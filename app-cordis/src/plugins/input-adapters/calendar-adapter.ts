/**
 * Calendar Input Adapter —— 日历事件感知（Phase 2.D mock 版）
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
 * 设计原则：与 pc-adapter 一致（mock + 周期 timer + dispose clearInterval）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../../config.js'
import type { EventBus } from '../../services/eventBus.js'

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

export function calendarAdapter(ctx: Context, config: OrcaConfig) {
  const bus = ctx.eventBus
  if (!bus) {
    ctx.logger.warn('[calendar-adapter] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return
  }

  const refreshMs = config.runtime.calendar?.refreshMs ?? 120_000 // 默认 2 分钟

  const timer = setInterval(() => {
    try {
      const tmpl = pickMockEvent()
      const minutesBefore = Math.floor(Math.random() * 10) + 1 // 1~10 分钟
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
      ctx.logger.info('[calendar-adapter] mock calendar_event → %s (%s, %d min)',
        tmpl.title, tmpl.activity, minutesBefore)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[calendar-adapter] tick 异常: %s', detail)
    }
  }, refreshMs)

  ctx.logger.info(
    '[calendar-adapter] 已启动（mock 模式，refreshMs=%d，候选=%d）',
    refreshMs, MOCK_TEMPLATES.length,
  )

  return () => {
    ctx.logger.info('[calendar-adapter] 关闭（clearInterval）')
    clearInterval(timer)
  }
}