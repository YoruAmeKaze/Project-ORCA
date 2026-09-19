import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import { personaPrompt } from '../persona.js'
import type { ChatMessage } from '../services/llm.js'
import type { FeishuMessageEvent } from './feishu-channel.js'
import type { InfoRecord } from '../agents/types.js'
import type { InfoAgentRegistry } from '../agents/registry.js'
import type { JsonlInfoRecordStore } from '../agents/store.js'
import type { ContextAssembler } from '../types/context.js'
import type { WorldState } from '../types/worldState.js'

/** 饮食类问题关键词（R0 查档触发，命中档案即复用，不重复调视觉模型） */
const FOOD_QUERY_RE = /(卡路里|热量|千卡|kcal|吃了|摄入|饮食|早饭|午饭|晚饭|早餐|午餐|晚餐|吃)/i

/**
 * 删除命令意图（确定性执行，不经过 LLM）。
 *
 * v1.8.0 hotfix：原先第一分支含"不要"，导致"不要编""不要 emoji"等普通否定
 * 表达被误判为删除命令。修正后四条路径**都要求删除动词 +明确对象**同时出现，
 * 路径 D（v1.6 兼容：删动词 + 短间隔 + 对象词）保留"删掉火鸡面"形式。
 *
 * 路径 A（动词在前 + 指示词 + 对象词，严格）：
 *   (删除|删掉|删了|清空|清理|去掉) + (这条|那条|所有|全部|那些)? + (记录|档案|饮食|食物|饮食记录|food-log|数据)
 *
 * 路径 B（动词在后，兼容"把记录删掉"语序）：
 *   (这条|那条|所有|全部|那些)? + (记录|档案|饮食|食物|测试|饮食记录|food-log|数据) + (删除|删掉|删了|清空|清理|去掉)
 *
 * 路径 C（"不要"型，**必须**紧跟对象词）：
 *   不要 + (这条|那条|所有|全部|那些)? + (记录|档案|饮食|食物|饮食记录|food-log|数据)
 *
 * 路径 D（v1.6 兼容：删动词 + 任意短后文——v1.6 旧行为兜底）：
 *   (删除|删掉|删了|清空|清理|去掉) + .{0,14}
 *   用于保留"删掉火鸡面""删掉寿司""删掉昨天那条"等具体名词型删除。
 *   **关键边界**：不含"不要"——"不要"路径完全由路径 C 负责，
 *   路径 D 不会误判"不要编""不要 emoji"等普通否定。
 *
 * 反例（必须不触发）：
 *   "不要编" / "不要 emoji" / "不要客气" / "不要瞎说" → "不要" 后无对象词
 *   "具体一点详细一点，不要编" → 同上（多段以句末标点分隔）
 *
 * 正例（必须触发）：
 *   "删掉测试记录" / "删除这条记录" / "清空饮食记录" / "去掉刚才那条记录" / "不要这条记录" / "删掉火鸡面"
 */
const DELETE_INTENT_RE =
  /(?:(?:删除|删掉|删了|清空|清理|去掉)\s*(?:这条|那条|所有|全部|那些)?\s*(?:记录|档案|饮食|食物|饮食记录|food-log|数据))|(?:(?:这条|那条|所有|全部|那些)?\s*(?:记录|档案|饮食|食物|测试|饮食记录|food-log|数据)\s*(?:删除|删掉|删了|清空|清理|去掉))|(?:不要\s*(?:这条|那条|所有|全部|那些)?\s*(?:记录|档案|饮食|食物|饮食记录|food-log|数据))|(?:(?:删除|删掉|删了|清空|清理|去掉).{0,14})/i
const DELETE_ALL_RE = /(全部|所有|清空|全删)/i
const DELETE_NOISE_RE = /(测试|噪音|无效|unknown)/i
const DELETE_FOOD_STOPWORDS = /(记录|档案|饮食|食物|测试|全部|所有|那条|这条)/

/**
 * 确定性删除命令（D-AGENT 补充，2026-08-25）：
 * - "清空/全部删除记录" → 整个 food-agent 档案
 * - "删掉测试记录/噪音" → 低置信度（<0.3）或 unknown 类噪音
 * - "删掉火鸡面" → 按食物名匹配删除
 * 返回回复文案；不是删除意图返回 null。
 */
export async function handleDeleteIntent(text: string, store: JsonlInfoRecordStore): Promise<string | null> {
  if (!DELETE_INTENT_RE.test(text)) return null
  const all = DELETE_ALL_RE.test(text)
  const noise = DELETE_NOISE_RE.test(text)
  const kwMatch = /删(?:掉|了|除)?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,12})/.exec(text)
  let keyword = kwMatch?.[1] ?? ''
  if (DELETE_FOOD_STOPWORDS.test(keyword)) keyword = ''

  const records = await store.query({ namespaces: ['food-agent'], types: ['food-log'], limit: 200 })
  const targets: string[] = []
  const names: string[] = []
  const foodOf = (r: InfoRecord): string => String((r.payload as { food?: unknown })?.food ?? '')
  const isNoise = (r: InfoRecord): boolean => {
    const food = foodOf(r)
    return (r.confidence ?? 0) < 0.3 || ['unknown', '未知', '无', ''].includes(food)
  }

  for (const r of records) {
    const food = foodOf(r)
    if (all || (noise && isNoise(r)) || (keyword && food.toLowerCase().includes(keyword.toLowerCase()))) {
      targets.push(r.id)
      names.push(food || '未知')
    }
  }
  if (!targets.length) {
    return keyword ? `没找到「${keyword}」的记录。` : '没有可删的记录。'
  }
  const deleted = await store.delete('food-agent', targets)
  const uniq = [...new Set(names)].slice(0, 5).join('、')
  return `删了 ${deleted} 条${uniq ? `（${uniq}${names.length > 5 ? ' 等' : ''}）` : ''}。`
}

/**
 * Agent 插件（Phase 2 升级版）：
 * 订阅 feishu/message → 删除命令（确定性）→ R0 查档案 + 待汇报队列注入 → persona + 历史 → DeepSeek → 回写历史 → reply。
 * CEO 分工（D-AGENT-10）：Orca 只做理解/查档/汇总/回复，具体事项由 InfoAgent 执行。
 */
export function agent(ctx: Context, config: OrcaConfig) {
  ctx.on('feishu/message', async (msg: FeishuMessageEvent) => {
    const { feishu, llm, sessions, worldState, contextAssembler } = ctx as {
      feishu: { sendToChat(chatId: string, text: string): Promise<void> }
      llm: { chat(messages: ChatMessage[]): Promise<string> }
      sessions: { push(id: string, turn: { role: string; content: string }): void; get(id: string): { role: string; content: string }[] }
      worldState?: { getState(): WorldState }
      contextAssembler?: ContextAssembler
      infoAgents: InfoAgentRegistry
      infoStore: JsonlInfoRecordStore
      logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void }
    }
    try {
      ctx.logger.info('[agent] 收到 feishu/message: %s', msg.text.slice(0, 50))

      // Phase C：Runtime enabled 时，feishu/message 由 Runtime path 处理
      // CognitionCore → CognitionOutput → cognitionOutputPlugin → Feishu
      // Agent 不再执行 LLM cognition（避免双重回复）
      if (config.runtime.enabled) {
        ctx.logger.debug('[agent] Runtime enabled，跳过 LLM cognition（由 CognitionCore 处理）')
        // 确定性处理（删除命令）仍然执行
        const deleteReply = await handleDeleteIntent(msg.text, ctx.infoStore)
        if (deleteReply !== null) {
          ctx.logger.info('[agent] Runtime 模式下删除命令: %s -> %s', msg.text, deleteReply)
          if (!config.dryRun) await feishu.sendToChat(msg.chatId, deleteReply)
        }
        return
      }

      // Legacy path（ORCA_RUNTIME_ENABLED=0）：Agent 直接处理 LLM cognition
      // CEO 前置 0：删除命令（确定性执行，不进 LLM、不进历史）
      const deleteReply = await handleDeleteIntent(msg.text, ctx.infoStore)
      if (deleteReply !== null) {
        ctx.logger.info('[agent] 删除命令: %s -> %s', msg.text, deleteReply)
        if (!config.dryRun) await feishu.sendToChat(msg.chatId, deleteReply)
        return
      }

      sessions.push(msg.sessionId, { role: 'user', content: msg.text })

      // CEO 前置：R0 查档案（D-AGENT-10）+ 待汇报队列（D-AGENT-11，urgency=1）
      const archive = await buildArchiveContext(ctx.infoAgents, ctx.infoStore, msg.text)

      // Phase 6.B：Memory context via ContextAssembler
      let memoryContext = ''
      if (contextAssembler && worldState) {
        try {
          const ws = worldState.getState()
          const result = await contextAssembler.assemble(msg.text, ws)
          // 只注入 memory facts 部分（summary 已包含 WorldState+R2+R3；这里只追加 R3）
          if (result.memoryFacts.length > 0) {
            const memLines = result.memoryFacts.map((f) => f.formatted)
            memoryContext = `\n\n【长期记忆】以下事实来自你的长期记忆（直接引用，无需核实）：\n${memLines.join('\n')}`
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          ctx.logger.warn('[agent] ContextAssembler assemble failed: %s（不影响主流程）', detail)
        }
      }

      const system = personaPrompt() + (archive.context ? `\n\n${archive.context}` : '') + memoryContext

      const history = sessions.get(msg.sessionId)
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        ...history.map((turn) => ({ role: turn.role as ChatMessage['role'], content: turn.content })),
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

  // Dashboard chat — 与 feishu/message 并列，接收 ctx.emit('dashboard/message', {text,id})
  ctx.on('dashboard/message', async (payload: { text: string; id: string }) => {
    const DASHBOARD_SESSION = 'dashboard'
    try {
      const { eventBus, llm, sessions, infoAgents, infoStore, worldState, contextAssembler } = ctx as {
        eventBus: { publish(input: { source: string; type: string; data: Record<string, unknown>; priority?: number }): void }
        llm: { chat(messages: { role: string; content: string }[]): Promise<string> }
        sessions: { push(id: string, turn: { role: string; content: string }): void; get(id: string): { role: string; content: string }[] }
        infoAgents: { list(): { meta: { name: string; recordTypes?: string[] } }[] }
        infoStore: { query(opts: { namespaces?: string[]; types?: string[]; limit?: number }): Promise<unknown[]> }
        worldState?: { getState(): WorldState }
        contextAssembler?: ContextAssembler
        logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void }
      }
      const archive = await buildArchiveContext(infoAgents as Parameters<typeof buildArchiveContext>[0], infoStore as Parameters<typeof buildArchiveContext>[1], payload.text)

      // Phase 6.B：Memory context via ContextAssembler
      let memoryContext = ''
      if (contextAssembler && worldState) {
        try {
          const ws = worldState.getState()
          const result = await contextAssembler.assemble(payload.text, ws)
          if (result.memoryFacts.length > 0) {
            const memLines = result.memoryFacts.map((f) => f.formatted)
            memoryContext = `\n\n【长期记忆】以下事实来自你的长期记忆（直接引用，无需核实）：\n${memLines.join('\n')}`
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          ctx.logger.warn('[dashboard-chat] ContextAssembler failed: %s', detail)
        }
      }

      const system = personaPrompt() + (archive.context ? `\n\n${archive.context}` : '') + memoryContext
      sessions.push(DASHBOARD_SESSION, { role: 'user', content: payload.text })
      const history = sessions.get(DASHBOARD_SESSION)
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        ...history.map((t) => ({ role: t.role as ChatMessage['role'], content: t.content })),
      ]
      const reply = await llm.chat(messages)
      sessions.push(DASHBOARD_SESSION, { role: 'assistant', content: reply })
      ctx.logger.info('[dashboard-chat] 回复: %s', reply.slice(0, 80))
      eventBus.publish({ source: 'orca', type: 'dashboard-reply', data: { id: payload.id, reply, sessionId: DASHBOARD_SESSION }, priority: 1 })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[dashboard-chat] 处理失败: %s', detail)
      const bus = (ctx as { eventBus?: { publish(input: { source: string; type: string; data: Record<string, unknown>; priority?: number }): void } }).eventBus
      bus?.publish({ source: 'orca', type: 'dashboard-reply', data: { id: payload.id, reply: `出错了：${detail.slice(0, 100)}`, sessionId: DASHBOARD_SESSION, error: true }, priority: 1 })
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

agent.inject = ['feishu', 'llm', 'sessions', 'infoAgents', 'infoStore', 'eventBus', 'worldState', 'contextAssembler']
