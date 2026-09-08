/**
 * QQ NapCatQQ Adapter —— IM-1.5C Phase
 *
 * 职责：
 * - 提供 HTTP webhook endpoint，接收 NapCatQQ 的 OneBot v11 事件
 * - 将 OneBot event 转换为 MessageEnvelope
 * - 发布到 EventBus（im.message.received / im.message.sent）
 *
 * IM-1.5C 约束：
 * - 不调用 LLM
 * - 不访问 MemoryStore
 * - 不产生 Decision / Action
 * - 不调用 send API（只接收消息）
 * - 不暴露 napcat 专用字段到核心类型
 *
 * 数据流：
 *   NapCatQQ → HTTP POST → qqAdapter.handleHTTP() → MessageEnvelope → EventBus.publish()
 */

import http from 'node:http'
import type { ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { RuntimeAdapter } from '../types/runtime-adapter.js'
import type { MessageEnvelope } from '../types/im.js'

export interface QQAdapterConfig {
  httpHost: string
  httpPort: number
  accessToken?: string
  platform: string
}

// ── OneBot v11 类型 ─────────────────────────────────────────────────────

interface OneBotMessageEvent {
  post_type: 'message' | 'message_sent'
  sub_type?: string
  message_id: number
  message_seq?: number
  group_id?: number
  discuss_id?: number
  user_id: number
  message: Array<{ type: string; data: Record<string, unknown> }>
  raw_message?: string
  font?: number
  sender?: { user_id: number; nickname?: string; card?: string; role?: string }
  self_id: number
  time: number
  message_type: 'private' | 'group' | 'discuss'
}

type OneBotEvent = OneBotMessageEvent | Record<string, unknown>

// ── 辅助函数 ─────────────────────────────────────────────────────────────

function extractText(message: Array<{ type: string; data: Record<string, unknown> }>): string {
  return message
    .filter(seg => seg.type === 'text')
    .map(seg => String(seg.data['text'] ?? ''))
    .join('')
}

function isGroupEvent(event: OneBotMessageEvent): boolean {
  return event.message_type === 'group'
}

function buildConversationId(event: OneBotMessageEvent): string {
  if (event.group_id) return String(event.group_id)
  return String(event.user_id)
}

function isMessageEvent(e: OneBotEvent): e is OneBotMessageEvent {
  const postType = (e as OneBotMessageEvent).post_type
  return postType === 'message' || postType === 'message_sent'
}

// ── OneBot → MessageEnvelope ─────────────────────────────────────────────

function normalize(event: OneBotEvent, direction: 'in' | 'out', platform: string): MessageEnvelope | null {
  if (!isMessageEvent(event)) return null

  const msgEvent = event
  const dir: 'in' | 'out' = msgEvent.post_type === 'message' ? 'in' : 'out'
  const senderId = String(msgEvent.sender?.user_id ?? msgEvent.user_id ?? 0)
  const conversationId = buildConversationId(msgEvent)
  const text = extractText(msgEvent.message ?? [])

  return {
    messageId: String(msgEvent.message_id ?? `${platform}-${Date.now()}`),
    source: platform,
    direction: dir,
    senderId,
    conversationId,
    timestamp: (msgEvent.time ?? Math.floor(Date.now() / 1000)) * 1000,
    content: text,
    metadata: {
      senderName: msgEvent.sender?.nickname,
      isGroup: isGroupEvent(msgEvent),
    },
  }
}

// ── HTTP Server ─────────────────────────────────────────────────────────

export function createQQAdapter(
  handlers: {
    onEnvelope(envelope: MessageEnvelope): void
  },
  config: QQAdapterConfig,
  logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void; error(msg: string, ...args: unknown[]): void },
): RuntimeAdapter {
  let disposed = false
  let server: ReturnType<typeof http.createServer> | null = null

  function verifyToken(req: IncomingMessage): boolean {
    if (!config.accessToken) return true
    const token = req.headers['authorization'] ?? req.headers['Authorization']
    if (!token) return false
    const bearer = typeof token === 'string' && token.startsWith('Bearer ') ? token.slice(7) : token
    return bearer === config.accessToken
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (disposed) {
      res.writeHead(503)
      res.end('Adapter disposed')
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end('Method Not Allowed')
      return
    }

    if (!verifyToken(req)) {
      logger.warn('[qq-adapter] 未授权的请求')
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }

    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const raw = JSON.parse(body)
        const events: OneBotEvent[] = Array.isArray(raw) ? raw : [raw]

        for (const rawEvent of events) {
          const envelope = normalize(rawEvent, 'in', config.platform)
          if (envelope) {
            handlers.onEnvelope(envelope)
            logger.info(
              '[qq-adapter] message → source=%s senderId=%s content=%s',
              envelope.source,
              envelope.senderId,
              envelope.content.slice(0, 40),
            )
          }
        }

        res.writeHead(200)
        res.end('{"status":"ok"}')
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        logger.warn('[qq-adapter] 解析失败: %s', detail)
        res.writeHead(400)
        res.end(JSON.stringify({ status: 'failed', retcode: -1, detail }))
      }
    })

    req.on('error', err => {
      const detail = err instanceof Error ? err.message : String(err)
      logger.warn('[qq-adapter] 请求错误: %s', detail)
      try { res.writeHead(500); res.end() } catch { /* ignore */ }
    })
  }

  return {
    start(): void {
      if (disposed) return
      if (server) return

      server = http.createServer(handleRequest)

      server.on('error', err => {
        const detail = err instanceof Error ? err.message : String(err)
        logger.error('[qq-adapter] HTTP server 错误: %s', detail)
      })

      server.listen(config.httpPort, config.httpHost, () => {
        logger.info('[qq-adapter] HTTP server 启动（mode=http，listen %s:%d）', config.httpHost, config.httpPort)
      })
    },

    stop(): void {
      disposed = true
      if (server) {
        server.close()
        server = null
        logger.info('[qq-adapter] HTTP server 已关闭')
      }
    },
  }
}
