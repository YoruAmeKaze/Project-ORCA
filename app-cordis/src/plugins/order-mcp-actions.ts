import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import { createOrderActionHandlers, createOrderMcpService } from '../services/orderMcp.js'
import type { ActionExecutorService } from '../types/action.js'

/** 两个独立官方 MCP 服务的只读 ActionHandler 装配；不注册任何写工具。 */
export function orderMcpActions(ctx: Context, config: OrcaConfig) {
  const service = createOrderMcpService(config.orderMcp, ctx.logger)
  ctx.provide('orderMcp', service)
  let disposed = false

  void service.initialize().then(() => {
    if (disposed) return
    const executor = ctx.get('actionExecutor') as ActionExecutorService | undefined
    if (!executor) {
      ctx.logger.warn('[order-mcp] ActionExecutor 不可用；点餐只读 Action 未注册')
      return
    }
    for (const handler of createOrderActionHandlers({ service, logger: ctx.logger })) {
      executor.registry.register(handler)
    }
    ctx.logger.info('[order-mcp] 只读 Action 已注册（%d 项）', service.availableActions().length)
  }).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : 'MCP discovery failed'
    ctx.logger.warn('[order-mcp] 初始化失败；相关 Action 保持关闭：%s', detail.slice(0, 160))
  })

  return () => {
    disposed = true
    service.dispose()
  }
}
