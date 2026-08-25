import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import { foodLogAgent } from '../agents/builtins/food-log.js'
import type { AgentDeps } from '../agents/types.js'
import type { VisionClient } from '../services/vision.js'
import type { FeishuClient } from '../services/feishu.js'
import type { JsonlInfoRecordStore } from '../agents/store.js'
import type { FeishuImageEvent } from './feishu-channel.js'

export interface FoodImageDeps {
  vision: VisionClient
  store: JsonlInfoRecordStore
  logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void }
  imagesDir: string
}

/**
 * 图片字节 → 落盘 → food-agent 识别 → 写 food-log 档案 → 回复文案。
 * 独立函数便于冒烟测试（注入任意图片字节 + stub 视觉，不依赖真实飞书下载）。
 */
export async function processFoodImage(
  buf: Buffer,
  deps: FoodImageDeps,
): Promise<{ reply: string; food: string; kcal: number; recordId?: string }> {
  await mkdir(deps.imagesDir, { recursive: true })
  const filePath = resolve(deps.imagesDir, `${Date.now()}-${randomUUID().slice(0, 8)}.jpg`)
  await writeFile(filePath, buf)

  const agentDeps: AgentDeps = { vision: deps.vision, store: deps.store, logger: deps.logger }
  const result = await foodLogAgent.execute({ agent: 'food-agent', input: { imagePath: filePath }, sessionId: 'food-image' }, agentDeps)
  if (!result.ok) throw new Error(result.error.message)

  const d = result.data
  // 平级 + 平淡（2026-08-25 用户指定）：不喊"老板"，记账式短句
  const reply = `这${d.amount ? d.amount : '份'}${d.food}，约 ${d.kcal} 千卡。记下了。`
  return { reply, food: d.food, kcal: d.kcal, recordId: d.recordId }
}

/**
 * 飞书图片事件 → food-agent 识别 → 档案 → 回复确认（事件处理器，供 image-router 按绑定调用，D-AGENT-15）。
 * 不再自订阅 'feishu/image'：由会话绑定路由决定该图片是否归 food-agent 处理（杜绝多图片 agent 混图）。
 */
export async function handleFoodImage(
  ctx: Context,
  config: OrcaConfig,
  img: FeishuImageEvent,
): Promise<void> {
  let feishu: FeishuClient | undefined
  try {
    const { feishu: f, vision, infoStore } = ctx
    feishu = f
    const buf = await feishu.downloadImage(img.messageId, img.imageKey)
    const out = await processFoodImage(buf, { vision, store: infoStore, logger: ctx.logger, imagesDir: config.imagesDir })
    ctx.logger.info('[food-image] %s 识别: %s ≈ %dkcal（record=%s）', img.sessionId, out.food, out.kcal, out.recordId ?? '-')
    if (config.dryRun) {
      ctx.logger.info('[dry-run] 不发送飞书，识别回复: %s', out.reply)
    } else {
      // 独立消息（非引用回复）：用发送接口 + chat_id
      await feishu.sendToChat(img.chatId, out.reply)
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ctx.logger.warn('[food-image] 处理失败: %s', detail)
    if (!config.dryRun && feishu) {
      const fallback = `图片处理出错了（${detail.slice(0, 120)}），稍后再试？`
      await feishu.sendToChat(img.chatId, fallback).catch(() => {
        // 兜底发送失败不再抛出
      })
    }
  }
}
