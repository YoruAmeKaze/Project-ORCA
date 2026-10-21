/**
 * ScheduledRule —— 定时规则抽象（Phase 7.1B）
 *
 * 职责：
 * - 表达一个定时规则：id + predicate + businessEvent
 * - predicate 判断是否触发
 * - 命中时通过 EventBus emit businessEvent
 *
 * 设计原则：
 * - ScheduledRuleRegistry 是"业务规则层"，不持有 timer
 * - Timer/scheduler 信号来自 SchedulerAdapter（scheduler:tick）
 * - Rule 只负责"判断 + 发射业务事件"
 * - 通过 EventBus 发射业务事件，业务事件 → WorldState → AttentionEngine
 *
 * 事件流向：
 *   SchedulerAdapter → scheduler:tick → ScheduledRuleRegistry → predicate → EventBus.publish(businessEvent)
 *                                                                              ↓
 *                                                                    WorldStateUpdater（无 reducer → 忽略）
 *                                                                              ↓
 *                                                                    AttentionEngine（businessEvent 触发评估）
 */

import type { OrcaEvent, OrcaEventSource, OrcaEventType } from './event.js'

/**
 * 业务事件定义（ScheduledRule 命中时发射）
 */
export interface ScheduledBusinessEvent {
  /** 事件 source */
  source: OrcaEventSource
  /** 事件 type */
  type: OrcaEventType
  /** 事件 data payload */
  data?: Record<string, unknown>
  /** 事件优先级，默认 1 */
  priority?: number
}

/**
 * ScheduledRule predicate 上下文
 */
export interface ScheduledRuleContext {
  /** 当前 tick 事件 */
  tick: OrcaEvent
  /** 上一次该 rule 触发的时间戳（毫秒），0 表示从未触发 */
  lastTriggeredAt: number
}

/**
 * ScheduledRule predicate 函数
 *
 * @param ctx 上下文（含当前 tick 和上次触发时间）
 * @returns true = 触发 businessEvent；false = 不触发
 */
export type ScheduledRulePredicate = (ctx: ScheduledRuleContext) => boolean

/**
 * ScheduledRule 定义
 *
 * 最小抽象：
 * - id：唯一标识
 * - predicate：判断是否触发
 * - businessEvent：命中时发射的业务事件
 */
export interface ScheduledRule {
  /** 唯一 rule id */
  readonly ruleId: string
  /** predicate：判断是否触发 */
  readonly predicate: ScheduledRulePredicate
  /** 命中时发射的业务事件 */
  readonly businessEvent: ScheduledBusinessEvent
}

/**
 * ScheduledRuleRegistry 接口
 */
export interface ScheduledRuleRegistry {
  /**
   * 注册规则
   * @param rule 要注册的规则
   * @returns void（同步，无副作用）
   */
  register(rule: ScheduledRule): void

  /**
   * 注销规则
   * @param ruleId 要注销的 rule id
   * @returns true = 注销成功；false = 规则不存在
   */
  unregister(ruleId: string): boolean

  /**
   * 获取当前注册的规则数
   */
  size(): number

  /**
   * 获取所有规则 id
   */
  ruleIds(): string[]
}
