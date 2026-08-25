import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import { personaPrompt } from '../persona.js'
import type { ChatMessage } from '../services/llm.js'
import type { FeishuMessageEvent } from './feishu-channel.js'
import type { InfoRecord } from '../agents/types.js'
import type { InfoAgentRegistry } from '../agents/registry.js'
import type { JsonlInfoRecordStore } from '../agents/store.js'

/** 饮食类问题关键词（R0 查档触发，命中档案即复用，不重复调视觉模型） */
const FOOD_QUERY_RE = /(卡路里|热量|千卡|kcal|吃了|摄入|饮食|早饭|午饭|晚饭|早餐|午餐|晚餐|吃)/i

/**
 * Agent 插件（Phase 2 升级版）：
 * 订阅 feishu/message → R0 查档案 + 待汇报队列注入 → persona + 历史 → DeepSeek → 回写历史 → reply。
 * CEO 分工（D-AGENT-10）：Orca 只做理解/查档/汇总/回复，具体事项由 InfoAgent 执行。
 */
export function agent(ctx: Context, config: OrcaConfig) {
  ctx.on('feishu/message', async (msg: FeishuMessageEvent) => {
    const { feishu, llm, sessions } = ctx
    try {
      sessions.push(msg.sessionId, { role: 'user', content: msg.text })

      // CEO 前置：R0 查档案（D-AGENT-10）+ 待汇报队列（D-AGENT-11，urgency=1）
      const archive = await buildArchiveContext(ctx.infoAgents, ctx.infoStore, msg.text)
      const system = personaPrompt() + (archive.context ? `\n\n${archive.context}` : '')

      const history = sessions.get(msg.sessionId)
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      ]
      const reply = await llm.chat(messages)
      sessions.push(msg.sessionId, { role: 'assistant', content: reply })

      // 汇报已带出，ack 移出待汇报队列（失败则保留，下条消息再带）
      if (archive.pendingIds.length) ctx.infoStore.ackPending(archive.pendingIds)

      ctx.logger.info('[agent] %s 回复: %s', msg.sessionId, reply.slice(0, 100))
      if (config.dryRun) {
        ctx.logger.info('[dry-run] 不发送飞书，AI 回复: %s', reply)
      } else {
        // 独立消息（非引用回复）：用发送接口 + chat_id，像普通聊天
        await feishu.sendToChat(msg.chatId, reply)
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[agent] 处理失败: %s', detail)
      if (config.dryRun) {
        ctx.logger.info('[dry-run] 出错兜底回复: %s', detail.slice(0, 120))
      } else {
        const fallback = `出错了，稍等一下……（${detail.slice(0, 120)}）`
        await feishu.sendToChat(msg.chatId, fallback).catch(() => {
          // 兜底发送失败不再抛出，避免 unhandled rejection
        })
      }
    }
  })
}

/** R0 查档 + 待汇报队列组装注入上下文 */
async function buildArchiveContext(
  registry: InfoAgentRegistry,
  store: JsonlInfoRecordStore,
  text: string,
): Promise<{ context: string; pendingIds: string[] }> {
  const parts: string[] = []
  const pendingIds: string[] = []

  // R0：查档案优先 —— 饮食类问题先跨 agent 查记录库，命中即复用（零成本，D-AGENT-10）
  if (FOOD_QUERY_RE.test(text)) {
    const records: InfoRecord[] = []
    for (const agent of registry.list()) {
      if (!agent.meta.recordTypes?.length) continue
      records.push(...(await store.query({ namespaces: [agent.meta.name], types: agent.meta.recordTypes, limit: 10 })))
    }
    records.sort((a, b) => b.ts - a.ts)
    if (records.length) {
      const lines = records.slice(0, 10).map(formatFoodRecord)
      parts.push(`【档案室 R0 命中】以下是最近的饮食记录（直接引用即可，无需再识别/搜索）：\n${lines.join('\n')}`)
    }
  }

  // 待汇报队列（D-AGENT-11）：urgency=1 的记录，下条消息自然带一句（回复成功后 ack）
  const pending = await store.peekPending()
  if (pending.length) {
    const lines = pending.map((r) => `- [${r.namespace}/${r.type}] ${summarizePayload(r.payload)}`)
    parts.push(`【待汇报】以下事项发生在用户上一条消息之后，请在回复里自然带一句（不展开成专题）：\n${lines.join('\n')}`)
    pendingIds.push(...pending.map((r) => r.id))
  }

  return { context: parts.join('\n\n'), pendingIds }
}

function formatFoodRecord(r: InfoRecord): string {
  const p = r.payload as { food?: string; kcal?: number; amount?: string }
  const t = new Date(r.ts).toLocaleString('zh-CN', { hour12: false })
  const kcal = typeof p.kcal === 'number' ? ` ≈ ${p.kcal} kcal` : ''
  const amount = p.amount ? `（${p.amount}）` : ''
  return `- ${t} ${p.food ?? '未知'}${kcal}${amount}`
}

function summarizePayload(payload: unknown): string {
  const p = payload as Record<string, unknown>
  const food = typeof p.food === 'string' ? p.food : ''
  const kcal = typeof p.kcal === 'number' ? p.kcal : null
  if (food) return `${food}${kcal !== null ? ` ≈ ${kcal}kcal` : ''}`
  const s = JSON.stringify(payload)
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

agent.inject = ['feishu', 'llm', 'sessions', 'infoAgents', 'infoStore']
