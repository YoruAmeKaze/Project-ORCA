import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { InfoRecord, Urgency } from '../agents/types.js'

export interface ReceiverOptions {
  port: number
  host: string
  /** token → 允许写入的 namespaces 白名单（D-AGENT-12：每 App 独立 Bearer token + namespace 白名单） */
  tokens: Record<string, string[]>
}

interface RecordPayload {
  namespace?: unknown
  type?: unknown
  source?: unknown
  ts?: unknown
  confidence?: unknown
  urgency?: unknown
  payload?: unknown
  ttlDays?: unknown
  supersedes?: unknown
  id?: unknown
}

/**
 * 外部 App Push 通道处理器（§7/§13）：POST /info/records（Bearer 鉴权）写档案。
 * 食物识别 App / 其他 InfoAgent 软件无需内嵌 Cordis，只要"上报通道 + 鉴权密钥"即可汇入 Orca 档案室。
 */
export function createReceiverHandler(opts: ReceiverOptions, onRecord: (record: InfoRecord) => void) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true })
    }
    if (req.method !== 'POST' || url.pathname !== '/info/records') {
      return sendJson(res, 404, { ok: false, error: 'not found' })
    }

    // Bearer 鉴权
    const auth = req.headers.authorization ?? ''
    const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]
    if (!token || !(token in opts.tokens)) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' })
    }

    const body = await readBody(req)
    let raw: RecordPayload
    try {
      raw = JSON.parse(body) as RecordPayload
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid json' })
    }

    // 信封校验（D-AGENT-09：namespace/type/source 必填）
    const namespace = typeof raw.namespace === 'string' ? raw.namespace : ''
    const type = typeof raw.type === 'string' ? raw.type : ''
    const source = typeof raw.source === 'string' ? raw.source : ''
    if (!namespace || !type || !source) {
      return sendJson(res, 400, { ok: false, error: '缺少信封字段 namespace/type/source' })
    }
    const allowed = opts.tokens[token] ?? []
    if (!allowed.includes(namespace)) {
      return sendJson(res, 403, { ok: false, error: `namespace 不在该 token 白名单: ${namespace}` })
    }
    const urgency = raw.urgency === undefined ? 0 : Number(raw.urgency)
    if (![0, 1, 2].includes(urgency)) {
      return sendJson(res, 400, { ok: false, error: 'urgency 必须为 0/1/2' })
    }

    const record: InfoRecord = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
      namespace,
      type,
      ts: typeof raw.ts === 'number' ? raw.ts : Date.now(),
      source,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
      urgency: urgency as Urgency,
      payload: raw.payload ?? {},
      ttlDays: typeof raw.ttlDays === 'number' ? raw.ttlDays : undefined,
      supersedes: typeof raw.supersedes === 'string' ? raw.supersedes : undefined,
    }

    onRecord(record)
    return sendJson(res, 201, { ok: true, id: record.id })
  }
}

/**
 * 外部 Push 通道插件：独立 HTTP 服务（默认 8101，INFO_RECEIVER_PORT 可改）。
 * 未配置 INFO_RECEIVER_TOKENS 时不启动（推送通道是可选项）。
 */
export function infoReceiver(ctx: Context, config: OrcaConfig) {
  const { tokens, port } = config.infoReceiver
  if (!Object.keys(tokens).length) {
    ctx.logger.info('[info-receiver] 未配置 INFO_RECEIVER_TOKENS，外部 Push 通道未启用（留空即关闭）')
    return
  }
  const server = createServer((req, res) => {
    void createReceiverHandler({ port, host: config.host, tokens }, (record) => {
      ctx.emit('info/record', record)
    })(req, res).catch((err: unknown) => {
      ctx.logger.warn('info-receiver error: %s', err instanceof Error ? err.message : String(err))
      sendJson(res, 500, { ok: false })
    })
  })

  server.on('error', (err: Error) => {
    ctx.logger.error('info-receiver HTTP server 错误: %s', err.message)
  })

  server.listen(port, config.host, () => {
    ctx.logger.info('info-receiver listening on http://%s:%d（POST /info/records）', config.host, port)
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
