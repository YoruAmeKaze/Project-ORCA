/**
 * ReflectionEngine Cordis plugin（Phase 5.3）
 *
 * 职责：
 * - 创建 ReflectionEngine 实例
 * - 暴露 ctx.reflection service
 * - 不实现自动 scheduler（Phase 5.3 仅手动 reflect）
 * - 返回 dispose 钩子
 *
 * 依赖：
 * - ctx.memory service（MemoryStore）；缺失则 engine 进入 noop 模式
 *
 * Phase 5.3 MVP 不做：
 * - interval scheduler
 * - episode-burst 自动 reflect
 * - LLM 触发
 * - 任何自动 Decision / Attention 集成
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  createReflectionEngine,
  type ReflectionEngine,
  type ReflectionEngineContext,
} from '../services/reflectionEngine.js'

/**
 * ReflectionEngine Plugin
 */
export function reflectionEnginePlugin(ctx: Context): () => void {
  const engineCtx: ReflectionEngineContext = {
    memory: ctx.get('memory') as ReflectionEngineContext['memory'],
    logger: ctx.logger,
  }
  const engine: ReflectionEngine = createReflectionEngine(engineCtx)

  // 提供 service（fire-and-forget；不阻塞其它 plugin 初始化）
  ctx.provide('reflection', engine)

  ctx.logger?.info?.(
    '[reflection-engine] Phase 5.3 ReflectionEngine 已挂载（手动 reflectNow；deterministic rule only；无 LLM）',
  )

  return () => {
    engine.dispose()
    ctx.logger?.info?.('[reflection-engine] disposed')
  }
}