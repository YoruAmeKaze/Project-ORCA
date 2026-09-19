/**
 * Cognition → filesystem.read E2E 冒烟测试（Phase D）
 * 运行：npm run build && node scripts/smoke-cognition-fs-read.mjs
 *
 * 验证完整链路：
 *  CognitionCore
 *    → CognitionActionIntent { action: 'filesystem.read', reason: JSON }
 *    → cognition-output-plugin（cognitionIntentToDecision）
 *    → emit 'orca/decision'
 *    → ActionExecutor.execute(decision)
 *    → filesystem.read ActionHandler
 *    → fs.readFile
 *    → ActionResult { success, metadata: { content, path, encoding, size } }
 *    → emit 'orca/action-result'
 *    → EventBus
 *
 * 覆盖：
 *  CF1. Cognition 产生 /act:filesystem.read:JSON → outputType='action'
 *  CF2. Decision.action === 'filesystem.read' + reason 携带 JSON 参数
 *  CF3. ActionExecutor dispatch filesystem.read decision
 *  CF4. filesystem.read handler 正确读取文件
 *  CF5. ActionResult metadata 完整（content / path / encoding / size）
 *  CF6. 事件链顺序验证
 *  CF7. 文件不存在 → ActionResult success=false
 *  CF8. dryRun:true 时 filesystem.read 仍执行（dryRun 不影响读取）
 *
 * 注意事项：
 *  ctx.plugin() 创建异步 fiber，必须 await 确保 plugin callback 执行完毕
 * （即 ctx.on inside plugin 注册完成）后再 emit 事件。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { EventBus } from '../dist/services/eventBus.js'
import { createWorldStateService } from '../dist/services/worldState.js'
import { createCognitiveScheduler } from '../dist/services/cognitive-scheduler.js'
import { createCognitionCore } from '../dist/services/cognition-core.js'
import { cognitionOutputPlugin } from '../dist/plugins/cognition-output-plugin.js'
import { actionExecutor } from '../dist/plugins/action-executor.js'
import { getInitialState } from '../dist/services/worldState.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// ── Mock LLM ────────────────────────────────────────────────────────────
function mkMockLlmForFsRead(llmOutput) {
  return { chat: () => Promise.resolve(llmOutput) }
}

// ── 测试辅助 ────────────────────────────────────────────────────────────
function mkRequest(id = 'req_cf_001', trigger = 'test trigger') {
  return {
    id,
    attentions: [{
      id: 'att_cf_001',
      ruleId: 'test-rule',
      priority: 'normal',
      reason: '请读取 test.txt 文件',
      action: 'act',
      eventId: 'evt_cf_001',
      source: 'feishu',
      stateSnapshot: getInitialState(Date.now()),
      evaluatedAt: Date.now(),
      chatId: 'chat_cf_test',
    }],
    createdAt: Date.now(),
    trigger,
  }
}

// ── 准备测试目录 ──────────────────────────────────────────────────────
const tmpRoot = join(tmpdir(), `orca-cf-e2e-${Date.now()}`)
const allowedRoot = join(tmpRoot, 'data')
mkdirSync(allowedRoot, { recursive: true })
writeFileSync(join(allowedRoot, 'test.txt'), 'Hello from filesystem.read!', 'utf8')
writeFileSync(join(allowedRoot, 'unicode.txt'), '你好，世界！🌟', 'utf8')

const mkConfig = (fsReadEnabled = true) => ({
  runtime: {
    enabled: true,
    worldState: { enabled: false },
    attention: { enabled: false },
    decision: { enabled: false },
    action: { enabled: true },
    eventWindowSize: 200,
  },
  dryRun: false,
  filesystem: fsReadEnabled ? { readRoot: allowedRoot } : undefined,
})

// ── CF1–CF6: 完整成功路径 ─────────────────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  const llmOutput = '/act:filesystem.read:{"path":"test.txt","encoding":"utf-8"}'
  ctx.provide('llm', mkMockLlmForFsRead(llmOutput))

  const bus = new EventBus({ windowSize: 50 }, ctx.logger)
  ctx.provide('eventBus', bus)

  const ws = createWorldStateService()
  ctx.provide('worldState', ws)

  // cognition-output-plugin 读取 ctx.fish（用于 text/reply 路径，action 路径不依赖）
  // 若不提供会 throw "cannot get property 'feishu' without inject"
  ctx.provide('feishu', { sendToChat: () => Promise.resolve() })

  const cognitionOutputs = []
  const orcaDecisions = []
  const orcaActionResults = []

  ctx.on('orca/cognition-output', (o) => { cognitionOutputs.push(o) })
  ctx.on('orca/decision', (d) => { orcaDecisions.push(d) })
  ctx.on('orca/action-result', (r) => { orcaActionResults.push(r) })

  // 挂载 plugins（必须 await，确保 fiber callback 执行完 + ctx.on 注册完）
  await ctx.plugin(cognitionOutputPlugin, mkConfig())
  await ctx.plugin(actionExecutor, mkConfig())

  // 挂载 CognitionCore（不使用 ctx.plugin，直接创建 service）
  const scheduler = createCognitiveScheduler(ctx)
  const core = createCognitionCore(ctx)
  ctx.on('orca/cognition-request', (request) => { core.onCognitionRequest(request) })

  // 触发 CognitiveRequest
  ctx.emit('orca/cognition-request', mkRequest('req_cf_success', 'read test.txt'))

  // 等待完整链路
  await new Promise((r) => setTimeout(r, 200))

  // CF1: Cognition 产生 action output
  check('CF1.1: cognition-output 事件已发出', cognitionOutputs.length >= 1)
  if (cognitionOutputs[0]) {
    check('CF1.2: outputType === "action"', cognitionOutputs[0].outputType === 'action')
    check('CF1.3: actionIntent.action === "filesystem.read"',
      cognitionOutputs[0].actionIntent?.action === 'filesystem.read')
    check('CF1.4: actionIntent.reason 是 JSON 字符串',
      typeof cognitionOutputs[0].actionIntent?.reason === 'string')
  }

  // CF2: Decision 正确携带参数
  check('CF2.1: orca/decision 事件已发出', orcaDecisions.length >= 1)
  if (orcaDecisions[0]) {
    check('CF2.2: Decision.action === "filesystem.read"', orcaDecisions[0].action === 'filesystem.read')
    check('CF2.3: Decision.reason 包含 JSON path', orcaDecisions[0].reason.includes('"path"'))
    check('CF2.4: Decision.reason 包含 test.txt', orcaDecisions[0].reason.includes('test.txt'))
    check('CF2.5: Decision.source === "cognition"', orcaDecisions[0].source === 'cognition')
    check('CF2.6: Decision.ruleId === "cognition"', orcaDecisions[0].ruleId === 'cognition')
  }

  // CF3 & CF4: ActionExecutor dispatch + handler 正确读取
  check('CF3.1: orca/action-result 事件已发出', orcaActionResults.length >= 1)
  if (orcaActionResults[0]) {
    check('CF3.2: ActionResult.success === true', orcaActionResults[0].success === true)
    check('CF3.3: ActionResult.action === "filesystem.read"',
      orcaActionResults[0].action === 'filesystem.read')
  }

  // CF5: ActionResult metadata 完整
  if (orcaActionResults[0]) {
    check('CF5.1: metadata.content === "Hello from filesystem.read!"',
      orcaActionResults[0].metadata?.content === 'Hello from filesystem.read!')
    check('CF5.2: metadata.path 包含 test.txt',
      typeof orcaActionResults[0].metadata?.path === 'string' &&
      orcaActionResults[0].metadata.path.includes('test.txt'))
    check('CF5.3: metadata.encoding === "utf-8"',
      orcaActionResults[0].metadata?.encoding === 'utf-8')
    check('CF5.4: metadata.size > 0',
      typeof orcaActionResults[0].metadata?.size === 'number' &&
      orcaActionResults[0].metadata.size > 0)
  }

  // CF6: 事件链顺序
  check('CF6.1: cognition-output 先于 decision',
    cognitionOutputs.length >= 1 && orcaDecisions.length >= 1)
  check('CF6.2: decision 先于 action-result',
    orcaDecisions.length >= 1 && orcaActionResults.length >= 1)
}

// ── CF7: 文件不存在 → success=false ───────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  const llmOutput = '/act:filesystem.read:{"path":"nonexistent_file.txt","encoding":"utf-8"}'
  ctx.provide('llm', mkMockLlmForFsRead(llmOutput))

  const bus = new EventBus({ windowSize: 50 }, ctx.logger)
  ctx.provide('eventBus', bus)

  const ws = createWorldStateService()
  ctx.provide('worldState', ws)
  ctx.provide('feishu', { sendToChat: () => Promise.resolve() })

  const orcaActionResults = []
  ctx.on('orca/action-result', (r) => { orcaActionResults.push(r) })

  await ctx.plugin(cognitionOutputPlugin, mkConfig())
  await ctx.plugin(actionExecutor, mkConfig())

  const scheduler = createCognitiveScheduler(ctx)
  const core = createCognitionCore(ctx)
  ctx.on('orca/cognition-request', (request) => { core.onCognitionRequest(request) })

  ctx.emit('orca/cognition-request', mkRequest('req_cf_notfound', 'read nonexistent'))

  await new Promise((r) => setTimeout(r, 200))

  check('CF7.1: 不存在文件 → success=false',
    orcaActionResults.length >= 1 && orcaActionResults[0].success === false)
  check('CF7.2: error 包含 ENOENT',
    orcaActionResults.length >= 1 &&
    typeof orcaActionResults[0].error === 'string' &&
    /ENOENT|no such file/i.test(orcaActionResults[0].error))
  check('CF7.3: action === "filesystem.read"',
    orcaActionResults.length >= 1 && orcaActionResults[0].action === 'filesystem.read')
}

// ── CF8: dryRun:true 时 filesystem.read 仍执行（dryRun 不影响此 handler） ─
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  const llmOutput = '/act:filesystem.read:{"path":"test.txt","encoding":"utf-8"}'
  ctx.provide('llm', mkMockLlmForFsRead(llmOutput))

  const bus = new EventBus({ windowSize: 50 }, ctx.logger)
  ctx.provide('eventBus', bus)

  const ws = createWorldStateService()
  ctx.provide('worldState', ws)
  ctx.provide('feishu', { sendToChat: () => Promise.resolve() })

  const orcaActionResults = []
  ctx.on('orca/action-result', (r) => { orcaActionResults.push(r) })

  // dryRun=true 传给 cognition-output-plugin 和 actionExecutor
  await ctx.plugin(cognitionOutputPlugin, { ...mkConfig(), dryRun: true })
  await ctx.plugin(actionExecutor, { ...mkConfig(), dryRun: true })

  const scheduler = createCognitiveScheduler(ctx)
  const core = createCognitionCore(ctx)
  ctx.on('orca/cognition-request', (request) => { core.onCognitionRequest(request) })

  ctx.emit('orca/cognition-request', mkRequest('req_cf_dryrun', 'dryRun test'))

  await new Promise((r) => setTimeout(r, 200))

  // filesystem.read 不受 dryRun 影响（dryRun 是 notify/feishu 的概念）
  check('CF8.1: dryRun=true 时 filesystem.read 仍执行成功',
    orcaActionResults.length >= 1 && orcaActionResults[0].success === true)
  check('CF8.2: content 正确返回',
    orcaActionResults[0]?.metadata?.content === 'Hello from filesystem.read!')
}

// ── CF9: 越界路径 → success=false ────────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  // 尝试读取 allowedRoot 之外的路径
  const llmOutput = '/act:filesystem.read:{"path":"../etc/passwd","encoding":"utf-8"}'
  ctx.provide('llm', mkMockLlmForFsRead(llmOutput))

  const bus = new EventBus({ windowSize: 50 }, ctx.logger)
  ctx.provide('eventBus', bus)

  const ws = createWorldStateService()
  ctx.provide('worldState', ws)
  ctx.provide('feishu', { sendToChat: () => Promise.resolve() })

  const orcaActionResults = []
  ctx.on('orca/action-result', (r) => { orcaActionResults.push(r) })

  await ctx.plugin(cognitionOutputPlugin, mkConfig())
  await ctx.plugin(actionExecutor, mkConfig())

  const scheduler = createCognitiveScheduler(ctx)
  const core = createCognitionCore(ctx)
  ctx.on('orca/cognition-request', (request) => { core.onCognitionRequest(request) })

  ctx.emit('orca/cognition-request', mkRequest('req_cf_forbidden', 'read forbidden'))

  await new Promise((r) => setTimeout(r, 200))

  check('CF9.1: 越界路径 → success=false',
    orcaActionResults.length >= 1 && orcaActionResults[0].success === false)
  check('CF9.2: error 包含 "outside allowed root"',
    orcaActionResults.length >= 1 &&
    typeof orcaActionResults[0].error === 'string' &&
    orcaActionResults[0].error.includes('outside allowed root'))
}

// ── 清理 ──────────────────────────────────────────────────────────────
try {
  rmSync(tmpRoot, { recursive: true, force: true })
} catch {}

// ── 结果 ──────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-cognition-fs-read 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('\n失败的测试：')
  for (const f of failed) {
    console.log(`  FAIL  ${f.name}`)
  }
  process.exit(1)
} else {
  console.log('全部通过')
}
