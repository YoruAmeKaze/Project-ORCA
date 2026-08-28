/**
 * Orca Decision Engine —— 纯函数决策层（Phase 4.A）
 *
 * 职责：
 * - AttentionItem → Decision（1:1 映射；纯函数）
 * - Action 翻译（AttentionItem.action → Decision.action）
 * - 透传 priority / reason / eventId / source / ruleId
 *
 * 严格无副作用（R13.9 测试保证）：
 * - ❌ 不发飞书
 * - ❌ 不写 infoStore
 * - ❌ 不调 agent / InfoAgent
 * - ❌ 不调 LLM
 * - ❌ 不执行 shell / 不读文件系统
 * - ❌ 不读 WorldState / EventBus
 * - ❌ 不持久化（无文件 / 无外部缓存）
 *
 * 设计原则（与 Attention 严格分层）：
 * - 不重新判断 priority（透传）
 * - 不重新评估"是否值得关注"（Attention 已决定）
 * - 不排序（按调用顺序返回）
 * - 不持久化（与 Attention 一致）
 *
 * 不做（Phase 4.A 范围外）：
 * - 不执行 action（Phase 4.B ActionExecutor）
 * - 不排重 / 不节流（如需再 dedup/throttle 在 ActionExecutor 层做）
 * - 不持久化
 * - 不 LLM 增强
 */

import { randomUUID } from 'node:crypto'
import type { AttentionAction, AttentionItem } from '../types/attention.js'
import type {
  Decision,
  DecisionAction,
  DecisionEngineService,
} from '../types/decision.js'

/**
 * AttentionItem.action → Decision.action 映射
 *
 * 已知 5 条 AttentionAction 翻译为具体决策动作；
 * 未知 AttentionAction（自定义 string）透传原值（fail-soft；便于未来扩展）。
 */
function mapAction(attentionAction: AttentionAction): DecisionAction {
  switch (attentionAction) {
    case 'notify_immediately':   return 'notify'
    case 'remember_only':        return 'remember'
    case 'wait_until_available': return 'defer'
    case 'act':                  return 'act'
    case 'ignore':               return 'no_action'
    default:                     return attentionAction  // 未知 → 透传
  }
}

/**
 * 工厂函数：创建 DecisionEngine 实例（纯函数闭包；无外部状态）
 *
 * 使用方式：
 * ```ts
 * const engine = createDecisionEngine()
 * const decision = engine.decide(attentionItem)
 * // 或批量：
 * const decisions = engine.decideMany(items)
 * ```
 */
export function createDecisionEngine(): DecisionEngineService {
  // 把 decide 抽成闭包内函数（避免在对象字面量方法中依赖 this）
  const decide = (item: AttentionItem): Decision => {
    return {
      decisionId: randomUUID(),
      attentionId: item.id,
      ruleId: item.ruleId,
      action: mapAction(item.action),
      priority: item.priority,
      reason: item.reason,
      eventId: item.eventId,
      source: item.source,
      decidedAt: Date.now(),
    }
  }

  return {
    decide,
    decideMany(items: AttentionItem[]): Decision[] {
      // 保留输入顺序；不排序（Phase 4.B ActionExecutor 才决定顺序）
      return items.map(decide)
    },
  }
}
