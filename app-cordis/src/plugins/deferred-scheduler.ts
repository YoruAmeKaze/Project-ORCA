/**
 * Orca DeferredActionScheduler —— Cordis plugin（Phase 4.D 第一版）
 *
 * 职责：
 * - 定期（30s）扫描 ctx.actionExecutor.deferredStore
 * - 根据 WorldState.user.status 判定 pending 是否 eligible
 * - eligible 时 consume pending + emit 'orca/decision' 重新送入 Decision pipeline
 * - 复用现有 ActionExecutor 链路（不直接调 ActionHandler）
 * - 闭包私有 disposed flag（dispose race 防护）
 *
 * 关键设计（严格分层）：
 * - **不阻塞原始 Decision publisher**（ctx.on 是 listener；emit 是 sync 派发所有 listener）
 * - **不重新评估 Decision**（store 中只有 Decision，没有 AttentionItem；无法调 decideMany）
 * - **不修改 Decision / AttentionItem / WorldState**
 * - **不直接调 ActionHandler**（emit 'orca/decision' 走 ActionExecutor）
 * - **不持久化**
 *
 * defer 循环防护（关键约束）：
 * - scheduler consume(entry.pendingId) → 立即从 store 删除（atomic）
 * - entry.decision.action === 'defer' 时翻译为 'no_action' 再 emit
 * - 理由：defer handler 会再 enqueue 形成 scheduler → defer → scheduler 死循环
 * - 翻译为 no_action 后走 noopHandler.execute（noop；不入队 store）→ 循环彻底断裂
 *
 * 生命周期：
 * - start()：plugin mount 时；setInterval 启动
 * - dispose()：plugin unmount 时；clearInterval + 闭包状态（processed 标记在 scheduler 闭包内；可被 GC）
 * - dispose 不得调 store.clear()（store 生命周期由 action-executor 拥有）
 * - restart 后：可继续处理 store 中剩余 pending（store 不被 scheduler 改）
 *
 * 配置：
 * - 30s 硬编码（不暴露配置键；与 worldStateUpdater 同形态）
 * - 不新增任何用户配置
 *
 * Cordis quirk 防护：
 * - listener try/catch（handler 异常不崩服务、不阻塞其他 listener）
 * - emit 使用 ctx.emit（与现有事件机制一致）
 * - disposed flag（Phase 4.B Review 同模式）：dispose 后 tick 短路
 *
 * 挂载时序：
 * - DeferredActionScheduler 必须在 actionExecutor 之后挂载（依赖 ctx.actionExecutor.deferredStore）
 * - 仅当 config.runtime.action.enabled 块内
 *
 * 不做（Phase 4.D 范围外）：
 * - 不实现 urgency=2 门控
 * - 不实现真实 act handler
 * - 不实现 ActionPlan
 * - 不实现 LLM 增强
 * - 不实现合并通知（消息合并 / 推送门控）
 * - 不引入 EventStore
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { Decision } from '../types/decision.js'
import type { WorldStateService } from '../services/worldState.js'
import type { DeferredActionStore } from '../types/action.js'

/**
 * Default tick 间隔（30s）。硬编码；不暴露配置键。
 *
 * 选择依据：与 worldStateUpdater 默认 60s 同数量级；scheduler 频率可以更高（pending 累积有界）。
 * 30s 提供"用户从 busy 醒来"后约 30s 内的消费窗口（可接受）。
 */
export const DEFERRED_SCHEDULER_TICK_MS = 30_000

/**
 * 不可用 user.status 集合（Phase 4.D 第一版最小集）。
 *
 * 行为：user.status in {busy, sleeping} → scheduler 不消费 pending（保留）。
 * 其他 status（awake / away）→ scheduler 消费 pending 并 emit 'orca/decision'。
 *
 * 不引入新 status 枚举（严格按 WorldState.UserStatus 真实类型）。
 */
const INELIGIBLE_USER_STATUSES: ReadonlySet<string> = new Set(['busy', 'sleeping'])

/**
 * executeTick —— 执行一次 scheduler tick 的纯逻辑（独立可测）
 *
 * @param store - DeferredActionStore（list/consume）
 * @param worldState - WorldStateService（getState）
 * @param emit - emit 函数（注入；测试中可替换为 spy）
 * @param isDisposed - dispose 检查回调（test 中可手动 dispose 后再 tick）
 * @returns 本次 tick 消费的 entry 数
 *
 * 行为：
 * 1. 读 worldState.getState().user.status
 * 2. 若 status in {busy, sleeping} → return 0（不消费）
 * 3. 遍历 store.list() snapshot
 * 4. 对每个 entry：
 *    a. store.consume(entry.pendingId)（原子）
 *    b. defer → no_action 翻译
 *    c. emit('orca/decision', out)
 *
 * 翻译理由：defer handler 接收 action='defer' 的 Decision 后会再次 enqueue 到 store；
 * 如果不翻译，scheduler → defer handler → 新 pending → scheduler → 死循环。
 * 翻译为 no_action 后走 noopHandler.execute（noop；不入队），循环彻底断裂。
 */
export function executeTick(
  store: DeferredActionStore,
  worldState: WorldStateService,
  emit: (decision: Decision) => void,
  isDisposed: () => boolean = () => false,
): number {
  if (isDisposed()) return 0

  let userStatus: string
  try {
    userStatus = worldState.getState().user.status
  } catch (err) {
    // worldState 异常时跳过本 tick（不消费）
    return 0
  }

  if (INELIGIBLE_USER_STATUSES.has(userStatus)) {
    return 0
  }

  let consumed = 0
  const entries = store.list()
  for (const entry of entries) {
    if (isDisposed()) break
    const ok = store.consume(entry.pendingId)
    if (!ok) continue  // 已被其他 consumer 拿走（防御性）

    // defer → no_action 翻译（防 defer 循环）
    const out: Decision = entry.decision.action === 'defer'
      ? { ...entry.decision, action: 'no_action' }
      : entry.decision

    emit(out)
    consumed++
  }
  return consumed
}

/**
 * deferredScheduler Cordis plugin
 *
 * 无 inject 声明（依赖的 ctx.actionExecutor.deferredStore / ctx.worldState 通过 ctx.get 软获取；
 * 任一缺失则优雅降级，不挂 timer）。
 *
 * 依赖：
 * - ctx.actionExecutor.deferredStore（必需；缺失 → 跳过挂载）
 * - ctx.worldState.getState()（必需；缺失 → 跳过挂载）
 * - ctx.action-executor plugin 必须在 scheduler 之前挂载（保证 deferredStore 已 provide）
 */
export function deferredScheduler(ctx: Context, _config: OrcaConfig) {
  // 1. 软获取 deferredStore（action-executor plugin 已挂载时存在；否则优雅降级）
  const store = ctx.get('actionExecutor') as
    | { deferredStore?: DeferredActionStore }
    | undefined
  const deferredStore = store?.deferredStore

  // 2. 软获取 worldState（action-executor plugin 之前已挂载 worldStateUpdater 时存在）
  const worldState = ctx.get('worldState') as WorldStateService | undefined

  if (!deferredStore) {
    ctx.logger.warn(
      '[deferred-scheduler] ctx.actionExecutor.deferredStore 未找到；scheduler 跳过挂载（action-executor 未启用？）',
    )
    return
  }
  if (!worldState) {
    ctx.logger.warn(
      '[deferred-scheduler] ctx.worldState 未找到；scheduler 跳过挂载（WorldState 未启用？）',
    )
    return
  }

  ctx.logger.info(
    '[deferred-scheduler] 已启动（tickMs=%d；Phase 4.D 第一版；defer→no_action 翻译）',
    DEFERRED_SCHEDULER_TICK_MS,
  )

  // 3. tick 函数：包装 executeTick + 日志
  let disposed = false
  const tick = (): void => {
    if (disposed) return

    const consumed = executeTick(
      deferredStore,
      worldState,
      (decision) => {
        // try/catch 包裹（ctx.emit 在 Cordis 中不抛错；此处防御）
        try {
          ctx.emit('orca/decision', decision)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          ctx.logger.warn(
            '[deferred-scheduler] emit 异常（不应发生）decisionId=%s: %s',
            decision.decisionId, detail,
          )
        }
      },
      () => disposed,
    )

    if (consumed > 0) {
      let userStatus: string
      try {
        userStatus = worldState.getState().user.status
      } catch {
        userStatus = 'unknown'
      }
      ctx.logger.info(
        '[deferred-scheduler] tick 消费 %d 条 pending（userStatus=%s）',
        consumed, userStatus,
      )
    }
  }

  // 4. setInterval 启动
  const timer = setInterval(tick, DEFERRED_SCHEDULER_TICK_MS)

  // 5. dispose 钩子
  return () => {
    ctx.logger.info(
      '[deferred-scheduler] 关闭（disposed=true + clearInterval；不调 store.clear）',
    )
    disposed = true  // 必须在 clearInterval 之前置位（in-flight tick 才会短路）
    clearInterval(timer)
    // ❌ 不调 deferredStore.clear()（store 生命周期由 action-executor 拥有；
    //    restart 后 store 仍保留剩余 pending，scheduler 可继续处理）
  }
}
