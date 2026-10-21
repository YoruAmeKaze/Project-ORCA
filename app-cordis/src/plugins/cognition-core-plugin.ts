/**
 * Orca CognitionCore Plugin —— Cordis integration（Phase B）
 *
 * 职责：
 * - 创建 CognitionCore 实例
 * - 订阅 'orca/cognition-request' → core.onCognitionRequest()
 * - 提供 ctx.cognitionCore service
 * - 返回 dispose 钩子
 *
 * 挂载时序（Phase B）：
 * - CognitionCorePlugin 在 CognitiveSchedulerPlugin 之后（消费 'orca/cognition-request'）
 * - CognitiveScheduler 决定"何时"发 cognition-request
 * - CognitionCore 决定"如何"执行 cognition
 *
 * Cordis quirk 防护：
 * - listener try/catch（handler 异常不崩服务、不阻塞其他 listener）
 * - inject = ['llm']（CognitionCore 需要 LLM 服务）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { CognitiveRequest } from '../types/cognition.js'
import { createCognitionCore } from '../services/cognition-core.js'
import type { CognitionCoreService } from '../services/cognition-core.js'

/**
 * CognitionCore Cordis plugin
 */
export function cognitionCorePlugin(ctx: Context, _config: OrcaConfig) {
  // 1. 创建 CognitionCore（注入 ctx 以便访问 llm service 和 emit 事件）
  const core: CognitionCoreService = createCognitionCore(ctx)
  ctx.provide('cognitionCore', core)
  ctx.logger.info('[cognition-core] 已启动（Phase B 骨架）')

  // 2. 订阅 'orca/cognition-request'：Scheduler 发出的请求 → CognitionCore 处理
  const unsubscribe = ctx.on('orca/cognition-request', (request: CognitiveRequest) => {
    try {
      core.onCognitionRequest(request)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[cognition-core] onCognitionRequest 异常 (requestId=%s): %s',
        request?.id ?? '?', detail)
    }
  })

  // 3. dispose 钩子
  return () => {
    ctx.logger.info('[cognition-core] 关闭')
    unsubscribe()
  }
}

/**
 * 必需依赖：llm service（CognitionCore 需要调用 LLM）。
 * inject 门控确保 llm 不可用时 plugin 不挂载。
 */
cognitionCorePlugin.inject = ['llm']
