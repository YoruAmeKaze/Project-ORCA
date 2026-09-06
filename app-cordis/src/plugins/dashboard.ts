import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'

/** Dashboard HTTP server port (default 8200，可通过 DASHBOARD_PORT 环境变量覆盖) */
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT ?? 8200)

/**
 * Orca 仪表盘插件：
 * - 启动独立 HTTP 服务器（端口 8200），随 Orca 一起运行
 * - 追踪飞书事件到达时间（最近文本/图片）
 * - 追踪 InfoAgents 注册状态
 * - 提供 /dashboard 页面（HTML，带自动刷新）和 /api/status JSON 接口
 * - 检测 Orca 主服务 (8100) 和 Info-Receiver (8101) 端口可达性
 *
 * 访问：http://localhost:8200/dashboard
 */
export function dashboard(ctx: Context, config: OrcaConfig) {
  const state = {
    feishu: { lastMessageAt: null as number | null, lastImageAt: null as number | null },
    orcaPort: config.port,
    receiverPort: config.infoReceiver.port,
  }

  ctx.on('feishu/message', () => { state.feishu.lastMessageAt = Date.now() })
  ctx.on('feishu/image', () => { state.feishu.lastImageAt = Date.now() })

  function getInfoAgents(): { name: string; description: string; modes: string[] }[] {
    const registry = ctx.get('infoAgents')
    if (!registry) return []
    return registry.metas().map((m: { name: string; description: string; modes?: string[] }) => ({
      name: m.name,
      description: m.description ?? '',
      modes: m.modes ?? ['pull'],
    }))
  }

  function probePort(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ port, host, timeout: 100 })
      socket.on('connect', () => { socket.destroy(); resolve(true) })
      socket.on('timeout', () => { socket.destroy(); resolve(false) })
      socket.on('error', () => { resolve(false) })
      setTimeout(() => resolve(false), 100)
    })
  }

  function relTime(ts: number | null): string {
    if (ts === null) return '—'
    const diff = Date.now() - ts
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    return `${Math.floor(diff / 3_600_000)}h ago`
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${DASHBOARD_PORT}`)
    if (url.pathname === '/api/status') {
      void handleStatus(req, res)
    } else if (url.pathname === '/api/events') {
      void handleEvents(req, res)
    } else if (url.pathname === '/api/world-state') {
      void handleWorldState(req, res)
    } else if (url.pathname === '/api/attention') {
      void handleAttention(req, res)
    } else if (url.pathname === '/debug/publish-event' && req.method === 'POST') {
      void handleDebugPublishEvent(req, res)
    } else if (url.pathname === '/api/memory') {
      void handleMemory(req, res)
    } else if (url.pathname === '/api/chat' && req.method === 'POST') {
      void handleChat(req, res)
    } else if (url.pathname === '/api/stream' && req.method === 'GET') {
      void handleStream(req, res)
    } else if (url.pathname === '/dashboard' || url.pathname === '/') {
      void handleDashboard(req, res)
    } else {
      sendJson(res, 404, { ok: false, error: 'not found' })
    }
  })

  server.on('error', (err: Error) => {
    ctx.logger.error('[dashboard] HTTP server 错误: %s', err.message)
  })

  async function handleStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [orcaOk, receiverOk] = await Promise.all([probePort(state.orcaPort), probePort(state.receiverPort)])
    const agents = getInfoAgents()
    sendJson(res, 200, {
      ok: true, ts: Date.now(),
      services: { orca: { port: state.orcaPort, reachable: orcaOk }, infoReceiver: { port: state.receiverPort, reachable: receiverOk } },
      feishu: { lastMessageAt: state.feishu.lastMessageAt, lastImageAt: state.feishu.lastImageAt, lastMessageRel: relTime(state.feishu.lastMessageAt), lastImageRel: relTime(state.feishu.lastImageAt) },
      infoAgents: agents,
    })
  }

  /**
   * Orca Runtime EventStream 端点（Phase 0+1）：
   * - 返回 EventBus 滑动窗口中最近的 OrcaEvent 列表
   * - query 参数：?limit=N（默认 50，上限 500）&source=feishu（可选过滤）
   * - EventBus 未注入时返回 503
   */
  async function handleEvents(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bus = ctx.get('eventBus') as
      | { recent(n: number, filter?: { source?: string }): unknown[]; size(): number }
      | undefined
    if (!bus) {
      sendJson(res, 503, { ok: false, error: 'EventBus 未启用（设置 ORCA_RUNTIME_ENABLED=1 启用 Persistent Context Runtime）' })
      return
    }
    const url2 = new URL(_req.url ?? '/', `http://localhost:${DASHBOARD_PORT}`)
    const limit = Math.min(Math.max(Number(url2.searchParams.get('limit') ?? 50), 1), 500)
    const source = url2.searchParams.get('source')
    const filter = source ? { source } : undefined
    const events = bus.recent(limit, filter)
    sendJson(res, 200, {
      ok: true,
      ts: Date.now(),
      count: events.length,
      bufferSize: bus.size(),
      events,
    })
  }

  /**
   * Orca Runtime WorldState 端点（Phase 2.A）：
   * - 返回当前 WorldState 快照（WorldStateUpdater 提供 getState()）
   * - WorldState 未注入时返回 503（Orca Runtime 未启用 / WorldState 单独关闭）
   */
  async function handleWorldState(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ws = ctx.get('worldState') as
      | { getState(): unknown }
      | undefined
    if (!ws) {
      sendJson(res, 503, { ok: false, error: 'WorldState 未启用（设置 ORCA_RUNTIME_ENABLED=1 启用 Persistent Context Runtime，且 ORCA_WORLD_STATE_ENABLED 不为 0）' })
      return
    }
    const state = ws.getState()
    sendJson(res, 200, {
      ok: true,
      ts: Date.now(),
      state,
    })
  }

  /**
   * Phase 3：Attention Engine 状态端点
   * - GET /api/attention → 200 {ok, ts, ruleCount}（当前注册规则数）
   * - POST /api/attention/evaluate  Body: {event?, state?} → 200 {items}
   *   - 手动触发一次评估（用于测试 attention 规则）
   * - Attention 未注入返回 503
   */
  async function handleAttention(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const att = ctx.get('attention') as
      | { ruleCount(): number; evaluate(input: unknown): unknown[] }
      | undefined
    if (!att) {
      sendJson(res, 503, { ok: false, error: 'Attention Engine 未启用（设置 ORCA_RUNTIME_ENABLED=1 启用 Persistent Context Runtime，且 ORCA_ATTENTION_ENABLED 不为 0）' })
      return
    }

    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        ts: Date.now(),
        ruleCount: att.ruleCount(),
      })
      return
    }

    if (req.method === 'POST' && req.url?.endsWith('/evaluate')) {
      const ws = ctx.get('worldState') as { getState(): unknown } | undefined
      if (!ws) {
        sendJson(res, 503, { ok: false, error: 'WorldState 未启用（evaluate 需要 worldState）' })
        return
      }
      // 读取 body
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 8192) {
          sendJson(res, 413, { ok: false, error: 'body too large（>8KB）' })
          req.destroy()
          return
        }
        chunks.push(chunk as Buffer)
      }
      const body = Buffer.concat(chunks).toString('utf8')
      let payload: { event?: unknown; state?: unknown }
      try { payload = JSON.parse(body) } catch { sendJson(res, 400, { ok: false, error: 'invalid json' }); return }

      // 类型守卫：简单判断 event/state 形态（dashboard 仅做最浅校验，不做 schema 验证）
      const stateObj = (payload.state && typeof payload.state === 'object' && payload.state !== null)
        ? payload.state as Record<string, unknown>
        : ws.getState() as Record<string, unknown>
      const eventObj = (payload.event && typeof payload.event === 'object' && payload.event !== null)
        ? payload.event as Record<string, unknown>
        : null

      const items = att.evaluate({
        event: eventObj as never,  // AttentionEngine.evaluate 内部会 narrow；dashboard 仅做转发
        state: stateObj as never,
        prevState: undefined,
      })
      sendJson(res, 200, {
        ok: true,
        ts: Date.now(),
        count: items.length,
        items,
      })
      return
    }

    sendJson(res, 405, { ok: false, error: 'method not allowed' })
  }

  /**
   * Memory Ocean 统计端点：
   * - 查询 infoStore 各 namespace 的记录数与最新时间戳
   * - namespace 映射为 4 个语义层：Projects / Preferences / Knowledge / Experiences
   * - infoStore 未注入时返回 503
   */
  async function handleMemory(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const store = ctx.get('infoStore') as
      | { query(opts: { namespaces?: string[]; limit?: number }): Promise<unknown[]>; namespaces?: () => string[] }
      | undefined
    if (!store) {
      sendJson(res, 503, { ok: false, error: 'infoStore 未启用' })
      return
    }

    // 语义 namespace → 展示层映射
    const LAYER_MAP: Record<string, string> = {
      'food-agent': 'Projects',
      'preferences': 'Preferences',
      'knowledge': 'Knowledge',
      'experiences': 'Experiences',
      'memory': 'Experiences',
    }

    const layerCounts: { Projects: { count: number; latestTs: number | null }; Preferences: { count: number; latestTs: number | null }; Knowledge: { count: number; latestTs: number | null }; Experiences: { count: number; latestTs: number | null } } = {
      Projects: { count: 0, latestTs: null },
      Preferences: { count: 0, latestTs: null },
      Knowledge: { count: 0, latestTs: null },
      Experiences: { count: 0, latestTs: null },
    }

    try {
      // 查询所有 namespace（取最新 1 条记录判断是否存在）
      const nsList = (store as { namespaces?: () => string[] }).namespaces?.() ?? []
      const allNamespaces = nsList.length ? nsList : ['food-agent', 'preferences', 'knowledge', 'experiences', 'memory']

      for (const ns of allNamespaces) {
        const records = await store.query({ namespaces: [ns], limit: 200 }) as Array<{ ts?: number }>
        const layer = LAYER_MAP[ns] ?? null
        if (records.length > 0) {
          const latestTs = Math.max(...records.map((r) => r.ts ?? 0))
          if (layer) {
            const target = layerCounts[layer as keyof typeof layerCounts]
            if (target) {
              target.count += records.length
              if (!target.latestTs || latestTs > target.latestTs) {
                target.latestTs = latestTs
              }
            }
          }
        }
      }

      sendJson(res, 200, {
        ok: true,
        ts: Date.now(),
        layers: [
          { key: 'Projects', label: 'Projects', count: layerCounts.Projects.count, latestTs: layerCounts.Projects.latestTs },
          { key: 'Preferences', label: 'Preferences', count: layerCounts.Preferences.count, latestTs: layerCounts.Preferences.latestTs },
          { key: 'Knowledge', label: 'Knowledge', count: layerCounts.Knowledge.count, latestTs: layerCounts.Knowledge.latestTs },
          { key: 'Experiences', label: 'Experiences', count: layerCounts.Experiences.count, latestTs: layerCounts.Experiences.latestTs },
        ],
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) })
    }
  }

  /**
   * 命令发送端点：POST /api/chat
   * Body: { text: string }
   * 行为：发射 dashboard/message 事件，由 agent 订阅处理后通过 eventBus 推送回复。
   * 前端通过 SSE /api/stream 接收 orca/dashboard-reply 事件。
   */
  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }

    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 4096) { sendJson(res, 413, { ok: false, error: 'body too large' }); req.destroy(); return }
      chunks.push(chunk as Buffer)
    }
    let body: { text?: unknown; id?: unknown }
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { sendJson(res, 400, { ok: false, error: 'invalid json' }); return }

    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) { sendJson(res, 400, { ok: false, error: 'text is required' }); return }

    const id = typeof body.id === 'string' ? body.id : `msg-${Date.now()}`

    // 发射 dashboard/message 事件，agent 订阅处理
    ctx.emit('dashboard/message', { text, id })
    ctx.logger.info('[dashboard-chat] 收到消息: %s', text.slice(0, 60))

    sendJson(res, 202, { ok: true, id, status: 'processing' })
  }

  /**
   * SSE 实时事件流：GET /api/stream
   * 前端 EventSource 连接此端点，接收 Orca 内部事件推送。
   * 用于：命令回复实时显示、事件监听。
   * eventBus 未注入时返回 503。
   */
  async function handleStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bus = ctx.get('eventBus') as
      | { subscribe(filter: Record<string, unknown>, handler: (event: unknown) => void): () => void; size(): number }
      | undefined
    if (!bus) {
      sendJson(res, 503, { ok: false, error: 'EventBus 未启用' })
      return
    }

    // CORS + SSE 头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // 每秒 keepalive ping
    const pingInterval = setInterval(() => {
      res.write(': ping\n\n')
    }, 15_000)

    // 订阅 orca 内部事件（source=orca 的事件，包括 dashboard-reply）
    const unsubscribe = bus.subscribe({ minPriority: 1 }, (event: unknown) => {
      const ev = event as { source?: string; type?: string; data?: Record<string, unknown> }
      if (ev.source === 'orca') {
        res.write(`event: orca\ndata: ${JSON.stringify(ev)}\n\n`)
      }
    })

    // 客户端断开时清理
    req.on('close', () => {
      clearInterval(pingInterval)
      unsubscribe()
    })
  }

  /**
   * 调试端点（Phase 2.D）：POST /debug/publish-event
   * Body: { source, type, data?, priority? }
   * 仅本地开发用：直接调用 ctx.eventBus.publish()，便于手动验证 reducer 链路。
   * 生产环境应在反向代理（Nginx / Caddy）层禁用此端点。
   */
  async function handleDebugPublishEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bus = ctx.get('eventBus') as
      | { publish: (input: { source: string; type: string; data?: Record<string, unknown>; priority?: number }) => void }
      | undefined
    if (!bus) {
      sendJson(res, 503, { ok: false, error: 'EventBus 未启用（设置 ORCA_RUNTIME_ENABLED=1 启用 Persistent Context Runtime）' })
      return
    }
    // 读取 body（限制 8KB；调试用不需要大 payload）
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 8192) {
        sendJson(res, 413, { ok: false, error: 'body too large（>8KB）' })
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    let payload: { source?: unknown; type?: unknown; data?: unknown; priority?: unknown }
    try {
      payload = JSON.parse(body) as typeof payload
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid json' })
      return
    }
    if (typeof payload.source !== 'string' || typeof payload.type !== 'string') {
      sendJson(res, 400, { ok: false, error: '需要 source + type（string）' })
      return
    }
    bus.publish({
      source: payload.source,
      type: payload.type,
      data: (typeof payload.data === 'object' && payload.data !== null) ? payload.data as Record<string, unknown> : {},
      priority: typeof payload.priority === 'number' ? payload.priority : undefined,
    })
    sendJson(res, 200, {
      ok: true,
      ts: Date.now(),
      published: { source: payload.source, type: payload.type },
    })
  }

  async function handleDashboard(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [orcaOk, receiverOk] = await Promise.all([probePort(state.orcaPort), probePort(state.receiverPort)])
    const agents = getInfoAgents()

    const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Orca — Personal Intelligence System</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Mono:wght@400&display=swap" rel="stylesheet">
<style>
:root {
  --ff: 'Inter', -apple-system, sans-serif;
  --mono: 'Space Mono', monospace;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--ff);
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}

/* ---- Grain texture ---- */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  opacity: 0.03;
  pointer-events: none;
  z-index: 1;
}

/* ---- Ambient light beam (Raycast-style diagonal energy) ---- */
.ambient {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
}

.ambient::before {
  content: '';
  position: absolute;
  top: -50%;
  left: 50%;
  transform: translateX(-50%);
  width: 160vw;
  height: 160vh;
  background: conic-gradient(
    from 200deg at 55% 40%,
    transparent 0deg,
    rgba(125, 211, 252, 0.035) 55deg,
    rgba(99, 179, 237, 0.06) 90deg,
    rgba(167, 139, 250, 0.04) 130deg,
    transparent 170deg
  );
  animation: ambientShift 25s ease-in-out infinite alternate;
}

.ambient::after {
  content: '';
  position: absolute;
  bottom: -30%;
  right: -15%;
  width: 70vw;
  height: 70vh;
  background: radial-gradient(ellipse at 85% 85%, rgba(34, 211, 238, 0.035) 0%, rgba(99, 179, 237, 0.02) 40%, transparent 65%);
}

@keyframes ambientShift {
  0%   { transform: translateX(-50%) rotate(0deg) scale(1); opacity: 1; }
  100% { transform: translateX(-50%) rotate(5deg) scale(1.05); opacity: 0.6; }
}

/* ---- Scan line overlay (TE-inspired) ---- */
.scanlines {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0,0,0,0.03) 2px,
    rgba(0,0,0,0.03) 4px
  );
}

/* ===================== THEMES ===================== */
/* Theme picker — floating top-right, outside snap stacking context */
.tpicker {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0;
}

.tbtn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(0,0,0,0.6);
  border: 1px solid rgba(255,255,255,0.1);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  color: var(--muted);
  transition: all 0.25s ease;
  box-shadow: 0 2px 20px rgba(0,0,0,0.5);
}

.tbtn:hover {
  border-color: rgba(255,255,255,0.22);
  color: var(--text);
  transform: scale(1.1);
}

.tmenu {
  position: absolute;
  top: 50px;
  right: 0;
  background: rgba(0,0,0,0.9);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px;
  padding: 8px;
  min-width: 160px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.7);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-8px) scale(0.96);
  transition: all 0.2s ease;
}

.tmenu.open {
  opacity: 1;
  pointer-events: all;
  transform: translateY(0) scale(1);
}

.titem {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
  transition: all 0.15s ease;
  white-space: nowrap;
}

.titem:hover { background: rgba(255,255,255,0.05); color: var(--text); }
.titem.active { color: var(--text); }

.tdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* ---- Theme: Orca Prime (dark neon sci-fi) ---- */
body[data-theme="orca-prime"],
body:not([data-theme]) {
  --bg: #0b0f1a;
  --text: #e8eeff;
  --muted: #8899bb;
  --dim: #3d4f6a;
  --accent: #7dd3fc;
  --cyan: #22d3ee;
  --green: #4ade80;
  --amber: #f59e0b;
}

/* ---- Theme: Void (pure black, clinical) ---- */
body[data-theme="void"] {
  --bg: #000000;
  --text: #f0f0f0;
  --muted: #555555;
  --dim: #2a2a2a;
  --accent: #ffffff;
  --cyan: #c0c0c0;
  --green: #e0e0e0;
  --amber: #888888;
}

/* ---- Theme: Terminal (matrix/hacker) ---- */
body[data-theme="terminal"] {
  --bg: #050a05;
  --text: #00ff41;
  --muted: #00aa2a;
  --dim: #003300;
  --accent: #00ff41;
  --cyan: #00cc33;
  --green: #00ff41;
  --amber: #009933;
}

/* ---- Theme: Frost (cold ethereal light) ---- */
body[data-theme="frost"] {
  --bg: #f0f4f8;
  --text: #0f172a;
  --muted: #64748b;
  --dim: #cbd5e1;
  --accent: #0ea5e9;
  --cyan: #06b6d4;
  --green: #10b981;
  --amber: #f59e0b;
}

/* ---- Layout — snap scrolling ---- */
html, body {
  height: 100%;
  overflow: hidden;
  margin: 0;
  padding: 0;
}

/* Main scroll viewport */
.snap-viewport {
  position: fixed;
  inset: 0;
  overflow-y: scroll;
  scroll-snap-type: y mandatory;
  scroll-behavior: auto;
  z-index: 1;
  /* Hide scrollbar */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.snap-viewport::-webkit-scrollbar { display: none; }

/* Each page is a full-height snap stop */
.page {
  min-height: 100vh;
  scroll-snap-align: start;
  scroll-margin-top: 0;
  position: relative;
}

.wrap {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 56px;
  position: relative;
  z-index: 3;
}

@media (max-width: 768px) {
  .wrap { padding: 0 24px; }
}

/* ---- HERO ---- */
.hero {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding-top: 12vh;
  text-align: center;
  position: relative;
}

.hero-eyebrow {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.35em;
  text-transform: uppercase;
  color: var(--muted);
  margin-top: -18px;
  margin-bottom: 4px;
  opacity: 0;
  animation: aUp 0.9s ease 0.15s forwards;
}

.hero-title {
  font-size: clamp(88px, 17vw, 168px);
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 0.88;
  margin-top: 0;
  margin-bottom: 0;
  position: relative;
  display: flex;
  justify-content: center;
}

/* Each layer — relative so they stack naturally, not positioned */
.t-cyan, .t-blue, .t-pink, .t-white {
  position: absolute;
  top: 0;
}

/* <b> holds the solid fill + glow; animation drives a gentle drift */
.t-cyan > b, .t-blue > b, .t-pink > b, .t-white > b {
  display: block;
  font-weight: inherit;
  letter-spacing: inherit;
  line-height: inherit;
}

/* Cyan — solid fill, slight left-up drift */
.t-cyan > b {
  color: #22d3ee;
  animation: driftCyan 4.5s ease-in-out 0s infinite alternate;
  filter:
    blur(0px)
    drop-shadow(0 0 8px #22d3ee)
    drop-shadow(0 0 20px rgba(34,211,238,0.8))
    drop-shadow(0 0 40px rgba(34,211,238,0.5))
    drop-shadow(0 0 80px rgba(34,211,238,0.25));
}

/* Blue — solid fill, slight right-up drift */
.t-blue > b {
  color: #7dd3fc;
  animation: driftBlue 5s ease-in-out 0.6s infinite alternate;
  filter:
    blur(0px)
    drop-shadow(0 0 8px #7dd3fc)
    drop-shadow(0 0 20px rgba(125,211,252,0.8))
    drop-shadow(0 0 40px rgba(125,211,252,0.5))
    drop-shadow(0 0 80px rgba(125,211,252,0.25));
}

/* Pink — solid fill, slight down drift */
.t-pink > b {
  color: #f472b6;
  animation: driftPink 5.5s ease-in-out 1.2s infinite alternate;
  filter:
    blur(0px)
    drop-shadow(0 0 8px #f472b6)
    drop-shadow(0 0 20px rgba(244,114,182,0.8))
    drop-shadow(0 0 40px rgba(244,114,182,0.5))
    drop-shadow(0 0 80px rgba(244,114,182,0.25));
}

/* White — bright core, reduced opacity */
.t-white > b {
  color: rgba(230, 240, 255, 0.7);
  animation: titlePulse 4s ease-in-out 1.2s infinite;
  text-shadow:
    0 0 12px rgba(255,255,255,0.9),
    0 0 30px rgba(125,211,252,0.7),
    0 0 60px rgba(125,211,252,0.5),
    0 0 120px rgba(125,211,252,0.25);
}

/* Each color drifts subtly from center */
@keyframes driftCyan {
  0%   { transform: translate(-6px, -4px); filter: drop-shadow(0 0 8px #22d3ee) drop-shadow(0 0 20px rgba(34,211,238,0.8)) drop-shadow(0 0 40px rgba(34,211,238,0.5)) drop-shadow(0 0 80px rgba(34,211,238,0.25)); }
  50%  { transform: translate(-10px, -7px); filter: drop-shadow(0 0 14px #22d3ee) drop-shadow(0 0 30px rgba(34,211,238,0.9)) drop-shadow(0 0 55px rgba(34,211,238,0.55)) drop-shadow(0 0 110px rgba(34,211,238,0.3)); }
  100% { transform: translate(-7px, -5px); filter: drop-shadow(0 0 10px #22d3ee) drop-shadow(0 0 25px rgba(34,211,238,0.85)) drop-shadow(0 0 48px rgba(34,211,238,0.5)) drop-shadow(0 0 95px rgba(34,211,238,0.25)); }
}

@keyframes driftBlue {
  0%   { transform: translate(5px, -3px); filter: drop-shadow(0 0 8px #7dd3fc) drop-shadow(0 0 20px rgba(125,211,252,0.8)) drop-shadow(0 0 40px rgba(125,211,252,0.5)) drop-shadow(0 0 80px rgba(125,211,252,0.25)); }
  50%  { transform: translate(9px, -6px); filter: drop-shadow(0 0 14px #7dd3fc) drop-shadow(0 0 30px rgba(125,211,252,0.9)) drop-shadow(0 0 55px rgba(125,211,252,0.55)) drop-shadow(0 0 110px rgba(125,211,252,0.3)); }
  100% { transform: translate(6px, -4px); filter: drop-shadow(0 0 10px #7dd3fc) drop-shadow(0 0 25px rgba(125,211,252,0.85)) drop-shadow(0 0 48px rgba(125,211,252,0.5)) drop-shadow(0 0 95px rgba(125,211,252,0.25)); }
}

@keyframes driftPink {
  0%   { transform: translate(2px, 5px); filter: drop-shadow(0 0 8px #f472b6) drop-shadow(0 0 20px rgba(244,114,182,0.8)) drop-shadow(0 0 40px rgba(244,114,182,0.5)) drop-shadow(0 0 80px rgba(244,114,182,0.25)); }
  50%  { transform: translate(4px, 9px); filter: drop-shadow(0 0 14px #f472b6) drop-shadow(0 0 30px rgba(244,114,182,0.9)) drop-shadow(0 0 55px rgba(244,114,182,0.55)) drop-shadow(0 0 110px rgba(244,114,182,0.3)); }
  100% { transform: translate(3px, 7px); filter: drop-shadow(0 0 10px #f472b6) drop-shadow(0 0 25px rgba(244,114,182,0.85)) drop-shadow(0 0 48px rgba(244,114,182,0.5)) drop-shadow(0 0 95px rgba(244,114,182,0.25)); }
}

@keyframes acidDrift {
  0%   { filter: blur(3px) brightness(1.4); transform: translate(-5px, -4px); }
  33%  { filter: blur(5px) brightness(1.6); transform: translate(-3px, -6px); }
  66%  { filter: blur(4px) brightness(1.5); transform: translate(-6px, -3px); }
  100% { filter: blur(3px) brightness(1.4); transform: translate(-5px, -4px); }
}

@keyframes titlePulse {
  0%, 100% {
    text-shadow: 0 0 8px rgba(125,211,252,0.8), 0 0 20px rgba(125,211,252,0.6), 0 0 40px rgba(125,211,252,0.4), 0 0 80px rgba(99,179,237,0.25);
  }
  50% {
    text-shadow: 0 0 12px rgba(125,211,252,1), 0 0 30px rgba(125,211,252,0.8), 0 0 60px rgba(125,211,252,0.5), 0 0 120px rgba(99,179,237,0.35);
  }
}



.hero-sub {
  font-size: clamp(14px, 1.6vw, 16px);
  font-weight: 300;
  letter-spacing: 0.12em;
  color: var(--muted);
  margin-top: -20px;
  margin-bottom: 0;
  opacity: 0;
  animation: aUp 0.9s ease 0.45s forwards;
}

.hero-lower {
  margin-top: 14vh;
}

.strip {
  margin-top: -60px;
}

/* Core Orb */
.core-wrap {
  position: relative;
  width: 300px;
  height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 64px auto 0;
  opacity: 0;
  animation: aIn 1.4s ease 0.7s forwards;
}

.core-svg { position: absolute; inset: 0; }

.cring {
  fill: none;
  stroke: var(--accent);
  stroke-width: 0.5;
  opacity: 0;
}

.cring-1 { animation: sonar 5s ease-out 0.8s infinite; }
.cring-2 { animation: sonar 5s ease-out 1.8s infinite; }
.cring-3 { animation: sonar 5s ease-out 2.8s infinite; }
.cring-4 { animation: sonar 5s ease-out 3.8s infinite; }

@keyframes sonar {
  0%   { transform: scale(0.12); opacity: 0.6; }
  100% { transform: scale(1);   opacity: 0; }
}

.cdot {
  width: 11px;
  height: 11px;
  background: var(--accent);
  border-radius: 50%;
  box-shadow: 0 0 28px var(--accent), 0 0 60px rgba(125,211,252,0.35), 0 0 120px rgba(125,211,252,0.1);
  animation: breathe 3s ease-in-out infinite;
  position: relative;
  z-index: 2;
}

@keyframes breathe {
  0%, 100% { transform: scale(1);    box-shadow: 0 0 24px var(--accent), 0 0 56px rgba(125,211,252,0.35); }
  50%       { transform: scale(1.25); box-shadow: 0 0 40px var(--accent), 0 0 80px rgba(125,211,252,0.4), 0 0 140px rgba(125,211,252,0.12); }
}

/* Hero strip */
.strip {
  display: flex;
  gap: 64px;
  margin-top: 80px;
  opacity: 0;
  animation: aUp 0.9s ease 1s forwards;
}

.strip-item { text-align: center; }

.strip-n {
  font-size: 32px;
  font-weight: 600;
  font-family: var(--mono);
  letter-spacing: -0.03em;
  color: var(--text);
}

.strip-l {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  margin-top: 6px;
}

.strip-sep {
  width: 1px;
  height: 48px;
  background: rgba(255,255,255,0.05);
  align-self: center;
}

/* Scroll hint */
.scroll {
  position: absolute;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  opacity: 0;
  animation: aIn 1s ease 1.8s forwards;
}

.scroll-t {
  font-size: 9px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--dim);
}

.scroll-l {
  width: 1px;
  height: 36px;
  background: linear-gradient(to bottom, rgba(255,255,255,0.06), transparent);
  animation: sPulse 2.5s ease-in-out infinite;
}

@keyframes sPulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.9; } }

/* ---- FLOWING PATHWAYS — diving into depths ---- */




/* ---- WORKSPACE ---- */
.space {
  min-height: 100vh;
  padding: 80px 0 60px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
}

.space-intro {
  text-align: center;
  margin-bottom: 64px;
  opacity: 0;
  animation: aUp 0.9s ease 0.6s forwards;
}

.space-intro h2 {
  font-size: clamp(28px, 4vw, 44px);
  font-weight: 600;
  letter-spacing: -0.04em;
  color: var(--text);
  margin-bottom: 10px;
}

.space-intro p {
  font-size: 15px;
  color: var(--muted);
  font-weight: 300;
}

/* 3-column: Agent | Core | Memory+Activity */
.grid {
  display: grid;
  grid-template-columns: 1fr 280px 1fr;
  gap: 0 28px;
  align-items: start;
}

.g-l { grid-column: 1; grid-row: 1/3; padding-top: 120px; }
.g-c { grid-column: 2; grid-row: 1/3; }
.g-r { grid-column: 3; grid-row: 1/3; padding-top: 120px; }

@media (max-width: 900px) {
  .grid { grid-template-columns: 1fr; }
  .g-l, .g-c, .g-r { grid-column: 1; grid-row: auto; padding-top: 0; }
}

/* Orbitals */
.orb-line { width: 1px; height: 80px; background: linear-gradient(to bottom, rgba(125,211,252,0.22), transparent); margin: 0 auto; }
.orb-dot  { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: 0.45; box-shadow: 0 0 8px rgba(125,211,252,0.4); margin: 0 auto; }

.core-sm {
  position: relative;
  width: 100px;
  height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 28px auto;
}

/* ---- PILL MODULE ---- */
.pill {
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 20px;
  padding: 28px 30px;
  margin-bottom: 18px;
  position: relative;
  overflow: hidden;
  transition: border-color 0.35s, transform 0.35s;
}

.pill:hover {
  border-color: rgba(125,211,252,0.12);
  transform: translateY(-2px);
}

.pill-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.pill-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--dim);
}

.pill-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: rgba(125,211,252,0.06);
  padding: 2px 9px;
  border-radius: 10px;
}

/* ---- AGENTS ---- */
.agent-list { display: flex; flex-direction: column; }

.agent-item {
  padding: 16px 0;
  border-bottom: 1px solid rgba(255,255,255,0.025);
  transition: padding-left 0.25s ease;
  cursor: default;
}

.agent-item:last-child { border-bottom: none; }
.agent-item:hover { padding-left: 8px; }

.agent-top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 5px;
}

.agent-name {
  font-size: 15px;
  font-weight: 500;
  color: var(--text);
}

.agent-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
}

.agent-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.agent-dot.on  { background: var(--green); box-shadow: 0 0 8px rgba(74,222,128,0.6); animation: pulseG 2s ease-in-out infinite; }
.agent-dot.idle { background: var(--amber); box-shadow: 0 0 6px rgba(245,158,11,0.45); }

@keyframes pulseG {
  0%, 100% { box-shadow: 0 0 6px rgba(74,222,128,0.45); }
  50% { box-shadow: 0 0 16px rgba(74,222,128,0.8), 0 0 4px rgba(74,222,128,0.5); }
}

.agent-slabel {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.agent-slabel.on  { color: var(--green); }
.agent-slabel.idle { color: var(--amber); }

.agent-doing {
  font-size: 13px;
  color: var(--muted);
  font-weight: 300;
  font-style: italic;
  padding-left: 17px;
}

.agent-doing::before { content: '— '; color: var(--dim); font-style: normal; }

/* ---- MEMORY OCEAN ---- */
.mem-sea {
  position: relative;
  height: 260px;
  margin-bottom: 24px;
  overflow: hidden;
}

.mem-svg { position: absolute; inset: 0; width: 100%; height: 100%; }

.mpath { fill: none; stroke-width: 0.8; opacity: 0.35; stroke-linecap: round; }
.mp-1 { stroke: rgba(125,211,252,0.55); }
.mp-2 { stroke: rgba(34,211,238,0.55); }
.mp-3 { stroke: rgba(74,222,128,0.55); }
.mp-4 { stroke: rgba(245,158,11,0.55); }
.mp-x { stroke: rgba(125,211,252,0.07); }

.mnode {
  position: absolute;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.3s ease;
}

.mnode:hover { transform: scale(1.7); }

.mnode::after {
  content: attr(data-label);
  position: absolute;
  left: 20px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: none;
}

.mnode:hover::after { opacity: 1; }

.mn-1 { background: var(--accent); box-shadow: 0 0 20px rgba(125,211,252,0.5); animation: fl1 7s ease-in-out infinite; }
.mn-2 { background: var(--cyan);  box-shadow: 0 0 20px rgba(34,211,238,0.5);  animation: fl2 8s ease-in-out infinite; }
.mn-3 { background: var(--green); box-shadow: 0 0 20px rgba(74,222,128,0.5);  animation: fl3 6s ease-in-out infinite; }
.mn-4 { background: var(--amber);box-shadow: 0 0 20px rgba(245,158,11,0.5);  animation: fl4 9s ease-in-out infinite; }

@keyframes fl1 { 0%,100% { transform:translate(0,0); }    33% { transform:translate(16px,-22px); } 66% { transform:translate(-12px,-14px); } }
@keyframes fl2 { 0%,100% { transform:translate(0,0); }    33% { transform:translate(-18px,-16px); } 66% { transform:translate(12px,-24px); } }
@keyframes fl3 { 0%,100% { transform:translate(0,0); }    33% { transform:translate(14px,-12px); } 66% { transform:translate(-16px,-18px); } }
@keyframes fl4 { 0%,100% { transform:translate(0,0); }    33% { transform:translate(-10px,-26px); } 66% { transform:translate(18px,-14px); } }

.mem-ctr {
  position: absolute;
  left: 50%; top: 50%;
  transform: translate(-50%,-50%);
  width: 9px; height: 9px;
  background: var(--accent);
  border-radius: 50%;
  box-shadow: 0 0 22px rgba(125,211,252,0.5);
}

.mem-cats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }

.mem-cat {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 8px;
  transition: background 0.2s;
}

.mem-cat:hover { background: rgba(255,255,255,0.025); }

.mem-cdot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.mem-clbl { font-size: 12px; color: var(--muted); flex: 1; }
.mem-cn { font-size: 11px; font-family: var(--mono); color: var(--dim); }

/* ---- ACTIVITY ---- */
.act { display: flex; flex-direction: column; }

.act-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 13px 0;
  border-bottom: 1px solid rgba(255,255,255,0.025);
  transition: padding-left 0.2s ease;
}

.act-row:last-child { border-bottom: none; }
.act-row:hover { padding-left: 6px; }

.act-av {
  width: 28px; height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  flex-shrink: 0;
  opacity: 0.6;
}

.act-av-g { background: rgba(74,222,128,0.08); }
.act-av-c { background: rgba(34,211,238,0.08); }
.act-av-a { background: rgba(245,158,11,0.08); }
.act-av-ac { background: rgba(125,211,252,0.08); }

.act-b { flex: 1; }
.act-t { font-size: 13px; color: var(--text); font-weight: 400; line-height: 1.5; }
.act-m { font-size: 11px; color: var(--dim); font-family: var(--mono); margin-top: 3px; }

/* ---- COMMAND (Raycast-style capsule) ---- */
.cmd {
  margin-top: 8px;
  opacity: 0;
  animation: aUp 0.9s ease 0.5s forwards;
}

.cmd-field {
  display: flex;
  align-items: center;
  gap: 14px;
  background: rgba(255,255,255,0.025);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 16px;
  padding: 16px 22px;
  transition: all 0.3s ease;
  cursor: text;
}

.cmd-field:focus-within {
  border-color: rgba(125,211,252,0.25);
  background: rgba(125,211,252,0.03);
  box-shadow: 0 0 0 3px rgba(125,211,252,0.04), 0 8px 32px rgba(0,0,0,0.3);
}

.cmd-icon {
  font-size: 22px;
  color: var(--accent);
  opacity: 0.6;
  flex-shrink: 0;
  line-height: 1;
}

.cmd-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-family: var(--ff);
  font-size: 15px;
  font-weight: 300;
  color: var(--text);
  caret-color: var(--accent);
}

.cmd-input::placeholder { color: var(--dim); }

.cmd-hints {
  display: flex;
  gap: 20px;
  margin-top: 14px;
  padding: 0 4px;
}

.cmd-h { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dim); }

.cmd-h kbd {
  font-family: var(--mono);
  font-size: 10px;
  padding: 2px 6px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 4px;
  color: var(--muted);
}

/* ---- STATUS BAR ---- */
.sbar {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  padding: 14px 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  z-index: 100;
  background: linear-gradient(to top, var(--bg), transparent);
}

.sbar-l { display: flex; align-items: center; gap: 28px; }

.sbar-i { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dim); }

.sbar-pip { width: 6px; height: 6px; border-radius: 50%; }
.sbar-pip.l  { background: var(--green); box-shadow: 0 0 6px rgba(74,222,128,0.6); }
.sbar-pip.d  { background: #f87171; }
.sbar-pip.n  { background: var(--dim); }

.sbar-r { font-size: 11px; font-family: var(--mono); color: var(--dim); }

/* ---- ANIMATIONS ---- */
@keyframes aUp  { from { opacity:0; transform:translateY(30px); } to { opacity:1; transform:translateY(0); } }
@keyframes aIn { from { opacity:0; } to { opacity:1; } }

.a0 { opacity:0; animation: aUp 0.8s ease 0.05s forwards; }
.a1 { opacity:0; animation: aUp 0.8s ease 0.15s forwards; }
.a2 { opacity:0; animation: aUp 0.8s ease 0.25s forwards; }
.a3 { opacity:0; animation: aUp 0.8s ease 0.35s forwards; }
.a4 { opacity:0; animation: aUp 0.8s ease 0.45s forwards; }
</style>
</head>
<body>

<!-- Ambient light beams -->
<div class="ambient"></div>

<!-- Scan line texture -->
<div class="scanlines"></div>

<div class="snap-viewport">

  <!-- PAGE 1: HERO -->
  <div class="page">
    <div class="wrap">
      <section class="hero">
        <div class="hero-eyebrow">Personal Intelligence System</div>
        <h1 class="hero-title">
          <span class="t-cyan"><b class="t-inner">ORCA</b></span>
          <span class="t-blue"><b class="t-inner">ORCA</b></span>
          <span class="t-pink"><b class="t-inner">ORCA</b></span>
          <span class="t-white"><b class="t-inner">ORCA</b></span>
        </h1>
        <p class="hero-sub">Autonomous AI Workspace</p>

        <div class="hero-lower">
        <div class="core-wrap">
          <svg class="core-svg" viewBox="0 0 300 300">
            <circle class="cring cring-1" cx="150" cy="150" r="55" />
            <circle class="cring cring-2" cx="150" cy="150" r="78" />
            <circle class="cring cring-3" cx="150" cy="150" r="104" />
            <circle class="cring cring-4" cx="150" cy="150" r="132" />
          </svg>
          <div class="cdot"></div>
        </div>

        <div class="scroll">
          <div class="scroll-t">Explore</div>
          <div class="scroll-l"></div>
        </div>
        </div>

        <div class="strip">
          <div class="strip-item">
            <div class="strip-n" id="hero-agents">${agents.length}</div>
            <div class="strip-l">Agents</div>
          </div>
          <div class="strip-sep"></div>
          <div class="strip-item">
            <div class="strip-n" id="hero-core">${orcaOk ? 'Online' : 'Offline'}</div>
            <div class="strip-l">Core</div>
          </div>
          <div class="strip-sep"></div>
          <div class="strip-item">
            <div class="strip-n" id="hero-lastseen">${state.feishu.lastMessageAt ? relTime(state.feishu.lastMessageAt) : '—'}</div>
            <div class="strip-l">Last seen</div>
          </div>
        </div>
      </section>
    </div>
  </div>

  <!-- PAGE 2: WORKSPACE -->
  <div class="page">
    <div class="wrap">
      <section class="space">

        <div class="space-intro">
          <h2>Your Intelligence Ecosystem</h2>
          <p>Where agents think, memories flow, and actions leave traces</p>
        </div>

        <div class="grid">

          <!-- LEFT: Agent Network -->
          <div class="g-l">
            <div class="pill a1">
              <div class="pill-head">
                <span class="pill-label">Agent Network</span>
                <span class="pill-badge" id="agent-count">${agents.length}</span>
              </div>
              <div class="agent-list">
                ${agents.length === 0 ? `
                  <div class="agent-item">
                    <div class="agent-doing" style="margin-left:0">No agents active — awaiting connection</div>
                  </div>` : ''}
                ${agents.map((a, i) => {
                  const on = i === 0
                  return `
                  <div class="agent-item">
                    <div class="agent-top">
                      <span class="agent-name">${a.name}</span>
                      <div class="agent-meta">
                        <span class="agent-dot ${on ? 'on' : 'idle'}"></span>
                        <span class="agent-slabel ${on ? 'on' : 'idle'}">${on ? 'Active' : 'Idle'}</span>
                      </div>
                    </div>
                    <div class="agent-doing">${a.description || 'Standing by'}</div>
                  </div>`
                }).join('')}
              </div>
            </div>
          </div>

          <!-- CENTER: Core + orbitals -->
          <div class="g-c a2">
            <div class="orb-line"></div>
            <div class="orb-dot"></div>
            <div class="core-sm">
              <svg class="core-svg" viewBox="0 0 100 100">
                <circle class="cring cring-1" cx="50" cy="50" r="20" />
                <circle class="cring cring-2" cx="50" cy="50" r="32" />
                <circle class="cring cring-3" cx="50" cy="50" r="44" />
              </svg>
              <div class="cdot" style="width:7px;height:7px"></div>
            </div>
            <div class="orb-dot"></div>
            <div class="orb-line"></div>
          </div>

          <!-- RIGHT: Memory Ocean + Activity -->
          <div class="g-r">

            <!-- Memory Ocean -->
            <div class="pill a3" style="margin-bottom:18px">
              <div class="pill-head">
                <span class="pill-label">Memory Ocean</span>
                <span class="pill-badge">4 layers</span>
              </div>

              <div class="mem-sea">
                <svg class="mem-svg" viewBox="0 0 320 260" preserveAspectRatio="xMidYMid meet">
                  <path class="mpath mp-1" d="M60,68 C105,56 130,90 160,130" />
                  <path class="mpath mp-2" d="M260,52 C218,82 190,106 160,130" />
                  <path class="mpath mp-3" d="M76,192 C118,165 142,148 160,130" />
                  <path class="mpath mp-4" d="M244,194 C200,168 180,150 160,130" />
                  <path class="mpath mp-x" d="M60,68 C90,135 125,180 244,194" />
                  <path class="mpath mp-x" d="M260,52 C198,105 175,145 76,192" />
                </svg>
                <div class="mnode mn-1" data-label="Projects"      style="left:16%;top:26%"></div>
                <div class="mnode mn-2" data-label="Preferences"   style="left:78%;top:19%"></div>
                <div class="mnode mn-3" data-label="Knowledge"     style="left:20%;top:76%"></div>
                <div class="mnode mn-4" data-label="Experiences"   style="left:73%;top:78%"></div>
                <div class="mem-ctr"></div>
              </div>

              <div class="mem-cats">
                <div class="mem-cat"><div class="mem-cdot" style="background:var(--accent)"></div><span class="mem-clbl">Projects</span><span class="mem-cn" id="mc-projects">—</span></div>
                <div class="mem-cat"><div class="mem-cdot" style="background:var(--cyan)"></div><span class="mem-clbl">Preferences</span><span class="mem-cn" id="mc-preferences">—</span></div>
                <div class="mem-cat"><div class="mem-cdot" style="background:var(--green)"></div><span class="mem-clbl">Knowledge</span><span class="mem-cn" id="mc-knowledge">—</span></div>
                <div class="mem-cat"><div class="mem-cdot" style="background:var(--amber)"></div><span class="mem-clbl">Experiences</span><span class="mem-cn" id="mc-experiences">—</span></div>
              </div>
            </div>

            <!-- Activity -->
            <div class="pill a4">
              <div class="pill-head">
                <span class="pill-label">Activity</span>
              </div>
              <div class="act" id="actFeed">
                <div class="act-loading" style="font-size:12px;color:var(--dim);padding:8px 0">Loading events…</div>
              </div>
            </div>
          </div>

        </div>

        <!-- Command -->
        <div class="cmd">
          <div class="cmd-field" id="cmdFld">
            <div class="cmd-icon">⬡</div>
            <input type="text" class="cmd-input" placeholder="Ask Orca anything…" id="cmdIn" autocomplete="off" spellcheck="false">
          </div>
          <div class="cmd-hints">
            <span class="cmd-h"><kbd>↵</kbd> Send</span>
            <span class="cmd-h"><kbd>Ctrl K</kbd> Focus</span>
            <span class="cmd-h"><kbd>Esc</kbd> Clear</span>
          </div>
        </div>

      </section>
    </div>
  </div>

</div>

<!-- Status bar — fixed bottom, above snap viewport -->
<div class="sbar">
  <div class="sbar-l">
    <div class="sbar-i">
      <div class="sbar-pip" id="sb-pip-orca"></div>
      <span id="sb-txt-orca">Orca ${orcaOk ? 'active' : 'inactive'}</span>
    </div>
    <div class="sbar-i">
      <div class="sbar-pip" id="sb-pip-receiver"></div>
      <span id="sb-txt-receiver">Receiver ${receiverOk ? 'ready' : 'down'}</span>
    </div>
    <div class="sbar-i">
      <div class="sbar-pip" id="sb-pip-feishu"></div>
      <span id="sb-txt-feishu">Feishu ${state.feishu.lastMessageAt ? 'connected' : 'idle'}</span>
    </div>
  </div>
  <div class="sbar-r" id="sbar-time">${new Date().toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
</div>

<!-- Theme picker — placed OUTSIDE snap-viewport so z-index:9999 is at root level -->
<div class="tpicker">
<button class="tbtn" id="tBtn" title="Switch theme" aria-label="Switch theme">◈</button>
<div class="tmenu" id="tMenu">
  <div class="titem active" data-theme="orca-prime">
    <div class="tdot" style="background:#7dd3fc;box-shadow:0 0 6px #7dd3fc"></div>Orca Prime
  </div>
  <div class="titem" data-theme="void">
    <div class="tdot" style="background:#ffffff"></div>Void
  </div>
  <div class="titem" data-theme="terminal">
    <div class="tdot" style="background:#00ff41;box-shadow:0 0 6px #00ff41"></div>Terminal
  </div>
  <div class="titem" data-theme="frost">
    <div class="tdot" style="background:#0ea5e9;box-shadow:0 0 6px #0ea5e9"></div>Frost
  </div>
</div>
</div>

<script>
document.addEventListener('DOMContentLoaded', function() {
  /* ─── Helpers ─── */
  var $ = function(id) { return document.getElementById(id) }

  function relTime(ts) {
    if (!ts) return '—'
    var diff = Date.now() - ts
    if (diff < 60000) return Math.floor(diff / 1000) + 's ago'
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago'
    return Math.floor(diff / 3600000) + 'h ago'
  }

  function esc(s) {
    var d = document.createElement('div')
    d.textContent = s
    return d.innerHTML
  }

  /* ─── Theme switcher ─── */
  var tBtn = $('tBtn')
  var tMenu = $('tMenu')

  var savedTheme = localStorage.getItem('orca-theme')
  if (savedTheme) applyTheme(savedTheme, false)

  tBtn && tBtn.addEventListener('click', function(e) { e.stopPropagation(); tMenu && tMenu.classList.toggle('open') })
  document.addEventListener('click', function() { tMenu && tMenu.classList.remove('open') })
  tMenu && tMenu.querySelectorAll('.titem').forEach(function(item) {
    item.addEventListener('click', function(e) {
      e.stopPropagation()
      var theme = item.dataset.theme || 'orca-prime'
      applyTheme(theme, true)
      tMenu && tMenu.classList.remove('open')
    })
  })

  function applyTheme(theme, save) {
    document.body.setAttribute('data-theme', theme)
    if (save) localStorage.setItem('orca-theme', theme)
    tMenu && tMenu.querySelectorAll('.titem').forEach(function(it) {
      it.classList.toggle('active', it.dataset.theme === theme)
    })
  }

  /* ─── Status bar & hero live update ─── */
  async function refreshStatus() {
    try {
      var r = await fetch('/api/status')
      if (!r.ok) return
      var d = await r.json()

      var heroAgents = $('hero-agents')
      var heroCore = $('hero-core')
      var heroLastseen = $('hero-lastseen')
      if (heroAgents) heroAgents.textContent = String(d.infoAgents && d.infoAgents.length || 0)
      if (heroCore) heroCore.textContent = d.services && d.services.orca && d.services.orca.reachable ? 'Online' : 'Offline'
      if (heroLastseen && d.feishu && d.feishu.lastMessageAt) {
        heroLastseen.textContent = d.feishu.lastMessageRel
      }

      var orcaPip = $('sb-pip-orca')
      var orcaTxt = $('sb-txt-orca')
      var recvPip = $('sb-pip-receiver')
      var recvTxt = $('sb-txt-receiver')
      var feishuPip = $('sb-pip-feishu')
      var feishuTxt = $('sb-txt-feishu')

      if (orcaPip) orcaPip.className = 'sbar-pip ' + (d.services && d.services.orca && d.services.orca.reachable ? 'l' : 'd')
      if (orcaTxt) orcaTxt.textContent = 'Orca ' + (d.services && d.services.orca && d.services.orca.reachable ? 'active' : 'inactive')
      if (recvPip) recvPip.className = 'sbar-pip ' + (d.services && d.services.infoReceiver && d.services.infoReceiver.reachable ? 'l' : 'd')
      if (recvTxt) recvTxt.textContent = 'Receiver ' + (d.services && d.services.infoReceiver && d.services.infoReceiver.reachable ? 'ready' : 'down')
      if (feishuPip) feishuPip.className = 'sbar-pip ' + (d.feishu && d.feishu.lastMessageAt ? 'l' : 'n')
      if (feishuTxt) feishuTxt.textContent = 'Feishu ' + (d.feishu && d.feishu.lastMessageAt ? 'connected' : 'idle')

      var agentCount = $('agent-count')
      if (agentCount) agentCount.textContent = String(d.infoAgents && d.infoAgents.length || 0)

      renderAgentList(d.infoAgents || [])
    } catch (_) {}
  }

  function renderAgentList(agents) {
    var list = document.querySelector('.agent-list')
    if (!list) return
    if (!agents.length) {
      list.innerHTML = '<div class="agent-item"><div class="agent-doing" style="margin-left:0">No agents active — awaiting connection</div></div>'
      return
    }
    list.innerHTML = agents.map(function(a, i) {
      var on = i === 0
      return '<div class="agent-item">' +
        '<div class="agent-top">' +
          '<span class="agent-name">' + esc(a.name) + '</span>' +
          '<div class="agent-meta">' +
            '<span class="agent-dot ' + (on ? 'on' : 'idle') + '"></span>' +
            '<span class="agent-slabel ' + (on ? 'on' : 'idle') + '">' + (on ? 'Active' : 'Idle') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="agent-doing">' + esc(a.description || 'Standing by') + '</div>' +
      '</div>'
    }).join('')
  }

  /* ─── Activity feed ─── */
  async function refreshActivity() {
    try {
      var r = await fetch('/api/events?limit=20')
      if (!r.ok) return
      var d = await r.json()
      var feed = $('actFeed')
      if (!feed) return

      if (!d.events || !d.events.length) {
        feed.innerHTML = '<div class="act-loading" style="font-size:12px;color:var(--dim);padding:8px 0">No events yet</div>'
        return
      }

      feed.innerHTML = d.events.slice(0, 15).map(function(ev) {
        var icon = ev.source === 'feishu' ? (ev.type === 'image' ? '◻' : '✉') : '◉'
        var cls = ev.source === 'feishu' ? 'act-av-ac' : 'act-av-g'
        var label = ev.type === 'message' ? 'Feishu message'
          : ev.type === 'image' ? 'Image processed'
          : ev.type === 'dashboard-reply' ? 'Orca replied'
          : ev.source === 'orca' ? 'Orca'
          : (ev.source + '/' + ev.type)
        var text = ev.data && ev.data.text
          ? (String(ev.data.text).slice(0, 60) + (String(ev.data.text).length > 60 ? '…' : ''))
          : label
        var meta = new Date(ev.timestamp).toLocaleTimeString('zh-CN', { hour12: false })
        return '<div class="act-row">' +
          '<div class="act-av ' + cls + '">' + icon + '</div>' +
          '<div class="act-b">' +
            '<div class="act-t">' + esc(text) + '</div>' +
            '<div class="act-m">' + esc(meta) + ' · ' + esc(label) + '</div>' +
          '</div>' +
        '</div>'
      }).join('')
    } catch (_) {}
  }

  /* ─── Memory Ocean counts ─── */
  async function refreshMemory() {
    try {
      var r = await fetch('/api/memory')
      if (!r.ok) return
      var d = await r.json()
      if (!d.layers) return
      d.layers.forEach(function(layer) {
        var el = $('mc-' + layer.key.toLowerCase())
        if (el) el.textContent = layer.count ? String(layer.count) : '—'
      })
    } catch (_) {}
  }

  /* ─── Command bar ─── */
  var inp = $('cmdIn')
  var fld = $('cmdFld')
  fld && fld.addEventListener('click', function() { inp && inp.focus() })
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); inp && inp.focus() }
    if (e.key === 'Escape' && document.activeElement === inp) { inp.value = ''; inp.blur() }
  })

  inp && inp.addEventListener('keydown', async function(e) {
    if (e.key !== 'Enter' || !inp.value.trim()) return
    var text = inp.value.trim()
    inp.value = ''

    var id = 'msg-' + Date.now()
    appendActivity('◉', 'act-av-g', esc(text), 'sending…', id)

    try {
      var r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text, id: id }),
      })
      if (!r.ok) throw new Error('chat failed')
    } catch (_) {
      updateActivity(id, '◌', 'act-av-a', esc(text), 'send failed')
    }
  })

  function appendActivity(icon, cls, text, meta, id) {
    var feed = $('actFeed')
    if (!feed) return
    var loading = feed.querySelector('.act-loading')
    if (loading) loading.remove()
    var row = document.createElement('div')
    row.className = 'act-row'
    row.id = 'act-' + id
    row.innerHTML = '<div class="act-av ' + cls + '">' + icon + '</div>' +
      '<div class="act-b">' +
        '<div class="act-t">' + text + '</div>' +
        '<div class="act-m">' + meta + '</div>' +
      '</div>'
    feed.insertBefore(row, feed.firstChild)
    while (feed.children.length > 20) feed.removeChild(feed.lastChild)
  }

  function updateActivity(id, icon, cls, text, meta) {
    var row = $('act-' + id)
    if (!row) return
    row.innerHTML = '<div class="act-av ' + cls + '">' + icon + '</div>' +
      '<div class="act-b">' +
        '<div class="act-t">' + text + '</div>' +
        '<div class="act-m">' + meta + '</div>' +
      '</div>'
  }

  /* ─── SSE — real-time Orca replies ─── */
  var evtSrc = null
  function connectSSE() {
    if (evtSrc) evtSrc.close()
    evtSrc = new EventSource('/api/stream')
    evtSrc.addEventListener('orca', function(e) {
      try {
        var ev = JSON.parse(e.data)
        if (ev.type === 'orca' && ev.data && ev.data.id) {
          var icon = ev.data.error ? '◌' : '◉'
          var cls = ev.data.error ? 'act-av-a' : 'act-av-g'
          updateActivity(ev.data.id, icon, cls, esc(ev.data.reply || ''), new Date().toLocaleTimeString('zh-CN', { hour12: false }))
        }
      } catch (_) {}
    })
    evtSrc.onerror = function() {
      evtSrc && evtSrc.close()
      setTimeout(connectSSE, 5000)
    }
  }

  /* ─── Clock ─── */
  function tick() {
    var el = $('sbar-time')
    if (el) el.textContent = new Date().toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  /* ─── Wheel scroll — one wheel tick = one full page snap ─── */
  var snapViewport = $('.snap-viewport')
  var pages = snapViewport ? snapViewport.querySelectorAll('.page') : []
  var currentPage = 0
  var isScrolling = false

  if (snapViewport) {
    snapViewport.addEventListener('wheel', function(e) {
      e.preventDefault()
      if (isScrolling) return
      var delta = e.wheelDeltaY !== undefined ? -e.wheelDeltaY : (e.deltaY || e.detail || 0)
      var nextPage = currentPage + (delta > 0 ? 1 : delta < 0 ? -1 : 0)
      if (nextPage < 0 || nextPage >= pages.length || nextPage === currentPage) return
      currentPage = nextPage
      isScrolling = true
      var targetTop = pages[currentPage].offsetTop
      smoothScrollTo(snapViewport, targetTop, 900, function() {
        isScrolling = false
      })
    }, { passive: false })
  }

  function smoothScrollTo(el, targetTop, duration, onDone) {
    var startTop = el.scrollTop
    var diff = targetTop - startTop
    var startTime = null
    function step(timestamp) {
      if (!startTime) startTime = timestamp
      var elapsed = timestamp - startTime
      var progress = Math.min(elapsed / duration, 1)
      // easeInOutCubic
      var t = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2
      el.scrollTop = startTop + diff * t
      if (progress < 1) {
        requestAnimationFrame(step)
      } else {
        onDone && onDone()
      }
    }
    requestAnimationFrame(step)
  }

  /* ─── Boot ─── */
  refreshStatus()
  refreshActivity()
  refreshMemory()
  connectSSE()
  tick()

  setInterval(refreshStatus, 5000)
  setInterval(refreshActivity, 5000)
  setInterval(refreshMemory, 15000)
  setInterval(tick, 10000)
})
</script>
</body>
</html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    ctx.logger.info('[dashboard] 仪表盘已启动 http://127.0.0.1:%d/dashboard', DASHBOARD_PORT)
  })

  return () => { server.close() }
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}
