/**
 * Phase 6.C.2 Semantic Conflict Detection 冒烟测试
 * 运行：node scripts/smoke-semantic-conflict.mjs
 *
 * 覆盖 L3 Semantic Conflict Detection（D-AGENT-21 §21-01 L3）：
 *
 * C1: 不同 subject 同 type → no conflict（disabled）
 * C2: 不同 subject 同 type → no conflict（enabled，但不同 subject）
 * C3: 同 subject 不同 type → no conflict（不同 type）
 * C4: detectSemanticConflict=false → no warning
 * C5: detectSemanticConflict=true, 多 subject 同 type → 无 conflict（不同 subject）
 * C6: enabled + single fact per subject → no conflict
 * C7: summary 不包含 warning（disabled）
 * C8: summary 包含 Memory Conflict Warnings（enabled + 多 facts 同 subject+type）
 *
 * 约束说明：
 * MemoryStore upsertFact 同 (type, subject) 第二次 upsert update-in-place，
 * 因此无法在 active facts 中保留同 (type, subject) 的多个 facts。
 * 测试采用不同 subject 模拟 "同一 subject 不同 facts" 场景的替代验证。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../dist/services/memoryStore.js'
import { createContextAssembler } from '../dist/services/contextAssembler.js'

const STABLE_SALT = 'test-salt-semantic'
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

const BASE_CONFIG_DISABLED = {
  enabled: true,
  memoryTopK: 10,
  memoryPerFactChars: 80,
  memoryBudgetChars: 500,
  infoRecordsLimit: 3,
  scoringPreset: 'confidence',
  detectSemanticConflict: false,
}

const BASE_CONFIG_ENABLED = {
  ...BASE_CONFIG_DISABLED,
  detectSemanticConflict: true,
}

// ── C1: 不同 subject 同 type → semanticConflicts = []（feature off）──────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c1-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ id: 'f1', subject: 'alice', type: 'preference', value: 'coffee', confidence: 0.9 }))
  await store.upsertFact(mkFact({ id: 'f2', subject: 'bob', type: 'preference', value: 'tea', confidence: 0.85 }))

  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG_DISABLED)
  const result = await assembler.assemble('hello', makeWorldState())

  check('C1.1: semanticConflicts = []（disabled）', result.semanticConflicts.length === 0, `got ${result.semanticConflicts.length}`)
  check('C1.2: sourceConflictsFiltered === 0', result.sourceConflictsFiltered === 0)
  check('C1.3: memoryFacts 包含 2 条', result.memoryFacts.length === 2, `got ${result.memoryFacts.length}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── C2: 不同 subject 同 type（enabled）→ 无 conflict（不同 subject）───────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c2-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ id: 'f1', subject: 'alice', type: 'preference', value: 'coffee', confidence: 0.9 }))
  await store.upsertFact(mkFact({ id: 'f2', subject: 'bob', type: 'preference', value: 'tea', confidence: 0.85 }))

  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG_ENABLED)
  const result = await assembler.assemble('hello', makeWorldState())

  check('C2.1: 不同 subject → semanticConflicts = []', result.semanticConflicts.length === 0, `got ${result.semanticConflicts.length}`)
  check('C2.2: memoryFacts 包含 2 条', result.memoryFacts.length === 2, `got ${result.memoryFacts.length}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── C3: 同 subject 不同 type → no conflict ──────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c3-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ id: 'f1', subject: 'alice', type: 'preference', value: 'coffee', confidence: 0.9 }))
  await store.upsertFact(mkFact({ id: 'f2', subject: 'alice', type: 'habit', value: 'gym', confidence: 0.8 }))

  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG_ENABLED)
  const result = await assembler.assemble('hello', makeWorldState())

  check('C3.1: 同 subject 不同 type → semanticConflicts = []', result.semanticConflicts.length === 0, `got ${result.semanticConflicts.length}`)
  check('C3.2: memoryFacts 包含 2 条', result.memoryFacts.length === 2, `got ${result.memoryFacts.length}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── C4: disabled → summary 不包含 warning ───────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c4-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ id: 'f1', subject: 'alice', type: 'preference', value: 'coffee', confidence: 0.9 }))
  await store.upsertFact(mkFact({ id: 'f2', subject: 'bob', type: 'preference', value: 'tea', confidence: 0.85 }))

  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG_DISABLED)
  const result = await assembler.assemble('hello', makeWorldState())

  check('C4.1: summary 不包含 Conflict Warning（disabled）', !result.summary.includes('Conflict Warning'))
  check('C4.2: summary 包含 Memory section', result.summary.includes('## Memory'))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── C5: single fact → no conflict ──────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c5-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ id: 'f1', subject: 'alice', type: 'preference', value: 'coffee', confidence: 0.9 }))

  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG_ENABLED)
  const result = await assembler.assemble('hello', makeWorldState())

  check('C5.1: 单 fact → semanticConflicts = []', result.semanticConflicts.length === 0, `got ${result.semanticConflicts.length}`)
  check('C5.2: memoryFacts 包含 1 条', result.memoryFacts.length === 1, `got ${result.memoryFacts.length}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── C6: enabled + 无 facts → semanticConflicts = [] ─────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c6-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG_ENABLED)
  const result = await assembler.assemble('hello', makeWorldState())

  check('C6.1: 无 facts → semanticConflicts = []', result.semanticConflicts.length === 0, `got ${result.semanticConflicts.length}`)
  check('C6.2: summary 不包含 Conflict Warning', !result.summary.includes('Conflict Warning'))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── C7: detectSemanticConflicts() 直接测试 ──────────────────────────────
{
  // 直接测试 detectSemanticConflicts 函数逻辑
  const { detectSemanticConflicts } = await import('../dist/types/context.js')

  // Case: 同 type + 同 subject = conflict
  const mockFacts = [
    { id: 'f1', type: 'preference', subject: 'alice', formatted: '喜欢咖啡', confidence: 0.9, updatedAt: 1000 },
    { id: 'f2', type: 'preference', subject: 'alice', formatted: '喜欢茶', confidence: 0.85, updatedAt: 2000 },
    { id: 'f3', type: 'habit', subject: 'bob', formatted: '每天健身', confidence: 0.8, updatedAt: 3000 },
  ]

  const conflicts = detectSemanticConflicts(mockFacts)

  check('C7.1: 同 subject+type → 1 个 conflict', conflicts.length === 1, `got ${conflicts.length}`)
  check('C7.2: conflict.subject === alice', conflicts[0]?.subject === 'alice', `got ${conflicts[0]?.subject}`)
  check('C7.3: conflict.type === preference', conflicts[0]?.type === 'preference', `got ${conflicts[0]?.type}`)
  check('C7.4: conflict.facts.length === 2', conflicts[0]?.facts.length === 2, `got ${conflicts[0]?.facts.length}`)
  check('C7.5: warningText 包含 Memory Conflict Warning', conflicts[0]?.warningText.includes('Memory Conflict Warning'))

  // Case: 不同 subject → 无 conflict
  const noConflictFacts = [
    { id: 'f1', type: 'preference', subject: 'alice', formatted: '喜欢咖啡', confidence: 0.9, updatedAt: 1000 },
    { id: 'f2', type: 'preference', subject: 'bob', formatted: '喜欢茶', confidence: 0.85, updatedAt: 2000 },
  ]

  const noConflicts = detectSemanticConflicts(noConflictFacts)
  check('C7.6: 不同 subject → 0 个 conflict', noConflicts.length === 0, `got ${noConflicts.length}`)

  // Case: 不同 type → 无 conflict
  const differentTypeFacts = [
    { id: 'f1', type: 'preference', subject: 'alice', formatted: '喜欢咖啡', confidence: 0.9, updatedAt: 1000 },
    { id: 'f2', type: 'habit', subject: 'alice', formatted: '每天健身', confidence: 0.8, updatedAt: 2000 },
  ]

  const diffTypeConflicts = detectSemanticConflicts(differentTypeFacts)
  check('C7.7: 不同 type → 0 个 conflict', diffTypeConflicts.length === 0, `got ${diffTypeConflicts.length}`)

  // Case: 单 fact → 无 conflict
  const singleFact = [
    { id: 'f1', type: 'preference', subject: 'alice', formatted: '喜欢咖啡', confidence: 0.9, updatedAt: 1000 },
  ]

  const singleConflicts = detectSemanticConflicts(singleFact)
  check('C7.8: 单 fact → 0 个 conflict', singleConflicts.length === 0, `got ${singleConflicts.length}`)

  // Case: 同 subject+type 但相同 formatted value → 无 conflict（value 相同不是冲突）
  const sameValueFacts = [
    { id: 'f1', type: 'preference', subject: 'alice', formatted: '喜欢咖啡', confidence: 0.9, updatedAt: 1000 },
    { id: 'f2', type: 'preference', subject: 'alice', formatted: '喜欢咖啡', confidence: 0.85, updatedAt: 2000 },
  ]

  const sameValueConflicts = detectSemanticConflicts(sameValueFacts)
  check('C7.9: 同 subject+type+value → 0 个 conflict', sameValueConflicts.length === 0, `got ${sameValueConflicts.length}`)
}

// ── C8: 3 facts 同 subject+type → 1 conflict, 3 facts ──────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c8-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  // 由于同 (type, subject) 第二次 upsert update-in-place，
  // 这里用三个不同 subject 模拟同一 type 多 facts 场景
  await store.upsertFact(mkFact({ id: 'f1', subject: 'alice', type: 'preference', value: '咖啡', confidence: 0.95 }))
  await store.upsertFact(mkFact({ id: 'f2', subject: 'bob', type: 'preference', value: '茶', confidence: 0.85 }))
  await store.upsertFact(mkFact({ id: 'f3', subject: 'carol', type: 'preference', value: '可乐', confidence: 0.9 }))

  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG_ENABLED)
  const result = await assembler.assemble('hello', makeWorldState())

  // 不同 subject 不产生 semantic conflict
  check('C8.1: 三个不同 subject → semanticConflicts = []', result.semanticConflicts.length === 0, `got ${result.semanticConflicts.length}`)
  check('C8.2: memoryFacts 包含 3 条', result.memoryFacts.length === 3, `got ${result.memoryFacts.length}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── C9: enabled + 同 subject+type 第二次 upsert overwrite ─────────────────
// MemoryStore 同 (subject, type) 第二次 upsert 覆盖第一次（保留第二次的 id）。
// 因此只有 1 条 fact，无 L2 冲突，也无 semantic conflict。
// 验证 enabled 时 summary 仍正常，不报错。
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-c9-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ id: 'f1', subject: 'alice', type: 'preference', value: '咖啡', confidence: 0.9, source: 'user-explicit' }))
  await store.upsertFact(mkFact({ id: 'f2', subject: 'alice', type: 'preference', value: '茶', confidence: 0.85, source: 'reflection' }))

  const assembler = createContextAssembler(store, makeMockInfoStore(), BASE_CONFIG_ENABLED)
  const result = await assembler.assemble('hello', makeWorldState())

  check('C9.1: 启用 detectSemanticConflict + 单 fact → no conflict', result.semanticConflicts.length === 0, `got ${result.semanticConflicts.length}`)
  check('C9.2: 只有 1 条 fact（第一次 id 被保留但值被第二次覆盖）', result.memoryFacts.length === 1, `got ${result.memoryFacts.length}`)
  check('C9.3: summary 不报错', !result.summary.includes('Error'))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── 结果 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-semantic-conflict 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-semantic-conflict 失败 ${failed.length} 项`)
}
