import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { FeishuImageEvent } from './feishu-channel.js'
import { handleFoodImage } from './food-image.js'

/** 解析会话绑定（D-AGENT-15）：chat_id → agent 名；未绑定返回 undefined（默认 Orca 主管线） */
export function resolveChatAgent(bindings: Record<string, string>, chatId: string): string | undefined {
  if (!chatId) return undefined
  return bindings[chatId]
}

/**
 * 图片事件路由层（D-AGENT-15 会话绑定路由 / 工位分配）：
 * 订阅 'feishu/image' → 查 chat_id → agent 绑定表（ORCA_CHAT_BINDINGS）→ **只派发给绑定 agent，不广播**。
 * - 绑定 food-agent → 走 food 识别管线（下载 → Qwen 识别 → 写 food-log 档案 → 回复确认）
 * - 未绑定会话 → 默认 Orca 主管线（当前主管线无图片能力，忽略并留日志）
 * - 绑定未知 agent → warn + 忽略（防配置错误静默）
 * 意图由"发到哪个工位"声明：用户把照片发到食物群 = 明说这是食物（确定性、零 LLM 开销）。
 */
export function imageRouter(ctx: Context, config: OrcaConfig) {
  ctx.on('feishu/image', async (img: FeishuImageEvent) => {
    try {
      const agent = resolveChatAgent(config.chatBindings, img.chatId)
      if (!agent) {
        ctx.logger.info('[image-router] chat=%s 未绑定 agent，走默认 Orca 主管线（当前无图片处理，忽略）', img.chatId || '(空)')
        return
      }
      switch (agent) {
        case 'food-agent':
          await handleFoodImage(ctx, config, img)
          break
        default:
          ctx.logger.warn('[image-router] chat=%s 绑定未知 agent=%s，忽略该图片', img.chatId, agent)
      }
    } catch (err) {
      // 事件监听器异常不能崩进程（否则 unhandledRejection → 服务挂）
      ctx.logger.warn('[image-router] 处理异常: %s', err instanceof Error ? err.message : String(err))
    }
  })
}

// 必需：handleFoodImage 内访问 ctx.feishu/vision/infoStore，须在插件 fiber 声明（cordis inject 门控）
imageRouter.inject = ['feishu', 'vision', 'infoStore']
