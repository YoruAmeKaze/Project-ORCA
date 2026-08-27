/**
 * Orca Attention Engine Plugin —— Cordis integration（Phase 3.A + Phase 3.B.dedup）
 *
 * 职责：
 * - 创建 AttentionEngine + AttentionDedup 实例
 * - 订阅 EventBus 所有事件：bus.publish 触发时调 engine.evaluate({event, state, prevState})
 * - 订阅 'orca/state_changed'：state-only 触发（event=null, prevState=undefined）
 * - 每个 AttentionItem → dedup.shouldEmit() → emit 'orca/attention'（如果通过）
 * - 提供 ctx.attention service（含 engine + evaluate）
 * - 返回 dispose 钩子（unsubscribe + dedup.clear）
 *
 * Phase 3.B.dedup 集成：
 * - AttentionEngine 与 AttentionDedup 职责分离：engine 决定"是什么"，dedup 决定"多不多"
 * - 不修改 Rule（保持 Phase 3.A 的纯评估边界）
 * - dedup 默认窗口 5000ms（内部硬编码，不暴露配置——用户决策 Phase 3.B 第二步才做配置）
 *
 * 不做（Phase 3 范围外）：
 * - 不发飞书 / 调 agent / 写 infoStore（Phase 4 Decision）
 * - 不 throttle / rule config / LLM 增强（Phase 3.B 第二步 / Phase 5）
 * - 不持久化
 *
 * Cordis quirk 防护：
 * - inject = ['eventBus', 'worldState']（必须声明）
 * - 监听器 try/catch
 *
 * 重要时序：AttentionEngine 必须在 WorldStateUpdater 之后挂载（依赖 worldState service）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { EventBus } from '../services/eventBus.js'
import { createAttentionDedup, createAttentionEngine, DEFAULT_DEDUP_WINDOW_MS } from '../services/attention.js'
import type { AttentionDedupService, AttentionEngineService } from '../types/attention.js'
import type { OrcaEvent } from '../types/event.js'
import type { WorldState } from '../types/worldState.js'
import type { AttentionInput, AttentionItem } from '../types/attention.js'

/**
 * 评估 + dedup 后 emit items。
 * - 统计 emit / dropped 数量，写入 debug 日志
 * - dropped 不 emit（不消耗下游 Decision 资源）
 */
function emitItemsWithDedup(
  ctx: Context,
  items: AttentionItem[],
  trigger: string,
  dedup: AttentionDedupService,
): void {
  if (items.length === 0) return
  let emitted = 0
  let dropped = 0
  for (const item of items) {
    if (dedup.shouldEmit(item)) {
      ctx.emit('orca/attention', item)
      emitted++
    } else {
      dropped++
    }
  }
  if (emitted > 0 || dropped > 0) {
    ctx.logger.info(
      '[attention] %s 评估 %d 条（emit=%d drop=%d）',
      trigger, items.length, emitted, dropped,
    )
  }
}

export function attentionEngine(ctx: Context, _config: OrcaConfig) {
  const bus = ctx.eventBus
  const ws = ctx.worldState

  if (!bus || !ws) {
    ctx.logger.warn('[attention-engine] eventBus 或 worldState 未注入，跳过（Orca Runtime 未启用？）')
    return
  }

  // 1. 创建 AttentionEngine + AttentionDedup（闭包私有，不暴露给 ctx）
  const engine: AttentionEngineService = createAttentionEngine()
  const dedup: AttentionDedupService = createAttentionDedup()  // 默认 5000ms 窗口
  ctx.provide('attention', engine)
  ctx.logger.info(
    '[attention-engine] 已启动（内置 %d 条规则 + dedup 窗口 %dms）',
    engine.ruleCount(),
    DEFAULT_DEDUP_WINDOW_MS,
  )

  // 2. 订阅 EventBus：每个 event 触发评估 + dedup
  // 关键：prevState 通过 ws.getPrevState() 获取（WorldStateUpdater 已 capture）
  const unsubscribe = bus.subscribe({ minPriority: 0 }, (event: OrcaEvent) => {
    try {
      const input: AttentionInput = {
        event,
        state: ws.getState(),
        prevState: ws.getPrevState() ?? undefined,
      }
      const items = engine.evaluate(input)
      emitItemsWithDedup(ctx, items, `event ${event.source}:${event.type}`, dedup)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[attention-engine] event handler 异常: %s', detail)
    }
  })

  // 3. 订阅 orca/state_changed：state-only 触发（无 event，无 prevState）
  ctx.on('orca/state_changed', (state: WorldState) => {
    try {
      const input: AttentionInput = { event: null, state }
      const items = engine.evaluate(input)
      emitItemsWithDedup(ctx, items, 'state_changed', dedup)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[attention-engine] state_changed handler 异常: %s', detail)
    }
  })

  // 4. dispose 钩子
  return () => {
    ctx.logger.info('[attention-engine] 关闭（unsubscribe + dedup.clear）')
    unsubscribe()
    dedup.clear()
  }
}

/**
 * 必需依赖：EventBus + WorldState。cordis inject 门控。
 */
attentionEngine.inject = ['eventBus', 'worldState']