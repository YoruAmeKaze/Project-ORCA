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

import { randomUUID } from 'node:crypto'
import type {
  AttentionDedupService,
  AttentionEngineService,
  AttentionItem,
  AttentionInput,
  AttentionRule,
  AttentionRuleRegistry,
  AttentionThrottleService,
} from '../types/attention.js'

// ── 注册表（Phase 3.B.rule-registry）────────────────────────────────────

/**
 * RuleRegistryImpl —— AttentionRuleRegistry 标准实现
 *
 * 内部用数组保序（Map.values() 虽也保插入序，但数组更显式 + 顺序在 unregister 后保持）。
 * enabled 状态单独存 Set（不污染 Rule 对象本身）。
 */
class RuleRegistryImpl implements AttentionRuleRegistry {
  private rules: AttentionRule[] = []
  private disabled = new Set<string>()

  register(rule: AttentionRule): void {
    // 同 id 重复注册 → 覆盖并保留原位置（便于热更新）
    const idx = this.rules.findIndex((r) => r.id === rule.id)
    if (idx >= 0) {
      this.rules[idx] = rule
    } else {
      this.rules.push(rule)
    }
    this.disabled.delete(rule.id)  // 重注册默认 enabled
  }

  unregister(ruleId: string): void {
    this.rules = this.rules.filter((r) => r.id !== ruleId)
    this.disabled.delete(ruleId)
  }

  getRules(): AttentionRule[] {
    // 仅返回 enabled 规则（按注册顺序）
    return this.rules.filter((r) => !this.disabled.has(r.id))
  }

  getAllRules(): AttentionRule[] {
    return [...this.rules]
  }

  setEnabled(ruleId: string, enabled: boolean): void {
    if (!this.rules.some((r) => r.id === ruleId)) {
      throw new Error(`[rule-registry] setEnabled: rule '${ruleId}' 未注册`)
    }
    if (enabled) {
      this.disabled.delete(ruleId)
    } else {
      this.disabled.add(ruleId)
    }
  }

  isEnabled(ruleId: string): boolean {
    if (!this.rules.some((r) => r.id === ruleId)) return false
    return !this.disabled.has(ruleId)
  }

  size(): number {
    return this.getRules().length
  }

  clear(): void {
    this.rules = []
    this.disabled.clear()
  }
}

/** 工厂函数：创建独立的（空）Registry；用于 R11 测试和未来配置化场景 */
export function createRuleRegistry(): AttentionRuleRegistry {
  return new RuleRegistryImpl()
}

/**
 * 默认 Registry（包含 5 条内置规则）。
 * - 模块加载时自动注册 5 条规则
 * - createAttentionEngine() 不传参时使用此 Registry（保持 Phase 3.A 行为）
 * - 向后兼容：registerRule / clearRules / ruleRegistrySize 委托此 Registry
 */
const defaultRegistry: AttentionRuleRegistry = createRuleRegistry()

/**
 * 注册规则（同 id 重复注册会覆盖）。**向后兼容 Phase 3.A API**。
 * 内部委托 defaultRegistry。
 */
export function registerRule(rule: AttentionRule): void {
  defaultRegistry.register(rule)
}

/** 测试 / 内部用：清空默认注册表 */
export function clearRules(): void {
  defaultRegistry.clear()
}

/** 当前默认注册表中已启用的规则数（向后兼容 Phase 3.A API） */
export function ruleRegistrySize(): number {
  return defaultRegistry.size()
}

/** 获取默认 Registry（包含 5 条内置规则）；Phase 3.B.rule-config 将扩展此 */
export function getDefaultRegistry(): AttentionRuleRegistry {
  return defaultRegistry
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
 * 纯评估引擎：遍历 registry，对每个**启用**规则调 predicate；命中则调 produce 生成 AttentionItem。
 *
 * Phase 3.B.rule-registry：
 * - Engine 接受外部注入的 AttentionRuleRegistry（不硬编码模块全局 Map）
 * - registry.getRules() 只返回启用规则；禁用规则不参与 evaluate
 * - 同 id 重复 register 覆盖并保留原位置；disable / unregister 后顺序保持
 *
 * 关键（向后兼容）：
 * - stateSnapshot 是 input.state 的深拷贝（避免后续 mutation 污染追溯）
 * - 不去重 / 不排序（按 registry.getRules() 顺序；Phase 4 Decision 可按 priority 排序）
 * - state-only 触发（event=null）的规则（如 R1 sleeping-quiet）会被 evaluate；
 *   但需要 event 的规则（R2/R3/R5）会因 predicate 中 event 检查而 false
 * - source 字段（Phase 3.B.throttle 引入）：input.event?.source ?? 'state'
 */
export class AttentionEngine implements AttentionEngineService {
  constructor(private readonly registry: AttentionRuleRegistry) {}

  evaluate(input: AttentionInput): AttentionItem[] {
    const out: AttentionItem[] = []
    const evaluatedAt = Date.now()
    const stateSnapshot = JSON.parse(JSON.stringify(input.state)) as AttentionInput['state']
    const eventId = input.event?.id

    for (const rule of this.registry.getRules()) {
      if (!rule.predicate(input)) continue
      const partial = rule.produce(input)
      // Phase 3.B.throttle：source 用于 source cooldown；state-only 触发用 'state' 占位
      const source = input.event?.source ?? 'state'
      out.push({
        // Phase 4.A：每个 AttentionItem 分配稳定唯一 id（Decision back-trace 用）
        id: randomUUID(),
        ruleId: rule.id,
        stateSnapshot,
        evaluatedAt,
        source,
        ...partial,
        // eventId 优先用 produce 返回的，否则用 input.event.id
        eventId: partial.eventId ?? eventId,
      })
    }
    return out
  }

  ruleCount(): number {
    return this.registry.size()
  }
}

/**
 * 工厂函数（Phase 3.B.rule-registry）
 * - 不传参：使用默认 Registry（包含 5 条内置规则；行为完全等同 Phase 3.A）
 * - 传参：使用自定义 Registry（便于测试、未来配置化）
 */
export function createAttentionEngine(
  registry: AttentionRuleRegistry = getDefaultRegistry(),
): AttentionEngineService {
  return new AttentionEngine(registry)
}

// ── Phase 3.B: AttentionDedup ─────────────────────────────────────────

/**
 * 默认 dedup 窗口（毫秒）：5000ms。
 * Phase 3.B 第一版硬编码；未来可作为 OrcaAttentionConfig 选项暴露。
 */
export const DEFAULT_DEDUP_WINDOW_MS = 5000

interface DedupEntry {
  /** 最近一次 emit 时间戳（ms） */
  lastEmitTs: number
}

/**
 * AttentionDedup —— (ruleId, eventId) 窗口期内去重
 *
 * 内部 key：`${ruleId}:${eventId ?? '__state__'}`
 * - 同 ruleId + 同 eventId 在窗口期内 → 第二次 drop
 * - 不同 ruleId 或不同 eventId → 个自独立计数
 * - state-only 触发（eventId=undefined）→ 用 '__state__' 兜底
 *
 * 不做：
 * - 不去重 map 容量限制（map 会无限增长；Phase 3.B+ 可加 LRU）
 * - 不持久化
 * - 不规则配置化（用户决策：先 dedup/throttle，再 rule config）
 */
export class AttentionDedup implements AttentionDedupService {
  private readonly map = new Map<string, DedupEntry>()
  private readonly windowMs: number

  constructor(opts: { windowMs?: number } = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_DEDUP_WINDOW_MS
  }

  shouldEmit(item: AttentionItem): boolean {
    const key = this.keyOf(item)
    const now = Date.now()
    const existing = this.map.get(key)
    if (existing && now - existing.lastEmitTs < this.windowMs) {
      // 窗口期内重复 → drop
      return false
    }
    // 首次或窗口已过期 → record + emit
    this.map.set(key, { lastEmitTs: now })
    return true
  }

  size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  private keyOf(item: AttentionItem): string {
    return `${item.ruleId}:${item.eventId ?? '__state__'}`
  }
}

/** 工厂函数（Phase 3.B 第一版默认窗口 5000ms） */
export function createAttentionDedup(opts: { windowMs?: number } = {}): AttentionDedupService {
  return new AttentionDedup(opts)
}

// ── Phase 3.B.throttle: AttentionThrottle ──────────────────────────────────

/** 默认 source cooldown 间隔（毫秒） */
export const DEFAULT_THROTTLE_COOLDOWN_MS = 5000
/** 默认 hourly cap：1 小时内最多 notify 次数 */
export const DEFAULT_THROTTLE_HOURLY_CAP = 10
/** 默认 hourly window（毫秒 = 1 小时） */
export const DEFAULT_THROTTLE_WINDOW_MS = 60 * 60 * 1000

/**
 * AttentionThrottle —— 防止短时间内反复打扰用户
 *
 * 两种机制（仅对会打扰用户的 action 生效：`notify_immediately` + `act`）：
 *
 * 1. **Source cooldown**（`cooldownMs`，默认 5000ms）：
 *    - 同一 source（如 'feishu'、'pc'、'calendar'）在 cooldownMs 内的下一次 notify emit → drop
 *    - 跨 source 独立计数（feishu cooldown 不影响 pc）
 *    - state-only 触发（source='state'）**不应用** cooldown（避免 state_changed 被任意 source 限制）
 *
 * 2. **Hourly cap**（`hourlyCap`，默认 10 / `windowMs` 默认 1 小时）：
 *    - 滑动窗口：滚动保留 [now - windowMs, now] 内的 notify emit 时间戳
 *    - 超过 cap → drop
 *    - 与 source cooldown 独立；可能同时被两者拦截
 *
 * 直通（不应用 throttle）：
 * - `action ∈ {remember_only, ignore, wait_until_available}` → 直接通过
 * - `source === 'state'` 或 `source === undefined` → 不应用 source cooldown（避免 state_changed 被任意限制）
 *
 * 不做（Phase 3.B 第二步）：
 * - 不持久化
 * - 不规则配置化（用户决策：先稳定再配置；窗口默认值硬编码）
 * - 不暴露 throttle 配置（构造参数仅供测试用）
 */
export class AttentionThrottle implements AttentionThrottleService {
  private readonly cooldownMs: number
  private readonly hourlyCap: number
  private readonly windowMs: number
  private clock: () => number = () => Date.now()
  /** source → 上一次 notify emit 时间戳 */
  private readonly lastBySource = new Map<string, number>()
  /** rolling window 内的 notify emit 时间戳数组 */
  private readonly hourlyTimestamps: number[] = []

  constructor(opts: {
    cooldownMs?: number
    hourlyCap?: number
    windowMs?: number
    clock?: () => number
  } = {}) {
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_THROTTLE_COOLDOWN_MS
    this.hourlyCap = opts.hourlyCap ?? DEFAULT_THROTTLE_HOURLY_CAP
    this.windowMs = opts.windowMs ?? DEFAULT_THROTTLE_WINDOW_MS
    if (opts.clock) this.clock = opts.clock
  }

  shouldEmit(item: AttentionItem): boolean {
    // 1. 仅对会打扰用户的 action 生效；其他直通
    if (item.action !== 'notify_immediately' && item.action !== 'act') {
      return true
    }

    // 2. state-only 触发（source='state' 或 undefined）→ 不应用 source cooldown
    //    （避免 state_changed 被任意 source 限制；如未来需要 cap state-only 通知可单独加 'state' cap）
    const realSource = (item.source && item.source !== 'state') ? item.source : null

    const now = this.clock()

    if (realSource !== null) {
      // 3a. Source cooldown
      const last = this.lastBySource.get(realSource)
      if (last !== undefined && now - last < this.cooldownMs) {
        return false  // cooldown 内 → drop
      }
      // 3b. Hourly cap（滑动窗口）
      this.pruneHourly(now)
      if (this.hourlyTimestamps.length >= this.hourlyCap) {
        return false  // 超出 cap → drop
      }
    }
    // state-only：跳过 cooldown + cap（直通）

    // 通过 → record
    if (realSource !== null) {
      this.lastBySource.set(realSource, now)
      this.hourlyTimestamps.push(now)
    }
    return true
  }

  reset(): void {
    this.lastBySource.clear()
    this.hourlyTimestamps.length = 0
  }

  setClock(fn: () => number): void {
    this.clock = fn
  }

  /** 清理 windowMs 之外的时间戳 */
  private pruneHourly(now: number): void {
    const cutoff = now - this.windowMs
    while (this.hourlyTimestamps.length > 0) {
      const head = this.hourlyTimestamps[0]
      if (head === undefined || head >= cutoff) break
      this.hourlyTimestamps.shift()
    }
  }
}

/** 工厂函数（Phase 3.B.throttle 第一版默认值） */
export function createAttentionThrottle(opts: {
  cooldownMs?: number
  hourlyCap?: number
  windowMs?: number
  clock?: () => number
} = {}): AttentionThrottleService {
  return new AttentionThrottle(opts)
}