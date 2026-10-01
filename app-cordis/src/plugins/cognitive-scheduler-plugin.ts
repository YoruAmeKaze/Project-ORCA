/**
 * Orca Cognitive Scheduler Plugin —— Cordis integration（Phase A）
 *
 * 职责：
 * - 创建 CognitiveScheduler 实例
 * - 订阅 'orca/attention' 事件 → scheduler.enqueue()
 * - 提供 ctx.cognitiveScheduler service
 * - 返回 dispose 钩子（清理事件订阅）
 *
 * Phase A 关键设计：
 * - Scheduler 通过 enqueue() 接收 AttentionItem，不直接 emit 'orca/cognition-request'
 * - evaluate() 在 enqueue 内部调用，决定是否产生 CognitiveRequest
 * - 'cognition/started' / 'cognition/completed' / 'cognition/failed' 事件由 CognitionCore emit
 *
 * 挂载时序（Phase A）：
 * - CognitiveSchedulerPlugin 在 AttentionEngine 之后挂载（订阅 'orca/attention' emit）
 * - DecisionEngine 继续独立工作（订阅 'orca/attention' 维持向后兼容）
 * - CognitiveScheduler 在 AttentionEngine 和 DecisionEngine 之间建立新路径
 *
 * Cordis quirk 防护：
 * - listener try/catch（handler 异常不崩服务、不阻塞其他 listener）
 * - inject = ['eventBus', 'worldState']（与 AttentionEngine 一致）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { AttentionItem } from '../types/attention.js'
import type { CognitiveSchedulerService } from '../types/cognition.js'
import { createCognitiveScheduler } from '../services/cognitive-scheduler.js'

/**
 * CognitiveScheduler Cordis plugin
 */
export function cognitiveSchedulerPlugin(ctx: Context, _config: OrcaConfig) {
  // 1. 创建 CognitiveScheduler（注入 ctx 以便 emit 事件和订阅）
  const scheduler: CognitiveSchedulerService = createCognitiveScheduler(ctx)
  ctx.provide('cognitiveScheduler', scheduler)
  ctx.logger.info('[cognitive-scheduler] 已启动（Phase A 骨架）')

  // 2. 订阅 'orca/attention'：每个 AttentionItem → scheduler.enqueue()
  // - 与 DecisionEngine 并行订阅（不阻塞 DecisionEngine 的 'orca/attention' listener）
  // - try/catch 包裹（cordis quirk 防护）
  const unsubscribe = ctx.on('orca/attention', (item: AttentionItem) => {
    try {
      scheduler.enqueue(item)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[cognitive-scheduler] enqueue 异常 (ruleId=%s): %s',
        item?.ruleId ?? '?', detail)
    }
  })

  // 3. dispose 钩子
  return () => {
    ctx.logger.info('[cognitive-scheduler] 关闭')
    unsubscribe()
    if (typeof scheduler.destroy === 'function') {
      scheduler.destroy()
    }
  }
}

/**
 * 必需依赖：EventBus + WorldState（与 AttentionEngine 一致；通过 inject 门控）。
 * 注意：Scheduler 自身不直接调用 eventBus 或 worldState，但 plugin 结构与 AttentionEngine 对称。
 */
cognitiveSchedulerPlugin.inject = ['eventBus', 'worldState']
