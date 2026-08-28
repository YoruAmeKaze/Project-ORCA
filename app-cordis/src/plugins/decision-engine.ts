/**
 * Orca Decision Engine Plugin —— Cordis integration（Phase 4.A）
 *
 * 职责：
 * - 创建 DecisionEngine 实例（纯函数服务）
 * - 订阅 'orca/attention'（attention-engine emit 的产物）
 * - 每个 AttentionItem → engine.decide() → ctx.emit('orca/decision')
 * - 提供 ctx.decision service（pure function engine，便于外部直接调用）
 * - 返回 dispose 钩子（unsubscribe）
 *
 * 关键设计（严格无副作用）：
 * - **不阻塞原始 Attention publisher**（ctx.on 是 listener；不影响 orca/attention emit）
 * - **不重新判断 priority / reason / eventId**（直接透传 AttentionItem 字段）
 * - **不执行 action**（Phase 4.B ActionExecutor 职责）
 * - **不发飞书 / 写 infoStore / 调 LLM / 调 shell**（纯决策层；只翻译）
 * - **不持久化**
 *
 * 与 AttentionEngine 的关系：
 * - AttentionEngine 关心"是什么"（事件 → AttentionItem）
 * - DecisionEngine 关心"具体怎么做"（AttentionItem → Decision）
 * - 严格分层：Decision 不重新执行 Attention 规则
 *
 * Cordis quirk 防护：
 * - listener try/catch（handler 异常不崩服务、不阻塞其他 listener）
 * - emit 使用 ctx.emit（与现有事件机制一致）
 *
 * 挂载时序：
 * - DecisionEngine 必须在 AttentionEngine 之后挂载（依赖 orca/attention emit）
 * - 实际无 hard inject 依赖（DecisionEngine 是纯函数，不读 ctx 服务）
 * - 但 emit 顺序要求 attentionEngine 先挂 → 在 index.ts 中按顺序装配
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { AttentionItem } from '../types/attention.js'
import { createDecisionEngine } from '../services/decision.js'
import type { DecisionEngineService } from '../types/decision.js'

/**
 * DecisionEngine Cordis plugin
 *
 * 无 inject 声明（DecisionEngine 是纯函数；不强依赖 ctx 服务）。
 * 订阅 ctx.on('orca/attention') 不阻塞 emit（ctx.on 注册的是 listener；emit 是 sync 派发所有 listener）。
 */
export function decisionEngine(ctx: Context, _config: OrcaConfig) {
  // 1. 创建 DecisionEngine（纯函数，闭包无外部状态）
  const engine: DecisionEngineService = createDecisionEngine()
  ctx.provide('decision', engine)
  ctx.logger.info('[decision-engine] 已启动（纯决策层；不执行 action）')

  // 2. 订阅 'orca/attention'：每个 AttentionItem → decide → emit 'orca/decision'
  // - listener 同步派发（不阻塞 emit 调用方）
  // - try/catch 包裹（listener 异常不崩其他 listener；cordis quirk 防护）
  const unsubscribe = ctx.on('orca/attention', (item: AttentionItem) => {
    try {
      const decision = engine.decide(item)
      ctx.emit('orca/decision', decision)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[decision-engine] handler 异常 (ruleId=%s): %s',
        item?.ruleId ?? '?', detail)
    }
  })

  // 3. dispose 钩子
  return () => {
    ctx.logger.info('[decision-engine] 关闭（unsubscribe）')
    unsubscribe()
  }
}
