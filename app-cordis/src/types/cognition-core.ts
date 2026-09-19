/**
 * Orca CognitionCore —— 类型定义（Phase B）
 *
 * 职责：
 * - 定义 CognitionSession（运行时认知会话）
 * - 定义 WorkingMemory（ephemeral 工作记忆）
 * - 定义 CognitionResult（认知结果）
 *
 * 设计原则：
 * - CognitionSession 是 ephemeral runtime state，不进 WorldState，不持久化到 MemoryStore
 * - WorkingMemory 属于 CognitionSession，cognition 结束后丢弃
 * - CognitionResult 只含最小 metadata，不携带完整 prompt 或 WorkingMemory dump
 */

import type { AttentionItem } from './attention.js'

/**
 * CognitionSession —— 一次认知会话的运行时状态
 *
 * 生命周期：
 * 1. CognitionCore 收到 CognitiveRequest → 创建 CognitionSession（status='running'）
 * 2. CognitionCore emit('cognition:started', session.id)
 * 3. CognitionCore 执行 LLM inference
 * 4. CognitionCore emit('cognition:completed', session.id) 或 emit('cognition:failed', session.id, error)
 * 5. CognitionSession 结束，状态变为 'completed' 或 'failed'
 *
 * 注意：Session 内容（prompt/response/workingMemory）由 CognitionCore 私有持有，
 * 不通过事件传递。Scheduler 只知道 activeCognitionId。
 */
export interface CognitionSession {
  /** 稳定唯一 ID（追溯用） */
  id: string
  /** 关联的 CognitiveRequest.id */
  requestId: string
  /** Session 创建时间 */
  createdAt: number
  /** Cognition 开始时间（startedAt > createdAt）*/
  startedAt: number
  /** Session 结束时间（completed/failed 时设置）*/
  endedAt?: number
  /** 进行中的 AttentionItem 列表（来自 CognitiveRequest）*/
  attentions: AttentionItem[]
  /** 当前状态 */
  status: 'running' | 'completed' | 'failed'
}

/**
 * WorkingMemory —— CognitionSession 的 ephemeral 工作记忆
 *
 * 生命周期与 CognitionSession 相同：
 * - Session 创建时 → WorkingMemory 创建
 * - Session 结束时 → WorkingMemory 丢弃（不持久化）
 *
 * Phase B 极简版本：只有 goal + observations。
 * 完整版（Phase C+）会扩展为包含 toolResults、intermediateSteps 等。
 */
export interface WorkingMemory {
  /** 当前认知目标（来自 CognitiveRequest trigger）*/
  goal: string
  /** 观察/中间结果（Phase B：来自 LLM 的原始输出）*/
  observations: string[]
}

/**
 * CognitionResult —— 认知结果（最小 metadata）
 *
 * 设计原则：
 * - 只携带最小可追溯信息
 * - 不携带完整 prompt / response / workingMemory
 * - output 是 LLM 原始回复文本（Phase B 直接透传）
 *
 * Phase B：output 是 LLM 的原始字符串回复
 * 未来（Phase C+）：可能扩展为结构化 output（ReAct steps / tool calls / 等）
 */
export interface CognitionResult {
  /** 关联的 CognitionSession.id */
  cognitionId: string
  /** 关联的 CognitiveRequest.id */
  requestId: string
  /** 结果状态 */
  status: 'completed' | 'failed'
  /** LLM 原始输出（Phase B 为纯文本字符串）*/
  output?: string
  /** 错误信息（failed 时填写）*/
  error?: string
  /** 耗时（毫秒）*/
  durationMs: number
}
