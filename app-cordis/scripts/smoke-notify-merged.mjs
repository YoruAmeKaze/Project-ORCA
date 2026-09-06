/**
 * Notify Merged Notification 冒烟测试（Phase 4.E / R18）
 * 运行：npm run build && node scripts/smoke-notify-merged.mjs
 *
 * 覆盖（合并通知）：
 *  R18.1   单元：groupPendingByChatId —— 纯函数行为
 *    R18.1.1:  0 entries → 空 Map
 *    R18.1.2:  1 entry → 1 group（chatId 反查）
 *    R18.1.3:  2 entries 同 chatId → 1 group
 *    R18.1.4:  2 entries 不同 chatId → 2 groups
 *    R18.1.5:  eventId 缺失 → __unknown__ group
 *    R18.1.6:  eventBus.get 返回 undefined → __unknown__ group
 *    R18.1.7:  event.data.chatId 非字符串 → __unknown__ group
 *    R18.1.8:  跨 source 合并（feishu + calendar 同 chatId）
 *
 *  R18.2   单元：composeMergedReason —— 文本格式
 *    R18.2.1:  1 条（实际不会调用，因为单条走原 Decision）
 *    R18.2.2:  2 条（不 truncate；无"还有 X 条"）
 *    R18.2.3:  5 条（不 truncate）
 *    R18.2.4:  6 条（truncate；"还有 1 条未展示"）
 *
 *  R18.3   单元：pickHighestPriority（间接通过 createMergedDecision 验证）
 *    R18.3.1:  high + normal → merged.priority = high
 *    R18.3.2:  urgent + high + normal → merged.priority = urgent
 *    R18.3.3:  normal + low → merged.priority = normal
 *
 *  R18.4   单元：createMergedDecision —— Decision 字段
 *    R18.4.1:  merged.action === 'notify'
 *    R18.4.2:  merged.ruleId === 'deferred-merged'
 *    R18.4.3:  merged.attentionId === first.attentionId
 *    R18.4.4:  merged.eventId === first.eventId
 *    R18.4.5:  merged.source === first.source
 *    R18.4.6:  merged.decisionId 是新 UUID（与 first.decisionId 不同）
 *
 *  R18.5   集成：executeTick 合并路径
 *    R18.5.1:  1 条 eligible → 1 emit（原 Decision）
 *    R18.5.2:  2 条同 chatId → 1 emit（merged notify）
 *    R18.5.3:  2 条不同 chatId → 2 emit（每 chatId 一组）
 *    R18.5.4:  混合：1 urgent（A）+ 1 high（B）→ 2 emit（A merged priority=urgent, B merged priority=high）
 *    R18.5.5:  5 条同 chatId → 1 emit（merged reason 含 5 条）
 *    R18.5.6:  6 条同 chatId → 1 emit（merged reason 含 5 条 + "还有 1 条未展示"）
 *
 *  R18.6   E2E：合并 Decision 走 ActionExecutor → NotifyHandler（mock feishu）
 *    R18.6.1:  合并 → action-result 1 条（每 chatId 一条）
 *    R18.6.2:  merged.action-result.action === 'notify'
 *    R18.6.3:  merged.action-result.success === true
 *    R18.6.4:  feishu.sendToChat 被调用 1 次（合并为单条通知）
 *    R18.6.5:  sendToChat 接收的 text 包含 "[Orca]" header + "你有 N 条待处理信息" + 各 source/priority/reason 行
 *    R18.6.6:  chatId === 注入值
 *
 *  R18.7   反例：合并循环防护
 *    R18.7.1:  合并产物 action='notify'（不进入 defer handler；不会形成 defer→scheduler→defer 循环）
 */

import { Context } from '@deepseek-ai/cordis'
import { EventBus } from '../dist/services/eventBus.js'
import {
  createRuleRegistry,
  createAttentionEngine,
} from '../dist/services/attention.js'
import { createWorldStateService } from '../dist/services/worldState.js'
import { decisionEngine } from '../dist/plugins/decision-engine.js'
import { actionExecutor } from '../dist/plugins/action-executor.js'
import {
  deferredScheduler,
  executeTick,
  groupPendingByChatId,
  composeMergedReason,
  createMergedDecision,
  MERGED_DECISION_RULE_ID,
  MAX_MERGED_ITEMS,
} from '../dist/plugins/deferred-scheduler.js'
import { createDeferredActionStore } from '../dist/services/action.js'

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

// 测试辅助：构造 DeferredActionEntry
function mkEntry(decisionOverrides = {}, overrides = {}) {
  const decision = mkDecision(decisionOverrides)
  return {
    pendingId: overrides.pendingId ?? `p_${Math.random().toString(36).slice(2)}`,
    decision,
    queuedAt: overrides.queuedAt ?? Date.now(),
  }
}

// 测试辅助：构造 fake eventBus（仅实现 get）
function mkFakeEventBus(eventMap = {}) {
  return {
    get(id) {
      return eventMap[id]
    },
  }
}

// 测试辅助：WorldStateService with given user.status
function mkWorldState(status) {
  const ws = createWorldStateService()
  ws.applyUpdate((s) => ({ ...s, user: { ...s.user, status } }))
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
// R18.1  unit: groupPendingByChatId
// ────────────────────────────────────────────────────────────
{
  // R18.1.1: 0 entries
  {
    const groups = groupPendingByChatId([], mkFakeEventBus())
    check('R18.1.1: 0 entries → 空 Map', groups.size === 0)
  }

  // R18.1.2: 1 entry → 1 group（chatId 反查）
  {
    const e1 = mkEntry({ eventId: 'evt_a' }, { pendingId: 'p_a' })
    const ev = { data: { chatId: 'oc_a' } }
    const groups = groupPendingByChatId([e1], mkFakeEventBus({ evt_a: ev }))
    check('R18.1.2: 1 entry → 1 group（chatId=oc_a）',
      groups.size === 1 && groups.get('oc_a')?.length === 1)
  }

  // R18.1.3: 2 entries 同 chatId → 1 group
  {
    const e1 = mkEntry({ eventId: 'evt_1' }, { pendingId: 'p_1' })
    const e2 = mkEntry({ eventId: 'evt_2' }, { pendingId: 'p_2' })
    const ev = { data: { chatId: 'oc_same' } }
    const groups = groupPendingByChatId(
      [e1, e2],
      mkFakeEventBus({ evt_1: ev, evt_2: ev }),
    )
    check('R18.1.3: 2 同 chatId → 1 group（size=2）',
      groups.size === 1 && groups.get('oc_same')?.length === 2)
  }

  // R18.1.4: 2 entries 不同 chatId → 2 groups
  {
    const e1 = mkEntry({ eventId: 'evt_x' }, { pendingId: 'p_x' })
    const e2 = mkEntry({ eventId: 'evt_y' }, { pendingId: 'p_y' })
    const groups = groupPendingByChatId(
      [e1, e2],
      mkFakeEventBus({
        evt_x: { data: { chatId: 'oc_x' } },
        evt_y: { data: { chatId: 'oc_y' } },
      }),
    )
    check('R18.1.4: 2 不同 chatId → 2 groups',
      groups.size === 2 && groups.get('oc_x')?.length === 1 && groups.get('oc_y')?.length === 1)
  }

  // R18.1.5: eventId 缺失 → 单独成组（不与他人合并）
  {
    const e1 = mkEntry({ eventId: undefined }, { pendingId: 'p_state' })
    const groups = groupPendingByChatId([e1], mkFakeEventBus({}))
    check('R18.1.5: eventId undefined → 1 group size=1（独立不合并）',
      groups.size === 1 && [...groups.values()][0]?.length === 1)
  }

  // R18.1.6: eventBus.get 返回 undefined → 单独成组
  {
    const e1 = mkEntry({ eventId: 'evt_unknown' }, { pendingId: 'p_u' })
    const e2 = mkEntry({ eventId: 'evt_unknown2' }, { pendingId: 'p_u2' })
    const groups = groupPendingByChatId([e1, e2], mkFakeEventBus())
    check('R18.1.6: 2 条都无法反查 → 各自独立成组（2 groups）',
      groups.size === 2 && [...groups.values()].every((g) => g.length === 1))
  }

  // R18.1.7: chatId 非字符串 → 单独成组
  {
    const e1 = mkEntry({ eventId: 'evt_num' }, { pendingId: 'p_num' })
    const e2 = mkEntry({ eventId: 'evt_num2' }, { pendingId: 'p_num2' })
    const groups = groupPendingByChatId(
      [e1, e2],
      mkFakeEventBus({ evt_num: { data: { chatId: 12345 } }, evt_num2: { data: { chatId: 67890 } } }),
    )
    check('R18.1.7: chatId 非字符串 → 各自独立成组（2 groups）',
      groups.size === 2 && [...groups.values()].every((g) => g.length === 1))
  }

  // R18.1.8: 跨 source 合并（feishu + calendar 同 chatId）
  {
    const e1 = mkEntry({ eventId: 'evt_f', source: 'feishu' }, { pendingId: 'p_f' })
    const e2 = mkEntry({ eventId: 'evt_c', source: 'calendar' }, { pendingId: 'p_c' })
    const ev = { data: { chatId: 'oc_mix' } }
    const groups = groupPendingByChatId(
      [e1, e2],
      mkFakeEventBus({ evt_f: ev, evt_c: ev }),
    )
    check('R18.1.8: 跨 source 合并（同 chatId）',
      groups.size === 1 && groups.get('oc_mix')?.length === 2)
  }
}

// ────────────────────────────────────────────────────────────
// R18.2  unit: composeMergedReason
// ────────────────────────────────────────────────────────────
{
  // R18.2.2: 2 条（不 truncate）
  {
    const text = composeMergedReason([
      mkEntry({ source: 'feishu', priority: 'normal', reason: 'msg-1' }),
      mkEntry({ source: 'calendar', priority: 'high', reason: 'meeting' }),
    ])
    check('R18.2.2.1: 标题含 "你有 2 条待处理信息"',
      text.includes('你有 2 条待处理信息'))
    check('R18.2.2.2: 含 [feishu] normal: msg-1',
      text.includes('- [feishu] normal: msg-1'))
    check('R18.2.2.3: 含 [calendar] high: meeting',
      text.includes('- [calendar] high: meeting'))
    check('R18.2.2.4: 不含 "还有 X 条未展示"',
      !text.includes('还有') || !text.includes('条未展示'))
  }

  // R18.2.3: 5 条（不 truncate）
  {
    const entries = Array.from({ length: 5 }, (_, i) =>
      mkEntry({ source: 'feishu', priority: 'normal', reason: `r${i}` }),
    )
    const text = composeMergedReason(entries)
    check('R18.2.3.1: 含 "你有 5 条待处理信息"',
      text.includes('你有 5 条待处理信息'))
    check('R18.2.3.2: 含全部 5 条 reason',
      ['r0', 'r1', 'r2', 'r3', 'r4'].every((r) => text.includes(r)))
    check('R18.2.3.3: 不含 "还有"（不 truncate）',
      !text.includes('还有'))
  }

  // R18.2.4: 6 条（truncate）
  {
    const entries = Array.from({ length: 6 }, (_, i) =>
      mkEntry({ source: 'feishu', priority: 'normal', reason: `r${i}` }),
    )
    const text = composeMergedReason(entries)
    check('R18.2.4.1: 含 "你有 6 条待处理信息"',
      text.includes('你有 6 条待处理信息'))
    check('R18.2.4.2: 含 "还有 1 条未展示"（6-5=1）',
      text.includes('还有 1 条未展示'))
    check('R18.2.4.3: 显示 5 条（MAX_MERGED_ITEMS）',
      ['r0', 'r1', 'r2', 'r3', 'r4'].every((r) => text.includes(r)))
    check('R18.2.4.4: 不含第 6 条（r5，已 truncate）',
      !text.includes('r5'))
  }
}

// ────────────────────────────────────────────────────────────
// R18.3  unit: pickHighestPriority（通过 createMergedDecision 验证）
// ────────────────────────────────────────────────────────────
{
  // R18.3.1: high + normal → high
  {
    const merged = createMergedDecision('oc_p', [
      mkEntry({ priority: 'normal' }),
      mkEntry({ priority: 'high' }),
    ])
    check('R18.3.1: high + normal → merged.priority=high',
      merged.priority === 'high')
  }

  // R18.3.2: urgent + high + normal → urgent
  {
    const merged = createMergedDecision('oc_p', [
      mkEntry({ priority: 'normal' }),
      mkEntry({ priority: 'high' }),
      mkEntry({ priority: 'urgent' }),
    ])
    check('R18.3.2: urgent + high + normal → merged.priority=urgent',
      merged.priority === 'urgent')
  }

  // R18.3.3: normal + low → normal
  {
    const merged = createMergedDecision('oc_p', [
      mkEntry({ priority: 'low' }),
      mkEntry({ priority: 'normal' }),
    ])
    check('R18.3.3: normal + low → merged.priority=normal',
      merged.priority === 'normal')
  }
}

// ────────────────────────────────────────────────────────────
// R18.4  unit: createMergedDecision 字段
// ────────────────────────────────────────────────────────────
{
  const e1 = mkEntry({
    decisionId: 'dec_orig_001',
    attentionId: 'att_orig_001',
    ruleId: 'r_orig',
    action: 'defer',
    priority: 'high',
    reason: 'orig reason',
    eventId: 'evt_orig_001',
    source: 'feishu',
  })
  const e2 = mkEntry({
    decisionId: 'dec_orig_002',
    attentionId: 'att_orig_002',
    reason: 'second reason',
  })
  const merged = createMergedDecision('oc_test', [e1, e2])

  check('R18.4.1: merged.action === notify', merged.action === 'notify')
  check('R18.4.2: merged.ruleId === deferred-merged',
    merged.ruleId === MERGED_DECISION_RULE_ID)
  check('R18.4.3: merged.attentionId === first.attentionId',
    merged.attentionId === 'att_orig_001')
  check('R18.4.4: merged.eventId === first.eventId',
    merged.eventId === 'evt_orig_001')
  check('R18.4.5: merged.source === first.source',
    merged.source === 'feishu')
  check('R18.4.6: merged.decisionId 是新 UUID（与 first.decisionId 不同）',
    merged.decisionId !== 'dec_orig_001' && typeof merged.decisionId === 'string' && merged.decisionId.length > 0)
  check('R18.4.7: merged.priority === high（first priority）',
    merged.priority === 'high')
  check('R18.4.8: merged.reason 含 first.reason 和 second.reason',
    merged.reason.includes('orig reason') && merged.reason.includes('second reason'))
  check('R18.4.9: MAX_MERGED_ITEMS === 5',
    MAX_MERGED_ITEMS === 5)
}

// ────────────────────────────────────────────────────────────
// R18.5  集成：executeTick 合并路径
// ────────────────────────────────────────────────────────────
{
  // R18.5.1: 1 条 eligible → 1 emit（原 Decision）
  {
    const store = createDeferredActionStore()
    const ws = mkWorldState('awake')
    const d = mkDecision({ eventId: 'evt_solo', action: 'no_action', decisionId: 'dec_solo_001' })
    store.enqueue(d)

    const fakeEventBus = mkFakeEventBus({ evt_solo: { data: { chatId: 'oc_solo' } } })
    const emitted = []
    const consumed = executeTick(store, ws, (x) => emitted.push(x), () => false, fakeEventBus)

    check('R18.5.1.1: 1 条 → consumed=1', consumed === 1)
    check('R18.5.1.2: 1 条 → emit 1 次（不合并）', emitted.length === 1)
    check('R18.5.1.3: emit 原 Decision（非合并）',
      emitted[0]?.decisionId === 'dec_solo_001' && emitted[0]?.action === 'no_action')
  }

  // R18.5.2: 2 条同 chatId → 1 emit（merged notify）
  {
    const store = createDeferredActionStore()
    const ws = mkWorldState('awake')
    const ev = { data: { chatId: 'oc_2' } }
    store.enqueue(mkDecision({ eventId: 'evt_2a' }))
    store.enqueue(mkDecision({ eventId: 'evt_2b' }))

    const fakeEventBus = mkFakeEventBus({ evt_2a: ev, evt_2b: ev })
    const emitted = []
    executeTick(store, ws, (x) => emitted.push(x), () => false, fakeEventBus)

    check('R18.5.2.1: 2 条同 chatId → emit 1 次（合并）',
      emitted.length === 1)
    check('R18.5.2.2: emit.action === notify', emitted[0]?.action === 'notify')
    check('R18.5.2.3: emit.ruleId === deferred-merged',
      emitted[0]?.ruleId === MERGED_DECISION_RULE_ID)
  }

  // R18.5.3: 2 条不同 chatId → 2 emit（每 chatId 一组）
  {
    const store = createDeferredActionStore()
    const ws = mkWorldState('awake')
    store.enqueue(mkDecision({ eventId: 'evt_3a' }))
    store.enqueue(mkDecision({ eventId: 'evt_3b' }))

    const fakeEventBus = mkFakeEventBus({
      evt_3a: { data: { chatId: 'oc_alpha' } },
      evt_3b: { data: { chatId: 'oc_beta' } },
    })
    const emitted = []
    executeTick(store, ws, (x) => emitted.push(x), () => false, fakeEventBus)

    check('R18.5.3.1: 2 不同 chatId → emit 2 次',
      emitted.length === 2)
    check('R18.5.3.2: 每组单条 → defer 翻译为 no_action（非合并；ruleId=test-rule）',
      emitted.every((e) => e.action === 'no_action' && e.ruleId === 'test-rule'))
    check('R18.5.3.3: 两条 emit 的 eventId 分别是 evt_3a / evt_3b',
      emitted.some((e) => e.eventId === 'evt_3a') && emitted.some((e) => e.eventId === 'evt_3b'))
  }

  // R18.5.4: 混合：urgent(A) + high(B)
  {
    const store = createDeferredActionStore()
    const ws = mkWorldState('awake')
    // 同 chatId（oc_A）两条：urgent + high → 应合并，priority 取 urgent
    store.enqueue(mkDecision({ eventId: 'evt_urgent', priority: 'urgent' }))
    store.enqueue(mkDecision({ eventId: 'evt_high', priority: 'high' }))

    const fakeEventBus = mkFakeEventBus({
      evt_urgent: { data: { chatId: 'oc_A' } },
      evt_high: { data: { chatId: 'oc_A' } },
    })
    const emitted = []
    executeTick(store, ws, (x) => emitted.push(x), () => false, fakeEventBus)

    const aEmit = emitted[0]
    check('R18.5.4.1: 同 chatId urgent+high → 合并 1 条 emit', emitted.length === 1)
    check('R18.5.4.2: merged.priority === urgent（取最高）', aEmit?.priority === 'urgent')
  }

  // R18.5.5: 5 条同 chatId → 1 emit（5 条全部显示）
  {
    const store = createDeferredActionStore()
    const ws = mkWorldState('awake')
    for (let i = 0; i < 5; i++) {
      store.enqueue(mkDecision({ eventId: `evt_5_${i}`, reason: `r${i}` }))
    }

    const ev = { data: { chatId: 'oc_5' } }
    const fakeEventBus = mkFakeEventBus({
      evt_5_0: ev, evt_5_1: ev, evt_5_2: ev, evt_5_3: ev, evt_5_4: ev,
    })
    const emitted = []
    executeTick(store, ws, (x) => emitted.push(x), () => false, fakeEventBus)

    check('R18.5.5.1: 5 条同 chatId → 1 emit', emitted.length === 1)
    check('R18.5.5.2: emit reason 含全部 5 条 reason',
      ['r0', 'r1', 'r2', 'r3', 'r4'].every((r) => emitted[0].reason.includes(r)))
    check('R18.5.5.3: emit reason 不含 "还有"（不 truncate）',
      !emitted[0].reason.includes('还有'))
  }

  // R18.5.6: 6 条同 chatId → 1 emit（5 显示 + 1 truncate）
  {
    const store = createDeferredActionStore()
    const ws = mkWorldState('awake')
    for (let i = 0; i < 6; i++) {
      store.enqueue(mkDecision({ eventId: `evt_6_${i}`, reason: `r${i}` }))
    }

    const ev = { data: { chatId: 'oc_6' } }
    const fakeEventBus = mkFakeEventBus({
      evt_6_0: ev, evt_6_1: ev, evt_6_2: ev, evt_6_3: ev, evt_6_4: ev, evt_6_5: ev,
    })
    const emitted = []
    executeTick(store, ws, (x) => emitted.push(x), () => false, fakeEventBus)

    check('R18.5.6.1: 6 条同 chatId → 1 emit', emitted.length === 1)
    check('R18.5.6.2: emit reason 含 "还有 1 条未展示"',
      emitted[0].reason.includes('还有 1 条未展示'))
    check('R18.5.6.3: emit reason 含 5 条 reason（不含 r5）',
      ['r0', 'r1', 'r2', 'r3', 'r4'].every((r) => emitted[0].reason.includes(r)) &&
      !emitted[0].reason.includes('r5'))
  }
}

// ────────────────────────────────────────────────────────────
// R18.6  E2E：合并 Decision 走 ActionExecutor → NotifyHandler
// ────────────────────────────────────────────────────────────
async function runMergeE2E() {
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  const bus = new EventBus({ windowSize: 50 })
  ctx.provide('eventBus', bus)

  const ws = createWorldStateService()  // 默认 awake
  ctx.provide('worldState', ws)

  // infoStore stub（避免真实写盘）
  ctx.provide('infoStore', { append: async () => {} })

  // notify 目标 chat
  const targetChatId = 'oc_e2e_merge'

  // mock feishu（构造时确保 sendToChat 与 chatId/text 都被记录）
  let sentChatId = null
  let sentText = null
  const feishu = {
    sendToChat: async (chatId, text) => {
      sentChatId = chatId
      sentText = text
    },
  }
  ctx.provide('feishu', feishu)

  const actionResults = []
  ctx.on('orca/action-result', (r) => { actionResults.push(r) })

  actionExecutor(ctx, { dryRun: false })

  const deferredStore = ctx.actionExecutor.deferredStore

  // enqueue 3 条同 chatId 的 defer pending（enqueue 期望 raw Decision；store 内部包装 entry）
  const evTemplate = { data: { chatId: targetChatId } }
  deferredStore.enqueue(mkDecision({
    eventId: 'evt_e2e_1', priority: 'urgent', reason: 'urgent msg', source: 'feishu', action: 'defer',
  }))
  deferredStore.enqueue(mkDecision({
    eventId: 'evt_e2e_2', priority: 'high', reason: 'high msg', source: 'calendar', action: 'defer',
  }))
  deferredStore.enqueue(mkDecision({
    eventId: 'evt_e2e_3', priority: 'normal', reason: 'normal msg', source: 'feishu', action: 'defer',
  }))

  // 把对应 feishu 事件 publish 到 bus（保证 eventBus.get 能反查到 chatId）
  bus.publish({ id: 'evt_e2e_1', source: 'feishu', type: 'message', data: { chatId: targetChatId, text: 'urgent body' } })
  bus.publish({ id: 'evt_e2e_2', source: 'calendar', type: 'calendar_event', data: { chatId: targetChatId, title: 'meeting' } })
  bus.publish({ id: 'evt_e2e_3', source: 'feishu', type: 'message', data: { chatId: targetChatId, text: 'normal body' } })

  // 手动 tick（不用 setInterval；用真实 bus + 真实 deferredStore）
  // 注意：executeTick 需要 eventBus 参数；这里直接构造 fakeEventBus 桥接到真实 bus
  const realBusAdapter = {
    get: (id) => {
      const events = bus.recent(100)
      return events.find((e) => e.id === id)
    },
  }
  executeTick(deferredStore, ws, (d) => ctx.emit('orca/decision', d), () => false, realBusAdapter)

  await pollFor(() => actionResults.length >= 1, 500)

  check('R18.6.1: 合并 → action-result 1 条', actionResults.length === 1)
  check('R18.6.2: merged.action-result.action === notify',
    actionResults[0]?.action === 'notify')
  check('R18.6.3: merged.action-result.success === true',
    actionResults[0]?.success === true)
  check('R18.6.4: feishu.sendToChat 被调用 1 次',
    sentChatId !== null && sentText !== null)
  check('R18.6.5: sendToChat chatId === 注入值',
    sentChatId === targetChatId)
  check('R18.6.6: sendToChat text 含 "[Orca]" header',
    typeof sentText === 'string' && sentText.startsWith('[Orca]'))
  check('R18.6.7: sendToChat text 含 "urgent"（merged.priority=urgent）',
    typeof sentText === 'string' && sentText.includes('urgent'))
  check('R18.6.8: sendToChat text 含 "你有 3 条待处理信息"',
    typeof sentText === 'string' && sentText.includes('你有 3 条待处理信息'))
  check('R18.6.9: sendToChat text 含 3 条 reason',
    typeof sentText === 'string' &&
    sentText.includes('urgent msg') &&
    sentText.includes('high msg') &&
    sentText.includes('normal msg'))
  check('R18.6.10: sendToChat text 含每条 source 标注',
    typeof sentText === 'string' &&
    sentText.includes('[feishu]') &&
    sentText.includes('[calendar]'))
  check('R18.6.11: 处理后 store 为空', deferredStore.size() === 0)
}
await runMergeE2E()

// ────────────────────────────────────────────────────────────
// R18.7  反例：合并循环防护
// ────────────────────────────────────────────────────────────
{
  // merged.action === 'notify'（不进入 defer handler；不会形成循环）
  const merged = createMergedDecision('oc_x', [
    mkEntry({ action: 'defer' }),  // 即使原始是 defer
    mkEntry({ action: 'defer' }),
  ])
  check('R18.7.1: 合并产物 action=notify（即便原始两条都是 defer）',
    merged.action === 'notify')
  check('R18.7.2: 合并产物 ruleId=deferred-merged（不是 test-rule）',
    merged.ruleId === MERGED_DECISION_RULE_ID)
}

// ────────── 结果 ──────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-notify-merged 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-notify-merged 失败 ${failed.length} 项`)
}
