/**
 * Orca World State Updater —— Cordis plugin（Phase 2.A 最小骨架 + Phase 2.C time tick）
 *
 * 职责：
 * - 创建并持有内部 WorldState（闭包私有，外部不可直接访问）
 * - 订阅 EventBus 所有事件（minPriority=0）
 * - 每个事件：applyReducers() → 检测字段变化 → 必要时 emit 'orca/state_changed'
 * - **Phase 2.C**：setInterval time tick，每 N ms 重算 time 字段 + deriveUserStatus（awake → away）
 * - 通过 ctx.provide('worldState', service) 暴露只读 WorldStateService
 * - 返回 dispose 钩子：clearInterval + unsubscribe
 *
 * 不做（Phase 2.C 范围外）：
 * - 不持久化（重启即失）
 * - 不反向推导（away → awake；busy / sleeping 状态解除都属 Phase 3+）
 * - 不接入 PC / Phone / Calendar adapter（属 Phase 2.D+）
 *
 * 变化检测策略（用户明确要求"不要简单依赖对象引用"）：
 * - 比较 reducer 输出前后的 WorldState JSON 序列化是否一致
 * - 一致 → 跳过 emit
 * - 不一致 → 顶层 spread 生成新 state + emit 'orca/state_changed'
 *
 * Cordis quirk 防护：
 * - inject = ['eventBus']（v0.3.0 教训：漏声明 inject 致 async reject → 崩进程）
 * - 监听器 try/catch（handler 异常不崩服务）
 * - setInterval 内部 try/catch（timer tick 异常不崩服务）
 * - emit 使用 ctx.emit（与现有事件机制一致）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { EventBus } from '../services/eventBus.js'
import type { OrcaEvent } from '../types/event.js'
import type { WorldState } from '../types/worldState.js'
import {
  applyReducers,
  computeTimeContext,
  createWorldStateService,
  deriveUserStatus,
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

/**
 * 比较两个 TimeContext 是否一致（仅 time 字段的局部深比较）。
 * 与 statesEqual 分离：timer tick 高频调用，不需要序列化整个 WorldState。
 */
function statesEqualTime(a: WorldState['time'], b: WorldState['time']): boolean {
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

  // 4. Time tick（Phase 2.C）：每 N ms 重算 time 字段 + deriveUserStatus
  // - 仅 awake → away 单向推导（不覆盖 busy/sleeping/away）
  // - 任一字段变化才更新 state + emit（无变化零开销）
  // - try/catch 包裹（timer 异常不崩进程）
  const timeRefreshMs = config.runtime.worldState.timeRefreshMs ?? 60_000
  const timer = setInterval(() => {
    try {
      const now = Date.now()
      const newTime = computeTimeContext(now)
      const newStatus = deriveUserStatus(state, now)

      const timeChanged = !statesEqualTime(newTime, state.time)
      const userChanged = newStatus !== null

      // 无变化：完全跳过（state 引用不变、emit 不触发）
      if (!timeChanged && !userChanged) return

      const prev = state
      const next: WorldState = {
        ...prev,
        time: timeChanged ? newTime : prev.time,
        user: newStatus !== null ? { ...prev.user, status: newStatus } : prev.user,
        lastUpdated: now,
        // 注意：lastEventId 在 timer tick 中不变（timer 不是事件）；仅在 EventBus 触发时更新
      }
      state = next

      ctx.logger.info(
        '[world-state-updater] timer tick 触发（timeChanged=%s userChanged=%s → status=%s）',
        timeChanged, userChanged, next.user.status,
      )
      ctx.emit('orca/state_changed', next)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[world-state-updater] timer tick 异常: %s', detail)
    }
  }, timeRefreshMs)
  ctx.logger.info(
    '[world-state-updater] time tick 已启用（timeRefreshMs=%d）',
    timeRefreshMs,
  )

  // 5. dispose 钩子（cordis fiber 清理）
  return () => {
    ctx.logger.info('[world-state-updater] 关闭（clearInterval + unsubscribe）')
    clearInterval(timer)
    unsubscribe()
  }
}

/**
 * 必需：依赖 EventBus Service。cordis inject 门控（v0.3.0 教训）。
 */
worldStateUpdater.inject = ['eventBus']