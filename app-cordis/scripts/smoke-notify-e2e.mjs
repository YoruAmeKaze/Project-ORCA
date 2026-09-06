/**
 * Phase 4.C NotifyHandler 端到端 smoke 测试（R16）
 *
 * 设计目标：完整验证 Phase 4.C 真实链路（不修改任何 production code）。
 *
 * 链路：
 *   独立 Registry 临时 rule (source=feishu, text 含 "[Orca E2E]")
 *     → EventBus.publish(feishu event)
 *     → 独立 AttentionEngine.evaluate → emit orca/attention
 *     → 真实 DecisionEngine plugin → emit orca/decision
 *     → 真实 ActionExecutor plugin（注入 mock FeishuClient）
 *     → NotifyHandler
 *     → EventBus.get(decision.eventId) → event.data.chatId
 *     → mock FeishuClient.sendToChat(chatId, text)
 *     → emit orca/action-result
 *
 * 关键不变量（约束）：
 * - ❌ 不调用 registerRule() 污染 defaultRegistry
 * - ❌ 不修改 services/attention.ts 5 条默认规则
 * - ❌ 不修改 plugins/attention-engine.ts / decision-engine.ts / action-executor.ts
 * - ❌ 不修改 types/attention.ts / types/decision.ts
 * - ❌ 不增加任何生产配置键
 * - ✅ 测试在独立 Context + 独立 Registry 中跑
 * - ✅ throttle 使用 cooldownMs=0 + hourlyCap=1000 避免单次测试被拦截
 * - ✅ NotifyHandler 用 mock FeishuClient（结构化类型 NotifyFeishuLike）
 *
 * 临时 rule 形态：
 *   - id: 'orca-e2e-notify'
 *   - predicate: event.source='feishu' && type='message' && text 含 [Orca E2E]
 *   - produce: priority='urgent', action='notify_immediately', reason, eventId
 *
 * 运行：npm run build && node scripts/smoke-notify-e2e.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import { EventBus } from '../dist/services/eventBus.js'
import {
  createRuleRegistry,
  createAttentionEngine,
  createAttentionDedup,
  createAttentionThrottle,
  ruleRegistrySize,
  getDefaultRegistry,
} from '../dist/services/attention.js'
import { createWorldStateService } from '../dist/services/worldState.js'
import { decisionEngine } from '../dist/plugins/decision-engine.js'
import { actionExecutor } from '../dist/plugins/action-executor.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// ────────────────────────────────────────────────────────────
// Mock FeishuClient（结构化类型 NotifyFeishuLike）
// ────────────────────────────────────────────────────────────
function mkMockFeishu() {
  const calls = []
  return {
    calls,
    sendToChat: async (chatId, text) => {
      calls.push({ chatId, text })
    },
  }
}

// ────────────────────────────────────────────────────────────
// 异步等待工具（轮询直至 predicate 为 true 或超时）
// ────────────────────────────────────────────────────────────
async function pollFor(predicate, timeoutMs = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    let ok = false
    try { ok = await predicate() } catch { ok = false }
    if (ok) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return false
}

// ────────────────────────────────────────────────────────────
// R16.0  准备：独立 EventBus + 独立 WorldState + 独立 Registry
// ────────────────────────────────────────────────────────────
{
  // 验证 defaultRegistry 不被污染（构造前快照）
  const beforeDefaultCount = ruleRegistrySize()
  check('R16.0.1: 初始 defaultRegistry 启用规则数 === 5', beforeDefaultCount === 5)

  // 构造独立测试组件
  const e2eRegistry = createRuleRegistry()
  check('R16.0.2: 独立 Registry 初始 size === 0', e2eRegistry.size() === 0)

  // 临时 E2E rule
  const E2E_RULE_ID = 'orca-e2e-notify'
  e2eRegistry.register({
    id: E2E_RULE_ID,
    description: 'E2E 验证用临时 rule：飞书消息含 [Orca E2E] 前缀 → notify_immediately',
    predicate: ({ event }) =>
      event?.source === 'feishu' &&
      event.type === 'message' &&
      /\[Orca E2E\]/.test(String(event.data.text ?? '')),
    produce: ({ event }) => {
      const text = String(event?.data.text ?? '')
      return {
        priority: 'urgent',
        reason: `R16 E2E 紧急通知：「${text.slice(0, 50)}」`,
        action: 'notify_immediately',
        eventId: event?.id,
      }
    },
  })
  check('R16.0.3: 独立 Registry 注册后 size === 1', e2eRegistry.size() === 1)

  // 独立 AttentionEngine（不传 defaultRegistry → 完全隔离）
  const e2eEngine = createAttentionEngine(e2eRegistry)
  check('R16.0.4: 独立 AttentionEngine.ruleCount() === 1', e2eEngine.ruleCount() === 1)

  // 验证 defaultRegistry 仍未被污染
  check('R16.0.5: defaultRegistry 启用规则数仍 === 5（独立 Registry 隔离）',
    ruleRegistrySize() === 5)
  check('R16.0.6: defaultRegistry.getRules().length === 5',
    getDefaultRegistry().getRules().length === 5)
  check('R16.0.7: defaultRegistry 不含 e2e rule id',
    !getDefaultRegistry().getAllRules().some((r) => r.id === E2E_RULE_ID))
}

// ────────────────────────────────────────────────────────────
// R16.1-R16.9  完整 E2E 链路：临时 rule → EventBus → AttentionEngine → DecisionEngine → ActionExecutor → NotifyHandler → mock feishu → action-result
// ────────────────────────────────────────────────────────────
{
  // 1. 构造独立测试 Context（不挂任何 production plugin；自己 provide 依赖）
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  // 2. 独立 EventBus（足够大以容纳 E2E 事件）
  const bus = new EventBus({ windowSize: 50 })
  ctx.provide('eventBus', bus)

  // 3. 独立 WorldState（fresh initial state）
  const ws = createWorldStateService()
  ctx.provide('worldState', ws)

  // 4. 独立 Registry + 临时 E2E rule（不触碰 defaultRegistry）
  const e2eRegistry = createRuleRegistry()
  const E2E_RULE_ID = 'orca-e2e-notify'
  e2eRegistry.register({
    id: E2E_RULE_ID,
    description: 'E2E 验证用临时 rule',
    predicate: ({ event }) =>
      event?.source === 'feishu' &&
      event.type === 'message' &&
      /\[Orca E2E\]/.test(String(event.data.text ?? '')),
    produce: ({ event }) => {
      const text = String(event?.data.text ?? '')
      return {
        priority: 'urgent',
        reason: `R16 E2E 紧急通知：「${text.slice(0, 50)}」`,
        action: 'notify_immediately',
        eventId: event?.id,
      }
    },
  })
  const e2eEngine = createAttentionEngine(e2eRegistry)
  ctx.provide('attention', e2eEngine)

  // 5. R16.1/R16.2 验证：defaultRegistry 隔离 + 独立 engine 只有 1 条
  check('R16.1: defaultRegistry 启用规则数 === 5（未被 e2e rule 污染）',
    ruleRegistrySize() === 5)
  check('R16.2: 独立 e2eEngine 只含 e2e rule（ruleCount=1）',
    e2eEngine.ruleCount() === 1)

  // 6. 自定义 Dedup + Throttle（cooldown=0 + hourlyCap=1000 避免测试被拦截）
  const dedup = createAttentionDedup({ windowMs: 5000 })
  const throttle = createAttentionThrottle({ cooldownMs: 0, hourlyCap: 1000, windowMs: 60_000 })

  // 7. 收集 orca/attention / orca/decision / orca/action-result
  const attentionItems = []
  ctx.on('orca/attention', (item) => { attentionItems.push(item) })
  const decisions = []
  ctx.on('orca/decision', (d) => { decisions.push(d) })
  const actionResults = []
  ctx.on('orca/action-result', (r) => { actionResults.push(r) })

  // 8. 模拟 attention-engine.ts:111 的订阅（手动而非插件；避免 production 插件污染）
  const unsubscribeBus = bus.subscribe({ minPriority: 0 }, (event) => {
    try {
      const input = {
        event,
        state: ws.getState(),
        prevState: ws.getPrevState() ?? undefined,
      }
      const items = e2eEngine.evaluate(input)
      // 三级流水线（dedup + throttle + emit）
      for (const item of items) {
        if (!dedup.shouldEmit(item)) continue
        if (!throttle.shouldEmit(item)) continue
        ctx.emit('orca/attention', item)
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[e2e-attention] handler 异常: %s', detail)
    }
  })

  // 9. 挂载真实 decisionEngine + actionExecutor plugin（按 production 装配顺序）
  // 注意：这两个 plugin 不依赖 AttentionEngine 来源；只订阅 ctx.on('orca/attention')
  const disposeDecision = decisionEngine(ctx, {})
  const mockFeishu = mkMockFeishu()
  ctx.provide('feishu', mockFeishu)
  const disposeAction = actionExecutor(ctx, { dryRun: false })

  // R16.10: 验证 mock feishu 的 notify handler 已注册
  const notifyHandler = ctx.actionExecutor.registry.list().find((h) => h.action === 'notify')
  check('R16.10.1: actionExecutor plugin 注入了真实 notify handler（name=notify）',
    notifyHandler?.name === 'notify')

  // 10. 触发 E2E 事件
  const e2eChatId = 'oc_e2e_test_chat_001'
  const e2eText = '[Orca E2E] 这是一条端到端验证消息，验证 NotifyHandler 通过 EventBus.get(eventId) 反查原始事件并发送飞书。'
  bus.publish({
    source: 'feishu',
    type: 'message',
    data: {
      text: e2eText,
      chatId: e2eChatId,
      openId: 'ou_e2e_test_user',
      messageId: 'om_e2e_test_msg',
    },
    priority: 1,
  })
  const e2eEventId = bus.recent(1)[0].id
  check('R16.3.1: EventBus 已记录 e2e 事件（id 非空）',
    typeof e2eEventId === 'string' && e2eEventId.length > 0)
  check('R16.3.2: e2eEventId 可通过 eventBus.get 反查',
    bus.get(e2eEventId)?.data?.chatId === e2eChatId)

  // 11. R16.3 等待链路派发
  // 完整链路：bus.publish → attention 订阅 → emit orca/attention → decision 订阅 → emit orca/decision → action 订阅 → execute → emit orca/action-result
  await pollFor(() => actionResults.length >= 1, 2000)

  // R16.3: AttentionItem 命中
  check('R16.3.3: emit(orca/attention) 触发（1 个 AttentionItem）', attentionItems.length === 1)
  const item = attentionItems[0]
  check('R16.3.4: AttentionItem.action === "notify_immediately"',
    item?.action === 'notify_immediately')
  check('R16.3.5: AttentionItem.priority === "urgent"',
    item?.priority === 'urgent')
  check('R16.3.6: AttentionItem.ruleId === "orca-e2e-notify"',
    item?.ruleId === E2E_RULE_ID)
  check('R16.3.7: AttentionItem.eventId === e2eEventId',
    item?.eventId === e2eEventId)
  check('R16.3.8: AttentionItem.source === "feishu"',
    item?.source === 'feishu')

  // R16.4: Dedup/Throttle 不阻断首次
  check('R16.4.1: 首次测试事件未被 dedup drop（通过 emit）',
    attentionItems.length === 1)
  check('R16.4.2: 首次测试事件未被 throttle drop',
    throttle.shouldEmit(item) === true)  // 二次验证 throttle 状态

  // R16.5: Decision.action === 'notify'
  check('R16.5.1: emit(orca/decision) 触发（1 个 Decision）', decisions.length === 1)
  const decision = decisions[0]
  check('R16.5.2: Decision.action === "notify"',
    decision?.action === 'notify')
  check('R16.5.3: Decision.priority === "urgent"（从 AttentionItem 透传）',
    decision?.priority === 'urgent')
  check('R16.5.4: Decision.attentionId === AttentionItem.id',
    decision?.attentionId === item?.id)
  check('R16.5.5: Decision.eventId === AttentionItem.eventId === e2eEventId',
    decision?.eventId === item?.eventId && decision?.eventId === e2eEventId)
  check('R16.5.6: Decision.ruleId === AttentionItem.ruleId',
    decision?.ruleId === item?.ruleId)
  check('R16.5.7: Decision.reason 含原 reason 关键信息',
    typeof decision?.reason === 'string' && decision.reason.includes('R16 E2E'))

  // R16.6: NotifyHandler 调用 mock sendToChat() 一次
  check('R16.6.1: NotifyHandler execute 完成 → 1 个 action-result', actionResults.length === 1)
  check('R16.6.2: mock FeishuClient.sendToChat 被调用 1 次',
    mockFeishu.calls.length === 1)

  // R16.7: chatId 来自 eventBus.get(decision.eventId)
  check('R16.7.1: sendToChat chatId === 原始事件 data.chatId',
    mockFeishu.calls[0]?.chatId === e2eChatId)
  check('R16.7.2: sendToChat chatId 与 EventBus.get 反查的 event.data.chatId 一致',
    mockFeishu.calls[0]?.chatId === bus.get(e2eEventId)?.data?.chatId)

  // R16.8: 发送文本符合格式
  const sentText = mockFeishu.calls[0]?.text ?? ''
  check('R16.8.1: 文本以 "[Orca] urgent" 开头',
    sentText.startsWith('[Orca] urgent'))
  check('R16.8.2: 文本包含 reason 关键信息 "R16 E2E"',
    sentText.includes('R16 E2E'))
  check('R16.8.3: 文本包含"源消息:"行（含原事件 text）',
    sentText.includes('源消息:'))
  check('R16.8.4: 文本包含原始消息内容（截断前 200 字符）',
    sentText.includes(e2eText.slice(0, 200)))

  // R16.9: 真实 plugin 链路闭环
  check('R16.9.1: action-result.result.success === true',
    actionResults[0]?.success === true)
  check('R16.9.2: action-result.result.action === "notify"',
    actionResults[0]?.action === 'notify')
  check('R16.9.3: action-result.result.decisionId 存在',
    typeof actionResults[0]?.decisionId === 'string' && actionResults[0].decisionId.length > 0)
  check('R16.9.4: action-result.result.executedAt 是 number',
    typeof actionResults[0]?.executedAt === 'number' && actionResults[0].executedAt > 0)

  // 清理
  disposeAction()
  disposeDecision()
  unsubscribeBus()
}

// ────────────────────────────────────────────────────────────
// R16.11  独立 rule 的 predicate 精度：仅 [Orca E2E] 触发
// ────────────────────────────────────────────────────────────
{
  const ws = createWorldStateService()
  const e2eRegistry = createRuleRegistry()
  e2eRegistry.register({
    id: 'orca-e2e-notify',
    description: 'E2E 验证用临时 rule',
    predicate: ({ event }) =>
      event?.source === 'feishu' && event.type === 'message' &&
      /\[Orca E2E\]/.test(String(event.data.text ?? '')),
    produce: ({ event }) => ({
      priority: 'urgent',
      reason: 'R16 E2E',
      action: 'notify_immediately',
      eventId: event?.id,
    }),
  })
  const e2eEngine = createAttentionEngine(e2eRegistry)

  // 1) 匹配 [Orca E2E] → 1 个 item
  const matchItems = e2eEngine.evaluate({
    event: { id: 'evt_match', source: 'feishu', type: 'message', timestamp: Date.now(), data: { chatId: 'oc_a', text: '[Orca E2E] match' }, priority: 1 },
    state: ws.getState(),
    prevState: undefined,
  })
  check('R16.11.1: 匹配 [Orca E2E] 文本 → 产生 1 个 AttentionItem',
    matchItems.length === 1 && matchItems[0]?.action === 'notify_immediately')

  // 2) 普通文本 → 0 个 item（rule 不会误触发）
  const normalItems = e2eEngine.evaluate({
    event: { id: 'evt_normal', source: 'feishu', type: 'message', timestamp: Date.now(), data: { chatId: 'oc_b', text: 'normal message without marker' }, priority: 1 },
    state: ws.getState(),
    prevState: undefined,
  })
  check('R16.11.2: 普通文本（无 [Orca E2E]）→ 0 个 AttentionItem（rule 不误触发）',
    normalItems.length === 0)

  // 3) 非 feishu source → 0 个 item
  const pcItems = e2eEngine.evaluate({
    event: { id: 'evt_pc', source: 'pc', type: 'app_focus', timestamp: Date.now(), data: { app: 'VSCode' }, priority: 1 },
    state: ws.getState(),
    prevState: undefined,
  })
  check('R16.11.3: 非 feishu source → 0 个 AttentionItem',
    pcItems.length === 0)

  // 4) 清理后 defaultRegistry 仍为 5 条（独立 Registry 完全隔离）
  check('R16.11.4: 测试结束 defaultRegistry 仍 === 5（独立 Registry 完全隔离）',
    ruleRegistrySize() === 5)
}

// ────────── 结果 ──────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-notify-e2e 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-notify-e2e 失败 ${failed.length} 项`)
}
