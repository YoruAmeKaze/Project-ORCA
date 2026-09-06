/**
 * Orca LongMemory —— MemoryStore 实现（Phase 5.0 + 5.1）
 *
 * 设计依据：D-AGENT-17 v1.1（guide/orca-memory-design.md v1.1）
 *
 * 关键约束：
 * - Mutation authority：所有 LongMemory 写必须经过此接口
 * - Reflection 永远不直接修改 JSONL 或 in-memory LongMemoryFact 对象
 * - forget 操作原子创建 ForgetMarker + 删除 fact
 * - AuditEvent 不保存 prevValue / newValue（v1.1）
 * - fingerprint salt 必须稳定（跨进程不随机），由 config 注入
 *
 * 持久化：JSONL + 内存索引（同 D-AGENT-09 JsonlInfoRecordStore 模式）
 * - long.jsonl       LongMemoryFact
 * - candidates.jsonl MemoryCandidate
 * - audit.jsonl      AuditEvent
 * - markers.jsonl    ForgetMarker
 * - episodes.jsonl    Episode（Phase 5.1）
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AuditActor,
  AuditEvent,
  AuditKind,
  CandidateQuery,
  CandidateState,
  Episode,
  EpisodeQuery,
  FactQuery,
  FactState,
  FactType,
  ForgetMarker,
  ForgetMarkerQuery,
  LongMemoryFact,
  MemoryCandidate,
  MemoryChangedEvent,
  MemoryEventType,
  MemoryStore,
  OrcaMemoryConfig,
} from '../types/memory.js'

// ── 工具函数 ────────────────────────────────────────────────────────────

function sha256Fingerprint(salt: string, subject: string): string {
  return createHash('sha256')
    .update(salt + (subject ?? '').toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, 16) // 前 16 字符（hex），与设计稿一致
}

function activeIdentity(fact: LongMemoryFact): string {
  return `${fact.type}:${fact.subject}`
}

// ── JsonlMemoryStore 实现 ───────────────────────────────────────────────

export class JsonlMemoryStore implements MemoryStore {
  // In-memory 索引
  private factsById = new Map<string, LongMemoryFact>()
  /** 仅 active fact 的 (type:subject) → id 映射 */
  private activeByTypeSubject = new Map<string, string>()
  private candidatesById = new Map<string, MemoryCandidate>()
  private candidatesByState = new Map<CandidateState, Set<string>>()
  private auditByFactId = new Map<string, AuditEvent[]>()
  private markersById = new Map<string, ForgetMarker>()
  private markersByFingerprint = new Map<string, ForgetMarker>()
  private markersByType = new Map<FactType, Set<string>>()
  // Episode 索引（Phase 5.1）
  private episodesById = new Map<string, Episode>()
  private episodeCount = 0 // 用于 limit 计算（保持排序近似）

  // 加载状态
  private loaded = false

  constructor(
    private config: OrcaMemoryConfig,
  ) {}

  /** 发射 memory_changed 事件（如果注册了 emitter） */
  private emit(event: MemoryChangedEvent): void {
    this.config.eventEmitter?.(event)
  }

  // ── 文件路径 ────────────────────────────────────────────────────────

  private fileOf(name: string): string {
    return `${this.config.dataDir}/${name}.jsonl`
  }

  // ── 初始化加载 ───────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    await mkdir(this.config.dataDir, { recursive: true })

    await this.loadLongFacts()
    await this.loadCandidates()
    await this.loadMarkers()
    await this.loadEpisodes()
    // audit.jsonl 在 queryAudit 时按需加载（不需要内存全量缓存）

    this.loaded = true
  }

  private async loadLongFacts(): Promise<void> {
    try {
      const text = await readFile(this.fileOf('long'), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const fact = JSON.parse(line) as LongMemoryFact
          this.factsById.set(fact.id, fact)
          if (fact.state === 'active') {
            this.activeByTypeSubject.set(activeIdentity(fact), fact.id)
          }
        } catch {
          // 跳过损坏行
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  private async loadCandidates(): Promise<void> {
    try {
      const text = await readFile(this.fileOf('candidates'), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const c = JSON.parse(line) as MemoryCandidate
          this.candidatesById.set(c.id, c)
          if (!this.candidatesByState.has(c.state)) {
            this.candidatesByState.set(c.state, new Set())
          }
          this.candidatesByState.get(c.state)!.add(c.id)
        } catch {
          // 跳过损坏行
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  private async loadMarkers(): Promise<void> {
    try {
      const text = await readFile(this.fileOf('markers'), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const m = JSON.parse(line) as ForgetMarker
          this.markersById.set(m.id, m)
          this.markersByFingerprint.set(m.fingerprint, m)
          if (!this.markersByType.has(m.type)) {
            this.markersByType.set(m.type, new Set())
          }
          this.markersByType.get(m.type)!.add(m.fingerprint)
        } catch {
          // 跳过损坏行
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  private async loadEpisodes(): Promise<void> {
    try {
      const text = await readFile(this.fileOf('episodes'), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const ep = JSON.parse(line) as Episode
          this.episodesById.set(ep.id, ep)
          this.episodeCount++
        } catch {
          // 跳过损坏行
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  private async appendToFile(name: string, record: unknown): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true })
    await appendFile(this.fileOf(name), JSON.stringify(record) + '\n', 'utf8')
  }

  private async rewriteFile(name: string, records: unknown[]): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true })
    const content = records.length > 0
      ? records.map((r) => JSON.stringify(r)).join('\n') + '\n'
      : ''
    await writeFile(this.fileOf(name), content, 'utf8')
  }

  // ── 私有写辅助 ───────────────────────────────────────────────────────

  private async appendAudit(
    factId: string,
    kind: AuditKind,
    actor: AuditActor,
    opts?: {
      changedFields?: string[]
      prevConfidence?: number
      newConfidence?: number
      reason?: string
      evidenceDelta?: { added: string[]; removed: string[] }
    },
  ): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: randomUUID(),
      factId,
      ts: Date.now(),
      kind,
      actor,
    }
    if (opts?.changedFields) event.changedFields = opts.changedFields
    if (opts?.prevConfidence !== undefined) event.prevConfidence = opts.prevConfidence
    if (opts?.newConfidence !== undefined) event.newConfidence = opts.newConfidence
    if (opts?.reason) event.reason = opts.reason
    if (opts?.evidenceDelta) event.evidenceDelta = opts.evidenceDelta

    await this.appendToFile('audit', event)

    // 内存缓存（仅保留该 fact 的最新 N 条）
    if (!this.auditByFactId.has(factId)) {
      this.auditByFactId.set(factId, [])
    }
    const list = this.auditByFactId.get(factId)!
    list.push(event)
    // 内存中只保留最近 100 条 per fact
    if (list.length > 100) {
      this.auditByFactId.set(factId, list.slice(-100))
    }

    return event
  }

  private async persistFact(fact: LongMemoryFact, isNew: boolean): Promise<void> {
    await this.appendToFile('long', fact)
    this.factsById.set(fact.id, fact)
    if (fact.state === 'active') {
      this.activeByTypeSubject.set(activeIdentity(fact), fact.id)
    } else {
      // superseded 时从 active 索引移除
      this.activeByTypeSubject.delete(activeIdentity(fact))
    }
  }

  private async rewriteLongFacts(): Promise<void> {
    const facts = [...this.factsById.values()]
    await this.rewriteFile('long', facts)
  }

  private async rewriteCandidates(): Promise<void> {
    const cs = [...this.candidatesById.values()]
    await this.rewriteFile('candidates', cs)
  }

  // ── LongMemory read ───────────────────────────────────────────────────

  async queryFacts(q: FactQuery, opts?: { includeSuperseded?: boolean }): Promise<LongMemoryFact[]> {
    await this.ensureLoaded()
    const results: LongMemoryFact[] = []
    for (const fact of this.factsById.values()) {
      if (fact.state === 'superseded' && !opts?.includeSuperseded) continue
      if (q.state && fact.state !== q.state) continue
      if (q.type && fact.type !== q.type) continue
      if (q.subject && fact.subject !== q.subject) continue
      if (q.subjectPrefix && !fact.subject.toLowerCase().startsWith(q.subjectPrefix.toLowerCase())) continue
      if (q.source && fact.source !== q.source) continue
      results.push(fact)
    }
    // 默认按 updatedAt 降序
    results.sort((a, b) => b.updatedAt - a.updatedAt)
    const max = this.config.maxActiveFacts ?? 100
    return results.slice(0, max)
  }

  async getFact(id: string, opts?: { includeSuperseded?: boolean }): Promise<LongMemoryFact | undefined> {
    await this.ensureLoaded()
    const fact = this.factsById.get(id)
    if (!fact) return undefined
    if (fact.state === 'superseded' && !opts?.includeSuperseded) return undefined
    return fact
  }

  // ── LongMemory write ──────────────────────────────────────────────────

  async upsertFact(fact: LongMemoryFact): Promise<LongMemoryFact> {
    await this.ensureLoaded()

    const existingId = this.activeByTypeSubject.get(activeIdentity(fact))
    const isUpdate = !!existingId
    const prevConfidence = isUpdate ? (this.factsById.get(existingId!)?.confidence) : undefined

    if (isUpdate && existingId) {
      // 更新现有 active fact（保持 existingId）
      const old = this.factsById.get(existingId!)!
      const updated: LongMemoryFact = {
        ...old,
        value: fact.value,
        confidence: fact.confidence,
        evidenceSummary: fact.evidenceSummary,
        representativeEvidenceIds: fact.representativeEvidenceIds,
        evidenceCount: fact.evidenceCount,
        updatedAt: Date.now(),
        supersededBy: undefined,
      }
      await this.appendAudit(existingId!, 'updated', updated.source, {
        changedFields: ['value', 'confidence'],
        prevConfidence,
        newConfidence: updated.confidence,
        evidenceDelta: this.diffEvidence(old.representativeEvidenceIds, updated.representativeEvidenceIds),
      })
      await this.appendToFile('long', updated)
      this.factsById.set(existingId!, updated)
      // active 索引不变（id 未变）
      this.emit({ type: 'fact.updated', factId: updated.id, subject: updated.subject, factType: updated.type, timestamp: Date.now() })
      return updated
    } else {
      // 新建
      const finalFact: LongMemoryFact = {
        ...fact,
        id: fact.id || randomUUID(),
        updatedAt: Date.now(),
      }
      await this.appendAudit(finalFact.id, 'created', finalFact.source, {
        newConfidence: finalFact.confidence,
      })
      await this.persistFact(finalFact, true)
      this.emit({ type: 'fact.created', factId: finalFact.id, subject: finalFact.subject, factType: finalFact.type, timestamp: Date.now() })
      return finalFact
    }
  }

  async supersedeFact(oldId: string, newFact: LongMemoryFact): Promise<void> {
    await this.ensureLoaded()
    const old = this.factsById.get(oldId)
    if (!old) throw new Error(`supersedeFact: old fact not found: ${oldId}`)

    const superseded: LongMemoryFact = {
      ...old,
      state: 'superseded',
      supersededBy: newFact.id,
      updatedAt: Date.now(),
    }
    const created: LongMemoryFact = {
      ...newFact,
      id: newFact.id || randomUUID(),
      state: 'active',
      supersedes: oldId,
      createdAt: newFact.createdAt || Date.now(),
      updatedAt: Date.now(),
    }

    // 原子：先写 superseded，再写 created
    await this.appendAudit(oldId, 'superseded', 'reflection', {
      changedFields: ['state', 'supersededBy'],
      prevConfidence: old.confidence,
      newConfidence: created.confidence,
    })
    await this.appendAudit(created.id, 'created', created.source, {
      changedFields: ['value', 'state'],
      prevConfidence: old.confidence,
      newConfidence: created.confidence,
    })

    // 更新 in-memory
    this.factsById.set(superseded.id, superseded)
    this.factsById.set(created.id, created)
    // active 索引更新
    this.activeByTypeSubject.delete(activeIdentity(old))
    this.activeByTypeSubject.set(activeIdentity(created), created.id)

    // 持久化（append；旧记录留在文件中但被 state='superseded' 标记）
    await this.appendToFile('long', superseded)
    await this.appendToFile('long', created)

    // Phase 5.4.B: emit events
    this.emit({ type: 'fact.created', factId: created.id, subject: created.subject, factType: created.type, timestamp: Date.now() })
    this.emit({ type: 'fact.superseded', factId: old.id, subject: old.subject, factType: old.type, timestamp: Date.now(), newFactId: created.id })
  }

  async mergeFacts(sourceIds: string[], targetId: string): Promise<void> {
    await this.ensureLoaded()
    const target = this.factsById.get(targetId)
    if (!target) throw new Error(`mergeFacts: target not found: ${targetId}`)
    if (target.state !== 'active') throw new Error('mergeFacts: target must be active')

    for (const sid of sourceIds) {
      const src = this.factsById.get(sid)
      if (!src) throw new Error(`mergeFacts: source not found: ${sid}`)
      if (src.state !== 'active') throw new Error('mergeFacts: source must be active')
      if (src.id === targetId) throw new Error('mergeFacts: source cannot equal target')

      const merged: LongMemoryFact = {
        ...src,
        state: 'superseded',
        mergedInto: targetId,
        updatedAt: Date.now(),
      }

      await this.appendAudit(src.id, 'merged', 'reflection', {
        changedFields: ['state', 'mergedInto'],
        prevConfidence: src.confidence,
        newConfidence: target.confidence,
      })

      this.factsById.set(merged.id, merged)
      this.activeByTypeSubject.delete(activeIdentity(src))
      await this.appendToFile('long', merged)
    }

    // 合并 evidence（去重 + 保留最多 keepRecent 条）
    const keepRecent = 5
    const allIds = [
      ...target.representativeEvidenceIds,
      ...sourceIds.flatMap((sid) => this.factsById.get(sid)?.representativeEvidenceIds ?? []),
    ]
    const uniqueIds = [...new Set(allIds)].slice(-keepRecent)

    const updatedTarget: LongMemoryFact = {
      ...target,
      representativeEvidenceIds: uniqueIds,
      evidenceCount: target.evidenceCount + sourceIds.length,
      updatedAt: Date.now(),
    }

    this.factsById.set(updatedTarget.id, updatedTarget)
    // active 索引不变（target id 未变）
    await this.appendToFile('long', updatedTarget)

    // Phase 5.4.B: emit events
    for (const sid of sourceIds) {
      const src = this.factsById.get(sid)
      if (src) {
        this.emit({ type: 'fact.merged', factId: src.id, subject: src.subject, factType: src.type, timestamp: Date.now(), newFactId: targetId })
      }
    }
    this.emit({ type: 'fact.updated', factId: target.id, subject: target.subject, factType: target.type, timestamp: Date.now() })
  }

  async compressFactEvidence(id: string, keepRecent = 5): Promise<void> {
    await this.ensureLoaded()
    const fact = this.factsById.get(id)
    if (!fact) throw new Error(`compressFactEvidence: fact not found: ${id}`)
    if (fact.state !== 'active') throw new Error('compressFactEvidence: only active facts')

    const oldIds = [...fact.representativeEvidenceIds]
    const newIds = oldIds.slice(-keepRecent)
    const removed = oldIds.filter((eid) => !newIds.includes(eid))

    const compressed: LongMemoryFact = {
      ...fact,
      representativeEvidenceIds: newIds,
      updatedAt: Date.now(),
    }

    await this.appendAudit(id, 'compressed', 'reflection', {
      changedFields: ['representativeEvidenceIds'],
      evidenceDelta: { added: [], removed },
    })

    this.factsById.set(compressed.id, compressed)
    // active 索引不变
    await this.appendToFile('long', compressed)
  }

  // ── forget（原子：ForgetMarker 先创建，fact 后删除）────────────────────

  async forgetFact(id: string): Promise<void> {
    await this.ensureLoaded()
    const fact = this.factsById.get(id)
    if (!fact) return // 已经不存在，直接返回

    // Step 1：原子创建 ForgetMarker（先于 fact 删除）
    const marker = await this.createForgetMarker(fact.type, fact.subject)

    // Step 2：删除 LongMemoryFact
    await this.persistForgetFact(id)

    // Step 3：删除相关 MemoryCandidate
    await this.rejectCandidatesBySubject(fact.type, fact.subject)

    // Step 4：追加遗忘审计（value 内容不进入审计记录）
    await this.appendAudit(id, 'forgotten', 'user-forget')

    // Step 5：从 in-memory 移除
    this.factsById.delete(id)
    this.activeByTypeSubject.delete(activeIdentity(fact))

    // Phase 5.4.B: emit fact.forgotten（所有删除步骤完成后）
    this.emit({ type: 'fact.forgotten', factId: id, subject: fact.subject, factType: fact.type, timestamp: Date.now() })
  }

  private async persistForgetFact(id: string): Promise<void> {
    // 从 factsById 移除（JSONL 中该记录保留，但 state 已是 superseded 不影响查询）
    // 若需物理删除：重写 long.jsonl（不保留已删除记录）
    const fact = this.factsById.get(id)
    if (!fact) return

    // 物理删除：从 factsById 移除，重写文件
    this.factsById.delete(id)
    this.activeByTypeSubject.delete(activeIdentity(fact))
    await this.rewriteLongFacts()
  }

  private async rejectCandidatesBySubject(type: FactType, subject: string): Promise<void> {
    const toReject: string[] = []
    for (const [cid, c] of this.candidatesById) {
      if (c.state === 'pending' && c.proposedFact.type === type && c.proposedFact.subject === subject) {
        toReject.push(cid)
      }
    }
    for (const cid of toReject) {
      const c = this.candidatesById.get(cid)!
      const rejected: MemoryCandidate = {
        ...c,
        state: 'rejected',
        rejectedReason: 'suppressed-by-forget-marker',
        decidedAt: Date.now(),
        decidedBy: 'auto-confidence-threshold',
      }
      this.candidatesById.set(cid, rejected)
    }
    if (toReject.length > 0) {
      await this.rewriteCandidates()
    }
  }

  async forgetByQuery(q: FactQuery): Promise<number> {
    await this.ensureLoaded()
    const facts = await this.queryFacts(q, { includeSuperseded: false })
    for (const fact of facts) {
      await this.forgetFact(fact.id)
    }
    return facts.length
  }

  // ── ForgetMarker ──────────────────────────────────────────────────────

  async createForgetMarker(type: FactType, subject: string): Promise<ForgetMarker> {
    await this.ensureLoaded()
    const fingerprint = sha256Fingerprint(this.config.fingerprintSalt, subject)

    // 检查是否已存在（幂等）
    const existing = this.markersByFingerprint.get(fingerprint)
    if (existing && existing.type === type) return existing

    const marker: ForgetMarker = {
      id: randomUUID(),
      fingerprint,
      subject,
      type,
      createdAt: Date.now(),
      createdBy: 'user-forget',
    }

    await this.appendToFile('markers', marker)

    this.markersById.set(marker.id, marker)
    this.markersByFingerprint.set(marker.fingerprint, marker)
    if (!this.markersByType.has(type)) {
      this.markersByType.set(type, new Set())
    }
    this.markersByType.get(type)!.add(marker.fingerprint)

    return marker
  }

  async queryForgetMarkers(q: ForgetMarkerQuery): Promise<ForgetMarker[]> {
    await this.ensureLoaded()
    const results: ForgetMarker[] = []
    for (const marker of this.markersById.values()) {
      if (q.type && marker.type !== q.type) continue
      if (q.fingerprint && marker.fingerprint !== q.fingerprint) continue
      results.push(marker)
    }
    return results
  }

  /**
   * 检查给定 type+subject 的 fingerprint 是否存在 active ForgetMarker。
   * 供 Reflection candidate 生成门控调用。
   */
  async isSuppressed(type: FactType, subject: string): Promise<boolean> {
    await this.ensureLoaded()
    const fingerprint = sha256Fingerprint(this.config.fingerprintSalt, subject)
    const marker = this.markersByFingerprint.get(fingerprint)
    return !!marker && marker.type === type
  }

  async isSubjectSuppressed(subject: string): Promise<boolean> {
    await this.ensureLoaded()
    const fingerprint = sha256Fingerprint(this.config.fingerprintSalt, subject)
    return this.markersByFingerprint.has(fingerprint)
  }

  // ── Candidate ─────────────────────────────────────────────────────────

  async appendCandidate(c: MemoryCandidate): Promise<void> {
    await this.ensureLoaded()
    const candidate: MemoryCandidate = {
      ...c,
      id: c.id || randomUUID(),
    }
    await this.appendToFile('candidates', candidate)
    this.candidatesById.set(candidate.id, candidate)
    if (!this.candidatesByState.has(candidate.state)) {
      this.candidatesByState.set(candidate.state, new Set())
    }
    this.candidatesByState.get(candidate.state)!.add(candidate.id)
  }

  async queryCandidates(q: CandidateQuery): Promise<MemoryCandidate[]> {
    await this.ensureLoaded()
    const results: MemoryCandidate[] = []
    for (const c of this.candidatesById.values()) {
      if (q.state && c.state !== q.state) continue
      if (q.type && c.proposedFact.type !== q.type) continue
      if (q.subject && c.proposedFact.subject !== q.subject) continue
      results.push(c)
    }
    // 按 createdAt 降序
    results.sort((a, b) => b.createdAt - a.createdAt)
    // D-AGENT-18：limit 截断（默认 100；上限 1000）
    const limit = Math.min(q.limit ?? 100, 1000)
    return results.slice(0, limit)
  }

  async promoteCandidate(id: string, decidedBy: 'auto-confidence-threshold' | 'user-confirmed'): Promise<LongMemoryFact> {
    await this.ensureLoaded()
    const c = this.candidatesById.get(id)
    if (!c) throw new Error(`promoteCandidate: candidate not found: ${id}`)
    if (c.state !== 'pending') throw new Error(`promoteCandidate: candidate state is ${c.state}`)

    // D-AGENT-18：subject-only suppression gate（MemoryStore 拥有 enforcement；忽略 type）
    if (await this.isSubjectSuppressed(c.proposedFact.subject)) {
      const rejected: MemoryCandidate = {
        ...c,
        state: 'rejected',
        rejectedReason: 'suppressed-by-forget-marker',
        decidedAt: Date.now(),
        decidedBy: 'auto-confidence-threshold',
      }
      this.candidatesById.set(id, rejected)
      this.candidatesByState.get('pending')?.delete(id)
      if (!this.candidatesByState.has('rejected')) {
        this.candidatesByState.set('rejected', new Set())
      }
      this.candidatesByState.get('rejected')!.add(id)
      await this.appendToFile('candidates', rejected)
      throw new Error(`promoteCandidate: candidate suppressed by ForgetMarker (subject=${c.proposedFact.subject})`)
    }

    // D-AGENT-18：user-explicit 保护 invariant —— MemoryStore 自己检查并拒绝；
    // 任何未来调用 promoteCandidate() 的 subsystem 都自动受到保护。
    // 即便 ReflectionEngine 没有做提前 guard，MemoryStore 也不允许 reflection fact 覆盖 user-explicit。
    const existingActive = await this.queryFacts(
      { type: c.proposedFact.type, subject: c.proposedFact.subject, state: 'active' },
      { includeSuperseded: false },
    )
    const hasUserExplicit = existingActive.some((f) => f.source === 'user-explicit')
    if (hasUserExplicit) {
      const rejected: MemoryCandidate = {
        ...c,
        state: 'rejected',
        rejectedReason: 'user-explicit-fact-exists',
        decidedAt: Date.now(),
        decidedBy: 'auto-confidence-threshold',
      }
      this.candidatesById.set(id, rejected)
      this.candidatesByState.get('pending')?.delete(id)
      if (!this.candidatesByState.has('rejected')) {
        this.candidatesByState.set('rejected', new Set())
      }
      this.candidatesByState.get('rejected')!.add(id)
      await this.appendToFile('candidates', rejected)
      throw new Error(
        `promoteCandidate: user-explicit fact already exists for (type=${c.proposedFact.type}, subject=${c.proposedFact.subject}); cannot overwrite`,
      )
    }

    const fact: LongMemoryFact = {
      id: c.proposedFact.subject + '_' + Date.now(), // 生成稳定 id
      type: c.proposedFact.type,
      subject: c.proposedFact.subject,
      value: c.proposedFact.value,
      confidence: c.confidence,
      source: 'reflection',
      state: 'active',
      representativeEvidenceIds: c.evidenceEpisodeIds.slice(0, 5),
      evidenceSummary: c.reason,
      evidenceCount: c.evidenceEpisodeIds.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: 'reflection',
      privacyLevel: 'L1',
    }

    const promoted: MemoryCandidate = {
      ...c,
      state: 'promoted',
      decidedAt: Date.now(),
      decidedBy,
      promotedFactId: fact.id,
    }

    await this.appendAudit(fact.id, 'created', 'reflection', {
      changedFields: ['value', 'confidence', 'source'],
      newConfidence: fact.confidence,
    })

    await this.persistFact(fact, true)

    // 更新 candidate
    this.candidatesById.set(id, promoted)
    this.candidatesByState.get('pending')?.delete(id)
    if (!this.candidatesByState.has('promoted')) {
      this.candidatesByState.set('promoted', new Set())
    }
    this.candidatesByState.get('promoted')!.add(id)
    await this.appendToFile('candidates', promoted)

    return fact
  }

  async rejectCandidate(id: string, reason: string): Promise<void> {
    await this.ensureLoaded()
    const c = this.candidatesById.get(id)
    if (!c) throw new Error(`rejectCandidate: candidate not found: ${id}`)

    const rejected: MemoryCandidate = {
      ...c,
      state: 'rejected',
      rejectedReason: reason,
      decidedAt: Date.now(),
      decidedBy: 'auto-confidence-threshold',
    }

    this.candidatesById.set(id, rejected)
    this.candidatesByState.get('pending')?.delete(id)
    if (!this.candidatesByState.has('rejected')) {
      this.candidatesByState.set('rejected', new Set())
    }
    this.candidatesByState.get('rejected')!.add(id)
    await this.appendToFile('candidates', rejected)
  }

  async expireCandidates(): Promise<number> {
    await this.ensureLoaded()
    const now = Date.now()
    const toExpire: string[] = []
    for (const [id, c] of this.candidatesById) {
      if (c.state === 'pending') {
        const age = (c.ttlDays ?? 30) * 86_400_000
        if (now - c.createdAt > age) toExpire.push(id)
      }
    }
    for (const id of toExpire) {
      const c = this.candidatesById.get(id)!
      const expired: MemoryCandidate = { ...c, state: 'expired', decidedAt: now, decidedBy: 'auto-confidence-threshold' }
      this.candidatesById.set(id, expired)
      this.candidatesByState.get('pending')?.delete(id)
      if (!this.candidatesByState.has('expired')) {
        this.candidatesByState.set('expired', new Set())
      }
      this.candidatesByState.get('expired')!.add(id)
      await this.appendToFile('candidates', expired)
    }
    return toExpire.length
  }

  // ── Audit ────────────────────────────────────────────────────────────

  async queryAudit(factId: string, limit = 50): Promise<AuditEvent[]> {
    await this.ensureLoaded()
    // 从内存缓存返回（内存缓存了最新 100 条 per fact）
    const cached = this.auditByFactId.get(factId) ?? []
    return cached.slice(-limit)
  }

  // ── Episode（Phase 5.1）──────────────────────────────────────────────────

  async appendEpisode(e: Episode): Promise<void> {
    await this.ensureLoaded()
    const episode: Episode = { ...e, id: e.id || randomUUID() }
    await this.appendToFile('episodes', episode)
    this.episodesById.set(episode.id, episode)
    this.episodeCount++
  }

  async queryEpisodes(q: EpisodeQuery): Promise<Episode[]> {
    await this.ensureLoaded()
    const now = Date.now()
    const todayStart = new Date().setHours(0, 0, 0, 0) // UTC midnight
    const results: Episode[] = []

    for (const ep of this.episodesById.values()) {
      if (ep.state === 'pruned') continue
      if (q.category && ep.category !== q.category) continue
      if (q.kind && ep.kind !== q.kind) continue
      if (q.entity && !ep.entities.includes(q.entity)) continue
      if (q.today && ep.ts < todayStart) continue
      // TTL 检查
      const expiresAt = ep.ts + ep.ttlDays * 86_400_000
      if (expiresAt < now) continue
      results.push(ep)
    }

    // 默认按 ts 降序
    results.sort((a, b) => b.ts - a.ts)

    const max = q.limit ?? 100
    return results.slice(0, max)
  }

  async getTodayEpisodes(): Promise<Episode[]> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    return this.queryEpisodes({ today: true, limit: 100 })
  }

  async getRecentEpisodes(limit = 50): Promise<Episode[]> {
    return this.queryEpisodes({ limit })
  }

  async pruneExpiredEpisodes(): Promise<number> {
    await this.ensureLoaded()
    const now = Date.now()
    let pruned = 0

    for (const [id, ep] of this.episodesById) {
      if (ep.state === 'pruned') continue
      const expiresAt = ep.ts + ep.ttlDays * 86_400_000
      if (expiresAt < now) {
        const updated: Episode = { ...ep, state: 'pruned', prunedAt: now }
        this.episodesById.set(id, updated)
        pruned++
      }
    }

    if (pruned > 0) {
      // 重写 episodes.jsonl，物理移除过期记录
      const active = [...this.episodesById.values()].filter((e) => e.state === 'active')
      await this.rewriteFile('episodes', active)
    }

    return pruned
  }

  // ── 辅助 ───────────────────────────────────────────────────────────────

  private diffEvidence(oldIds: string[], newIds: string[]): { added: string[]; removed: string[] } {
    const oldSet = new Set(oldIds)
    const newSet = new Set(newIds)
    return {
      added: newIds.filter((id) => !oldSet.has(id)),
      removed: oldIds.filter((id) => !newSet.has(id)),
    }
  }

  /** 仅供测试：获取当前活跃 fact 总数 */
  getActiveCountForTest(): number {
    return this.activeByTypeSubject.size
  }

  /** 仅供测试：获取当前 markers 总数 */
  getMarkerCountForTest(): number {
    return this.markersById.size
  }

  /** 仅供测试：获取当前 episode 总数 */
  getEpisodeCountForTest(): number {
    return this.episodeCount
  }
}

// ── 工厂函数 ────────────────────────────────────────────────────────────

/**
 * 创建 MemoryStore 实例。
 *
 * 必须在 index.ts 初始化阶段调用（确保 ORCA_MEMORY_DIR 配置已读取）。
 * 不要在 plugin 生命周期内重复创建（每个 plugin 实例应当接收已存在的 store 引用）。
 */
export function createMemoryStore(config: OrcaMemoryConfig): MemoryStore {
  return new JsonlMemoryStore(config)
}
