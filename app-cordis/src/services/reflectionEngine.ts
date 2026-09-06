/**
 * ReflectionEngine —— Reflection 推断引擎（Phase 5.3 MVP）
 *
 * 职责（Phase 5.3 MVP）：
 * - 读取最近 Episode（deterministic）
 * - 发现可晋升的 pattern（确定性规则，无 LLM）
 * - 生成 MemoryCandidate
 * - 检查 ForgetMarker suppression
 * - 在 confidence 足够时调用 MemoryStore.promoteCandidate
 * - 检查 user-explicit fact 冲突（避免无条件覆盖）
 *
 * 严格约束（用户决策，2026-08-27）：
 * - **不**直接修改 LongMemoryFact
 * - **不**直接写 long.jsonl / candidates.jsonl / episodes.jsonl
 * - **不**调用 JSONL persistence
 * - **不**绕过 MemoryStore mutation authority
 * - **不**使用 LLM（deterministic rule only）
 * - proposer ≠ mutator（MemoryStore 才是 mutator）
 *
 * MVP 规则（确定性，Phase 5.3）：
 * - Rule A (Repeated Entity Burst)：同一 entities[0]（sender）在最近 N 条 Episode 中
 *   出现 ≥ 3 次且 kind='message.burst' 时生成 candidate
 *   candidate: type='behavioral_pattern', subject=entities[0], value='high_burst_frequency'
 *
 * confidence 计算（确定性公式）：
 * - count=3  → 0.70
 * - count=4  → 0.75
 * - count=5  → 0.80
 * - count=6+ → min(0.85 + (count-6) * 0.05, 0.95)
 *
 * 禁止事项：
 * - LLM Reflection
 * - Episode → Candidate 自动 promote（除非 confidence 满足）
 * - CEO / context retrieval
 * - Memory → Attention / Decision / WorldState
 * - Calendar / GPS
 * - vector DB / embedding / semantic search
 * - 自动 personality inference
 *
 * Phase 5.3 不做：
 * - 复杂 scheduler（只提供 reflectNow() / reflectRecent() 接口）
 * - LLM 摘要 / extraction
 * - 多个 reflection rule 之间的优先级调度
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { MemoryStore, Episode, MemoryCandidate, FactType, LongMemoryFact } from '../types/memory.js'

/** Reflection 触发方式 */
export type ReflectionTrigger = 'manual' | 'episode-burst' | 'interval'

/** Rule A 生成的 candidate kind 标识 */
export const REFLECTION_RULE_A_KIND = 'repeated-burst-entity'

/** confidence promote 阈值（Phase 5.3 MVP 默认 0.70） */
export const REFLECTION_PROMOTE_THRESHOLD = 0.70

/** Rule A 最小 occurrence 数（≥ 3 触发） */
export const REFLECTION_MIN_OCCURRENCE = 3

/** Rule A confidence 公式 */
export function confidenceFromCount(count: number): number {
  if (count < REFLECTION_MIN_OCCURRENCE) return 0
  if (count === 3) return 0.70
  if (count === 4) return 0.75
  if (count === 5) return 0.80
  return Math.min(0.85 + (count - 6) * 0.05, 0.95)
}

/** Rule A 是否应该生成 candidate（occurrence ≥ MIN_OCCURRENCE） */
export function shouldGenerateCandidateFromCount(count: number): boolean {
  return count >= REFLECTION_MIN_OCCURRENCE
}

/** ReflectionEngine 配置 */
export interface ReflectionConfig {
  /** 最近 Episode 数量上限（默认 30） */
  episodeLimit?: number
  /** confidence promote 阈值（默认 0.70） */
  promoteThreshold?: number
}

/** Reflection 统计（每次 reflect 后返回） */
export interface ReflectionStats {
  scannedEpisodeCount: number
  candidateGeneratedCount: number
  candidateSuppressedCount: number
  candidateRejectedCount: number
  candidatePromotedCount: number
}

/** ReflectionEngine 实例 */
export interface ReflectionEngine {
  /**
   * 扫描最近 Episode 并执行规则。
   * 默认 trigger='manual'，可由 caller 指定其他 trigger（仅用于日志/审计）。
   */
  reflectNow(opts?: { trigger?: ReflectionTrigger; episodeLimit?: number }): Promise<ReflectionStats>
  /**
   * 扫描最近 N Episode（默认 episodeLimit 配置）并执行规则。
   * 当前实现与 reflectNow 等价；保留独立接口便于将来扩展。
   */
  reflectRecent(n?: number): Promise<ReflectionStats>
  /** dispose 内部状态 */
  dispose(): void
}

/**
 * 创建 ReflectionEngine（工厂）
 */
export function createReflectionEngine(
  ctx: Context | ReflectionEngineContext,
  config: ReflectionConfig = {},
): ReflectionEngine {
  const ctx_: ReflectionEngineContext = {
    memory: typeof (ctx as Context).get === 'function'
      ? ((ctx as Context).get('memory') as MemoryStore | undefined)
      : (ctx as ReflectionEngineContext).memory,
    logger: (ctx as ReflectionEngineContext).logger ?? (ctx as Context).logger,
  }
  const memory: MemoryStore | undefined = ctx_.memory
  const logger = ctx_.logger

  if (!memory) {
    logger?.warn?.('[reflection-engine] memory service 未提供；engine 进入 noop 模式')
  }

  const episodeLimit = config.episodeLimit ?? 30
  const promoteThreshold = config.promoteThreshold ?? REFLECTION_PROMOTE_THRESHOLD

  /**
   * 内部：执行 Rule A
   * @returns 生成的 candidate 列表（未 persist 到 store）
   */
  function runRuleA(episodes: Episode[]): { type: FactType; subject: string; value: string; confidence: number; evidenceEpisodeIds: string[]; reason: string }[] {
    // 聚合：key = `${kind}::${entities[0]}` （仅 message.burst）
    const groups = new Map<string, { count: number; episodeIds: string[]; sender: string }>()
    for (const ep of episodes) {
      if (ep.kind !== 'message.burst') continue
      if (ep.state !== 'active') continue
      const sender: string | undefined = ep.entities[0]
      if (!sender) continue
      const k = `${ep.kind}::${sender}`
      const existing = groups.get(k)
      if (existing) {
        existing.count++
        existing.episodeIds.push(ep.id)
      } else {
        groups.set(k, { count: 1, episodeIds: [ep.id], sender })
      }
    }

    const out: { type: FactType; subject: string; value: string; confidence: number; evidenceEpisodeIds: string[]; reason: string }[] = []
    for (const { count, episodeIds, sender } of groups.values()) {
      if (!shouldGenerateCandidateFromCount(count)) continue
      const confidence = confidenceFromCount(count)
      out.push({
        type: 'behavioral_pattern',
        subject: sender,
        value: 'high_burst_frequency',
        confidence,
        evidenceEpisodeIds: episodeIds,
        reason: `${count} message.burst episodes involving ${sender} in recent window`,
      })
    }
    return out
  }

  /**
   * 内部：去重（同一 type+subject 已存在非 expired candidate 时跳过）
   * 返回新生成的 candidate（过滤掉已存在的）
   */
  async function dedupCandidates(
    candidates: ReturnType<typeof runRuleA>,
    existing: MemoryCandidate[],
  ): Promise<ReturnType<typeof runRuleA>> {
    // 已 promoted / rejected / suppressed 的 candidate 视为已处理过；不再生成
    const existingKeys = new Set(
      existing
        .filter((c) => c.state !== 'expired')
        .map((c) => `${c.proposedFact.type}::${c.proposedFact.subject}`),
    )
    return candidates.filter((c) => !existingKeys.has(`${c.type}::${c.subject}`))
  }

  /**
   * 内部：检查 user-explicit fact 冲突
   * 返回 true = 有冲突，应该拒绝 candidate
   */
  async function hasUserExplicitConflict(type: FactType, subject: string): Promise<boolean> {
    if (!memory) return false
    const existing = await memory.queryFacts({ type, subject, state: 'active' }, { includeSuperseded: false })
    return existing.some((f) => f.source === 'user-explicit')
  }

  async function reflect(opts: { trigger: ReflectionTrigger; episodeLimit: number }): Promise<ReflectionStats> {
    const stats: ReflectionStats = {
      scannedEpisodeCount: 0,
      candidateGeneratedCount: 0,
      candidateSuppressedCount: 0,
      candidateRejectedCount: 0,
      candidatePromotedCount: 0,
    }

    if (!memory) {
      logger?.warn?.('[reflection-engine] noop: memory service 缺失')
      return stats
    }

    // Step 1: 读取最近 Episode
    const episodes = await memory.getRecentEpisodes(opts.episodeLimit)
    stats.scannedEpisodeCount = episodes.length
    logger?.info?.(
      '[reflection-engine] reflectNow trigger=%s scanned=%d episodeLimit=%d',
      opts.trigger,
      episodes.length,
      opts.episodeLimit,
    )

    if (episodes.length === 0) return stats

    // Step 2: 读现有 candidate（用于去重；包括 promoted/rejected/pending；排除 expired）
    const existingCandidates = await memory.queryCandidates({})

    // Step 3: 运行规则
    const ruleAOut = runRuleA(episodes)

    // Step 4: 去重
    const newCandidates = await dedupCandidates(ruleAOut, existingCandidates)
    stats.candidateGeneratedCount = newCandidates.length

    // Step 5: persist candidate + 检查 suppression + 检查 user-explicit + 决定 promote / reject
    for (const c of newCandidates) {
      const candidateId = randomUUID()
      const candidate: MemoryCandidate = {
        id: candidateId,
        proposedFact: {
          type: c.type,
          subject: c.subject,
          value: c.value,
        },
        confidence: c.confidence,
        evidenceEpisodeIds: c.evidenceEpisodeIds,
        reason: c.reason,
        source: 'reflection',
        state: 'pending',
        ttlDays: 30,
        createdAt: Date.now(),
      }
      await memory.appendCandidate(candidate)

      // Step 5a: 检查 ForgetMarker suppression（subject-only；忽略 type —— privacy gate）
      const suppressed = await memory.isSubjectSuppressed(c.subject)
      if (suppressed) {
        await memory.rejectCandidate(candidateId, 'suppressed-by-forget-marker')
        stats.candidateSuppressedCount++
        continue
      }

      // Step 5b: 检查 user-explicit fact 冲突（防止覆盖 user-explicit）
      if (await hasUserExplicitConflict(c.type, c.subject)) {
        await memory.rejectCandidate(candidateId, 'user-explicit-fact-exists')
        stats.candidateRejectedCount++
        continue
      }

      // Step 5c: confidence 满足阈值 → promote
      if (c.confidence >= promoteThreshold) {
        try {
          await memory.promoteCandidate(candidateId, 'auto-confidence-threshold')
          stats.candidatePromotedCount++
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          logger?.warn?.('[reflection-engine] promote 失败: %s', detail)
        }
      }
    }

    logger?.info?.(
      '[reflection-engine] 统计 scanned=%d generated=%d suppressed=%d rejected=%d promoted=%d',
      stats.scannedEpisodeCount,
      stats.candidateGeneratedCount,
      stats.candidateSuppressedCount,
      stats.candidateRejectedCount,
      stats.candidatePromotedCount,
    )

    return stats
  }

  return {
    async reflectNow(opts) {
      return reflect({
        trigger: opts?.trigger ?? 'manual',
        episodeLimit: opts?.episodeLimit ?? episodeLimit,
      })
    },
    async reflectRecent(n) {
      return reflect({ trigger: 'manual', episodeLimit: n ?? episodeLimit })
    },
    dispose() {
      // 当前 MVP 无内部 state；接口保留供未来扩展
    },
  }
}

/** ReflectionEngineContext —— ReflectionEngine 需要的最小依赖 */
export interface ReflectionEngineContext {
  memory?: MemoryStore
  logger?: {
    info?(msg: string, ...args: unknown[]): void
    warn?(msg: string, ...args: unknown[]): void
  }
}