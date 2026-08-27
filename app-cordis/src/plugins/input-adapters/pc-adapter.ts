/**
 * PC Input Adapter —— 桌面焦点应用感知（Phase 2.D mock 版）
 *
 * 职责：
 * - 周期性查询当前 PC 焦点应用并 publish 到 EventBus（source='pc', type='app_focus'）
 * - Phase 2.D 第一版使用 mock（随机从常见 app 列表选一个）；
 *   后续 Phase 可替换为真实实现（Windows PowerShell Get-Process / macOS lsappinfo / Linux xdotool）
 *
 * 与 feishu-adapter 的区别：
 * - feishu-adapter 是被动订阅 ctx.on('feishu/*') → bus.publish（外部信号源 → OrcaEvent）
 * - pc-adapter 是**主动**周期性 publish（无外部事件源，由内部 timer 驱动）
 *
 * 设计原则：
 * - EventBus 未注入 → no-op + warn（与 feishu-adapter 一致）
 * - 监听器 try/catch（timer 异常不崩服务，cordis quirk 防护）
 * - dispose 钩子 clearInterval（不泄漏 timer）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../../config.js'
import type { EventBus } from '../../services/eventBus.js'

/** mock 应用列表（第一版用，后续真实实现时替换） */
const MOCK_PC_APPS = [
  'VSCode',
  'Chrome',
  'Feishu',
  'Terminal',
  'Cursor',
  'WeChat',
] as const

function pickMockApp(): string {
  // 简单随机选择；后续可改为基于历史 lastApp 加权减少抖动
  const idx = Math.floor(Math.random() * MOCK_PC_APPS.length)
  return MOCK_PC_APPS[idx] ?? 'Unknown'
}

export function pcAdapter(ctx: Context, config: OrcaConfig) {
  const bus = ctx.eventBus
  if (!bus) {
    ctx.logger.warn('[pc-adapter] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return
  }

  const refreshMs = config.runtime.pc?.refreshMs ?? 60_000

  const timer = setInterval(() => {
    try {
      const app = pickMockApp()
      bus.publish({
        source: 'pc',
        type: 'app_focus',
        data: { app },
        priority: 1,
      })
      ctx.logger.info('[pc-adapter] mock app_focus → %s', app)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[pc-adapter] tick 异常: %s', detail)
    }
  }, refreshMs)

  ctx.logger.info(
    '[pc-adapter] 已启动（mock 模式，refreshMs=%d，候选=%s）',
    refreshMs,
    MOCK_PC_APPS.join('/'),
  )

  return () => {
    ctx.logger.info('[pc-adapter] 关闭（clearInterval）')
    clearInterval(timer)
  }
}