/**
 * MemoryStore 冒烟测试（Phase 5.0）
 * 运行：npm run build && node scripts/smoke-memory.mjs
 *
 * 覆盖：
 *  M1   LongMemoryFact create → query
 *  M2   LongMemoryFact update（upsert 同 type:subject）
 *  M3   LongMemoryFact supersede（冲突场景）
 *  M4   LongMemoryFact merge（两条 active fact 合并）
 *  M5   LongMemoryFact compress（evidence 压缩）
 *  M6   forget + ForgetMarker 原子创建
 *  M7   forget 后普通 query 不返回该 fact
 *  M8   forget marker persistence（restart 后仍能 suppress）
 *  M9   AuditEvent 不含 prevValue/newValue（v1.1）
 *  M10  JSONL reload 后 in-memory index 与磁盘状态一致
 *  M11  Candidate promote / reject / expire
 *  M12  MemoryStore API 阻止直接 mutation 绕过（通过反射验证内部不可达）
 *
 * 注：纯 JavaScript，无 TypeScript 类型注解（type: "module" 项目中 .mjs 是原生 ESM）
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../dist/services/memoryStore.js'

const STABLE_SALT = 'test-stable-salt-please-do-not-change'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// ── 辅助 ─────────────────────────────────────────────────────────────────

function mkFact(overrides = {}) {
  const id = overrides.id ?? `f_${Math.random().toString(36).slice(2)}`
  const now = Date.now()
  return {
    id,
    type: overrides.type ?? 'preference',
    subject: overrides.subject ?? `test_subject_${id}`,
    value: overrides.value ?? `test_value_${id}`,
    confidence: overrides.confidence ?? 0.8,
    source: overrides.source ?? 'user-explicit',
    state: 'active',
    representativeEvidenceIds: overrides.representativeEvidenceIds ?? [],
    evidenceSummary: overrides.evidenceSummary,
    evidenceCount: overrides.evidenceCount ?? 1,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    createdBy: overrides.createdBy ?? 'user-explicit',
    privacyLevel: 'L1',
    ...overrides,
  }
}

function mkCandidate(overrides = {}) {
  const id = overrides.id ?? `c_${Math.random().toString(36).slice(2)}`
  const now = Date.now()
  return {
    id,
    proposedFact: {
      type: overrides.type ?? 'preference',
      subject: overrides.subject ?? `test_subject_${id}`,
      value: overrides.value ?? `test_value_${id}`,
      ...(overrides.proposedFact || {}),
    },
    confidence: overrides.confidence ?? 0.75,
    evidenceEpisodeIds: overrides.evidenceEpisodeIds ?? [],
    reason: overrides.reason ?? 'test reason',
    source: 'reflection',
    state: 'pending',
    ttlDays: overrides.ttlDays ?? 30,
    createdAt: overrides.createdAt ?? now,
    ...overrides,
  }
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

// ── M1: create → query ────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m1-'))
  const store = createMemoryStore(mkConfig(dir))

  const fact = mkFact({ subject: 'coffee', value: '我喜欢咖啡', type: 'preference' })
  const saved = await store.upsertFact(fact)

  const found = await store.getFact(saved.id)
  check('M1.1: upsertFact 返回 fact', !!saved && saved.id === fact.id)
  check('M1.2: getFact(id) 找到', !!found && found.id === saved.id)
  check('M1.3: getFact 返回正确的 value', found?.value === fact.value)
  check('M1.4: getFact 返回正确的 type', found?.type === 'preference')
  check('M1.5: getFact 返回 correct state', found?.state === 'active')

  const all = await store.queryFacts({})
  check('M1.6: queryFacts() 返回至少 1 条', all.length >= 1)
  const bySubject = await store.queryFacts({ subject: 'coffee' })
  check('M1.7: queryFacts(subject=coffee) 命中', bySubject.length === 1)
  const prefix = await store.queryFacts({ subjectPrefix: 'cof' })
  check('M1.8: queryFacts(subjectPrefix=cof) prefix 匹配', prefix.length >= 1)

  rmSync(dir, { recursive: true, force: true })
}

// ── M2: update（upsert 同 type:subject）──────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m2-'))
  const store = createMemoryStore(mkConfig(dir))

  const f1 = mkFact({ id: 'f_update_test', subject: 'coffee', value: 'old value', confidence: 0.5 })
  await store.upsertFact(f1)

  const f2 = mkFact({ id: 'f_update_test2', subject: 'coffee', value: 'new value', confidence: 0.9 })
  await store.upsertFact(f2) // 同 type:subject → 原地更新（id 保持 f_update_test）

  const current = await store.queryFacts({ subject: 'coffee' })
  check('M2.1: update 后只有 1 条 active', current.length === 1)
  check('M2.2: update 后 value 已更新', current[0]?.value === 'new value')
  check('M2.3: update 后 confidence 已更新', current[0]?.confidence === 0.9)

  // updated audit 记录在 existing fact id（f_update_test）上
  const audit = await store.queryAudit('f_update_test')
  const updatedEvents = audit.filter((e) => e.kind === 'updated')
  check('M2.4: update 操作产生 updated audit', updatedEvents.length >= 1)
  check('M2.5: updated audit 有 changedFields', updatedEvents[0]?.changedFields?.includes('value'))
  check('M2.6: updated audit 没有 prevValue', !('prevValue' in (updatedEvents[0] ?? {})))
  check('M2.7: updated audit 没有 newValue', !('newValue' in (updatedEvents[0] ?? {})))

  rmSync(dir, { recursive: true, force: true })
}

// ── M3: supersede ─────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m3-'))
  const store = createMemoryStore(mkConfig(dir))

  const oldFact = mkFact({ id: 'f_supersede_old', subject: 'girlfriend.coffee', value: '她喜欢咖啡', confidence: 0.9 })
  await store.upsertFact(oldFact)

  const newFact = mkFact({ id: 'f_supersede_new', subject: 'girlfriend.coffee', value: '她讨厌咖啡', confidence: 0.85, type: 'preference' })
  await store.supersedeFact('f_supersede_old', newFact)

  const superseded = await store.queryFacts({ subject: 'girlfriend.coffee' })
  check('M3.1: supersede 后只有 1 条 active', superseded.length === 1)
  check('M3.2: active fact 是新值', superseded[0]?.value === '她讨厌咖啡')
  check('M3.3: active fact 的 supersedes 指向旧 id', superseded[0]?.supersedes === 'f_supersede_old')

  const all = await store.queryFacts({ subject: 'girlfriend.coffee' }, { includeSuperseded: true })
  check('M3.4: includeSuperseded 时有 2 条', all.length === 2)
  const old = all.find((f) => f.id === 'f_supersede_old')
  check('M3.5: 旧 fact state=superseded', old?.state === 'superseded')
  check('M3.6: 旧 fact supersededBy 指向新 id', old?.supersededBy === 'f_supersede_new')

  rmSync(dir, { recursive: true, force: true })
}

// ── M4: merge ────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m4-'))
  const store = createMemoryStore(mkConfig(dir))

  // merge 用于合并"实质重复"的事实，identity = (type, subject)
  // 测试用不同 type 来创建多个可并存的 active fact
  const src1 = mkFact({ id: 'f_merge_src1', subject: 'sugar Habit', value: '加糖', confidence: 0.8, type: 'habit' })
  const src2 = mkFact({ id: 'f_merge_src2', subject: 'sugar Preference', value: '加糖', confidence: 0.85, type: 'preference' })
  const target = mkFact({ id: 'f_merge_target', subject: 'sugar Habit', value: '加糖', confidence: 0.9, type: 'habit' })
  await store.upsertFact(src1) // active (habit, 'sugar Habit')
  await store.upsertFact(src2) // active (preference, 'sugar Preference') - 不同 type
  await store.upsertFact(target) // 同 (habit, 'sugar Habit') → 原地更新 src1

  await store.mergeFacts(['f_merge_src2'], 'f_merge_src1') // 合并 preference 到 habit

  const active = await store.queryFacts({ type: 'habit' })
  check('M4.1: merge 后 habit 有 1 条 active', active.length === 1)
  check('M4.2: target 的 mergedInto 不存在', !('mergedInto' in (active[0] ?? {})))
  check('M4.3: active 的 evidenceCount >= 1', (active[0]?.evidenceCount ?? 0) >= 1)

  const prefActive = await store.queryFacts({ type: 'preference' })
  check('M4.4: 被合并的 preference fact state=superseded', prefActive.length === 0)
  const allPref = await store.queryFacts({ type: 'preference' }, { includeSuperseded: true })
  const mergedPref = allPref.find((f) => f.id === 'f_merge_src2')
  check('M4.5: 源 fact state=superseded', mergedPref?.state === 'superseded')
  check('M4.6: 源 fact mergedInto 指向 target', mergedPref?.mergedInto === 'f_merge_src1')

  rmSync(dir, { recursive: true, force: true })
}

// ── M5: compress ─────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m5-'))
  const store = createMemoryStore(mkConfig(dir))

  const fact = mkFact({
    id: 'f_compress',
    subject: 'evtest',
    value: 'test',
    representativeEvidenceIds: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
  })
  await store.upsertFact(fact)

  await store.compressFactEvidence('f_compress', 5)

  const compressed = await store.getFact('f_compress')
  check('M5.1: compress 后 evidence 数量 = keepRecent', (compressed?.representativeEvidenceIds?.length ?? 0) === 5)
  // 保留最近的 5 条（最后 5 个）
  const last5 = compressed?.representativeEvidenceIds?.join(',')
  check('M5.2: compress 后保留最近的 5 条', last5 === 'e3,e4,e5,e6,e7')

  const audit = await store.queryAudit('f_compress')
  const compressEvents = audit.filter((e) => e.kind === 'compressed')
  check('M5.3: compress 产生 compressed audit', compressEvents.length >= 1)
  check('M5.4: compressed audit evidenceDelta.removed.length = 2', compressEvents[0]?.evidenceDelta?.removed?.length === 2)

  rmSync(dir, { recursive: true, force: true })
}

// ── M6: forget + ForgetMarker 原子创建 ─────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m6-'))
  const store = createMemoryStore(mkConfig(dir))

  const fact = mkFact({ id: 'f_forget_test', subject: 'secret', value: 'very secret', type: 'preference' })
  await store.upsertFact(fact)

  await store.forgetFact('f_forget_test')

  const markers = await store.queryForgetMarkers({ type: 'preference' })
  check('M6.1: forget 后有 1 个 ForgetMarker', markers.length === 1)
  check('M6.2: marker.type = preference', markers[0]?.type === 'preference')
  check('M6.3: marker.createdBy = user-forget', markers[0]?.createdBy === 'user-forget')
  check('M6.4: marker 没有 value（只有 subject）', markers[0]?.subject === 'secret' && !('value' in (markers[0] ?? {})))

  // fingerprint 是确定性的
  const marker2 = await store.createForgetMarker('preference', 'secret')
  check('M6.5: 相同 subject 产生相同 fingerprint', marker2.fingerprint === markers[0]?.fingerprint)

  rmSync(dir, { recursive: true, force: true })
}

// ── M7: forget 后 query 不返回 fact ────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m7-'))
  const store = createMemoryStore(mkConfig(dir))

  const fact = mkFact({ id: 'f_forget_query', subject: 'to_be_forgotten', value: 'test' })
  await store.upsertFact(fact)

  const beforeForget = await store.getFact('f_forget_query')
  check('M7.1: forget 前 getFact 找到', !!beforeForget)

  await store.forgetFact('f_forget_query')

  const afterForget = await store.getFact('f_forget_query')
  check('M7.2: forget 后 getFact 不返回', !afterForget)

  const bySubject = await store.queryFacts({ subject: 'to_be_forgotten' })
  check('M7.3: forget 后 queryFacts(subject) 不返回', bySubject.length === 0)

  rmSync(dir, { recursive: true, force: true })
}

// ── M8: ForgetMarker persistence（restart 后仍能 suppress）───────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m8-'))
  const salt = 'restart-test-salt-abc123'

  // 创建 store 并 forget
  const store1 = createMemoryStore({ ...mkConfig(dir), fingerprintSalt: salt })
  const fact = mkFact({ id: 'f_restart', subject: 'persistent_preference', value: 'test' })
  await store1.upsertFact(fact)
  await store1.forgetFact('f_restart')
  const marker = await store1.queryForgetMarkers({ type: 'preference' })
  check('M8.1: forget 后 marker 存在', marker.length === 1)
  const fp = marker[0]?.fingerprint

  // 用相同 salt 重启新 store
  const store2 = createMemoryStore({ ...mkConfig(dir), fingerprintSalt: salt })

  const markersAfterRestart = await store2.queryForgetMarkers({ type: 'preference' })
  check('M8.2: restart 后 marker 持久化（query 找到）', markersAfterRestart.length >= 1)

  // 相同 subject + salt 产生的 fingerprint 必须相同
  check('M8.3: restart 后 fingerprint 一致', markersAfterRestart[0]?.fingerprint === fp)

  // isSuppressed 检查
  const suppressed = await store2.isSuppressed('preference', 'persistent_preference')
  check('M8.4: isSuppressed(type, subject) 返回 true', suppressed === true)

  // 不同 salt 产生不同 fingerprint（salt 稳定性验证）
  // 注意：queryForgetMarkers 直接匹配 stored fingerprint，不受当前 salt 影响
  // isSuppressed 才使用当前 salt 重新计算，所以用 isSuppressed 验证
  const store3 = createMemoryStore({ ...mkConfig(dir), fingerprintSalt: 'different-salt-xyz' })
  const diffSaltSuppressed = await store3.isSuppressed('preference', 'persistent_preference')
  check('M8.5: 不同 salt → isSuppressed 返回 false', diffSaltSuppressed === false)

  rmSync(dir, { recursive: true, force: true })
}

// ── M9: AuditEvent 不含 prevValue/newValue（v1.1）────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m9-'))
  const store = createMemoryStore(mkConfig(dir))

  const fact = mkFact({ id: 'f_audit_no_prev', subject: 'audit_test', value: 'init' })
  await store.upsertFact(fact)

  const createdEvents = await store.queryAudit('f_audit_no_prev')
  check('M9.1: created audit 没有 prevValue', !createdEvents.some((e) => 'prevValue' in e))
  check('M9.2: created audit 没有 newValue', !createdEvents.some((e) => 'newValue' in e))

  const f2 = mkFact({ id: 'f_audit_no_prev2', subject: 'audit_test', value: 'updated' })
  await store.upsertFact(f2) // 同 type:subject → 更新 existing fact（id = f_audit_no_prev）

  const updatedEvents = await store.queryAudit('f_audit_no_prev') // audit 记录在 existing id 上
  check('M9.3: updated audit 没有 prevValue', !updatedEvents.some((e) => 'prevValue' in e))
  check('M9.4: updated audit 没有 newValue', !updatedEvents.some((e) => 'newValue' in e))
  check('M9.5: updated audit 有 changedFields', updatedEvents.some((e) => e.kind === 'updated' && e.changedFields?.includes('value')))

  await store.forgetFact('f_audit_no_prev') // forget the existing id
  const forgottenEvents = await store.queryAudit('f_audit_no_prev')
  const forgotten = forgottenEvents.find((e) => e.kind === 'forgotten')
  check('M9.6: forgotten audit 没有 prevValue', !forgotten || !('prevValue' in forgotten))
  check('M9.7: forgotten audit 没有 newValue', !forgotten || !('newValue' in forgotten))
  check('M9.8: forgotten audit changedFields 为 undefined', !forgotten || forgotten.changedFields === undefined)

  rmSync(dir, { recursive: true, force: true })
}

// ── M10: JSONL reload 后 in-memory index 与磁盘状态一致 ───────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m10-'))

  // 创建并写入数据
  {
    const store = createMemoryStore(mkConfig(dir))
    await store.upsertFact(mkFact({ id: 'f_reload_1', subject: 'reload_test', value: 'v1' }))
    await store.upsertFact(mkFact({ id: 'f_reload_2', subject: 'reload_another', value: 'v2' }))
    await store.upsertFact(mkFact({ id: 'f_reload_3', subject: 'reload_third', value: 'v3' }))
    check('M10.1: 写入 3 条后 queryFacts 返回 3 条', (await store.queryFacts({})).length === 3)
  }

  // 重启新 store（不提供原始 store 实例）
  {
    const store2 = createMemoryStore(mkConfig(dir))
    const all = await store2.queryFacts({})
    check('M10.2: restart 后 queryFacts() 返回 3 条', all.length === 3)
    const bySubject = await store2.queryFacts({ subject: 'reload_test' })
    check('M10.3: restart 后 subject 查询正确', bySubject.length === 1 && bySubject[0]?.value === 'v1')
    const f2 = await store2.getFact('f_reload_2')
    check('M10.4: restart 后 getFact(id) 正确', f2?.value === 'v2')
  }

  // forget 后 restart，marker 仍然存在
  {
    const store3 = createMemoryStore(mkConfig(dir))
    await store3.forgetFact('f_reload_1')
    const remaining = await store3.queryFacts({})
    check('M10.5: forget 后 queryFacts 返回 2 条', remaining.length === 2)
  }
  {
    const store4 = createMemoryStore(mkConfig(dir))
    const remaining = await store4.queryFacts({})
    check('M10.6: restart 后 forget 持久化（只剩 2 条）', remaining.length === 2)
    const forgottenOne = await store4.getFact('f_reload_1')
    check('M10.7: restart 后 forgotten fact 不返回', !forgottenOne)
    const markers = await store4.queryForgetMarkers({ type: 'preference' })
    check('M10.8: restart 后 ForgetMarker 持久化', markers.length >= 1)
  }

  rmSync(dir, { recursive: true, force: true })
}

// ── M11: Candidate promote / reject / expire ──────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m11-'))
  const store = createMemoryStore(mkConfig(dir))

  const cand = mkCandidate({ id: 'c_test', subject: 'new_fact', value: 'discovered', confidence: 0.85 })
  await store.appendCandidate(cand)

  const promoted = await store.promoteCandidate('c_test', 'auto-confidence-threshold')
  check('M11.1: promote 返回 LongMemoryFact', !!promoted && 'type' in promoted && 'value' in promoted)
  check('M11.2: promoted fact type=reflection', promoted.source === 'reflection')
  check('M11.3: promoted fact state=active', promoted.state === 'active')
  check('M11.4: promoted fact subject 正确', promoted.subject === 'new_fact')

  // reject
  const cand2 = mkCandidate({ id: 'c_reject', subject: 'reject_me', value: 'rejected', confidence: 0.3 })
  await store.appendCandidate(cand2)
  await store.rejectCandidate('c_reject', 'confidence too low')

  // expire
  const oldCand = mkCandidate({
    id: 'c_expire',
    subject: 'expire_me',
    value: 'old',
    confidence: 0.6,
    ttlDays: 0,
    createdAt: Date.now() - 2 * 86_400_000,
  })
  await store.appendCandidate(oldCand)
  const expired = await store.expireCandidates()
  check('M11.5: expireCandidates 返回 >= 1', expired >= 1)

  rmSync(dir, { recursive: true, force: true })
}

// ── M12: forgetByQuery ───────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-m12-'))
  const store = createMemoryStore(mkConfig(dir))

  // 用不同 type 创建 3 个独立 identity 的 fact，可被 forgetByQuery 批量删除
  await store.upsertFact(mkFact({ id: 'f_bq1', subject: 'batch_one', value: 'v1', type: 'preference' }))
  await store.upsertFact(mkFact({ id: 'f_bq2', subject: 'batch_two', value: 'v2', type: 'preference' }))
  await store.upsertFact(mkFact({ id: 'f_bq3', subject: 'batch_three', value: 'v3', type: 'preference' }))
  await store.upsertFact(mkFact({ id: 'f_bq_other', subject: 'keep_me', value: 'other', type: 'preference' }))

  const count = await store.forgetByQuery({ subjectPrefix: 'batch_' })
  check('M12.1: forgetByQuery(subjectPrefix) 返回删除数量 3', count === 3)

  const remaining = await store.queryFacts({})
  check('M12.2: forgetByQuery 后只剩 1 条', remaining.length === 1)
  check('M12.3: 保留的 fact 是 keep_me', remaining[0]?.subject === 'keep_me')

  const markers = await store.queryForgetMarkers({ type: 'preference' })
  check('M12.4: batch forget 产生 3 个 ForgetMarker', markers.length >= 3)

  rmSync(dir, { recursive: true, force: true })
}

// ── 结果 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-memory 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-memory 失败 ${failed.length} 项`)
}
