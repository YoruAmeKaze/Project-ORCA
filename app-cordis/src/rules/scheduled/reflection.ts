/**
 * ReflectionIntervalRule —— 反思触发规则（Phase 7.1B）
 *
 * 职责：
 * - 判断"是否到反思触发时间"（基于 lastTriggeredAt 间隔判断）
 * - 命中时 emit `reflection:due`（source='scheduler'）
 *
 * 设计原则：
 * - Rule 只负责"判断"，不生成 reflection 内容
 * - 不调用 LLM / AttentionEngine / DecisionEngine
 * - 通过 EventBus 发射 `reflection:due` 事件
 * - 反思内容生成由 ReflectionEngine 负责（Phase 7.1B 后续）
 *
 * `reflectionIntervalMs`：
 * - 两次 reflection:due 的最小间隔
 * - lastTriggeredAt === 0（从未触发）时立即触发
 */

import type { ScheduledRule, ScheduledRuleContext } from '../../types/scheduled-rule.js'

/**
 * 创建 ReflectionIntervalRule
 *
 * @param ruleId 规则 id
 * @param reflectionIntervalMs 最小触发间隔（毫秒）
 * @returns ScheduledRule
 */
export function createReflectionIntervalRule(
  ruleId: string,
  reflectionIntervalMs: number,
): ScheduledRule {
  return {
    ruleId,
    predicate: (ctx: ScheduledRuleContext): boolean => {
      if (ctx.lastTriggeredAt === 0) {
        // 从未触发，立即触发
        return true
      }
      const elapsed = ctx.tick.timestamp - ctx.lastTriggeredAt
      return elapsed >= reflectionIntervalMs
    },
    businessEvent: {
      source: 'scheduler',
      type: 'reflection:due',
      data: { ruleId },
      priority: 2,
    },
  }
}
