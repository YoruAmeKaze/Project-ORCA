/**
 * Orca Cognitive Scheduler —— 认知调度层类型（Phase A）
 *
 * 职责：
 * - 接收 AttentionItem → 放入 pending 队列
 * - 管理 pending 队列（ephemeral，内存）
 * - 决定是否/何时产生 CognitiveRequest
 * - 发出 cognition:started / cognition:completed / cognition:failed 事件
 *
 * 核心语义：
 * - Scheduler 只负责"什么时候值得进行 cognition"
 * - Scheduler 不执行 cognition（CognitionCore 负责）
 * - Scheduler 不调用 LLM
 * - Scheduler 不直接执行 Action
 *
 * Phase A 约束：
 * - 不实现 priority scheduling（后续阶段）
 * - 不实现 sophisticated merge（后续阶段）
 * - 不实现 token budget optimizer（后续阶段）
 * - 不实现 automatic defer policy（后续阶段）
 *
 * 与其他组件的关系：
 * - AttentionEngine → 产生 AttentionItem → 发给 Scheduler.enqueue()
 * - Scheduler → 决策是否启动 Cognition → 发出 'orca/cognition-request'
 * - CognitionCore（未来）→ 消费 'orca/cognition-request' → 执行认知循环
 * - DecisionEngine → 订阅 'orca/attention'（Phase A 保持向后兼容）
 */

import type { AttentionItem } from './attention.js'

/**
 * CognitiveRequest —— Scheduler 产生的认知请求
 *
 * 设计原则：
 * - id: 稳定唯一 ID（追溯用）
 * - attentions: 导致此次请求的 AttentionItem 列表（可以是一个或多个）
 * - createdAt: 请求创建时间戳
 * - trigger: 触发原因描述（调试用）
 *
 * 携带：
 * - sessionId：外部通道会话边界（不是 CognitionSession.id）
 *
 * 不携带：
 * - 不携带"如何执行"的细节（CognitionCore 决定）
 * - 不携带预计算的 context（CognitionCore 自行获取）
 */
export interface CognitiveRequest {
  /** 稳定唯一 ID（debug / 追溯） */
  id: string
  /** 导致此次请求的 AttentionItem 列表 */
  attentions: AttentionItem[]
  /** 请求创建时间戳 */
  createdAt: number
  /** 触发原因描述（调试用） */
  trigger: string
  /** 外部通道会话标识；同一通道会话下的 attention 才会被合并 */
  sessionId?: string
}

/**
 * CognitiveSchedulerService —— 认知调度服务接口
 *
 * Phase A 职责（最小可用）：
 * - enqueue(attention: AttentionItem)：接收 AttentionItem 入队
 * - getPendingCount()：返回当前 pending 数量（测试/监控用）
 * - isCognitionRunning()：返回当前是否有进行中的认知
 * - getActiveSessionId()：返回当前活跃 session ID（null if none）
 * - destroy()：清理事件订阅（dispose 钩子调用）
 *
 * 不做（Phase A）：
 * - 不实现优先级调度
 * - 不实现合并策略
 * - 不实现延迟策略
 * - 不实现 budget 计算
 *
 * 生命周期事件（通过 EventBus）：
 * - 'cognition/started'：CognitionCore 开始认知时
 * - 'cognition/completed'：CognitionCore 完成认知时
 * - 'cognition/failed'：CognitionCore 失败时
 *
 * 这些事件由 Scheduler 订阅，供 Scheduler 维护 isCognitionRunning 状态。
 */
export interface CognitiveSchedulerService {
  /**
   * 接收 AttentionItem 入队（pending queue）。
   * Scheduler 内部维护队列，不修改 AttentionItem。
   */
  enqueue(attention: AttentionItem): void

  /**
   * 当前 pending 队列中的 AttentionItem 数量（测试/监控用）。
   */
  getPendingCount(): number

  /**
   * 当前是否有进行中的认知（CognitionCore 未完成）。
   * 由 'cognition/started' / 'cognition/completed' / 'cognition/failed' 事件维护。
   */
  isCognitionRunning(): boolean

  /**
   * 当前活跃的 cognition session ID（如果没有进行中的 cognition，返回 null）。
   */
  getActiveSessionId(): string | null

  /**
   * 销毁函数（清理 cognition 生命周期事件订阅）。
   * Cordis plugin 的 dispose 钩子应调用此函数。
   */
  destroy(): void
}
