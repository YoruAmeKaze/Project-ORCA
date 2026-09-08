/**
 * ScheduledRuleRegistry Plugin —— Cordis integration（Phase 7.1B）
 *
 * 职责：
 * - 创建 ScheduledRuleRegistry 实例
 * - 订阅 EventBus 的 `scheduler:tick` 事件
 * - 每个 tick → registry._evaluate(tick) → predicate → EventBus.publish(businessEvent)
 * - 提供 ctx.scheduledRuleRegistry service
 * - 返回 dispose 钩子（unsubscribe）
 *
 * 设计原则（GPT Review Phase 7.0）：
 * - Registry 是"业务规则层"，不持有 timer（timer 在 SchedulerAdapter）
 * - businessEvent 通过 EventBus.publish() 发射，进入现有流水线：
 *   EventBus → WorldStateUpdater（无 reducer → 忽略）→ AttentionEngine
 * - 不直接调用 AttentionEngine / DecisionEngine / ActionExecutor
 *
 * 第一版（Phase 7.1B）：
 * - 注册一个 deterministic test rule（`test-rule-always-trigger`）
 * - predicate 始终返回 true，每 tick 都触发
 * - 用于验证 `scheduler:tick → rule hit → business event` 闭环
 *
 * 不做（Phase 7.1B 范围外）：
 * - Morning Briefing / Reflection / Reminder 等具体业务规则
 * - LLM-based scheduling
 * - External Services Gateway
 *
 * Cordis quirk 防护：
 * - inject = ['eventBus']
 * - listener try/catch
 * - disposed flag
 *
 * 挂载时序：
 * - ScheduledRuleRegistry 必须在 SchedulerAdapter 之后挂载（依赖 scheduler:tick 事件）
 * - 但 EventBus 是共享的，无需严格顺序（无事件时 evaluate 是空操作）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { EventBus } from '../services/eventBus.js'
import { createScheduledRuleRegistry } from '../services/scheduledRuleRegistry.js'
import type { ScheduledRuleRegistryService } from '../services/scheduledRuleRegistry.js'
import type { OrcaEvent } from '../types/event.js'
import type { ScheduledRule } from '../types/scheduled-rule.js'

/**
 * 默认 test rule（Phase 7.1B 验证用）
 *
 * predicate 始终返回 true，每 tick 都触发 `briefing:due`。
 * 用于验证完整链路：
 *   scheduler:tick → test rule → briefing:due
 */
const TEST_RULE_ALWAYS_TRIGGER: ScheduledRule = {
  ruleId: 'test-rule-always-trigger',
  predicate: () => true,
  businessEvent: {
    source: 'scheduler',
    type: 'briefing:due',
    data: { triggeredBy: 'test-rule-always-trigger' },
    priority: 2,
  },
}

/**
 * ScheduledRuleRegistry Cordis plugin
 */
export function scheduledRuleRegistry(ctx: Context, _config: OrcaConfig) {
  const bus = ctx.eventBus

  if (!bus) {
    ctx.logger.warn('[scheduled-rule-registry] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return
  }

  // 1. 创建 ScheduledRuleRegistry
  const registry: ScheduledRuleRegistryService = createScheduledRuleRegistry(bus, {
    info: ctx.logger.info.bind(ctx.logger),
    warn: ctx.logger.warn.bind(ctx.logger),
  })

  // 2. 注册默认 test rule（Phase 7.1B 验证用）
  registry.register(TEST_RULE_ALWAYS_TRIGGER)

  // 3. 提供 service
  ctx.provide('scheduledRuleRegistry', registry)

  ctx.logger.info(
    '[scheduled-rule-registry] 已启动（%d 规则 registered）',
    registry.size(),
  )

  // 4. 订阅 EventBus：每个 scheduler:tick → evaluate
  let disposed = false
  const unsubscribe = bus.subscribe(
    { source: 'scheduler', type: 'scheduler:tick', minPriority: 0 },
    (tick: OrcaEvent) => {
      if (disposed) return
      try {
        const triggered = registry._evaluate(tick)
        if (triggered > 0) {
          ctx.logger.info(
            '[scheduled-rule-registry] tick#%d 触发 %d 条规则',
            tick.data?.tickCount ?? '?',
            triggered,
          )
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        ctx.logger.warn('[scheduled-rule-registry] evaluate 异常: %s', detail)
      }
    },
  )

  // 5. dispose 钩子
  return () => {
    disposed = true
    unsubscribe()
    ctx.logger.info('[scheduled-rule-registry] 已关闭（unsubscribe）')
  }
}

/**
 * 必需依赖：EventBus。cordis inject 门控。
 */
scheduledRuleRegistry.inject = ['eventBus']
