/**
 * Orca Decision Engine —— 决策层类型（Phase 4.A）
 *
 * 设计动机：
 * - Attention 已决定"事件值得 Orca 消耗注意力"（**关注"是什么"**）
 * - Decision 决定"Orca 接下来应该采取什么策略"（**关注"具体怎么做"**）
 * - 严格分层：Decision **不**重新执行 Attention 规则，只消费 AttentionItem 产出 Decision
 *
 * 三层职责分离（持续维护）：
 * - AttentionEngine：判断事件是否值得关注 + 产生 AttentionItem（**是什么**）
 * - DecisionEngine： 把 AttentionItem.action 翻译为具体决策（**怎么做**）
 * - ActionExecutor：  执行 Decision（**真正去做**；Phase 4.B）
 *
 * 与 AttentionItem.action 的关系：
 * - AttentionItem.action 是**建议**（notify_immediately / remember_only / wait_until_available / act / ignore）
 * - Decision.action 是**决定**（notify / remember / defer / act / no_action）—— 更具体、更落地
 * - 不存在反向引用（Decision 不修改 AttentionItem；只通过 attentionId 引用）
 *
 * 关系图：
 * ```
 *   EventBus → WorldState → AttentionEngine → emit('orca/attention')
 *                                              ↓ AttentionItem[]
 *                                          DecisionEngine.decide()
 *                                              ↓ Decision[]
 *                                          emit('orca/decision')
 *                                              ↓
 *                                          [Phase 4.B ActionExecutor]
 * ```
 */

import type {
  AttentionAction,
  AttentionItem,
  AttentionPriority,
} from './attention.js'

/**
 * Decision 行动方向（Phase 4.A 第一版）
 *
 * AttentionItem.action（建议）→ Decision.action（决定）的映射：
 * - notify_immediately → notify       （推送：飞书 / Bark）
 * - remember_only      → remember     （入档：infoStore）
 * - wait_until_available → defer      （等待：用户可用时合并通知）
 * - act                → act          （执行：调用 InfoAgent / plugin）
 * - ignore             → no_action    （不做任何事）
 *
 * 真实执行属 Phase 4.B ActionExecutor。Phase 4.A 只翻译 / 不执行。
 */
export const ORCA_DECISION_ACTIONS = [
  'notify',       // AttentionItem.action 'notify_immediately' → 推送（飞书 / Bark）
  'remember',     // AttentionItem.action 'remember_only' → 入档（infoStore）
  'defer',        // AttentionItem.action 'wait_until_available' → 等待用户可用时合并通知
  'act',          // AttentionItem.action 'act' → 调用 InfoAgent / plugin 执行
  'no_action',    // AttentionItem.action 'ignore' → 不做任何事
] as const

export type DecisionAction = (typeof ORCA_DECISION_ACTIONS)[number] | (string & {})

/**
 * Decision —— Phase 4.A 决策层产物
 *
 * 设计原则：
 * - **不修改 AttentionItem**（保留上游语义；只通过 attentionId 引用）
 * - priority / reason / eventId / source 从 AttentionItem **透传**（不重新判断）
 * - attentionId 指向 AttentionItem.id（back-trace）
 * - decisionId 是 Decision 自身的稳定唯一 ID（debug / 追溯）
 * - action 是"已经决定要做什么"的**具体**行动（不再是建议）
 *
 * 不携带：
 * - "如何执行"的细节（payload / channel / target）—— ActionPlan 职责（Phase 4.B）
 * - 执行时间 / 执行者（ActionExecutor 决定）
 * - LLM 评分（Phase 5+）
 */
export interface Decision {
  /** Decision 自身稳定唯一 ID（debug / 追溯） */
  decisionId: string
  /** 触发决策的 AttentionItem.id（back-trace） */
  attentionId: string
  /** 触发决策的 AttentionItem.ruleId（便于不读上游也能定位规则） */
  ruleId: string
  /** 具体行动（已映射 AttentionItem.action → 落地动作） */
  action: DecisionAction
  /** 紧急度（从 AttentionItem 透传；Phase 4.A 不重新判断） */
  priority: AttentionPriority
  /** 决策原因（从 AttentionItem 透传） */
  reason: string
  /** 触发源事件 ID（从 AttentionItem 透传；state-only 时 undefined） */
  eventId?: string
  /** 触发 source（从 AttentionItem 透传） */
  source?: string
  /** 决策时间戳 */
  decidedAt: number
}

/**
 * DecisionEngine —— Phase 4.A 决策层服务
 *
 * 职责：
 * - decide(item: AttentionItem) → Decision（1:1 映射）
 * - decideMany(items: AttentionItem[]) → Decision[]（保留顺序）
 *
 * 严格分层 / 无副作用：
 * - **纯函数** —— 不发飞书 / 不写 infoStore / 不调 agent / 不调 LLM / 不执行 shell
 * - **不读 WorldState / EventBus / 文件系统** —— 输入只来自 AttentionItem
 * - **不重新判断 priority** —— priority 从 AttentionItem 透传
 * - **不重新评估"是否值得关注"** —— Attention 已决定；这里只决定"具体做什么"
 * - **不排序** —— 按调用顺序返回（Phase 4.B ActionExecutor 才决定顺序）
 * - **不持久化** —— 重启即失（与 Attention 一致）
 *
 * 行为映射（AttentionItem.action → Decision.action）：
 * - notify_immediately  → notify
 * - remember_only       → remember
 * - wait_until_available → defer
 * - act                 → act
 * - ignore              → no_action
 * - 未知 AttentionAction → 透传原值（fail-soft；不抛错；便于未来扩展）
 *
 * 不做（Phase 4.A 范围外）：
 * - 不执行 action（Phase 4.B ActionExecutor）
 * - 不排重 / 不节流（Phase 4.A 只翻译；如需再 dedup/throttle 在 ActionExecutor 层做）
 * - 不持久化
 * - 不 LLM 增强
 * - 不 ActionPlan 拆分（必要时由 Phase 4.B 引入）
 */
export interface DecisionEngineService {
  /** 把单个 AttentionItem 翻译为 Decision */
  decide(item: AttentionItem): Decision
  /** 批量翻译（保留输入顺序，不排序） */
  decideMany(items: AttentionItem[]): Decision[]
}
