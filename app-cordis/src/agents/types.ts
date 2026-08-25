/**
 * 信息获取框架核心抽象（对应 guide/orca-info-agent-framework.md §3）。
 * CEO-员工-档案室模型：Orca=CEO，InfoAgent=员工，InfoRecordStore=档案室。
 */

/** 待机行为门控等级（D-AGENT-11）：0 静默（默认）/ 1 建议汇报 / 2 紧急推送（本轮未实现，设计保留） */
export type Urgency = 0 | 1 | 2

/** 协作模式：Pull=问询（Orca 主动调用）；Push=自主写档案（App/事件/定时） */
export type InfoAgentMode = 'pull' | 'push'

/** 执行后端形态（D-AGENT-05） */
export type InfoBackend = 'in-process' | 'subprocess-bridge' | 'mcp' | 'remote-http'

/** 能力描述 —— 给 LLM 选型和路由用 */
export interface InfoAgentMeta {
  name: string
  description: string // 能力描述（注入 system prompt 供 LLM 选择）
  tags?: string[] // 能力标签：food / weather / finance / news / local ...
  inputSchema?: Record<string, unknown> // Pull 参数校验（JSON Schema 子集）
  outputSchema?: Record<string, unknown> // Pull 结果结构（canonical）
  modes?: InfoAgentMode[] // 默认 ['pull']；push 需声明 recordTypes
  recordTypes?: string[] // push 模式产出的记录类型（food-log / stock-quote ...）
  kind?: 'tool' | 'llm'
  backend?: InfoBackend
  timeoutMs?: number
  isConcurrencySafe?: boolean // false 时 Executor 对该 agent 串行执行
  costHint?: 'free' | 'cheap' | 'paid'
}

/** 执行依赖 —— 最小权限注入（D-AGENT-06：不给发送/写文件能力） */
export interface AgentDeps {
  /** 推理型 agent 内部 LLM（如 DeepSeek） */
  llm?: unknown
  /** 视觉识别客户端（food-agent 用） */
  vision?: unknown
  /** 会话存储（按需） */
  session?: unknown
  /** Push 模式 agent 用它写档案 */
  store?: InfoRecordStore
  /** 统一日志接口 */
  logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void }
  /** 取消信号（超时/外部取消） */
  signal?: AbortSignal
}

export interface InfoRequest<In = unknown> {
  agent?: string
  input: In
  sessionId: string
}

export type InfoResult<Out = unknown> =
  | { ok: true; data: Out; tookMs: number; source: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean } }

export interface InfoAgent<In = unknown, Out = unknown> {
  meta: InfoAgentMeta
  execute(req: InfoRequest<In>, deps: AgentDeps): Promise<InfoResult<Out>>
}

// ---------- Push 模式：记录信封（员工档案条目，D-AGENT-09） ----------

export interface InfoRecord {
  id: string // uuid
  namespace: string // agent 名（food-agent / stock-agent ...）
  type: string // 记录类型（food-log / stock-quote ...）
  ts: number // 产生时间（写入时打）
  source: string // 来源标识（app / mcp-server / worker / cli）
  confidence?: number // 0-1，推理型 agent 的置信度
  urgency?: Urgency // 0 静默（默认）/ 1 建议汇报 / 2 紧急推送
  payload: unknown // agent 私有结构化数据（schema 由 recordTypes 对应声明）
  ttlDays?: number // 可选过期天数（照片类可设短 ttl）
  supersedes?: string // 更正：本条取代 id 指向的前一条（append-only + supersedes，D-AGENT-09）
}

/** 查询条件：检索与门控只依赖信封字段，不解析 payload（框架硬性约定） */
export interface RecordQuery {
  namespaces?: string[]
  types?: string[]
  from?: number // ts 下限
  to?: number // ts 上限
  urgency?: Urgency
  keyword?: string // payload 内文本/JSON 关键词（大小写不敏感）
  limit?: number
}

/** 档案室服务契约（§3） */
export interface InfoRecordStore {
  append(record: InfoRecord): Promise<void> // Push 入口（InfoAgent / 外部通道调用）
  query(q: RecordQuery): Promise<InfoRecord[]> // Orca 跨 agent 检索（R0）
  delete(namespace: string, ids?: string[]): Promise<number> // 软删 + prune 物理清理（D-AGENT-12）
  pruneExpired(): Promise<number> // 按 ttl 清理
  getRecentByNamespace(namespace: string, n: number): Promise<InfoRecord[]>
  // 待汇报队列（urgency=1，D-AGENT-11）：peek 注入下条消息，回复成功后 ack 移出
  peekPending(): Promise<InfoRecord[]>
  ackPending(ids: string[]): void
}
