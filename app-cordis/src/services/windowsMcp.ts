import type { ActionHandler, ActionResult } from '../types/action.js'
import type { Decision } from '../types/decision.js'

export interface WindowsMcpConfig {
  enabled: boolean
  endpoint: string
  token: string
  timeoutMs: number
  protocolVersion: string
}

export interface WindowsMcpLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
}

export interface WindowsMcpTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  dispose?(): void
}

export interface WindowsMcpService {
  initialize(): Promise<void>
  availableActions(): string[]
  describeActions(): string[]
  execute(action: string, args: Record<string, unknown>): Promise<{ message: string; metadata?: Record<string, unknown> }>
  dispose(): void
}

const ACTIONS = {
  'windows.desktop.screenshot': { tool: 'Screenshot', description: '获取 Windows 桌面截图（不保存图片）。', input: '可选 JSON 对象：{}' },
  'windows.desktop.snapshot': { tool: 'Snapshot', description: '获取 Windows UI Automation 界面快照（限制输出长度）。', input: '可选 JSON 对象：{}' },
  'windows.desktop.display_inventory': { tool: 'DisplayInventory', description: '查询 Windows 显示器数量、布局和 DPI。', input: '{}' },
  'windows.desktop.control_status': { tool: 'ControlStatus', description: '查询 Windows-MCP 控制状态，不执行控制。', input: '{}' },
} as const

type ToolSpec = { name: string; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } }

function validateSchema(value: unknown, schema: unknown, path = 'arguments'): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return `${path}: missing schema`
  const s = schema as Record<string, unknown>
  if (Array.isArray(s.enum) && !s.enum.some((item) => Object.is(item, value))) return `${path}: enum violation`
  const type = s.type
  if (type === 'object' || (!type && s.properties)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${path}: expected object`
    const object = value as Record<string, unknown>
    const properties = s.properties && typeof s.properties === 'object' ? s.properties as Record<string, unknown> : {}
    const required = Array.isArray(s.required) ? s.required.filter((item): item is string => typeof item === 'string') : []
    for (const key of required) if (!(key in object)) return `${path}.${key}: required`
    if (s.additionalProperties === false) for (const key of Object.keys(object)) if (!(key in properties)) return `${path}.${key}: unexpected property`
    for (const [key, child] of Object.entries(object)) {
      if (key in properties) {
        const error = validateSchema(child, properties[key], `${path}.${key}`)
        if (error) return error
      }
    }
    return null
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return `${path}: expected array`
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return `${path}: too many items`
    if (s.items) for (let i = 0; i < value.length; i++) {
      const error = validateSchema(value[i], s.items, `${path}[${i}]`)
      if (error) return error
    }
    return null
  }
  if (type === 'string' && typeof value !== 'string') return `${path}: expected string`
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${path}: expected number`
  if (type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) return `${path}: expected integer`
  if (type === 'boolean' && typeof value !== 'boolean') return `${path}: expected boolean`
  return null
}

function summarizeResult(result: unknown): { message: string; metadata?: Record<string, unknown> } {
  if (!result || typeof result !== 'object') throw new Error('Windows-MCP 返回结构未知')
  const payload = result as { isError?: unknown; content?: unknown }
  if (payload.isError === true) throw new Error('Windows-MCP 工具返回错误')
  if (!Array.isArray(payload.content)) throw new Error('Windows-MCP 缺少 content')
  const text: string[] = []
  let images = 0
  for (const item of payload.content) {
    if (!item || typeof item !== 'object') continue
    const content = item as { type?: unknown; text?: unknown; data?: unknown }
    if (content.type === 'text' && typeof content.text === 'string') text.push(content.text.slice(0, 4000))
    if (content.type === 'image' && typeof content.data === 'string') images++
  }
  if (!text.length && images === 0) throw new Error('Windows-MCP 返回空结果')
  return {
    message: [text.join('\n'), images > 0 ? `已获取 ${images} 张截图（图片仅用于本次请求，未保存）。` : ''].filter(Boolean).join('\n'),
    metadata: { contentTypes: [...new Set(payload.content.map((item) => item && typeof item === 'object' ? (item as { type?: unknown }).type : undefined).filter((type): type is string => typeof type === 'string'))], imageCount: images },
  }
}

class StreamableHttpTransport implements WindowsMcpTransport {
  private sessionId: string | undefined
  private nextId = 1
  private disposed = false

  constructor(private readonly config: WindowsMcpConfig) {}

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.disposed) throw new Error('Windows-MCP client disposed')
    const id = method.startsWith('notifications/') ? undefined : this.nextId++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      }
      if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
      const response = await fetch(this.config.endpoint, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
      })
      this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId
      const body = await response.text()
      if (!response.ok) throw new Error(`Windows-MCP HTTP ${response.status}`)
      if (id === undefined || !body.trim()) return undefined
      const jsonText = response.headers.get('content-type')?.includes('text/event-stream')
        ? body.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean).at(-1)
        : body
      if (!jsonText) throw new Error('Windows-MCP 空响应')
      const message = JSON.parse(jsonText) as { error?: { message?: string }; result?: unknown }
      if (message.error) throw new Error(message.error.message ?? 'Windows-MCP JSON-RPC error')
      return message.result
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Windows-MCP 请求超时')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  dispose(): void { this.disposed = true }
}

export function createWindowsMcpService(config: WindowsMcpConfig, logger?: WindowsMcpLogger, transport?: WindowsMcpTransport): WindowsMcpService {
  const client = transport ?? new StreamableHttpTransport(config)
  const tools = new Map<string, ToolSpec>()
  let initialized = false
  let disposed = false
  return {
    async initialize() {
      if (!config.enabled) return
      if (!config.endpoint || !config.token) throw new Error('Windows-MCP endpoint/token 未配置')
      const initializedResult = await client.request('initialize', {
        protocolVersion: config.protocolVersion,
        capabilities: {},
        clientInfo: { name: 'orca', version: '0.7.1' },
      })
      if (!initializedResult || typeof initializedResult !== 'object') throw new Error('Windows-MCP initialize 返回结构未知')
      await client.request('notifications/initialized')
      const listResult = await client.request('tools/list')
      const listed = listResult && typeof listResult === 'object' && Array.isArray((listResult as { tools?: unknown }).tools)
        ? (listResult as { tools: unknown[] }).tools : []
      tools.clear()
      for (const item of listed) {
        if (!item || typeof item !== 'object') continue
        const tool = item as ToolSpec
        if (typeof tool.name === 'string') tools.set(tool.name, tool)
      }
      for (const spec of Object.values(ACTIONS)) {
        const tool = tools.get(spec.tool)
        if (!tool || tool.annotations?.readOnlyHint !== true || !tool.inputSchema) {
          logger?.warn('[windows-mcp] 工具未通过只读 allowlist/schema 校验：%s', spec.tool)
          continue
        }
      }
      initialized = true
      logger?.info('[windows-mcp] 只读工具发现完成 available=%s', JSON.stringify(this.availableActions()))
    },
    availableActions() {
      if (!initialized || disposed) return []
      return Object.entries(ACTIONS).filter(([, spec]) => {
        const tool = tools.get(spec.tool)
        return Boolean(tool && tool.annotations?.readOnlyHint === true && tool.inputSchema)
      }).map(([action]) => action)
    },
    describeActions() {
      return this.availableActions().map((action) => `- ${action}: ${ACTIONS[action as keyof typeof ACTIONS].description} 参数 JSON: ${ACTIONS[action as keyof typeof ACTIONS].input}`)
    },
    async execute(action, args) {
      if (!this.availableActions().includes(action)) throw new Error('Windows-MCP Action 未启用或服务不可用')
      if (!args || Array.isArray(args)) throw new Error('Windows-MCP 参数必须是 JSON 对象')
      const toolName = ACTIONS[action as keyof typeof ACTIONS].tool
      const tool = tools.get(toolName)!
      const validation = validateSchema(args, tool.inputSchema)
      if (validation) throw new Error(validation)
      const result = await client.request('tools/call', { name: toolName, arguments: args })
      return summarizeResult(result)
    },
    dispose() { disposed = true; client.dispose?.() },
  }
}

function fail(decision: Decision, error: string): ActionResult {
  return { success: false, action: decision.action, decisionId: decision.decisionId, sourceEventId: decision.eventId, error, message: 'Windows 桌面观察暂时不可用。', executedAt: Date.now() }
}

export function createWindowsDesktopActionHandlers(service: WindowsMcpService, logger?: WindowsMcpLogger): ActionHandler[] {
  return service.availableActions().map((action) => ({
    action, name: `${action}-readonly`, llmDescription: service.describeActions().find((description) => description.startsWith(`- ${action}:`))?.slice(2),
    async execute(decision: Decision): Promise<ActionResult> {
      try {
        const args = JSON.parse(decision.reason || '{}') as Record<string, unknown>
        const result = await service.execute(action, args)
        return { success: true, action, decisionId: decision.decisionId, sourceEventId: decision.eventId, message: result.message, metadata: result.metadata, executedAt: Date.now() }
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Windows-MCP 执行失败'
        logger?.warn('[windows-mcp] action=%s failed=%s', action, detail.slice(0, 160))
        return fail(decision, detail)
      }
    },
  }))
}

export const WINDOWS_MCP_ACTIONS = Object.keys(ACTIONS)
