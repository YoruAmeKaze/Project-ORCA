/**
 * IM Observation Adapter —— 通信行为信号生成器（IM-1.5A Phase）
 *
 * 职责：
 * - 订阅 EventBus im.message.received / im.message.sent
 * - 生成 CommunicationSignal（不含 message content）
 * - 检测 im.burst（同一 sender 在 burstWindowMs 内发 ≥3 条）
 *
 * IM-1.5A 约束：
 * - 不调用 LLM 服务
 * - 不调用 Memory 存储层
 * - 不调用 Attention / Decision 引擎
 * - 不产生 Action
 */

import type { OrcaEvent } from '../types/event.js'
import type { MessageEnvelope } from '../types/im.js'
import type { IMObservationConfig, CommunicationSignal } from '../types/communication.js'

/**
 * 从 OrcaEvent 提取 MessageEnvelope
 */
function extractEnvelope(event: OrcaEvent): MessageEnvelope | null {
  const data = event.data as { envelope?: MessageEnvelope } | undefined
  return data?.envelope ?? null
}

function extractPlatform(source: string): 'qq' | 'wechat' {
  if (source === 'im.wechat') return 'wechat'
  return 'qq'
}

/**
 * 创建 IM Observation Adapter
 *
 * @param handlers 信号处理器
 * @param config 配置
 * @param logger 日志
 */
export function createIMObservationAdapter(
  handlers: {
    onSignal(signal: CommunicationSignal): void
  },
  config: IMObservationConfig,
  logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void },
) {
  // burst 追踪表：key = `${senderId}:${conversationId}`
  const burstTrackers = new Map<string, {
    senderId: string
    conversationId: string
    timestamps: number[]
    eventIds: string[]
    platform: 'qq' | 'wechat'
  }>()

  const burstWindowMs = config.burstWindowMs ?? 60 * 60 * 1000
  const burstMinCount = config.burstMinCount ?? 3

  function detectBurst(event: OrcaEvent, envelope: MessageEnvelope, key: string): void {
    if (envelope.metadata?.isGroup) return

    const now = envelope.timestamp
    let tracker = burstTrackers.get(key)
    if (!tracker) {
      tracker = { senderId: envelope.senderId, conversationId: envelope.conversationId, timestamps: [], eventIds: [], platform: extractPlatform(envelope.source) }
      burstTrackers.set(key, tracker)
    }

    tracker.timestamps.push(now)
    tracker.eventIds.push(event.id)

    const windowStart = now - burstWindowMs
    while (tracker.timestamps.length > 0 && tracker.timestamps[0]! < windowStart) {
      tracker.timestamps.shift()
      tracker.eventIds.shift()
    }

    if (tracker.timestamps.length >= burstMinCount) {
      const firstTs = tracker.timestamps[0]!
      const lastTs = tracker.timestamps[tracker.timestamps.length - 1]!
      const durationMs = lastTs - firstTs

      const burstSignal: CommunicationSignal = {
        signalType: 'burst.detected',
        timestamp: now,
        eventId: event.id,
        sourcePlatform: tracker.platform,
        senderId: tracker.senderId,
        conversationId: tracker.conversationId,
        isGroup: false,
        burstDetail: {
          messageCount: tracker.timestamps.length,
          durationMs,
          firstEventId: tracker.eventIds[0]!,
          lastEventId: event.id,
        },
      }

      handlers.onSignal(burstSignal)
      tracker.timestamps = []
      tracker.eventIds = []
      logger.info('[im-observation] burst.detected sender=%s count=%d durationMs=%d', tracker.senderId, burstSignal.burstDetail!.messageCount, durationMs)
    }
  }

  function handleEvent(event: OrcaEvent): void {
    const envelope = extractEnvelope(event)
    if (!envelope) return

    const key = `${envelope.senderId}:${envelope.conversationId}`
    const signalType = envelope.direction === 'in' ? 'message.received' : 'message.sent'

    handlers.onSignal({
      signalType,
      timestamp: envelope.timestamp,
      eventId: event.id,
      sourcePlatform: extractPlatform(envelope.source),
      senderId: envelope.senderId,
      conversationId: envelope.conversationId,
      isGroup: envelope.metadata?.isGroup ?? false,
    })

    if (envelope.direction === 'in') {
      detectBurst(event, envelope, key)
    }
  }

  function dispose(): void {
    burstTrackers.clear()
    logger.info('[im-observation] disposed')
  }

  return { handleEvent, dispose }
}
