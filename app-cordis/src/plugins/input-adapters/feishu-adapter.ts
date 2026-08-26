/**
 * Feishu Input Adapter —— 飞书事件 → OrcaEvent 翻译层
 *
 * 职责：
 * - 订阅现有 'feishu/message' 与 'feishu/image' 事件
 * - 翻译为 OrcaEvent 并发布到 EventBus
 *
 * 设计原则：
 * - **不修改** feishu-channel.ts（零侵入；现有 agent / image-router / dashboard 订阅完全不受影响）
 * - feishu-adapter 只是"新增订阅者"，旁路接入
 * - 如果 EventBus 未注入（Runtime 未启用），adapter 是 no-op + warn log
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../../config.js'
import type { EventBus } from '../../services/eventBus.js'
import type { FeishuImageEvent, FeishuMessageEvent } from '../feishu-channel.js'

/**
 * 翻译飞书消息事件为 OrcaEvent（priority=1 normal）
 */
function feishuMessageToEvent(msg: FeishuMessageEvent) {
  return {
    id: msg.eventId || undefined, // feishu eventId 可作幂等键；空时由 EventBus 生成
    source: 'feishu' as const,
    type: 'message' as const,
    timestamp: Date.now(),
    data: {
      text: msg.text,
      openId: msg.openId,
      chatId: msg.chatId,
      messageId: msg.messageId,
    },
    priority: 1 as const,
    sessionId: msg.sessionId,
    meta: { eventId: msg.eventId, kind: 'text' },
  }
}

/**
 * 翻译飞书图片事件为 OrcaEvent（priority=1 normal，type=notification）
 */
function feishuImageToEvent(img: FeishuImageEvent) {
  return {
    id: img.eventId || undefined,
    source: 'feishu' as const,
    type: 'notification' as const,
    timestamp: Date.now(),
    data: {
      imageKey: img.imageKey,
      openId: img.openId,
      chatId: img.chatId,
      messageId: img.messageId,
    },
    priority: 1 as const,
    sessionId: img.sessionId,
    meta: { eventId: img.eventId, kind: 'image' },
  }
}

export function feishuAdapter(ctx: Context, _config: OrcaConfig) {
  const bus = ctx.eventBus
  if (!bus) {
    ctx.logger.warn('[feishu-adapter] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return
  }

  // 监听器必须 try/catch（cordis quirk：async 监听器 reject → unhandledRejection 崩进程）
  ctx.on('feishu/message', (msg: FeishuMessageEvent) => {
    try {
      bus.publish(feishuMessageToEvent(msg))
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[feishu-adapter] publish message 失败: %s', detail)
    }
  })

  ctx.on('feishu/image', (img: FeishuImageEvent) => {
    try {
      bus.publish(feishuImageToEvent(img))
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[feishu-adapter] publish image 失败: %s', detail)
    }
  })

  ctx.logger.info('[feishu-adapter] 已订阅 feishu/message + feishu/image → publish 到 EventBus')
}