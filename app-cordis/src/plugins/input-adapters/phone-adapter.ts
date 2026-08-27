/**
 * Phone Input Adapter —— 手机状态感知（Phase 2.D mock 版）
 *
 * 职责：
 * - 周期性 publish mock 手机事件到 EventBus
 * - Phase 2.D 第一版 mock 两种状态交替：
 *   - 'sleep' → user.status='sleeping'（phone 通知 iOS Health sleep）
 *   - 'wake' → 当前 Phase 无 reducer 主动改回 awake（保持 sleeping，等用户活动触发）
 *
 * 后续 Phase 可替换为真实实现（iOS Health Auto Export / Bark / Pushcut）
 *
 * 设计原则：与 pc/calendar adapter 一致（mock + 周期 timer + dispose）
 *
 * 注意：Phase 2.C 的 time tick 不覆盖 sleeping（已在 R5.A7 测过），
 * phone:sleep → user.status='sleeping' 是 Phase 2.D 第一次引入"主动设置非 awake" 的 reducer。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../../config.js'
import type { EventBus } from '../../services/eventBus.js'

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

export function phoneAdapter(ctx: Context, config: OrcaConfig) {
  const bus = ctx.eventBus
  if (!bus) {
    ctx.logger.warn('[phone-adapter] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return
  }

  const refreshMs = config.runtime.phone?.refreshMs ?? 300_000 // 默认 5 分钟

  const timer = setInterval(() => {
    try {
      const evt = pickMockPhoneEvent()
      bus.publish({
        source: 'phone',
        type: evt.type === 'sleep' ? 'sleep' : 'activity',
        data: { activityState: evt.activityState },
        priority: 1,
      })
      ctx.logger.info('[phone-adapter] mock %s → %s', evt.type, evt.activityState)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[phone-adapter] tick 异常: %s', detail)
    }
  }, refreshMs)

  ctx.logger.info(
    '[phone-adapter] 已启动（mock 模式，refreshMs=%d）',
    refreshMs,
  )

  return () => {
    ctx.logger.info('[phone-adapter] 关闭（clearInterval）')
    clearInterval(timer)
  }
}