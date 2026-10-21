/**
 * ContextAssemblerProvider —— Cordis 插件（Phase 6.A 启动顺序修复）
 *
 * 职责：
 * - 注入依赖：memory + infoStore（由 Cordis DI 在 plugin fiber 激活时同步解析）
 * - 同步 provide('contextAssembler', ...)（在 plugin 函数体内直接注册）
 * - agent plugin 的 inject['contextAssembler'] 依赖由此满足
 *
 * 设计动机：
 * - Cordis v4 的 ctx.plugin() 是异步 Fiber 激活，plugin 函数在 fiber 进入 activate 状态才跑
 * - index.ts 顶层若用 ctx.get('infoStore') 紧跟 ctx.plugin(infoAgents, ...)，会拿到 undefined
 * - 通过独立插件 + inject 声明，让 Cordis DI 在 fiber 激活时同步保证 memory + infoStore 已就绪
 *
 * 不做（边界）：
 * - 不修改 infoAgents 职责
 * - 不修改 ContextAssembler API
 * - 不修改 agent.inject
 * - 不调用 await ctx.plugin()（仅依赖 Cordis DI）
 * - 不在顶层 bootstrap 用 async
 *
 * 启用方式：环境变量 ORCA_CONTEXT_ASSEMBLER_ENABLED 默认 true（config.contextAssembler.enabled）
 */
import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import { createContextAssembler } from '../services/contextAssembler.js'
import type { MemoryStore } from '../types/memory.js'
import type { JsonlInfoRecordStore } from '../agents/store.js'

/**
 * ContextAssemblerProvider Cordis plugin
 * inject: memory + infoStore —— Cordis DI 在 fiber 激活时同步注入，确保 provide 时两者均已就绪
 */
export function contextAssemblerProvider(ctx: Context, config: OrcaConfig): void {
  // 通过 ctx.get() 取 service（与 episode-engine / reflection-engine 风格一致）
  const memory = ctx.get('memory') as MemoryStore | undefined
  const infoStore = ctx.get('infoStore') as JsonlInfoRecordStore | undefined

  if (!memory || !infoStore) {
    ctx.logger.warn(
      '[context-assembler-provider] 跳过：memory=%s, infoStore=%s（需 MemoryStore + InfoRecordStore 均启用）',
      !!memory, !!infoStore,
    )
    return
  }

  if (!config.contextAssembler.enabled) {
    ctx.logger.info('[context-assembler-provider] 未启用（ORCA_CONTEXT_ASSEMBLER_ENABLED=0 关闭）')
    return
  }

  ctx.provide('contextAssembler', createContextAssembler(memory, infoStore, config.contextAssembler, {
    info: ctx.logger.info.bind(ctx.logger),
    warn: ctx.logger.warn.bind(ctx.logger),
  }))
  ctx.logger.info(
    '[orca-cordis] Phase 6.A ContextAssembler 已启用（memoryTopK=%d, memoryBudgetChars=%d）',
    config.contextAssembler.memoryTopK,
    config.contextAssembler.memoryBudgetChars,
  )
}

/**
 * 必需依赖：memory + infoStore（infoAgents plugin 内同步 provide）
 * Cordis inject 门控：直到 memory + infoStore 都 provide 后此插件才激活
 */
contextAssemblerProvider.inject = ['memory', 'infoStore']

