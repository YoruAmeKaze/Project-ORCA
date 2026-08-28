/**
 * Orca Action Executor —— 执行层实现（Phase 4.B）
 *
 * 职责：
 * - ActionHandlerRegistry 标准实现（register/unregister/get/list/size/clear）
 * - DeferredActionStore 内存实现（Phase 4.B 第一版；不调度、不持久化）
 * - ActionExecutor 服务：execute(decision) → Promise<ActionResult>
 *
 * 第一版内置 5 个 ActionHandler（按 action 一一对应）：
 * - noopHandler    (no_action)   —— 安全 no-op；success=true
 * - rememberHandler (remember)    —— 复用 infoStore；写 InfoRecord
 * - deferHandler   (defer)       —— 入队到 DeferredActionStore；不消费
 * - notifyStubHandler (notify)   —— stub：success=false + "notification handler not configured"
 * - actStubHandler (act)         —— 安全闸：未配置时 success=false；不执行任意 shell / JS / 插件
 *
 * 严格安全约束（用户决策，2026-08-27）：
 * - act handler **禁止执行任意 shell / 任意 JS / 任意插件调用**
 * - act stub 默认返回 success=false + "action handler not configured"
 * - 不允许 fake shell executor
 * - Executor 内部捕获所有 handler 异常 → 转化为 success=false ActionResult
 *
 * 不做（Phase 4.B 范围外）：
 * - 排序 / 排重 / 节流
 * - 持久化（DeferredActionStore 仅 in-memory）
 * - LLM 增强
 * - 真实 scheduler（仅 pending store；不消费）
 */

import { randomUUID } from 'node:crypto'
import type { Decision } from '../types/decision.js'
import type {
  ActionExecutorService,
  ActionHandler,
  ActionHandlerRegistry,
  ActionResult,
  DeferredActionEntry,
  DeferredActionStore,
} from '../types/action.js'

// ── ActionHandlerRegistry 标准实现 ─────────────────────────────────────

/**
 * ActionHandlerRegistryImpl —— 按 action 索引 handler（Last-Write-Wins）
 *
 * - 同 action 重复 register 会覆盖（最后注册的生效）
 * - unregister 不存在不报错（fail-soft）
 */
class ActionHandlerRegistryImpl implements ActionHandlerRegistry {
  private handlers = new Map<string, ActionHandler>()

  register(handler: ActionHandler): void {
    this.handlers.set(handler.action, handler)
  }

  unregister(action: string): void {
    this.handlers.delete(action)
  }

  get(action: string): ActionHandler | undefined {
    return this.handlers.get(action)
  }

  list(): ActionHandler[] {
    return [...this.handlers.values()]
  }

  size(): number {
    return this.handlers.size
  }

  clear(): void {
    this.handlers.clear()
  }
}

/** 工厂函数：创建独立的（空）Registry；用于 R14 测试和未来配置化场景 */
export function createActionHandlerRegistry(): ActionHandlerRegistry {
  return new ActionHandlerRegistryImpl()
}

// ── DeferredActionStore 内存实现 ────────────────────────────────────────

/**
 * DeferredActionStoreImpl —— Phase 4.B 第一版 pending store
 *
 * - 仅 in-memory（不持久化）
 * - 不消费 / 不调度（pendingId 永远不会被自动删除）
 * - 提供 list() / get() / size() / clear() 查询接口
 *
 * 不做：
 * - 不持久化（重启即失）
 * - 不调度（Phase 4.B 范围外）
 */
class DeferredActionStoreImpl implements DeferredActionStore {
  private entries = new Map<string, DeferredActionEntry>()

  enqueue(decision: Decision): string {
    const pendingId = randomUUID()
    this.entries.set(pendingId, {
      pendingId,
      decision,
      queuedAt: Date.now(),
    })
    return pendingId
  }

  get(pendingId: string): DeferredActionEntry | undefined {
    return this.entries.get(pendingId)
  }

  list(): DeferredActionEntry[] {
    return [...this.entries.values()].sort((a, b) => a.queuedAt - b.queuedAt)
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

/** 工厂函数：创建独立的 DeferredActionStore；用于 R14 测试 */
export function createDeferredActionStore(): DeferredActionStore {
  return new DeferredActionStoreImpl()
}

// ── ActionResult 构造工具 ──────────────────────────────────────────────

function okResult(decision: Decision, metadata?: Record<string, unknown>): ActionResult {
  const r: ActionResult = {
    success: true,
    action: decision.action,
    decisionId: decision.decisionId,
    executedAt: Date.now(),
  }
  if (metadata) r.metadata = metadata
  return r
}

function failResult(decision: Decision, error: string): ActionResult {
  return {
    success: false,
    action: decision.action,
    decisionId: decision.decisionId,
    error,
    executedAt: Date.now(),
  }
}

// ── 内置 5 个 ActionHandler ────────────────────────────────────────────

/**
 * noopHandler —— no_action 的安全 no-op handler
 *
 * - 始终 success=true
 * - 不做任何副作用（不查 ctx / 不写文件 / 不发消息）
 * - 是默认安全 handler（用户决策：ignore action 必须真的什么都不做）
 */
export const noopHandler: ActionHandler = {
  name: 'noop',
  action: 'no_action',
  async execute(_decision: Decision): Promise<ActionResult> {
    return okResult(_decision)
  },
}

/**
 * RememberActionContext —— remember handler 需要的最小依赖
 *
 * 第一版不复用整个 InfoAgent framework（避免耦合 InfoRecord envelope 校验）；
 * 直接调 JsonlInfoRecordStore.append（已有最小契约）。
 *
 * 未来可升级为完整 InfoAgent Push 模式（带 agent 选择 / 校验 / 路由）。
 */
export interface RememberActionContext {
  /** 档案室（来自 ctx.infoStore） */
  store: {
    append(record: {
      id?: string
      namespace: string
      type: string
      ts?: number
      source: string
      confidence?: number
      urgency?: 0 | 1 | 2
      payload: unknown
      ttlDays?: number
      supersedes?: string
    }): Promise<void>
  }
  /** Logger（warn 级别） */
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

/**
 * rememberHandler —— remember action 的 handler
 *
 * 行为：
 * - 从 Decision 构造 InfoRecord，写入 infoStore
 * - namespace 固定 'decision-action'（与现有 food-agent 等 namespace 区分）
 * - type 固定 'decision-remember'（Phase 4.B 第一版；后续可按 ruleId 分桶）
 * - urgency = 0（静默；D-AGENT-11 默认）
 * - payload = { attentionId, ruleId, priority, reason, eventId, source, decidedAt }
 * - source = 'action-executor'
 *
 * 严格不副作用：
 * - 不修改 Decision
 * - 不调 LLM
 * - 不发飞书
 * - 写档失败 → success=false（捕获异常，不抛）
 */
export function createRememberHandler(ctx: RememberActionContext): ActionHandler {
  return {
    name: 'remember',
    action: 'remember',
    async execute(decision: Decision): Promise<ActionResult> {
      try {
        const record = {
          namespace: 'decision-action',
          type: 'decision-remember',
          source: 'action-executor',
          urgency: 0 as const,
          payload: {
            attentionId: decision.attentionId,
            ruleId: decision.ruleId,
            priority: decision.priority,
            reason: decision.reason,
            eventId: decision.eventId,
            source: decision.source,
            decidedAt: decision.decidedAt,
          },
        }
        await ctx.store.append(record)
        return okResult(decision)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        ctx.logger?.warn('[action:remember] 写档失败: %s', detail)
        return failResult(decision, `remember failed: ${detail}`)
      }
    },
  }
}

/**
 * DeferActionContext —— defer handler 需要的最小依赖
 *
 * 第一版不依赖任何外部服务；仅持有一个 DeferredActionStore。
 * 外部可通过 store 参数注入自定义 store（测试用）。
 */
export interface DeferActionContext {
  /** Pending store（默认独立 in-memory 实例） */
  store?: DeferredActionStore
  /** Logger */
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

/**
 * deferHandler —— defer action 的 handler
 *
 * 行为：
 * - 入队到 DeferredActionStore
 * - 返回 success=true + metadata.pendingId
 * - Phase 4.B 第一版**不消费**（仅记录）
 * - Phase 4.C+ 真实 scheduler 接入后读 store.list() 消费
 *
 * 严格不副作用：
 * - 不写 infoStore
 * - 不发飞书
 * - 不调 LLM
 */
export function createDeferHandler(ctx: DeferActionContext = {}): ActionHandler {
  const store = ctx.store ?? createDeferredActionStore()
  return {
    name: 'defer',
    action: 'defer',
    async execute(decision: Decision): Promise<ActionResult> {
      try {
        const pendingId = store.enqueue(decision)
        return okResult(decision, { pendingId })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        ctx.logger?.warn('[action:defer] 入队失败: %s', detail)
        return failResult(decision, `defer failed: ${detail}`)
      }
    },
  }
}

/**
 * NotifyActionContext —— notify handler 需要的依赖（Phase 4.B 第一版仅 stub）
 *
 * 注：现有 FeishuClient.sendToChat 可作为后续真实 notify handler 的实现，
 * Phase 4.B 第一版**不直接调 FeishuClient**，原因：
 * 1. notify action 缺少必要字段（chatId / text）；直接用会过度耦合
 * 2. Phase 4.B 第一版要保证默认安全（未配置 handler 时不发送）
 * 3. 真实 notify handler 需要 ActionPlan 拆分（payload / channel / target），属 Phase 4.C+
 */
export interface NotifyActionContext {
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

/**
 * notifyStubHandler —— notify action 的默认 stub handler
 *
 * 行为：
 * - 始终 success=false
 * - error = "notification handler not configured"
 *
 * 安全语义：
 * - 不调用 FeishuClient
 * - 不调用任何外部通知 SDK
 * - 真实 notify handler 必须由 Phase 4.C+ 显式注册并配置 FeishuClient 依赖
 *
 * 设计动机（用户决策，2026-08-27）：
 * "如果现有项目没有成熟 notification service：不要自己重新实现 Feishu API。
 *  可以先提供一个明确的 notify handler stub：success = false + error = 'notification handler not configured'。
 *  不要伪造成功。"
 */
export function createNotifyStubHandler(ctx: NotifyActionContext = {}): ActionHandler {
  return {
    name: 'notify-stub',
    action: 'notify',
    async execute(decision: Decision): Promise<ActionResult> {
      ctx.logger?.warn(
        '[action:notify] notify handler not configured（Phase 4.B stub）。decisionId=%s ruleId=%s',
        decision.decisionId, decision.ruleId,
      )
      return failResult(decision, 'notification handler not configured')
    },
  }
}

/**
 * ActActionContext —— act handler 需要的依赖（Phase 4.B 第一版仅 stub）
 *
 * 严格安全约束（用户决策，2026-08-27）：
 * - act handler **禁止执行任意 shell / 任意 JS / 任意插件调用**
 * - 未配置 handler 时 success=false
 * - **绝对不要默认执行任意 command**
 *
 * 后续 act 真实实现必须经过：
 * 1. 显式注册 ActionHandler（不允许内部 fallback 调 InfoAgent / Plugin）
 * 2. ActionHandler 内部必须实现 D-AGENT-06 最小权限注入
 * 3. 调用任何 shell 都需经过白名单校验（属 Phase 4.C+）
 */
export interface ActActionContext {
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

/**
 * actStubHandler —— act action 的默认 stub handler
 *
 * 行为：
 * - 始终 success=false
 * - error = "action handler not configured"
 *
 * 这是最重要的安全边界。
 *
 * 设计动机（用户决策，2026-08-27）：
 * "act 必须经过显式注册的 ActionHandler。"
 * "不要为了测试而加入 fake shell executor。"
 */
export function createActStubHandler(ctx: ActActionContext = {}): ActionHandler {
  return {
    name: 'act-stub',
    action: 'act',
    async execute(decision: Decision): Promise<ActionResult> {
      ctx.logger?.warn(
        '[action:act] act handler not configured（Phase 4.B 安全 stub；禁止任意 shell）。decisionId=%s ruleId=%s',
        decision.decisionId, decision.ruleId,
      )
      return failResult(decision, 'action handler not configured')
    },
  }
}

// ── ActionExecutor 服务工厂 ─────────────────────────────────────────────

/**
 * ActionExecutorOptions —— Executor 创建参数
 *
 * 设计原则：
 * - registry / deferredStore 可由外部注入（测试用；默认使用内置实例）
 * - 外部可注册额外 handler（fire-and-forget）
 */
export interface ActionExecutorOptions {
  registry?: ActionHandlerRegistry
  deferredStore?: DeferredActionStore
}

/**
 * 工厂函数：创建 ActionExecutor 实例
 *
 * - 默认 registry 已注册 5 个内置 handler（noop/remember(defer-store)/defer/notify-stub/act-stub）
 * - remember handler 需要 RememberActionContext.store；无 ctx 时默认 success=false + error
 * - defer / notify-stub / act-stub 可独立构造
 *
 * 注意：Phase 4.B 第一版默认**不提供** remember handler（需要 ctx 注入 store）。
 * 调用方可在外层手动 register(createRememberHandler({ store })) 注入。
 */
export function createActionExecutor(opts: ActionExecutorOptions = {}): ActionExecutorService {
  const registry = opts.registry ?? createActionHandlerRegistry()
  const deferredStore = opts.deferredStore ?? createDeferredActionStore()

  // 默认注册安全 handler：
  // - noop / defer / notify-stub / act-stub 不依赖外部 ctx，进来即可用
  // - remember handler 需要 store 依赖，由调用方显式 register（如 plugin 装配时）
  registry.register(noopHandler)
  registry.register(createDeferHandler({ store: deferredStore }))
  registry.register(createNotifyStubHandler())
  registry.register(createActStubHandler())

  return {
    registry,
    deferredStore,

    async execute(decision: Decision): Promise<ActionResult> {
      const handler = registry.get(decision.action)
      if (!handler) {
        // 未知 action / 未注册 handler → 明确错误（不抛）
        return failResult(decision, `no handler registered for action: ${decision.action}`)
      }
      try {
        // handler.execute 内部应捕获自身异常；此处再 catch 一次作为兜底
        return await handler.execute(decision)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return failResult(decision, `handler ${handler.name} threw: ${detail}`)
      }
    },
  }
}
