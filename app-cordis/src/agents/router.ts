import type { AgentDeps, InfoRecord, InfoResult } from './types.js'
import type { InfoAgentRegistry } from './registry.js'
import type { InfoExecutor } from './executor.js'
import type { JsonlInfoRecordStore } from './store.js'

export interface RouterServices {
  registry: InfoAgentRegistry
  store: JsonlInfoRecordStore
  executor: InfoExecutor
  logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void }
}

export type RouterResult =
  | { source: 'archive'; agent: string; records: InfoRecord[]; tookMs: number }
  | { source: 'agent'; agent: string; result: InfoResult; tookMs: number }
  | { source: 'none'; tookMs: number }

export interface RouteRequest {
  /** 自然语言问询（R0 查档关键词 / R1 关键词匹配） */
  query?: string
  /** 显式指定 agent（Pull 委托） */
  agent?: string
  /** agent 输入（与 agent 同传） */
  input?: unknown
  sessionId: string
  deps: AgentDeps
}

/**
 * 路由（§5，D-AGENT-04/10）：
 * R0 查档案优先 —— 档案命中直接复用（零成本），未命中才派活；
 * R1 关键词匹配出候选集；R2（LLM 工具选择）/ R3（多源聚合）留到信息源增多后演进。
 */
export async function route(services: RouterServices, req: RouteRequest): Promise<RouterResult> {
  const started = Date.now()
  const keyword = req.query?.trim() || summarize(req.input)

  // R0：查档案优先（D-AGENT-10）—— 对每个声明了 recordTypes 的 push agent 检索其档案夹
  if (keyword) {
    for (const agent of services.registry.list()) {
      if (!agent.meta.recordTypes?.length) continue
      const records = await services.store.query({
        namespaces: [agent.meta.name],
        types: agent.meta.recordTypes,
        keyword,
        limit: 5,
      })
      if (records.length) {
        return { source: 'archive', agent: agent.meta.name, records, tookMs: Date.now() - started }
      }
    }
  }

  // 显式 Pull 委托（Orca 或外部调用方点名 agent）
  if (req.agent) {
    const agent = services.registry.get(req.agent)
    if (!agent) return { source: 'none', tookMs: Date.now() - started }
    const result = await services.executor.execute(agent, { agent: req.agent, input: req.input, sessionId: req.sessionId }, req.deps)
    return { source: 'agent', agent: req.agent, result, tookMs: Date.now() - started }
  }

  // R1：关键词匹配出候选集（信息源 > 8 个后演进到 R2 LLM 工具选择，D-AGENT-04）。
  // 本轮文本问询不自动执行图片型 agent（缺少图片输入），候选集仅记录日志，返回 none 由 CEO 常规回复。
  if (keyword) {
    const candidates = services.registry
      .list()
      .filter((a) => [a.meta.name, ...(a.meta.tags ?? [])].some((t) => keyword.toLowerCase().includes(t.toLowerCase())))
    if (candidates.length) {
      services.logger.info(
        '[router] R1 候选集: %s（query=%s，文本问询不自动执行，等待显式 Pull 委托）',
        candidates.map((c) => c.meta.name).join(','),
        keyword.slice(0, 60),
      )
    }
  }

  return { source: 'none', tookMs: Date.now() - started }
}

function summarize(v: unknown): string {
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'string') return v
  try {
    const s = JSON.stringify(v)
    return s.length > 160 ? `${s.slice(0, 160)}…` : s
  } catch {
    return String(v)
  }
}
