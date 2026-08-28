/**
 * Orca Action Executor —— 执行层类型（Phase 4.B）
 *
 * 设计动机：
 * - Decision 已决定"应该采取什么策略"（Phase 4.A 纯翻译）
 * - ActionExecutor 决定"具体怎么执行这个已经决定的动作"
 * - 严格分层：Executor **不**重新评估 Decision / Attention / WorldState
 *
 * 四层职责分离（最终）：
 * - AttentionEngine：判断事件是否值得关注（**是什么**）
 * - DecisionEngine： 把 AttentionItem 翻译为 Decision（**怎么做**）
 * - ActionExecutor： 找到对应 ActionHandler 执行（**真做**）
 * - ActionHandler：   单个 action 的具体实现（**怎么真做**）
 *
 * 与 Decision 的关系：
 * - Decision.action 是"已经决定要做什么"的行动方向（5 个枚举）
 * - ActionHandler 是该方向的"具体实现"
 * - Executor 维护 ActionHandlerRegistry，按 action 查找 handler
 *
 * 关系图：
 * ```
 *   Attention → Decision → ActionExecutor → ActionHandler → 副作用
 *                                              ↓
 *                                          ActionResult
 *                                              ↓
 *                                          emit('orca/action-result')
 * ```
 */

import type { Decision, DecisionAction } from './decision.js'

/**
 * ActionHandler —— 单个 action 的具体实现
 *
 * 关键约束（用户决策，2026-08-27）：
 * - 任何 handler 默认禁止执行任意 shell / 任意 JS / 任意插件调用
 * - act handler **必须经过显式注册**；未配置 handler 时返回 success=false
 * - 不允许 fake shell executor
 */
export interface ActionHandler {
  /** 该 handler 处理的 action（一个 handler 一个 action） */
  action: DecisionAction
  /**
   * 执行该 action。
   *
   * 实现要求：
   * - 返回 Promise<ActionResult>（不抛异常给 caller；异常应在内部捕获并转化为 ActionResult.error）
   * - **不修改入参 Decision**（保持上游不可变）
   * - **不修改 AttentionItem / WorldState**
   * - **不调用 LLM 重新判断是否执行**
   */
  execute(decision: Decision): Promise<ActionResult>
  /**
   * handler 名称（debug / 日志用；不参与逻辑）。
   * 同 action 可注册多个 handler，但只有最后一个生效（Last-Write-Wins；Registry 维护）。
   */
  name: string
}

/**
 * ActionResult —— Phase 4.B 执行结果
 *
 * 设计原则：
 * - 必须包含 decisionId（back-trace 到 Decision）
 * - 必须包含 action（明确哪个 action 的结果）
 * - success / error 二选一关键信息
 * - executedAt 是执行完成时间戳（不一定是开始时间；handler 可自行 startAt）
 * - metadata 可选（不强制；handler 可写入 token / recordId / sentMessageId 等可追溯信息）
 *
 * 关键约束：
 * - Executor 不修改 Decision；ActionResult 是独立产物
 * - Executor 异常必须被捕获并转换为 success=false + error
 * - 不返回部分成功（避免下游误判）
 */
export interface ActionResult {
  /** 是否执行成功 */
  success: boolean
  /** 该 result 归属的 action（透传 Decision.action） */
  action: DecisionAction
  /** 关联 Decision.decisionId（back-trace 锚点） */
  decisionId: string
  /** 错误描述（仅 success=false 时存在） */
  error?: string
  /** 执行完成时间戳 */
  executedAt: number
  /**
   * 可选元数据（handler 私有；不强求字段）。
   * 示例：
   * - remember handler → { recordId, namespace }
   * - defer handler    → { pendingId }
   * - notify handler   → { messageId }（成功后才有）
   * - noop handler     → 可省略
   */
  metadata?: Record<string, unknown>
}

/**
 * ActionHandlerRegistry —— handler 注册表
 *
 * 职责：
 * - register(handler) —— 注册或覆盖（Last-Write-Wins）
 * - unregister(action) —— 注销
 * - get(action)        —— 查找
 * - list()             —— 列出所有已注册（debug 用）
 *
 * 严格无副作用（除 register/unregister 本身）：
 * - 不执行 handler
 * - 不持久化
 * - 不读 ctx 服务
 */
export interface ActionHandlerRegistry {
  /**
   * 注册 handler。同 action 重复注册会**覆盖**（Last-Write-Wins）。
   * 不抛错；handler 应通过 name 字段自描述。
   */
  register(handler: ActionHandler): void
  /**
   * 注销 action 对应 handler。action 不存在不报错。
   */
  unregister(action: DecisionAction): void
  /**
   * 获取 action 对应 handler。返回 undefined 表示未注册。
   */
  get(action: DecisionAction): ActionHandler | undefined
  /**
   * 列出所有已注册 handler（按 action）。debug 用。
   */
  list(): ActionHandler[]
  /**
   * 当前已注册 handler 数。
   */
  size(): number
  /**
   * 清空所有 handler（dispose / 测试用）。
   */
  clear(): void
}

/**
 * DeferredActionEntry —— 内存 pending store 单条记录（Phase 4.B 第一版）
 *
 * 设计动机：
 * - defer action 在 Phase 4.B 第一版**不实现**真实 scheduler
 * - 仅记录到内存 pending store，便于后续 Phase 4.C+ 接入真正调度
 * - 当前 Phase 不消费 pending（仅记录）
 *
 * 严格无副作用：
 * - 不持久化（重启即失）
 * - 不调度（仅 in-memory 存储 + 查询接口）
 */
export interface DeferredActionEntry {
  /** 唯一 pending ID（debug / 关联用） */
  pendingId: string
  /** 触发该 entry 的 Decision */
  decision: Decision
  /** 入队时间戳 */
  queuedAt: number
}

/**
 * DeferredActionStore —— 内存 pending store 接口
 *
 * 严格约束（Phase 4.B 第一版）：
 * - 仅 in-memory（不持久化）
 * - 不消费 / 不调度（pendingId 永远不会被自动删除）
 * - 提供 list() / get() 查询接口供 Phase 4.C+ 接入真实 scheduler
 */
export interface DeferredActionStore {
  /** 入队（返回生成的 pendingId） */
  enqueue(decision: Decision): string
  /** 按 pendingId 查询 */
  get(pendingId: string): DeferredActionEntry | undefined
  /** 列出所有 pending（按 queuedAt 正序） */
  list(): DeferredActionEntry[]
  /** 当前 pending 数 */
  size(): number
  /** 清空（dispose / 测试用） */
  clear(): void
}

/**
 * ActionExecutor —— Phase 4.B 执行层服务
 *
 * 职责：
 * - execute(decision: Decision) → Promise<ActionResult>
 * - 内部按 decision.action 查找 ActionHandler 并调用 handler.execute()
 * - 捕获 handler 异常 → 转换为 success=false ActionResult（不向 caller 抛）
 * - 未知 action 或未注册 handler → 返回 success=false + 明确 error
 *
 * 严格分层（关键约束）：
 * - **不**重新评估 Attention 规则
 * - **不**重新判断 priority
 * - **不**修改 Decision / AttentionItem / WorldState
 * - **不**调用 LLM 重新判断是否执行
 * - **不**持久化（ActionResult 仅 emit 到 event bus）
 *
 * 不做（Phase 4.B 范围外）：
 * - 不排序（按调用顺序）
 * - 不排重 / 不节流（ActionPlan 职责；Phase 4.C+）
 * - 不持久化
 * - 不 LLM 增强
 */
export interface ActionExecutorService {
  /**
   * 执行单个 Decision。
   * 总是返回 ActionResult（即便 handler 未注册 / handler 抛异常）。
   */
  execute(decision: Decision): Promise<ActionResult>
  /**
   * 暴露 registry（便于外部挂载额外 handler；fire-and-forget 不阻塞主调用）。
   */
  registry: ActionHandlerRegistry
  /**
   * 暴露 DeferredActionStore（仅 defer handler 使用；Phase 4.C+ 真实 scheduler 也读）。
   */
  deferredStore: DeferredActionStore
}
