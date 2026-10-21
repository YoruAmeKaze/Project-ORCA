/**
 * ReminderIntervalRule —— 通用提醒触发规则（Phase 7.1B）
 *
 * 职责：
 * - 判断"是否到提醒触发时间"（基于 lastTriggeredAt 间隔判断）
 * - 命中时 emit `reminder:due`（source='scheduler'）
 *
 * 设计原则：
 * - Rule 只负责"判断"，不实现真正的 reminder 系统
 * - 不调用 LLM / AttentionEngine / DecisionEngine / ActionExecutor
 * - 通过 EventBus 发射 `reminder:due` 事件
 * - reminder 内容生成 / 任务数据库 / 用户配置由后续 phase 负责
 *
 * `reminderIntervalMs`：
 * - 两次 reminder:due 的最小间隔
 * - lastTriggeredAt === 0（从未触发）时立即触发
 */

import type { ScheduledRule, ScheduledRuleContext } from '../../types/scheduled-rule.js'

/**
 * 创建 ReminderIntervalRule
 *
 * @param ruleId 规则 id
 * @param reminderIntervalMs 最小触发间隔（毫秒）
 * @returns ScheduledRule
 */
export function createReminderIntervalRule(
  ruleId: string,
  reminderIntervalMs: number,
): ScheduledRule {
  return {
    ruleId,
    predicate: (ctx: ScheduledRuleContext): boolean => {
      if (ctx.lastTriggeredAt === 0) {
        // 从未触发，立即触发
        return true
      }
      const elapsed = ctx.tick.timestamp - ctx.lastTriggeredAt
      return elapsed >= reminderIntervalMs
    },
    businessEvent: {
      source: 'scheduler',
      type: 'reminder:due',
      data: { ruleId },
      priority: 2,
    },
  }
}
