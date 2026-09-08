/**
 * BriefingIntervalRule —— 简报触发规则（Phase 7.1B）
 *
 * 职责：
 * - 判断"是否到触发时间"（基于 lastTriggeredAt 间隔判断）
 * - 命中时 emit `briefing:due`（source='scheduler'）
 *
 * 设计原则：
 * - Rule 只负责"判断"，不生成 briefing 内容
 * - 不调用 LLM / AttentionEngine / DecisionEngine
 * - 通过 EventBus 发射 `briefing:due` 事件
 * - 内容生成由 Phase 7.1B 后续或其他系统负责
 *
 * `briefingIntervalMs`：
 * - 两次 briefing:due 的最小间隔
 * - lastTriggeredAt === 0（从未触发）时立即触发
 */

import type { ScheduledRule, ScheduledRuleContext } from '../../types/scheduled-rule.js'

/**
 * 创建 BriefingIntervalRule
 *
 * @param ruleId 规则 id
 * @param briefingIntervalMs 最小触发间隔（毫秒）
 * @returns ScheduledRule
 */
export function createBriefingIntervalRule(
  ruleId: string,
  briefingIntervalMs: number,
): ScheduledRule {
  return {
    ruleId,
    predicate: (ctx: ScheduledRuleContext): boolean => {
      if (ctx.lastTriggeredAt === 0) {
        // 从未触发，立即触发
        return true
      }
      const elapsed = ctx.tick.timestamp - ctx.lastTriggeredAt
      return elapsed >= briefingIntervalMs
    },
    businessEvent: {
      source: 'scheduler',
      type: 'briefing:due',
      data: { ruleId },
      priority: 2,
    },
  }
}
