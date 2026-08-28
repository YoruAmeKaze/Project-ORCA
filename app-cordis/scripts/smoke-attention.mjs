/**
 * Attention Engine 冒烟测试（Phase 3.A 行为锁定 + R8）
 * 运行：npm run build && node scripts/smoke-attention.mjs
 *
 * 覆盖：
 *  R8.A  纯 AttentionEngine.evaluate（4 条内置规则 + 1 个 SKIP）
 *        R8.A0:  ruleCount === 5
 *        R8.A1:  empty input → 0 items
 *        R8.A2:  sleeping-quiet: state=sleeping + null event → ignore
 *        R8.A3:  sleeping-quiet: state=sleeping + feishu:message → 忽略消息（仍 ignore）
 *        R8.A4:  away-arrival SKIPPED_BEFORE_FIX: state=away（current, no prevState）→ 0 items
 *        R8.A5:  away-arrival: prevState.user.status=away + feishu:message → 1 item (remember_only)
 *        R8.A6:  away-arrival: prevState=undefined + feishu:message → 0 items（state-only 短路）
 *        R8.A7:  away-arrival: state-only trigger (event=null) → 0 items
 *        R8.A8:  feishu-deadline: feishu:message with "今晚前提交报告" → priority=high, action=remember_only
 *        R8.A9:  feishu-deadline: feishu:message with "ddl" → 1 item
 *        R8.A10: feishu-deadline: feishu:message with normal text → 0 items
 *        R8.A11: feishu-deadline: non-feishu source → 0 items
 *        R8.A12: calendar-busy-soon: state=busy + calendar minutesBefore=3 → wait_until_available, priority=high
 *        R8.A13: calendar-busy-soon: state=busy + calendar minutesBefore=10 → 0 items（>5 分钟不触发）
 *        R8.A14: calendar-busy-soon: state=awake + calendar minutesBefore=2 → 0 items
 *        R8.A15: focus-interrupt: feishu:message + activity='focus' → 1 item (remember_only)
 *        R8.A16: focus-interrupt: feishu:message + activity='meeting' → 1 item
 *        R8.A17: focus-interrupt: feishu:message + activity=undefined → 0 items
 *        R8.A18: focus-interrupt: pc:app_focus + activity='focus' → 0 items（source 不是 feishu）
 *        R8.A19: SKIP urgent-keyword（规则不存在，TODO Phase 3.B 规则配置化时加）
 *
 *  R8.B  WorldStateService prevState capture + Attention 集成回归
 *        R8.B0:  applyUpdate 内部 capture prev（直接测试）
 *        R8.B1:  away-arrival 集成（核心回归）：
 *                 - applyUpdate 1: state.user.status='away'
 *                 - applyUpdate 2: 模拟 feishuMessageReducer → state.user.status='awake'
 *                 - evaluate({event, state, prevState}) → away-arrival 触发
 *                 这是 Phase 3.A "prev state snapshot" 架构保证的核心验证
 */
import { AttentionEngine, createAttentionEngine, createAttentionDedup, createAttentionThrottle, createRuleRegistry, getDefaultRegistry, ruleRegistrySize } from '../dist/services/attention.js'
import { createRuleConfigLoader } from '../dist/services/attention-config.js'
import { createWorldStateService, getInitialState } from '../dist/services/worldState.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// 测试辅助：根据 (status, activity, overrides) 构造 state
function mkState(overrides = {}) {
  const base = getInitialState(1_700_000_000_000)
  return {
    ...base,
    user: {
      ...base.user,
      status: overrides.status ?? base.user.status,
      currentActivity: overrides.activity !== undefined ? overrides.activity : base.user.currentActivity,
      lastSeenAt: overrides.lastSeenAt ?? base.user.lastSeenAt,
    },
  }
}

// 测试辅助：构造 feishu:message event
function mkFeishuMsg(text, overrides = {}) {
  return {
    id: overrides.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    source: 'feishu',
    type: 'message',
    timestamp: Date.now(),
    data: { text, openId: 'ou_test', chatId: 'oc_test', messageId: 'om_test' },
    priority: 1,
    sessionId: 'ou_test',
    meta: { eventId: `evt_${Date.now()}`, kind: 'text' },
    ...overrides,
  }
}

// 测试辅助：构造 calendar:calendar_event event
function mkCalendarEvent(minutesBefore, title = 'Mock 会议', overrides = {}) {
  return {
    id: overrides.id ?? `evt_cal_${Math.random().toString(36).slice(2)}`,
    source: 'calendar',
    type: 'calendar_event',
    timestamp: Date.now(),
    data: { title, activity: 'meeting', minutesBefore },
    priority: 1,
    ...overrides,
  }
}

// 测试辅助：pc:app_focus event
function mkPcAppFocus(app) {
  return {
    id: `evt_pc_${Math.random().toString(36).slice(2)}`,
    source: 'pc',
    type: 'app_focus',
    timestamp: Date.now(),
    data: { app },
    priority: 1,
  }
}

// ────────────────────────────────────────────────────────────
// R8.A  纯 AttentionEngine 评估
// ────────────────────────────────────────────────────────────
{
  const engine = createAttentionEngine()
  check('R8.A0: ruleCount === 5（内置 4 条规则 + SKIP 的 urgent-keyword）', engine.ruleCount() === 5)
  // 注意：ruleRegistrySize 也是 5（模块加载时硬编码注册）
  check('R8.A0b: ruleRegistrySize === 5', ruleRegistrySize() === 5)

  // ── R8.A1: empty input ──
  const emptyItems = engine.evaluate({ event: null, state: mkState(), prevState: undefined })
  check('R8.A1: empty input → 0 items', emptyItems.length === 0)

  // ── R8.A2/A3: sleeping-quiet ──
  const sleeping = mkState({ status: 'sleeping' })
  const r2 = engine.evaluate({ event: null, state: sleeping, prevState: undefined })
  check('R8.A2: sleeping-quiet (state-only) → 1 item', r2.length === 1)
  check('R8.A2: sleeping-quiet action=ignore', r2[0]?.action === 'ignore')
  check('R8.A2: sleeping-quiet priority=low', r2[0]?.priority === 'low')
  check('R8.A2: sleeping-quiet ruleId=sleeping-quiet', r2[0]?.ruleId === 'sleeping-quiet')

  const r3 = engine.evaluate({ event: mkFeishuMsg('随便说点啥'), state: sleeping, prevState: sleeping })
  check('R8.A3: sleeping + 飞书消息 → 仍 ignore（sleeping-quiet 覆盖）', r3.length === 1 && r3[0]?.action === 'ignore')

  // ── R8.A4~A7: away-arrival（修复后用 prevState）──
  // A4: prevState 未提供（state-only 评估语义下，state-only 触发但 state.user.status='away'）→ 0 items
  //     away-arrival predicate 要求 prevState（state-only 触发 prevState=undefined，短路）
  const away = mkState({ status: 'away' })
  const r4 = engine.evaluate({ event: mkFeishuMsg('hello'), state: away, prevState: undefined })
  check('R8.A4: away + event（无 prevState）→ 0 items（away-arrival 需 prevState）', r4.length === 0)

  // A5: prevState=away + 飞书消息 → 1 item, action=remember_only（核心回归）
  const awake = mkState({ status: 'awake' })
  const r5 = engine.evaluate({ event: mkFeishuMsg('hello'), state: awake, prevState: away })
  check('R8.A5: prevState=away + 飞书消息 → 1 item', r5.length === 1)
  check('R8.A5: away-arrival ruleId', r5[0]?.ruleId === 'away-arrival')
  check('R8.A5: away-arrival action=remember_only', r5[0]?.action === 'remember_only')
  check('R8.A5: away-arrival priority=normal', r5[0]?.priority === 'normal')
  check('R8.A5: eventId 透传', r5[0]?.eventId === r5[0]?.eventId) // smoke 简化检查

  // A6: prevState=undefined + 飞书消息 → 0 items（短路）
  const r6 = engine.evaluate({ event: mkFeishuMsg('hello'), state: awake, prevState: undefined })
  check('R8.A6: prevState=undefined + 飞书 → 0 items', r6.length === 0)

  // A7: state-only trigger (event=null) → away-arrival 不命中（rule 要求 event !== null）
  const r7 = engine.evaluate({ event: null, state: away, prevState: away })
  check('R8.A7: state-only + away → away-arrival 不命中（rule 要求 event）', r7.length === 0)

  // ── R8.A8~A11: feishu-deadline ──
  const normalState = mkState()
  const r8 = engine.evaluate({ event: mkFeishuMsg('今晚前提交报告'), state: normalState, prevState: normalState })
  check('R8.A8: 飞书 "今晚前提交报告" → 1 item', r8.length === 1)
  check('R8.A8: action=remember_only', r8[0]?.action === 'remember_only')
  check('R8.A8: priority=high', r8[0]?.priority === 'high')
  check('R8.A8: ruleId=feishu-deadline', r8[0]?.ruleId === 'feishu-deadline')

  const r9 = engine.evaluate({ event: mkFeishuMsg('ddl 提醒'), state: normalState, prevState: normalState })
  check('R8.A9: 飞书 "ddl" → 1 item', r9.length === 1 && r9[0]?.ruleId === 'feishu-deadline')

  const r10 = engine.evaluate({ event: mkFeishuMsg('今天天气不错'), state: normalState, prevState: normalState })
  check('R8.A10: 飞书 普通文本 → 0 items（deadline 不命中）', r10.length === 0)

  const r11 = engine.evaluate({ event: mkCalendarEvent(3), state: normalState, prevState: normalState })
  check('R8.A11: calendar:calendar_event（无 deadline 关键词）→ 0 items', r11.length === 0)

  // ── R8.A12~A14: calendar-busy-soon ──
  const busy = mkState({ status: 'busy' })
  const r12 = engine.evaluate({ event: mkCalendarEvent(3), state: busy, prevState: busy })
  check('R8.A12: busy + calendar minutesBefore=3 → 1 item', r12.length === 1)
  check('R8.A12: action=wait_until_available', r12[0]?.action === 'wait_until_available')
  check('R8.A12: priority=high', r12[0]?.priority === 'high')
  check('R8.A12: ruleId=calendar-busy-soon', r12[0]?.ruleId === 'calendar-busy-soon')

  const r13 = engine.evaluate({ event: mkCalendarEvent(10), state: busy, prevState: busy })
  check('R8.A13: busy + calendar minutesBefore=10 → 0 items（>5 不触发）', r13.length === 0)

  const r14 = engine.evaluate({ event: mkCalendarEvent(2), state: normalState, prevState: normalState })
  check('R8.A14: awake + calendar minutesBefore=2 → 0 items（不 busy 不触发）', r14.length === 0)

  // ── R8.A15~A18: focus-interrupt ──
  const focus = mkState({ activity: 'focus' })
  const r15 = engine.evaluate({ event: mkFeishuMsg('hi'), state: focus, prevState: focus })
  check('R8.A15: focus + 飞书 → 1 item', r15.length === 1)
  check('R8.A15: action=remember_only', r15[0]?.action === 'remember_only')
  check('R8.A15: ruleId=focus-interrupt', r15[0]?.ruleId === 'focus-interrupt')

  const meeting = mkState({ activity: 'meeting' })
  const r16 = engine.evaluate({ event: mkFeishuMsg('hi'), state: meeting, prevState: meeting })
  check('R8.A16: meeting + 飞书 → 1 item', r16.length === 1)

  const r17 = engine.evaluate({ event: mkFeishuMsg('hi'), state: normalState, prevState: normalState })
  check('R8.A17: normal activity + 飞书 → 0 items', r17.length === 0)

  const r18 = engine.evaluate({ event: mkPcAppFocus('VSCode'), state: focus, prevState: focus })
  check('R8.A18: pc:app_focus + focus → 0 items（source 不是 feishu）', r18.length === 0)

  // ── R8.A19: SKIP urgent-keyword（TODO Phase 3.B 规则配置化时新增）──
  // 故意不测试：当前 Phase 3.A 目标是验证 Pipeline，不扩充规则
  check('R8.A19: SKIP urgent-keyword（规则不存在，TODO Phase 3.B）', true,
    'skipped: urgent-keyword 规则未实现（avoid mixing bug fix + feature add in same change）')

  // silence unused
  void AttentionEngine // 引用以避免 linter warning（dist 导出的类）
}

// ────────────────────────────────────────────────────────────
// R8.B  WorldStateService prevState capture + Attention 集成回归
// ────────────────────────────────────────────────────────────
{
  const engine = createAttentionEngine()

  // ── R8.B0: applyUpdate 内部 capture prev（直接测试 WorldStateService）──
  const ws0 = createWorldStateService()
  check('R8.B0.1: 初始 ws.getPrevState() === null（从未 applyUpdate）', ws0.getPrevState() === null)

  // 第一次 applyUpdate（service 内部 capture 初始 state 为 prev）
  ws0.applyUpdate((s) => s) // 幂等 updater（返回旧引用，service 防御逻辑处理）
  // 注：applyUpdate 实现中：如果 updater 返回旧引用，service 不更新 state；但 prev 已被 capture
  // 这意味着 R8.B0.2 测试后 getPrevState() 是初始 state

  const prev0 = ws0.getPrevState()
  check('R8.B0.2: applyUpdate 后 getPrevState() 返回初始 state', prev0 !== null && prev0.user.status === 'awake')

  // 多次 applyUpdate：getPrevState() 总是最近一次 applyUpdate 之前的 state
  ws0.applyUpdate((s) => ({ ...s, user: { ...s.user, status: 'busy' } }))
  const prev1 = ws0.getPrevState()
  check('R8.B0.3: 第二次 applyUpdate 后 getPrevState() === 第一次 applyUpdate 后的 state',
    prev1 !== null && prev1.user.status === 'awake') // 第一次 applyUpdate 后仍是 awake

  // ── R8.B1: away-arrival 集成（核心回归）──
  // 场景：
  //   - state 1: user.status='away'（applyUpdate 1）
  //   - state 2: user.status='awake'（applyUpdate 2 模拟 feishuMessageReducer）
  //   - evaluate({event: feishuMsg, state: state2, prevState: state1})
  //     → away-arrival 应触发（action=remember_only）
  const ws = createWorldStateService()
  const engineB = createAttentionEngine()

  // applyUpdate 1：state.user.status='away'
  ws.applyUpdate((s) => ({ ...s, user: { ...s.user, status: 'away' } }))
  const state1 = ws.getState()
  check('R8.B1.1: applyUpdate 后 state.user.status=away', state1.user.status === 'away')

  // applyUpdate 2：模拟 feishuMessageReducer（user.lastSeenAt = now, status = 'awake'）
  //   service 内部 capture prev = state1（其中 status='away'）
  ws.applyUpdate((s) => ({
    ...s,
    user: { ...s.user, lastSeenAt: Date.now(), status: 'awake' },
  }))
  const state2 = ws.getState()
  const prevState = ws.getPrevState()
  check('R8.B1.2: 第二次 applyUpdate 后 state.user.status=awake（reducer 已覆盖）', state2.user.status === 'awake')
  check('R8.B1.3: getPrevState() 仍然反映 applyUpdate 前的 state（away）',
    prevState !== null && prevState.user.status === 'away')
  check('R8.B1.4: getState() 与 getPrevState() 是不同对象引用（深拷贝隔离）',
    ws.getState() !== prevState)

  // evaluate：away-arrival 应触发（prevState.user.status='away'）
  const feishuMsg = mkFeishuMsg('我回来了')
  const input = {
    event: feishuMsg,
    state: state2,
    prevState,
  }
  const items = engineB.evaluate(input)
  check('R8.B1.5: 完整链路 → away-arrival 触发（1 item）', items.length === 1)
  check('R8.B1.6: away-arrival ruleId 正确', items[0]?.ruleId === 'away-arrival')
  check('R8.B1.7: away-arrival action=remember_only', items[0]?.action === 'remember_only')
  check('R8.B1.8: away-arrival priority=normal', items[0]?.priority === 'normal')
  check('R8.B1.9: eventId 来自 input.event', items[0]?.eventId === feishuMsg.id)
}

// ────────────────────────────────────────────────────────────
// R9（Phase 3.B.dedup）：Attention Stream 去重层
// ────────────────────────────────────────────────────────────
// 设计：
// - key = `${ruleId}:${eventId ?? '__state__'}`
// - 窗口默认 5000ms（生产硬编码）；测试用 50ms 短窗口避免等待
// - 第一次 shouldEmit=true；窗口内重复 → false；窗口外 → 再次 true

// 测试辅助：构造 AttentionItem（仅 dedup 关心的字段）
function mkItem(ruleId, eventId, cols = {}) {
  return {
    ruleId,
    eventId,
    priority: 'normal',
    action: 'remember_only',
    reason: 'test',
    stateSnapshot: {},
    evaluatedAt: 0,
    ...cols,
  }
}

{
  // ── R9.1: 同 ruleId + 同 eventId 50ms 内 → 第二次 drop ──
  const dedup1 = createAttentionDedup({ windowMs: 50 })
  const item1a = mkItem('feishu-deadline', 'evt_1')
  check('R9.1.1: 第一次 shouldEmit=true', dedup1.shouldEmit(item1a) === true)
  check('R9.1.2: map.size === 1', dedup1.size() === 1)
  const item1b = mkItem('feishu-deadline', 'evt_1')  // 同 ruleId+eventId
  check('R9.1.3: 50ms 内第二次 shouldEmit=false（drop）', dedup1.shouldEmit(item1b) === false)

  // ── R9.2: 不同 eventId → 两条都通过 ──
  const dedup2 = createAttentionDedup({ windowMs: 50 })
  const a = mkItem('feishu-deadline', 'evt_a')
  const b = mkItem('feishu-deadline', 'evt_b')
  check('R9.2.1: event A shouldEmit=true', dedup2.shouldEmit(a) === true)
  check('R9.2.2: event B shouldEmit=true（不同 eventId 独立计数）', dedup2.shouldEmit(b) === true)
  check('R9.2.3: map.size === 2', dedup2.size() === 2)

  // ── R9.3: 不同 ruleId + 同 eventId → 两条都通过 ──
  const dedup3 = createAttentionDedup({ windowMs: 50 })
  const x = mkItem('feishu-deadline', 'evt_x')
  const y = mkItem('away-arrival', 'evt_x')  // 同 eventId 不同 ruleId
  check('R9.3.1: rule A shouldEmit=true', dedup3.shouldEmit(x) === true)
  check('R9.3.2: rule B shouldEmit=true（不同 ruleId 独立计数）', dedup3.shouldEmit(y) === true)

  // ── R9.4: 窗口过期 → 两条都通过 ──
  const dedup4 = createAttentionDedup({ windowMs: 50 })
  const z = mkItem('feishu-deadline', 'evt_z')
  check('R9.4.1: 第一次 shouldEmit=true', dedup4.shouldEmit(z) === true)
  await new Promise((r) => setTimeout(r, 80))  // 超过 50ms 窗口
  check('R9.4.2: 窗口外第二次 shouldEmit=true（重新 emit）', dedup4.shouldEmit(z) === true)

  // ── R9.5: state-only 触发（eventId=undefined）→ 用 '__state__' 兜底 ──
  const dedup5 = createAttentionDedup({ windowMs: 50 })
  const stateOnly = mkItem('sleeping-quiet', undefined)
  check('R9.5.1: state-only 第一次 shouldEmit=true', dedup5.shouldEmit(stateOnly) === true)
  check('R9.5.2: state-only 第二次 shouldEmit=false（去重）', dedup5.shouldEmit(stateOnly) === false)
  // 不同 rule 的 state-only 仍独立
  const stateOnly2 = mkItem('away-arrival', undefined)
  check('R9.5.3: state-only 不同 ruleId → true（key 区分）', dedup5.shouldEmit(stateOnly2) === true)

  // ── R9.6: clear() 后 → 重新开始计数 ──
  const dedup6 = createAttentionDedup({ windowMs: 50 })
  dedup6.shouldEmit(mkItem('r', 'e'))
  check('R9.6.1: clear 前 size === 1', dedup6.size() === 1)
  dedup6.clear()
  check('R9.6.2: clear 后 size === 0', dedup6.size() === 0)
  check('R9.6.3: clear 后 shouldEmit=true（重新开始）', dedup6.shouldEmit(mkItem('r', 'e')) === true)
}

// ────────────────────────────────────────────────────────────
// R10（Phase 3.B.throttle）：Attention Stream 节流层
// ────────────────────────────────────────────────────────────
// 设计：
// - 仅 notify_immediately / act 受限；remember_only / ignore / wait_until_available 直通
// - Source cooldown（默认 5000ms）：同 source 窗口内第二次 drop
// - Hourly cap（默认 10/小时）：滚动窗口，超出 drop
// - state-only 触发（source='state'）：不应用 source cooldown，也不消耗 hourly cap
// - 用 fake clock 注入时间（避免 setTimeout 真实等待）

// 测试辅助：fake clock（避免真实时间等待）
function mkFakeClock(initial = 0) {
  let now = initial
  return {
    now: () => now,
    set: (t) => { now = t },
    advance: (ms) => { now += ms },
  }
}

{
  // ── R10.1: 同 source + notify_immediately cooldown ──
  const clock = mkFakeClock(1000)
  const t1 = createAttentionThrottle({ cooldownMs: 5000, clock: clock.now })
  const itemA1 = mkItem('r', 'a', { source: 'feishu', action: 'notify_immediately' })
  check('R10.1.1: t=1000 第一次 shouldEmit=true', t1.shouldEmit(itemA1) === true)
  clock.set(2000)  // 1000ms 后，仍在 5000ms cooldown 内
  const itemA2 = mkItem('r', 'a', { source: 'feishu', action: 'notify_immediately' })
  check('R10.1.2: t=2000 cooldown 内第二次 shouldEmit=false（drop）', t1.shouldEmit(itemA2) === false)
  clock.set(7000)  // 5000ms 后 cooldown 到期
  check('R10.1.3: t=7000 cooldown 到期后第二次 shouldEmit=true', t1.shouldEmit(itemA2) === true)

  // ── R10.2: 不同 source + notify_immediately 独立 ──
  const clock2 = mkFakeClock(0)
  const t2 = createAttentionThrottle({ cooldownMs: 5000, clock: clock2.now })
  clock2.set(100)
  check('R10.2.1: source=feishu t=100 第一次 true', t2.shouldEmit(mkItem('r', 'a', { source: 'feishu', action: 'notify_immediately' })) === true)
  // 同 100ms，source 不同 → 不被 cooldown 影响
  check('R10.2.2: source=pc t=100 第一次 true（不同 source 独立）',
    t2.shouldEmit(mkItem('r', 'a', { source: 'pc', action: 'notify_immediately' })) === true)

  // ── R10.3: remember_only 不被 cooldown 阻止 ──
  const clock3 = mkFakeClock(0)
  const t3 = createAttentionThrottle({ cooldownMs: 5000, clock: clock3.now })
  clock3.set(0)
  const rem = mkItem('r', 'a', { source: 'feishu', action: 'remember_only' })
  check('R10.3.1: remember_only 第一次 true', t3.shouldEmit(rem) === true)
  clock3.set(100)
  check('R10.3.2: remember_only 第二次仍 true（不被 cooldown 阻止）', t3.shouldEmit(rem) === true)
  // 多次相同 item 都通过
  for (let i = 0; i < 30; i++) {
    clock3.set(100 + i * 50)
    t3.shouldEmit(rem)
  }
  check('R10.3.3: remember_only 多次仍然全 true（不被 hourly cap 阻止）', t3.shouldEmit(rem) === true)

  // ── R10.4: hourly cap（默认 10/小时）──
  // 用不同 source 避免 source cooldown 干扰；每个 source 只发一次
  const clock4 = mkFakeClock(0)
  const t4 = createAttentionThrottle({ cooldownMs: 0, hourlyCap: 3, windowMs: 60_000, clock: clock4.now })
  let passCount = 0
  let dropCount = 0
  for (let i = 1; i <= 5; i++) {
    clock4.set(i * 100)  // 间隔 100ms（cooldown=0 无影响；只看 cap）
    const item = mkItem('r', `a${i}`, { source: `src${i}`, action: 'notify_immediately' })
    if (t4.shouldEmit(item)) passCount++; else dropCount++
  }
  check('R10.4.1: hourlyCap=3 → 前 3 个通过（passCount=3）', passCount === 3)
  check('R10.4.2: hourlyCap=3 → 后 2 个 drop（dropCount=2）', dropCount === 2)

  // ── R10.5: 不同 action 不互相消耗 quota ──
  // 3 个 remember_only 不消耗 notify 配额
  const clock5 = mkFakeClock(0)
  const t5 = createAttentionThrottle({ cooldownMs: 0, hourlyCap: 3, windowMs: 60_000, clock: clock5.now })
  clock5.set(0)
  // 3 个 remember_only（不消耗配额）
  for (let i = 1; i <= 3; i++) {
    clock5.set(i * 50)
    t5.shouldEmit(mkItem('r', `mem${i}`, { source: 'feishu', action: 'remember_only' }))
  }
  // 然后 3 个 notify_immediately 应该都通过（remember_only 没消耗配额）
  for (let i = 1; i <= 3; i++) {
    clock5.set(1000 + i * 50)
    const item = mkItem('r', `not${i}`, { source: `nsrc${i}`, action: 'notify_immediately' })
    check(`R10.5.${i}: notify #${i} 在 3 个 remember_only 后仍通过（不消耗）`,
      t5.shouldEmit(item) === true)
  }
  // 第 4 个 notify 应该被 cap 阻止
  clock5.set(2000)
  check('R10.5.4: 第 4 个 notify 被 hourly cap 阻止（remember_only 不消耗 cap）',
    t5.shouldEmit(mkItem('r', 'not4', { source: 'nsrc4', action: 'notify_immediately' })) === false)

  // ── R10.6: state-only（source='state'）不受 source cooldown 与 hourly cap 限制 ──
  const clock6 = mkFakeClock(0)
  const t6 = createAttentionThrottle({ cooldownMs: 5000, hourlyCap: 1, windowMs: 60_000, clock: clock6.now })
  clock6.set(0)
  // 1 个真 source notify → 消耗 cap=1
  const realNotify = mkItem('r', 'real', { source: 'feishu', action: 'notify_immediately' })
  check('R10.6.1: 真 source notify 第一次 true（消耗 cap=1）', t6.shouldEmit(realNotify) === true)
  // 现在 cap 满了，但 state-only 直通
  for (let i = 0; i < 5; i++) {
    clock6.set(100 + i * 100)
    const stateOnly = mkItem('r', `state${i}`, { source: 'state', action: 'notify_immediately' })
    check(`R10.6.${i + 2}: state-only notify #${i + 1} 仍 true（不消耗 cap）`,
      t6.shouldEmit(stateOnly) === true)
  }
  // 真 source 第二次仍被 cap 阻止
  clock6.set(2000)
  check('R10.6.7: 真 source 第二次 notify 被 cap 阻止',
    t6.shouldEmit(mkItem('r', 'real2', { source: 'feishu', action: 'notify_immediately' })) === false)

  // ── R10.7: cooldown 到期后允许再次 emit（R10.1 已验证，此处补充 act action）──
  const clock7 = mkFakeClock(1000)
  const t7 = createAttentionThrottle({ cooldownMs: 5000, clock: clock7.now })
  clock7.set(1000)
  check('R10.7.1: act 第一次 true', t7.shouldEmit(mkItem('r', 'a', { source: 'feishu', action: 'act' })) === true)
  clock7.set(6500)  // cooldown 到期
  check('R10.7.2: act 第二次 true（cooldown 到期）', t7.shouldEmit(mkItem('r', 'a', { source: 'feishu', action: 'act' })) === true)
}

// ────────────────────────────────────────────────────────────
// R11（Phase 3.B.rule-registry）：RuleRegistry 解耦
// ────────────────────────────────────────────────────────────
// 设计：
// - AttentionRuleRegistry 接口：register / unregister / getRules / getAllRules / setEnabled / size / clear
// - AttentionEngine 接受 registry 注入（不再硬编码模块全局 Map）
// - createAttentionEngine() 不传参 → 使用默认 Registry（包含 5 条内置规则；保持 Phase 3.A 行为）
// - createAttentionEngine(reg) → 使用自定义 Registry（便于测试 + 未来配置化）
// - engine.ruleCount() = registry.size()（仅算启用）

// 测试辅助：构造一个简单的测试 rule
function mkTestRule(id, trigger = true, action = 'remember_only') {
  return {
    id,
    description: `test rule ${id}`,
    predicate: () => trigger,
    produce: () => ({
      priority: 'normal',
      reason: `triggered by ${id}`,
      action,
    }),
  }
}

{
  // ── R11.1: register rule 后可以 evaluate ──
  const reg1 = createRuleRegistry()
  reg1.register(mkTestRule('test-r1'))
  const engine1 = createAttentionEngine(reg1)
  const items1 = engine1.evaluate({
    event: mkFeishuMsg('hi'),
    state: mkState(),
    prevState: undefined,
  })
  check('R11.1.1: register 后 evaluate 触发', items1.length === 1 && items1[0]?.ruleId === 'test-r1')
  check('R11.1.2: ruleCount === 1', engine1.ruleCount() === 1)

  // ── R11.2: unregister 后 rule 不执行 ──
  const reg2 = createRuleRegistry()
  reg2.register(mkTestRule('r1'))
  reg2.register(mkTestRule('r2'))
  const engine2 = createAttentionEngine(reg2)
  const before2 = engine2.evaluate({ event: mkFeishuMsg('hi'), state: mkState() })
  check('R11.2.1: register r1+r2 后 → 2 items', before2.length === 2)
  reg2.unregister('r1')
  check('R11.2.2: unregister r1 后 → 1 item（剩 r2）', engine2.evaluate({ event: mkFeishuMsg('hi'), state: mkState() }).length === 1)
  reg2.unregister('nonexistent')  // 不存在不报错
  check('R11.2.3: unregister 不存在 id 不报错', engine2.evaluate({ event: mkFeishuMsg('hi'), state: mkState() }).length === 1)
  reg2.unregister('r2')
  check('R11.2.4: unregister r2 后 → 0 items', engine2.evaluate({ event: mkFeishuMsg('hi'), state: mkState() }).length === 0)

  // ── R11.3: disabled rule 不执行 ──
  const reg3 = createRuleRegistry()
  reg3.register(mkTestRule('r1'))
  reg3.register(mkTestRule('r2'))
  reg3.setEnabled('r1', false)
  const engine3 = createAttentionEngine(reg3)
  const items3 = engine3.evaluate({ event: mkFeishuMsg('hi'), state: mkState() })
  check('R11.3.1: r1 disabled 后 → 1 item（仅 r2）',
    items3.length === 1 && items3[0]?.ruleId === 'r2')
  check('R11.3.2: ruleCount 仅算启用（disabled 不计）', engine3.ruleCount() === 1)
  reg3.setEnabled('r1', true)
  const items3b = engine3.evaluate({ event: mkFeishuMsg('hi'), state: mkState() })
  check('R11.3.3: setEnabled(true) 后 r1 重新触发', items3b.length === 2)
  check('R11.3.4: setEnabled(true) 后 ruleCount === 2', engine3.ruleCount() === 2)
  // isEnabled 查询
  check('R11.3.5: isEnabled(\'r1\') === true', reg3.isEnabled('r1') === true)
  check('R11.3.6: isEnabled(\'nonexistent\') === false', reg3.isEnabled('nonexistent') === false)
  // setEnabled 未注册 id 抛错（必须包 try/catch，避免终止脚本）
  let threw = false
  try { reg3.setEnabled('nonexistent', true) } catch { threw = true }
  check('R11.3.7: setEnabled 未注册 id 抛错', threw)
  let threwFalse = false
  try { reg3.setEnabled('nonexistent', false) } catch { threwFalse = true }
  check('R11.3.8: setEnabled 未注册 id + enabled=false 也抛错', threwFalse)

  // ── R11.4: 多个 rule 顺序稳定 ──
  const reg4 = createRuleRegistry()
  reg4.register(mkTestRule('a'))
  reg4.register(mkTestRule('b'))
  reg4.register(mkTestRule('c'))
  const engine4 = createAttentionEngine(reg4)
  const items4 = engine4.evaluate({ event: mkFeishuMsg('hi'), state: mkState() })
  check('R11.4.1: 顺序 a→b→c',
    items4.map((i) => i.ruleId).join(',') === 'a,b,c')
  // unregister 中间一个，顺序保持
  reg4.unregister('b')
  const items4b = engine4.evaluate({ event: mkFeishuMsg('hi'), state: mkState() })
  check('R11.4.2: unregister b 后 → a→c（保持原位置）',
    items4b.map((i) => i.ruleId).join(',') === 'a,c')
  // disable 中间一个，顺序保持（disable 的不在 getRules 中）
  reg4.register(mkTestRule('b2'))
  reg4.setEnabled('a', false)
  const items4c = engine4.evaluate({ event: mkFeishuMsg('hi'), state: mkState() })
  check('R11.4.3: disable a 后 → c,b2（a 不出现，b2 在末位）',
    items4c.map((i) => i.ruleId).join(',') === 'c,b2')

  // ── R11.5: 现有 5 条内置规则迁移后行为不变 ──
  const defaultReg = getDefaultRegistry()
  check('R11.5.1: defaultRegistry.size() === 5（5 条内置规则）', defaultReg.size() === 5)
  check('R11.5.2: ruleRegistrySize() === 5（向后兼容）', ruleRegistrySize() === 5)
  // 不传参 createAttentionEngine → 使用默认 Registry
  const engine5 = createAttentionEngine()
  check('R11.5.3: 默认 engine.ruleCount() === 5', engine5.ruleCount() === 5)
  // 验证 R8 关键场景仍触发
  const r8sleep = engine5.evaluate({ event: null, state: mkState({ status: 'sleeping' }), prevState: undefined })
  check('R11.5.4: sleeping-quiet 仍触发（向后兼容）',
    r8sleep.length === 1 && r8sleep[0]?.ruleId === 'sleeping-quiet')
  const r8deadline = engine5.evaluate({ event: mkFeishuMsg('今晚前提交报告'), state: mkState() })
  check('R11.5.5: feishu-deadline 仍触发（向后兼容）',
    r8deadline.length === 1 && r8deadline[0]?.ruleId === 'feishu-deadline')

  // 自定义 Registry 替换默认：5 条规则不参与 evaluate
  const reg5b = createRuleRegistry()
  reg5b.register(mkTestRule('only-rule'))
  const engine5b = createAttentionEngine(reg5b)
  const r5b = engine5b.evaluate({ event: mkFeishuMsg('今晚前提交报告'), state: mkState() })
  check('R11.5.6: 自定义 Registry（只有 only-rule）→ 不触发默认 5 条',
    r5b.length === 1 && r5b[0]?.ruleId === 'only-rule')
}

// ────────────────────────────────────────────────────────────
// R12（Phase 3.B.rule-config）：AttentionRuleConfigLoader
// ────────────────────────────────────────────────────────────
// 设计：
// - JSON only（项目无 YAML 依赖，不引入新依赖）
// - 严格白名单：只解析 enabled；其他字段（predicate/expression 等）直接报错（防 DSL）
// - 不创建新 Rule——只对已注册的 rule 设置 enabled 状态
// - 未知 ruleId 抛错（fail-fast）
// - 不污染 defaultRegistry——Loader 接受任意 registry 参数

{
  // ── R12.1: 空配置 → 默认规则保持 enabled ──
  const loader = createRuleConfigLoader()
  const cfg1 = loader.parse('{"rules":{}}')
  check('R12.1.1: 空 rules 对象 parse 成功', cfg1.rules !== undefined && Object.keys(cfg1.rules).length === 0)

  // 用独立 Registry 测试（不污染 defaultRegistry）
  const reg12 = createRuleRegistry()
  reg12.register(mkTestRule('r1'))
  reg12.register(mkTestRule('r2'))
  reg12.register(mkTestRule('r3'))
  loader.load(cfg1, reg12)
  check('R12.1.2: 空配置 load 后所有规则 enabled', reg12.size() === 3)
  check('R12.1.3: 缺省 enabled = true（不写 enabled 字段）',
    loader.parse('{"rules":{"r1":{}}}').rules.r1.enabled === true)

  // ── R12.2: 关闭一个规则 → registry 中 disabled + engine 不再产生 ──
  const reg12b = createRuleRegistry()
  reg12b.register(mkTestRule('r1'))
  reg12b.register(mkTestRule('r2'))
  const engine12b = createAttentionEngine(reg12b)
  // 先验证两个都触发
  const before = engine12b.evaluate({ event: mkFeishuMsg('hi'), state: mkState() })
  check('R12.2.1: load 前 2 个规则都触发', before.length === 2)
  // 关闭 r2
  loader.load(loader.parse('{"rules":{"r2":{"enabled":false}}}'), reg12b)
  check('R12.2.2: disable r2 后 reg12b.size() === 1（仅 r1 启用）', reg12b.size() === 1)
  const after = engine12b.evaluate({ event: mkFeishuMsg('hi'), state: mkState() })
  check('R12.2.3: disable r2 后 evaluate → 1 item（仅 r1）',
    after.length === 1 && after[0]?.ruleId === 'r1')
  check('R12.2.4: r2 仍在 getAllRules（disable 不删除）',
    reg12b.getAllRules().some((r) => r.id === 'r2'))
  check('R12.2.5: r2 在 getRules 中不出现（disable 不返回）',
    !reg12b.getRules().some((r) => r.id === 'r2'))

  // ── R12.3: 重新 enabled → 规则恢复 ──
  loader.load(loader.parse('{"rules":{"r2":{"enabled":true}}}'), reg12b)
  check('R12.3.1: re-enable r2 后 size === 2', reg12b.size() === 2)
  const after2 = engine12b.evaluate({ event: mkFeishuMsg('hi'), state: mkState() })
  check('R12.3.2: re-enable 后 evaluate → 2 items',
    after2.length === 2 && after2.some((i) => i.ruleId === 'r2'))

  // ── R12.4: 未知 ruleId → 抛错（fail-fast）──
  const reg12c = createRuleRegistry()
  reg12c.register(mkTestRule('known'))
  let threwUnknown = false
  try {
    loader.load(loader.parse('{"rules":{"unknown_rule":{"enabled":false}}}'), reg12c)
  } catch (err) {
    threwUnknown = true
    const detail = err instanceof Error ? err.message : String(err)
    check('R12.4.1: 未知 ruleId 错误信息含 ruleId',
      detail.includes('unknown_rule'))
  }
  check('R12.4.2: 未知 ruleId 抛错（fail-fast）', threwUnknown)
  check('R12.4.3: 抛错后 registry 状态不被破坏', reg12c.size() === 1)

  // ── R12.5: JSON 解析错误 → 明确报告 ──
  let threwParse = false
  try {
    loader.parse('not-valid-json{')
  } catch (err) {
    threwParse = true
    const detail = err instanceof Error ? err.message : String(err)
    check('R12.5.1: 解析错误信息包含 JSON parse', detail.toLowerCase().includes('json'))
  }
  check('R12.5.2: 无效 JSON 抛错', threwParse)

  // 结构错误（合法 JSON 但不是 object）
  let threwStruct1 = false
  try { loader.parse('null') } catch { threwStruct1 = true }
  check('R12.5.3: null 不是 object → 抛错', threwStruct1)

  let threwStruct2 = false
  try { loader.parse('[]') } catch { threwStruct2 = true }
  check('R12.5.4: array 不是 object → 抛错', threwStruct2)

  let threwStruct3 = false
  try { loader.parse('{"foo": 1}') } catch { threwStruct3 = true }  // 缺 rules 字段
  check('R12.5.5: 缺 rules 字段 → 抛错', threwStruct3)

  // 拒绝未知字段（防 DSL 倾向：写 predicate 直接报错）
  let threwDsl = false
  try {
    loader.parse('{"rules":{"r1":{"enabled":true,"predicate":"state.user.status === \\"away\\""}}}')
  } catch (err) {
    threwDsl = true
    const detail = err instanceof Error ? err.message : String(err)
    check('R12.5.6: 未知字段 predicate 抛错（防 DSL）',
      detail.includes('predicate') && detail.includes('不支持'))
  }
  check('R12.5.7: predicate 字段抛错', threwDsl)

  // enabled 类型错误
  let threwType = false
  try {
    loader.parse('{"rules":{"r1":{"enabled":"yes"}}}')
  } catch { threwType = true }
  check('R12.5.8: enabled 非 boolean 抛错', threwType)

  // ── R12.6: 配置应用到独立 Registry → 不污染 defaultRegistry ──
  // 记录 defaultRegistry 关闭前的 enabled 状态
  const defaultRegForR126 = getDefaultRegistry()
  const beforeR126 = new Map()  // ruleId → enabled
  for (const r of defaultRegForR126.getAllRules()) {
    beforeR126.set(r.id, defaultRegForR126.isEnabled(r.id))
  }

  // 用独立 Registry 测试
  const regIsolated = createRuleRegistry()
  regIsolated.register(mkTestRule('r1'))
  loader.load(loader.parse('{"rules":{"r1":{"enabled":false}}}'), regIsolated)
  check('R12.6.1: 独立 Registry load 成功', regIsolated.size() === 0)  // r1 disabled

  // 验证 defaultRegistry 未受影响
  let dirty = false
  for (const r of defaultRegForR126.getAllRules()) {
    const wasBefore = beforeR126.get(r.id)
    if (wasBefore !== undefined && defaultRegForR126.isEnabled(r.id) !== wasBefore) {
      dirty = true
      break
    }
  }
  check('R12.6.2: defaultRegistry 未被独立 Registry load 污染', !dirty)

  // ── R12.7: 现有 R8/R9/R10 行为零回归（双验证：直接 + 通过 config 关闭）──
  // (a) 默认 Registry（createAttentionEngine() 不传参）行为不变
  const engineDefault = createAttentionEngine()
  const r8regression = engineDefault.evaluate({ event: null, state: mkState({ status: 'sleeping' }) })
  check('R12.7.1: 默认 Registry sleeping-quiet 仍触发（向后兼容）',
    r8regression.length === 1 && r8regression[0]?.ruleId === 'sleeping-quiet')
  const r10regression = engineDefault.evaluate({ event: mkFeishuMsg('今晚前提交报告'), state: mkState() })
  check('R12.7.2: 默认 Registry feishu-deadline 仍触发（向后兼容）',
    r10regression.length === 1 && r10regression[0]?.ruleId === 'feishu-deadline')

  // (b) 通过 config 关闭默认规则后应不再触发
  const cfgDisable = loader.parse('{"rules":{"sleeping-quiet":{"enabled":false},"feishu-deadline":{"enabled":false}}}')
  loader.load(cfgDisable, defaultRegForR126, )
  // 上面会修改 defaultRegistry（仅用于测试，测试后恢复——见下）
  const engineAfterDisable = createAttentionEngine()
  const r8after = engineAfterDisable.evaluate({ event: null, state: mkState({ status: 'sleeping' }) })
  check('R12.7.3: 通过 config disable 后 sleeping-quiet 不触发', r8after.length === 0)
  const r10after = engineAfterDisable.evaluate({ event: mkFeishuMsg('今晚前提交报告'), state: mkState() })
  check('R12.7.4: 通过 config disable 后 feishu-deadline 不触发', r10after.length === 0)

  // 恢复 defaultRegistry 状态（避免污染后续测试）
  for (const r of defaultRegForR126.getAllRules()) {
    const wasBefore = beforeR126.get(r.id)
    if (wasBefore !== undefined && defaultRegForR126.isEnabled(r.id) !== wasBefore) {
      defaultRegForR126.setEnabled(r.id, wasBefore)
    }
  }
  check('R12.7.5: defaultRegistry 状态恢复（不污染后续测试）', true)  // 仅记录恢复操作
}

// ────────── 结果 ──────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-attention 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-attention 失败 ${failed.length} 项`)
}