/**
 * MemoryAttentionAdapter Cordis plugin（Phase 5.4.A + 5.4.B）
 *
 * 挂载：在 MemoryStore 之后（依赖 ctx.memory）；在 Runtime 启用时有效。
 *
 * 职责：
 * - 创建 MemoryAttentionAdapter 实例
 * - 启动轮询
 * - 订阅 memory_changed 事件（Phase 5.4.B）
 * - 通过 ctx.emit('orca/attention', item) 注入事件流
 * - 返回 dispose 钩子
 *
 * 不做（Phase 5.4.A+B MVP）：
 * - 不映射 Memory type → AttentionItem action（统一 action='remember_only'）
 * - 不调用 Decision / Action
 * - 不修改 AttentionEngine / WorldState
 *
 * 设计依据：D-AGENT-19 §19-02
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { AttentionItem } from '../types/attention.js'
import type { MemoryChangedEvent } from '../types/memory.js'
import {
  createMemoryAttentionAdapter,
  type MemoryAttentionAdapterConfig,
} from '../services/memoryAttentionAdapter.js'

export function memoryAttentionAdapter(
  ctx: Context,
  config: OrcaConfig,
): () => void {
  const memory = ctx.get('memory')
  if (!memory) {
    ctx.logger?.warn('[memory-attention-adapter] memory service not available, plugin not mounted')
    return () => {}
  }

  // 从 config.memory 读取（环境变量已在 loadConfig 中解析）
  const adapterConfig: MemoryAttentionAdapterConfig = {
    enabled: config.memory.attentionEnabled,
    pollIntervalMs: config.memory.attentionPollIntervalMs,
    topK: config.memory.attentionTopK,
  }

  if (!adapterConfig.enabled) {
    ctx.logger?.info('[memory-attention-adapter] ORCA_MEMORY_ATTENTION_ENABLED=0，已关闭')
    return () => {}
  }

  const adapter = createMemoryAttentionAdapter(
    memory,
    (event: string, item: AttentionItem) => ctx.emit(event, item),
    adapterConfig,
    ctx.logger ? { info: ctx.logger.info.bind(ctx.logger), warn: ctx.logger.warn.bind(ctx.logger) } : undefined,
  )

  // Phase 5.4.B: 订阅 memory_changed 事件
  const unsubscribe = ctx.on('memory_changed', (event: MemoryChangedEvent) => {
    adapter.onMemoryChanged(event)
  })

  adapter.start()

  ctx.logger?.info('[memory-attention-adapter] Phase 5.4.B MemoryAttentionAdapter 已挂载（轮询 + memory_changed 事件驱动）')

  return () => {
    unsubscribe()
    adapter.stop()
    ctx.logger?.info('[memory-attention-adapter] disposed')
  }
}
