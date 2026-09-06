/**
 * Orca DeferredActionScheduler —— Cordis plugin（Phase 4.D + Phase 4.E 合并通知）
 *
 * 职责（Phase 4.D + Phase 4.E）：
 * - 定期（30s）扫描 ctx.actionExecutor.deferredStore
 * - 根据 WorldState.user.status 判定 pending 是否 eligible
 * - eligible 时 consume pending + 按 chatId 分组 + 合并 → emit 'orca/decision' 重新送入 Decision pipeline
 * - 复用现有 ActionExecutor 链路（不直接调 ActionHandler）
 * - 闭包私有 disposed flag（dispose race 防护）
 *
 * Phase 4.E 合并通知（Deferred Notification Aggregation）：
 * - 同 chatId 的多条 pending 合并为单条 notify Decision
 * - merge 上限 5 条；超出部分 truncate（在 reason 文末标注 "还有 X 条未展示"）
 * - 合并后 Decision.priority = group 中最高 priority（notify header 显示最高级）
 * - 合并后 Decision.reason = 多行摘要（每条 "- [source] priority: reason"）
 * - 跨 source 合并允许（feishu + calendar 等同 chatId 可合并）
 * - 注意：scheduler **不做去重**（同一 ruleId 在同 group 内可能出现多次）
 *   ——去重由 Attention 层（Phase 3.B.dedup）负责；scheduler 只做展示聚合
 *
 * 关键设计（严格分层）：
 * - **不阻塞原始 Decision publisher**（ctx.on 是 listener；emit 是 sync 派发所有 listener）
 * - **不重新评估 Decision**（store 中只有 Decision，没有 AttentionItem；无法调 decideMany）
 * - **不修改 Decision / AttentionItem / WorldState**
 * - **不直接调 ActionHandler**（emit 'orca/decision' 走 ActionExecutor）
 * - **不持久化**
 * - **不引入 ActionPlan / metadata schema**（合并文本塞 reason 字段）
 *
 * defer 循环防护（关键约束）：
 * - scheduler consume(entry.pendingId) → 立即从 store 删除（atomic）
 * - entry.decision.action === 'defer' 时翻译为 'no_action' 再 emit（merge 前）
 * - 理由：defer handler 会再 enqueue 形成 scheduler → defer → scheduler 死循环
 * - 翻译为 no_action 后走 noopHandler.execute（noop；不入队 store）→ 循环彻底断裂
 *
 * 生命周期：
 * - start()：plugin mount 时；setInterval 启动
 * - dispose()：plugin unmount 时；clearInterval + 闭包状态
 * - dispose 不得调 store.clear()（store 生命周期由 action-executor 拥有）
 * - restart 后：可继续处理 store 中剩余 pending（store 不被 scheduler 改）
 *
 * 配置：
 * - 30s tick 硬编码（不暴露配置键；与 worldStateUpdater 同形态）
 * - MAX_MERGED_ITEMS = 5 硬编码（不暴露配置键）
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
 * 不做（Phase 4.E 范围外）：
 * - 不实现 ActionPlan 拆分（合并文本塞 reason 字段）
 * - 不实现真实 act handler
 * - 不实现 bark / 邮件等其他通知渠道
 * - 不实现 urgency=2 门控
 * - 不实现持久化 / EventStore
 * - 不引入 LLM
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import type { Decision } from '../types/decision.js'
import type { WorldStateService } from '../services/worldState.js'
import type { DeferredActionStore, DeferredActionEntry } from '../types/action.js'
import type { EventBus } from '../services/eventBus.js'

/**
 * Default tick 间隔（30s）。硬编码；不暴露配置键。
 */
export const DEFERRED_SCHEDULER_TICK_MS = 30_000

/**
 * 合并通知上限（Phase 4.E 硬编码；不暴露配置键）。
 *
 * 超出部分 truncate（不降级为多条独立 send），在 reason 文末追加 "还有 X 条未展示"。
 */
export const MAX_MERGED_ITEMS = 5

/**
 * 不可用 user.status 集合（与 Phase 4.D 一致）。
 */
const INELIGIBLE_USER_STATUSES: ReadonlySet<string> = new Set(['busy', 'sleeping'])

/**
 * priority 排序权重（urgent 最高）；合并时取 group 中最高 priority 作为 merged.priority。
 */
const PRIORITY_WEIGHT: Readonly<Record<string, number>> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
}

/**
 * Merged Decision 的 ruleId 标识。
 *
 * 不引入新枚举；用 sentinel 字符串区分普通 rule 与合并产物。
 * Attention / DecisionEngine 不感知此值（仅 NotifyHandler 读取 ruleId 用于 back-trace；合并产物保留 first entry ruleId 在 metadata）。
 */
export const MERGED_DECISION_RULE_ID = 'deferred-merged'

/**
 * groupPendingByChatId —— 按 chatId 分组（Phase 4.E 新增）
 *
 * 逻辑：
 * - 遍历 entries；对每个 entry 用 `eventBus.get(decision.eventId)` 反查 chatId
 * - 反查失败（event evicted / event 不在 sliding window / 非 feishu / chatId 缺失 / eventBus 缺失）→
 *   该 entry 单独成组（key = `__unknown:${pendingId}`），**不与他人合并**（无法确认同 chatId）
 *
 * 注意：
 * - **不做 scheduler 层去重**：同一 ruleId 在同 group 内可能出现多次（按用户决策"scheduler 只做展示聚合"）
 *
 * @param entries DeferredActionEntry[]
 * @param eventBus EventBus（用于反查 chatId；仅用 get 方法；可选）
 * @returns chatId → entries[]（保持 store.list() 原始顺序）
 */
export function groupPendingByChatId(
  entries: DeferredActionEntry[],
  eventBus?: { get(id: string): unknown },
): Map<string, DeferredActionEntry[]> {
  const groups = new Map<string, DeferredActionEntry[]>()
  for (const entry of entries) {
    let groupKey: string
    if (eventBus && entry.decision.eventId) {
      const ev = eventBus.get(entry.decision.eventId) as
        | { source?: string; data?: Record<string, unknown> }
        | undefined
      const dataChatId = ev?.data?.chatId
      if (typeof dataChatId === 'string' && dataChatId.length > 0) {
        groupKey = dataChatId
      } else {
        // 反查失败 → 单独成组（不与他人合并）
        groupKey = `__unknown:${entry.pendingId}`
      }
    } else {
      // 无 eventId 或 eventBus 缺失 → 单独成组
      groupKey = `__unknown:${entry.pendingId}`
    }
    let group = groups.get(groupKey)
    if (!group) {
      group = []
      groups.set(groupKey, group)
    }
    group.push(entry)
  }
  return groups
}

/**
 * 选择 group 中 priority 最高的（按 PRIORITY_WEIGHT）。
 * 未知 priority（字符串但不在表中）→ 视为 lowest（0）；不影响有合法 priority 的 entry。
 */
function pickHighestPriority(group: DeferredActionEntry[]): string {
  let best: string = 'low'
  let bestWeight = -1
  for (const entry of group) {
    const p = entry.decision.priority
    const w = (PRIORITY_WEIGHT as Record<string, number>)[p] ?? 0
    if (w > bestWeight) {
      bestWeight = w
      best = p
    }
  }
  return best
}

/**
 * composeMergedReason —— 构造合并后 Decision.reason 的文本（Phase 4.E 新增）
 *
 * 格式（用户决策）：
 *   你有 N 条待处理信息
 *
 *   - [source] priority: reason
 *   - [source] priority: reason
 *
 *   还有 X 条未展示
 *
 * @param group 同一 chatId 的所有 pending entries
 * @returns reason 字符串（不含 [Orca] header；header 由 NotifyHandler 拼接）
 */
export function composeMergedReason(group: DeferredActionEntry[]): string {
  const total = group.length
  const shown = group.slice(0, MAX_MERGED_ITEMS)
  const truncatedCount = total - shown.length

  const lines: string[] = []
  lines.push(`你有 ${total} 条待处理信息`)
  lines.push('')
  for (const entry of shown) {
    const d = entry.decision
    const src = d.source ?? 'unknown'
    lines.push(`- [${src}] ${d.priority}: ${d.reason}`)
  }
  if (truncatedCount > 0) {
    lines.push('')
    lines.push(`还有 ${truncatedCount} 条未展示`)
  }
  return lines.join('\n')
}

/**
 * createMergedDecision —— 构造合并后的 notify Decision（Phase 4.E 新增）
 *
 * 合并规则（用户决策）：
 * - merged.decisionId = randomUUID()（新；与原始 decisionIds 不同）
 * - merged.attentionId = first.attentionId（保留 back-trace 起点）
 * - merged.ruleId = MERGED_DECISION_RULE_ID ('deferred-merged')
 * - merged.action = 'notify'（NotifyHandler 识别为 notify 路径）
 * - merged.priority = group 中最高 priority
 * - merged.reason = composeMergedReason(group)（多行摘要）
 * - merged.eventId = first.eventId（NotifyHandler 用此反查 EventBus 拿 chatId）
 * - merged.source = first.source（保留可追溯性）
 * - merged.decidedAt = Date.now()
 *
 * @param chatId 该 group 对应的 chatId（已知；group 内所有 entry 反查均得此值）
 * @param group 同一 chatId 的所有 pending entries（>1）
 * @param now Date.now()（注入便于测试；默认 Date.now()）
 * @returns 新的 notify Decision（不会被 scheduler 二次 defer；因为 action='notify'）
 */
export function createMergedDecision(
  chatId: string,
  group: DeferredActionEntry[],
  now: number = Date.now(),
): Decision {
  // 防御性：group 必须 >= 2（单条不应走 createMergedDecision；由 executeTick 控制）
  const first = group[0] as DeferredActionEntry
  const firstDecision = first.decision

  return {
    decisionId: randomUUIDCompat(),
    attentionId: firstDecision.attentionId,
    ruleId: MERGED_DECISION_RULE_ID,
    action: 'notify',
    priority: pickHighestPriority(group),
    reason: composeMergedReason(group),
    eventId: firstDecision.eventId,
    source: firstDecision.source,
    decidedAt: now,
  }
}

/**
 * randomUUIDCompat —— 包装 randomUUID（不抽到外部避免增加 Phase 4.E API 面积）
 */
function randomUUIDCompat(): string {
  return randomUUID()
}

/**
 * executeTick —— 执行一次 scheduler tick 的纯逻辑（独立可测）
 *
 * Phase 4.E 行为（在前 Phase 4.D 基础上扩展）：
 * 1. 读 worldState.getState().user.status
 * 2. 若 status in {busy, sleeping} → return 0（不消费）
 * 3. store.list() → snapshot
 * 4. groupPendingByChatId(entries, eventBus) 按 chatId 分组
 * 5. 对每个 chatId group：
 *    a. consume 所有 entries（atomic）
 *    b. group.length === 1 → defer→no_action 翻译（保持 Phase 4.D 行为）后 emit 单条
 *       group.length >= 2 → 合并为单条 notify Decision 后 emit
 *    c. 注意：合并时 group 内若有 action='defer' 的 entry，仍走 notify 路径（不再翻译为 no_action；
 *       合并产物 action='notify'，不进入 defer handler，不会形成循环）
 *
 * @param store DeferredActionStore
 * @param worldState WorldStateService
 * @param eventBus EventBus（用于 chatId 反查；仅用 get 方法）
 * @param emit emit 函数
 * @param isDisposed dispose 检查回调
 * @returns 本次 tick 消费的 entry 总数（含合并）
 */
export function executeTick(
  store: DeferredActionStore,
  worldState: WorldBusLike,
  emit: (decision: Decision) => void,
  isDisposed: () => boolean = () => false,
  eventBus?: { get(id: string): unknown },
): number {
  if (isDisposed()) return 0

  let userStatus: string
  try {
    userStatus = worldState.getState().user.status
  } catch (err) {
    return 0
  }

  if (INELIGIBLE_USER_STATUSES.has(userStatus)) {
    return 0
  }

  let consumed = 0
  const entries = store.list()
  if (entries.length === 0) return 0

  // Phase 4.E：按 chatId 分组。
  // - eventBus 存在：可按 chatId 合并（同 chatId 多条 → 合并 notify）
  // - eventBus 缺失：无法反查 chatId → 每条独立成组（保持 Phase 4.D 的单条 emit 行为；不误合并）
  let groups: Map<string, DeferredActionEntry[]>
  if (eventBus) {
    groups = groupPendingByChatId(entries, eventBus)
  } else {
    groups = new Map()
    for (const entry of entries) {
      groups.set(entry.pendingId, [entry])
    }
  }

  for (const [chatId, group] of groups) {
    if (isDisposed()) break

    // 5.a consume 所有 entries（atomic；store API 不变）
    for (const entry of group) {
      const ok = store.consume(entry.pendingId)
      if (ok) consumed++
      // consume 失败的（已被其他 consumer 拿走）忽略
    }

    if (group.length === 1) {
      // 单条：保持 Phase 4.D 行为（defer → no_action 翻译）
      const entry = group[0] as DeferredActionEntry
      const out: Decision = entry.decision.action === 'defer'
        ? { ...entry.decision, action: 'no_action' }
        : entry.decision
      emit(out)
    } else {
      // 多条：合并为单条 notify Decision
      const merged = createMergedDecision(chatId, group)
      // merged.action === 'notify'（不进入 defer handler；无循环风险）
      emit(merged)
    }
  }

  return consumed
}

/**
 * WorldBusLike —— executeTick 依赖的最小 WorldState 接口（结构化类型）
 *
 * 仅声明 getState（用于读 user.status）。
 * 不强制注入完整 WorldStateService；便于测试用 mock 替代。
 * 注：WorldStateService 在结构上满足此接口（structural typing）。
 */
type WorldBusLike = Pick<WorldStateService, 'getState'>

/**
 * deferredScheduler Cordis plugin
 *
 * 无 inject 声明（依赖的 ctx.actionExecutor.deferredStore / ctx.worldState / ctx.eventBus 通过 ctx.get 软获取；
 * 任一缺失则优雅降级，不挂 timer）。
 *
 * 依赖：
 * - ctx.actionExecutor.deferredStore（必需；缺失 → 跳过挂载）
 * - ctx.worldState.getState()（必需；缺失 → 跳过挂载）
 * - ctx.eventBus.get(id)（必需；缺失 → 跳过挂载）
 * - ctx.action-executor plugin 必须在 scheduler 之前挂载（保证 deferredStore 已 provide）
 * - ctx.orca-runtime plugin 必须在 scheduler 之前挂载（保证 eventBus 已 provide）
 */
export function deferredScheduler(ctx: Context, _config: OrcaConfig) {
  // 1. 软获取 deferredStore（action-executor plugin 已挂载时存在；否则优雅降级）
  const store = ctx.get('actionExecutor') as
    | { deferredStore?: DeferredActionStore }
    | undefined
  const deferredStore = store?.deferredStore

  // 2. 软获取 worldState（action-executor plugin 之前已挂载 worldStateUpdater 时存在）
  const worldState = ctx.get('worldState') as WorldStateService | undefined

  // 3. 软获取 eventBus（orca-runtime plugin 已挂载时存在；Phase 4.E 需要 chatId 反查）
  const eventBus = ctx.get('eventBus') as EventBus | undefined

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
  if (!eventBus) {
    ctx.logger.warn(
      '[deferred-scheduler] ctx.eventBus 未找到；scheduler 跳过挂载（Orca Runtime 未启用？）',
    )
    return
  }

  ctx.logger.info(
    '[deferred-scheduler] 已启动（tickMs=%d；Phase 4.D + Phase 4.E；chatId 合并；上限 %d 条/通知）',
    DEFERRED_SCHEDULER_TICK_MS, MAX_MERGED_ITEMS,
  )

  // 4. tick 函数：包装 executeTick + 日志
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
      eventBus,
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

  // 5. setInterval 启动
  const timer = setInterval(tick, DEFERRED_SCHEDULER_TICK_MS)

  // 6. dispose 钩子
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
