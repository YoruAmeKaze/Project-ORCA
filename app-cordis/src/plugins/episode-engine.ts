/**
 * EpisodeEngine Cordis 插件（Phase 5.1）
 *
 * 挂载：MemoryStore 之后（依赖 ctx.memory）
 *
 * 订阅：
 * - 'orca/event'（EventBus 事件）→ EpisodeEngine.handleEvent
 * - 'orca/state_changed'（WorldState 变化）→ EpisodeEngine.handleStateChange
 *
 * 约束：
 * - 纯规则，无 LLM
 * - 不修改 EventBus / WorldState
 */

import type { Context } from '@deepseek-ai/cordis'
import { createEpisodeEngine } from '../services/episodeEngine.js'

export function episodeEnginePlugin(ctx: Context): () => void {
  // 需要 memory service
  const memory = ctx.get('memory')
  if (!memory) {
    ctx.logger?.warn('[episode-engine] memory service not available, plugin not mounted')
    return () => {}
  }

  const engine = createEpisodeEngine(ctx)

  // 监听 EventBus 事件（ctx.on 返回 unsubscribe）
  const eventUnsubscribe = ctx.on('orca/event', (event: unknown) => {
    void engine.handleEvent(event as Parameters<typeof engine.handleEvent>[0])
  })

  // 监听 WorldState 变化
  const stateUnsubscribe = ctx.on('orca/state_changed', (state: unknown, prev: unknown) => {
    void engine.handleStateChange(
      state as Parameters<typeof engine.handleStateChange>[0],
      prev as Parameters<typeof engine.handleStateChange>[1],
    )
  })

  ctx.logger?.info('[episode-engine] Phase 5.1 EpisodeEngine 已挂载（message.burst + state.transition）')

  return () => {
    engine.dispose()
    eventUnsubscribe()
    stateUnsubscribe()
    ctx.logger?.info('[episode-engine] disposed')
  }
}
