/**
 * Orca World State Updater —— Cordis plugin（Phase 2.A 最小骨架）
 *
 * 职责：
 * - 创建并持有内部 WorldState（闭包私有，外部不可直接访问）
 * - 订阅 EventBus 所有事件（minPriority=0）
 * - 每个事件：applyReducers() → 检测字段变化 → 必要时 emit 'orca/state_changed'
 * - 通过 ctx.provide('worldState', service) 暴露只读 WorldStateService
 * - 返回 dispose 钩子（Phase 2.C 会扩展为 clearInterval；当前仅 unsubscribe）
 *
 * 不做（Phase 2.A 范围外）：
 * - 不启动 setInterval（time tick 推到 Phase 2.C）
 * - 不持久化（重启即失）
 * - 不自动判断 away（仅响应事件，不主动推导）
 *
 * 变化检测策略（用户明确要求"不要简单依赖对象引用"）：
 * - 比较 reducer 输出前后的 WorldState JSON 序列化是否一致
 * - 一致 → 跳过 emit
 * - 不一致 → 顶层 spread 生成新 state + emit 'orca/state_changed'
 *
 * Cordis quirk 防护：
 * - inject = ['eventBus']（v0.3.0 教训：漏声明 inject 致 async reject → 崩进程）
 * - 监听器 try/catch（handler 异常不崩服务）
 * - emit 使用 ctx.emit（与现有事件机制一致）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { EventBus } from '../services/eventBus.js'
import type { OrcaEvent } from '../types/event.js'
import type { WorldState } from '../types/worldState.js'
import {
  applyReducers,
  createWorldStateService,
  getInitialState,
  type WorldStateService,
} from '../services/worldState.js'

/**
 * 比较两个 WorldState 是否字段一致（深比较）。
 * 实现：JSON.stringify 比较。WorldState 字段都是 plain JSON-safe，性能足够。
 * 若未来字段含非 JSON 类型（如 Date / Map），需切换为结构化 deep equal。
 */
function statesEqual(a: WorldState, b: WorldState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function worldStateUpdater(ctx: Context, config: OrcaConfig) {
  const bus = ctx.eventBus
  if (!bus) {
    ctx.logger.warn('[world-state-updater] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return
  }

  // 1. 创建并持有内部 WorldState（闭包私有）
  let state: WorldState = getInitialState()
  ctx.logger.info(
    '[world-state-updater] 已启动（user.status=%s timeOfDay=%s）',
    state.user.status,
    state.time.timeOfDay,
  )

  // 2. 创建只读 Service（getter 闭包到 state，外部无法 mutate state）
  const service: WorldStateService = createWorldStateService(() => state)
  ctx.provide('worldState', service)

  // 3. 订阅 EventBus（所有事件）
  // 使用 minPriority=0 + 不指定 source/type，匹配所有事件。
  // handler 必须 try/catch（cordis quirk：async reject → unhandledRejection 崩进程）
  const unsubscribe = bus.subscribe({ minPriority: 0 }, (event: OrcaEvent) => {
    try {
      const prev = state
      const next = applyReducers(prev, event)

      // 字段级变化检测：JSON 序列化对比
      if (statesEqual(prev, next)) {
        // 无字段变化（如 reducer 返回 null 或空 partial）→ 跳过 emit
        return
      }

      // 有变化：更新 lastUpdated + lastEventId，生成新顶层引用
      const updated: WorldState = {
        ...next,
        lastUpdated: event.timestamp,
        lastEventId: event.id,
      }
      state = updated

      ctx.logger.info(
        '[world-state-updater] %s:%s 触发状态变化（lastEventId=%s）',
        event.source,
        event.type,
        event.id,
      )

      // emit 'orca/state_changed'（Phase 3 Attention Engine 会订阅）
      ctx.emit('orca/state_changed', updated)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[world-state-updater] handler 异常 (source=%s type=%s): %s',
        event.source, event.type, detail)
    }
  })

  // 4. dispose 钩子（cordis fiber 清理；Phase 2.C 会扩展为 clearInterval）
  return () => {
    ctx.logger.info('[world-state-updater] 关闭（unsubscribe）')
    unsubscribe()
  }
}

/**
 * 必需：依赖 EventBus Service。cordis inject 门控（v0.3.0 教训）。
 */
worldStateUpdater.inject = ['eventBus']