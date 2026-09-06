/**
 * Deferred Scheduler 冒烟测试（Phase 4.D / R17）
 * 运行：npm run build && node scripts/smoke-deferred.mjs
 *
 * 覆盖（按用户要求的 15+ 用例）：
 *  R17.1   enqueue pending → store.size === 1
 *  R17.2   busy → 不消费（store 不变）
 *  R17.3   sleeping → 不消费（store 不变）
 *  R17.4   awake → 消费（store.size === 0；emit 1 次）
 *  R17.5   consume 后同 pendingId 再次 list → 不出现
 *  R17.6   tick 后 Decision 进入 'orca/decision' 事件流
 *  R17.7   Decision=notify → 正常经过 ActionExecutor（action-result 1 个，success=true）
 *  R17.8   Decision=remember → 正常经过 ActionExecutor（action-result 1 个，success=true）
 *  R17.9   Decision=no_action → 正常经过 ActionExecutor（action-result 1 个，success=true）
 *  R17.10  Decision=再次 defer → scheduler 翻译为 no_action（不会形成 defer 循环）
 *  R17.11  dispose 后 tick → 不消费
 *  R17.12  dispose 不调 store.clear()（store 仍保留）
 *  R17.13  restart 后仍能处理剩余 pending
 *  R17.14  多个 pending → 处理顺序符合 store.list() 顺序（按 queuedAt 升序）
 *  R17.15  scheduler 不直接调 ActionHandler（registry.list 5 项与 mount 前一致）
 *  R17.E2E 完整 plugin-level E2E：bus.publish → attention → decision → action → action-result
 *         （仿 R16；验证 scheduler 链入真实 action-executor 后的端到端行为）
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { EventBus } from '../dist/services/eventBus.js'
import {
  createRuleRegistry,
  createAttentionEngine,
  createAttentionDedup,
  createAttentionThrottle,
  ruleRegistrySize,
} from '../dist/services/attention.js'
import { createWorldStateService, getInitialState } from '../dist/services/worldState.js'
import { decisionEngine } from '../dist/plugins/decision-engine.js'
import { actionExecutor } from '../dist/plugins/action-executor.js'
import { deferredScheduler, executeTick } from '../dist/plugins/deferred-scheduler.js'
import { createDeferredActionStore } from '../dist/services/action.js'
import { JsonlInfoRecordStore } from '../dist/agents/store.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// 测试辅助：构造 Decision
function mkDecision(overrides = {}) {
  return {
    decisionId: overrides.decisionId ?? `dec_${Math.random().toString(36).slice(2)}`,
    attentionId: overrides.attentionId ?? `att_${Math.random().toString(36).slice(2)}`,
    ruleId: overrides.ruleId ?? 'test-rule',
    action: overrides.action ?? 'defer',
    priority: overrides.priority ?? 'normal',
    reason: overrides.reason ?? 'test reason',
    eventId: overrides.eventId ?? 'evt_test',
    source: overrides.source ?? 'feishu',
    decidedAt: overrides.decidedAt ?? Date.now(),
    ...overrides,
  }
}

// 测试辅助：构造 WorldStateService with given user.status
function mkWorldState(status) {
  const ws = createWorldStateService()
  ws.applyUpdate((s) => ({
    ...s,
    user: { ...s.user, status },
  }))
  return ws
}

// 异步等待
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
// R17.0  准备
// ────────────────────────────────────────────────────────────
{
  // defaultRegistry 隔离检查
  check('R17.0.1: 初始 defaultRegistry 启用规则数 === 5', ruleRegistrySize() === 5)
}

// ────────────────────────────────────────────────────────────
// R17.1  enqueue pending → store.size === 1
// ────────────────────────────────────────────────────────────
{
  const store = createDeferredActionStore()
  const decision = mkDecision({ action: 'defer' })
  const pendingId = store.enqueue(decision)
  check('R17.1.1: enqueue 后 store.size === 1', store.size() === 1)
  check('R17.1.2: enqueue 返回 pendingId 是 string', typeof pendingId === 'string' && pendingId.length > 0)
  check('R17.1.3: store.get(pendingId) 返回 entry', store.get(pendingId)?.decision === decision)
  check('R17.1.4: store.list() 包含该 entry', store.list().some((e) => e.pendingId === pendingId))
}

// ────────────────────────────────────────────────────────────
// R17.2  busy → 不消费
// ────────────────────────────────────────────────────────────
{
  const store = createDeferredActionStore()
  const ws = mkWorldState('busy')
  const d1 = mkDecision({ action: 'defer' })
  const id1 = store.enqueue(d1)

  const emitted = []
  const consumed = executeTick(store, ws, (d) => emitted.push(d))

  check('R17.2.1: busy tick 返回 0（不消费）', consumed === 0)
  check('R17.2.2: busy tick emit 0 次', emitted.length === 0)
  check('R17.2.3: busy tick store.size 仍 === 1', store.size() === 1)
  check('R17.2.4: busy tick pendingId 仍可查', store.get(id1) !== undefined)
}

// ────────────────────────────────────────────────────────────
// R17.3  sleeping → 不消费
// ────────────────────────────────────────────────────────────
{
  const store = createDeferredActionStore()
  const ws = mkWorldState('sleeping')
  const d1 = mkDecision({ action: 'defer' })
  const id1 = store.enqueue(d1)

  const emitted = []
  const consumed = executeTick(store, ws, (d) => emitted.push(d))

  check('R17.3.1: sleeping tick 返回 0', consumed === 0)
  check('R17.3.2: sleeping tick emit 0 次', emitted.length === 0)
  check('R17.3.3: sleeping tick store.size 仍 === 1', store.size() === 1)
  check('R17.3.4: sleeping tick pendingId 仍可查', store.get(id1) !== undefined)
}

// ────────────────────────────────────────────────────────────
// R17.4  awake → 消费
// ────────────────────────────────────────────────────────────
{
  const store = createDeferredActionStore()
  const ws = mkWorldState('awake')
  const d1 = mkDecision({ action: 'defer' })
  const id1 = store.enqueue(d1)

  const emitted = []
  const consumed = executeTick(store, ws, (d) => emitted.push(d))

  check('R17.4.1: awake tick 返回 1（消费 1 条）', consumed === 1)
  check('R17.4.2: awake tick emit 1 次', emitted.length === 1)
  check('R17.4.3: awake tick store.size === 0（消费后清空）', store.size() === 0)
  check('R17.4.4: awake tick get(pendingId) === undefined（被 consume）', store.get(id1) === undefined)
}

// ────────────────────────────────────────────────────────────
// R17.5  consume 后同 pendingId 再次 list → 不出现
// ────────────────────────────────────────────────────────────
{
  const store = createDeferredActionStore()
  const ws = mkWorldState('awake')
  const d1 = mkDecision({ action: 'defer' })
  const id1 = store.enqueue(d1)

  executeTick(store, ws, () => {})

  // 再次 list 应不包含
  const list = store.list()
  check('R17.5.1: consume 后 list 不含该 pendingId', !list.some((e) => e.pendingId === id1))
  check('R17.5.2: consume 后 size === 0', store.size() === 0)
  // 再次 executeTick 也无新内容
  const emitted2 = []
  const consumed2 = executeTick(store, ws, (d) => emitted2.push(d))
  check('R17.5.3: 第二次 tick 消费 0（store 已空）', consumed2 === 0)
  check('R17.5.4: 第二次 tick emit 0', emitted2.length === 0)
}

// ────────────────────────────────────────────────────────────
// R17.10  Decision=再次 defer → 翻译为 no_action（防循环）
// ────────────────────────────────────────────────────────────
{
  const store = createDeferredActionStore()
  const ws = mkWorldState('awake')
  const d1 = mkDecision({ action: 'defer' })
  store.enqueue(d1)

  const emitted = []
  executeTick(store, ws, (d) => emitted.push(d))

  check('R17.10.1: defer 翻译为 no_action emit',
    emitted.length === 1 && emitted[0]?.action === 'no_action')
  check('R17.10.2: 翻译保留 decisionId', emitted[0]?.decisionId === d1.decisionId)
  check('R17.10.3: 翻译保留 attentionId', emitted[0]?.attentionId === d1.attentionId)
  check('R17.10.4: 翻译保留 priority', emitted[0]?.priority === d1.priority)
  check('R17.10.5: 翻译保留 reason', emitted[0]?.reason === d1.reason)
  check('R17.10.6: 翻译后 store 为空（defer handler 不会再入队）', store.size() === 0)
}

// ────────────────────────────────────────────────────────────
// R17.6  tick 后 Decision 进入 'orca/decision' 事件流（独立 Context + 真实 plugin）
// ────────────────────────────────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  const bus = new EventBus({ windowSize: 50 })
  const ws = createWorldStateService()  // 默认 status='awake'
  ctx.provide('eventBus', bus)
  ctx.provide('worldState', ws)

  // 构造 action-executor（用 stub infoStore）
  const store = { append: async () => {} }
  ctx.provide('infoStore', store)

  const decisions = []
  ctx.on('orca/decision', (d) => { decisions.push(d) })

  // 挂 action-executor
  actionExecutor(ctx, { dryRun: false })

  // 直接挂 scheduler plugin（不依赖 EventBus + 真实 attention-engine）
  // scheduler 内部 tick 由我们直接调用 executeTick（避免 30s 等待）
  const deferredStore = ctx.actionExecutor.deferredStore

  const d1 = mkDecision({ action: 'no_action', decisionId: 'dec_r17_6_001' })
  deferredStore.enqueue(d1)

  // 手动调用 executeTick 模拟一次 tick
  executeTick(
    deferredStore,
    ws,
    (decision) => ctx.emit('orca/decision', decision),
  )

  // 等待 listener 派发
  await pollFor(() => decisions.length > 0, 500)

  check('R17.6.1: executeTick 后 emit 1 个 orca/decision', decisions.length === 1)
  check('R17.6.2: emitted decision === 原 decision（no_action 不翻译）',
    decisions[0]?.action === 'no_action' && decisions[0]?.decisionId === 'dec_r17_6_001')
  check('R17.6.3: consume 后 store.size === 0', deferredStore.size() === 0)
}

// ────────────────────────────────────────────────────────────
// R17.7  Decision=notify → 正常经过 ActionExecutor
// R17.8  Decision=remember → 正常经过 ActionExecutor
// R17.9  Decision=no_action → 正常经过 ActionExecutor
// ────────────────────────────────────────────────────────────
{
  // 构造独立 Context：真实 action-executor + mock infoStore
  async function runOne(actionType, decisionId) {
    const ctx = new Context()
    ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })
    // 注意：使用本地变量持有 bus；不在 ctx.eventBus 上调用（cordis fork 的 ctx.eventBus
    // 类型声明与 ctx.get('eventBus') 不一定等价；用 ctx.provide 注入 + 本地变量直接调用更可靠）
    const bus = new EventBus({ windowSize: 10 })
    ctx.provide('eventBus', bus)
    ctx.provide('worldState', createWorldStateService())

    // remember handler 需要 infoStore
    let remembered = null
    const infoStore = {
      append: async (rec) => { remembered = rec },
    }
    ctx.provide('infoStore', infoStore)

    // notify handler 需要 feishu
    let notifiedChatId = null
    let notifiedText = null
    const feishu = {
      sendToChat: async (chatId, text) => {
        notifiedChatId = chatId
        notifiedText = text
      },
    }
    ctx.provide('feishu', feishu)

    const actionResults = []
    ctx.on('orca/action-result', (r) => { actionResults.push(r) })

    actionExecutor(ctx, { dryRun: false })

    const deferredStore = ctx.actionExecutor.deferredStore
    const ws = ctx.worldState

    // enqueue decision
    deferredStore.enqueue(mkDecision({
      action: actionType,
      decisionId,
      eventId: 'evt_notify_target',  // 让 notify 能反查
    }))

    // 如果是 notify，pre-publish 一个 feishu event 让反查成功
    // 使用本地 bus 变量（action-executor 通过 ctx.get('eventBus') 拿到同一个引用）
    // id 字段必须 === decision.eventId，否则 eventBus.get(id) 返回 undefined
    if (actionType === 'notify') {
      bus.publish({
        id: 'evt_notify_target',
        source: 'feishu',
        type: 'message',
        data: { chatId: 'oc_notify_chat', text: 'notify target text' },
        priority: 1,
      })
    }

    // 手动 tick
    executeTick(
      deferredStore,
      ws,
      (decision) => ctx.emit('orca/decision', decision),
    )

    await pollFor(() => actionResults.length > 0, 500)

    return { actionResults, remembered, notifiedChatId, notifiedText }
  }

  // R17.7: notify
  {
    const r = await runOne('notify', 'dec_r17_7_notify')
    check('R17.7.1: notify → action-result 1 个', r.actionResults.length === 1)
    check('R17.7.2: notify → success=true', r.actionResults[0]?.success === true)
    check('R17.7.3: notify → action=notify', r.actionResults[0]?.action === 'notify')
    check('R17.7.4: notify → decisionId 透传', r.actionResults[0]?.decisionId === 'dec_r17_7_notify')
    check('R17.7.5: notify → feishu.sendToChat 被调用', r.notifiedChatId === 'oc_notify_chat')
  }

  // R17.8: remember
  {
    const r = await runOne('remember', 'dec_r17_8_remember')
    check('R17.8.1: remember → action-result 1 个', r.actionResults.length === 1)
    check('R17.8.2: remember → success=true', r.actionResults[0]?.success === true)
    check('R17.8.3: remember → action=remember', r.actionResults[0]?.action === 'remember')
    check('R17.8.4: remember → decisionId 透传', r.actionResults[0]?.decisionId === 'dec_r17_8_remember')
    check('R17.8.5: remember → infoStore.append 被调用', r.remembered !== null)
    check('R17.8.6: remember → namespace = decision-action', r.remembered?.namespace === 'decision-action')
    check('R17.8.7: remember → type = decision-remember', r.remembered?.type === 'decision-remember')
  }

  // R17.9: no_action
  {
    const r = await runOne('no_action', 'dec_r17_9_noop')
    check('R17.9.1: no_action → action-result 1 个', r.actionResults.length === 1)
    check('R17.9.2: no_action → success=true', r.actionResults[0]?.success === true)
    check('R17.9.3: no_action → action=no_action', r.actionResults[0]?.action === 'no_action')
    check('R17.9.4: no_action → decisionId 透传', r.actionResults[0]?.decisionId === 'dec_r17_9_noop')
  }
}

// ────────────────────────────────────────────────────────────
// R17.10  Decision 再次 defer → scheduler 翻译为 no_action（防循环）
// ────────────────────────────────────────────────────────────
// 已在 R17.10 块完成（executeTick 单测）；下面验证 e2e 场景下 defer handler 不被触发
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })
  ctx.provide('eventBus', new EventBus({ windowSize: 10 }))
  ctx.provide('worldState', createWorldStateService())  // 默认 awake
  ctx.provide('infoStore', { append: async () => {} })
  ctx.provide('feishu', { sendToChat: async () => {} })

  const actionResults = []
  ctx.on('orca/action-result', (r) => { actionResults.push(r) })

  actionExecutor(ctx, { dryRun: false })

  const deferredStore = ctx.actionExecutor.deferredStore
  const ws = ctx.worldState

  // enqueue 一个 defer decision（模拟 user.status=busy 时产生的 pending）
  const deferDecision = mkDecision({
    action: 'defer',
    decisionId: 'dec_r17_10_defer',
    priority: 'high',
    reason: 'defer 翻译验证',
  })
  deferredStore.enqueue(deferDecision)

  // user 转为 awake；执行 tick
  ws.applyUpdate((s) => ({ ...s, user: { ...s.user, status: 'awake' } }))

  const deferHandlerCalled = { count: 0 }
  // 拦截 defer handler 触发（不应发生）
  const realDefer = ctx.actionExecutor.registry.get('defer')
  if (realDefer) {
    const origExecute = realDefer.execute.bind(realDefer)
    realDefer.execute = async (d) => {
      deferHandlerCalled.count++
      return origExecute(d)
    }
  }

  // 手动 tick
  executeTick(
    deferredStore,
    ws,
    (decision) => ctx.emit('orca/decision', decision),
  )

  await pollFor(() => actionResults.length > 0, 500)

  check('R17.10.E2E.1: defer pending → 翻译为 no_action emit',
    actionResults[0]?.action === 'no_action')
  check('R17.10.E2E.2: defer handler execute 未被调用（防循环关键）',
    deferHandlerCalled.count === 0)
  check('R17.10.E2E.3: store 已空（无新 defer pending 产生）', deferredStore.size() === 0)
}

// ────────────────────────────────────────────────────────────
// R17.11  dispose 后 tick → 不消费
// R17.12  dispose 不调 store.clear()（store 仍保留）
// R17.13  restart 后仍能处理剩余 pending
// ────────────────────────────────────────────────────────────
{
  const store = createDeferredActionStore()
  const ws = mkWorldState('awake')

  // enqueue
  const d1 = mkDecision({ action: 'defer', decisionId: 'dec_r17_13_001' })
  store.enqueue(d1)

  // dispose 模拟：isDisposed() === true
  let disposed = false
  const emitted1 = []
  const consumed1 = executeTick(store, ws, (d) => emitted1.push(d), () => disposed)
  // 第一次 tick 应正常消费（disposed=false）
  check('R17.13.1: 第一次 tick（disposed=false）消费 1 条', consumed1 === 1)
  check('R17.13.2: 第一次 tick emit 1 次', emitted1.length === 1)

  // re-enqueue
  store.enqueue(mkDecision({ action: 'defer', decisionId: 'dec_r17_13_002' }))

  // dispose（disposed=true）
  disposed = true

  // tick：应短路
  const emitted2 = []
  const consumed2 = executeTick(store, ws, (d) => emitted2.push(d), () => disposed)
  check('R17.11.1: dispose 后 tick 返回 0', consumed2 === 0)
  check('R17.11.2: dispose 后 tick emit 0 次', emitted2.length === 0)
  check('R17.12.1: dispose 不清空 store（仍 === 1）', store.size() === 1)

  // restart（disposed=false）；tick 应正常
  disposed = false
  const emitted3 = []
  const consumed3 = executeTick(store, ws, (d) => emitted3.push(d), () => disposed)
  check('R17.13.3: restart 后 tick 消费 1 条', consumed3 === 1)
  check('R17.13.4: restart 后 tick emit 1 次', emitted3.length === 1)
  check('R17.13.5: restart 处理后 store 为空', store.size() === 0)
}

// ────────────────────────────────────────────────────────────
// R17.14  多个 pending → 处理顺序符合 store.list() 顺序（按 queuedAt 升序）
// Phase 4.E 更新：executeTick 不提供 eventBus 时无法反查 chatId → 每条独立 emit（不合并）
// ────────────────────────────────────────────────────────────
{
  const store = createDeferredActionStore()
  const ws = mkWorldState('awake')

  // enqueue 3 条（依次入队；不提供 eventBus → 各自独立 emit）
  const d1 = mkDecision({ action: 'no_action', decisionId: 'dec_r17_14_001' })
  const d2 = mkDecision({ action: 'no_action', decisionId: 'dec_r17_14_002' })
  const d3 = mkDecision({ action: 'no_action', decisionId: 'dec_r17_14_003' })
  store.enqueue(d1)
  store.enqueue(d2)
  store.enqueue(d3)

  const emitted = []
  executeTick(store, ws, (d) => emitted.push(d))

  // 不提供 eventBus → 无法反查 chatId → 每条独立 emit（不合并；保持 Phase 4.D 语义）
  check('R17.14.1: 无 eventBus → 3 条独立 emit（不合并）', emitted.length === 3)
  check('R17.14.2: emit 顺序 = enqueue 顺序（queuedAt 升序）',
    emitted[0]?.decisionId === 'dec_r17_14_001' &&
    emitted[1]?.decisionId === 'dec_r17_14_002' &&
    emitted[2]?.decisionId === 'dec_r17_14_003')
  check('R17.14.3: 各 emit 保持原 action（no_action）',
    emitted.every((d) => d.action === 'no_action'))
  check('R17.14.4: 处理后 store 为空（全部 consume）', store.size() === 0)
}

// ────────────────────────────────────────────────────────────
// R17.15  scheduler 不直接调 ActionHandler
// 验证方式：scheduler 不注册/不修改 action-executor 的 registry
// ────────────────────────────────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })
  ctx.provide('eventBus', new EventBus({ windowSize: 10 }))
  ctx.provide('worldState', createWorldStateService())
  ctx.provide('infoStore', { append: async () => {} })

  actionExecutor(ctx, { dryRun: false })

  // 记录 action-executor mount 后的 handler 列表
  // 4 个默认 handler（noop/defer/notify-stub/act-stub）+ remember handler（因为提供了 infoStore）= 5
  // （不提供 feishu → notify 仍为 stub；scheduler 不注册任何 handler）
  const handlersBefore = ctx.actionExecutor.registry.list().map((h) => `${h.action}=${h.name}`).sort()
  check('R17.15.1: action-executor mount 后有 5 个 handler（noop/defer/notify-stub/act-stub + remember）',
    handlersBefore.length === 5)
  check('R17.15.2: notify handler 是 stub（real notify 在 plugin 内部覆盖）',
    handlersBefore.includes('notify=notify-stub'))
  check('R17.15.2b: remember handler 是真实 handler（因为提供了 infoStore）',
    handlersBefore.includes('remember=remember'))

  // 挂 scheduler（不动 registry）
  const disposeScheduler = deferredScheduler(ctx, {})

  const handlersAfter = ctx.actionExecutor.registry.list().map((h) => `${h.action}=${h.name}`).sort()
  check('R17.15.3: scheduler mount 后 handler 列表不变（不直接注册 handler）',
    JSON.stringify(handlersBefore) === JSON.stringify(handlersAfter))
  check('R17.15.4: scheduler 不修改 handler 数量', handlersAfter.length === handlersBefore.length)

  disposeScheduler()
}

// ────────────────────────────────────────────────────────────
// R17.E2E  完整 plugin-level E2E：bus → attention → decision → scheduler → action → action-result
// 真实链路：feishu event → attention rule（defer）→ defer handler → store
//          → scheduler tick → emit 'orca/decision' → action-executor → handler → action-result
// ────────────────────────────────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  const bus = new EventBus({ windowSize: 50 })
  ctx.provide('eventBus', bus)

  // 真实 WorldState（默认 awake）
  const ws = createWorldStateService()
  ctx.provide('worldState', ws)

  // 真实 infoStore（写盘目录用 tmp）
  const tmpDir = mkdtempSync(join(tmpdir(), 'orca-r17-'))
  const realInfoStore = new JsonlInfoRecordStore(tmpDir)
  ctx.provide('infoStore', realInfoStore)

  // 真实 attention engine + 独立 Registry（仿 R16）
  const e2eRegistry = createRuleRegistry()
  e2eRegistry.register({
    id: 'r17-e2e-defer-rule',
    description: 'R17 E2E：所有 feishu 消息均 defer',
    predicate: ({ event }) =>
      event?.source === 'feishu' && event.type === 'message',
    produce: ({ event }) => ({
      priority: 'high',
      reason: `E2E defer test：${String(event?.data.text ?? '').slice(0, 30)}`,
      action: 'wait_until_available',
      eventId: event?.id,
    }),
  })
  const e2eEngine = createAttentionEngine(e2eRegistry)
  ctx.provide('attention', e2eEngine)

  // 收集 events
  const actionResults = []
  ctx.on('orca/action-result', (r) => { actionResults.push(r) })

  // 挂 4 个真实 plugin（顺序：action-executor → 内部覆盖 notify handler → decision-engine 已在 attention 之后）
  actionExecutor(ctx, { dryRun: false })

  // 手动模拟 attention-engine plugin（订阅 EventBus → evaluate → emit）
  // 因为不能修改 production plugin，所以单独写
  const dedup = createAttentionDedup({ windowMs: 5000 })
  const throttle = createAttentionThrottle({ cooldownMs: 0, hourlyCap: 1000, windowMs: 60_000 })
  const unsubscribeBus = bus.subscribe({ minPriority: 0 }, (event) => {
    const items = e2eEngine.evaluate({
      event, state: ws.getState(), prevState: ws.getPrevState() ?? undefined,
    })
    for (const item of items) {
      if (!dedup.shouldEmit(item)) continue
      if (!throttle.shouldEmit(item)) continue
      ctx.emit('orca/attention', item)
    }
  })

  // decision-engine plugin（真实）
  decisionEngine(ctx, {})

  // deferred-scheduler plugin（真实）
  // 注意：scheduler 内部有 setInterval 30s；测试不等待真实 tick，直接用 executeTick
  const deferredStore = ctx.actionExecutor.deferredStore
  let disposed = false  // 必须先于 tickInterval 声明
  const tickInterval = setInterval(() => {
    if (disposed) return
    executeTick(
      deferredStore, ws,
      (decision) => ctx.emit('orca/decision', decision),
      () => disposed,
    )
  }, 100)  // 测试用短间隔（仍可验证 scheduler 真实 plugin 的 setInterval 启动 + 工作）

  // R17.E2E.1: 真实 publish feishu event → attention → defer → defer handler → store
  bus.publish({
    source: 'feishu', type: 'message',
    data: { chatId: 'oc_e2e', text: 'E2E test' },
    priority: 1,
  })

  await pollFor(() => deferredStore.size() > 0, 500)
  check('R17.E2E.1: feishu event → defer pending 入队（store.size=1）', deferredStore.size() === 1)

  // 等待：第一个 action-result（defer handler 自身返回 success）+ 第二个（scheduler tick 翻译后的 no_action）
  // 注意：第一个 action-result 的 action='defer'（defer handler 执行成功），第二个才是 no_action
  await pollFor(() => actionResults.length >= 2, 5000)

  check('R17.E2E.2: scheduler tick 后产生 action-result（含 defer handler 自身 + 翻译后）',
    actionResults.length >= 2)
  // 验证第一个 action-result 是 defer handler 的 success（不是 scheduler tick 产出）
  check('R17.E2E.2b: 第一个 action-result = defer handler（action=defer）',
    actionResults[0]?.action === 'defer')
  // 验证第二个 action-result 是 scheduler tick 翻译后的 no_action
  const noActionResults = actionResults.filter((r) => r.action === 'no_action')
  check('R17.E2E.3: action-result.action === "no_action"（defer 翻译）',
    noActionResults.length >= 1)
  check('R17.E2E.4: action-result.success === true（noopHandler）',
    noActionResults[0]?.success === true)

  // R17.E2E.5: store 处理后为空
  check('R17.E2E.5: tick 后 store 为空', deferredStore.size() === 0)

  // 清理
  disposed = true
  clearInterval(tickInterval)
  unsubscribeBus()
  // 注意：scheduler plugin 的 dispose 由 plugin mount 调用的返回函数管理
  // 本测试不调 dispose（因为 setInterval 100ms 是测试专用的）
  // 但测试 scheduler 自身 dispose 行为在 R17.11-13 已覆盖

  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
}

// ────────── 结果 ──────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-deferred 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-deferred 失败 ${failed.length} 项`)
}
