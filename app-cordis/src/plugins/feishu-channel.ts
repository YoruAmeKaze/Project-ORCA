import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'

/** 飞书消息到达事件（agent 插件订阅） */
export interface FeishuMessageEvent {
  eventId: string
  sessionId: string
  openId: string
  messageId: string
  text: string
}

/** 飞书图片消息事件（food-image 插件订阅，D-AGENT-13 通道①） */
export interface FeishuImageEvent {
  eventId: string
  sessionId: string
  openId: string
  messageId: string
  imageKey: string
}

interface FeishuPayload {
  type?: string
  challenge?: string
  header?: { event_type?: string; event_id?: string }
  event?: {
    sender?: { sender_id?: { open_id?: string } }
    message?: {
      message_id?: string
      message_type?: string
      chat_type?: string
      content?: string
    }
  }
}

/**
 * 飞书 webhook 通道插件（纯 Cordis 自写，对应 Python 版 router/feishu.py）。
 * 职责：challenge 验证、event_id 60s 去重、仅 p2p（text 与 image）、fire-and-forget 立即回 200。
 * image 消息 → 派发 'feishu/image' 事件（D-AGENT-13 通道①：手机快捷指令发图到飞书）。
 */
export function feishuChannel(ctx: Context, config: OrcaConfig) {
  const recentEvents = new Map<string, number>()

  const isDuplicate = (id: string): boolean => {
    const now = Date.now()
    for (const [key, ts] of recentEvents) {
      if (now - ts > 60_000) recentEvents.delete(key)
    }
    if (recentEvents.has(id)) return true
    recentEvents.set(id, now)
    return false
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      ctx.logger.warn('webhook error: %s', err instanceof Error ? err.message : String(err))
      sendJson(res, 500, { ok: false })
    })
  })

  // 端口被占用等启动错误：记录清晰日志而非裸崩溃
  server.on('error', (err: Error) => {
    ctx.logger.error('HTTP server 错误: %s', err.message)
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true })
    }
    if (req.method !== 'POST' || url.pathname !== '/feishu/webhook') {
      return sendJson(res, 404, { ok: false, error: 'not found' })
    }

    const body = await readBody(req)
    let payload: FeishuPayload
    try {
      payload = JSON.parse(body) as FeishuPayload
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid json' })
    }

    // 飞书事件订阅 URL 验证
    if (payload.type === 'url_verification') {
      return sendJson(res, 200, { challenge: payload.challenge ?? '' })
    }

    if (payload.header?.event_type !== 'im.message.receive_v1') {
      return sendJson(res, 200, { ok: true })
    }

    const eventId = payload.header.event_id ?? ''
    if (isDuplicate(eventId)) {
      return sendJson(res, 200, { ok: true, skipped: 'duplicate' })
    }

    const sender = payload.event?.sender
    const message = payload.event?.message
    if (!message || message.chat_type !== 'p2p') {
      return sendJson(res, 200, { ok: true, skipped: 'not-p2p' })
    }

    const openId = sender?.sender_id?.open_id ?? ''
    const base = { eventId, sessionId: openId, openId, messageId: message.message_id ?? '' }

    // 文本消息 → feishu/message（主 agent 走 R0 查档 + LLM 回复）
    if (message.message_type === 'text') {
      let text = ''
      try {
        text = (JSON.parse(message.content ?? '{}') as { text?: string }).text ?? ''
      } catch {
        // 保留空文本
      }
      if (!text.trim()) {
        return sendJson(res, 200, { ok: true, skipped: 'empty-text' })
      }
      sendJson(res, 200, { ok: true })
      ctx.emit('feishu/message', { ...base, text: text.trim() } satisfies FeishuMessageEvent)
      return
    }

    // 图片消息 → feishu/image（food 识别闭环）
    if (message.message_type === 'image') {
      let imageKey = ''
      try {
        imageKey = (JSON.parse(message.content ?? '{}') as { image_key?: string }).image_key ?? ''
      } catch {
        // 保留空 key
      }
      if (!imageKey) {
        return sendJson(res, 200, { ok: true, skipped: 'empty-image-key' })
      }
      sendJson(res, 200, { ok: true })
      ctx.emit('feishu/image', { ...base, imageKey } satisfies FeishuImageEvent)
      return
    }

    // 其他消息类型暂不处理
    return sendJson(res, 200, { ok: true, skipped: 'unsupported-type' })
  }

  server.listen(config.port, config.host, () => {
    ctx.logger.info('feishu channel listening on http://%s:%d', config.host, config.port)
  })

  return () => {
    server.close()
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString()
      if (data.length > 1_000_000) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolveBody(data))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}
