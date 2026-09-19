/**
 * Orca Cognitive Scheduler Service —— 认知调度服务（Phase A 最小可用骨架）
 *
 * 职责（Phase A）：
 * - 接收 AttentionItem → 放入 pending 队列（内存私有，不进 WorldState）
 * - 订阅 cognition:started / cognition:completed / cognition:failed 事件维护运行状态
 * - 决定何时产生 CognitiveRequest 并 emit
 *
 * 严格约束（Phase A）：
 * - ❌ 不调用 LLM
 * - ❌ 不执行 Action
 * - ❌ 不直接修改 WorldState
 * - ❌ 不持久化 pendingAttentions
 * - ❌ 不实现优先级调度（后续阶段）
 * - ❌ 不实现复杂的 attention 合并（后续阶段）
 *
 * 当前策略（Phase A）：
 * - 每当 enqueue 一个 attention，如果当前没有进行中的 cognition，立即产生 CognitiveRequest
 * - CognitionCore 订阅 'orca/cognition-request' 并处理
 * - CognitionCore 完成时 emit 'cognition/completed'，Scheduler 恢复接收新 attention
 *
 * 事件订阅：
 * - 'cognition/started'：isCognitionRunning = true
 * - 'cognition/completed'：isCognitionRunning = false
 * - 'cognition/failed'：isCognitionRunning = false
 *
 * 注意：当前 Phase A 的 evaluate() 逻辑是"立即触发"策略。
 * 这是最小可用骨架，真正的 intelligent batching/priority/defer 策略在后续阶段实现。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AttentionItem } from '../types/attention.js'
import type { CognitiveSchedulerService, CognitiveRequest } from '../types/cognition.js'

/**
 * 创建 CognitiveScheduler 实例
 *
 * Phase A 骨架策略：
 * - pendingAttentions: private Map（内存，ephemeral）
 * - activeCognitionId: null | string（ephemeral）
 * - evaluate(): 如果 isCognitionRunning=false，enqueue 时立即产生 CognitiveRequest
 *
 * @param ctx Cordis Context（用于 emit 事件和订阅 cognition 生命周期事件）
 */
export function createCognitiveScheduler(ctx: Context): CognitiveSchedulerService {
  // Ephemeral state（Scheduler 私有，不进 WorldState）
  const pendingAttentions = new Map<string, AttentionItem>()
  let activeCognitionId: string | null = null

  /**
   * 订阅 cognition 生命周期事件，维护 activeCognitionId 状态。
   * 这些事件由 CognitionCore（未来）或测试代码 emit。
   */
  const unsubStarted = ctx.on('cognition/started', (sessionId: string) => {
    activeCognitionId = sessionId
    ctx.logger.debug('[cognitive-scheduler] cognition started: %s', sessionId)
  })

  const unsubCompleted = ctx.on('cognition/completed', (sessionId: string) => {
    if (activeCognitionId === sessionId) {
      ctx.logger.debug('[cognitive-scheduler] cognition completed: %s', sessionId)
      activeCognitionId = null
      // 闭环关键：cognition 结束后，评估是否有 pending 需要处理
      evaluate()
    } else {
      ctx.logger.warn('[cognitive-scheduler] cognition/completed for unknown session: %s (active=%s)',
        sessionId, activeCognitionId)
    }
  })

  const unsubFailed = ctx.on('cognition/failed', (sessionId: string, _error: string) => {
    if (activeCognitionId === sessionId) {
      ctx.logger.debug('[cognitive-scheduler] cognition failed: %s', sessionId)
      activeCognitionId = null
      // failed 也要触发 evaluate，防止 pending 永远饿死
      evaluate()
    } else {
      ctx.logger.warn('[cognitive-scheduler] cognition/failed for unknown session: %s (active=%s)',
        sessionId, activeCognitionId)
    }
  })

  /**
   * Phase A evaluate 策略：
   * - 如果当前有进行中的 cognition，新 attention 只入队，不触发新 request
   * - 如果当前没有进行中的 cognition，立即产生 CognitiveRequest
   *
   * 这是最小可用骨架。真正的 batching/priority/defer 策略在 Phase B+ 实现。
   */
  function evaluate() {
    if (activeCognitionId !== null) {
      // 有进行中的 cognition，pending 等待
      ctx.logger.debug('[cognitive-scheduler] cognition running (session=%s), %d pending',
        activeCognitionId, pendingAttentions.size)
      return
    }

    if (pendingAttentions.size === 0) {
      return
    }

    // 没有进行中的 cognition，立即产生 CognitiveRequest
    const attentions = Array.from(pendingAttentions.values())
    const request: CognitiveRequest = {
      id: randomUUID(),
      attentions,
      createdAt: Date.now(),
      trigger: `pending=${attentions.length} items, cognition available`,
    }

    // 清空 pending
    pendingAttentions.clear()

    ctx.logger.info('[cognitive-scheduler] emitting cognition-request (id=%s, attentions=%d)',
      request.id, request.attentions.length)
    ctx.emit('orca/cognition-request', request)
  }

  return {
    enqueue(attention: AttentionItem): void {
      pendingAttentions.set(attention.id, attention)
      ctx.logger.debug('[cognitive-scheduler] enqueue attention (id=%s, ruleId=%s, pending=%d)',
        attention.id, attention.ruleId, pendingAttentions.size)

      // Phase A 策略：立即尝试产生 CognitiveRequest
      evaluate()
    },

    getPendingCount(): number {
      return pendingAttentions.size
    },

    isCognitionRunning(): boolean {
      return activeCognitionId !== null
    },

    getActiveSessionId(): string | null {
      return activeCognitionId
    },

    /** 销毁函数（清理事件订阅） */
    destroy(): void {
      unsubStarted()
      unsubCompleted()
      unsubFailed()
    },
  }
}
