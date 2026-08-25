import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { InfoRecord, Urgency } from '../agents/types.js'
import type { VisionClient } from '../services/vision.js'
import type { JsonlInfoRecordStore } from '../agents/store.js'
import { processFoodImage, type FoodImageDeps } from './food-image.js'

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
 * 直连图片上传通道（D-AGENT-16 草案，2026-08-25 用户要求先实现试用）：POST /info/images（Bearer 鉴权）。
 * 手机快捷指令（Base64 编码 → 获取 URL 内容 POST）跳过飞书直连 Orca → food 管线识别 → 写 food-log 档案 → 同步返回结果。
 * token 白名单须含 food-agent（图片识别管线当前唯一绑定）。
 */
const MAX_IMAGE_BODY = 16_000_000 // base64 图片上限 ~12MB 原图

export interface ImageUploadDeps {
  store: JsonlInfoRecordStore
  vision: VisionClient
  logger: FoodImageDeps['logger']
  imagesDir: string
}

interface ImageUploadPayload {
  imageBase64?: unknown
  imageUrl?: unknown
  note?: unknown
}

export function createImageUploadHandler(opts: ReceiverOptions, deps: ImageUploadDeps) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true })
    }
    if (req.method !== 'POST' || url.pathname !== '/info/images') {
      return sendJson(res, 404, { ok: false, error: 'not found' })
    }

    // Bearer 鉴权
    const auth = req.headers.authorization ?? ''
    const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]
    if (!token || !(token in opts.tokens)) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' })
    }
    const allowed = opts.tokens[token] ?? []
    if (!allowed.includes('food-agent')) {
      return sendJson(res, 403, { ok: false, error: 'token 未授权 food-agent' })
    }

    const body = await readBody(req, MAX_IMAGE_BODY)
    let raw: ImageUploadPayload
    try {
      raw = JSON.parse(body) as ImageUploadPayload
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid json' })
    }

    let buf: Buffer
    if (typeof raw.imageBase64 === 'string' && raw.imageBase64) {
      // Buffer.from(base64) 对非法字符静默忽略，需往返校验（re-encode 比对）
      try {
        const clean = raw.imageBase64.replace(/\s+/g, '')
        buf = Buffer.from(clean, 'base64')
        if (!buf.length) throw new Error('empty')
        const reEncoded = buf.toString('base64').replace(/=+$/g, '')
        if (reEncoded !== clean.replace(/=+$/g, '')) throw new Error('roundtrip mismatch')
      } catch {
        return sendJson(res, 400, { ok: false, error: 'imageBase64 无效' })
      }
    } else if (typeof raw.imageUrl === 'string' && raw.imageUrl) {
      try {
        const remote = await fetch(raw.imageUrl, { signal: AbortSignal.timeout(15_000) })
        if (!remote.ok) return sendJson(res, 502, { ok: false, error: `imageUrl 拉取失败 http ${remote.status}` })
        buf = Buffer.from(await remote.arrayBuffer())
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: `imageUrl 拉取失败: ${err instanceof Error ? err.message : String(err)}` })
      }
    } else {
      return sendJson(res, 400, { ok: false, error: '需要 imageBase64 或 imageUrl' })
    }

    try {
      const out = await processFoodImage(buf, { store: deps.store, vision: deps.vision, logger: deps.logger, imagesDir: deps.imagesDir })
      deps.logger.info('[info-images] 识别: %s ≈ %dkcal（record=%s）', out.food, out.kcal, out.recordId ?? '-')
      return sendJson(res, 200, {
        ok: true,
        food: out.food,
        kcal: out.kcal,
        confidence: out.confidence ?? null,
        recordId: out.recordId ?? null,
        reply: out.reply,
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      deps.logger.warn('[info-images] 识别失败: %s', detail)
      return sendJson(res, 500, { ok: false, error: detail.slice(0, 200) })
    }
  }
}

/**
 * 外部 Push 通道插件：独立 HTTP 服务（默认 8101，INFO_RECEIVER_PORT 可改）。
 * 路由：POST /info/records（结构化记录）/ POST /info/images（直连图片上传）。
 * 未配置 INFO_RECEIVER_TOKENS 时不启动（推送通道是可选项）。
 */
export function infoReceiver(ctx: Context, config: OrcaConfig) {
  const { tokens, port } = config.infoReceiver
  if (!Object.keys(tokens).length) {
    ctx.logger.info('[info-receiver] 未配置 INFO_RECEIVER_TOKENS，外部 Push 通道未启用（留空即关闭）')
    return
  }
  const recordsHandler = createReceiverHandler({ port, host: config.host, tokens }, (record) => {
    ctx.emit('info/record', record)
  })
  const imageHandler = createImageUploadHandler({ port, host: config.host, tokens }, {
    store: ctx.infoStore,
    vision: ctx.vision,
    logger: ctx.logger,
    imagesDir: config.imagesDir,
  })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const handler = url.pathname === '/info/images' ? imageHandler : recordsHandler
    void handler(req, res).catch((err: unknown) => {
      ctx.logger.warn('info-receiver error: %s', err instanceof Error ? err.message : String(err))
      sendJson(res, 500, { ok: false })
    })
  })

  server.on('error', (err: Error) => {
    ctx.logger.error('info-receiver HTTP server 错误: %s', err.message)
  })

  server.listen(port, config.host, () => {
    ctx.logger.info('info-receiver listening on http://%s:%d（POST /info/records、POST /info/images）', config.host, port)
  })

  return () => {
    server.close()
  }
}

infoReceiver.inject = ['infoStore', 'vision']

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString()
      if (data.length > limit) {
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
