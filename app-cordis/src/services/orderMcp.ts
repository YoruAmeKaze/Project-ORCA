import type { ActionHandler, ActionResult } from '../types/action.js'
import type { Decision } from '../types/decision.js'
import type { LocationService } from './location.js'

export interface OrderMcpProviderConfig {
  enabled: boolean
  endpoint: string
  token: string
}

export interface OrderMcpConfig {
  luckin: OrderMcpProviderConfig
  mcd: OrderMcpProviderConfig
}

export interface OrderMcpLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
}

export interface OrderMcpService {
  initialize(): Promise<void>
  availableActions(): string[]
  describeActions(): string[]
  execute(action: string, args: Record<string, unknown>): Promise<{ message: string; data?: ActionResult['data'] }>
  dispose(): void
}

interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
}

interface ProviderSpec {
  label: string
  endpoint: string
  token: string
  enabled: boolean
  tools: Record<string, { action: string; tool: string; description: string; input: string }>
  fixedArgs?: (action: string, input: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
}

const PROVIDER_ACTIONS = {
  luckin: {
    'order.luckin.stores': { tool: 'queryShopList', description: '查询当前位置附近的瑞幸门店。先通过 location.current 获取本机位置，不询问用户索取坐标。', input: '{"deptName":"城市或门店关键词（可选）"}' },
    'order.luckin.products': { tool: 'searchProductForMcp', description: '按门店查询瑞幸商品。', input: '{"deptId":门店ID,"query":"商品关键词"}' },
    'order.luckin.product_detail': { tool: 'queryProductDetailInfo', description: '查询瑞幸单个商品详情。', input: '{"deptId":门店ID,"productId":商品ID}' },
    'order.luckin.preview': { tool: 'previewOrder', description: '只试算瑞幸订单，不创建订单。', input: '{"deptId":门店ID,"productList":[{"amount":数量,"productId":商品ID,"skuCode":"规格码"}]}' },
    'order.luckin.order_status': { tool: 'queryOrderDetailInfo', description: '查询瑞幸订单状态。', input: '{"orderId":"订单号"}' },
  },
  mcd: {
    'order.mcd.stores': { tool: 'query-nearby-stores', description: '按城市和地标查询麦当劳到店门店。', input: '{"beType":1或5,"city":"城市","keyword":"地标或区域"}' },
    'order.mcd.menu': { tool: 'query-meals', description: '查询指定麦当劳门店菜单。', input: '{"storeCode":"门店码","beType":1或2或5或6,"orderType":1或2,"beCode":"按实时 schema 需要时填写"}' },
    'order.mcd.meal_detail': { tool: 'query-meal-detail', description: '查询麦当劳餐品详情。', input: '{"storeCode":"门店码","beType":... ,"orderType":... ,"code":"餐品码"}' },
    'order.mcd.price': { tool: 'calculate-price', description: '只试算麦当劳价格，不创建订单。', input: '{"storeCode":"门店码","beType":... ,"orderType":... ,"items":[{"productCode":"餐品码","quantity":数量}]}' },
    'order.mcd.order_status': { tool: 'query-order', description: '查询麦当劳订单状态。', input: '{"orderId":"订单号"}' },
    'order.mcd.store_coupons': { tool: 'query-store-coupons', description: '查询指定门店可用优惠，不领取或兑换。', input: '{"storeCode":"门店码","beType":... ,"orderType":...}' },
    'order.mcd.server_time': { tool: 'now-time-info', description: '查询麦当劳服务端当前时间。', input: '{}' },
  },
} as const

const CHINESE_LABELS: Record<string, string> = {
  deptName: '门店', storeName: '门店', store_name: '门店', name: '名称',
  deptId: '门店ID', storeCode: '门店码', beCode: '业务码', productName: '商品',
  product_name: '商品', productId: '商品ID', productCode: '商品码', skuCode: '规格码',
  price: '价格', totalPrice: '总价', payableAmount: '应付', status: '状态',
  orderStatus: '订单状态', orderId: '订单号', distance: '距离', isOpen: '营业中',
  openStatus: '营业状态', categoryName: '分类', message: '说明', success: '成功',
  businessStatus: '营业中', businessStartTime: '营业开始', businessEndTime: '营业结束',
  reservation: '支持预约', reservationOptionText: '预约时段', date: '日期', today: '今天',
  code: '状态码', total: '数量', count: '数量', description: '说明',
}

const STORE_ADDRESS_ACTIONS = new Set(['order.luckin.stores', 'order.mcd.stores'])

function validateAgainstSchema(value: unknown, schemaValue: unknown, path = 'arguments'): string | null {
  if (typeof schemaValue !== 'object' || schemaValue === null || Array.isArray(schemaValue)) return `${path}: invalid server schema`
  const schema = schemaValue as Record<string, unknown>
  const type = schema.type
  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.some((x) => Object.is(x, value))) return `${path}: value not in allowed enum`
  if (type === 'object' || (!type && schema.properties)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path}: expected object`
    const obj = value as Record<string, unknown>
    const properties = (schema.properties && typeof schema.properties === 'object')
      ? schema.properties as Record<string, unknown>
      : {}
    const required = Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === 'string') : []
    for (const key of required) if (!(key in obj)) return `${path}.${key}: required`
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) if (!(key in properties)) return `${path}.${key}: unexpected property`
    }
    for (const [key, child] of Object.entries(obj)) {
      if (!(key in properties)) continue
      const error = validateAgainstSchema(child, properties[key], `${path}.${key}`)
      if (error) return error
    }
    return null
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return `${path}: expected array`
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${path}: too few items`
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path}: too many items`
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const error = validateAgainstSchema(value[i], schema.items, `${path}[${i}]`)
        if (error) return error
      }
    }
    return null
  }
  if (type === 'string' && typeof value !== 'string') return `${path}: expected string`
  if (type === 'integer' && (!Number.isInteger(value))) return `${path}: expected integer`
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${path}: expected number`
  if (type === 'boolean' && typeof value !== 'boolean') return `${path}: expected boolean`
  return null
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function parseRpcResponse(raw: string): Record<string, unknown> {
  const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith('data:'))
  const body = dataLine ? dataLine.slice(5).trim() : raw.trim()
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new Error('MCP returned an invalid JSON-RPC response')
  }
}

function extractJsonPayload(text: string): unknown | undefined {
  // Vendor prose may contain placeholders such as `data[]`; public results are object envelopes.
  const start = text.indexOf('{')
  if (start < 0) return undefined
  const opening = '{'
  const closing = '}'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === opening) depth++
    if (char === closing) depth--
    if (depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)) } catch { return undefined }
    }
  }
  return undefined
}

function formatResult(action: string, content: unknown): string {
  const chunks = Array.isArray(content) ? content : []
  const texts = chunks.flatMap((item) => {
    if (typeof item === 'object' && item !== null && typeof (item as { text?: unknown }).text === 'string') return [(item as { text: string }).text]
    return []
  })
  if (!texts.length) return '查询已完成，但服务未返回可展示的数据。'
  const summaries: string[] = []
  const plainTexts: string[] = []
  for (const text of texts) {
    const parsed = extractJsonPayload(text)
    if (parsed === undefined) {
      const cleaned = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 16).join('\n')
      if (cleaned && !cleaned.startsWith('{') && !cleaned.startsWith('[')) plainTexts.push(cleaned.slice(0, 1_500))
      continue
    }
    const allowed = new Set(Object.keys(CHINESE_LABELS))
    if (STORE_ADDRESS_ACTIONS.has(action)) allowed.add('address')
    const lines: string[] = []
    const visit = (node: unknown, depth: number) => {
      if (depth > 5 || lines.length >= 45) return
      if (Array.isArray(node)) {
        for (const item of node.slice(0, 8)) visit(item, depth + 1)
        return
      }
      if (typeof node !== 'object' || node === null) return
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (allowed.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
          const rendered = String(value).slice(0, 160)
          lines.push(`${CHINESE_LABELS[key] ?? key}：${rendered}`)
        } else if (typeof value === 'object' && value !== null) visit(value, depth + 1)
      }
    }
    visit(parsed, 0)
    if (lines.length) summaries.push([...new Set(lines)].slice(0, 24).join('\n'))
  }
  if (!summaries.length && plainTexts.length) return plainTexts.join('\n').slice(0, 1_500)
  if (!summaries.length) return '查询已返回，但响应结构暂未识别；为避免展示未经整理的原始报文，暂不展开内容。'
  return summaries.join('\n\n').slice(0, 3_500)
}

function extractStructuredData(action: string, content: unknown): ActionResult['data'] | undefined {
  const allowed = new Set(['deptId', 'deptName', 'storeCode', 'storeName', 'productId', 'productName', 'productCode', 'skuCode', 'distance', 'address', 'isOpen', 'price', 'totalPrice', 'status', 'orderId'])
  const values: Record<string, unknown> = {}
  const visit = (node: unknown, depth = 0) => {
    if (depth > 6 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const item of node.slice(0, 20)) visit(item, depth + 1); return }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (allowed.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
        if (!(key in values)) values[key] = value
      } else visit(value, depth + 1)
    }
  }
  for (const block of Array.isArray(content) ? content : []) {
    if (typeof block !== 'object' || block === null || typeof (block as { text?: unknown }).text !== 'string') continue
    const parsed = extractJsonPayload((block as { text: string }).text)
    if (parsed !== undefined) visit(parsed)
  }
  if (!Object.keys(values).length) return undefined
  return { kind: action.endsWith('.stores') ? 'store-list' : action.endsWith('.menu') ? 'menu' : 'provider-query', values }
}

class ProviderClient {
  private tools = new Map<string, McpTool>()
  private signatures = new Map<string, string>()
  private requestId = 1
  private sessionId: string | undefined
  private initialized = false
  private disposed = false

  constructor(private readonly spec: ProviderSpec, private readonly logger?: OrderMcpLogger) {}

  async initialize(): Promise<void> {
    if (!this.spec.enabled || !this.spec.token) return
    const init = await this.post('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'orca-order-actions', version: '1.0.0' },
    })
    const result = init.result as Record<string, unknown> | undefined
    if (!result || typeof result.protocolVersion !== 'string') throw new Error(`${this.spec.label}: invalid initialize result`)
    this.initialized = true
    await this.post('notifications/initialized')
    await this.refreshTools()
    this.logger?.info('[order-mcp:%s] 已核验只读工具 schema（%d 项）', this.spec.label, this.tools.size)
  }

  actions(): string[] {
    return this.initialized && !this.disposed ? Object.keys(this.spec.tools) : []
  }

  async call(action: string, input: Record<string, unknown>): Promise<{ message: string; data?: ActionResult['data'] }> {
    if (!this.initialized || this.disposed) throw new Error('该点餐 MCP 服务未就绪')
    const mapping = this.spec.tools[action]
    if (!mapping) throw new Error('此 Action 未注册')
    const args = await (this.spec.fixedArgs?.(action, input) ?? input)
    // 每次调用前重新核验 tools/list，防止远端部署变更后盲调旧 schema。
    await this.refreshTools()
    const tool = this.tools.get(mapping.tool)
    if (!tool) throw new Error('官方服务当前未提供此只读工具')
    const validation = validateAgainstSchema(args, tool.inputSchema)
    if (validation) throw new Error(`查询参数未通过官方 schema 校验：${validation}`)
    const response = await this.post('tools/call', { name: mapping.tool, arguments: args })
    const result = response.result as Record<string, unknown> | undefined
    if (!result || result.isError === true) throw new Error('官方服务未能完成只读查询')
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (typeof block !== 'object' || block === null || typeof (block as { text?: unknown }).text !== 'string') continue
        const payload = extractJsonPayload((block as { text: string }).text)
        if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)
          && (payload as Record<string, unknown>).success === false) {
          throw new Error('官方服务返回业务失败状态')
        }
      }
    }
    return { message: formatResult(action, result.content), data: extractStructuredData(action, result.content) }
  }

  dispose(): void { this.disposed = true; this.tools.clear(); this.signatures.clear() }

  private async refreshTools(): Promise<void> {
    const response = await this.post('tools/list', {})
    const result = response.result as Record<string, unknown> | undefined
    const tools = result?.tools
    if (!Array.isArray(tools)) throw new Error(`${this.spec.label}: invalid tools/list response`)
    const next = new Map<string, McpTool>()
    for (const raw of tools) {
      if (typeof raw !== 'object' || raw === null) continue
      const tool = raw as McpTool
      if (typeof tool.name === 'string') next.set(tool.name, tool)
    }
    for (const mapping of Object.values(this.spec.tools)) {
      const tool = next.get(mapping.tool)
      if (!tool || typeof tool.inputSchema !== 'object' || tool.inputSchema === null) {
        throw new Error(`${this.spec.label}: expected read-only tool unavailable; calls disabled`)
      }
      const signature = stableJson(tool.inputSchema)
      if (tool.annotations?.readOnlyHint === false) throw new Error(`${this.spec.label}: ${mapping.tool} is not declared read-only`)
      const previous = this.signatures.get(mapping.tool)
      if (previous && previous !== signature) throw new Error(`${this.spec.label}: schema changed for ${mapping.tool}; calls stopped`)
      this.signatures.set(mapping.tool, signature)
    }
    this.tools = next
  }

  private async post(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = method.startsWith('notifications/') ? undefined : this.requestId++
    const body = JSON.stringify(id === undefined
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id, method, params })
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.spec.token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-03-26',
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
    let response: Response
    try {
      response = await fetch(this.spec.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) })
    } catch {
      throw new Error(`${this.spec.label}: MCP connection failed`)
    }
    const sessionId = response.headers.get('Mcp-Session-Id')
    if (sessionId) this.sessionId = sessionId
    if (!response.ok) throw new Error(`${this.spec.label}: MCP HTTP ${response.status}`)
    if (id === undefined) return {}
    const rpc = parseRpcResponse(await response.text())
    if (rpc.error) throw new Error(`${this.spec.label}: MCP request failed`)
    return rpc
  }
}

export function createOrderMcpService(
  config: OrderMcpConfig,
  logger?: OrderMcpLogger,
  location?: Pick<LocationService, 'getLatest'>,
): OrderMcpService {
  const luckin = new ProviderClient({
    label: '瑞幸', endpoint: config.luckin.endpoint, token: config.luckin.token,
    enabled: config.luckin.enabled,
    tools: Object.fromEntries(Object.entries(PROVIDER_ACTIONS.luckin)
      .filter(([action]) => action !== 'order.luckin.stores' || Boolean(location))
      .map(([action, item]) => [action, { ...item, action, input: item.input }])),
    fixedArgs: (action, input) => {
      if (action === 'order.luckin.stores') {
        const current = location?.getLatest()
        if (!current) throw new Error('没有有效的本机定位；请先通过 location.current 获取当前位置后再查询附近门店。')
        return { ...input, longitude: current.longitude, latitude: current.latitude }
      }
      return input
    },
  }, logger)
  const mcd = new ProviderClient({
    label: '麦当劳', endpoint: config.mcd.endpoint, token: config.mcd.token, enabled: config.mcd.enabled,
    tools: Object.fromEntries(Object.entries(PROVIDER_ACTIONS.mcd).map(([action, item]) => [action, { ...item, action, input: item.input }])),
    fixedArgs: (action, input) => {
      if (action === 'order.mcd.stores') {
        if (typeof input.city !== 'string' || !input.city.trim() || typeof input.keyword !== 'string' || !input.keyword.trim()) {
          throw new Error('麦当劳门店查询需要城市和地标/区域')
        }
        return { ...input, searchType: 2 }
      }
      if (action.startsWith('order.mcd.') && ['menu', 'meal_detail', 'price', 'store_coupons'].some((suffix) => action.endsWith(`.${suffix}`))) {
        const beType = input.beType
        const orderType = input.orderType
        if (![1, 2, 5, 6].includes(Number(beType))) throw new Error('麦当劳履约类型无效')
        const requiredOrderType = beType === 1 || beType === 5 ? 1 : 2
        if (orderType !== requiredOrderType) throw new Error('麦当劳履约类型与订单类型不匹配')
        if ((beType === 2 || beType === 5 || beType === 6) && (typeof input.beCode !== 'string' || !input.beCode)) {
          throw new Error('当前麦当劳履约类型需要服务返回的 beCode')
        }
        if (beType === 1 && input.beCode !== undefined) throw new Error('到店自取不可传 beCode')
      }
      return input
    },
  }, logger)
  const clients = { luckin, mcd }
  const providerFor = (action: string) => action.startsWith('order.luckin.') ? luckin : action.startsWith('order.mcd.') ? mcd : undefined
  return {
    async initialize() {
      if (config.luckin.enabled && !config.luckin.token) logger?.warn('[order-mcp:瑞幸] 已启用但未配置 LUCKIN_COFFEE_TOKEN')
      if (config.mcd.enabled && !config.mcd.token) logger?.warn('[order-mcp:麦当劳] 已启用但未配置 MCDONALD_TOKEN')
      const results = await Promise.allSettled([
        config.luckin.enabled && config.luckin.token ? luckin.initialize() : Promise.resolve(),
        config.mcd.enabled && config.mcd.token ? mcd.initialize() : Promise.resolve(),
      ])
      results.forEach((result, i) => {
        if (result.status === 'rejected') logger?.warn('[order-mcp:%s] 服务未启用：%s', i === 0 ? '瑞幸' : '麦当劳', result.reason instanceof Error ? result.reason.message : '连接失败')
      })
    },
    availableActions: () => [...clients.luckin.actions(), ...clients.mcd.actions()],
    describeActions: () => describeOrderActions({ availableActions: () => [...clients.luckin.actions(), ...clients.mcd.actions()] } as OrderMcpService),
    async execute(action, args) {
      const client = providerFor(action)
      if (!client) throw new Error('未知点餐 Action')
      return client.call(action, args)
    },
    dispose: () => { luckin.dispose(); mcd.dispose() },
  }
}

export interface OrderActionDeps {
  service: OrderMcpService
  logger?: OrderMcpLogger
}

function classifyOrderError(message: string): NonNullable<ActionResult['errorInfo']> {
  const code = /schema|required|unexpected|校验|参数/u.test(message) ? 'SCHEMA_MISMATCH'
    : /未就绪|unavailable|未提供|不可用/u.test(message) ? 'TOOL_UNAVAILABLE'
      : /timeout|超时/u.test(message) ? 'TIMEOUT' : 'REMOTE_BUSINESS_ERROR'
  return { code, retryable: code === 'TIMEOUT', message }
}

function fail(decision: Decision, message: string): ActionResult {
  return {
    success: false, action: decision.action, decisionId: decision.decisionId,
    sourceEventId: decision.eventId, error: message,
    errorInfo: classifyOrderError(message),
    message: `这次查询没有完成：${message}`.slice(0, 800), executedAt: Date.now(),
  }
}

export function createOrderActionHandlers(deps: OrderActionDeps): ActionHandler[] {
  return deps.service.availableActions().map((action): ActionHandler => ({
    action,
    name: `${action}-readonly`,
    async execute(decision) {
      const startedAt = Date.now()
      deps.logger?.info('[order-action] 查询开始 action=%s decisionId=%s', action, decision.decisionId)
      try {
        let args: unknown
        try { args = JSON.parse(decision.reason) } catch { return fail(decision, '查询参数格式无效') }
        if (typeof args !== 'object' || args === null || Array.isArray(args)) return fail(decision, '查询参数必须是 JSON 对象')
        const result = await deps.service.execute(action, args as Record<string, unknown>)
        deps.logger?.info('[order-action] 查询结束 action=%s decisionId=%s success=true durationMs=%d', action, decision.decisionId, Date.now() - startedAt)
        return {
          success: true, action: decision.action, decisionId: decision.decisionId,
          sourceEventId: decision.eventId, message: result.message, data: result.data,
          executedAt: Date.now(),
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : '查询失败'
        deps.logger?.warn('[order-action] 查询结束 action=%s decisionId=%s success=false durationMs=%d reason=%s', action, decision.decisionId, Date.now() - startedAt, detail.slice(0, 120))
        return fail(decision, detail)
      }
    },
  }))
}

export function describeOrderActions(service: OrderMcpService): string[] {
  return service.availableActions().map((action) => {
    const item = (PROVIDER_ACTIONS.luckin as Record<string, { description: string; input: string }>)[action]
      ?? (PROVIDER_ACTIONS.mcd as Record<string, { description: string; input: string }>)[action]
    if (!item) return `- ${action}`
    return `- ${action}: ${item.description} 参数 JSON: ${item.input}`
  })
}
