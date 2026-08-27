/**
 * Orca Attention Engine —— 注意力系统类型（Phase 3）
 *
 * 设计动机：
 * - WorldState 持续接收外部信号 → 用户当前状态被持续推导
 * - Attention Engine 决定"这个事件/状态变化是否值得关注"
 * - 输出 AttentionItem（建议的行为方向）→ Phase 4 Decision 决定具体执行
 *
 * 关键设计：AttentionItem.action 是**建议**（不立即执行），Decision 才是**执行**。
 * Phase 4 才会真正发飞书消息 / 调 agent / 写 infoStore。
 *
 * 与 EventBus / WorldState 的关系：
 * - EventBus → 持续事件流（OrcaEvent）
 * - WorldState → 持续状态（user/device/time）
 * - **Attention** = Event × State → AttentionItem[]
 * - Decision = AttentionItem[] → 具体 action（Phase 4）
 * - LLM 增强在 Phase 5（评审 AttentionItem，非替代）
 */

import type { OrcaEvent } from './event.js'
import type { WorldState } from './worldState.js'

/** 建议采取的行为方向（Phase 4 Decision 实际执行；当前仅 emit 不执行） */
export const ORCA_ATTENTION_ACTIONS = [
  'notify_immediately',   // 立即推送（飞书消息 / Bark 推送）
  'wait_until_available',  // 等待用户可用时合并通知（不在 busy / sleeping 时打扰）
  'remember_only',        // 只入档案（infoStore），不打扰用户
  'ignore',                // 完全忽略
  'act',                   // 需要调用 InfoAgent / agent plugin 做点什么（Phase 4 扩展）
] as const

export type AttentionAction = (typeof ORCA_ATTENTION_ACTIONS)[number] | (string & {})

/** 紧急度（Phase 4 排序用；high > normal > low） */
export const ORCA_ATTENTION_PRIORITIES = [
  'urgent',
  'high',
  'normal',
  'low',
] as const

export type AttentionPriority = (typeof ORCA_ATTENTION_PRIORITIES)[number] | (string & {})

/**
 * 评估时的输入。
 *
 * - event: 触发的具体事件（state-only 触发如 `orca/state_changed` 监听器调用 → event=null）
 * - state: 当前 WorldState 快照
 * - prevState: event 处理前的 WorldState 快照（state-only 触发 → undefined）
 *
 * 关键点：Attention 规则可写"prevState→state"的状态变化判断，例如：
 *   prevState.user.status !== 'busy' && state.user.status === 'busy'  → "用户刚进入 busy"
 */
export interface AttentionInput {
  event: OrcaEvent | null
  state: WorldState
  prevState?: WorldState
}

/**
 * 评估输出（一条规则 = 一个 item）。
 *
 * - ruleId: 触发规则的唯一 ID（用于追溯）
 * - priority / action / reason: 规则的语义产出
 * - eventId: 触发的具体事件（state-only 触发为 undefined）
 * - stateSnapshot: 评估时的 WorldState 快照（用于追溯，**深拷贝避免外部 mutation**）
 * - evaluatedAt: 评估时间戳
 */
export interface AttentionItem {
  ruleId: string
  priority: AttentionPriority
  reason: string
  action: AttentionAction
  eventId?: string
  stateSnapshot: WorldState
  evaluatedAt: number
}

/** 规则判定函数：返回 true 表示触发 */
export type AttentionPredicate = (input: AttentionInput) => boolean

/** 规则产物生成：触发后如何描述（除 ruleId / stateSnapshot / evaluatedAt 外的字段） */
export type AttentionProducer = (
  input: AttentionInput
) => Omit<AttentionItem, 'ruleId' | 'stateSnapshot' | 'evaluatedAt'>

/** 完整规则（id 必须全局唯一） */
export interface AttentionRule {
  id: string
  /** 人类描述（debug 用；不参与逻辑） */
  description: string
  predicate: AttentionPredicate
  produce: AttentionProducer
}

/**
 * AttentionEngine 是 Cordis 暴露给其他 plugin 的服务。
 *
 * 设计原则：
 * - 纯评估：evaluate() 只返回 AttentionItem[]，不执行任何 action
 * - 不持久化（重启即失）
 * - 不去重 / 不节流（Phase 3 第一版；Phase 4+ 可加）
 */
export interface AttentionEngineService {
  evaluate(input: AttentionInput): AttentionItem[]
  /** 已注册规则数（debug 用） */
  ruleCount(): number
}