/**
 * PC Input Adapter —— 桌面焦点应用感知（Phase 2.D + Phase 7.1A 重构）
 *
 * Phase 7.1A 变更：
 * - 实现 RuntimeAdapter 统一接口 { start(), stop() }
 * - 保持现有 event 格式（pc:app_focus）
 * - 符合 GPT Review Phase 7.0：所有状态变更必须经过 EventBus
 *
 * 职责：
 * - 周期性查询当前 PC 焦点应用并 publish 到 EventBus（source='pc', type='app_focus'）
 * - Phase 2.D 第一版使用 mock（随机从常见 app 列表选一个）；
 *   后续 Phase 可替换为真实实现（Windows PowerShell Get-Process / macOS lsappinfo / Linux xdotool）
 *
 * 事件 payload:
 *   data.app: 当前焦点应用名称
 *
 * 设计原则（GPT Review Phase 7.0）：
 * - RuntimeAdapter 统一接口
 * - 不直接修改 WorldState
 * - 所有事件通过 EventBus → WorldStateUpdater 路径
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../../config.js'
import type { EventBus } from '../../services/eventBus.js'
import type { RuntimeAdapter } from '../../types/runtime-adapter.js'

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
  const idx = Math.floor(Math.random() * MOCK_PC_APPS.length)
  return MOCK_PC_APPS[idx] ?? 'Unknown'
}

/**
 * 创建 PC Adapter
 *
 * 统一 RuntimeAdapter 接口：
 * - start()：启动 timer，开始 emit pc:app_focus 事件
 * - stop()：清理 timer
 */
export function createPcAdapter(
  bus: EventBus,
  refreshMs: number,
  logger: Context['logger'],
): RuntimeAdapter {
  let disposed = false
  let timer: ReturnType<typeof setInterval> | null = null

  function safePublish(app: string): void {
    if (disposed || !bus) return
    try {
      bus.publish({
        source: 'pc',
        type: 'app_focus',
        data: { app },
        priority: 1,
      })
      logger.info('[pc-adapter] mock app_focus → %s', app)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      logger.warn('[pc-adapter] tick 异常: %s', detail)
    }
  }

  return {
    start(): void {
      if (disposed) return
      timer = setInterval(() => {
        if (!disposed) {
          safePublish(pickMockApp())
        }
      }, refreshMs)
    },

    stop(): void {
      disposed = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      logger.info('[pc-adapter] 已关闭（clearInterval）')
    },
  }
}

/**
 * PC Adapter Cordis plugin
 *
 * Phase 7.1A 重构：
 * - 返回 RuntimeAdapter 统一接口
 * - 适配现有 OrcaConfig 配置
 */
export function pcAdapter(ctx: Context, config: OrcaConfig): RuntimeAdapter {
  const bus = ctx.eventBus
  if (!bus) {
    ctx.logger.warn('[pc-adapter] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return {
      start() {},
      stop() {},
    }
  }

  const refreshMs = config.runtime.pc?.refreshMs ?? 60_000

  ctx.logger.info(
    '[pc-adapter] 已启动（mock 模式，refreshMs=%d，候选=%s）',
    refreshMs,
    MOCK_PC_APPS.join('/'),
  )

  const adapter = createPcAdapter(bus, refreshMs, ctx.logger)
  adapter.start()
  return adapter
}
