/**
 * Scheduled Rules Factory（Phase 7.2）
 *
 * 职责：
 * - 读取配置（OrcaScheduledRulesConfig）
 * - 创建 enabled 的 ScheduledRule 实例
 * - 返回 Rule 数组供 Registry.register() 调用
 *
 * 边界：
 * - Factory 不持有 timer（timer 在 SchedulerAdapter）
 * - Factory 不注册规则（由调用方负责 Registry.register()）
 * - Factory 不订阅 EventBus
 *
 * 配置格式（Phase 7.2）：
 *   ORCA_SCHEDULER_BRIEFING_ENABLED=1
 *   ORCA_SCHEDULER_BRIEFING_INTERVAL_MS=14400000
 *   ORCA_SCHEDULER_REFLECTION_ENABLED=1
 *   ORCA_SCHEDULER_REFLECTION_INTERVAL_MS=86400000
 *   ORCA_SCHEDULER_REMINDER_ENABLED=0
 *   ORCA_SCHEDULER_REMINDER_INTERVAL_MS=3600000
 */

import type { OrcaScheduledRulesConfig } from '../../config.js'
import type { ScheduledRule } from '../../types/scheduled-rule.js'
import { createBriefingIntervalRule } from './briefing.js'
import { createReflectionIntervalRule } from './reflection.js'
import { createReminderIntervalRule } from './reminder.js'

/**
 * 根据配置创建所有 enabled 的 ScheduledRule
 *
 * @param config OrcaScheduledRulesConfig（或 undefined）
 * @returns ScheduledRule[]（仅 enabled 的规则）
 */
export function createScheduledRulesFromConfig(
  config?: OrcaScheduledRulesConfig,
): ScheduledRule[] {
  const rules: ScheduledRule[] = []

  // Briefing rule
  const briefing = config?.briefing
  if (briefing?.enabled) {
    rules.push(
      createBriefingIntervalRule(
        'scheduled-briefing',
        briefing.intervalMs ?? 4 * 60 * 60 * 1000, // 默认 4h
      ),
    )
  }

  // Reflection rule
  const reflection = config?.reflection
  if (reflection?.enabled) {
    rules.push(
      createReflectionIntervalRule(
        'scheduled-reflection',
        reflection.intervalMs ?? 24 * 60 * 60 * 1000, // 默认 24h
      ),
    )
  }

  // Reminder rule
  const reminder = config?.reminder
  if (reminder?.enabled) {
    rules.push(
      createReminderIntervalRule(
        'scheduled-reminder',
        reminder.intervalMs ?? 60 * 60 * 1000, // 默认 1h
      ),
    )
  }

  return rules
}
