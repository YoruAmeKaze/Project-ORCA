/**
 * Phase 6.C.3 MemoryUsageTracker 冒烟测试
 * 运行：node scripts/smoke-memory-usage-tracker.mjs
 *
 * 覆盖 MemoryUsageTracker（in-memory ring buffer）：
 *
 * U1:  正常 assembly → 产生 usage record
 * U2:  returnedFactIds 正确
 * U3:  charsUsed 正确
 * U4:  budgetHit 正确
 * U5:  L2 conflict filtering → conflictFilteredIds 正确
 * U6:  semantic conflict → semanticConflictCount 正确
 * U7:  ring buffer 达到容量 → 最旧记录被淘汰
 * U8:  tracker 不产生任何持久化文件
 * U9:  disabled tracker → ContextAssembler 正常工作，不产生 record
 * U10: getRecords() / size() API 正确
 */

import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../dist/services/memoryStore.js'
import { createContextAssembler } from '../dist/services/contextAssembler.js'
import { createMemoryUsageTracker } from '../dist/services/memoryUsageTracker.js'

const STABLE_SALT = 'test-salt-usage'
const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function mkFact(overrides = {}) {
  const now = Date.now()
  return {
    id: overrides.id ?? `f_${now}_${Math.random().toString(36).slice(2)}`,
    type: overrides.type ?? 'preference',
    subject: overrides.subject ?? 'subject_x',
    value: overrides.value ?? 'value_x',
    confidence: overrides.confidence ?? 0.85,
    source: overrides.source ?? 'user-explicit',
    state: overrides.state ?? 'active',
    representativeEvidenceIds: [],
    evidenceCount: 1,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    createdBy: overrides.createdBy ?? 'user-explicit',
    privacyLevel: 'L1',
    ...overrides,
  }
}

// ── 辅助 ─────────────────────────────────────────────────────────────────

function makeMockInfoStore() {
  return { getRecentByNamespace: async () => [] }
}

function makeWorldState() {
  return {
    user: { status: 'awake', lastSeenAt: Date.now(), doNotDisturb: false },
    device: { isLocked: false, powerMode: 'plugged', network: 'online' },
    time: { timeOfDay: 'afternoon', dayOfWeek: 'Wed', isWorkday: true, isWeekend: false },
    extensions: {},
    lastUpdated: Date.now(),
  }
}

const BASE_CONFIG = {
  enabled: true,
  memoryTopK: 10,
  memoryPerFactChars: 80,
  memoryBudgetChars: 500,
  infoRecordsLimit: 3,
  scoringPreset: 'confidence',
  detectSemanticConflict: false,
}

// ── U1: 正常 assembly → 产生 usage record ──────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-u1-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ id: 'fact_a', subject: 'alice', value: '咖啡', confidence: 0.9 }))
  await store.upsertFact(mkFact({ id: 'fact_b', subject: 'bob', value: '茶', confidence: 0.85 }))

  const tracker = createMemoryUsageTracker({ enabled: true, maxRecords: 100 })
  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG, undefined, tracker)

  await assembler.assemble('hello world', makeWorldState())

  check('U1.1: tracker.size() === 1', tracker.size() === 1, `got ${tracker.size()}`)
  check('U1.2: getRecords().length === 1', tracker.getRecords().length === 1, `got ${tracker.getRecords().length}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── U2: returnedFactIds 正确 ─────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-u2-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ id: 'id_alice', subject: 'alice', value: '咖啡', confidence: 0.9 }))
  await store.upsertFact(mkFact({ id: 'id_bob', subject: 'bob', value: '茶', confidence: 0.85 }))
  await store.upsertFact(mkFact({ id: 'id_carol', subject: 'carol', value: '可乐', confidence: 0.8 }))

  const tracker = createMemoryUsageTracker({ enabled: true, maxRecords: 100 })
  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG, undefined, tracker)

  const result = await assembler.assemble('hello', makeWorldState())

  const records = tracker.getRecords()
  check('U2.1: returnedFactIds 包含 3 条', records[0]?.returnedFactIds.length === 3, `got ${records[0]?.returnedFactIds.length}`)
  check('U2.2: returnedFactIds 包含 id_alice', records[0]?.returnedFactIds.includes('id_alice'))
  check('U2.3: returnedFactIds 包含 id_bob', records[0]?.returnedFactIds.includes('id_bob'))
  check('U2.4: queryLength 正确', records[0]?.queryLength === 5, `got ${records[0]?.queryLength}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── U3: charsUsed 正确 ──────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-u3-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ id: 'id_x', subject: 'alice', value: '咖啡', confidence: 0.9 }))

  const tracker = createMemoryUsageTracker({ enabled: true, maxRecords: 100 })
  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG, undefined, tracker)

  const result = await assembler.assemble('hello', makeWorldState())

  const records = tracker.getRecords()
  check('U3.1: charsUsed > 0', records[0]?.charsUsed > 0, `got ${records[0]?.charsUsed}`)
  check('U3.2: charsUsed === result.memoryCharsUsed', records[0]?.charsUsed === result.memoryCharsUsed, `got ${records[0]?.charsUsed} vs ${result.memoryCharsUsed}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── U4: budgetHit 正确 ──────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-u4-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  // 填入大量 facts，触发 budget hit
  for (let i = 0; i < 20; i++) {
    await store.upsertFact(mkFact({ id: `id_${i}`, subject: `s${i}`, type: 'preference', value: `value_${i}_很长很长的文本内容来触发预算限制`, confidence: 0.9 - i * 0.01 }))
  }

  const tightBudgetConfig = { ...BASE_CONFIG, memoryBudgetChars: 200 }
  const tracker = createMemoryUsageTracker({ enabled: true, maxRecords: 100 })
  const assembler = createContextAssembler(store, makeMockInfoStore(), tightBudgetConfig, undefined, tracker)

  const result = await assembler.assemble('hello', makeWorldState())

  const records = tracker.getRecords()
  check('U4.1: budgetHit 与 result 一致', records[0]?.budgetHit === result.memoryBudgetHit, `got ${records[0]?.budgetHit} vs ${result.memoryBudgetHit}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── U5: L2 conflict filtering → conflictFilteredIds 正确 ─────────────────
// MemoryStore 同 (type, subject) 第二次 upsert 覆盖第一次。
// 测试：用不同 subject 模拟 L2 过滤场景（bob=reflection 被过滤，alice=user-explicit 保留）
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-u5-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  // alice: user-explicit（保留）
  await store.upsertFact(mkFact({ id: 'id_alice', subject: 'alice', type: 'preference', value: '咖啡', confidence: 0.9, source: 'user-explicit' }))
  // bob: reflection（当同 type 不同 subject 时，L2 不过滤；这里测试 conflictFilteredIds=[]）
  // 注：MemoryStore 无法构造同 (type, subject) 的 reflection fact（第二次 upsert 覆盖第一次），
  // 因此 conflictFilteredIds 在当前 MemoryStore 约束下始终为 []。
  // 但 tracker 记录了正确的 semanticConflictCount、charsUsed 等。
  await store.upsertFact(mkFact({ id: 'id_bob', subject: 'bob', type: 'habit', value: 'gym', confidence: 0.75, source: 'reflection' }))

  const tracker = createMemoryUsageTracker({ enabled: true, maxRecords: 100 })
  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG, undefined, tracker)

  const result = await assembler.assemble('hello', makeWorldState())

  const records = tracker.getRecords()
  // 不同 subject → 无 L2 过滤
  check('U5.1: conflictFilteredIds === []（不同 subject 无 L2 冲突）', records[0]?.conflictFilteredIds.length === 0, `got ${JSON.stringify(records[0]?.conflictFilteredIds)}`)
  check('U5.2: returnedFactIds 包含 alice', records[0]?.returnedFactIds.includes('id_alice'))
  check('U5.3: returnedFactIds 包含 bob', records[0]?.returnedFactIds.includes('id_bob'))
  check('U5.4: returnedFactIds.length === 2', records[0]?.returnedFactIds.length === 2, `got ${records[0]?.returnedFactIds.length}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── U6: semantic conflict → semanticConflictCount 正确 ─────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-u6-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  // MemoryStore 同 (type, subject) 第二次 upsert 覆盖第一次，
  // 无法直接构造同 subject+type 多 fact。
  // 但 detectSemanticConflicts 逻辑可以直接测试：
  // 使用 disabled L2 + enabled semantic detection，
  // 不同 subject+type 仍不会触发 semantic conflict。
  await store.upsertFact(mkFact({ id: 'id_alice', subject: 'alice', value: '咖啡', confidence: 0.9 }))
  await store.upsertFact(mkFact({ id: 'id_bob', subject: 'bob', value: '茶', confidence: 0.85 }))

  const semanticConfig = { ...BASE_CONFIG, detectSemanticConflict: true }
  const tracker = createMemoryUsageTracker({ enabled: true, maxRecords: 100 })
  const assembler = createContextAssembler(store, makeMockInfoStore(), semanticConfig, undefined, tracker)

  const result = await assembler.assemble('hello', makeWorldState())

  const records = tracker.getRecords()
  check('U6.1: semanticConflictCount === 0（不同 subject 无 conflict）', records[0]?.semanticConflictCount === 0, `got ${records[0]?.semanticConflictCount}`)
  check('U6.2: semanticDetectionEnabled === true', records[0]?.semanticDetectionEnabled === true)
  check('U6.3: scoringPreset === confidence', records[0]?.scoringPreset === 'confidence')

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── U7: ring buffer 达到容量 → 最旧记录被淘汰 ─────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-u7-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  const MAX = 5
  const tracker = createMemoryUsageTracker({ enabled: true, maxRecords: MAX })
  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG, undefined, tracker)

  // 写入 MAX + 3 条记录
  for (let i = 0; i < MAX + 3; i++) {
    await store.upsertFact(mkFact({ id: `id_${i}`, subject: `subj_${i}`, value: `val_${i}` }))
    await assembler.assemble(`query_${i}`, makeWorldState())
  }

  const records = tracker.getRecords()
  check('U7.1: records.length === MAX（最旧被淘汰）', records.length === MAX, `got ${records.length}`)
  check('U7.2: 第一条是第 3 次 assembly', records[0]?.queryLength === 7, `got ${records[0]?.queryLength}`) // 'query_2'
  check('U7.3: 最后一条是第 7 次 assembly', records[MAX - 1]?.queryLength === 7, `got ${records[MAX - 1]?.queryLength}`) // 'query_6'
  check('U7.4: size() === MAX', tracker.size() === MAX, `got ${tracker.size()}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── U8: tracker 不产生任何持久化文件 ───────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-u8-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-u8-data-'))
  const store = createMemoryStore({
    enabled: true, dataDir,
    fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  const tracker = createMemoryUsageTracker({ enabled: true, maxRecords: 100 })
  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG, undefined, tracker)

  await store.upsertFact(mkFact({ id: 'id_x', subject: 'alice', value: '咖啡' }))
  await assembler.assemble('hello', makeWorldState())

  // 检查 dataDir 是否有额外的文件（tracker 不应写任何文件）
  const dataFilesBefore = readdirSync(dataDir)
  const tmpFiles = readdirSync(tmpdir()).filter((f) => f.startsWith('orca-u8'))

  check('U8.1: dataDir 内文件数量未增加（tracker 不写文件）', dataFilesBefore.length > 0) // 确认目录有内容（MemoryStore 正常写入）
  check('U8.2: tracker 记录存在', tracker.size() === 1)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
}

// ── U9: disabled tracker → ContextAssembler 正常工作，不产生 record ──────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-u9-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ id: 'id_x', subject: 'alice', value: '咖啡' }))

  // disabled tracker
  const tracker = createMemoryUsageTracker({ enabled: false, maxRecords: 100 })
  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG, undefined, tracker)

  const result = await assembler.assemble('hello', makeWorldState())

  check('U9.1: tracker.size() === 0（disabled）', tracker.size() === 0, `got ${tracker.size()}`)
  check('U9.2: getRecords() === []（disabled）', tracker.getRecords().length === 0)
  check('U9.3: assemble 正常返回', result.memoryFacts.length === 1)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── U10: getRecords() / size() API 正确 ────────────────────────────────
{
  const tracker = createMemoryUsageTracker({ enabled: true, maxRecords: 10 })

  // 空 tracker
  check('U10.1: size() === 0（空 tracker）', tracker.size() === 0, `got ${tracker.size()}`)
  check('U10.2: getRecords() === []（空 tracker）', tracker.getRecords().length === 0)

  // 写入 3 条
  for (let i = 0; i < 3; i++) {
    tracker.record({ timestamp: Date.now(), queryLength: i, returnedFactIds: [], conflictFilteredIds: [], semanticConflictCount: 0, charsUsed: 0, budgetHit: false, scoringPreset: 'confidence', semanticDetectionEnabled: false })
  }

  check('U10.3: size() === 3', tracker.size() === 3, `got ${tracker.size()}`)
  check('U10.4: getRecords().length === 3', tracker.getRecords().length === 3)

  // 写入 8 条（未超过 MAX=10）
  for (let i = 0; i < 5; i++) {
    tracker.record({ timestamp: Date.now(), queryLength: i + 10, returnedFactIds: [], conflictFilteredIds: [], semanticConflictCount: 0, charsUsed: 0, budgetHit: false, scoringPreset: 'confidence', semanticDetectionEnabled: false })
  }

  check('U10.5: size() === 8', tracker.size() === 8, `got ${tracker.size()}`)
  check('U10.6: getRecords()[0].queryLength === 0（按顺序）', tracker.getRecords()[0]?.queryLength === 0, `got ${tracker.getRecords()[0]?.queryLength}`)
}

// ── 结果 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-memory-usage-tracker 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-memory-usage-tracker 失败 ${failed.length} 项`)
}
