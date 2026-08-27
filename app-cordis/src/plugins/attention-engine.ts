/**
 * Orca Attention Engine Plugin —— Cordis integration（Phase 3 第一版）
 *
 * 职责：
 * - 创建 AttentionEngine 实例
 * - 订阅 EventBus 所有事件：bus.publish 触发时调 engine.evaluate({event, state, prevState})
 * - 订阅 'orca/state_changed'：state-only 触发（event=null, prevState=undefined）
 * - 每个 AttentionItem emit 'orca/attention'（Phase 4 Decision 订阅）
 * - 提供 ctx.attention service（含 engine + evaluate）
 * - 返回 dispose 钩子
 *
 * 不做（Phase 3 范围外）：
 * - 不发飞书 / 调 agent / 写 infoStore（Phase 4 Decision）
 * - 不去重 / 节流（Phase 4+）
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
import { createAttentionEngine } from '../services/attention.js'
import type { AttentionEngineService } from '../types/attention.js'
import type { OrcaEvent } from '../types/event.js'
import type { WorldState } from '../types/worldState.js'
import type { AttentionInput, AttentionItem } from '../types/attention.js'

/**
 * 评估单条（event 触发），emit items
 */
function emitItems(
  ctx: Context,
  items: AttentionItem[],
  trigger: string,
): void {
  if (items.length === 0) return
  ctx.logger.info('[attention] %s 触发 %d 条 attention item(s)', trigger, items.length)
  for (const item of items) {
    ctx.emit('orca/attention', item)
  }
}

export function attentionEngine(ctx: Context, _config: OrcaConfig) {
  const bus = ctx.eventBus
  const ws = ctx.worldState

  if (!bus || !ws) {
    ctx.logger.warn('[attention-engine] eventBus 或 worldState 未注入，跳过（Orca Runtime 未启用？）')
    return
  }

  // 1. 创建 AttentionEngine + provide
  const engine: AttentionEngineService = createAttentionEngine()
  ctx.provide('attention', engine)
  ctx.logger.info(
    '[attention-engine] 已启动（内置 %d 条规则，纯评估不执行）',
    engine.ruleCount(),
  )

  // 2. 订阅 EventBus：每个 event 触发评估
  // 关键：prevState 通过 ws.getPrevState() 获取（WorldStateUpdater 已 capture）
  const unsubscribe = bus.subscribe({ minPriority: 0 }, (event: OrcaEvent) => {
    try {
      const input: AttentionInput = {
        event,
        state: ws.getState(),
        prevState: ws.getPrevState() ?? undefined,
      }
      const items = engine.evaluate(input)
      emitItems(ctx, items, `event ${event.source}:${event.type}`)
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
      emitItems(ctx, items, 'state_changed')
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[attention-engine] state_changed handler 异常: %s', detail)
    }
  })

  // 4. dispose 钩子
  return () => {
    ctx.logger.info('[attention-engine] 关闭（unsubscribe）')
    unsubscribe()
  }
}

/**
 * 必需依赖：EventBus + WorldState。cordis inject 门控。
 */
attentionEngine.inject = ['eventBus', 'worldState']