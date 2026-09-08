/**
 * Mock IM Adapter —— IM-1.0 冒烟测试用模拟实现
 *
 * IM-1.0 范围：
 * - simulateIncomingMessage()：模拟收到一条消息
 * - simulateSentMessage()：模拟 Orca 发出一条消息
 *
 * IM-1.0 禁止：
 * - 自动回复（不发任何消息到外部）
 * - LLM 介入
 * - 任何网络请求
 */

import type { MessageEnvelope, OrcaIMConfig } from '../types/im.js'
import type { RuntimeAdapter } from '../types/runtime-adapter.js'

/** Mock 消息库（用于 simulateIncomingMessage） */
const MOCK_INCOMING_MESSAGES: Array<{ senderId: string; conversationId: string; content: string; senderName: string; isGroup: boolean }> = [
  { senderId: 'alice', conversationId: 'c:private:1', content: '你好！', senderName: 'Alice', isGroup: false },
  { senderId: 'bob', conversationId: 'c:private:2', content: '在吗？', senderName: 'Bob', isGroup: false },
  { senderId: '快递员', conversationId: 'c:private:3', content: '您的快递到了', senderName: '快递员', isGroup: false },
  { senderId: 'group-chat', conversationId: 'c:group:1', content: '大家好', senderName: 'Charlie', isGroup: true },
  { senderId: 'alice', conversationId: 'c:private:1', content: '[图片]', senderName: 'Alice', isGroup: false },
]

let _msgCounter = 0
function nextMsgId(prefix: string): string {
  return `${prefix}-mock-${++_msgCounter}`
}

function mkEnvelope(
  direction: 'in' | 'out',
  opts: {
    senderId: string
    conversationId: string
    content: string
    senderName?: string
    isGroup?: boolean
    mentionedMe?: boolean
    attachments?: Array<{ kind: string; ref: string }>
  },
  platform: string,
): MessageEnvelope {
  return {
    messageId: nextMsgId(platform),
    source: platform,
    direction,
    senderId: opts.senderId,
    conversationId: opts.conversationId,
    timestamp: Date.now(),
    content: opts.content,
    metadata: {
      senderName: opts.senderName,
      isGroup: opts.isGroup,
      mentionedMe: opts.mentionedMe,
      attachments: opts.attachments,
    },
  }
}

/**
 * 创建 Mock IM Adapter（IM-1.0）
 *
 * 提供 simulateIncomingMessage() / simulateSentMessage()，用于：
 * 1. smoke test 验证事件生成
 * 2. 开发阶段隔离测试（不依赖真实协议）
 *
 * @param bus EventBus 实例（用于直接 publish 事件）
 * @param config IM 配置
 * @param logger 日志
 */
export function createMockIMAdapter(
  bus: { publish(event: { source: string; type: string; data: Record<string, unknown>; priority?: 0 | 1 | 2 | 3 }): void },
  config: OrcaIMConfig,
  logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void },
): RuntimeAdapter & {
  /** 模拟收到一条随机消息 */
  simulateIncomingMessage(): MessageEnvelope
  /** 模拟 Orca 发出一条消息 */
  simulateSentMessage(opts: { conversationId: string; content: string }): MessageEnvelope
} {
  let disposed = false
  let mockInterval: ReturnType<typeof setInterval> | null = null
  let mockIdx = 0

  const platform = config.platform ?? 'im.qq'

  function publishEnvelope(envelope: MessageEnvelope): void {
    if (disposed) return
    const eventType = envelope.direction === 'in' ? 'im.message.received' : 'im.message.sent'
    logger.info(
      '[mock-im-adapter] %s → source=%s type=%s senderId=%s content=%s',
      envelope.direction === 'in' ? 'IN ' : 'OUT',
      envelope.source,
      eventType,
      envelope.senderId,
      envelope.content.slice(0, 40),
    )
    bus.publish({
      source: envelope.source as 'im.qq' | 'im.wechat',
      type: eventType as 'im.message.received' | 'im.message.sent',
      data: { envelope },
      priority: envelope.direction === 'in' ? 1 : 1,
    })
  }

  function tick(): void {
    if (disposed) return
    const msgIdx = mockIdx % MOCK_INCOMING_MESSAGES.length
    mockIdx++
    const envelope = mkEnvelope('in', MOCK_INCOMING_MESSAGES[msgIdx]!, platform)
    publishEnvelope(envelope)
  }

  return {
    start(): void {
      if (disposed) return
      const intervalMs = config.mockIntervalMs ?? 5_000
      logger.info('[mock-im-adapter] 启动（mock 模式，intervalMs=%d）', intervalMs)
      mockInterval = setInterval(tick, intervalMs)
    },

    stop(): void {
      disposed = true
      if (mockInterval) {
        clearInterval(mockInterval)
        mockInterval = null
      }
      logger.info('[mock-im-adapter] 已停止')
    },

    simulateIncomingMessage(): MessageEnvelope {
      if (disposed) throw new Error('Adapter 已停止')
      const msgIdx = mockIdx % MOCK_INCOMING_MESSAGES.length
      mockIdx++
      const envelope = mkEnvelope('in', MOCK_INCOMING_MESSAGES[msgIdx]!, platform)
      publishEnvelope(envelope)
      return envelope
    },

    simulateSentMessage(opts: { conversationId: string; content: string }): MessageEnvelope {
      if (disposed) throw new Error('Adapter 已停止')
      const envelope = mkEnvelope(
        'out',
        {
          senderId: 'orca-self',
          conversationId: opts.conversationId,
          content: opts.content,
          senderName: 'Orca',
          isGroup: false,
        },
        platform,
      )
      publishEnvelope(envelope)
      return envelope
    },
  }
}
