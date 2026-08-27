/**
 * Orca Attention Engine —— 规则注册表 + 纯评估（Phase 3 第一版，不引入 LLM）
 *
 * 职责：
 * - AttentionRule 注册表（按 ruleId 索引）
 * - AttentionEngine.evaluate(input) → AttentionItem[]（应用所有匹配规则）
 * - 内置 5 条示例规则（用户决策：先规则，不引入 LLM）
 *
 * 不做（Phase 3 范围外）：
 * - 不持久化
 * - 不去重 / 节流（Phase 4+）
 * - 不发飞书 / 调 agent / 写 infoStore（Phase 4 Decision）
 * - LLM 增强（Phase 5）
 */

import type {
  AttentionEngineService,
  AttentionItem,
  AttentionInput,
  AttentionRule,
} from '../types/attention.js'

// ── 注册表 ────────────────────────────────────────────────────────────

const ruleRegistry = new Map<string, AttentionRule>()

/**
 * 注册规则。同 id 重复注册会覆盖（便于测试和热更新）。
 */
export function registerRule(rule: AttentionRule): void {
  ruleRegistry.set(rule.id, rule)
}

/** 测试 / 内部用：清空注册表 */
export function clearRules(): void {
  ruleRegistry.clear()
}

/** 当前已注册的规则数量 */
export function ruleRegistrySize(): number {
  return ruleRegistry.size
}

// ── 内置规则（Phase 3 第一版：5 条示例规则） ─────────────────────────────

/** R1: 用户睡眠时 → 全部忽略（不打扰） */
const ruleSleepingQuiet: AttentionRule = {
  id: 'sleeping-quiet',
  description: '用户睡眠时不打扰（任何 event / state-only 触发）',
  predicate: ({ state }) => state.user.status === 'sleeping',
  produce: () => ({
    priority: 'low',
    reason: '用户正在睡眠',
    action: 'ignore',
  }),
}

/** R2: 飞书消息含 deadline 关键词 → 高优先级 remember */
const ruleFeishuDeadline: AttentionRule = {
  id: 'feishu-deadline',
  description: '飞书消息含 deadline 类关键词（今晚前/明天前/截止/ddl/报告/due）',
  predicate: ({ event }) =>
    event?.source === 'feishu' && event.type === 'message' &&
    /今晚前|明天前|截止|ddl|报告|due/i.test(String(event.data.text ?? '')),
  produce: ({ event }) => {
    const text = String(event?.data.text ?? '')
    return {
      priority: 'high',
      reason: `消息含 deadline 关键词：「${text.slice(0, 30)}」`,
      action: 'remember_only',
      eventId: event?.id,
    }
  },
}

/** R3: 用户忙碌 + 日历事件 ≤5 分钟 → 等待可用时通知 */
const ruleCalendarBusySoon: AttentionRule = {
  id: 'calendar-busy-soon',
  description: '用户忙时收到 ≤5 分钟后的日历事件',
  predicate: ({ event, state }) =>
    event?.source === 'calendar' && event.type === 'calendar_event' &&
    state.user.status === 'busy' &&
    Number(event.data.minutesBefore) <= 5,
  produce: ({ event }) => ({
    priority: 'high',
    reason: `忙碌中收到 ${event?.data.minutesBefore} 分钟后的会议「${String(event?.data.title ?? '?')}」`,
    action: 'wait_until_available',
    eventId: event?.id,
  }),
}

/** R4: 用户 away 时收到事件 → 入档待用户回来
 *
 * 重要：必须用 prevState 而不是 state。
 * feishuMessageReducer 会把 status 改回 'awake'，所以 current state.status='awake'，
 * 但 prevState 仍是 'away'——这才是"用户 away 时收到事件"的语义。
 * Phase 3.A 引入 prevState snapshot 的核心目的之一就是让这种规则能正确触发。
 *
 * prevState 可选（state-only 触发时为 undefined）：本规则要求 event !== null，
 * 因此在 state-only 触发下永远不命中（prevState 为 undefined 时短路）。
 */
const ruleAwayArrival: AttentionRule = {
  id: 'away-arrival',
  description: '用户 away 时收到新事件（用 prevState 而非 current state，避免 reducer 把 awake 覆盖 away）',
  predicate: ({ event, prevState }) =>
    event !== null && prevState?.user.status === 'away',
  produce: () => ({
    priority: 'normal',
    reason: '用户当前 away，新事件入档待用户回来',
    action: 'remember_only',
    eventId: undefined,  // 由 AttentionEngine 注入（event.id）
  }),
}

/** R5: 用户 focus / meeting 时收到飞书消息 → 不打断，仅入档 */
const ruleFocusInterrupt: AttentionRule = {
  id: 'focus-interrupt',
  description: '用户在 focus / meeting 时收到飞书消息（不打断）',
  predicate: ({ event, state }) =>
    event?.source === 'feishu' && event.type === 'message' &&
    (state.user.currentActivity === 'focus' || state.user.currentActivity === 'meeting'),
  produce: ({ event }) => ({
    priority: 'normal',
    reason: `用户在 ${event && 'focus'}，仅入档不打断`,
    action: 'remember_only',
    eventId: event?.id,
  }),
}

// 模块加载时一次性注册（与 Phase 2.A reducer 模式一致）
registerRule(ruleSleepingQuiet)
registerRule(ruleFeishuDeadline)
registerRule(ruleCalendarBusySoon)
registerRule(ruleAwayArrival)
registerRule(ruleFocusInterrupt)

// ── AttentionEngine 服务 ────────────────────────────────────────────────

/**
 * 纯评估引擎：遍历注册表，对每个规则调 predicate；命中则调 produce 生成 AttentionItem。
 *
 * 关键：
 * - stateSnapshot 是 input.state 的深拷贝（避免后续 mutation 污染追溯）
 * - 不去重 / 不排序（按注册顺序；Phase 4 Decision 可按 priority 排序）
 * - state-only 触发（event=null）的规则（如 R1 sleeping-quiet）会被 evaluate；
 *   但需要 event 的规则（R2/R3/R5）会因 predicate 中 event 检查而 false
 */
export class AttentionEngine implements AttentionEngineService {
  evaluate(input: AttentionInput): AttentionItem[] {
    const out: AttentionItem[] = []
    const evaluatedAt = Date.now()
    const stateSnapshot = JSON.parse(JSON.stringify(input.state)) as AttentionInput['state']
    const eventId = input.event?.id

    for (const rule of ruleRegistry.values()) {
      if (!rule.predicate(input)) continue
      const partial = rule.produce(input)
      out.push({
        ruleId: rule.id,
        stateSnapshot,
        evaluatedAt,
        ...partial,
        // eventId 优先用 produce 返回的，否则用 input.event.id
        eventId: partial.eventId ?? eventId,
      })
    }
    return out
  }

  ruleCount(): number {
    return ruleRegistry.size
  }
}

/** 工厂函数 */
export function createAttentionEngine(): AttentionEngineService {
  return new AttentionEngine()
}