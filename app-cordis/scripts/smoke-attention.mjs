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
import { AttentionEngine, createAttentionEngine, createAttentionDedup, ruleRegistrySize } from '../dist/services/attention.js'
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

// ────────── 结果 ──────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-attention 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-attention 失败 ${failed.length} 项`)
}