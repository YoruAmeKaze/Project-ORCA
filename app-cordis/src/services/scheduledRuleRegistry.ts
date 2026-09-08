/**
 * ScheduledRuleRegistry 服务（Phase 7.1B）
 *
 * 职责：
 * - 管理 ScheduledRule 集合
 * - 接收 scheduler:tick 事件
 * - 评估每个 rule 的 predicate
 * - 命中时通过 EventBus emit businessEvent
 *
 * 设计原则：
 * - Registry 是"业务规则层"，不持有 timer（timer 在 SchedulerAdapter）
 * - scheduler:tick 是唯一触发信号
 * - rule 只负责"判断 + 发射业务事件"
 * - businessEvent 通过 EventBus.publish() 发射，进入现有 EventBus → WorldState → AttentionEngine 流水线
 *
 * 事件流向：
 *   SchedulerAdapter → scheduler:tick → evaluate(tick) → predicate → EventBus.publish(businessEvent)
 *                                                                              ↓
 *                                                                    WorldStateUpdater（无 reducer → 忽略）
 *                                                                              ↓
 *                                                                    AttentionEngine（businessEvent 触发评估）
 */

import type { EventBus } from './eventBus.js'
import type { OrcaEvent, OrcaEventPriority } from '../types/event.js'
import type {
  ScheduledRule,
  ScheduledRuleContext,
  ScheduledRulePredicate,
  ScheduledRuleRegistry,
  ScheduledBusinessEvent,
} from '../types/scheduled-rule.js'

/**
 * ScheduledRuleRegistry 日志接口
 */
export interface ScheduledRuleRegistryLogger {
  info: (msg: string, ...args: unknown[]) => void
  warn: (msg: string, ...args: unknown[]) => void
}

/**
 * 创建 ScheduledRuleRegistry
 *
 * @param eventBus EventBus（用于发射 businessEvent）
 * @param logger 日志接口（可选）
 * @returns ScheduledRuleRegistryService 实例（含内部 _evaluate）
 */
export function createScheduledRuleRegistry(
  eventBus: EventBus,
  logger?: ScheduledRuleRegistryLogger,
): ScheduledRuleRegistryService {
  // ruleId → ScheduledRule
  const rules = new Map<string, ScheduledRule>()
  // ruleId → lastTriggeredAt（毫秒时间戳）
  const lastTriggeredAt = new Map<string, number>()

  /**
   * 评估所有规则
   *
   * @param tick 当前 scheduler:tick 事件
   * @returns 触发的 rule 数量
   */
  function evaluate(tick: OrcaEvent): number {
    let triggered = 0
    for (const [ruleId, rule] of rules) {
      const ctx: ScheduledRuleContext = {
        tick,
        lastTriggeredAt: lastTriggeredAt.get(ruleId) ?? 0,
      }
      try {
        if (rule.predicate(ctx)) {
          // 触发：更新 lastTriggeredAt
          lastTriggeredAt.set(ruleId, tick.timestamp)
          // 通过 EventBus 发射 businessEvent
          eventBus.publish({
            source: rule.businessEvent.source,
            type: rule.businessEvent.type,
            data: rule.businessEvent.data ?? {},
            priority: (rule.businessEvent.priority ?? 1) as OrcaEventPriority,
          })
          triggered++
          logger?.info(
            '[scheduled-rule-registry] rule %s 触发 → emit %s:%s',
            ruleId,
            rule.businessEvent.source,
            rule.businessEvent.type,
          )
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        logger?.warn('[scheduled-rule-registry] rule %s predicate 异常: %s', ruleId, detail)
      }
    }
    return triggered
  }

  return {
    register(rule: ScheduledRule): void {
      // 同 id 覆盖（便于热更新）
      rules.set(rule.ruleId, rule)
      logger?.info(
        '[scheduled-rule-registry] 注册 rule: id=%s, businessEvent=%s:%s',
        rule.ruleId,
        rule.businessEvent.source,
        rule.businessEvent.type,
      )
    },

    unregister(ruleId: string): boolean {
      const existed = rules.has(ruleId)
      rules.delete(ruleId)
      lastTriggeredAt.delete(ruleId)
      if (existed) {
        logger?.info('[scheduled-rule-registry] 注销 rule: id=%s', ruleId)
      }
      return existed
    },

    size(): number {
      return rules.size
    },

    ruleIds(): string[] {
      return Array.from(rules.keys())
    },

    // 内部方法，供 plugin 调用（暴露在 ScheduledRuleRegistryService 接口中）
    _evaluate(tick: OrcaEvent): number {
      return evaluate(tick)
    },
  }
}

/**
 * ScheduledRuleRegistry 增强接口（含内部 evaluate）
 */
export interface ScheduledRuleRegistryService extends ScheduledRuleRegistry {
  /** 评估所有规则（内部方法） */
  _evaluate(tick: OrcaEvent): number
}
