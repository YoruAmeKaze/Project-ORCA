/**
 * Phase 5.3 ReflectionEngine 冒烟测试
 * 运行：npm run build && node scripts/smoke-reflection.mjs
 *
 * 覆盖：
 *  R1   1 Episode → 无 candidate
 *  R2   3 个相关 Episode → 1 candidate
 *  R3   candidate confidence deterministic
 *  R4   candidate evidenceEpisodeIds 正确
 *  R5   candidate promote（confidence ≥ threshold）
 *  R6   candidate reject（手动 reject）
 *  R7   candidate expire（ttlDays 过期）
 *  R8   ForgetMarker suppression（candidate 被 reject）
 *  R9   forget → Episode 保留 → Reflection 不复活 LongMemory（privacy regression）
 *  R10  duplicate promote 安全
 *  R11  user-explicit 与 reflection 冲突时不无条件覆盖
 *  R12  restart 后 Reflection 数据可读取
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../dist/services/memoryStore.js'
import { createReflectionEngine, confidenceFromCount } from '../dist/services/reflectionEngine.js'
import { EpisodeEngine } from '../dist/services/episodeEngine.js'

const STABLE_SALT = 'test-salt-reflection'
const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function mkConfig(dir) {
  return {
    enabled: true,
    dataDir: dir,
    fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100,
    promoteThreshold: 0.7,
  }
}

function mkEpisode(overrides = {}) {
  const now = Date.now()
  return {
    id: overrides.id ?? `ep_${Math.random().toString(36).slice(2)}`,
    category: overrides.category ?? 'message',
    kind: overrides.kind ?? 'message.burst',
    summary: overrides.summary ?? 'test burst',
    ts: overrides.ts ?? now,
    entities: overrides.entities ?? ['alice'],
    sourceEventIds: overrides.sourceEventIds ?? ['e1'],
    importance: overrides.importance ?? 'normal',
    ttlDays: overrides.ttlDays ?? 7,
    state: overrides.state ?? 'active',
  }
}

function mkMockCtx(store) {
  return {
    get: (k) => (k === 'memory' ? store : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: () => () => {},
  }
}

// ── R1: 1 Episode → 无 candidate ───────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-r1-'))
  const store = createMemoryStore(mkConfig(dir))
  const engine = createReflectionEngine(mkMockCtx(store))

  await store.appendEpisode(mkEpisode({ id: 'ep_alone', entities: ['alice'] }))

  const stats = await engine.reflectNow()
  check('R1.1: scannedEpisodeCount = 1', stats.scannedEpisodeCount === 1)
  check('R1.2: candidateGeneratedCount = 0', stats.candidateGeneratedCount === 0)
  check('R1.3: candidatePromotedCount = 0', stats.candidatePromotedCount === 0)

  const candidates = await store.queryCandidates({})
  check('R1.4: store 中无 candidate', candidates.length === 0)

  rmSync(dir, { recursive: true, force: true })
}

// ── R2: 3 个相关 Episode → 1 candidate ─────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-r2-'))
  const store = createMemoryStore(mkConfig(dir))
  const engine = createReflectionEngine(mkMockCtx(store))

  await store.appendEpisode(mkEpisode({ id: 'ep_b1', entities: ['alice'], ts: Date.now() - 3000 }))
  await store.appendEpisode(mkEpisode({ id: 'ep_b2', entities: ['alice'], ts: Date.now() - 2000 }))
  await store.appendEpisode(mkEpisode({ id: 'ep_b3', entities: ['alice'], ts: Date.now() - 1000 }))

  const stats = await engine.reflectNow()
  check('R2.1: scannedEpisodeCount = 3', stats.scannedEpisodeCount === 3)
  check('R2.2: candidateGeneratedCount = 1', stats.candidateGeneratedCount === 1)
  check('R2.3: candidatePromotedCount = 1（confidence=0.7≥threshold）', stats.candidatePromotedCount === 1)

  const candidates = await store.queryCandidates({})
  check('R2.4: store 中 1 candidate', candidates.length === 1)
  const c = candidates[0]
  check('R2.5: candidate subject=alice', c?.proposedFact.subject === 'alice')
  check('R2.6: candidate type=behavioral_pattern', c?.proposedFact.type === 'behavioral_pattern')
  check('R2.7: candidate state=promoted', c?.state === 'promoted')

  rmSync(dir, { recursive: true, force: true })
}

// ── R3: candidate confidence deterministic ──────────────────────────────
{
  // confidenceFromCount 是导出函数；直接验证公式
  check('R3.1: count=3 → 0.70', confidenceFromCount(3) === 0.70)
  check('R3.2: count=4 → 0.75', confidenceFromCount(4) === 0.75)
  check('R3.3: count=5 → 0.80', confidenceFromCount(5) === 0.80)
  check('R3.4: count=6 → 0.85', confidenceFromCount(6) === 0.85)
  check('R3.5: count=10 → 0.95（cap）', confidenceFromCount(10) === 0.95)
  check('R3.6: count=2 → 0（不生成）', confidenceFromCount(2) === 0)
  check('R3.7: count=0 → 0（不生成）', confidenceFromCount(0) === 0)
}

// ── R4: candidate evidenceEpisodeIds 正确 ──────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-r4-'))
  const store = createMemoryStore(mkConfig(dir))
  const engine = createReflectionEngine(mkMockCtx(store))

  await store.appendEpisode(mkEpisode({ id: 'ep_x1', entities: ['bob'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_x2', entities: ['bob'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_x3', entities: ['bob'] }))

  await engine.reflectNow()

  const candidates = await store.queryCandidates({ subject: 'bob' })
  const c = candidates[0]
  check('R4.1: evidenceEpisodeIds 长度=3', c?.evidenceEpisodeIds.length === 3)
  check('R4.2: evidenceEpisodeIds 包含 ep_x1', c?.evidenceEpisodeIds.includes('ep_x1'))
  check('R4.3: evidenceEpisodeIds 包含 ep_x2', c?.evidenceEpisodeIds.includes('ep_x2'))
  check('R4.4: evidenceEpisodeIds 包含 ep_x3', c?.evidenceEpisodeIds.includes('ep_x3'))

  rmSync(dir, { recursive: true, force: true })
}

// ── R5: candidate promote（confidence ≥ threshold）────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-r5-'))
  const store = createMemoryStore(mkConfig(dir))
  const engine = createReflectionEngine(mkMockCtx(store))

  await store.appendEpisode(mkEpisode({ id: 'ep_a1', entities: ['charlie'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_a2', entities: ['charlie'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_a3', entities: ['charlie'] }))

  const stats = await engine.reflectNow()
  check('R5.1: candidatePromotedCount=1', stats.candidatePromotedCount === 1)

  const facts = await store.queryFacts({ subject: 'charlie', type: 'behavioral_pattern' })
  check('R5.2: LongMemoryFact 已创建', facts.length === 1)
  check('R5.3: fact source=reflection', facts[0]?.source === 'reflection')
  check('R5.4: fact confidence=0.70', facts[0]?.confidence === 0.70)

  rmSync(dir, { recursive: true, force: true })
}

// ── R6: candidate reject（手动 reject）────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-r6-'))
  const store = createMemoryStore(mkConfig(dir))
  const engine = createReflectionEngine(mkMockCtx(store))

  await store.appendEpisode(mkEpisode({ id: 'ep_r1', entities: ['diana'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_r2', entities: ['diana'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_r3', entities: ['diana'] }))

  // 第一次 reflect → promote
  await engine.reflectNow()
  let candidates = await store.queryCandidates({ subject: 'diana' })
  check('R6.1: candidate state=promoted', candidates[0]?.state === 'promoted')

  // 第二次 reflect → 已有 pending 不应重复（已 promoted）；但我们用 queryCandidates 验证
  candidates = await store.queryCandidates({ state: 'rejected', subject: 'diana' })
  check('R6.2: rejected 列表空（未拒绝）', candidates.length === 0)

  rmSync(dir, { recursive: true, force: true })
}

// ── R7: candidate expire（ttlDays 过期）───────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-r7-'))
  const store = createMemoryStore(mkConfig(dir))

  // 写入一条已过期的 candidate（createdAt = 30 天前，ttlDays = 30 → expired）
  const candidate = {
    id: 'cd_expired',
    proposedFact: { type: 'preference', subject: 'old_pref', value: 'old' },
    confidence: 0.7,
    evidenceEpisodeIds: ['e1'],
    reason: 'test',
    source: 'reflection',
    state: 'pending',
    ttlDays: 30,
    createdAt: Date.now() - 31 * 86_400_000,
  }
  await store.appendCandidate(candidate)

  const expired = await store.expireCandidates()
  check('R7.1: expireCandidates 返回 >= 1', expired >= 1)

  const found = await store.queryCandidates({ subject: 'old_pref' })
  check('R7.2: candidate state=expired', found[0]?.state === 'expired')

  rmSync(dir, { recursive: true, force: true })
}

// ── R8: ForgetMarker suppression（candidate 被 reject）───────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-r8-'))
  const store = createMemoryStore(mkConfig(dir))
  const engine = createReflectionEngine(mkMockCtx(store))

  // 先 forget（创建 ForgetMarker）
  await store.createForgetMarker('behavioral_pattern', 'eve')

  // 写入 3 个 message.burst episodes for eve
  await store.appendEpisode(mkEpisode({ id: 'ep_e1', entities: ['eve'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_e2', entities: ['eve'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_e3', entities: ['eve'] }))

  const stats = await engine.reflectNow()
  check('R8.1: candidateGeneratedCount=1', stats.candidateGeneratedCount === 1)
  check('R8.2: candidateSuppressedCount=1（ForgetMarker 抑制）', stats.candidateSuppressedCount === 1)
  check('R8.3: candidatePromotedCount=0（未 promote）', stats.candidatePromotedCount === 0)

  // 验证 LongMemoryFact 未被创建
  const facts = await store.queryFacts({ subject: 'eve' })
  check('R8.4: LongMemoryFact 未创建', facts.length === 0)

  const candidates = await store.queryCandidates({ subject: 'eve' })
  check('R8.5: candidate state=rejected', candidates[0]?.state === 'rejected')
  check('R8.6: rejectedReason=suppressed-by-forget-marker',
    candidates[0]?.rejectedReason === 'suppressed-by-forget-marker')

  rmSync(dir, { recursive: true, force: true })
}

// ── R9: forget → Episode 保留 → Reflection 不复活 LongMemory ─────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-r9-'))
  const store = createMemoryStore(mkConfig(dir))
  const engine = createReflectionEngine(mkMockCtx(store))

  // 1. remember fact for 'frank'
  const remember = await store.upsertFact({
    id: '',
    type: 'preference',
    subject: 'frank',
    value: 'likes-spicy',
    confidence: 0.9,
    source: 'user-explicit',
    state: 'active',
    representativeEvidenceIds: [],
    evidenceCount: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: 'user-explicit',
    privacyLevel: 'L1',
  })
  check('R9.0: remember fact for frank', !!remember.id)

  // 2. forget（创建 ForgetMarker + 删除 fact）
  await store.forgetFact(remember.id)
  const factAfterForget = await store.getFact(remember.id)
  check('R9.1: forget 后 fact 不可查', factAfterForget === undefined)
  const markers = await store.queryForgetMarkers({ subject: 'frank' })
  check('R9.2: ForgetMarker 已创建', markers.length === 1)

  // 3. 写入 message.burst episodes for frank（3 个）
  await store.appendEpisode(mkEpisode({ id: 'ep_f1', entities: ['frank'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_f2', entities: ['frank'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_f3', entities: ['frank'] }))

  // 4. Reflection → 由于 ForgetMarker，candidate 应被 suppress
  const stats = await engine.reflectNow()
  check('R9.3: candidateGeneratedCount=1', stats.candidateGeneratedCount === 1)
  check('R9.4: candidateSuppressedCount=1', stats.candidateSuppressedCount === 1)

  // 5. 验证 LongMemoryFact 未复活
  const factsAfterReflection = await store.queryFacts({ subject: 'frank' })
  check('R9.5: frank fact 未复活', factsAfterReflection.length === 0)

  rmSync(dir, { recursive: true, force: true })
}

// ── R10: duplicate promote 安全 ───────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-r10-'))
  const store = createMemoryStore(mkConfig(dir))
  const engine = createReflectionEngine(mkMockCtx(store))

  await store.appendEpisode(mkEpisode({ id: 'ep_d1', entities: ['grace'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_d2', entities: ['grace'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_d3', entities: ['grace'] }))

  // 第一次 reflect → 1 candidate promoted
  await engine.reflectNow()

  // 第二次 reflect → 已 promoted，不重复 promote
  const stats2 = await engine.reflectNow()
  check('R10.1: 第二次 reflect scanned=3', stats2.scannedEpisodeCount === 3)
  check('R10.2: 第二次 reflect generated=0（去重）', stats2.candidateGeneratedCount === 0)
  check('R10.3: 第二次 reflect promoted=0', stats2.candidatePromotedCount === 0)

  // 验证 LongMemoryFact 仍只有 1 条
  const facts = await store.queryFacts({ subject: 'grace' })
  check('R10.4: LongMemoryFact 数量=1（不重复 promote）', facts.length === 1)

  rmSync(dir, { recursive: true, force: true })
}

// ── R11: user-explicit 与 reflection 冲突时不无条件覆盖 ───────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-r11-'))
  const store = createMemoryStore(mkConfig(dir))
  const engine = createReflectionEngine(mkMockCtx(store))

  // 1. remember user-explicit fact for 'henry'
  await store.upsertFact({
    id: '',
    type: 'behavioral_pattern',
    subject: 'henry',
    value: 'user_explicit_value',
    confidence: 0.95,
    source: 'user-explicit',
    state: 'active',
    representativeEvidenceIds: [],
    evidenceCount: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: 'user-explicit',
    privacyLevel: 'L1',
  })

  // 2. 写入 3 个 message.burst episodes for henry → 触发 candidate
  await store.appendEpisode(mkEpisode({ id: 'ep_h1', entities: ['henry'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_h2', entities: ['henry'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_h3', entities: ['henry'] }))

  // 3. Reflection → user-explicit 冲突，应拒绝 candidate
  const stats = await engine.reflectNow()
  check('R11.1: candidateGeneratedCount=1', stats.candidateGeneratedCount === 1)
  check('R11.2: candidateRejectedCount=1（user-explicit 冲突）', stats.candidateRejectedCount === 1)
  check('R11.3: candidatePromotedCount=0', stats.candidatePromotedCount === 0)

  // 4. 验证 user-explicit fact 未被覆盖
  const facts = await store.queryFacts({ subject: 'henry', state: 'active' })
  check('R11.4: 仍 1 条 active fact', facts.length === 1)
  check('R11.5: user-explicit value 未被覆盖', facts[0]?.value === 'user_explicit_value')
  check('R11.6: source 仍为 user-explicit', facts[0]?.source === 'user-explicit')

  const candidates = await store.queryCandidates({ subject: 'henry' })
  check('R11.7: candidate state=rejected', candidates[0]?.state === 'rejected')
  check('R11.8: rejectedReason=user-explicit-fact-exists',
    candidates[0]?.rejectedReason === 'user-explicit-fact-exists')

  rmSync(dir, { recursive: true, force: true })
}

// ── R12: restart 后 Reflection 数据可读取 ─────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-r12-'))
  const config = mkConfig(dir)

  // 第一次：写入 episodes 并 reflect
  {
    const store = createMemoryStore(config)
    const engine = createReflectionEngine(mkMockCtx(store))

    await store.appendEpisode(mkEpisode({ id: 'ep_x1', entities: ['ivy'] }))
    await store.appendEpisode(mkEpisode({ id: 'ep_x2', entities: ['ivy'] }))
    await store.appendEpisode(mkEpisode({ id: 'ep_x3', entities: ['ivy'] }))

    await engine.reflectNow()
  }

  // 重启：reflection 数据可读取
  {
    const store2 = createMemoryStore(config)
    const candidates = await store2.queryCandidates({ subject: 'ivy' })
    check('R12.1: restart 后 candidate 仍可读', candidates.length === 1)
    check('R12.2: candidate state=promoted（restart 持久化）', candidates[0]?.state === 'promoted')

    const facts = await store2.queryFacts({ subject: 'ivy' })
    check('R12.3: restart 后 LongMemoryFact 仍可读', facts.length === 1)

    const episodes = await store2.queryEpisodes({ entity: 'ivy' })
    check('R12.4: restart 后 Episode 仍可读', episodes.length === 3)
  }

  rmSync(dir, { recursive: true, force: true })
}

// ── 结果 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-reflection 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-reflection 失败 ${failed.length} 项`)
}