/**
 * Orca Action Executor Plugin — Cordis integration (Phase 4.B + Phase 4.C)
 *
 * 职责：
 * - 创建 ActionExecutor 实例（含 ActionHandlerRegistry + DeferredActionStore）
 * - 注册内置 handler：noop / remember(store-dep) / defer / act-stub（默认）
 * - Phase 4.C 注册真实 notify handler（依赖 feishu + eventBus；缺失则保留 notify-stub）
 * - 订阅 'orca/decision'（decision-engine emit 的产物）
 * - 每个 Decision → executor.execute() → ctx.emit('orca/action-result')
 * - 提供 ctx.actionExecutor service（便于外部直接调用）
 * - 返回 dispose 钩子（unsubscribe）
 *
 * 关键设计（严格分层）：
 * - **不阻塞原始 Decision publisher**（ctx.on 是 listener；不影响 orca/decision emit）
 * - **不重新评估 Attention 规则 / priority / Decision**
 * - **不修改 Decision / AttentionItem / WorldState**
 * - **handler 异常隔离**：handler.execute 抛错被 catch 转化为 ActionResult.success=false
 *
 * 安全约束（用户决策，2026-08-27）：
 * - act handler 默认 stub（success=false + "action handler not configured"）
 * - 不允许任意 shell / 任意 JS / 任意插件调用
 * - 不允许 fake shell executor
 *
 * Cordis quirk 防护：
 * - listener try/catch（handler 异常不崩服务、不阻塞其他 listener）
 * - emit 使用 ctx.emit（与现有事件机制一致）
 *
 * 挂载时序：
 * - ActionExecutor 必须在 DecisionEngine 之后挂载（依赖 orca/decision emit）
 * - remember handler 需要 infoStore；infoAgents plugin 已先挂（infoStore 已 provide）
 * - notify handler 需要 feishu + eventBus；index.ts 已先 provide feishu（line 45）+ orcaRuntime provide eventBus
 *
 * 配置：
 * - ORCA_ACTION_ENABLED 默认 false（用户决策：默认安全）
 * - 启用时挂载 plugin；不启用时跳过整个 executor
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { Decision } from '../types/decision.js'
import type { ActionExecutorService } from '../types/action.js'
import {
  createActionExecutor,
  createMemoryForgetHandler,
  createMemoryRememberHandler,
  createNotifyHandler,
  createRememberHandler,
} from '../services/action.js'

/**
 * ActionExecutor Cordis plugin
 *
 * 无 inject 声明（executor 不强依赖 ctx 服务；remember/notify handler 由 plugin 内部按需获取）。
 * 订阅 ctx.on('orca/decision') 不阻塞 emit（ctx.on 注册的是 listener；emit 是 sync 派发所有 listener）。
 */
export function actionExecutor(ctx: Context, _config: OrcaConfig) {
  // 1. 创建 ActionExecutor（含 registry + deferred store）
  const executor: ActionExecutorService = createActionExecutor()
  ctx.provide('actionExecutor', executor)

  // 2. 注入 remember handler（依赖 infoStore）
  // infoStore 在 infoAgents plugin 中 provide；这里用 ctx.get 软获取（未启用时跳过）
  const store = ctx.get('infoStore') as
    | Parameters<typeof createRememberHandler>[0]['store']
    | undefined
  if (store) {
    executor.registry.register(createRememberHandler({
      store,
      logger: ctx.logger,
    }))
    ctx.logger.info('[action-executor] remember handler 已挂载（infoStore 依赖）')
  } else {
    ctx.logger.info(
      '[action-executor] infoStore 未提供；remember handler 未挂载（其他 handler 不受影响）',
    )
  }

  // 2.5 注入 notify handler（Phase 4.C 真实通知；依赖 feishu + eventBus）
  // 任一缺失则保留默认 notify-stub（failResult）。注意 Last-Write-Wins：override stub。
  const feishu = ctx.get('feishu') as
    | Parameters<typeof createNotifyHandler>[0]['feishu']
    | undefined
  const eventBus = ctx.get('eventBus') as
    | Parameters<typeof createNotifyHandler>[0]['eventBus']
    | undefined
  if (feishu && eventBus) {
    executor.registry.register(createNotifyHandler({
      feishu,
      eventBus,
      dryRun: _config.dryRun,
      logger: ctx.logger,
    }))
    ctx.logger.info(
      '[action-executor] notify handler 已挂载（真实通知；feishu + eventBus；dryRun=%s）',
      _config.dryRun,
    )
  } else {
    ctx.logger.info(
      '[action-executor] feishu 或 eventBus 未提供；notify-stub 保留（failResult）',
    )
  }

  // 2.6 注入 memory.remember / memory.forget handler（Phase 5.2；依赖 ctx.memory）
  const memory = ctx.get('memory') as
    | Parameters<typeof createMemoryRememberHandler>[0]['memory']
    | undefined
  if (memory) {
    executor.registry.register(createMemoryRememberHandler({ memory, logger: ctx.logger }))
    executor.registry.register(createMemoryForgetHandler({ memory, logger: ctx.logger }))
    ctx.logger.info('[action-executor] memory.remember + memory.forget handler 已挂载（Phase 5.2）')
  } else {
    ctx.logger.info(
      '[action-executor] memory 未提供；memory.remember/forget handler 未挂载',
    )
  }

  ctx.logger.info(
    '[action-executor] 已启动（handlers: %s）',
    executor.registry.list().map((h) => `${h.action}=${h.name}`).join(', '),
  )

  // 3. 订阅 'orca/decision'：每个 Decision → execute → emit 'orca/action-result'
  // - listener try/catch 包裹（异常不崩其他 listener；cordis quirk 防护）
  // - handler.execute 是 async（Promise）；fire-and-forget 不阻塞 emit
  // - disposed 闸门（Phase 4.B Review 修复）：dispose 后 in-flight execute 完成时
  //   不再 emit / 不再 logger.warn（避免 disposed ctx 仍被回调）
  let disposed = false
  const unsubscribe = ctx.on('orca/decision', (decision: Decision) => {
    try {
      // 异步执行；结果通过 emit 派发
      void executor.execute(decision)
        .then((result) => {
          if (disposed) return
          ctx.emit('orca/action-result', result)
        })
        .catch((err: unknown) => {
          if (disposed) return
          // executor.execute 内部已 try/catch，这里只是兜底；不应触发
          const detail = err instanceof Error ? err.message : String(err)
          ctx.logger.warn('[action-executor] 兜底捕获异常 (decisionId=%s): %s',
            decision?.decisionId ?? '?', detail)
          ctx.emit('orca/action-result', {
            success: false,
            action: decision?.action ?? 'unknown',
            decisionId: decision?.decisionId ?? 'unknown',
            error: `executor threw (unexpected): ${detail}`,
            executedAt: Date.now(),
          })
        })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.logger.warn('[action-executor] listener 异常 (decisionId=%s): %s',
        decision?.decisionId ?? '?', detail)
    }
  })

  // 4. dispose 钩子
  return () => {
    ctx.logger.info('[action-executor] 关闭（disposed=true + unsubscribe + registry.clear + deferredStore.clear）')
    disposed = true  // 必须在 unsubscribe 之前置位（in-flight .then/.catch 才会短路）
    unsubscribe()
    executor.registry.clear()
    executor.deferredStore.clear()
  }
}
