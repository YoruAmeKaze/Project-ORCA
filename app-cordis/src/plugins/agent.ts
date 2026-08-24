import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import { personaPrompt } from '../persona.js'
import type { ChatMessage } from '../services/llm.js'
import type { FeishuMessageEvent } from './feishu-channel.js'

/**
 * Agent 插件（Phase 1 最小闭环）：
 * 订阅 feishu/message → 拼 system prompt(persona) + 会话历史 → DeepSeek → 回写历史 → reply。
 * 工具调用 / 多步编排对应 Python 版 Planner+Validator+Engine，留到 Phase 2。
 */
export function agent(ctx: Context, config: OrcaConfig) {
  ctx.on('feishu/message', async (msg: FeishuMessageEvent) => {
    const { feishu, llm, sessions } = ctx
    try {
      sessions.push(msg.sessionId, { role: 'user', content: msg.text })
      const history = sessions.get(msg.sessionId)
      const messages: ChatMessage[] = [
        { role: 'system', content: personaPrompt() },
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      ]
      const reply = await llm.chat(messages)
      sessions.push(msg.sessionId, { role: 'assistant', content: reply })

      ctx.logger.info('[agent] %s 回复: %s', msg.sessionId, reply.slice(0, 100))
      if (config.dryRun) {
        ctx.logger.info('[dry-run] 不发送飞书，AI 回复: %s', reply)
      } else {
        await feishu.replyText(msg.messageId, reply)
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[agent] 处理失败: %s', detail)
      if (config.dryRun) {
        ctx.logger.info('[dry-run] 出错兜底回复: %s', detail.slice(0, 120))
      } else {
        const fallback = `出错了，稍等一下……（${detail.slice(0, 120)}）`
        await feishu.replyText(msg.messageId, fallback).catch(() => {
          // 兜底发送失败不再抛出，避免 unhandled rejection
        })
      }
    }
  })
}

agent.inject = ['feishu', 'llm', 'sessions']
