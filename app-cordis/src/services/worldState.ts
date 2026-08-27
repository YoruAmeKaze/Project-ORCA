/**
 * Orca World State Service —— Reducer 注册表 + 状态计算工具（Phase 2.A 最小骨架）
 *
 * 职责：
 * - StateReducer 类型（纯函数）
 * - Reducer 注册表（按 `${source}:${type}` key 索引）
 * - applyReducers(state, event) → newState（应用所有匹配 reducer，返回新 state）
 * - getInitialState()（启动时默认值，详见注释）
 * - computeTimeContext(timestamp?)（按本地时间推导时段/星期/工作日）
 * - WorldStateService 接口（ctx.worldState 暴露的只读视图）
 *
 * 不做（Phase 2.A 范围外）：
 * - 不实现 setInterval（time tick 推到 Phase 2.C）
 * - 不实现 away 自动判断（仅 feishu:message → awake + lastSeenAt）
 * - 不持久化 WorldState
 * - 不暴露任何 setter（state 变更只能由 WorldStateUpdater 内部完成）
 */

import type { OrcaEvent } from '../types/event.js'
import type {
  TimeContext,
  TimeOfDay,
  UserState,
  UserStatus,
  DeviceState,
  WorldState,
} from '../types/worldState.js'

// ── Reducer 类型 ────────────────────────────────────────────────────────

/**
 * 纯函数 reducer：(state, event) → Partial<WorldState> | null
 *
 * - 返回 Partial 表示"修改这些字段"（未提及的字段保持不变）
 * - 返回 null 表示"该事件不触发状态变更"（reducer 可用于 no-op 标记）
 * - 必须保持不可变：通过 spread 创建新对象，绝不能 mutate state
 */
export type StateReducer = (
  state: WorldState,
  event: OrcaEvent
) => Partial<WorldState> | null

// ── Reducer 注册表 ──────────────────────────────────────────────────────

const reducerRegistry = new Map<string, StateReducer>()

/**
 * 注册 reducer。key 格式：`${source}:${type}`（例如 `feishu:message`、`pc:app_focus`）。
 * 同 key 重复注册会覆盖（便于测试和热更新）。
 */
export function registerReducer(source: string, type: string, reducer: StateReducer): void {
  reducerRegistry.set(`${source}:${type}`, reducer)
}

/** 测试 / 内部用：清空注册表 */
export function clearReducers(): void {
  reducerRegistry.clear()
}

/** 当前已注册的 reducer 数量 */
export function reducerRegistrySize(): number {
  return reducerRegistry.size
}

// ── 默认 Reducer：feishu:message（Phase 2.A 最小骨架） ──────────────────

/**
 * feishu:message reducer：用户活跃信号
 * - user.lastSeenAt = event.timestamp
 * - user.status = 'awake'
 *
 * 故意**不**实现 away 自动判断——away 推导需要"30 分钟无事件"的窗口逻辑，
 * 属于 time tick（Phase 2.C），不在 Phase 2.A 范围。
 */
function feishuMessageReducer(state: WorldState, event: OrcaEvent): Partial<WorldState> {
  const user: UserState = {
    ...state.user,
    lastSeenAt: event.timestamp,
    status: 'awake',
  }
  return { user }
}

// 注册：仅一次（模块加载时）。若需热重载可改为在 plugin apply 中注册并提供 dispose。
registerReducer('feishu', 'message', feishuMessageReducer)

// ── applyReducers ───────────────────────────────────────────────────────

/**
 * 对一个事件应用所有匹配的 reducer，返回新 state。
 *
 * 行为：
 * - 若无任何 reducer 匹配 → 返回原 state 引用（WorldStateUpdater 据此判断"无变化"）
 * - 若有一个或多个 reducer 匹配 → 从首个 Partial 开始浅合并，依次应用到 state，
 *   最终返回新 state 对象（顶层引用一定变化）
 *
 * 注意：reducer 自身负责不可变更新；applyReducers 只做"浅合并"。
 * 若多个 reducer 同时修改同一字段，**后者覆盖前者**（Map 迭代顺序）。
 */
export function applyReducers(state: WorldState, event: OrcaEvent): WorldState {
  let next: WorldState = state
  let anyMatched = false
  for (const [key, reducer] of reducerRegistry) {
    const [source, type] = key.split(':', 2)
    if (source !== event.source || type !== event.type) continue
    anyMatched = true
    const partial = reducer(next, event)
    if (partial === null) continue
    next = { ...next, ...partial }
  }
  return anyMatched ? next : state
}

// ── getInitialState ──────────────────────────────────────────────────────

/**
 * WorldState 初始默认值。**仅作为"在无任何事件输入时的合理猜测"**，不代表已被观测。
 * - user.status = 'awake'（假设 Orca 启动时用户在线）
 * - user.doNotDisturb = false（初始不打扰）
 * - device.isLocked = false（假设电脑未锁屏）
 * - device.powerMode = 'plugged'（假设插电；PC adapter 接入后会覆盖）
 * - device.network = 'online'（假设联网；断网事件会覆盖）
 * - time = computeTimeContext()（按启动时刻计算）
 * - lastUpdated = Date.now()
 *
 * 不调用 `Date.now()` 的副作用，方便测试传入固定时间戳。
 */
export function getInitialState(now: number = Date.now()): WorldState {
  const user: UserState = {
    status: 'awake',
    lastSeenAt: now,
    doNotDisturb: false,
  }
  const device: DeviceState = {
    isLocked: false,
    powerMode: 'plugged',
    network: 'online',
  }
  const time: TimeContext = computeTimeContext(now)
  return {
    user,
    device,
    time,
    extensions: {},
    lastUpdated: now,
  }
}

// ── computeTimeContext ───────────────────────────────────────────────────

/**
 * 时段划分（按本地时间 24h 制，hour 为 0-23 的整数）：
 * - dawn:      05:00-08:00（hour >= 5 && hour < 8）
 * - morning:   08:00-12:00（hour >= 8 && hour < 12）
 * - afternoon: 12:00-18:00（hour >= 12 && hour < 18）
 * - evening:   18:00-22:00（hour >= 18 && hour < 22）
 * - night:     22:00-05:00（hour >= 22 || hour < 5，跨午夜）
 *
 * dayOfWeek: 'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat'
 *
 * isWorkday: 周一至周五；isWeekend: 周六周日。
 *
 * 不传 timestamp 默认 Date.now()。
 */
export function computeTimeContext(timestamp: number = Date.now()): TimeContext {
  const d = new Date(timestamp)
  const hour = d.getHours()
  let timeOfDay: TimeOfDay
  if (hour >= 5 && hour < 8) timeOfDay = 'dawn'
  else if (hour >= 8 && hour < 12) timeOfDay = 'morning'
  else if (hour >= 12 && hour < 18) timeOfDay = 'afternoon'
  else if (hour >= 18 && hour < 22) timeOfDay = 'evening'
  else timeOfDay = 'night'

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const dayIndex = d.getDay()
  const dayOfWeek = days[dayIndex] ?? 'Sun'
  const isWeekend = dayIndex === 0 || dayIndex === 6
  const isWorkday = !isWeekend

  return { timeOfDay, dayOfWeek, isWorkday, isWeekend }
}

// ── inactivity 推导（Phase 2.C）─────────────────────────────────────────

/**
 * 30 分钟无活动视为 away 的阈值（毫秒）。
 * Phase 2.C 第一版硬编码；未来可作为配置项暴露。
 */
export const AWAY_THRESHOLD_MS = 30 * 60 * 1000

/**
 * 推算 user.status（基于 lastSeenAt 与 now 的时间差）。
 *
 * 设计原则（Phase 2.C 第一版）：
 * - **仅 awake → away 单向推导**。其他状态（busy / sleeping / away）不主动覆盖。
 * - busy / sleeping 是用户主动设置或由其他信号（如 calendar / phone sleep）触发；
 *   time tick 不会"猜"这些状态。
 * - away 状态不自恢复（用户需新事件触发 re-derive 或 Phase 3+ Attention 主动反向）。
 * - lastSeenAt <= 0（兜底，无事件触发）→ 不推导。
 *
 * 返回：
 * - null = 不修改 user.status（应跳过 emit）
 * - UserStatus = 推导结果（当前只会返回 'away'）
 */
export function deriveUserStatus(state: WorldState, now: number = Date.now()): UserStatus | null {
  // 1. 只对 awake 推导；其他状态（busy / sleeping / away）不主动覆盖
  if (state.user.status !== 'awake') return null
  // 2. 兜底：lastSeenAt <= 0 表示从未有过事件输入，不推导
  if (state.user.lastSeenAt <= 0) return null
  // 3. 超过 30 分钟无活动 → away
  // 注：使用严格 >（即 30:00 整不算 away，30:00.001 才算）
  if (now - state.user.lastSeenAt > AWAY_THRESHOLD_MS) {
    return 'away'
  }
  return null
}

// ── WorldStateService 接口（ctx.worldState 暴露形态） ─────────────────────

/**
 * WorldStateService 是 Cordis Context 暴露给其他 plugin 的只读接口。
 *
 * 设计原则：
 * - 仅暴露 getState()（返回 WorldState 快照的深拷贝，外部持有的是值不是引用）
 * - 不暴露任何 setter——状态变更只能由 WorldStateUpdater 内部完成
 * - 这是 Cordis Context service interface，按 @deepseek-ai/cordis 约定
 *   在 src/context.ts 的 declare module Context 中声明
 */
export interface WorldStateService {
  /**
   * 返回当前 WorldState 的深拷贝快照（不持有内部引用，避免外部 mutation 污染）。
   * 注意：返回的是新对象，频繁调用有 JSON 序列化级别性能成本；dashboard 端点按需调用。
   */
  getState(): WorldState
}

/**
 * 创建 WorldStateService 实例（仅供 WorldStateUpdater 内部使用）。
 *
 * 工厂函数而非类：state 完全是闭包私有，外部无法绕过 getState() 读取/修改。
 */
export function createWorldStateService(getter: () => WorldState): WorldStateService {
  return {
    getState(): WorldState {
      // 深拷贝：JSON 序列化反序列化。WorldState 字段都是 plain JSON-safe，
      // 性能足够 dashboard 端点使用（不在 hot path）。
      return JSON.parse(JSON.stringify(getter())) as WorldState
    },
  }
}