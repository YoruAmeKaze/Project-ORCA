/**
 * Orca CognitionCore Service —— 认知执行核心（Phase B 最小可用骨架）
 *
 * 职责（Phase B）：
 * - 订阅 'orca/cognition-request' 事件
 * - 接收 CognitiveRequest → 创建 CognitionSession
 * - 发 'cognition/started'
 * - 构造最小 prompt（persona + attention reasons）→ 调用 LLM
 * - 发 'cognition:completed' 或 'cognition:failed'
 * - 管理 WorkingMemory（ephemeral，cognition 结束后丢弃）
 *
 * 严格约束（Phase B）：
 * - ❌ 不接入 ContextAssembler（那是 CEO/Agent 的 context）
 * - ❌ 不做 tool calling（Phase D+）
 * - ❌ 不做 TaskManager（Phase E+）
 * - ❌ 不做 memory exploration / promotion（Phase C+）
 * - ❌ 不做 ActionExecutor 调用
 * - ❌ 不直接修改 WorldState
 * - ❌ 不持久化 WorkingMemory / CognitionSession
 *
 * 并发策略（Phase B）：
 * - 如果已有 active session，拒绝新的 cognition request（emit busy log）
 * - 等待 Scheduler 实现自动 defer——当前阶段直接拒绝
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ChatMessage } from './llm.js'
import type { CognitiveRequest } from '../types/cognition.js'
import type { CognitionSession, WorkingMemory, CognitionResult } from '../types/cognition-core.js'
import type { CognitionOutput, CognitionActionIntent } from '../context.js'
import { personaPrompt } from '../persona.js'

/**
 * 解析 LLM 输出中的 action intent（Phase D 最小实现）
 *
 * 格式约定：/act:<action>:<reason>
 * 示例：/act:no_action:minimal-test
 * 示例：/act:remember:reminder-setup:please remember this
 *
 * Phase D 目的：验证 structured action boundary，不设计长期 LLM 协议。
 * 后续（Phase E+）替换为 JSON structured output 解析。
 *
 * 约束：纯函数，不调用任何 ctx 服务，不发事件，不修改状态，后续可抽离为独立文件。
 */
function parseActionIntent(output: string): CognitionActionIntent | null {
  const trimmed = output.trim()
  const match = trimmed.match(/^\/act:([^:]+):(.*)/)
  if (!match || !match[1] || !match[2]) return null
  return {
    action: match[1].trim(),
    reason: match[2].trim(),
    attentionId: '', // 由调用方填充
  }
}

/**
 * 创建 CognitionCore 实例
 *
 * @param ctx Cordis Context（用于 llm service、emit 事件、logger）
 */
export function createCognitionCore(ctx: Context) {
  // 当前活跃 session（ephemeral，CognitionCore 私有）
  let activeSession: CognitionSession | null = null

  /**
   * 处理 CognitiveRequest 的核心逻辑
   */
  async function processRequest(request: CognitiveRequest): Promise<void> {
    // 防御：如果已有 running session，拒绝新的 cognition
    if (activeSession !== null) {
      ctx.logger.warn('[cognition-core] cognition %s rejected: session %s still running',
        request.id, activeSession.id)
      return
    }

    const sessionId = randomUUID()
    const startedAt = Date.now()

    // 创建 CognitionSession
    const session: CognitionSession = {
      id: sessionId,
      requestId: request.id,
      createdAt: startedAt,
      startedAt,
      attentions: request.attentions,
      status: 'running',
    }
    activeSession = session

    // 创建 WorkingMemory（Phase B 极简版）
    const workingMemory: WorkingMemory = {
      goal: request.trigger,
      observations: [],
    }

    // 发 cognition/started
    ctx.emit('cognition/started', sessionId, request.id)
    ctx.logger.info('[cognition-core] cognition started: session=%s request=%s attentions=%d',
      sessionId, request.id, request.attentions.length)

    // 构造 prompt
    const messages = buildPrompt(session, workingMemory)

    // 调用 LLM
    const durationMs = Date.now() - startedAt
    try {
      const llm = (ctx as { llm?: { chat(messages: ChatMessage[]): Promise<string> } }).llm
      if (!llm?.chat) {
        throw new Error('llm service not available')
      }

      const output = await llm.chat(messages)
      workingMemory.observations.push(output)

      // Phase D：解析 LLM 输出中是否包含 action intent
      const intent = parseActionIntent(output)
      const outputType: CognitionOutput['outputType'] = intent ? 'action' : 'text/reply'
      const actionIntent: CognitionOutput['actionIntent'] = intent
        ? { ...intent, attentionId: session.attentions[0]?.id ?? '' }
        : undefined

      const result: CognitionResult = {
        cognitionId: sessionId,
        requestId: request.id,
        status: 'completed',
        output,
        durationMs: Date.now() - startedAt,
      }

      // 更新 session 状态
      session.status = 'completed'
      session.endedAt = Date.now()

      ctx.emit('cognition/completed', sessionId, result)
      ctx.emit('orca/cognition-output', {
        cognitionId: sessionId,
        requestId: request.id,
        output,
        outputType,
        actionIntent,
        attentionIds: session.attentions.map((a) => a.id),
        chatId: session.attentions[0]?.chatId,
      } satisfies CognitionOutput)
      ctx.logger.info('[cognition-core] cognition completed: session=%s output=%s',
        sessionId, output.slice(0, 80))

    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)

      const result: CognitionResult = {
        cognitionId: sessionId,
        requestId: request.id,
        status: 'failed',
        error,
        durationMs: Date.now() - startedAt,
      }

      // 更新 session 状态
      session.status = 'failed'
      session.endedAt = Date.now()

      ctx.emit('cognition/failed', sessionId, error)
      // error output 也通过 boundary 传递，使 consumer 可以决定如何处理
      ctx.emit('orca/cognition-output', {
        cognitionId: sessionId,
        requestId: request.id,
        output: error,
        outputType: 'error',
        attentionIds: session.attentions.map((a) => a.id),
        chatId: session.attentions[0]?.chatId,
      } satisfies CognitionOutput)
      ctx.logger.warn('[cognition-core] cognition failed: session=%s error=%s',
        sessionId, error)
    } finally {
      activeSession = null
      // WorkingMemory 丢弃（ephemeral，不持久化）
    }
  }

  /**
   * 构造 LLM prompt（Phase B 极简版）
   *
   * 策略：
   * - system: personaPrompt()
   * - user: attention reasons 作为认知目标描述
   *
   * 注意：Phase B 不接入 ContextAssembler，
   * 因为 CognitionCore 不是 Agent/CEO，不走 R0 档案查询那条路。
   */
  function buildPrompt(session: CognitionSession, _workingMemory: WorkingMemory): ChatMessage[] {
    const system = personaPrompt()

    // 将 attention reasons 组装成一个 user message
    const attentionDescriptions = session.attentions
      .map((a) => `[${a.priority}] ${a.reason} (rule: ${a.ruleId})`)
      .join('\n')

    const userMessage = `当前认知目标：\n${session.attentions[0]?.ruleId ?? 'general'}\n\n相关注意力项：\n${attentionDescriptions}\n\n请进行认知处理。\n（如需执行 action，可使用格式：/act:<action>:<reason>，例如 /act:no_action:minimal-test）`

    return [
      { role: 'system', content: system },
      { role: 'user', content: userMessage },
    ]
  }

  return {
    /**
     * 获取当前活跃 session（测试/监控用）
     */
    getActiveSession(): CognitionSession | null {
      return activeSession
    },

    /**
     * 获取当前 WorkingMemory（如果有）
     * Phase B 暂不暴露，等需要调试时再加
     */

    /**
     * 内部事件处理器：订阅 'orca/cognition-request'
     */
    onCognitionRequest(request: CognitiveRequest): void {
      // Phase B 策略：直接 process，不 queue
      // 后续 phase 会改这里实现 defer/priority
      void processRequest(request)
    },
  }
}

export type CognitionCoreService = ReturnType<typeof createCognitionCore>
