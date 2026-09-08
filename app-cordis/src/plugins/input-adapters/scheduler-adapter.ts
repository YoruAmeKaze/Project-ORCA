/**
 * Scheduler Input Adapter —— 纯时间生产者（Phase 7.1A）
 *
 * Phase 7.1A 职责：
 * - 仅 emit `scheduler:tick` 心跳事件（纯时间信号）
 * - 不 emit `briefing:due` / `reflection:due` / `reminder:due`（这些属于 ScheduledRuleRegistry，7.1B）
 *
 * 设计原则（GPT Review Phase 7.0）：
 * - RuntimeAdapter 统一接口 { start(), stop() }
 * - Scheduler 是"纯 Time Producer"——只产生时间信号
 * - 业务逻辑（briefing/reflection/reminder 触发）由 ScheduledRuleRegistry（7.1B）订阅 scheduler:tick 后决策
 * - 不直接修改 WorldState
 *
 * 事件：
 * - `scheduler:tick`：{ tickCount: number, timestamp: number }
 *
 * 7.1B ScheduledRuleRegistry 架构：
 *   scheduler:tick → ScheduledRuleRegistry（订阅）→ 根据规则触发 briefing/reflection/reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../../config.js'
import type { EventBus } from '../../services/eventBus.js'
import type { RuntimeAdapter } from '../../types/runtime-adapter.js'

/**
 * Scheduler Adapter 配置（Phase 7.1A：极简）
 */
export interface SchedulerAdapterConfig {
  /** 是否启用（默认 false） */
  enabled: boolean
  /** tick 间隔（毫秒，默认 60000） */
  tickMs?: number
}

/**
 * 从配置中提取 SchedulerAdapterConfig
 */
function getSchedulerConfig(config: OrcaConfig): SchedulerAdapterConfig {
  return {
    enabled: config.runtime.scheduler?.enabled ?? false,
    tickMs: config.runtime.scheduler?.tickMs ?? 60_000,
  }
}

/**
 * 创建 Scheduler Adapter（纯 Time Producer）
 *
 * 统一 RuntimeAdapter 接口：
 * - start()：启动 tick timer
 * - stop()：清理 timer
 */
export function createSchedulerAdapter(
  ctx: Context,
  config: SchedulerAdapterConfig,
): RuntimeAdapter {
  const bus = ctx.eventBus
  if (!bus) {
    ctx.logger.warn('[scheduler-adapter] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return {
      start() {},
      stop() {},
    }
  }

  let disposed = false
  let tickCount = 0
  let tickTimer: ReturnType<typeof setInterval> | null = null

  const tickMs = config.tickMs ?? 60_000

  /**
   * emit 安全包装（disposed 时短路）
   */
  function safePublish(): void {
    if (disposed || !bus) return
    try {
      tickCount++
      bus.publish({
        source: 'scheduler',
        type: 'scheduler:tick',
        data: {
          tickCount,
          timestamp: Date.now(),
        },
        priority: 1,
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[scheduler-adapter] tick 异常: %s', detail)
    }
  }

  return {
    start(): void {
      if (disposed) return

      // tick 心跳事件
      tickTimer = setInterval(() => {
        safePublish()
      }, tickMs)

      ctx.logger.info('[scheduler-adapter] 已启动（Phase 7.1A：纯 Time Producer，tickMs=%d）', tickMs)
    },

    stop(): void {
      disposed = true

      if (tickTimer) {
        clearInterval(tickTimer)
        tickTimer = null
      }

      ctx.logger.info('[scheduler-adapter] 已关闭')
    },
  }
}

/**
 * 默认 Scheduler Adapter 工厂（从 OrcaConfig 读取配置）
 */
export function schedulerAdapter(ctx: Context, config: OrcaConfig): RuntimeAdapter {
  const cfg = getSchedulerConfig(config)

  if (!cfg.enabled) {
    ctx.logger.info('[scheduler-adapter] 未启用（ORCA_SCHEDULER_ENABLED!=1）')
    return {
      start() {},
      stop() {},
    }
  }

  const adapter = createSchedulerAdapter(ctx, cfg)
  adapter.start()
  return adapter
}
