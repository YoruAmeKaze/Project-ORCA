/**
 * Orca IM Bridge —— IM 类型定义（IM-1.0 Phase）
 *
 * 职责边界（IM-1.0）：
 * - Adapter 只做"原协议 → MessageEnvelope"，然后通过 EventBus 发布事件
 * - Adapter 不调 LLM、不做决策、不直接回复、不直接写 Memory
 *
 * IM-1.0 范围：
 * - MessageEnvelope 类型定义
 * - IMAdapter RuntimeAdapter 接口
 * - MockIMAdapter（用于 smoke test）
 *
 * IM-1.0 禁止：
 * - 自动回复（IM-2.0）
 * - 联系人系统（IM-2.x）
 * - LLM 介入
 * - Memory 直接写入
 * - Attention/Decision 修改
 */

import type { RuntimeAdapter } from './runtime-adapter.js'

/**
 * IM 消息信封——所有 IM 平台共用格式
 *
 * 字段设计说明：
 * - messageId：平台原生消息 ID（用于去重 / supersedes）
 * - id：Orca 内部 Event ID（EventBus 滑动窗口用）
 * - source：平台来源（'im.qq' | 'im.wechat' | ...）
 * - direction：'in'=收到，'out'=Orca 发出
 * - senderId：发送者在平台上的 ID
 * - conversationId：会话 ID（群 ID 或私聊会话 ID）
 * - content：消息文本内容
 * - metadata：可选元数据（附件、位置等）
 */
export interface MessageEnvelope {
  /** 平台原生消息 ID（用于跨通道去重 + supersedes） */
  messageId: string
  /** 平台来源：im.qq | im.wechat | ... */
  source: string
  /** 'in'=收到消息，'out'=Orca 主动发出 */
  direction: 'in' | 'out'
  /** 发送者在平台上的 ID */
  senderId: string
  /** 会话 ID（群 ID 或私聊会话 ID） */
  conversationId: string
  /** 消息时间戳（毫秒） */
  timestamp: number
  /** 消息文本内容 */
  content: string
  /** 可选元数据 */
  metadata?: {
    /** 是否在群聊中 @ 了 Orca */
    mentionedMe?: boolean
    /** 附件列表 */
    attachments?: Array<{ kind: string; ref: string }>
    /** 平台原始sender名称 */
    senderName?: string
    /** 是否是群聊消息 */
    isGroup?: boolean
    /** 平台原生附加数据（key-value） */
    [key: string]: unknown
  }
}

/**
 * IM Adapter 配置
 */
export interface OrcaIMConfig {
  /** 是否启用（默认 false，IM-1.0 为 Mock 模式） */
  enabled: boolean
  /** 平台来源（'im.qq' | 'im.wechat'）*/
  platform: 'im.qq' | 'im.wechat'
  /**
   * Mock 模式消息模拟间隔（毫秒）。
   * 仅 MockIMAdapter 使用；真实 adapter 由协议本身驱动。
   * 默认 5000ms。
   */
  mockIntervalMs?: number
}

/**
 * IM 平台来源（EventBus source 字段值）
 */
export const ORCA_IM_SOURCES = ['im.qq', 'im.wechat'] as const
export type OrcaIMSource = (typeof ORCA_IM_SOURCES)[number]

/**
 * IM 事件类型（EventBus type 字段值）
 */
export const ORCA_IM_EVENT_TYPES = ['im.message.received', 'im.message.sent'] as const
export type OrcaIMEventType = (typeof ORCA_IM_EVENT_TYPES)[number]

/**
 * IM Adapter 工厂函数签名
 *
 * 遵循 Phase 7.1A RuntimeAdapter 统一接口 { start(), stop() }。
 * 真实 adapter 由具体协议实现（NapCatQQ / WCF 等），本文件只定义接口。
 *
 * @param bus EventBus 实例
 * @param config IM 配置
 * @param logger 日志
 * @returns RuntimeAdapter
 */
export type IMAdapterFactory = (
  bus: { publish(event: { source: string; type: string; data: Record<string, unknown>; priority?: number }): void },
  config: OrcaIMConfig,
  logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void },
) => RuntimeAdapter
