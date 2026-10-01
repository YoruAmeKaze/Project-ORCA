/**
 * Orca Persistent Context Runtime —— 顶层装配 plugin
 *
 * Phase 0+1 最小版（v0.5.0）：
 * - 创建 EventBus 实例
 * - 通过 ctx.provide('eventBus', ...) 注册为 Service
 * - 挂载 feishu-adapter（订阅飞书事件 → 翻译为 OrcaEvent → publish）
 *
 * 后续 Phase 计划（不在本版实现）：
 * - Phase 2：worldState + reducer
 * - Phase 3：attention engine + decision
 * - Phase 4：decision executor
 * - Phase 2+：calendar-mock / pc-adapter / phone-adapter
 *
 * 启用方式：环境变量 ORCA_RUNTIME_ENABLED=1
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import { EventBus } from '../services/eventBus.js'
import { dashboardAdapter } from './input-adapters/dashboard-adapter.js'
import { feishuAdapter } from './input-adapters/feishu-adapter.js'

export function orcaRuntime(ctx: Context, config: OrcaConfig) {
  // 1. 创建 EventBus 并注册为 Service
  const bus = new EventBus({ windowSize: config.runtime.eventWindowSize }, ctx.logger)
  ctx.provide('eventBus', bus)

  ctx.logger.info(
    '[orca-runtime] Phase 0+1 已启动（windowSize=%d，feishu-adapter 即将挂载）',
    config.runtime.eventWindowSize,
  )

  // 2. 挂载内置 adapters
  feishuAdapter(ctx, config)
  dashboardAdapter(ctx, config)

  // 3. 返回 dispose 钩子（cordis fiber 清理）
  return () => {
    ctx.logger.info('[orca-runtime] 关闭 EventBus')
    bus.dispose()
  }
}
