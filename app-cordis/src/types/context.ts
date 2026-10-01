/**
 * ContextAssembler 类型定义 —— Phase 6.A + Phase 6.C.1
 *
 * 设计依据：D-AGENT-20（guide/orca-memory-consumption-design.md §12）
 *           D-AGENT-21 §21-02（Scoring Interface）
 *
 * 职责：
 * - CEO Context Assembly 的类型契约
 * - Memory retrieval 查询参数（含 scoring interface）
 * - Context 格式化输出类型
 * - L2 Source Conflict Resolution 类型
 *
 * 不做：
 * - 不定义 AttentionItem / Decision 相关类型
 * - 不定义 InfoRecord 相关类型（已在 agents/types.ts）
 */

import type { FactType, LongMemoryFact } from './memory.js'
import type { WorldState } from './worldState.js'
import type { InfoRecord } from '../agents/types.js'

// ── Memory Retrieval ────────────────────────────────────────────────────────

/**
 * Memory 查询参数（Phase 6.A + 6.C.1）。
 *
 * 扩展 FactQuery：增加 scoring interface。
 */
export interface MemoryRetrievalQuery {
  /** 精确匹配 fact type（D-AGENT-20 §20-03） */
  type?: FactType
  /** 精确匹配 fact subject（大小写不敏感）（D-AGENT-20 §20-03） */
  subject?: string
  /** 前缀匹配 subject（e.g. 'girlfriend' 匹配 'girlfriend.coffee'） */
  subjectPrefix?: string
  /** 默认 'active' */
  state?: 'active' | 'superseded'
  /** 最低 confidence 阈值 */
  minConfidence?: number
  /** 默认 10（D-AGENT-20 §12.3.3） */
  limit?: number
  /**
   * Per-call scoring override。
   * 优先级高于 Config.scoringPreset。
   * 返回值越高越优先。
   */
  scoringFunction?: (fact: LongMemoryFact) => number
}

// ── Scoring Interface ────────────────────────────────────────────────────────

/**
 * Scoring function signature。
 * 输入：一条 LongMemoryFact
 * 输出：number（越高越优先）
 *
 * 设计约束：
 * - 确定性：相同输入 → 相同输出
 * - 不使用 embedding 或语义相似度
 */
export type ScoringFunction = (fact: LongMemoryFact) => number

/**
 * Scoring preset identifiers。
 *
 * - 'confidence': primary=confidence 降序，secondary=updatedAt 降序（Phase 6.A 行为）
 * - 'source-confidence': user-explicit +0.2 bonus，再按 confidence 降序
 */
export type ScoringPreset = 'confidence' | 'source-confidence'

/**
 * 获取指定 preset 的 scoring function。
 */
export function getScoringFunction(preset: ScoringPreset): ScoringFunction {
  switch (preset) {
    case 'source-confidence':
      return scoreBySourceConfidence
    case 'confidence':
    default:
      return scoreByConfidence
  }
}

/**
 * 预设1：纯 confidence 降序，secondary=updatedAt 降序。
 * Phase 6.A 默认行为。
 */
export function scoreByConfidence(fact: LongMemoryFact): number {
  return fact.confidence
}

/**
 * 预设2：user-explicit +0.2 bonus，再按 confidence 降序。
 * user-explicit 优先级高于 reflection。
 * bonus 控制在 [0, 1] 范围内。
 */
export function scoreBySourceConfidence(fact: LongMemoryFact): number {
  const bonus = fact.source === 'user-explicit' ? 0.2 : 0
  return Math.min(1, fact.confidence + bonus)
}

// ── Semantic Conflict Detection ────────────────────────────────────────────

/**
 * Semantic Conflict（D-AGENT-21 §21-01 L3）。
 *
 * 检测条件（保守规则，同 subject + 同 type + 多条 active facts）：
 * 1. 同一 subject（精确匹配，大小写不敏感）
 * 2. 同一 type
 * 3. 两条及以上 active facts
 *
 * 不做：
 * - 不理解自然语言语义
 * - 不使用 embedding
 * - 不调用 LLM
 * - 不自动裁决（只标记，不过滤）
 */
export interface SemanticConflict {
  /** 冲突涉及的 subject（原始值） */
  subject: string
  /** 冲突涉及的 fact type */
  type: FactType
  /** 涉及的 facts */
  facts: FormattedMemoryFact[]
  /** 格式化后的 warning 文本 */
  warningText: string
}

/**
 * 检测 semantic conflict。
 * 保守规则：同 subject + 同 type + 多条 facts = conflict candidate。
 * value 内容不做语义分析。
 */
export function detectSemanticConflicts(
  formattedFacts: FormattedMemoryFact[],
): SemanticConflict[] {
  // 按 (type, subject) 分组
  const groups = new Map<string, FormattedMemoryFact[]>()

  for (const fact of formattedFacts) {
    const key = `${fact.type}::${fact.subject}`
    const existing = groups.get(key)
    if (existing) {
      existing.push(fact)
    } else {
      groups.set(key, [fact])
    }
  }

  const conflicts: SemanticConflict[] = []

  for (const [key, group] of groups) {
    if (group.length < 2) continue // 单条 fact 不是冲突

    // 必须有不同的 formatted 值才算语义冲突
    const first = group[0]
    if (!first) continue
    const allSame = group.every((f) => f.formatted === first.formatted)
    if (allSame) continue // 相同 formatted value 不是冲突

    const [type, ...subjectParts] = key.split('::')
    const subject = subjectParts.join('::') // subject 可能包含 ::

    const lines = group.map(
      (f) => `  - ${type}: ${subject} -> ${f.formatted}`,
    )

    conflicts.push({
      subject,
      type: type as FactType,
      facts: group,
      warningText: `[Memory Conflict Warning] Multiple memories for same subject+type:\n${lines.join('\n')}`,
    })
  }

  return conflicts
}

// ── Formatted Memory Fact ─────────────────────────────────────────────────

/**
 * 经过格式化（注入 prompt 前）的 Memory fact。
 * 用于 ContextAssemblyResult.memory。
 */
export interface FormattedMemoryFact {
  /** LongMemoryFact.id */
  id: string
  /** fact type */
  type: FactType
  /** fact subject */
  subject: string
  /** 格式化后的字符串，格式：[Memory:{type}] {subject}: {value} (confidence {confidence}) */
  formatted: string
  /** 格式化前的 confidence */
  confidence: number
  /** 格式化前的 updatedAt */
  updatedAt: number
}

// ── Context Assembly ───────────────────────────────────────────────────────

/**
 * CEO Context Assembly 结果。
 * 包含四个维度的格式化数据，供 CEO/R0 构建 prompt 使用。
 */
export interface ContextAssemblyResult {
  /** Fixed system knowledge loaded from resources/self-profile.md. */
  selfProfile: string

  /**
   * 当前用户输入（原样传入）。
   * 不做格式化，R4 层由调用方自行注入。
   */
  input: string

  /**
   * R1: WorldState snapshot（D-AGENT-20 §12.2.2）。
   * 由调用方传入，这里只透传。
   */
  worldState: WorldState

  /**
   * R2: 最近 InfoRecords。
   * 格式：[namespace] {type}: {payload 文本化}。
   * 由 infoStore.getRecentByNamespace 获得。
   */
  infoRecords: FormattedInfoRecord[]

  /**
   * R3: Memory facts。
   * 格式：[Memory:{type}] {subject}: {value} (confidence {confidence})。
   * 按 D-AGENT-20 §12.4.2 格式化。
   */
  memoryFacts: FormattedMemoryFact[]

  /**
   * 总 memory facts 字符数（格式化后）。
   * 用于判断是否超出 budget。
   */
  memoryCharsUsed: number

  /**
   * 是否达到 memory budget 上限（500 chars）。
   * true = 达到了上限，facts 可能被截断。
   */
  memoryBudgetHit: boolean

  /**
   * Memory facts 原始查询结果数（截断前）。
   * 用于判断是否有更多 facts 未纳入。
   */
  memoryTotalAvailable: number

  /**
   * L2 Source Conflict 过滤掉的 fact 数量（D-AGENT-21 §21-01）。
   * 同一 (subject, type) 存在 user-explicit 和 reflection 时，reflection 被过滤。
   */
  sourceConflictsFiltered: number

  /**
   * L3 Semantic Conflicts（D-AGENT-21 §21-01）。
   * 同 subject + 同 type + 多条 facts = conflict candidate。
   * 不自动过滤，只标记。
   */
  semanticConflicts: SemanticConflict[]

  /**
   * 汇总文本（所有维度合并为单字符串，供直接注入 prompt 使用）。
   * 分层拼接：R1 → R2 → R3。
   */
  summary: string
}

/**
 * 格式化的 InfoRecord。
 * 用于 ContextAssemblyResult.infoRecords。
 */
export interface FormattedInfoRecord {
  id: string
  namespace: string
  type: string
  /** 格式化字符串：[namespace] {type}: {summary} */
  formatted: string
  ts: number
  confidence?: number
}

// ── ContextAssembler Config ────────────────────────────────────────────────

export interface ContextAssemblerConfig {
  /** 是否启用 context assembly（默认 true） */
  enabled: boolean
  /** Memory facts Top-K（默认 10） */
  memoryTopK: number
  /** 单条 fact 最大字符数（默认 80） */
  memoryPerFactChars: number
  /** Memory facts 总字符数上限（默认 500） */
  memoryBudgetChars: number
  /** InfoRecords 最近条目数（默认 3） */
  infoRecordsLimit: number
  /** Scoring preset（默认 'confidence'，Phase 6.C.1） */
  scoringPreset: ScoringPreset
  /** 是否启用 L3 语义冲突检测（默认 false，Phase 6.C.2） */
  detectSemanticConflict: boolean
}

// ── ContextAssembler Service Interface ─────────────────────────────────────

export interface ContextAssembler {
  /**
   * 装配 CEO context。
   *
   * @param input   当前用户输入（原样传递，不格式化）
   * @param worldState  当前 WorldState snapshot
   * @param options 可选：指定 memory 查询参数（subject/type/minConfidence）
   * @returns 格式化后的 ContextAssemblyResult
   */
  assemble(
    input: string,
    worldState: WorldState,
    options?: {
      memoryQuery?: Partial<MemoryRetrievalQuery>
    },
  ): Promise<ContextAssemblyResult>
}
