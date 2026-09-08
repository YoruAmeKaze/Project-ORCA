/**
 * Phone Input Adapter —— 手机状态感知（Phase 2.D + Phase 7.1A 重构）
 *
 * Phase 7.1A 变更：
 * - 实现 RuntimeAdapter 统一接口 { start(), stop() }
 * - 保持现有 event 格式（phone:sleep / phone:activity）
 * - 符合 GPT Review Phase 7.0：所有状态变更必须经过 EventBus
 *
 * 职责：
 * - 周期性 publish mock 手机事件到 EventBus
 * - Phase 2.D 第一版 mock 两种状态交替：
 *   - 'sleep' → user.status='sleeping'
 *   - 'wake' → 当前 Phase 无 reducer 主动改回 awake（保持 sleeping，等用户活动触发）
 *
 * 后续 Phase 可替换为真实实现（iOS Health Auto Export / Bark / Pushcut）
 *
 * 事件 payload:
 *   data.activityState: 'asleep' | 'in_bed' | 'active'
 *
 * 设计原则（GPT Review Phase 7.0）：
 * - RuntimeAdapter 统一接口
 * - 不直接修改 WorldState
 * - 所有事件通过 EventBus → WorldStateUpdater 路径
 *
 * 注意：Phase 2.C 的 time tick 不覆盖 sleeping（已在 R5.A7 测过），
 * phone:sleep → user.status='sleeping' 是 Phase 2.D 第一次引入"主动设置非 awake" 的 reducer。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../../config.js'
import type { EventBus } from '../../services/eventBus.js'
import type { RuntimeAdapter } from '../../types/runtime-adapter.js'

/** mock 事件类型（轮流发送） */
const MOCK_PHONE_EVENTS = [
  { type: 'sleep', activityState: 'asleep' },
  { type: 'sleep', activityState: 'in_bed' },
  { type: 'wake', activityState: 'active' },
] as const

function pickMockPhoneEvent() {
  const idx = Math.floor(Math.random() * MOCK_PHONE_EVENTS.length)
  return MOCK_PHONE_EVENTS[idx] ?? MOCK_PHONE_EVENTS[0]
}

/**
 * 创建 Phone Adapter
 *
 * 统一 RuntimeAdapter 接口：
 * - start()：启动 timer，开始 emit phone:sleep / phone:activity 事件
 * - stop()：清理 timer
 */
export function createPhoneAdapter(
  bus: EventBus,
  refreshMs: number,
  logger: Context['logger'],
): RuntimeAdapter {
  let disposed = false
  let timer: ReturnType<typeof setInterval> | null = null

  function safePublish(evt: { type: string; activityState: string }): void {
    if (disposed || !bus) return
    try {
      bus.publish({
        source: 'phone',
        type: evt.type === 'sleep' ? 'sleep' : 'activity',
        data: { activityState: evt.activityState },
        priority: 1,
      })
      logger.info('[phone-adapter] mock %s → %s', evt.type, evt.activityState)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      logger.warn('[phone-adapter] tick 异常: %s', detail)
    }
  }

  return {
    start(): void {
      if (disposed) return
      timer = setInterval(() => {
        if (!disposed) {
          safePublish(pickMockPhoneEvent())
        }
      }, refreshMs)
    },

    stop(): void {
      disposed = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      logger.info('[phone-adapter] 已关闭（clearInterval）')
    },
  }
}

/**
 * Phone Adapter Cordis plugin
 *
 * Phase 7.1A 重构：
 * - 返回 RuntimeAdapter 统一接口
 * - 适配现有 OrcaConfig 配置
 */
export function phoneAdapter(ctx: Context, config: OrcaConfig): RuntimeAdapter {
  const bus = ctx.eventBus
  if (!bus) {
    ctx.logger.warn('[phone-adapter] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return {
      start() {},
      stop() {},
    }
  }

  const refreshMs = config.runtime.phone?.refreshMs ?? 300_000

  ctx.logger.info(
    '[phone-adapter] 已启动（mock 模式，refreshMs=%d）',
    refreshMs,
  )

  const adapter = createPhoneAdapter(bus, refreshMs, ctx.logger)
  adapter.start()
  return adapter
}
