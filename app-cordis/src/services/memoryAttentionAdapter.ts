/**
 * MemoryAttentionAdapter —— Phase 5.4.A + 5.4.B
 *
 * Memory → Attention 的唯一桥接层。
 *
 * 职责：
 * - 定时轮询 MemoryStore.queryFacts({state:'active'})（Phase 5.4.A fallback）
 * - 订阅 MemoryStore memory_changed 事件（Phase 5.4.B event-driven）
 * - 将 LongMemoryFact 映射为 AttentionItem（type='memory.insight'）
 * - 通过 ctx.emit('orca/attention', item) 注入事件流
 *
 * 不做（Phase 5.4.A+B MVP）：
 * - 不映射 Memory type → AttentionItem action（统一生成 action='remember_only'）
 * - 不调用 Decision / Action
 * - 不修改 AttentionEngine / WorldState
 *
 * 去重（Phase 5.4.A polling）：
 * - seenFacts: Map<factId, updatedAt>
 * - 同一 fact.updatedAt 未变化时不重新生成 AttentionItem
 * - forget 后 fact 自然从 queryFacts 中消失，不会续期
 *
 * 事件驱动（Phase 5.4.B）：
 * - fact.created / fact.updated → 生成或刷新 AttentionItem
 * - fact.superseded / fact.merged / fact.forgotten → 失效对应 AttentionItem
 *
 * 设计依据：D-AGENT-19 §19-02
 */

import type { AttentionItem, AttentionPriority } from '../types/attention.js'
import type { LongMemoryFact, MemoryChangedEvent, MemoryEventType } from '../types/memory.js'
import type { MemoryStore } from '../types/memory.js'
import type { WorldState } from '../types/worldState.js'

export interface MemoryAttentionAdapterConfig {
  /** 轮询间隔（毫秒）；默认 60000 */
  pollIntervalMs: number
  /** 每次最多生成的 AttentionItems 数；默认 5 */
  topK: number
  /** 是否启用 */
  enabled: boolean
}

export interface MemoryAttentionAdapter {
  /** 启动轮询 */
  start(): void
  /** 停止轮询（dispose） */
  stop(): void
  /** 手动触发一次 tick（测试用） */
  tick(): Promise<void>
  /**
   * 处理 MemoryStore 发出的 memory_changed 事件（Phase 5.4.B）。
   * 调用者传入此函数；adapter 内部在事件发生时调用。
   */
  onMemoryChanged(event: MemoryChangedEvent): void
}

interface SeenEntry {
  updatedAt: number
  /** 已发出的 AttentionItem 的 id */
  itemId: string
}

const DEFAULT_CONFIG: MemoryAttentionAdapterConfig = {
  pollIntervalMs: 60_000,
  topK: 5,
  enabled: true,
}

/**
 * 根据 confidence 计算 priority。
 * Phase 5.4.A MVP 简化映射。
 */
function confidenceToPriority(confidence: number): AttentionPriority {
  if (confidence >= 0.9) return 'urgent'
  if (confidence >= 0.8) return 'high'
  if (confidence >= 0.7) return 'normal'
  return 'low'
}

/**
 * 构造 MemoryAttentionAdapter 专用的 minimal WorldState stub。
 * MemoryAttentionAdapter 不持有 worldState service，stateSnapshot 仅用于追溯。
 * 字段满足 AttentionItem.stateSnapshot 类型契约。
 */
function makeStubWorldState(): WorldState {
  return {
    user: { status: 'awake', lastSeenAt: Date.now(), doNotDisturb: false },
    device: { isLocked: false, powerMode: 'plugged', network: 'online' },
    time: { timeOfDay: 'afternoon', dayOfWeek: 'Wed', isWorkday: true, isWeekend: false },
    extensions: {},
    lastUpdated: Date.now(),
  }
}

/**
 * 将 LongMemoryFact 映射为 AttentionItem。
 * 所有 Memory facts 统一生成 type='memory.insight'（MVP 简化，不按原始 type 分类）。
 *
 * @param fact 源 LongMemoryFact
 * @param ruleId 触发规则 ID（固定）
 */
export function factToAttentionItem(fact: LongMemoryFact, ruleId = 'memory-attention-adapter'): AttentionItem {
  const now = Date.now()
  const reason = `[Memory] ${fact.type}/${fact.subject}: ${fact.value} (confidence ${fact.confidence})`

  const item: AttentionItem = {
    id: `memory:${fact.id}`,
    ruleId,
    priority: confidenceToPriority(fact.confidence),
    reason,
    action: 'remember_only',
    source: 'memory',
    stateSnapshot: makeStubWorldState(),
    evaluatedAt: now,
  }

  // D-AGENT-19 §19-02：metadata 必须包含 factId / memoryType / memorySource / confidence
  // AttentionItem.metadata 是自由字段
  ;(item as AttentionItem & { metadata: Record<string, unknown> }).metadata = {
    factId: fact.id,
    memoryType: fact.type,
    memorySource: fact.source,
    confidence: fact.confidence,
    updatedAt: fact.updatedAt,
    createdAt: fact.createdAt,
  }

  return item
}

type LogFn = (msg: string, ...args: unknown[]) => void

/**
 * 创建 MemoryAttentionAdapter 实例。
 *
 * @param memory MemoryStore（只读）
 * @param emit  事件发射器（ctx.emit）
 * @param config 配置（可选）
 * @param logger 日志（可选）；支持 .info() / .warn() 方法
 */
export function createMemoryAttentionAdapter(
  memory: MemoryStore,
  emit: (event: string, item: AttentionItem) => void,
  config: Partial<MemoryAttentionAdapterConfig> = {},
  logger?: { info?: LogFn; warn?: LogFn },
): MemoryAttentionAdapter {
  const cfg: MemoryAttentionAdapterConfig = { ...DEFAULT_CONFIG, ...config }

  /** factId → {updatedAt, itemId}；用于去重 */
  const seenFacts = new Map<string, SeenEntry>()

  /** 当前定时器句柄 */
  let timer: ReturnType<typeof setInterval> | null = null

  /** 是否已 dispose */
  let disposed = false

  /**
   * 执行一次轮询。
   * 查询 active facts → 过滤已见 → 生成 AttentionItems → emit。
   */
  async function tick(): Promise<void> {
    if (disposed || !cfg.enabled) return

    try {
      const facts = await memory.queryFacts({ state: 'active' })

      // 按 updatedAt 降序，取 topK
      facts.sort((a, b) => b.updatedAt - a.updatedAt)
      const topFacts = facts.slice(0, cfg.topK)

      let emitted = 0
      for (const fact of topFacts) {
        const seen = seenFacts.get(fact.id)

        // 去重：同一 fact.updatedAt 未变化时不重新生成
        if (seen && seen.updatedAt === fact.updatedAt) {
          continue
        }

        const item = factToAttentionItem(fact)
        emit('orca/attention', item)
        seenFacts.set(fact.id, { updatedAt: fact.updatedAt, itemId: item.id })
        emitted++
      }

      if (emitted > 0) {
        logger?.info?.('[memory-attention-adapter] tick: %d items emitted (total seen=%d)', emitted, seenFacts.size)
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      logger?.warn?.('[memory-attention-adapter] tick error: %s', detail)
    }
  }

  /**
   * 处理 memory_changed 事件（Phase 5.4.B）。
   *
   * - fact.created / fact.updated：查询当前 fact 状态，生成/刷新 AttentionItem
   * - fact.superseded / fact.merged / fact.forgotten：从 seenFacts 移除，不再发送 AttentionItem
   *
   * @param event MemoryChangedEvent
   */
  function onMemoryChanged(event: MemoryChangedEvent): void {
    if (disposed || !cfg.enabled) return

    const invalidateTypes: MemoryEventType[] = ['fact.superseded', 'fact.merged', 'fact.forgotten']
    if (invalidateTypes.includes(event.type)) {
      // 失效：从 seenFacts 移除，不再发送 AttentionItem
      const existed = seenFacts.delete(event.factId)
      if (existed) {
        logger?.info?.('[memory-attention-adapter] memory event: %s → invalidated (factId=%s)', event.type, event.factId)
      }
      return
    }

    // fact.created / fact.updated：查询当前状态并生成 AttentionItem
    if (event.type === 'fact.created' || event.type === 'fact.updated') {
      void (async () => {
        try {
          const fact = await memory.getFact(event.factId)
          if (!fact) {
            logger?.warn?.('[memory-attention-adapter] memory event: %s but fact not found (factId=%s)', event.type, event.factId)
            return
          }
          if (fact.state !== 'active') {
            // 已不再是 active（被 supersede 或 forget 同时发生）
            seenFacts.delete(event.factId)
            return
          }
          const item = factToAttentionItem(fact)
          emit('orca/attention', item)
          seenFacts.set(fact.id, { updatedAt: fact.updatedAt, itemId: item.id })
          logger?.info?.('[memory-attention-adapter] memory event: %s → emitted (factId=%s)', event.type, event.factId)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          logger?.warn?.('[memory-attention-adapter] onMemoryChanged error: %s', detail)
        }
      })()
    }
  }

  function start(): void {
    if (disposed || !cfg.enabled) return
    // 立即执行一次（不等首次轮询间隔）
    void tick()
    timer = setInterval(() => {
      void tick()
    }, cfg.pollIntervalMs)
    logger?.info?.(
      '[memory-attention-adapter] started (pollInterval=%dms topK=%d)',
      cfg.pollIntervalMs,
      cfg.topK,
    )
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    disposed = true
    logger?.info?.('[memory-attention-adapter] stopped')
  }

  return { start, stop, tick, onMemoryChanged }
}
