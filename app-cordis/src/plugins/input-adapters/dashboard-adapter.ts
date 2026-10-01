/** Dashboard Input Adapter —— 前端消息 → OrcaEvent 翻译层 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../../config.js'

export interface DashboardMessageEvent {
  id: string
  text: string
  /** 浏览器/客户端持久化的会话标识；缺省时按单客户端回退 */
  sessionId?: string
  /** 客户端根据浏览器能力推断的设备类别；不是硬件指纹 */
  device?: 'mobile' | 'tablet' | 'desktop' | 'unknown'
}

/**
 * Dashboard 只发 Cordis 输入事件；由此 adapter 统一进入 Runtime EventBus。
 * 与 feishu-adapter 相同：不参与回复、不修改 WorldState。
 */
export function dashboardAdapter(ctx: Context, _config: OrcaConfig) {
  const bus = ctx.eventBus
  if (!bus) {
    ctx.logger.warn('[dashboard-adapter] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return
  }

  const unsubscribe = ctx.on('dashboard/message', (msg: DashboardMessageEvent) => {
    try {
      const sessionId = `dashboard:${msg.sessionId || 'default'}`
      ctx.logger.info('[dashboard-adapter] input received channel=dashboard sessionId=%s requestId=%s', sessionId, msg.id)
      bus.publish({
        id: msg.id,
        source: 'dashboard',
        type: 'message',
        timestamp: Date.now(),
        data: {
          id: msg.id,
          text: msg.text,
          actor: 'user',
          messageKind: 'user_message',
          device: msg.device ?? 'unknown',
        },
        priority: 1,
        sessionId,
        meta: { kind: 'user_message', actor: 'user', device: msg.device ?? 'unknown' },
      })
      ctx.logger.debug('[dashboard-adapter] event published channel=dashboard sessionId=%s requestId=%s', sessionId, msg.id)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[dashboard-adapter] publish message 失败: %s', detail)
    }
  })

  ctx.logger.info('[dashboard-adapter] 已订阅 dashboard/message → publish 到 EventBus')
  return unsubscribe
}
