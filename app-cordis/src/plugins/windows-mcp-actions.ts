import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { ActionExecutorService } from '../types/action.js'
import { createWindowsDesktopActionHandlers, createWindowsMcpService } from '../services/windowsMcp.js'

/** Optional Windows-MCP read-only integration. Disabled by default and fail-closed. */
export function windowsMcpActions(ctx: Context, config: OrcaConfig) {
  const service = createWindowsMcpService(config.windowsMcp, ctx.logger)
  let disposed = false
  void service.initialize().then(() => {
    if (disposed) return
    const executor = ctx.get('actionExecutor') as ActionExecutorService | undefined
    if (!executor) {
      ctx.logger.warn('[windows-mcp] ActionExecutor 不可用；桌面 Action 未注册')
      return
    }
    for (const handler of createWindowsDesktopActionHandlers(service, ctx.logger)) executor.registry.register(handler)
    ctx.logger.info('[windows-mcp] 只读桌面 Action 已注册，%d 项', service.availableActions().length)
  }).catch((error: unknown) => {
    ctx.logger.warn('[windows-mcp] 服务未启用：%s', error instanceof Error ? error.message : String(error))
  })
  return () => { disposed = true; service.dispose() }
}
