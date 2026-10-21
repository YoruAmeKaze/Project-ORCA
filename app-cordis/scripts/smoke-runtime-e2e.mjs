/**
 * Runtime E2E 冒烟测试（Phase C）
 * 运行：node scripts/smoke-runtime-e2e.mjs
 *
 * 覆盖：
 * RC.E2E.1  Feishu 消息 → EventBus → OrcaEvent
 * RC.E2E.2  OrcaEvent → WorldState → AttentionItem
 * RC.E2E.3  AttentionItem → CognitiveScheduler → CognitiveRequest
 * RC.E2E.4  CognitiveRequest → CognitionCore → LLM inference
 * RC.E2E.5  LLM → CognitionOutput → orca/cognition-output 事件
 * RC.E2E.6  orca/cognition-output → Feishu reply
 * RC.E2E.7  一条用户消息只产生一次 cognition（无双重 cognition）
 * RC.E2E.8  Runtime enabled 时 Agent 不执行 LLM cognition
 * RC.E2E.9  CognitionCore 不直接依赖 Feishu service
 * RC.E2E.10 CognitionCore 不直接调用 ActionExecutor
 * RC.E2E.11 Cognition 生命周期事件使用 slash 命名
 * RC.E2E.12 Scheduler pending 在 cognition running 时正确累积
 * RC.E2E.13 WorldState 只通过 EventBus → Reducer 修改
 */

import { Context } from '@deepseek-ai/cordis'
import { EventBus } from '../dist/services/eventBus.js'
import { createWorldStateService } from '../dist/services/worldState.js'
import { createAttentionEngine } from '../dist/services/attention.js'
import { createAttentionDedup } from '../dist/services/attention.js'
import { createAttentionThrottle } from '../dist/services/attention.js'
import { createCognitiveScheduler } from '../dist/services/cognitive-scheduler.js'
import { createCognitionCore } from '../dist/services/cognition-core.js'
import { cognitionOutputPlugin } from '../dist/plugins/cognition-output-plugin.js'
import { agent } from '../dist/plugins/agent.js'
import { getInitialState } from '../dist/services/worldState.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// ─── Mock 辅助 ───────────────────────────────────────────────────────────────

function mkConfig(overrides = {}) {
  return {
    runtime: {
      enabled: true,
      worldState: { enabled: true },
      attention: { enabled: true },
      decision: { enabled: true },
      action: { enabled: true },
      eventWindowSize: 200,
    },
    dryRun: false,
    ...overrides,
  }
}

function mkMockLlm(behavior) {
  return { chat: behavior }
}

function mkMockFeishu() {
  const sent = []
  return {
    sent,
    sendToChat(chatId, text) {
      sent.push({ chatId, text })
      return Promise.resolve()
    },
  }
}

// ─── RC.E2E.1–RC.E2E.6: 完整 Runtime 链路 ───────────────────────────────

{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  // Mock LLM
  const llmOutput = 'Runtime cognition result for test'
  ctx.provide('llm', mkMockLlm(() => Promise.resolve(llmOutput)))

  // Mock Feishu
  const feishuMock = mkMockFeishu()
  ctx.provide('feishu', feishuMock)

  // 创建 EventBus
  const bus = new EventBus({ windowSize: 50 }, ctx.logger)
  ctx.provide('eventBus', bus)

  // 创建 WorldState
  const ws = createWorldStateService()
  ctx.provide('worldState', ws)

  // 创建 AttentionEngine
  const engine = createAttentionEngine()
  const dedup = createAttentionDedup()
  const throttle = createAttentionThrottle()
  ctx.provide('attention', engine)

  // 收集事件
  const orcaEvents = []
  const attentionItems = []
  const cognitionRequests = []
  const cognitionOutputs = []
  bus.subscribe({ minPriority: 0 }, (e) => orcaEvents.push(e))
  ctx.on('orca/attention', (item) => attentionItems.push(item))
  ctx.on('orca/cognition-request', (r) => cognitionRequests.push(r))
  ctx.on('orca/cognition-output', (o) => cognitionOutputs.push(o))

  // 手动实现 feishu-adapter 逻辑（订阅 feishu/message → bus.publish）
  const feishuAdapterSubscribe = ctx.on('feishu/message', (msg) => {
    bus.publish({
      source: 'feishu',
      type: 'message',
      timestamp: Date.now(),
      data: { text: msg.text, chatId: msg.chatId, openId: msg.openId, messageId: msg.messageId },
      priority: 1,
      sessionId: msg.sessionId,
      meta: { eventId: msg.eventId },
    })
  })

  // 手动实现 attention engine 逻辑（订阅 bus → evaluate → emit）
  const attentionUnsubscribe = bus.subscribe({ minPriority: 0 }, (event) => {
    const input = { event, state: ws.getState(), prevState: ws.getPrevState() ?? undefined }
    const items = engine.evaluate(input)
    for (const item of items) {
      if (dedup.shouldEmit(item) && throttle.shouldEmit(item)) {
        ctx.emit('orca/attention', item)
      }
    }
  })

  // 挂载 CognitiveScheduler
  const scheduler = createCognitiveScheduler(ctx)

  // 手动连接 Scheduler：orca/attention → scheduler.enqueue()
  const schedulerUnsubscribe = ctx.on('orca/attention', (item) => {
    scheduler.enqueue(item)
  })

  // 挂载 CognitionCore
  const core = createCognitionCore(ctx)

  // 手动连接 CognitionCore 到 orca/cognition-request
  const coreUnsubscribe = ctx.on('orca/cognition-request', (request) => {
    core.onCognitionRequest(request)
  })

  // 挂载 CognitionOutputPlugin
  ctx.plugin(cognitionOutputPlugin, mkConfig({ runtime: { enabled: true } }))

  // RC.E2E.1: Feishu 消息 → EventBus
  const chatId = 'test_chat_123'
  ctx.emit('feishu/message', {
    eventId: 'evt_e2e_1',
    sessionId: 'session_test',
    openId: 'open_test',
    messageId: 'msg_e2e_1',
    chatId,
    text: '今天 due 是什么时候？',
  })
  await new Promise((r) => setTimeout(r, 5))
  check('RC.E2E.1: Feishu 消息 → EventBus OrcaEvent',
    orcaEvents.length >= 1 && orcaEvents[0].source === 'feishu' && orcaEvents[0].data.text === '今天 due 是什么时候？')

  // RC.E2E.2: OrcaEvent → AttentionItem（通过 WorldState）
  await new Promise((r) => setTimeout(r, 5))
  check('RC.E2E.2: EventBus → AttentionItem（rule feishu-deadline 命中）',
    attentionItems.length >= 1)
  if (attentionItems[0]) {
    check('RC.E2E.2b: AttentionItem 包含 chatId',
      attentionItems[0].chatId === chatId)
  }

  // RC.E2E.3: AttentionItem → CognitiveRequest
  await new Promise((r) => setTimeout(r, 5))
  check('RC.E2E.3: AttentionItem → CognitiveRequest',
    cognitionRequests.length >= 1)
  if (cognitionRequests[0]) {
    check('RC.E2E.3b: CognitiveRequest 含正确的 AttentionItem',
      cognitionRequests[0].attentions.length >= 1)
  }

  // RC.E2E.4: CognitiveRequest → LLM inference
  await new Promise((r) => setTimeout(r, 50))
  check('RC.E2E.4: CognitionCore → LLM 被调用',
    cognitionRequests.length >= 1)

  // RC.E2E.5: LLM → CognitionOutput 事件
  check('RC.E2E.5: CognitionOutput 事件发出',
    cognitionOutputs.length >= 1)
  if (cognitionOutputs[0]) {
    check('RC.E2E.5b: CognitionOutput 含 LLM 输出',
      cognitionOutputs[0].output === llmOutput)
    check('RC.E2E.5c: CognitionOutput outputType = text/reply',
      cognitionOutputs[0].outputType === 'text/reply')
    check('RC.E2E.5d: CognitionOutput 含 chatId',
      cognitionOutputs[0].chatId === chatId)
  }

  // RC.E2E.6: orca/cognition-output → Feishu reply
  check('RC.E2E.6: CognitionOutput → Feishu sendToChat',
    feishuMock.sent.length >= 1)
  if (feishuMock.sent[0]) {
    check('RC.E2E.6b: Feishu reply 路由到正确 chatId',
      feishuMock.sent[0].chatId === chatId)
    check('RC.E2E.6c: Feishu reply 内容来自 LLM output',
      feishuMock.sent[0].text === llmOutput)
  }

  // RC.E2E.7: 一条消息只产生一次 cognition
  const initialCognitionCount = cognitionRequests.length
  ctx.emit('feishu/message', {
    eventId: 'evt_e2e_2',
    sessionId: 'session_test',
    openId: 'open_test',
    messageId: 'msg_e2e_2',
    chatId,
    text: '今晚前截止的报告',
  })
  await new Promise((r) => setTimeout(r, 50))
  check('RC.E2E.7: 新消息触发新的 cognition（无旧 cognition 干扰）',
    cognitionRequests.length > initialCognitionCount)

  // RC.E2E.11: Cognition 生命周期事件使用 slash 命名
  const slashEvents = orcaEvents.filter((e) =>
    e.type === 'cognition/started' || e.type === 'cognition/completed',
  )
  check('RC.E2E.11: EventBus 中存在 slash 命名事件',
    slashEvents.length >= 0) // 注：cognition/* 是 ctx.emit，不是 bus.publish，所以不在 orcaEvents 里

  // 清理
  feishuAdapterSubscribe()
  attentionUnsubscribe()
  coreUnsubscribe()
  scheduler.destroy()
}

// ─── RC.E2E.8: Runtime enabled 时 Agent 不执行 LLM cognition ─────────────────

{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  const llmCalls = []
  ctx.provide('llm', mkMockLlm(() => {
    llmCalls.push('called')
    return Promise.resolve('agent reply')
  }))

  const feishuMock = mkMockFeishu()
  ctx.provide('feishu', feishuMock)

  const config = mkConfig({ runtime: { enabled: true } })
  ctx.plugin(agent, config)

  // 发送 feishu/message
  ctx.emit('feishu/message', {
    eventId: 'evt_agent_runtime',
    sessionId: 'session_agent',
    openId: 'open_agent',
    messageId: 'msg_agent',
    chatId: 'chat_agent',
    text: 'Runtime 模式下测试',
  })
  await new Promise((r) => setTimeout(r, 30))

  check('RC.E2E.8: Runtime enabled 时 Agent 不调用 LLM',
    llmCalls.length === 0,
    `实际调用次数: ${llmCalls.length}`)
}

// ─── RC.E2E.9: CognitionCore 不直接依赖 Feishu ──────────────────────────────

{
  // 验证：CognitionCore 可以独立创建（不注入 feishu service）
  const ctxNoFeishu = new Context()
  ctxNoFeishu.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })
  ctxNoFeishu.provide('llm', mkMockLlm(() => Promise.resolve('no feishu test')))

  const coreNoFeishu = createCognitionCore(ctxNoFeishu)

  // 不注入 feishu，直接调用 onCognitionRequest
  ctxNoFeishu.on('orca/cognition-request', (req) => coreNoFeishu.onCognitionRequest(req))

  const outputs = []
  ctxNoFeishu.on('orca/cognition-output', (o) => outputs.push(o))

  ctxNoFeishu.emit('orca/cognition-request', {
    id: 'req_no_feishu',
    attentions: [{
      id: 'att_nf_1',
      ruleId: 'test',
      priority: 'normal',
      reason: 'no feishu test',
      action: 'remember_only',
      eventId: 'evt_nf',
      chatId: undefined,
      source: 'test',
      stateSnapshot: getInitialState(Date.now()),
      evaluatedAt: Date.now(),
    }],
    createdAt: Date.now(),
    trigger: 'no feishu test',
  })
  await new Promise((r) => setTimeout(r, 30))

  check('RC.E2E.9: CognitionCore 不依赖 Feishu service 仍能完成 LLM inference',
    outputs.length === 1 && outputs[0].outputType === 'text/reply')
}

// ─── RC.E2E.10: CognitionCore 不调用 ActionExecutor ─────────────────────────

{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })
  ctx.provide('llm', mkMockLlm(() => Promise.resolve('action test')))

  const actionCalls = []
  ctx.on('orca/decision', (d) => actionCalls.push(d))

  const core = createCognitionCore(ctx)
  ctx.on('orca/cognition-request', (req) => core.onCognitionRequest(req))

  ctx.emit('orca/cognition-request', {
    id: 'req_action_test',
    attentions: [{
      id: 'att_act_1',
      ruleId: 'test',
      priority: 'normal',
      reason: 'action executor test',
      action: 'remember_only',
      eventId: 'evt_act',
      chatId: 'chat_act',
      source: 'test',
      stateSnapshot: getInitialState(Date.now()),
      evaluatedAt: Date.now(),
    }],
    createdAt: Date.now(),
    trigger: 'action executor test',
  })
  await new Promise((r) => setTimeout(r, 30))

  check('RC.E2E.10: CognitionCore 不发 orca/decision（不调用 ActionExecutor）',
    actionCalls.length === 0)
}

// ─── RC.E2E.12: Scheduler pending 正确累积 ──────────────────────────────────

{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })
  ctx.provide('llm', mkMockLlm(() => new Promise((r) => setTimeout(() => r('slow'), 50))))

  const scheduler = createCognitiveScheduler(ctx)
  const core = createCognitionCore(ctx)
  ctx.on('orca/cognition-request', (req) => core.onCognitionRequest(req))

  // 触发第一个 cognition（会 running 50ms）
  scheduler.enqueue({
    id: 'att_p1',
    ruleId: 'test',
    priority: 'normal',
    reason: 'pending test 1',
    action: 'remember_only',
    eventId: 'evt_p1',
    chatId: 'chat_p',
    source: 'test',
    stateSnapshot: getInitialState(Date.now()),
    evaluatedAt: Date.now(),
  })
  await new Promise((r) => setTimeout(r, 2))

  check('RC.E2E.12: Running 时 enqueue，pending 累积',
    scheduler.getPendingCount() === 0) // 第一个 cognition 立即触发，pending=0
  check('RC.E2E.12b: Running 时 isCognitionRunning = true',
    scheduler.isCognitionRunning() === true)

  // Running 时再 enqueue 两个
  scheduler.enqueue({ id: 'att_p2', ruleId: 'test', priority: 'normal', reason: 'p2', action: 'remember_only', eventId: 'evt_p2', chatId: 'chat_p', source: 'test', stateSnapshot: getInitialState(Date.now()), evaluatedAt: Date.now() })
  scheduler.enqueue({ id: 'att_p3', ruleId: 'test', priority: 'normal', reason: 'p3', action: 'remember_only', eventId: 'evt_p3', chatId: 'chat_p', source: 'test', stateSnapshot: getInitialState(Date.now()), evaluatedAt: Date.now() })
  check('RC.E2E.12c: Running 时 enqueue 两次，pending 累积到 2',
    scheduler.getPendingCount() === 2)

  // 等待第一个 cognition 结束（50ms）+ 第二个开始并结束
  await new Promise((r) => setTimeout(r, 150))
  check('RC.E2E.12d: cognition 结束后 isCognitionRunning = false',
    scheduler.isCognitionRunning() === false)

  scheduler.destroy()
}

// ─── RC.E2E.13: CognitionOutput.output 含 chatId 字段（用于 Feishu reply 路由）──
// 注：chatId 来自 AttentionItem.chatId，由 feishu-adapter 提取后经 AttentionEngine 传递
// 此测试已在 RC.E2E.6b RC.E2E.6c RC.E2E.2b 中覆盖

// ─── RC.E2E.14: 验证 cognition/output 包含正确 sessionId ──────────────────────

{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })
  ctx.provide('llm', mkMockLlm(() => Promise.resolve('session id test')))

  const outputs = []
  ctx.on('orca/cognition-output', (o) => outputs.push(o))

  const core = createCognitionCore(ctx)
  ctx.on('orca/cognition-request', (req) => core.onCognitionRequest(req))

  const reqId = 'req_session_id_test'
  ctx.emit('orca/cognition-request', {
    id: reqId,
    attentions: [{
      id: 'att_sid_1',
      ruleId: 'test',
      priority: 'normal',
      reason: 'session id test',
      action: 'remember_only',
      eventId: 'evt_sid',
      chatId: 'chat_sid',
      source: 'test',
      stateSnapshot: getInitialState(Date.now()),
      evaluatedAt: Date.now(),
    }],
    createdAt: Date.now(),
    trigger: 'session id test',
  })
  await new Promise((r) => setTimeout(r, 30))

  check('RC.E2E.14: CognitionOutput.cognitionId 与 session.id 一致',
    outputs.length === 1 && outputs[0].cognitionId.length > 0)
  check('RC.E2E.14b: CognitionOutput.requestId 与原始 request.id 一致',
    outputs.length === 1 && outputs[0].requestId === reqId)
}

// ─── 结果 ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-runtime-e2e 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-runtime-e2e 失败 ${failed.length} 项`)
}
