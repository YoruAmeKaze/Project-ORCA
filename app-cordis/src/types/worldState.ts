/**
 * Orca World State —— 当前世界状态模型（Phase 2.A 最小骨架）
 *
 * WorldState 与 InfoRecord / OrcaEvent 的区别：
 * - InfoRecord = 档案条目（历史事实，按 ttl 清理）
 * - OrcaEvent = 事件流（实时输入，按优先级分发，可丢弃）
 * - **WorldState = 实时状态**（当前快照，自动覆盖；非历史，由 Reducer 从 EventStream 推导）
 *
 * 注意：以下"initial assumptions"只是 WorldStateUpdater 启动时的默认值，
 * **不代表已经被真实设备观测到**。它们只是"在没有任何事件输入时的合理猜测"。
 * 一旦 Reducer 收到实际事件，状态会被对应字段覆盖。
 */

export const ORCA_USER_STATUSES = [
  'awake',     // 用户清醒且活跃
  'busy',      // 用户专注中（如开会、深度工作）
  'away',      // 用户离开（30 分钟内无事件触发 Phase 2.C 的 time tick 来推导）
  'sleeping',  // 用户睡眠（iOS 健康推送 / 睡眠模式触发）
] as const

export type UserStatus = (typeof ORCA_USER_STATUSES)[number] | (string & {})

export const ORCA_POWER_MODES = [
  'plugged',       // 插电
  'battery',       // 电池
  'low_battery',   // 低电量
] as const

export type PowerMode = (typeof ORCA_POWER_MODES)[number] | (string & {})

export const ORCA_NETWORK_STATES = [
  'online',
  'offline',
] as const

export type NetworkState = (typeof ORCA_NETWORK_STATES)[number] | (string & {})

export const ORCA_TIMES_OF_DAY = [
  'dawn',      // 05:00-08:00
  'morning',   // 08:00-12:00
  'afternoon', // 12:00-18:00
  'evening',   // 18:00-22:00
  'night',     // 22:00-05:00（跨午夜）
] as const

export type TimeOfDay = (typeof ORCA_TIMES_OF_DAY)[number] | (string & {})

export interface UserState {
  status: UserStatus
  currentActivity?: string
  lastSeenAt: number
  doNotDisturb: boolean
}

export interface DeviceState {
  activeApp?: string
  isLocked: boolean
  powerMode: PowerMode
  network: NetworkState
}

export interface TimeContext {
  timeOfDay: TimeOfDay
  /** Mon Tue Wed Thu Fri Sat Sun */
  dayOfWeek: string
  isWorkday: boolean
  isWeekend: boolean
}

/**
 * 完整 WorldState。extensions 字段为未来 calendar / pc / phone 等扩展预留。
 * 设计上**整个对象不可从外部修改**——外部只能通过 WorldStateService.getState() 读取快照。
 */
export interface WorldState {
  user: UserState
  device: DeviceState
  time: TimeContext
  extensions: Record<string, Record<string, unknown>>
  lastUpdated: number
  lastEventId?: string
}

/**
 * WorldStateService 接口定义在 src/services/worldState.ts（按 Phase 2.A 设计要求）。
 *
 * 这里仅放置"数据形态"类型（UserStatus / UserState / DeviceState / TimeContext / WorldState）；
 * WorldStateService（"可被外部使用的形态"）放在 services 模块，以便未来在 service 层
 * 扩展实现细节（如缓存、事件触发等），不影响 type 层的纯类型契约。
 */