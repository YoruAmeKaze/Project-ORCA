/**
 * Calendar Input Adapter —— 日历事件感知（Phase 2.D + Phase 7.1A 重构）
 *
 * Phase 7.1A 变更：
 * - 实现 RuntimeAdapter 统一接口 { start(), stop() }
 * - 保持现有 event 格式（calendar:calendar_event）
 * - 符合 GPT Review Phase 7.0：所有状态变更必须经过 EventBus
 *
 * 职责：
 * - 周期性 publish mock 日历事件到 EventBus（source='calendar', type='calendar_event'）
 * - Phase 2.D 第一版使用 mock（固定模板）；
 *   后续 Phase 可替换为真实实现（CalDAV / 飞书日历 API / iCloud）
 *
 * 事件 payload:
 *   data.title: 日历事件标题
 *   data.activity: 推导的活动类型（'meeting' / 'focus' / 'break'）
 *   data.minutesBefore: 距离开始还有多少分钟（mock 随机 1~10）
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

interface MockCalendarTemplate {
  title: string
  activity: 'meeting' | 'focus' | 'break'
}

const MOCK_TEMPLATES: MockCalendarTemplate[] = [
  { title: '项目同步会', activity: 'meeting' },
  { title: '设计 review', activity: 'meeting' },
  { title: '深度工作时间', activity: 'focus' },
  { title: '午饭', activity: 'break' },
]

function pickMockEvent(): MockCalendarTemplate {
  const idx = Math.floor(Math.random() * MOCK_TEMPLATES.length)
  return MOCK_TEMPLATES[idx] ?? { title: '未命名', activity: 'meeting' }
}

/**
 * 创建 Calendar Adapter
 *
 * 统一 RuntimeAdapter 接口：
 * - start()：启动 timer，开始 emit calendar:calendar_event 事件
 * - stop()：清理 timer
 */
export function createCalendarAdapter(
  bus: EventBus,
  refreshMs: number,
  logger: Context['logger'],
): RuntimeAdapter {
  let disposed = false
  let timer: ReturnType<typeof setInterval> | null = null

  function safePublish(tmpl: MockCalendarTemplate): void {
    if (disposed || !bus) return
    try {
      const minutesBefore = Math.floor(Math.random() * 10) + 1
      bus.publish({
        source: 'calendar',
        type: 'calendar_event',
        data: {
          title: tmpl.title,
          activity: tmpl.activity,
          minutesBefore,
        },
        priority: 1,
      })
      logger.info('[calendar-adapter] mock calendar_event → %s (%s, %d min)',
        tmpl.title, tmpl.activity, minutesBefore)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      logger.warn('[calendar-adapter] tick 异常: %s', detail)
    }
  }

  return {
    start(): void {
      if (disposed) return
      timer = setInterval(() => {
        if (!disposed) {
          safePublish(pickMockEvent())
        }
      }, refreshMs)
    },

    stop(): void {
      disposed = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      logger.info('[calendar-adapter] 已关闭（clearInterval）')
    },
  }
}

/**
 * Calendar Adapter Cordis plugin
 *
 * Phase 7.1A 重构：
 * - 返回 RuntimeAdapter 统一接口
 * - 适配现有 OrcaConfig 配置
 */
export function calendarAdapter(ctx: Context, config: OrcaConfig): RuntimeAdapter {
  const bus = ctx.eventBus
  if (!bus) {
    ctx.logger.warn('[calendar-adapter] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return {
      start() {},
      stop() {},
    }
  }

  const refreshMs = config.runtime.calendar?.refreshMs ?? 120_000

  ctx.logger.info(
    '[calendar-adapter] 已启动（mock 模式，refreshMs=%d，候选=%d）',
    refreshMs, MOCK_TEMPLATES.length,
  )

  const adapter = createCalendarAdapter(bus, refreshMs, ctx.logger)
  adapter.start()
  return adapter
}
