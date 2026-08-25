import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import { foodLogAgent } from '../agents/builtins/food-log.js'
import type { AgentDeps } from '../agents/types.js'
import type { VisionClient } from '../services/vision.js'
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
  const reply = `老板，这${d.amount ? d.amount : '份'}${d.food}大约 ${d.kcal} kcal，已记入你的饮食档案。`
  return { reply, food: d.food, kcal: d.kcal, recordId: d.recordId }
}

/**
 * 飞书图片 → food-agent 识别 → 档案 → 回复确认。
 * 用户设定的"快捷指令发图到飞书，食物 agent 收照片"闭环（guide/orca-iphone-channel.md §2 通道①）。
 */
export function foodImage(ctx: Context, config: OrcaConfig) {
  ctx.on('feishu/image', async (img: FeishuImageEvent) => {
    const { feishu, vision, infoStore } = ctx
    try {
      const buf = await feishu.downloadImage(img.imageKey)
      const out = await processFoodImage(buf, { vision, store: infoStore, logger: ctx.logger, imagesDir: config.imagesDir })
      ctx.logger.info('[food-image] %s 识别: %s ≈ %dkcal（record=%s）', img.sessionId, out.food, out.kcal, out.recordId ?? '-')
      if (config.dryRun) {
        ctx.logger.info('[dry-run] 不发送飞书，识别回复: %s', out.reply)
      } else {
        await feishu.replyText(img.messageId, out.reply)
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[food-image] 处理失败: %s', detail)
      if (!config.dryRun) {
        const fallback = `图片处理出错了（${detail.slice(0, 120)}），稍后再试？`
        await feishu.replyText(img.messageId, fallback).catch(() => {
          // 兜底发送失败不再抛出
        })
      }
    }
  })
}

foodImage.inject = ['feishu', 'vision', 'infoStore']
