/**
 * Orca Attention Engine Plugin —— Cordis integration（Phase 3.A + Phase 3.B.dedup + Phase 3.B.throttle）
 *
 * 职责：
 * - 创建 AttentionEngine + AttentionDedup + AttentionThrottle 实例
 * - 订阅 EventBus 所有事件：bus.publish 触发时调 engine.evaluate({event, state, prevState})
 * - 订阅 'orca/state_changed'：state-only 触发（event=null, prevState=undefined）
 * - 每个 AttentionItem → dedup.shouldEmit() → throttle.shouldEmit() → emit 'orca/attention'
 * - 提供 ctx.attention service（含 engine + evaluate）
 * - 返回 dispose 钩子（unsubscribe + dedup.clear + throttle.reset）
 *
 * Phase 3.B 完整集成（dedup + throttle）：
 * - AttentionEngine 关注"是什么"——评估事件 → 产生 AttentionItem（不变）
 * - AttentionDedup   关注"是不是新刺激"——窗口期内去重（Phase 3.B.dedup）
 * - AttentionThrottle 关注"现在该不该打扰"——source cooldown + hourly cap（Phase 3.B.throttle）
 * - 三层职责分离，互不耦合；任何一层可独立替换
 *
 * 不做（Phase 3 范围外）：
 * - 不发飞书 / 调 agent / 写 infoStore（Phase 4 Decision）
 * - 不 rule config / LLM 增强（Phase 3.B 第三步 / Phase 5）
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
import {
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_THROTTLE_COOLDOWN_MS,
  DEFAULT_THROTTLE_HOURLY_CAP,
  DEFAULT_THROTTLE_WINDOW_MS,
  createAttentionDedup,
  createAttentionEngine,
  createAttentionThrottle,
} from '../services/attention.js'
import type {
  AttentionDedupService,
  AttentionEngineService,
  AttentionThrottleService,
} from '../types/attention.js'
import type { OrcaEvent } from '../types/event.js'
import type { WorldState } from '../types/worldState.js'
import type { AttentionInput, AttentionItem } from '../types/attention.js'

/**
 * 评估 → dedup → throttle → emit 三级流水线（Phase 3.B 完整）
 * - 统计 emit / dropped_by_dedup / dropped_by_throttle 数量，写入 debug 日志
 * - 任何一级 drop 都不 emit（不消耗下游 Decision 资源）
 */
function emitItemsWithDedupAndThrottle(
  ctx: Context,
  items: AttentionItem[],
  trigger: string,
  dedup: AttentionDedupService,
  throttle: AttentionThrottleService,
): void {
  if (items.length === 0) return
  let emitted = 0
  let droppedByDedup = 0
  let droppedByThrottle = 0
  for (const item of items) {
    if (!dedup.shouldEmit(item)) {
      droppedByDedup++
      continue
    }
    if (!throttle.shouldEmit(item)) {
      droppedByThrottle++
      continue
    }
    ctx.emit('orca/attention', item)
    emitted++
  }
  if (emitted > 0 || droppedByDedup > 0 || droppedByThrottle > 0) {
    ctx.logger.info(
      '[attention] %s 评估 %d 条（emit=%d drop_dedup=%d drop_throttle=%d）',
      trigger, items.length, emitted, droppedByDedup, droppedByThrottle,
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

  // 1. 创建 AttentionEngine + AttentionDedup + AttentionThrottle（闭包私有，不暴露 ctx）
  const engine: AttentionEngineService = createAttentionEngine()
  const dedup: AttentionDedupService = createAttentionDedup()         // 默认 5000ms 窗口
  const throttle: AttentionThrottleService = createAttentionThrottle() // 默认 cooldown=5s + cap=10/1h
  ctx.provide('attention', engine)
  ctx.logger.info(
    '[attention-engine] 已启动（%d 规则 + dedup %dms + throttle cooldown=%dms cap=%d/%dms）',
    engine.ruleCount(),
    DEFAULT_DEDUP_WINDOW_MS,
    DEFAULT_THROTTLE_COOLDOWN_MS,
    DEFAULT_THROTTLE_HOURLY_CAP,
    DEFAULT_THROTTLE_WINDOW_MS,
  )

  // 2. 订阅 EventBus：每个 event 触发评估 → dedup → throttle → emit
  const unsubscribe = bus.subscribe({ minPriority: 0 }, (event: OrcaEvent) => {
    try {
      const input: AttentionInput = {
        event,
        state: ws.getState(),
        prevState: ws.getPrevState() ?? undefined,
      }
      const items = engine.evaluate(input)
      emitItemsWithDedupAndThrottle(
        ctx, items, `event ${event.source}:${event.type}`, dedup, throttle,
      )
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
      emitItemsWithDedupAndThrottle(ctx, items, 'state_changed', dedup, throttle)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[attention-engine] state_changed handler 异常: %s', detail)
    }
  })

  // 4. dispose 钩子
  return () => {
    ctx.logger.info('[attention-engine] 关闭（unsubscribe + dedup.clear + throttle.reset）')
    unsubscribe()
    dedup.clear()
    throttle.reset()
  }
}

/**
 * 必需依赖：EventBus + WorldState。cordis inject 门控。
 */
attentionEngine.inject = ['eventBus', 'worldState']