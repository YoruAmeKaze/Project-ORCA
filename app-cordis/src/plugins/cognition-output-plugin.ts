/**
 * Orca Cognition Output Plugin —— Runtime output boundary（Phase C）
 *
 * 职责：
 * - 订阅 'orca/cognition-output' 事件
 * - 根据 outputType 分发到正确的 consumer
 * - text/reply → Feishu sendToChat
 * - error → 记录 error 日志（后续阶段可扩展为告警）
 * - observation → 记录 debug 日志（后续阶段可接入 Memory/Reflection）
 *
 * 设计原则（Phase C）：
 * - CognitionCore 不知道 Feishu 的存在（通过事件边界解耦）
 * - CognitionCore 不知道 ActionExecutor 的存在
 * - 本 plugin 负责"认知结果如何到达用户"这个职责
 * - 当前只处理 text/reply（Feishu reply）
 *
 * 不做（Phase C）：
 * - 不处理 observation 类输出（Phase C+ 接入 Memory/Reflection）
 * - 不处理 error 告警（Phase C+ 接入告警系统）
 * - 不做模型路由 / 多 consumer 分发
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { Decision } from '../types/decision.js'
import type { CognitionOutput, CognitionActionIntent } from '../context.js'

/**
 * Cognition Output Plugin
 *
 * @param ctx Cordis Context
 * @param config Orca runtime config（用于读取 ORCA_RUNTIME_ENABLED 等）
 */
export function cognitionOutputPlugin(ctx: Context, config: OrcaConfig) {
  // 只在 Runtime 启用时处理 cognition output
  // （Runtime 未启用时，Legacy Agent path 直接调 LLM，不需要这个 handler）
  if (!config.runtime.enabled) {
    ctx.logger.debug('[cognition-output] Runtime 未启用，跳过 cognition output handler')
    return
  }

  const feishu = (ctx as { feishu?: { sendToChat(chatId: string, text: string): Promise<void> } }).feishu

  const unsubscribe = ctx.on('orca/cognition-output', (output: CognitionOutput) => {
    try {
      switch (output.outputType) {
        case 'text/reply':
          handleTextReply(output, feishu)
          break
        case 'error':
          ctx.logger.warn('[cognition-output] cognition error output: cognitionId=%s error=%s',
            output.cognitionId, output.output)
          break
        case 'observation':
          ctx.logger.debug('[cognition-output] cognition observation: cognitionId=%s output=%s',
            output.cognitionId, output.output.slice(0, 80))
          break
        // Phase D：action 类型输出 → 转换为 Decision → emit 'orca/decision'
        case 'action':
          if (output.actionIntent) {
            const decision = cognitionIntentToDecision(output.actionIntent)
            ctx.emit('orca/decision', decision)
            ctx.logger.info('[cognition-output] action intent → decision: action=%s decisionId=%s',
              decision.action, decision.decisionId)
          } else {
            ctx.logger.warn('[cognition-output] action output without actionIntent: cognitionId=%s',
              output.cognitionId)
          }
          break
        default:
          ctx.logger.debug('[cognition-output] unknown output type: %s', (output as { outputType: string }).outputType)
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[cognition-output] 处理 cognition output 异常: %s', detail)
    }
  })

  ctx.logger.info('[cognition-output] 已启动（Runtime enabled，订阅 orca/cognition-output）')

  return () => {
    ctx.logger.info('[cognition-output] 关闭')
    unsubscribe()
  }
}

/**
 * 将 CognitionActionIntent 转换为 legacy Decision（Phase D 局部兼容转换）
 *
 * 这是当前复用的 compatibility path，不是永久架构抽象。
 * 未来删除 DecisionEngine 时，只需修改这个局部转换函数。
 */
function cognitionIntentToDecision(intent: CognitionActionIntent): Decision {
  return {
    decisionId: randomUUID(),
    attentionId: intent.attentionId,
    ruleId: 'cognition',
    action: intent.action as Decision['action'],
    priority: 'normal',
    reason: intent.reason,
    eventId: undefined,
    source: 'cognition',
    decidedAt: Date.now(),
  }
}

/**
 * 处理 text/reply 类输出
 * - 从 CognitionOutput.chatId 获取目标会话
 * - 通过 feishu.sendToChat() 回复用户
 *
 * 如果 chatId 不可用（来自非飞书源的 cognition），跳过发送（避免错误路由）
 */
function handleTextReply(
  output: CognitionOutput,
  feishu: { sendToChat(chatId: string, text: string): Promise<void> } | undefined,
) {
  if (!output.chatId) {
    // 这个 cognition 不是由飞书消息触发的，跳过 Feishu reply
    // （后续阶段，非飞书来源的 output 可以通过其他 adapter 处理）
    return
  }

  if (!feishu?.sendToChat) {
    // feishu service 不可用，跳过发送
    return
  }

  // 避免空输出
  if (!output.output.trim()) {
    return
  }

  feishu.sendToChat(output.chatId, output.output).catch((err: unknown) => {
    // 发送失败不抛异常（飞书接口问题不应该影响 cognition 本身的状态）
    const detail = err instanceof Error ? err.message : String(err)
    console.warn('[cognition-output] Feishu sendToChat failed: %s', detail)
  })
}
