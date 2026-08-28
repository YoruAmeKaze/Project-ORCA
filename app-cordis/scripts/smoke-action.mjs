/**
 * Action Executor 冒烟测试（Phase 4.B）
 * 运行：npm run build && node scripts/smoke-action.mjs
 *
 * 覆盖：
 *  R14.A  ActionHandlerRegistry 行为
 *    R14.0:  register / get / list / size / clear / unregister（Last-Write-Wins）
 *
 *  R14.B  ActionExecutor 单条 Decision → ActionResult 行为
 *    R14.1:  no_action  → success=true（safe noop）
 *    R14.2:  remember   → success=true（写入 infoStore 真实档案）
 *    R14.3:  defer      → success=true + metadata.pendingId + 可从 store 查询
 *    R14.4:  notify     → success=false + "notification handler not configured"（stub）
 *    R14.5:  act        → success=false + "action handler not configured"（**安全 stub**）
 *    R14.6:  未知 action → success=false + "no handler registered for action"
 *    R14.7:  handler 抛异常 → Executor 捕获 → success=false + EventBus 不崩溃
 *
 *  R14.C  Decision → ActionExecutor Cordis 集成
 *    R14.8:  emit('orca/decision') → produce emit('orca/action-result')
 *            含 decisionId / action / executedAt / 不阻塞其他 listener
 *
 *  R14.D  ActionResult 追溯
 *    R14.9:  result.decisionId / result.action / result.executedAt / result.error 可追溯
 *
 *  R14.E  生命周期
 *    R14.10: dispose 后不再执行 handler（订阅取消）
 *
 *  R14.F  安全边界
 *    R14.11: act handler 不执行任意 shell / 不读 fs / 不调插件
 *            （通过 stub 返回 success=false 验证）
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { JsonlInfoRecordStore } from '../dist/agents/store.js'
import {
  createActionExecutor,
  createActionHandlerRegistry,
  createDeferredActionStore,
  createRememberHandler,
  createDeferHandler,
  createNotifyStubHandler,
  createActStubHandler,
  noopHandler,
} from '../dist/services/action.js'
import { actionExecutor } from '../dist/plugins/action-executor.js'

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
    action: overrides.action ?? 'no_action',
    priority: overrides.priority ?? 'normal',
    reason: overrides.reason ?? 'test reason',
    eventId: overrides.eventId ?? 'evt_test',
    source: overrides.source ?? 'feishu',
    decidedAt: overrides.decidedAt ?? Date.now(),
    ...overrides,
  }
}

// 临时档案目录（隔离每个 R14.2 测试）
const tmpRoot = mkdtempSync(join(tmpdir(), 'orca-r14-'))
function makeTmpStore() {
  return new JsonlInfoRecordStore(tmpRoot)
}

// ────────────────────────────────────────────────────────────
// R14.A  ActionHandlerRegistry 基础行为
// ────────────────────────────────────────────────────────────
{
  const reg = createActionHandlerRegistry()

  // R14.0.1: 空 registry size = 0
  check('R14.0.1: 空 registry size === 0', reg.size() === 0)
  check('R14.0.2: 空 registry get(noop) === undefined', reg.get('no_action') === undefined)
  check('R14.0.3: 空 registry list() === []', reg.list().length === 0)

  // R14.0.4: register 后 get 可查到
  reg.register(noopHandler)
  check('R14.0.4: register noop 后 get(no_action) === noopHandler', reg.get('no_action') === noopHandler)
  check('R14.0.5: size === 1', reg.size() === 1)

  // R14.0.6: list 返回 1 项
  check('R14.0.6: list() 返回 1 项', reg.list().length === 1)

  // R14.0.7: Last-Write-Wins：同 action 再次 register 覆盖
  const overrideHandler = {
    name: 'override',
    action: 'no_action',
    async execute() {
      return {
        success: true,
        action: 'no_action',
        decisionId: 'override-test',
        executedAt: Date.now(),
      }
    },
  }
  reg.register(overrideHandler)
  check('R14.0.7: 同 action 重复 register 覆盖（Last-Write-Wins）',
    reg.get('no_action') === overrideHandler)
  check('R14.0.8: 覆盖后 size 仍 === 1（同 action 不重复计数）', reg.size() === 1)

  // R14.0.9: unregister 不存在 action 不报错
  let unregThrew = false
  try { reg.unregister('nonexistent') } catch { unregThrew = true }
  check('R14.0.9: unregister 不存在 action 不报错', !unregThrew)

  // R14.0.10: unregister 后 get === undefined
  reg.unregister('no_action')
  check('R14.0.10: unregister 后 get(no_action) === undefined', reg.get('no_action') === undefined)
  check('R14.0.11: unregister 后 size === 0', reg.size() === 0)

  // R14.0.12: clear 清空
  reg.register(noopHandler)
  reg.register(createActStubHandler())
  reg.clear()
  check('R14.0.12: clear 后 size === 0', reg.size() === 0)
}

// ────────────────────────────────────────────────────────────
// R14.B  ActionExecutor.execute() 行为
// ────────────────────────────────────────────────────────────

// ── R14.1: no_action → success=true ──
{
  const executor = createActionExecutor()
  const decision = mkDecision({ action: 'no_action', decisionId: 'dec_noop_001' })
  const result = await executor.execute(decision)

  check('R14.1.1: no_action → success=true', result.success === true)
  check('R14.1.2: no_action → action 保留', result.action === 'no_action')
  check('R14.1.3: no_action → decisionId 透传', result.decisionId === 'dec_noop_001')
  check('R14.1.4: no_action → executedAt 是 number', typeof result.executedAt === 'number' && result.executedAt > 0)
  check('R14.1.5: no_action → 无 error', result.error === undefined)

  // 不修改 Decision（决策层与执行层隔离）
  check('R14.1.6: no_action → Decision 不被修改',
    decision.action === 'no_action' && decision.decisionId === 'dec_noop_001')
}

// ── R14.2: remember → success=true + 真实写入 infoStore ──
{
  const store = makeTmpStore()
  const executor = createActionExecutor()
  executor.registry.register(createRememberHandler({ store, logger: console }))

  const decision = mkDecision({
    action: 'remember',
    decisionId: 'dec_remember_001',
    attentionId: 'att_remember_001',
    ruleId: 'feishu-deadline',
    priority: 'high',
    reason: 'remember test',
  })
  const result = await executor.execute(decision)

  check('R14.2.1: remember → success=true', result.success === true)
  check('R14.2.2: remember → decisionId 透传', result.decisionId === 'dec_remember_001')
  check('R14.2.3: remember → action 保留', result.action === 'remember')

  // 验证真实写入档案
  const records = await store.query({ namespaces: ['decision-action'] })
  check('R14.2.4: remember → infoStore 写入 1 条',
    records.length === 1)
  if (records.length > 0) {
    const r = records[0]
    check('R14.2.5: remember → namespace = decision-action', r.namespace === 'decision-action')
    check('R14.2.6: remember → type = decision-remember', r.type === 'decision-remember')
    check('R14.2.7: remember → source = action-executor', r.source === 'action-executor')
    check('R14.2.8: remember → payload.attentionId 保留',
      r.payload?.attentionId === 'att_remember_001')
    check('R14.2.9: remember → payload.ruleId 保留',
      r.payload?.ruleId === 'feishu-deadline')
    check('R14.2.10: remember → payload.priority 保留',
      r.payload?.priority === 'high')
    check('R14.2.11: remember → payload.reason 保留',
      r.payload?.reason === 'remember test')
    check('R14.2.12: remember → urgency = 0（静默）',
      (r.urgency ?? 0) === 0)
  }
}

// ── R14.3: defer → success=true + pending store ──
{
  const deferred = createDeferredActionStore()
  const executor = createActionExecutor({ deferredStore: deferred })
  // 默认 executor 已注册 defer handler（指向传入的 deferred）

  const decision = mkDecision({
    action: 'defer',
    decisionId: 'dec_defer_001',
    ruleId: 'calendar-busy-soon',
  })
  const result = await executor.execute(decision)

  check('R14.3.1: defer → success=true', result.success === true)
  check('R14.3.2: defer → metadata.pendingId 是 string',
    typeof result.metadata?.pendingId === 'string' && (result.metadata?.pendingId ?? '').length > 0)

  // 通过 store 查询
  const pendingId = result.metadata?.pendingId
  const entry = pendingId ? deferred.get(pendingId) : undefined
  check('R14.3.3: defer → store.get(pendingId) 找到 entry', entry !== undefined)
  if (entry) {
    check('R14.3.4: defer → entry.decision 完整保留',
      entry.decision.decisionId === 'dec_defer_001' &&
      entry.decision.action === 'defer')
    check('R14.3.5: defer → entry.queuedAt 是 number',
      typeof entry.queuedAt === 'number' && entry.queuedAt > 0)
  }

  // store.list() 返回排序后列表
  const list = deferred.list()
  check('R14.3.6: defer → store.list() 包含该 pending', list.length === 1)

  // 多条 defer 保序
  await executor.execute(mkDecision({ action: 'defer', decisionId: 'dec_defer_002' }))
  await executor.execute(mkDecision({ action: 'defer', decisionId: 'dec_defer_003' }))
  check('R14.3.7: defer → 多次入队后 list() === 3',
    deferred.list().length === 3)
  check('R14.3.8: defer → list() 按 queuedAt 升序',
    deferred.list()[0]?.decision.decisionId === 'dec_defer_001')
}

// ── R14.4: notify → success=false（stub 行为）──
{
  const executor = createActionExecutor()
  // 默认已注册 notify stub

  const decision = mkDecision({
    action: 'notify',
    decisionId: 'dec_notify_001',
  })
  const result = await executor.execute(decision)

  check('R14.4.1: notify → success=false（默认 stub）', result.success === false)
  check('R14.4.2: notify → action = notify', result.action === 'notify')
  check('R14.4.3: notify → decisionId 透传', result.decisionId === 'dec_notify_001')
  check('R14.4.4: notify → error 包含 "notification handler not configured"',
    typeof result.error === 'string' && result.error.includes('notification handler not configured'))
}

// ── R14.5: act → success=false（安全 stub；禁止任意 shell）──
{
  const executor = createActionExecutor()

  const decision = mkDecision({
    action: 'act',
    decisionId: 'dec_act_001',
    ruleId: 'some-act-rule',
  })
  const result = await executor.execute(decision)

  check('R14.5.1: act → success=false（**安全 stub**）', result.success === false)
  check('R14.5.2: act → action = act', result.action === 'act')
  check('R14.5.3: act → decisionId 透传', result.decisionId === 'dec_act_001')
  check('R14.5.4: act → error 包含 "action handler not configured"',
    typeof result.error === 'string' && result.error.includes('action handler not configured'))

  // 关键安全验证：act stub 不应执行任意 shell / 任意 JS
  // 通过 executor.registry.list() 确认 act 注册的是 stub
  const actReg = executor.registry.get('act')
  check('R14.5.5: act → handler.name 是 "act-stub"（不是 fake shell）',
    actReg?.name === 'act-stub')

  // 极端测试：构造一个看起来"危险"的 ruleId（包含 shell 元字符），stub 也不应执行
  const dangerousDecision = mkDecision({
    action: 'act',
    decisionId: 'dec_dangerous',
    ruleId: 'rm -rf /',
  })
  const dangerousResult = await executor.execute(dangerousDecision)
  check('R14.5.6: act → 即使 ruleId 看起来危险，仍 stub 拒绝',
    dangerousResult.success === false &&
    typeof dangerousResult.error === 'string' &&
    dangerousResult.error.includes('action handler not configured'))
}

// ── R14.6: 未知 action → success=false ──
{
  const executor = createActionExecutor()

  const decision = mkDecision({
    action: 'unknown_action_xyz',
    decisionId: 'dec_unknown_001',
  })
  const result = await executor.execute(decision)

  check('R14.6.1: 未知 action → success=false', result.success === false)
  check('R14.6.2: 未知 action → action 透传', result.action === 'unknown_action_xyz')
  check('R14.6.3: 未知 action → error 包含 "no handler registered"',
    typeof result.error === 'string' && result.error.includes('no handler registered'))
}

// ── R14.7: handler 抛异常 → Executor 捕获 → success=false ──
{
  const reg = createActionHandlerRegistry()
  // 注册一个会抛异常的 handler
  reg.register({
    name: 'broken',
    action: 'broken_action',
    async execute() {
      throw new Error('simulated handler crash')
    },
  })
  const executor = createActionExecutor({ registry: reg })

  const decision = mkDecision({ action: 'broken_action', decisionId: 'dec_broken_001' })
  const result = await executor.execute(decision)

  check('R14.7.1: handler 抛异常 → success=false', result.success === false)
  check('R14.7.2: handler 抛异常 → error 包含 "threw"',
    typeof result.error === 'string' && result.error.includes('threw'))
  check('R14.7.3: handler 抛异常 → error 含原始消息',
    typeof result.error === 'string' && result.error.includes('simulated handler crash'))
  check('R14.7.4: handler 抛异常 → decisionId 仍透传',
    result.decisionId === 'dec_broken_001')

  // 异步异常也被捕获（返回 rejected promise 但 executor 已 catch）
  const asyncBrokenResult = await executor.execute(mkDecision({
    action: 'broken_action',
    decisionId: 'dec_broken_002',
  }))
  check('R14.7.5: 异步异常 → success=false', asyncBrokenResult.success === false)
}

// ────────────────────────────────────────────────────────────
// R14.C  Cordis 集成（emit orca/decision → emit orca/action-result）
// ────────────────────────────────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  const store = makeTmpStore()
  // 先 provide infoStore（plugin 内部 ctx.get 依赖此 service）
  ctx.provide('infoStore', store)

  // 收集 orca/action-result（必须在 plugin 挂载前注册，否则 plugin emit 时 listener 数量可能受影响）
  const results14c = []
  ctx.on('orca/action-result', (r) => { results14c.push(r) })

  // 挂载 actionExecutor plugin（plugin 内部：创建 executor + 注册 remember handler + 订阅 decision）
  const dispose = actionExecutor(ctx, { runtime: { action: { enabled: true } } })

  // 拿到 plugin 创建的 executor（验证 service 可用 + 后续可读 deferredStore）
  const executor = ctx.actionExecutor

  // ── R14.8: 注入 decision → 产生 action-result ──
  const decision1 = mkDecision({ action: 'no_action', decisionId: 'dec_integration_noop' })
  ctx.emit('orca/decision', decision1)

  // Cordis listener 派发可能异步；polling 等
  await pollFor(() => results14c.length > 0, 500)

  check('R14.8.1: emit(orca/decision noop) → 1 个 orca/action-result', results14c.length === 1)
  const r1 = results14c[0]
  check('R14.8.2: noop → result.success=true', r1?.success === true)
  check('R14.8.3: noop → result.decisionId 透传', r1?.decisionId === 'dec_integration_noop')

  // ── R14.8.x: remember 决策 → 写入 infoStore ──
  results14c.length = 0
  const decision2 = mkDecision({
    action: 'remember',
    decisionId: 'dec_integration_remember',
    attentionId: 'att_int_remember',
  })
  ctx.emit('orca/decision', decision2)
  await pollFor(() => results14c.length > 0, 500)
  check('R14.8.4: remember → 1 个 result', results14c.length === 1)
  check('R14.8.5: remember → result.success=true', results14c[0]?.success === true)

  // 等待 store 写盘完成
  await pollFor(async () => (await store.query({ namespaces: ['decision-action'] })).length >= 1, 500)
  const records = await store.query({ namespaces: ['decision-action'] })
  check('R14.8.6: remember → infoStore 真实写入', records.length >= 1)

  // ── R14.8.x: defer 决策 → pending 入队 ──
  results14c.length = 0
  const decision3 = mkDecision({ action: 'defer', decisionId: 'dec_integration_defer' })
  ctx.emit('orca/decision', decision3)
  await pollFor(() => results14c.length > 0, 500)
  check('R14.8.7: defer → 1 个 result', results14c.length === 1)
  check('R14.8.8: defer → metadata.pendingId 存在',
    typeof results14c[0]?.metadata?.pendingId === 'string')
  check('R14.8.9: defer → 真实入队到 executor.deferredStore',
    executor.deferredStore.size() >= 1)

  // ── R14.8.x: notify 决策 → stub success=false ──
  results14c.length = 0
  ctx.emit('orca/decision', mkDecision({ action: 'notify', decisionId: 'dec_integration_notify' }))
  await pollFor(() => results14c.length > 0, 500)
  check('R14.8.10: notify → 1 个 result', results14c.length === 1)
  check('R14.8.11: notify → result.success=false（stub）',
    results14c[0]?.success === false)
  check('R14.8.12: notify → error 包含 "notification handler not configured"',
    typeof results14c[0]?.error === 'string' &&
    results14c[0].error.includes('notification handler not configured'))

  // ── R14.8.x: act 决策 → stub success=false（**安全边界**）──
  results14c.length = 0
  ctx.emit('orca/decision', mkDecision({ action: 'act', decisionId: 'dec_integration_act' }))
  await pollFor(() => results14c.length > 0, 500)
  check('R14.8.13: act → 1 个 result', results14c.length === 1)
  check('R14.8.14: act → result.success=false（**安全 stub**）',
    results14c[0]?.success === false)
  check('R14.8.15: act → error 包含 "action handler not configured"',
    typeof results14c[0]?.error === 'string' &&
    results14c[0].error.includes('action handler not configured'))

  // ── R14.8.x: 未知 action → success=false ──
  results14c.length = 0
  ctx.emit('orca/decision', mkDecision({ action: 'mystery_action', decisionId: 'dec_integration_unknown' }))
  await pollFor(() => results14c.length > 0, 500)
  check('R14.8.16: 未知 action → 1 个 result', results14c.length === 1)
  check('R14.8.17: 未知 action → result.success=false',
    results14c[0]?.success === false)
  check('R14.8.18: 未知 action → error 包含 "no handler registered"',
    typeof results14c[0]?.error === 'string' &&
    results14c[0].error.includes('no handler registered'))

  // ── R14.8.x: 不阻塞其他 decision listener ──
  let otherListenerCalled = false
  ctx.on('orca/decision', () => { otherListenerCalled = true })
  results14c.length = 0
  ctx.emit('orca/decision', mkDecision({ action: 'no_action', decisionId: 'dec_listener_check' }))
  await pollFor(() => results14c.length > 0 && otherListenerCalled, 500)
  check('R14.8.19: 其他 decision listener 也被调（不阻塞）', otherListenerCalled === true)

  // ── R14.10: dispose 后不再执行 ──
  dispose()
  results14c.length = 0
  ctx.emit('orca/decision', mkDecision({ action: 'no_action', decisionId: 'dec_after_dispose' }))
  // 等一会确认没有 result 产生
  await new Promise((r) => setTimeout(r, 100))
  check('R14.10.1: dispose 后 emit(orca/decision) 不再产生 orca/action-result',
    results14c.length === 0)
}

// ────────────────────────────────────────────────────────────
// R14.D  ActionResult 字段完整性（decisionId / action / executedAt）
// ────────────────────────────────────────────────────────────
{
  const executor = createActionExecutor()
  const before = Date.now()
  const decision = mkDecision({
    action: 'no_action',
    decisionId: 'dec_traceable_001',
  })
  const result = await executor.execute(decision)
  const after = Date.now()

  check('R14.9.1: result.decisionId 透传', result.decisionId === 'dec_traceable_001')
  check('R14.9.2: result.action === decision.action', result.action === decision.action)
  check('R14.9.3: result.executedAt 在调用时间范围内',
    result.executedAt >= before && result.executedAt <= after)
  check('R14.9.4: result.success 是 boolean', typeof result.success === 'boolean')
}

// ────────────────────────────────────────────────────────────
// R14.F  安全边界：act / notify 默认不执行任何副作用
// ────────────────────────────────────────────────────────────
{
  const executor = createActionExecutor()
  const handlers = executor.registry.list().map((h) => h.name)
  // 默认注册：defer / notify-stub / act-stub / noop
  // （remember handler 由 ctx 注入；此处独立 executor 未注入）
  check('R14.11.1: act handler.name === "act-stub"（无 shell）',
    executor.registry.get('act')?.name === 'act-stub')
  check('R14.11.2: notify handler.name === "notify-stub"（无 feishu）',
    executor.registry.get('notify')?.name === 'notify-stub')

  // 验证 act stub 真的不执行任何 IO（Promise 同步 resolve，无 await）
  const decision = mkDecision({ action: 'act', decisionId: 'dec_safety_001' })
  const startTime = Date.now()
  const result = await executor.execute(decision)
  const elapsed = Date.now() - startTime
  check('R14.11.3: act stub 执行时间 < 50ms（无 IO）',
    elapsed < 50 && result.success === false)

  // 验证 notify stub 同样无 IO
  const startTime2 = Date.now()
  await executor.execute(mkDecision({ action: 'notify', decisionId: 'dec_safety_002' }))
  const elapsed2 = Date.now() - startTime2
  check('R14.11.4: notify stub 执行时间 < 50ms（无 IO）', elapsed2 < 50)

  // 默认 handler 列表中**不包含**任何可能的"通用 exec / shell / run" handler
  const dangerousNames = handlers.filter((n) => /exec|shell|run|command/i.test(n))
  check('R14.11.5: 默认 handler 列表不含任何 shell/exec/run handler',
    dangerousNames.length === 0)

  // silence unused
  void createNotifyStubHandler
  void createDeferHandler
  void createActStubHandler
}

// ────────────────────────────────────────────────────────────
// 清理临时目录
// ────────────────────────────────────────────────────────────
try {
  rmSync(tmpRoot, { recursive: true, force: true })
} catch {
  // ignore cleanup errors
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

// ────────── 结果 ──────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-action 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-action 失败 ${failed.length} 项`)
}
