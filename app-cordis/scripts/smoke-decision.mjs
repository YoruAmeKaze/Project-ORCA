/**
 * Decision Engine 冒烟测试（Phase 4.A）
 * 运行：npm run build && node scripts/smoke-decision.mjs
 *
 * 覆盖：
 *  R13.A  DecisionEngine.decide() 纯函数行为（无副作用 + 透传 + 映射）
 *    R13.1:  notify_immediately      → Decision.action = 'notify'
 *    R13.2:  remember_only           → Decision.action = 'remember'
 *    R13.3:  wait_until_available    → Decision.action = 'defer'
 *    R13.4:  act                     → Decision.action = 'act'
 *    R13.5:  ignore                  → Decision.action = 'no_action'
 *    R13.6:  priority 必须从 AttentionItem 透传（urgent → urgent）
 *    R13.7:  reason 必须保留
 *    R13.8:  attentionId / eventId / ruleId / source 必须能追溯来源
 *    R13.9:  DecisionEngine 必须无外部副作用（不修改输入 / 同步返回 / 多次结果可重复）
 *
 *  R13.B  DecisionEnginePlugin EventBus 集成（Cordis 真实 Context）
 *    R13.10: emit('orca/attention') → 产生 emit('orca/decision')
 *            且不阻塞其他 listener / 不修改 AttentionItem / ctx.decision service 可用
 *
 *  R13.C  AttentionItem.id（back-trace 基础；Phase 4.A 引入）
 *    - engine.evaluate() 生成的 item 必须有稳定唯一 id（UUID 格式）
 *    - 两次 evaluate 同一 input → 不同 id
 */
import { Context } from '@deepseek-ai/cordis'
import { createAttentionEngine } from '../dist/services/attention.js'
import { createDecisionEngine } from '../dist/services/decision.js'
import { decisionEngine } from '../dist/plugins/decision-engine.js'
import { getInitialState } from '../dist/services/worldState.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// 测试辅助：构造 AttentionItem（覆盖默认字段）
function mkItem(overrides = {}) {
  return {
    id: overrides.id ?? `att_${Math.random().toString(36).slice(2)}`,
    ruleId: overrides.ruleId ?? 'test-rule',
    priority: overrides.priority ?? 'normal',
    reason: overrides.reason ?? 'test reason',
    action: overrides.action ?? 'remember_only',
    eventId: overrides.eventId ?? 'evt_test',
    source: overrides.source ?? 'feishu',
    stateSnapshot: overrides.stateSnapshot ?? getInitialState(Date.now()),
    evaluatedAt: overrides.evaluatedAt ?? Date.now(),
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────
// R13.A  DecisionEngine.decide() 纯函数行为
// ────────────────────────────────────────────────────────────
{
  const engine = createDecisionEngine()

  // ── R13.1: notify_immediately → notify ──
  const d1 = engine.decide(mkItem({ action: 'notify_immediately' }))
  check('R13.1.1: notify_immediately → Decision.action = notify', d1.action === 'notify')

  // ── R13.2: remember_only → remember ──
  const d2 = engine.decide(mkItem({ action: 'remember_only' }))
  check('R13.2.1: remember_only → Decision.action = remember', d2.action === 'remember')

  // ── R13.3: wait_until_available → defer ──
  const d3 = engine.decide(mkItem({ action: 'wait_until_available' }))
  check('R13.3.1: wait_until_available → Decision.action = defer', d3.action === 'defer')

  // ── R13.4: act → act ──
  const d4 = engine.decide(mkItem({ action: 'act' }))
  check('R13.4.1: act → Decision.action = act', d4.action === 'act')

  // ── R13.5: ignore → no_action ──
  const d5 = engine.decide(mkItem({ action: 'ignore' }))
  check('R13.5.1: ignore → Decision.action = no_action', d5.action === 'no_action')

  // ── R13.6: priority 必须从 AttentionItem 保留 ──
  const d6a = engine.decide(mkItem({ priority: 'urgent' }))
  check('R13.6.1: priority=urgent → Decision.priority=urgent', d6a.priority === 'urgent')
  const d6b = engine.decide(mkItem({ priority: 'high' }))
  check('R13.6.2: priority=high → Decision.priority=high', d6b.priority === 'high')
  const d6c = engine.decide(mkItem({ priority: 'normal' }))
  check('R13.6.3: priority=normal → Decision.priority=normal', d6c.priority === 'normal')
  const d6d = engine.decide(mkItem({ priority: 'low' }))
  check('R13.6.4: priority=low → Decision.priority=low', d6d.priority === 'low')

  // ── R13.7: reason 必须保留 ──
  const reasonText = '我在测试 reason 字段完整保留（含中文/emoji-free）'
  const d7 = engine.decide(mkItem({ reason: reasonText }))
  check('R13.7.1: reason 完整保留', d7.reason === reasonText)

  // ── R13.8: attentionId / eventId / ruleId / source 必须能追溯 ──
  const item8 = mkItem({
    id: 'att_backtrace_123',
    eventId: 'evt_backtrace_456',
    ruleId: 'feishu-deadline',
    source: 'feishu',
  })
  const d8 = engine.decide(item8)
  check('R13.8.1: attentionId = AttentionItem.id', d8.attentionId === 'att_backtrace_123')
  check('R13.8.2: eventId 保留', d8.eventId === 'evt_backtrace_456')
  check('R13.8.3: ruleId 保留', d8.ruleId === 'feishu-deadline')
  check('R13.8.4: source=feishu 保留', d8.source === 'feishu')

  // 不同 source 也保留
  const d8b = engine.decide(mkItem({ source: 'calendar' }))
  check('R13.8.5: source=calendar 保留', d8b.source === 'calendar')

  // state-only item（eventId=undefined）也保留
  const d8c = engine.decide(mkItem({ eventId: undefined }))
  check('R13.8.6: state-only item eventId=undefined 保留', d8c.eventId === undefined)

  // source=state（state-only 触发标识）也保留
  const d8d = engine.decide(mkItem({ source: 'state' }))
  check('R13.8.7: source=state 保留', d8d.source === 'state')

  // ── R13.9: DecisionEngine 必须无外部副作用 ──
  // 纯函数测试：多次调用结果稳定、不修改输入、decideMany 保序

  // (a) decide() 同步返回
  const item9 = mkItem({ action: 'notify_immediately', reason: 'pure test', priority: 'urgent' })
  const d9a = engine.decide(item9)
  check('R13.9.1: decide() 同步返回 Decision 对象',
    typeof d9a === 'object' && d9a !== null)

  // (b) decisionId 是 string 且非空
  check('R13.9.2: decisionId 是 string 且非空',
    typeof d9a.decisionId === 'string' && d9a.decisionId.length > 0)

  // (c) 多次调用 decisionId 不同（UUID 唯一）
  const d9b = engine.decide(item9)
  check('R13.9.3: 多次调用 decisionId 不同（UUID 唯一）',
    d9a.decisionId !== d9b.decisionId)

  // (d) 其他字段（除 decisionId 和 decidedAt）应一致
  check('R13.9.4: 多次调用 attentionId/action/priority/reason/eventId/ruleId 一致',
    d9a.attentionId === d9b.attentionId &&
    d9a.action === d9b.action &&
    d9a.priority === d9b.priority &&
    d9a.reason === d9b.reason &&
    d9a.eventId === d9b.eventId &&
    d9a.ruleId === d9b.ruleId)

  // (e) 输入 AttentionItem 不被修改
  check('R13.9.5: decide() 不修改 AttentionItem',
    item9.action === 'notify_immediately' &&
    item9.reason === 'pure test' &&
    item9.priority === 'urgent' &&
    item9.id === 'att_backtrace_123')

  // (f) decideMany 顺序保持
  const itemsMany = [
    mkItem({ action: 'notify_immediately', priority: 'high', id: 'a1' }),
    mkItem({ action: 'remember_only', priority: 'normal', id: 'a2' }),
    mkItem({ action: 'wait_until_available', priority: 'low', id: 'a3' }),
  ]
  const dMany = engine.decideMany(itemsMany)
  check('R13.9.6: decideMany 返回长度 = 输入长度', dMany.length === 3)
  check('R13.9.7: decideMany[0].action = notify（保序）',
    dMany[0]?.action === 'notify' && dMany[0]?.attentionId === 'a1')
  check('R13.9.8: decideMany[1].action = remember（保序）',
    dMany[1]?.action === 'remember' && dMany[1]?.attentionId === 'a2')
  check('R13.9.9: decideMany[2].action = defer（保序）',
    dMany[2]?.action === 'defer' && dMany[2]?.attentionId === 'a3')

  // (g) decideMany 不重排 priority（按输入顺序原样保留）
  check('R13.9.10: decideMany 不重排 priority（保序）',
    dMany[0]?.priority === 'high' &&
    dMany[1]?.priority === 'normal' &&
    dMany[2]?.priority === 'low')

  // (h) 输入顺序故意打乱 → 输出仍按输入顺序
  const itemsMixed = [
    mkItem({ action: 'ignore', priority: 'low', id: 'm1' }),
    mkItem({ action: 'notify_immediately', priority: 'urgent', id: 'm2' }),
    mkItem({ action: 'remember_only', priority: 'normal', id: 'm3' }),
  ]
  const dMixed = engine.decideMany(itemsMixed)
  check('R13.9.11: decideMany 按输入顺序（不按 priority 重排）',
    dMixed[0]?.attentionId === 'm1' && dMixed[0]?.priority === 'low' &&
    dMixed[1]?.attentionId === 'm2' && dMixed[1]?.priority === 'urgent' &&
    dMixed[2]?.attentionId === 'm3' && dMixed[2]?.priority === 'normal')

  // (i) decidedAt 在调用前后时间范围内（单调递增的合理时间戳）
  const beforeTime = Date.now()
  const dTime = engine.decide(mkItem())
  const afterTime = Date.now()
  check('R13.9.12: decidedAt 在调用前后时间范围内',
    dTime.decidedAt >= beforeTime && dTime.decidedAt <= afterTime)
}

// ────────────────────────────────────────────────────────────
// R13.B  DecisionEnginePlugin EventBus 集成（真实 Cordis Context）
// ────────────────────────────────────────────────────────────
{
  const ctx = new Context()

  // 静默日志（避免噪音；测试用）
  ctx.logger.exporter({
    colors: 0,
    levels: { default: 3 },
    export() {},
  })

  // 收集 emit('orca/decision', ...) 的 payload
  const decisions = []
  ctx.on('orca/decision', (d) => {
    decisions.push(d)
  })

  // 挂载 plugin（无 inject 依赖；不需 mock service）
  decisionEngine(ctx, { runtime: { decision: { enabled: true } } })

  // 模拟 attention-engine emit('orca/attention', item)
  const itemB1 = mkItem({
    id: 'att_integration_001',
    action: 'notify_immediately',
    priority: 'high',
    reason: 'integration test',
    eventId: 'evt_integration',
    source: 'feishu',
    ruleId: 'feishu-deadline',
  })
  ctx.emit('orca/attention', itemB1)

  // Cordis fork 的 listener 派发可能异步；用 polling 等（避免真实 sleep 掩盖竞态）
  await new Promise((resolve) => {
    let waited = 0
    const poll = () => {
      if (decisions.length > 0 || waited > 200) {
        resolve()
        return
      }
      waited += 5
      setTimeout(poll, 5)
    }
    poll()
  })

  check('R13.10.1: emit(orca/attention) → 1 个 orca/decision', decisions.length === 1)
  const decisionB1 = decisions[0]
  check('R13.10.2: Decision.attentionId = AttentionItem.id',
    decisionB1?.attentionId === 'att_integration_001')
  check('R13.10.3: Decision.action = notify（notify_immediately 映射）',
    decisionB1?.action === 'notify')
  check('R13.10.4: Decision.priority = high（保留）',
    decisionB1?.priority === 'high')
  check('R13.10.5: Decision.reason = "integration test"（保留）',
    decisionB1?.reason === 'integration test')
  check('R13.10.6: Decision.eventId = evt_integration（保留）',
    decisionB1?.eventId === 'evt_integration')
  check('R13.10.7: Decision.source = feishu（保留）',
    decisionB1?.source === 'feishu')
  check('R13.10.8: Decision.ruleId = feishu-deadline（保留）',
    decisionB1?.ruleId === 'feishu-deadline')
  check('R13.10.9: Decision.decisionId 是 string 且非空',
    typeof decisionB1?.decisionId === 'string' && decisionB1.decisionId.length > 0)

  // ctx.decision service 可用（纯函数 + decideMany）
  const svc = ctx.decision
  check('R13.10.10: ctx.decision service 可用（decide 方法）',
    typeof svc?.decide === 'function')
  check('R13.10.11: ctx.decision service 可用（decideMany 方法）',
    typeof svc?.decideMany === 'function')

  // 不阻塞原始 Attention publisher：注册第二个 attention listener，验证也收到事件
  let otherAttentionListenerCalled = false
  ctx.on('orca/attention', () => {
    otherAttentionListenerCalled = true
  })
  decisions.length = 0
  ctx.emit('orca/attention', mkItem({ id: 'att_002', action: 'remember_only', reason: 'second test' }))

  // 同样 polling 等异步派发
  await new Promise((resolve) => {
    let waited = 0
    const poll = () => {
      if ((decisions.length > 0 && otherAttentionListenerCalled) || waited > 200) {
        resolve()
        return
      }
      waited += 5
      setTimeout(poll, 5)
    }
    poll()
  })

  check('R13.10.12: DecisionEnginePlugin 不阻塞其他 attention listener（其他 listener 也被调）',
    otherAttentionListenerCalled === true)
  check('R13.10.13: 第二次 emit 也产生 decision',
    decisions.length === 1 && decisions[0]?.attentionId === 'att_002')
  check('R13.10.14: 第二次 Decision.action = remember（remember_only 映射）',
    decisions[0]?.action === 'remember')

  // FIXME: Cordis fork emit() 不隔离 listener 抛错——任何一个 listener 抛错会导致整个 emit() 崩溃。
  // 本测试意图验证"第三个 listener 抛错时 DecisionEngine listener 仍工作"，但 Cordis fork 当前版本不支持。
  // R13.10.15 在 Node.js 24 + 此版本 Cordis fork 下会崩溃，预期行为无法验证。
  // 相关讨论见 Phase A migration notes。
  let listener3Called = false
  ctx.on('orca/attention', () => {
    listener3Called = true
    throw new Error('simulated third listener error')
  })
  decisions.length = 0
  ctx.emit('orca/attention', mkItem({ id: 'att_003', action: 'ignore' }))

  await new Promise((resolve) => {
    let waited = 0
    const poll = () => {
      if ((decisions.length > 0 && listener3Called) || waited > 200) {
        resolve()
        return
      }
      waited += 5
      setTimeout(poll, 5)
    }
    poll()
  })

  // 注：third listener 抛错 → Cordis 怎么处理取决于 fork 实现；至少 DecisionEngine 自己的 listener 应独立处理
  // 这里我们只验证 DecisionEngine 在第三方 listener 抛错后仍能工作
  check('R13.10.15: DecisionEngine 在第三方 listener 抛错后仍 emit decision',
    decisions.length === 1 && decisions[0]?.attentionId === 'att_003' && decisions[0]?.action === 'no_action')
}

// ────────────────────────────────────────────────────────────
// R13.C  AttentionItem.id（back-trace 基础；Phase 4.A 引入）
// ────────────────────────────────────────────────────────────
{
  const att = createAttentionEngine()
  const state = getInitialState(Date.now())
  // 构造 sleeping 状态触发 sleeping-quiet 规则
  const sleeping = { ...state, user: { ...state.user, status: 'sleeping' } }
  const items = att.evaluate({ event: null, state: sleeping, prevState: undefined })

  check('R13.C.1: 评估产生 item 时含 id 字段',
    items.length > 0 && typeof items[0]?.id === 'string')

  if (items.length > 0 && items[0]) {
    // UUID v4 格式（8-4-4-4-12 hex）
    const idOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(items[0].id)
    check('R13.C.2: item.id 是 UUID 格式', idOk)
  }

  // 两次 evaluate 同一 input → 不同 id（UUID 唯一）
  const itemsA = att.evaluate({ event: null, state: sleeping, prevState: undefined })
  const itemsB = att.evaluate({ event: null, state: sleeping, prevState: undefined })
  check('R13.C.3: 两次 evaluate 同一 input → 不同 id',
    itemsA.length > 0 && itemsB.length > 0 && itemsA[0]?.id !== itemsB[0]?.id)
}

// ────────── 结果 ──────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-decision 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-decision 失败 ${failed.length} 项`)
}
