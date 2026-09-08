/**
 * Orca Persistent Context Runtime —— 事件流类型定义
 *
 * 与现有 InfoRecord 的区别：
 * - InfoRecord 是档案条目（append-only JSONL，按 ttl 清理，事实历史）
 * - OrcaEvent 是事件流条目（滑动窗口，按优先级分发，可丢弃，实时流）
 *
 * Phase 0 + 1：仅定义类型 + 输入辅助类型，不挂载任何运行时逻辑。
 */

export const ORCA_EVENT_KNOWN_SOURCES = [
  'feishu',          // 飞书消息
  'calendar',        // 日历事件
  'pc',              // 电脑状态（焦点/进程/电池）
  'phone',           // 手机推送
  'scheduler',       // 内部调度器（Phase 7.1A 新增）
  'iot',             // 智能家居
  'environment',     // 环境传感器
  'internal',        // Orca 内部事件（自检/状态变更）
  // IM Bridge（IM-1.0 新增）
  'im.qq',           // QQ 消息（NapCatQQ）
  'im.wechat',       // 微信消息（openclaw-weixin）
] as const

export type OrcaEventSource = (typeof ORCA_EVENT_KNOWN_SOURCES)[number] | (string & {})

export const ORCA_EVENT_KNOWN_TYPES = [
  'message',         // 文本消息
  'notification',    // 通知（图片/系统通知等）
  'calendar_event',  // 日历事件
  'app_focus',       // 应用焦点变化
  'sensor',          // 通用传感器数据
  'state_changed',   // 状态变更（来自 World State，Phase 2）
  'user_action',     // 用户主动行为
  // Phase 7.1A：scheduler 事件（GPT Review Phase 7.0）
  'scheduler:tick',     // 心跳事件
  'briefing:due',       // 简报提醒（source='scheduler'，Phase 7.1B）
  'reflection:due',     // 反思提醒（source='scheduler'）
  'reminder:due',       // 通用提醒（source='scheduler'）
  // IM Bridge（IM-1.0 新增）
  'im.message.received', // IM 收到消息
  'im.message.sent',    // IM Orca 发出消息
] as const

export type OrcaEventType = (typeof ORCA_EVENT_KNOWN_TYPES)[number] | (string & {})

/** 优先级 0=debug 1=normal 2=important 3=urgent */
export type OrcaEventPriority = 0 | 1 | 2 | 3

/** 完整 OrcaEvent（持久化在 EventBus 滑动窗口中的形态） */
export interface OrcaEvent {
  id: string
  source: OrcaEventSource
  type: OrcaEventType
  timestamp: number
  data: Record<string, unknown>
  priority: OrcaEventPriority
  sessionId?: string
  userId?: string
  meta?: Record<string, unknown>
}

/**
 * publish 输入：publish 时可省略 id/timestamp，EventBus 内部补默认。
 * priority 不传时默认 1（normal）。
 */
export interface PublishEventInput {
  id?: string
  source: OrcaEventSource
  type: OrcaEventType
  timestamp?: number
  data?: Record<string, unknown>
  /** 默认 1 */
  priority?: OrcaEventPriority
  sessionId?: string
  userId?: string
  meta?: Record<string, unknown>
}

/** 订阅过滤条件 */
export interface EventFilter {
  source?: string
  type?: string
  minPriority?: OrcaEventPriority
}

/** 事件处理器（异步失败不阻塞 publish，但记 warn 日志） */
export type EventHandler = (event: OrcaEvent) => void | Promise<void>