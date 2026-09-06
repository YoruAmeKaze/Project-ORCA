/**
 * Orca LongMemory —— 类型契约（Phase 5.0 + 5.1）
 *
 * 设计依据：D-AGENT-17 v1.1（guide/orca-memory-design.md v1.1）
 *
 * 四类数据模型：
 * - LongMemoryFact    当前生效知识状态（二态持久：active / superseded）
 * - MemoryCandidate   Reflection 推断的待晋升候选
 * - AuditEvent       操作元数据日志（prevValue/newValue 已移除，v1.1）
 * - ForgetMarker     遗忘抑制标识（v1.1 新增）
 * - Episode          短期记忆单元（Phase 5.1：message.burst / state.transition）
 *
 * 约束：
 * - 不引入 SQLite / 向量库（本阶段用 JSONL + 内存索引）
 * - AuditEvent 是操作元数据，不是内容备份
 */

// ── 基础类型 ────────────────────────────────────────────────────────────

export type FactType = 'preference' | 'person' | 'habit' | 'fact' | 'behavioral_pattern' | 'state_pattern'

export type FactState = 'active' | 'superseded'

export type CandidateState = 'pending' | 'promoted' | 'rejected' | 'expired'

export type AuditKind = 'created' | 'updated' | 'superseded' | 'merged' | 'compressed' | 'forgotten'

export type AuditActor = 'reflection' | 'user-explicit' | 'user-forget'

// ── LongMemoryFact（长期知识，当前生效状态）────────────────────────────────

/**
 * LongMemoryFact —— 当前生效的长期知识状态
 *
 * identity = (type, subject)；同 (type, subject) 至多一条 active。
 * upsert / supersede 路径。
 */
export interface LongMemoryFact {
  id: string
  type: FactType
  subject: string
  value: string
  confidence: number // 0..1
  source: 'user-explicit' | 'reflection'
  state: FactState
  /** 仅 state='superseded' 时存在 */
  supersededBy?: string
  /** 仅合并来源时存在 */
  supersedes?: string
  /** 仅合并目标时存在 */
  mergedInto?: string
  /** 最多 5 条；append 满则触发 compress */
  representativeEvidenceIds: string[]
  /** ≤ 200 字符；注入 prompt 的单行摘要 */
  evidenceSummary?: string
  /** 单调递增；用于 Reflection 判断稳定度 */
  evidenceCount: number
  createdAt: number
  updatedAt: number
  createdBy: 'reflection' | 'user-explicit' | 'initial-import'
  privacyLevel: 'L1'
  /** 不设 = 永久 */
  ttlDays?: number
}

// ── MemoryCandidate（Reflection 推断的待晋升候选）────────────────────────────

/**
 * MemoryCandidate —— Reflection 推断的待晋升候选
 *
 * source 固定为 'reflection'；user-explicit 不走 candidate 路径。
 */
export interface MemoryCandidate {
  id: string
  proposedFact: {
    type: FactType
    subject: string
    value: string
  }
  confidence: number // 0..1
  evidenceEpisodeIds: string[]
  reason: string
  source: 'reflection' // 必填且固定
  state: CandidateState
  decidedAt?: number
  decidedBy?: 'auto-confidence-threshold' | 'user-confirmed'
  promotedFactId?: string // state='promoted' 时指向 LongMemoryFact.id
  rejectedReason?: string
  ttlDays: number // 默认 30；超期未晋升则 expired
  createdAt: number
}

// ── AuditEvent（操作元数据日志，v1.1：prevValue/newValue 已移除）──────────────

/**
 * AuditEvent —— 操作元数据日志（append-only）
 *
 * v1.1 变更：prevValue / newValue 从 schema 移除。
 * 变更内容通过 changedFields[]（字段名列表）表达，value 本身不进入审计。
 * forgotten 事件：只记录 factId + kind + actor + ts，value 内容永不进入审计记录。
 */
export interface AuditEvent {
  id: string
  factId: string
  ts: number
  kind: AuditKind
  /**
   * v1.1：变更字段名列表。
   * updated 时：['value', 'confidence'] 等。
   * forgotten 时：不填（undefined）。
   */
  changedFields?: string[]
  prevConfidence?: number
  newConfidence?: number
  actor: AuditActor
  reason?: string
  evidenceDelta?: {
    added: string[]
    removed: string[]
  }
}

// ── ForgetMarker（遗忘抑制标识，v1.1 新增）────────────────────────────────

/**
 * ForgetMarker —— 遗忘抑制标识
 *
 * 设计目的：用户 forget X 后，Reflection 未来从旧 Episode 重新推断相同事实时，
 * ForgetMarker 提供确定性抑制信号，使该 candidate 在生成阶段就被拒绝。
 *
 * 特性：
 * - 不包含 memory value（仅 subject + fingerprint）
 * - fingerprint = SHA-256(salt + lower(subject)) 前 16 字符（hex）
 * - 永久保留（用户主动清除前一直抑制）
 * - 与 tombstone 独立（两个机制）
 */
export interface ForgetMarker {
  id: string
  /** SHA-256(salt + lower(subject)) 前 16 字符（hex） */
  fingerprint: string
  /** 原始 subject（不是 value） */
  subject: string
  type: FactType
  createdAt: number
  createdBy: 'user-forget' // 固定值
}

// ── Episode（短期记忆单元，Phase 5.1）────────────────────────────────────

/**
 * Episode —— 最近发生事件的短期记忆单元
 *
 * MVP 支持两类（确定性规则生成，无 LLM）：
 * - message.burst：同 sender 在短时间窗口（90s）内发送 ≥3 条消息
 * - state.transition：WorldState user.status 状态转换（如 away → active）
 *
 * TTL 默认 7 天，到期后 state='pruned'（软删）。
 */
export interface Episode {
  id: string
  category: 'message' | 'state'
  /** message.burst | state.transition */
  kind: 'message.burst' | 'state.transition'
  /** 确定性规则生成；MVP 不调用 LLM */
  summary: string
  ts: number
  /** 主体/对象（人、地、物）；MVP 先用字符串集合 */
  entities: string[]
  /** back-trace 到 EventBus 事件 */
  sourceEventIds: string[]
  importance: 'low' | 'normal' | 'high'
  /** 默认 7 天（对齐 D-AGENT-12） */
  ttlDays: number
  state: 'active' | 'pruned'
  prunedAt?: number
}

// ── Episode Query ───────────────────────────────────────────────────────

export interface EpisodeQuery {
  category?: 'message' | 'state'
  kind?: 'message.burst' | 'state.transition'
  /** ts >= today 00:00 UTC */
  today?: boolean
  /** 按 ts 降序，返回最多 limit 条 */
  limit?: number
  entity?: string
}

/** LongMemoryFact 查询条件 */
export interface FactQuery {
  type?: FactType
  subject?: string
  /** prefix 匹配（e.g. 'girlfriend' 匹配 'girlfriend.coffee'） */
  subjectPrefix?: string
  state?: FactState
  source?: 'user-explicit' | 'reflection'
}

/** MemoryCandidate 查询条件（D-AGENT-18 正式纳入 contract；含 limit） */
export interface CandidateQuery {
  state?: CandidateState
  type?: FactType
  subject?: string
  /**
   * 最多返回多少条候选；按 createdAt 降序截断。默认 100；上限 1000。
   * Phase 5.3+ 已知仅 ReflectionEngine 使用；不需要分页系统，简单 limit 足够。
   */
  limit?: number
}

/** ForgetMarker 查询条件 */
export interface ForgetMarkerQuery {
  type?: FactType
  fingerprint?: string
}

// ── MemoryStore 接口 ────────────────────────────────────────────────────

/**
 * MemoryStore —— LongMemory 的 mutation authority（D-AGENT-17 v1.1）
 *
 * 职责：
 * - 所有 LongMemory 写操作必须经过此接口（Reflection 等上层只能调用 API）
 * - 所有 mutation 同步追加 AuditEvent
 * - 维护 in-memory 索引 + JSONL 持久化
 *
 * Episode（Phase 5.1）：短期记忆存储（episodes.jsonl）
 *
 * 约束：
 * - Reflection 永远不直接修改 JSONL 或 in-memory LongMemoryFact 对象
 * - forget 操作必须原子创建 ForgetMarker + 删除 fact
 * - AuditEvent 不保存 prevValue / newValue（v1.1）
 */
export interface MemoryStore {
  // ── LongMemory read ──
  queryFacts(q: FactQuery, opts?: { includeSuperseded?: boolean }): Promise<LongMemoryFact[]>
  getFact(id: string, opts?: { includeSuperseded?: boolean }): Promise<LongMemoryFact | undefined>

  // ── LongMemory write（受控入口）──
  upsertFact(fact: LongMemoryFact): Promise<LongMemoryFact>
  supersedeFact(oldId: string, newFact: LongMemoryFact): Promise<void>
  mergeFacts(sourceIds: string[], targetId: string): Promise<void>
  compressFactEvidence(id: string, keepRecent?: number): Promise<void>
  forgetFact(id: string): Promise<void>
  forgetByQuery(q: FactQuery): Promise<number>

  // ── Candidate ──
  appendCandidate(c: MemoryCandidate): Promise<void>
  queryCandidates(q: CandidateQuery): Promise<MemoryCandidate[]>
  promoteCandidate(id: string, decidedBy: 'auto-confidence-threshold' | 'user-confirmed'): Promise<LongMemoryFact>
  rejectCandidate(id: string, reason: string): Promise<void>
  expireCandidates(): Promise<number>

  // ── ForgetMarker（v1.1 新增）──
  createForgetMarker(type: FactType, subject: string): Promise<ForgetMarker>
  queryForgetMarkers(q: ForgetMarkerQuery): Promise<ForgetMarker[]>
  /** 检查给定 type+subject 是否被 ForgetMarker 抑制（内部用 salt 重算 fingerprint） */
  isSuppressed(type: FactType, subject: string): Promise<boolean>
  /**
   * 检查给定 subject 是否被任一 ForgetMarker 抑制（subject-only；忽略 type）。
   * Phase 5.3 privacy gate：user-explicit fact 被 forget 后，Reflection 推断该 subject
   * 的任何 fact（任何 type）都应被拒绝 promote。
   */
  isSubjectSuppressed(subject: string): Promise<boolean>

  // ── Episode（Phase 5.1）──
  appendEpisode(e: Episode): Promise<void>
  queryEpisodes(q: EpisodeQuery): Promise<Episode[]>
  getTodayEpisodes(): Promise<Episode[]>
  getRecentEpisodes(limit?: number): Promise<Episode[]>
  pruneExpiredEpisodes(): Promise<number>

  // ── Audit ──
  queryAudit(factId: string, limit?: number): Promise<AuditEvent[]>
}

// ── 配置 ───────────────────────────────────────────────────────────────

export interface OrcaMemoryConfig {
  /** 是否启用 MemoryStore（默认 true） */
  enabled: boolean
  /** Memory 数据目录（默认 appRoot/data/memory） */
  dataDir: string
  /**
   * ForgetMarker fingerprint salt（必须稳定，重启后不变才能跨进程抑制）。
   * 建议使用随机字符串并永久保存到 .env。
   */
  fingerprintSalt: string
  /** LongMemoryFact.active 检索结果上限（默认 100） */
  maxActiveFacts?: number
  /** Candidate confidence 晋升阈值（默认 0.7） */
  promoteThreshold?: number
  /**
   * 可选的事件发射器（Phase 5.4.B）。
   * MemoryStore 在每次 mutation 后调用此函数。
   * 不知道也不关心消费者是谁。
   */
  eventEmitter?: (event: MemoryChangedEvent) => void
}

// ── Memory Changed Events（Phase 5.4.B）──────────────────────────────

/** Memory mutation 事件类型（D-AGENT-19 §19-02） */
export type MemoryEventType = 'fact.created' | 'fact.updated' | 'fact.superseded' | 'fact.merged' | 'fact.forgotten'

/**
 * Memory mutation 事件 payload。
 * 由 MemoryStore 在每次 mutation 后 emit。
 * 消费者：MemoryAttentionAdapter。
 */
export interface MemoryChangedEvent {
  /** 事件类型 */
  type: MemoryEventType
  /** 受影响/创建的 LongMemoryFact.id */
  factId: string
  /** 受影响/创建的 fact subject */
  subject: string
  /** 受影响/创建的 fact type */
  factType: FactType
  /** 事件发生时间（Date.now()） */
  timestamp: number
  /**
   * 对于 superseded/merged：替换的新 fact id。
   * 对于 created/updated：undefined。
   */
  newFactId?: string
}
