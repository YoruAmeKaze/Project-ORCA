/**
 * ContextAssembler —— Phase 6.A + Phase 6.C.1 + Phase 6.C.2
 *
 * CEO Context Assembly 服务。
 * 组合 WorldState + InfoRecords + LongMemoryFacts → 格式化 context。
 *
 * 设计依据：D-AGENT-20（guide/orca-memory-consumption-design.md §12）
 *           D-AGENT-21 §21-01（L2 Source Conflict Resolution）
 *           D-AGENT-21 §21-02（Scoring Interface）
 *           D-AGENT-21 §21-01 L3（Semantic Conflict Detection）
 *
 * CEO 不直接调用 MemoryStore，通过此服务查询。
 * Memory retrieval 使用确定性规则（subject 匹配 > type 过滤 > 全局），
 * 不使用 embedding 或语义搜索。
 *
 * Memory budget（硬限制）：
 * - Top-K: 10（可配置）
 * - 单条 fact: ≤ 80 字符（可配置）
 * - R3 总计: ≤ 500 字符（可配置）
 *
 * Phase 6.C.1 新增：
 * - Scoring Interface：config.scoringPreset 控制排序
 * - L2 Source Conflict Resolution：user-explicit > reflection
 *
 * Phase 6.C.2 新增：
 * - L3 Semantic Conflict Detection：同 subject + 同 type + 多条 facts = conflict candidate
 */

import type { WorldState } from '../types/worldState.js'
import type { MemoryStore } from '../types/memory.js'
import type { JsonlInfoRecordStore } from '../agents/store.js'
import type {
  ContextAssembler,
  ContextAssemblerConfig,
  ContextAssemblyResult,
  FormattedInfoRecord,
  FormattedMemoryFact,
  MemoryRetrievalQuery,
  ScoringFunction,
  SemanticConflict,
} from '../types/context.js'
import { detectSemanticConflicts, getScoringFunction } from '../types/context.js'
import type { FactType, LongMemoryFact } from '../types/memory.js'
import type { MemoryUsageTracker } from './memoryUsageTracker.js'
import type { MemoryUsageRecord } from './memoryUsageTracker.js'
import { getSelfProfileLoader, type SelfProfileLoader } from './selfProfileLoader.js'

const DEFAULT_CONFIG: Required<ContextAssemblerConfig> = {
  enabled: true,
  memoryTopK: 10,
  memoryPerFactChars: 80,
  memoryBudgetChars: 500,
  infoRecordsLimit: 3,
  scoringPreset: 'confidence',
  detectSemanticConflict: false,
}

/** 默认 logger（无外部注入时） */
function noopLogger() {
  // 空实现
}

type LogFn = (msg: string, ...args: unknown[]) => void

/**
 * 创建 ContextAssembler 实例。
 *
 * @param memoryStore  MemoryStore 只读查询（不持有写权限）
 * @param infoStore    InfoRecordStore（读取最近 records）
 * @param config      配置（可选）
 * @param logger      日志（可选）
 * @param memoryUsageTracker  MemoryUsageTracker（可选，Phase 6.C.3）
 */
export function createContextAssembler(
  memoryStore: MemoryStore,
  infoStore: JsonlInfoRecordStore,
  config: Partial<ContextAssemblerConfig> = {},
  logger?: { info?: LogFn; warn?: LogFn },
  memoryUsageTracker?: MemoryUsageTracker,
  selfProfileLoader: SelfProfileLoader = getSelfProfileLoader(),
): ContextAssembler {
  const cfg: Required<ContextAssemblerConfig> = { ...DEFAULT_CONFIG, ...config }

  if (!cfg.enabled) {
    return {
      assemble: async (input: string, worldState: WorldState) => {
        logger?.info?.('[context-assembler] disabled, returning minimal context')
        return createEmptyResult(input, worldState)
      },
    }
  }

  /**
   * 格式化一条 LongMemoryFact 为 prompt 注入字符串。
   * 格式：[Memory:{type}] {subject}: {value} (confidence {confidence})
   * 超过 perFactChars 的 value 被截断。
   */
  function formatMemoryFact(fact: LongMemoryFact, maxChars: number): string {
    const value = fact.value.length > maxChars
      ? fact.value.slice(0, maxChars - 1) + '…'
      : fact.value
    return `[Memory:${fact.type}] ${fact.subject}: ${value} (confidence ${fact.confidence})`
  }

  /**
   * 格式化一条 InfoRecord 为 prompt 注入字符串。
   * 格式：[namespace] {type}: {summary}
   */
  function formatInfoRecord(record: { namespace: string; type: string; payload: unknown; ts: number }): string {
    const payloadText = typeof record.payload === 'string'
      ? record.payload
      : JSON.stringify(record.payload).slice(0, 60)
    return `[${record.namespace}] ${record.type}: ${payloadText}`
  }

  /**
   * L2 Source Conflict Resolution（D-AGENT-21 §21-01）。
   * 同一 (subject, type) 存在 user-explicit 和 reflection 时，只保留 user-explicit。
   * 这是 presentation layer 行为，不修改 MemoryStore 数据。
   *
   * @param facts 查询结果
   * @returns 过滤后 facts + 被过滤数量
   */
  function resolveL2SourceConflict(
    facts: LongMemoryFact[],
  ): { filtered: LongMemoryFact[]; filteredCount: number; filteredIds: string[] } {
    // 按 (type, subject) 分组
    const groups = new Map<string, LongMemoryFact[]>()
    for (const fact of facts) {
      const key = `${fact.type}::${fact.subject}`
      const existing = groups.get(key)
      if (existing) {
        existing.push(fact)
      } else {
        groups.set(key, [fact])
      }
    }

    const result: LongMemoryFact[] = []
    let filteredCount = 0
    const filteredIds: string[] = []

    for (const [, group] of groups) {
      if (group.length === 1) {
        // 没有冲突，直接保留
        const fact = group[0]
        if (fact) result.push(fact)
      } else {
        // 存在冲突：user-explicit 优先
        const userExplicit = group.find((f) => f.source === 'user-explicit')
        if (userExplicit) {
          result.push(userExplicit)
          // 记录被过滤的 reflection facts ids
          for (const f of group) {
            if (f !== userExplicit && f) {
              filteredIds.push(f.id)
              filteredCount++
            }
          }
        } else {
          // 没有 user-explicit，全部保留（只有 reflection）
          result.push(...group)
        }
      }
    }

    return { filtered: result, filteredCount, filteredIds }
  }

  /**
   * 查询 Memory facts。
   * 流程：query → L2 filter → scoring sort → format → budget cap
   *
   * @param options 查询选项
   * @returns 格式化后的 facts + 元数据
   */
  async function queryMemory(
    options?: Partial<MemoryRetrievalQuery>,
  ): Promise<{
    facts: FormattedMemoryFact[]
    charsUsed: number
    budgetHit: boolean
    totalAvailable: number
    sourceConflictsFiltered: number
    conflictFilteredIds: string[]
    semanticConflicts: SemanticConflict[]
  }> {
    const limit = options?.limit ?? cfg.memoryTopK
    const perFactChars = cfg.memoryPerFactChars

    // 构建查询
    const query: MemoryRetrievalQuery = {
      state: 'active',
      ...options,
      limit,
    }

    let rawFacts: LongMemoryFact[]

    try {
      rawFacts = await memoryStore.queryFacts(query)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      logger?.warn?.('[context-assembler] queryFacts failed: %s', detail)
      return { facts: [], charsUsed: 0, budgetHit: false, totalAvailable: 0, sourceConflictsFiltered: 0, conflictFilteredIds: [], semanticConflicts: [] }
    }

    const totalAvailable = rawFacts.length

    // L2 Source Conflict Resolution（D-AGENT-21 §21-01）
    const { filtered, filteredCount, filteredIds } = resolveL2SourceConflict(rawFacts)

    // Scoring：优先使用 per-call scoringFunction，其次使用 config preset
    const scorer: ScoringFunction = options?.scoringFunction ?? getScoringFunction(cfg.scoringPreset)

    // 排序：scoring score 降序，secondary=updatedAt 降序
    filtered.sort((a, b) => {
      const scoreA = scorer(a)
      const scoreB = scorer(b)
      if (scoreB !== scoreA) return scoreB - scoreA
      return b.updatedAt - a.updatedAt
    })

    // 格式化
    const formatted: FormattedMemoryFact[] = []
    let charsUsed = 0
    let budgetHit = false

    for (const fact of filtered) {
      const text = formatMemoryFact(fact, perFactChars)
      const textLen = text.length

      if (charsUsed + textLen > cfg.memoryBudgetChars && formatted.length > 0) {
        budgetHit = true
        break
      }

      charsUsed += textLen
      formatted.push({
        id: fact.id,
        type: fact.type,
        subject: fact.subject,
        formatted: text,
        confidence: fact.confidence,
        updatedAt: fact.updatedAt,
      })
    }

    logger?.info?.(
      '[context-assembler] memory query: %d facts, chars=%d, budgetHit=%s, sourceConflictsFiltered=%d',
      formatted.length,
      charsUsed,
      budgetHit,
      filteredCount,
    )

    // L3 Semantic Conflict Detection（D-AGENT-21 §21-01 L3）
    // 基于格式化后的 facts（经过 L2 过滤、scoring 排序之后）进行检测
    const semanticConflicts = cfg.detectSemanticConflict
      ? detectSemanticConflicts(formatted)
      : []

    logger?.info?.(
      '[context-assembler] memory query: %d facts, chars=%d, budgetHit=%s, sourceConflictsFiltered=%d, semanticConflicts=%d',
      formatted.length,
      charsUsed,
      budgetHit,
      filteredCount,
      semanticConflicts.length,
    )

    return { facts: formatted, charsUsed, budgetHit, totalAvailable, sourceConflictsFiltered: filteredCount, conflictFilteredIds: filteredIds, semanticConflicts }
  }

  /**
   * 获取最近 InfoRecords。
   */
  async function queryInfoRecords(): Promise<FormattedInfoRecord[]> {
    try {
      const records = await infoStore.getRecentByNamespace('', cfg.infoRecordsLimit)
      return records.map((r) => ({
        id: r.id,
        namespace: r.namespace,
        type: r.type,
        formatted: formatInfoRecord(r),
        ts: r.ts,
        confidence: r.confidence,
      }))
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      logger?.warn?.('[context-assembler] getRecentByNamespace failed: %s', detail)
      return []
    }
  }

  /**
   * 构建 summary 字符串。
   * 分层拼接：R1 (worldState) → R2 (infoRecords) → R3 (memoryFacts) → L3 warnings。
   */
  function buildSummary(
    worldState: WorldState,
    infoRecords: FormattedInfoRecord[],
    memoryFacts: FormattedMemoryFact[],
    semanticConflicts: SemanticConflict[],
  ): string {
    const lines: string[] = []

    // Fixed identity is the first system-context section.
    lines.push(selfProfileLoader.get())
    lines.push('')

    // R1: WorldState
    lines.push('## WorldState')
    lines.push(`user: status=${worldState.user.status}, dnd=${worldState.user.doNotDisturb}`)
    lines.push(`device: locked=${worldState.device.isLocked}, network=${worldState.device.network}`)
    lines.push(`time: ${worldState.time.timeOfDay} / ${worldState.time.dayOfWeek} / workday=${worldState.time.isWorkday}`)

    // R2: InfoRecords
    if (infoRecords.length > 0) {
      lines.push('## Recent InfoRecords')
      for (const r of infoRecords) {
        lines.push(r.formatted)
      }
    } else {
      lines.push('## Recent InfoRecords (none)')
    }

    // R3: MemoryFacts
    if (memoryFacts.length > 0) {
      lines.push('## Memory (long-term knowledge)')
      for (const f of memoryFacts) {
        lines.push(f.formatted)
      }
    } else {
      lines.push('## Memory (none)')
    }

    // L3: Semantic Conflict Warnings
    if (semanticConflicts.length > 0) {
      lines.push('## Memory Conflict Warnings')
      for (const conflict of semanticConflicts) {
        lines.push(conflict.warningText)
      }
    }

    return lines.join('\n')
  }

  function createEmptyResult(input: string, worldState: WorldState): ContextAssemblyResult {
    return {
      input,
      worldState,
      selfProfile: selfProfileLoader.get(),
      infoRecords: [],
      memoryFacts: [],
      memoryCharsUsed: 0,
      memoryBudgetHit: false,
      memoryTotalAvailable: 0,
      sourceConflictsFiltered: 0,
      semanticConflicts: [],
      summary: '',
    }
  }

  /**
   * 组装 CEO context。
   */
  async function assemble(
    input: string,
    worldState: WorldState,
    options?: { memoryQuery?: Partial<MemoryRetrievalQuery> },
  ): Promise<ContextAssemblyResult> {
    logger?.info?.('[context-assembler] assembling context for input length=%d', input.length)

    const [infoRecords, memoryResult] = await Promise.all([
      queryInfoRecords(),
      queryMemory(options?.memoryQuery),
    ])

    const summary = buildSummary(worldState, infoRecords, memoryResult.facts, memoryResult.semanticConflicts)

    // Phase 6.C.3 MemoryUsageTracker：记录最终进入 context 的 memory usage
    if (memoryUsageTracker) {
      const record: MemoryUsageRecord = {
        timestamp: Date.now(),
        queryLength: input.length,
        returnedFactIds: memoryResult.facts.map((f) => f.id),
        conflictFilteredIds: memoryResult.conflictFilteredIds,
        semanticConflictCount: memoryResult.semanticConflicts.length,
        charsUsed: memoryResult.charsUsed,
        budgetHit: memoryResult.budgetHit,
        scoringPreset: cfg.scoringPreset,
        semanticDetectionEnabled: cfg.detectSemanticConflict,
      }
      memoryUsageTracker.record(record)
    }

    const result: ContextAssemblyResult = {
      input,
      worldState,
      selfProfile: selfProfileLoader.get(),
      infoRecords,
      memoryFacts: memoryResult.facts,
      memoryCharsUsed: memoryResult.charsUsed,
      memoryBudgetHit: memoryResult.budgetHit,
      memoryTotalAvailable: memoryResult.totalAvailable,
      sourceConflictsFiltered: memoryResult.sourceConflictsFiltered,
      semanticConflicts: memoryResult.semanticConflicts,
      summary,
    }

    logger?.info?.(
      '[context-assembler] done: infoRecords=%d, memoryFacts=%d, memoryChars=%d, budgetHit=%s',
      infoRecords.length,
      memoryResult.facts.length,
      memoryResult.charsUsed,
      memoryResult.budgetHit,
    )

    return result
  }

  return { assemble }
}
