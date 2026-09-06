/**
 * D-AGENT-18 Memory Contract Hardening 冒烟测试
 * 运行：npm run build && node scripts/smoke-d-agent-18.mjs
 *
 * 覆盖：
 *  C1   queryCandidates(state/type/subject/limit)
 *  C2   subject-level suppression
 *  C3   forget subject A → candidate type B → promote 被拒绝
 *  C4   user-explicit fact → reflection candidate same type+subject → MemoryStore.promoteCandidate() 直接拒绝
 *  C5   即使 ReflectionEngine 没有提前做 explicit guard，MemoryStore 仍然不能覆盖 user-explicit fact
 *  C6   普通 reflection fact 仍然可以正常 promote
 *  C7   restart 后 suppression 和 explicit protection 仍然有效
 *  C8   现有 69 + 45 + 51 + 58 全部零回归（已在测试外层用脚本验证）
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../dist/services/memoryStore.js'

const STABLE_SALT = 'test-salt-d-agent-18'
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

function mkCandidate(overrides = {}) {
  return {
    id: overrides.id ?? '',
    proposedFact: {
      type: overrides.type ?? 'preference',
      subject: overrides.subject ?? 'subject_x',
      value: overrides.value ?? 'value_x',
    },
    confidence: overrides.confidence ?? 0.8,
    evidenceEpisodeIds: overrides.evidenceEpisodeIds ?? ['e1'],
    reason: overrides.reason ?? 'test',
    source: 'reflection',
    state: 'pending',
    ttlDays: 30,
    createdAt: Date.now(),
    ...overrides,
  }
}

// ── C1: queryCandidates(state/type/subject/limit) ────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c1-'))
  const store = createMemoryStore(mkConfig(dir))

  // 写入 5 个 candidate，2 个 promoted，1 个 rejected，2 个 pending
  for (let i = 0; i < 5; i++) {
    await store.appendCandidate(mkCandidate({ subject: 's1', evidenceEpisodeIds: [`e${i}`] }))
  }
  // promote 第一个
  const list1 = await store.queryCandidates({ state: 'pending' })
  await store.promoteCandidate(list1[0].id, 'auto-confidence-threshold')

  // reject 第二个
  const list2 = await store.queryCandidates({ state: 'pending' })
  await store.rejectCandidate(list2[0].id, 'manual')

  // 添加一个 type=habit 的 candidate
  await store.appendCandidate(mkCandidate({ subject: 's2', type: 'habit', evidenceEpisodeIds: ['ehabit'] }))

  // C1.1: state 过滤（5 初始 - 1 promoted - 1 rejected + 1 habit = 4 pending）
  const pending = await store.queryCandidates({ state: 'pending' })
  check('C1.1: state=pending 过滤', pending.length === 4)

  const promoted = await store.queryCandidates({ state: 'promoted' })
  check('C1.2: state=promoted 过滤', promoted.length === 1)

  // C1.3: type 过滤
  const habits = await store.queryCandidates({ type: 'habit' })
  check('C1.3: type=habit 过滤', habits.length === 1)

  // C1.4: subject 过滤
  const s1 = await store.queryCandidates({ subject: 's1' })
  check('C1.4: subject=s1 过滤', s1.length === 5)

  // C1.5: limit
  const limited = await store.queryCandidates({ limit: 2 })
  check('C1.5: limit=2 返回 2 条', limited.length === 2)

  const limitDefault = await store.queryCandidates({})
  check('C1.6: 无 limit 默认上限 100（6 条全返回）', limitDefault.length === 6)

  // C1.7: limit 超过上限 1000 仍取上限
  const limitOver = await store.queryCandidates({ limit: 5000 })
  check('C1.7: limit=5000 上限 1000（6 条全返回）', limitOver.length === 6)

  // C1.8: limit=0 返回 0
  const limit0 = await store.queryCandidates({ limit: 0 })
  check('C1.8: limit=0 返回 0', limit0.length === 0)

  rmSync(dir, { recursive: true, force: true })
}

// ── C2: subject-level suppression ─────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c2-'))
  const store = createMemoryStore(mkConfig(dir))

  // 为 subject='alice' 创建 ForgetMarker（type=preference）
  await store.createForgetMarker('preference', 'alice')

  // C2.1: type-scoped isSuppressed 仍存在
  const suppressedPref = await store.isSuppressed('preference', 'alice')
  check('C2.1: isSuppressed(preference, alice) === true', suppressedPref === true)

  // C2.2: 不同 type 不被 type-scoped 抑制
  const habitNotSupp = await store.isSuppressed('habit', 'alice')
  check('C2.2: isSuppressed(habit, alice) === false（type-scoped）', habitNotSupp === false)

  // C2.3: subject-only 抑制 —— 任何 type 都 true
  const subjectSuppressed = await store.isSubjectSuppressed('alice')
  check('C2.3: isSubjectSuppressed(alice) === true（subject-level）', subjectSuppressed === true)

  // C2.4: 未被 forget 的 subject 返回 false
  const other = await store.isSubjectSuppressed('bob')
  check('C2.4: isSubjectSuppressed(bob) === false', other === false)

  // C2.5: 大小写不敏感（lower(subject) 语义）
  const upperCase = await store.isSubjectSuppressed('ALICE')
  check('C2.5: isSubjectSuppressed(ALICE) === true（大小写不敏感）', upperCase === true)

  rmSync(dir, { recursive: true, force: true })
}

// ── C3: forget subject A → candidate type B → promote 被拒绝 ────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c3-'))
  const store = createMemoryStore(mkConfig(dir))

  // 1. forget subject='dan' type=preference
  await store.createForgetMarker('preference', 'dan')

  // 2. 写入 type=habit subject=dan 的 candidate（type 不同）
  const candidate = mkCandidate({ subject: 'dan', type: 'habit', confidence: 0.95 })
  await store.appendCandidate(candidate)
  const list = await store.queryCandidates({ state: 'pending', subject: 'dan' })
  const cid = list[0]?.id

  // 3. 直接调用 MemoryStore.promoteCandidate —— 应被 subject-level gate 拒绝
  let errMsg = ''
  try {
    await store.promoteCandidate(cid, 'auto-confidence-threshold')
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err)
  }
  check('C3.1: promote 抛错（subject suppressed）', errMsg.includes('ForgetMarker'))
  check('C3.2: 错误信息包含 subject=dan', errMsg.includes('dan'))

  const after = await store.queryCandidates({})
  const c = after.find((x) => x.id === cid)
  check('C3.3: candidate state=rejected', c?.state === 'rejected')
  check('C3.4: rejectedReason=suppressed-by-forget-marker',
    c?.rejectedReason === 'suppressed-by-forget-marker')

  const facts = await store.queryFacts({ subject: 'dan' })
  check('C3.5: LongMemoryFact 未创建', facts.length === 0)

  rmSync(dir, { recursive: true, force: true })
}

// ── C4: user-explicit fact → reflection candidate → promote 被拒绝 ────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c4-'))
  const store = createMemoryStore(mkConfig(dir))

  // 1. user-explicit 写入
  await store.upsertFact({
    id: '',
    type: 'preference',
    subject: 'eve',
    value: 'user_value',
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

  // 2. reflection candidate 同样 (type, subject)
  const candidate = mkCandidate({
    subject: 'eve',
    type: 'preference',
    value: 'reflection_value',
    confidence: 0.95,
  })
  await store.appendCandidate(candidate)
  const list = await store.queryCandidates({ state: 'pending', subject: 'eve' })
  const cid = list[0]?.id

  // 3. 直接调 promoteCandidate
  let errMsg = ''
  try {
    await store.promoteCandidate(cid, 'auto-confidence-threshold')
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err)
  }
  check('C4.1: promote 抛错（user-explicit 冲突）', errMsg.includes('user-explicit'))
  check('C4.2: 错误信息包含 subject=eve', errMsg.includes('eve'))

  const after = await store.queryCandidates({})
  const c = after.find((x) => x.id === cid)
  check('C4.3: candidate state=rejected', c?.state === 'rejected')
  check('C4.4: rejectedReason=user-explicit-fact-exists',
    c?.rejectedReason === 'user-explicit-fact-exists')

  const facts = await store.queryFacts({ subject: 'eve' })
  check('C4.5: user-explicit fact 未被覆盖', facts.length === 1)
  check('C4.6: value 仍为 user_value', facts[0]?.value === 'user_value')

  rmSync(dir, { recursive: true, force: true })
}

// ── C5: 即使 ReflectionEngine 没有提前做 explicit guard，MemoryStore 仍拒绝 ──
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c5-'))
  const store = createMemoryStore(mkConfig(dir))

  // 1. user-explicit fact
  await store.upsertFact({
    id: '',
    type: 'preference',
    subject: 'frank',
    value: 'original',
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

  // 2. 模拟 reflection candidate 直接调 promote（绕过 ReflectionEngine guard）
  const candidate = mkCandidate({ subject: 'frank', type: 'preference', confidence: 0.9 })
  await store.appendCandidate(candidate)
  const cid = (await store.queryCandidates({ state: 'pending', subject: 'frank' }))[0]?.id

  // 3. 直接 promote
  let threw = false
  try {
    await store.promoteCandidate(cid, 'auto-confidence-threshold')
  } catch {
    threw = true
  }
  check('C5.1: 即使绕过 ReflectionEngine guard，promote 仍被拒绝', threw)

  // 4. user-explicit fact 应保持原值
  const facts = await store.queryFacts({ subject: 'frank' })
  check('C5.2: user-explicit fact 数量 = 1', facts.length === 1)
  check('C5.3: value 未被覆盖', facts[0]?.value === 'original')
  check('C5.4: source 仍 user-explicit', facts[0]?.source === 'user-explicit')

  rmSync(dir, { recursive: true, force: true })
}

// ── C6: 普通 reflection fact 仍可正常 promote ────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c6-'))
  const store = createMemoryStore(mkConfig(dir))

  // 无 user-explicit fact，无 ForgetMarker
  const candidate = mkCandidate({ subject: 'grace', type: 'habit', confidence: 0.9 })
  await store.appendCandidate(candidate)
  const cid = (await store.queryCandidates({ state: 'pending', subject: 'grace' }))[0]?.id

  const fact = await store.promoteCandidate(cid, 'auto-confidence-threshold')
  check('C6.1: promote 返回 fact', !!fact)
  check('C6.2: fact subject=grace', fact.subject === 'grace')
  check('C6.3: fact type=habit', fact.type === 'habit')
  check('C6.4: fact source=reflection', fact.source === 'reflection')

  const after = await store.queryCandidates({})
  const c = after.find((x) => x.id === cid)
  check('C6.5: candidate state=promoted', c?.state === 'promoted')
  check('C6.6: promotedFactId 指向 fact.id', c?.promotedFactId === fact.id)

  rmSync(dir, { recursive: true, force: true })
}

// ── C7: restart 后 suppression 和 explicit protection 仍有效 ──────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c7-'))
  const config = mkConfig(dir)

  // 写入 user-explicit fact + ForgetMarker
  {
    const store = createMemoryStore(config)
    await store.createForgetMarker('preference', 'henry')
    await store.upsertFact({
      id: '',
      type: 'preference',
      subject: 'isaac',
      value: 'user_value',
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
  }

  // restart
  {
    const store2 = createMemoryStore(config)

    // C7.1: subject-level suppression 持久化
    const henrySuppressed = await store2.isSubjectSuppressed('henry')
    check('C7.1: restart 后 isSubjectSuppressed(henry) 仍 true', henrySuppressed === true)

    // C7.2: restart 后 promotion 仍受 MemoryStore invariant 保护
    const candidate1 = mkCandidate({ subject: 'henry', type: 'habit' })
    await store2.appendCandidate(candidate1)
    const cid1 = (await store2.queryCandidates({ state: 'pending', subject: 'henry' }))[0]?.id

    let threw1 = false
    try {
      await store2.promoteCandidate(cid1, 'auto-confidence-threshold')
    } catch {
      threw1 = true
    }
    check('C7.2: restart 后 henry promote 仍被拒绝', threw1)

    // C7.3: restart 后 user-explicit 保护
    const candidate2 = mkCandidate({ subject: 'isaac', type: 'preference' })
    await store2.appendCandidate(candidate2)
    const cid2 = (await store2.queryCandidates({ state: 'pending', subject: 'isaac' }))[0]?.id

    let threw2 = false
    try {
      await store2.promoteCandidate(cid2, 'auto-confidence-threshold')
    } catch {
      threw2 = true
    }
    check('C7.3: restart 后 isaac promote 仍被拒绝（user-explicit 冲突）', threw2)

    // C7.4: restart 后 user-explicit fact 仍存在且未被覆盖
    const facts = await store2.queryFacts({ subject: 'isaac' })
    check('C7.4: restart 后 user-explicit fact 持久化', facts.length === 1)
    check('C7.5: value 未变', facts[0]?.value === 'user_value')
  }

  rmSync(dir, { recursive: true, force: true })
}

// ── C8: 现有 contract 零回归（快速 API smoke） ──────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c8-'))
  const store = createMemoryStore(mkConfig(dir))

  // CRUD 基本
  const f = await store.upsertFact({
    id: '', type: 'fact', subject: 'j', value: 'v',
    confidence: 0.9, source: 'user-explicit', state: 'active',
    representativeEvidenceIds: [], evidenceCount: 1,
    createdAt: Date.now(), updatedAt: Date.now(), createdBy: 'user-explicit', privacyLevel: 'L1',
  })
  check('C8.1: upsertFact 返回 fact', !!f.id)
  const found = await store.getFact(f.id)
  check('C8.2: getFact 找到', found?.id === f.id)

  // forget
  await store.forgetFact(f.id)
  const forgotten = await store.getFact(f.id)
  check('C8.3: forgetFact 后 getFact 返回 undefined', forgotten === undefined)

  // Episode CRUD
  await store.appendEpisode({
    id: 'ep1', category: 'message', kind: 'message.burst',
    summary: 's', ts: Date.now(), entities: ['a'],
    sourceEventIds: ['e1'], importance: 'normal', ttlDays: 7, state: 'active',
  })
  const eps = await store.getRecentEpisodes(5)
  check('C8.4: appendEpisode + getRecentEpisodes', eps.length === 1)

  // Candidate 全流程
  const c = mkCandidate({ subject: 'k' })
  await store.appendCandidate(c)
  const cid = (await store.queryCandidates({ state: 'pending', subject: 'k' }))[0]?.id
  await store.promoteCandidate(cid, 'auto-confidence-threshold')
  const candidateAfter = (await store.queryCandidates({ subject: 'k' }))[0]
  check('C8.5: candidate 完整 promote 流程', candidateAfter?.state === 'promoted')

  rmSync(dir, { recursive: true, force: true })
}

// ── 结果 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-d-agent-18 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-d-agent-18 失败 ${failed.length} 项`)
}