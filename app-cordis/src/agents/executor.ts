import type { AgentDeps, InfoAgent, InfoRequest, InfoResult } from './types.js'

export interface ExecutorOptions {
  defaultTimeoutMs?: number
}

interface LoggerLike {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
}

/**
 * Pull 执行管线（§6，D-AGENT-03/07）：
 * request → 参数校验 → 并发控制 → 超时 → execute → 输出校验 → 归一 → 审计日志。
 * 失败语义：retryable → 重试或换源；否则告知用户。
 */
export class InfoExecutor {
  private unsafeQueues = new Map<string, Promise<unknown>>()

  constructor(
    private logger: LoggerLike,
    private opts: ExecutorOptions = {},
  ) {}

  async execute<In = unknown, Out = unknown>(
    agent: InfoAgent<In, Out>,
    req: InfoRequest<In>,
    deps: AgentDeps,
  ): Promise<InfoResult<Out>> {
    const meta = agent.meta
    const started = Date.now()
    const summary = summarize(req.input)

    // 1. 参数校验
    const invalid = validateInput(meta.inputSchema, req.input)
    if (invalid) {
      this.audit(meta.name, 'BAD_INPUT', invalid, started)
      return { ok: false, error: { code: 'BAD_INPUT', message: invalid, retryable: false } }
    }

    // 2. 并发控制：非并发安全 agent 串行执行；deps.signal 注入超时/取消信号（agent 内 fetch 可真正中止）
    const controller = new AbortController()
    const exec = (): Promise<InfoResult<Out>> => agent.execute(req, { ...deps, signal: controller.signal })
    const task = meta.isConcurrencySafe === false ? this.serialize(meta.name, exec) : exec()

    // 3. 超时
    const timeoutMs = meta.timeoutMs ?? this.opts.defaultTimeoutMs ?? 15_000
    let result: InfoResult<Out>
    try {
      result = await withTimeout(task, timeoutMs)
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError'
      if (timedOut) controller.abort() // 中止底层请求，避免孤儿 fetch 继续烧 API/占连接
      const message = timedOut ? `执行超时（>${timeoutMs}ms）` : err instanceof Error ? err.message : String(err)
      this.audit(meta.name, timedOut ? 'TIMEOUT' : 'EXEC_ERROR', message, started)
      return { ok: false, error: { code: timedOut ? 'TIMEOUT' : 'EXEC_ERROR', message, retryable: timedOut } }
    }

    // 4. 输出校验 + 归一
    if (!result.ok) {
      this.audit(meta.name, result.error.code, result.error.message, started)
      return result
    }
    const outInvalid = validateOutput(meta.outputSchema, result.data)
    if (outInvalid) {
      this.audit(meta.name, 'BAD_OUTPUT', outInvalid, started)
      return { ok: false, error: { code: 'BAD_OUTPUT', message: outInvalid, retryable: false } }
    }
    const normalized: InfoResult<Out> = { ok: true, data: result.data, tookMs: Date.now() - started, source: result.source || meta.name }
    this.audit(meta.name, 'ok', summarize(normalized.data), started)
    return normalized
  }

  private serialize<T>(name: string, task: () => Promise<T>): Promise<T> {
    const prev = this.unsafeQueues.get(name) ?? Promise.resolve()
    const next = prev.then(task, task)
    this.unsafeQueues.set(name, next.catch(() => undefined))
    return next
  }

  private audit(name: string, code: string, detail: string, started: number): void {
    // D-AGENT-07 委托可审计：路由回执（选了谁/结果摘要/耗时）写入日志
    this.logger.info('[info:%s] %s %s took=%dms', name, code, detail.slice(0, 120), Date.now() - started)
  }
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`timeout after ${ms}ms`)
      err.name = 'TimeoutError'
      reject(err)
    }, ms)
    task.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** JSON Schema 子集校验（无 schemastery 依赖，够 Pull 参数校验用） */
export function validateInput(schema: Record<string, unknown> | undefined, input: unknown): string | null {
  if (!schema || typeof schema !== 'object') return null
  if (schema.type === 'object' || schema.type === undefined) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'input 必须是 object'
  }
  const obj = input as Record<string, unknown>
  const required = schema.required as string[] | undefined
  if (required) {
    for (const key of required) {
      if (!(key in obj) || obj[key] === undefined) return `缺少必填参数: ${key}`
    }
  }
  const properties = schema.properties as Record<string, { type?: string }> | undefined
  if (properties) {
    for (const [key, spec] of Object.entries(properties)) {
      if (obj[key] === undefined) continue
      if (!spec?.type) continue
      const ok =
        spec.type === 'integer' ? Number.isInteger(obj[key])
        : spec.type === 'number' ? typeof obj[key] === 'number'
        : spec.type === 'string' ? typeof obj[key] === 'string'
        : spec.type === 'boolean' ? typeof obj[key] === 'boolean'
        : spec.type === 'array' ? Array.isArray(obj[key])
        : spec.type === 'object' ? typeof obj[key] === 'object' && !Array.isArray(obj[key])
        : true
      if (!ok) return `参数 ${key} 类型应为 ${spec.type}`
    }
  }
  return null
}

function validateOutput(schema: Record<string, unknown> | undefined, data: unknown): string | null {
  if (!schema || typeof schema !== 'object') return null
  if (schema.type === 'object' && (data === null || typeof data !== 'object' || Array.isArray(data))) {
    return 'output 必须是 object'
  }
  return null
}

function summarize(v: unknown): string {
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}…` : v
  try {
    const s = JSON.stringify(v)
    return s.length > 120 ? `${s.slice(0, 120)}…` : s
  } catch {
    return String(v)
  }
}
