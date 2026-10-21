/**
 * Orca IM Bridge —— 通信观察信号类型（IM-1.5A Phase）
 *
 * 设计原则：
 * - 只含行为信号，不含消息内容
 * - 禁止保存：text / summary / topic / emotion / relationship inference
 * - Observation 数据不晋升为 Memory（Episode 独立存储，7天TTL）
 *
 * IM-1.5A 范围：
 * - CommunicationSignal 类型定义
 * - IM Observation Adapter（订阅 EventBus，生成 signal）
 *
 * IM-1.5A 禁止：
 * - 不调用 LLM
 * - 不调用 MemoryStore（Episode 写入由 EpisodeEngine 管理）
 * - 不调用 AttentionEngine / DecisionEngine
 * - 不产生 Decision
 * - 不触发 Action
 */

import type { MessageEnvelope } from './im.js'

/**
 * 通信观察信号类型（MVP）
 *
 * 三种 signalType：
 * - message.received：收到一条 IM 消息
 * - message.sent：Orca 发出一条 IM 消息
 * - burst.detected：检测到消息突发（同一 sender 在窗口内发 ≥3 条）
 */
export type CommunicationSignalType = 'message.received' | 'message.sent' | 'burst.detected'

/**
 * CommunicationSignal —— 通信观察信号的最小单元
 *
 * 约束：
 * - 不含 message content / text / summary
 * - senderId / platform / timestamp / signalType 是全部字段
 * - burst.signalType 时 burstDetail 含 messageCount / durationMs
 */
export interface CommunicationSignal {
  /** 信号类型 */
  signalType: CommunicationSignalType
  /** 信号产生时间 */
  timestamp: number
  /** 原始 EventBus 事件 ID（用于 debug/back-trace） */
  eventId: string
  /** 消息来源平台 */
  sourcePlatform: 'qq' | 'wechat'
  /** 发送者 ID */
  senderId: string
  /** 会话 ID */
  conversationId: string
  /** 是否群聊 */
  isGroup: boolean
  /** 突发详情（仅 signalType='burst.detected' 时存在） */
  burstDetail?: {
    messageCount: number
    durationMs: number
    firstEventId: string
    lastEventId: string
  }
}

/**
 * IMObservationAdapter 配置
 */
export interface IMObservationConfig {
  /** 是否启用（默认 false） */
  enabled: boolean
  /** 突发检测窗口（毫秒），默认 60 分钟 */
  burstWindowMs: number
  /** 突发最小消息数，默认 3 */
  burstMinCount: number
  /** 是否写入 im.burst Episode（默认 false，IM-2.0 再开启）*/
  emitEpisodes: boolean
}

/**
 * BurstTracker —— 检测消息突发的内部状态
 *
 * 追踪每个 sender 的消息时间戳窗口。
 * 窗口内消息数 ≥ burstMinCount → 触发 burst.detected signal。
 */
interface BurstTracker {
  senderId: string
  conversationId: string
  timestamps: number[]   // 窗口内所有消息的时间戳
  eventIds: string[]     // 对应事件 ID
  platform: 'qq' | 'wechat'
}
