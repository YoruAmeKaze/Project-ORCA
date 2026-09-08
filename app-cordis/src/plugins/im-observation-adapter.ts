/**
 * IM Observation Adapter Cordis Plugin（IM-1.5A Phase）
 *
 * 挂载：Runtime 之后（订阅 EventBus im.* 事件）
 *
 * IM-1.5A 约束：
 * - 不调用 LLM 服务
 * - 不调用 Memory 存储层（signal 仅在内存）
 * - 不调用 Attention / Decision 引擎
 * - 不产生 Action
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { IMObservationConfig } from '../types/communication.js'
import { createIMObservationAdapter } from '../services/im-observation-adapter.js'
import type { OrcaEvent } from '../types/event.js'

/**
 * IM Observation Adapter Cordis Plugin
 *
 * @param ctx Cordis Context
 * @param config OrcaConfig
 * @returns dispose 函数
 */
export function imObservationAdapter(ctx: Context, config: OrcaConfig): () => void {
  const obsConfig: IMObservationConfig = {
    enabled: config.runtime.imObservation?.enabled ?? false,
    burstWindowMs: config.runtime.imObservation?.burstWindowMs ?? 60 * 60 * 1000,
    burstMinCount: config.runtime.imObservation?.burstMinCount ?? 3,
    emitEpisodes: config.runtime.imObservation?.emitEpisodes ?? false,
  }

  if (!obsConfig.enabled) {
    ctx.logger?.info('[im-observation] 未启用（ORCA_IM_OBSERVATION_ENABLED=0 或未配置）')
    return () => {}
  }

  ctx.logger?.info(
    '[im-observation] Phase 1.5A 已启用（burstWindowMs=%d, burstMinCount=%d）',
    obsConfig.burstWindowMs,
    obsConfig.burstMinCount,
  )

  const adapter = createIMObservationAdapter(
    {
      onSignal(signal) {
        // IM-1.5A：signal 仅在内存，不写 MemoryStore
        ctx.logger?.info(
          '[im-observation] signal type=%s sender=%s conversation=%s',
          signal.signalType,
          signal.senderId,
          signal.conversationId,
        )
      },
    },
    obsConfig,
    ctx.logger!,
  )

  // 订阅 EventBus，筛选 im.* 事件
  const unsubscribe = ctx.on('orca/event', (event: unknown) => {
    const e = event as OrcaEvent
    if (!e.source?.startsWith('im.') || (e.type !== 'im.message.received' && e.type !== 'im.message.sent')) {
      return
    }
    adapter.handleEvent(e)
  })

  ctx.logger?.info('[im-observation] Phase 1.5A 已挂载')

  return function dispose(): void {
    unsubscribe()
    adapter.dispose()
    ctx.logger?.info('[im-observation] disposed')
  }
}
