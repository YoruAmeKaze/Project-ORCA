/**
 * filesystem.read ActionHandler 冒烟测试（Phase D）
 * 运行：npm run build && node scripts/smoke-fs-read.mjs
 *
 * 覆盖：
 *  FR1. filesystem.read 成功读取允许目录中的文件
 *  FR2. 文件不存在 → success=false
 *  FR3. 路径超出允许范围 → success=false + "outside allowed root"
 *  FR4. 尝试读取目录而非文件 → success=false
 *  FR5. ActionExecutor 能正确 dispatch filesystem.read
 *  FR6. ActionResult 正确返回 metadata（content / path / encoding / size）
 *  FR7. 无效 JSON reason → success=false
 *  FR8. 缺少 path 字段 → success=false
 *  FR9. 不支持的 encoding → success=false
 *  FR10. 相对路径自动拼接 allowedRoot
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  createActionExecutor,
  createFilesystemReadHandler,
} from '../dist/services/action.js'
import { actionExecutor } from '../dist/plugins/action-executor.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// 辅助：构造 Decision
function mkDecision(overrides = {}) {
  return {
    decisionId: overrides.decisionId ?? `dec_${Math.random().toString(36).slice(2)}`,
    attentionId: overrides.attentionId ?? `att_${Math.random().toString(36).slice(2)}`,
    ruleId: overrides.ruleId ?? 'test-rule',
    action: overrides.action ?? 'filesystem.read',
    priority: overrides.priority ?? 'normal',
    reason: overrides.reason ?? JSON.stringify({ path: '/dummy.txt' }),
    eventId: overrides.eventId ?? 'evt_test',
    source: overrides.source ?? 'test',
    decidedAt: overrides.decidedAt ?? Date.now(),
    ...overrides,
  }
}

// 辅助：polling 等异步 listener 派发
async function pollFor(predicate, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    let ok = false
    try {
      ok = await predicate()
    } catch {
      ok = false
    }
    if (ok) return
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ── 准备临时测试目录 ────────────────────────────────────────────────────
const tmpRoot = join(tmpdir(), `orca-fs-read-${Date.now()}`)
const allowedRoot = join(tmpRoot, 'allowed')
const forbiddenDir = join(tmpRoot, 'forbidden')

mkdirSync(allowedRoot, { recursive: true })
mkdirSync(forbiddenDir, { recursive: true })

// 在 allowedRoot 内创建测试文件
writeFileSync(join(allowedRoot, 'hello.txt'), 'Hello, Orca!', 'utf8')
writeFileSync(join(allowedRoot, 'unicode.txt'), '你好，世界！🌟', 'utf8')
writeFileSync(join(allowedRoot, 'base64-input.txt'), 'SGVsbG8=', 'utf8')
// 父目录的禁止文件
writeFileSync(join(tmpRoot, 'secret.txt'), 'top secret', 'utf8')
// forbiddenDir 内的禁止文件
writeFileSync(join(forbiddenDir, 'private.txt'), 'private data', 'utf8')

const fsHandler = createFilesystemReadHandler({ allowedRoot })

// ── FR1: 成功读取允许目录中的文件 ─────────────────────────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  const decision = mkDecision({
    decisionId: 'dec_fsread_001',
    reason: JSON.stringify({ path: join(allowedRoot, 'hello.txt') }),
  })
  const result = await executor.execute(decision)

  check('FR1.1: 读取成功 → success=true', result.success === true)
  check('FR1.2: result.action === "filesystem.read"', result.action === 'filesystem.read')
  check('FR1.3: metadata.content === "Hello, Orca!"',
    result.metadata?.content === 'Hello, Orca!')
  check('FR1.4: metadata.path 包含 hello.txt',
    typeof result.metadata?.path === 'string' && result.metadata.path.includes('hello.txt'))
  check('FR1.5: metadata.encoding === "utf-8"（默认）',
    result.metadata?.encoding === 'utf-8')
  check('FR1.6: metadata.size > 0', typeof result.metadata?.size === 'number' && result.metadata.size > 0)
}

// ── FR2: 文件不存在 ────────────────────────────────────────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  const decision = mkDecision({
    decisionId: 'dec_fsread_002',
    reason: JSON.stringify({ path: join(allowedRoot, 'nonexistent.txt') }),
  })
  const result = await executor.execute(decision)

  check('FR2.1: 文件不存在 → success=false', result.success === false)
  check('FR2.2: error 包含 "ENOENT" 或 "no such file"',
    typeof result.error === 'string' && /ENOENT|no such file/i.test(result.error))
}

// ── FR3: 路径超出允许范围 ──────────────────────────────────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  // 尝试读取父目录的禁止文件
  const decision = mkDecision({
    decisionId: 'dec_fsread_003',
    reason: JSON.stringify({ path: join(tmpRoot, 'secret.txt') }),
  })
  const result = await executor.execute(decision)

  check('FR3.1: 越界路径 → success=false', result.success === false)
  check('FR3.2: error 包含 "outside allowed root"',
    typeof result.error === 'string' && result.error.includes('outside allowed root'))

  // 尝试读取 forbiddenDir 内的文件
  const decision2 = mkDecision({
    decisionId: 'dec_fsread_003b',
    reason: JSON.stringify({ path: join(forbiddenDir, 'private.txt') }),
  })
  const result2 = await executor.execute(decision2)
  check('FR3.3: forbiddenDir 越界 → success=false', result2.success === false)
}

// ── FR4: 尝试读取目录而非文件 ──────────────────────────────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  const decision = mkDecision({
    decisionId: 'dec_fsread_004',
    reason: JSON.stringify({ path: allowedRoot }),
  })
  const result = await executor.execute(decision)

  check('FR4.1: 读取目录 → success=false', result.success === false)
  check('FR4.2: error 包含 "EISDIR" 或 "is a directory"',
    typeof result.error === 'string' && /EISDIR|is a directory/i.test(result.error))
}

// ── FR5: ActionExecutor 能正确 dispatch filesystem.read ────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  const decision = mkDecision({
    decisionId: 'dec_fsread_005',
    reason: JSON.stringify({ path: join(allowedRoot, 'hello.txt') }),
  })
  const result = await executor.execute(decision)

  check('FR5.1: executor.dispatch → success=true', result.success === true)
  check('FR5.2: decisionId 透传', result.decisionId === 'dec_fsread_005')
}

// ── FR6: ActionResult metadata 完整性 ────────────────────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  const decision = mkDecision({
    decisionId: 'dec_fsread_006',
    reason: JSON.stringify({ path: join(allowedRoot, 'hello.txt'), encoding: 'utf-8' }),
  })
  const result = await executor.execute(decision)

  check('FR6.1: metadata.path 存在', typeof result.metadata?.path === 'string')
  check('FR6.2: metadata.encoding === "utf-8"', result.metadata?.encoding === 'utf-8')
  check('FR6.3: metadata.content 存在', result.metadata?.content !== undefined)
  check('FR6.4: metadata.size === Buffer.byteLength(content)',
    result.metadata?.size === Buffer.byteLength('Hello, Orca!', 'utf8'))
}

// ── FR7: 无效 JSON reason ─────────────────────────────────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  const decision = mkDecision({
    decisionId: 'dec_fsread_007',
    reason: 'not a json string with { path }',
  })
  const result = await executor.execute(decision)

  check('FR7.1: 无效 JSON → success=false', result.success === false)
  check('FR7.2: error 包含 "cannot parse"',
    typeof result.error === 'string' && result.error.includes('cannot parse'))
}

// ── FR8: 缺少 path 字段 ───────────────────────────────────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  const decision = mkDecision({
    decisionId: 'dec_fsread_008',
    reason: JSON.stringify({ encoding: 'utf-8' }),
  })
  const result = await executor.execute(decision)

  check('FR8.1: 缺少 path → success=false', result.success === false)
  check('FR8.2: error 包含 "path is required"',
    typeof result.error === 'string' && result.error.includes('path is required'))
}

// ── FR9: 不支持的 encoding ────────────────────────────────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  const decision = mkDecision({
    decisionId: 'dec_fsread_009',
    reason: JSON.stringify({ path: join(allowedRoot, 'hello.txt'), encoding: 'invalid-encoding' }),
  })
  const result = await executor.execute(decision)

  check('FR9.1: 无效 encoding → success=false', result.success === false)
  check('FR9.2: error 包含 "unsupported encoding"',
    typeof result.error === 'string' && result.error.includes('unsupported encoding'))
}

// ── FR10: 相对路径自动拼接 allowedRoot ────────────────────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  const decision = mkDecision({
    decisionId: 'dec_fsread_010',
    reason: JSON.stringify({ path: 'hello.txt' }), // 相对路径
  })
  const result = await executor.execute(decision)

  check('FR10.1: 相对路径 → success=true', result.success === true)
  check('FR10.2: 相对路径 content === "Hello, Orca!"',
    result.metadata?.content === 'Hello, Orca!')
}

// ── FR11: base64 encoding ──────────────────────────────────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  // readFile(encoding='base64')：将文件原始字节 base64-Encode 返回
  // 文件内容 "SGVsbG8=" (ASCII bytes) → content = base64(ASCII bytes) = "U0dWc2JHOD0="
  const decision = mkDecision({
    decisionId: 'dec_fsread_011',
    reason: JSON.stringify({ path: join(allowedRoot, 'base64-input.txt'), encoding: 'base64' }),
  })
  const result = await executor.execute(decision)

  check('FR11.1: base64 读取 → success=true', result.success === true)
  check('FR11.2: content 是 base64 编码后的字符串',
    typeof result.metadata?.content === 'string' && result.metadata.content.length > 0)
  check('FR11.3: encoding === "base64"',
    result.metadata?.encoding === 'base64')
}

// ── FR12: Unicode 文件内容 ─────────────────────────────────────────────
{
  const executor = createActionExecutor()
  executor.registry.register(fsHandler)

  const decision = mkDecision({
    decisionId: 'dec_fsread_012',
    reason: JSON.stringify({ path: join(allowedRoot, 'unicode.txt') }),
  })
  const result = await executor.execute(decision)

  check('FR12.1: Unicode 文件 → success=true', result.success === true)
  check('FR12.2: Unicode 内容完整', result.metadata?.content === '你好，世界！🌟')
}

// ── FR13: Executor 未知 action 返回正确错误 ────────────────────────────
{
  const executor = createActionExecutor()
  // 不注册 filesystem.read handler

  const decision = mkDecision({
    decisionId: 'dec_fsread_013',
    action: 'filesystem.read',
  })
  const result = await executor.execute(decision)

  check('FR13.1: 未注册 action → success=false', result.success === false)
  check('FR13.2: error 包含 "no handler registered"',
    typeof result.error === 'string' && result.error.includes('no handler registered'))
}

// ── FR14: ActionExecutor plugin 集成（Cordis）───────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  // 收集 action-result
  const results14 = []
  ctx.on('orca/action-result', (r) => { results14.push(r) })

  // 挂载 plugin，配置 filesystem.readRoot
  const dispose = actionExecutor(ctx, {
    filesystem: { readRoot: allowedRoot },
    runtime: { action: { enabled: true } },
  })

  // 确认 filesystem.read handler 已注册
  const executor = ctx.actionExecutor
  check('FR14.1: ctx.actionExecutor.registry.get("filesystem.read") 已注册',
    executor.registry.get('filesystem.read')?.name === 'filesystem.read')

  // 触发 filesystem.read decision
  ctx.emit('orca/decision', mkDecision({
    decisionId: 'dec_fsread_014',
    reason: JSON.stringify({ path: join(allowedRoot, 'hello.txt') }),
  }))

  await pollFor(() => results14.length > 0, 500)

  check('FR14.2: emit(orca/decision filesystem.read) → 1 个 action-result', results14.length === 1)
  check('FR14.3: plugin dispatch → success=true', results14[0]?.success === true)
  check('FR14.4: plugin dispatch → content 正确',
    results14[0]?.metadata?.content === 'Hello, Orca!')

  dispose()
}

// ── 清理临时目录 ────────────────────────────────────────────────────────
try {
  rmSync(tmpRoot, { recursive: true, force: true })
} catch {
  // ignore cleanup errors
}

// ── 结果 ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-fs-read 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('\n失败的测试：')
  for (const f of failed) {
    console.log(`  FAIL  ${f.name}`)
  }
  process.exit(1)
} else {
  console.log('全部通过')
}
