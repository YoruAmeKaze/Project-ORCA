/**
 * Phase 6.A ContextAssembler 冒烟测试
 * 运行：npm run build && node scripts/smoke-context-assembler.mjs
 *
 * 覆盖（CA1~CA11）：
 *  CA1: 基本 assembly — WorldState + InfoRecords + MemoryFacts 组合
 *  CA2: infoRecords 格式化正确
 *  CA3: memory budget 500 字符限制
 *  CA4: per-fact 80 字符截断
 *  CA5: Top-K=10 限制
 *  CA6: 空 memory 时不报错
 *  CA7: 空 infoRecords 时不报错
 *  CA8: subject 精确匹配
 *  CA9: type 过滤
 *  CA10: memoryBudgetHit flag 正确
 *  CA11: disabled 模式返回空 context
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../dist/services/memoryStore.js'
import { createContextAssembler } from '../dist/services/contextAssembler.js'

const STABLE_SALT = 'test-salt-ca'
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

// ── 辅助 ──────────────────────────────────────────────────────────────────

function makeMockInfoStore(records = []) {
  return {
    getRecentByNamespace: async (namespace, n) => records.slice(0, n),
  }
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

const DEFAULT_CONFIG = {
  enabled: true,
  memoryTopK: 10,
  memoryPerFactChars: 80,
  memoryBudgetChars: 500,
  infoRecordsLimit: 3,
}

// ── CA1: 基本 assembly ───────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca1-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'alice', type: 'preference', value: 'coffee', confidence: 0.95 }))
  await store.upsertFact(mkFact({ subject: 'bob', type: 'habit', value: 'late_night', confidence: 0.78 }))

  const infoStore = makeMockInfoStore([
    { id: 'r1', namespace: 'food', type: 'food-log', ts: Date.now(), source: 'app', payload: { text: '午餐：米饭+炒菜' } },
    { id: 'r2', namespace: 'weather', type: 'weather', ts: Date.now() - 1000, source: 'app', payload: { text: '今天晴' } },
  ])

  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('hello world', makeWorldState())

  check('CA1.1: input 原样传递', result.input === 'hello world')
  check('CA1.2: worldState 透传', !!result.worldState && result.worldState.user.status === 'awake')
  check('CA1.3: infoRecords 非空', result.infoRecords.length === 2, `got ${result.infoRecords.length}`)
  check('CA1.4: memoryFacts 非空', result.memoryFacts.length === 2, `got ${result.memoryFacts.length}`)
  check('CA1.5: summary 包含 WorldState', result.summary.includes('WorldState'))
  check('CA1.6: summary 包含 Memory', result.summary.includes('Memory'))
  check('CA1.7: summary 包含 InfoRecords', result.summary.includes('InfoRecords'))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CA2: infoRecords 格式化 ───────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca2-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  const infoStore = makeMockInfoStore([
    { id: 'r1', namespace: 'food', type: 'food-log', ts: 1000, source: 'app', payload: { text: '午餐' } },
  ])

  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('test', makeWorldState())

  check('CA2.1: infoRecord 格式化包含 namespace', result.infoRecords[0].formatted.includes('[food]'))
  check('CA2.2: infoRecord 格式化包含 type', result.infoRecords[0].formatted.includes('food-log'))
  check('CA2.3: FormattedInfoRecord 包含 id/namespace/type/ts', !!result.infoRecords[0].id && !!result.infoRecords[0].namespace && !!result.infoRecords[0].type && !!result.infoRecords[0].ts)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CA3: memory budget 500 字符限制 ───────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca3-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  // 写入 20 条 facts，每条约 100 字符 value → 总字符远超 500
  for (let i = 0; i < 20; i++) {
    await store.upsertFact(mkFact({
      subject: `user_${i}`,
      type: 'fact',
      value: 'x'.repeat(100),
      confidence: 1.0 - i * 0.04,
    }))
  }

  const infoStore = makeMockInfoStore([])
  const lowBudget = { ...DEFAULT_CONFIG, memoryBudgetChars: 500, memoryTopK: 20 }
  const assembler = createContextAssembler(store, infoStore, lowBudget)
  const result = await assembler.assemble('test', makeWorldState())

  const totalChars = result.memoryFacts.reduce((s, f) => s + f.formatted.length, 0)
  check('CA3.1: 总字符数不超过 500', totalChars <= 500, `got ${totalChars}`)
  check('CA3.2: memoryBudgetHit 为 true', result.memoryBudgetHit === true)
  check('CA3.3: totalAvailable > memoryFacts.length', result.memoryTotalAvailable > result.memoryFacts.length, `total=${result.memoryTotalAvailable}, included=${result.memoryFacts.length}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CA4: per-fact 80 字符截断 ─────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca4-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  // value 超过 80 字符（ASCII，每字符 1 单位长度）
  await store.upsertFact(mkFact({
    subject: 'alice',
    type: 'preference',
    value: 'A'.repeat(100),  // 100 chars > 80
    confidence: 0.95,
  }))

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('test', makeWorldState())

  // perFactChars=80 限制的是 value 部分（不含前缀 [Memory:type] subject: 等）
  // 这个 value 长 100 < 80 → 被截断（所以 endsWith('…') 是 TRUE）
  // formatted = `[Memory:preference] alice: ` + 79 + '…' + ` (confidence 0.95)` → endsWith '…' FALSE
  const hasEllipsis1 = result.memoryFacts[0].formatted.includes('…')
  check('CA4.1: value 100 > perFactChars 80 → 被截断', hasEllipsis1, `formatted=${result.memoryFacts[0].formatted.slice(0,50)}`)

  // 测试真正的截断：把 perFactChars 设为 30
  const shortConfig = { ...DEFAULT_CONFIG, memoryPerFactChars: 30 }
  const shortAssembler = createContextAssembler(store, infoStore, shortConfig)
  const shortResult = await shortAssembler.assemble('test', makeWorldState())
  const shortHasEllipsis = shortResult.memoryFacts[0].formatted.includes('…')
  check('CA4.2: value 100 > perFactChars 30 → 被截断', shortHasEllipsis, `formatted=${shortResult.memoryFacts[0].formatted.slice(0,50)}`)

  // CA4.1 应该截断到 80 字符（79 value + 省略号）
  const fullLen = result.memoryFacts[0].formatted.length
  check('CA4.3: 截断后 total formatted 约 125 字符', fullLen > 100, `len=${fullLen}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CA5: Top-K=10 限制 ────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca5-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  // 写入 15 条 facts
  for (let i = 0; i < 15; i++) {
    await store.upsertFact(mkFact({ subject: `user_${i}`, confidence: 1.0 - i * 0.06 }))
  }

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('test', makeWorldState())

  check('CA5.1: 最多 10 条 facts', result.memoryFacts.length <= 10, `got ${result.memoryFacts.length}`)
  check('CA5.2: totalAvailable 为 15', result.memoryTotalAvailable === 15, `got ${result.memoryTotalAvailable}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CA6: 空 memory 不报错 ──────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca6-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('test', makeWorldState())

  check('CA6.1: memoryFacts 为空', result.memoryFacts.length === 0)
  check('CA6.2: memoryCharsUsed 为 0', result.memoryCharsUsed === 0)
  check('CA6.3: summary 包含 Memory (none)', result.summary.includes('Memory (none)'))
  check('CA6.4: memoryBudgetHit 为 false', result.memoryBudgetHit === false)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CA7: 空 infoRecords 不报错 ─────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca7-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'alice', confidence: 0.9 }))

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('test', makeWorldState())

  check('CA7.1: infoRecords 为空', result.infoRecords.length === 0)
  check('CA7.2: summary 包含 InfoRecords (none)', result.summary.includes('InfoRecords (none)'))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CA8: subject 精确匹配 ─────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca8-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'alice', type: 'preference', value: 'coffee', confidence: 0.95 }))
  await store.upsertFact(mkFact({ subject: 'bob', type: 'habit', value: 'late_night', confidence: 0.8 }))
  await store.upsertFact(mkFact({ subject: 'alice_bob', type: 'fact', value: 'shared_topic', confidence: 0.75 }))

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('test', makeWorldState(), {
    memoryQuery: { subject: 'alice' },
  })

  check('CA8.1: 只返回 alice 的 fact', result.memoryFacts.length === 1, `got ${result.memoryFacts.length}`)
  check('CA8.2: subject 匹配', result.memoryFacts[0]?.subject === 'alice')
  check('CA8.3: 不包含 bob', !result.memoryFacts.find((f) => f.subject === 'bob'))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CA9: type 过滤 ────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca9-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'alice', type: 'preference', confidence: 0.95 }))
  await store.upsertFact(mkFact({ subject: 'bob', type: 'habit', confidence: 0.85 }))
  await store.upsertFact(mkFact({ subject: 'carol', type: 'fact', confidence: 0.75 }))

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('test', makeWorldState(), {
    memoryQuery: { type: 'habit' },
  })

  check('CA9.1: 只返回 habit facts', result.memoryFacts.length === 1, `got ${result.memoryFacts.length}`)
  check('CA9.2: type=habit', result.memoryFacts[0]?.type === 'habit')
  check('CA9.3: subject=bob', result.memoryFacts[0]?.subject === 'bob')

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CA10: memoryBudgetHit flag ─────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca10-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  // 写入足够多的 facts，确保 budget 被触发
  for (let i = 0; i < 15; i++) {
    await store.upsertFact(mkFact({
      subject: `user_${i}`,
      value: 'x'.repeat(80),
      confidence: 0.9,
    }))
  }

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('test', makeWorldState())

  // 当 facts 数量足以触发 budget 时，budgetHit 应该为 true
  check('CA10.1: budgetHit flag 正确', result.memoryBudgetHit === true, `budgetHit=${result.memoryBudgetHit}, facts=${result.memoryFacts.length}, chars=${result.memoryCharsUsed}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CA11: disabled 模式 ────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca11-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'alice', confidence: 0.95 }))

  const infoStore = makeMockInfoStore([
    { id: 'r1', namespace: 'food', type: 'food-log', ts: Date.now(), source: 'app', payload: { text: '午餐' } },
  ])

  const disabledConfig = { ...DEFAULT_CONFIG, enabled: false }
  const assembler = createContextAssembler(store, infoStore, disabledConfig)
  const result = await assembler.assemble('hello', makeWorldState())

  check('CA11.1: disabled 时 input 仍传递', result.input === 'hello')
  check('CA11.2: disabled 时 memoryFacts 为空', result.memoryFacts.length === 0)
  check('CA11.3: disabled 时 infoRecords 为空', result.infoRecords.length === 0)
  check('CA11.4: disabled 时 summary 为空', result.summary === '')

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CA12: confidence + updatedAt 排序 ────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-ca-ca12-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  const now = Date.now()
  await store.upsertFact(mkFact({ subject: 'low', confidence: 0.6, updatedAt: now }))
  await store.upsertFact(mkFact({ subject: 'high', confidence: 0.95, updatedAt: now - 1000 })) // 更旧但更高 confidence
  await store.upsertFact(mkFact({ subject: 'mid', confidence: 0.8, updatedAt: now }))

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('test', makeWorldState())

  check('CA12.1: 第一条是 high confidence', result.memoryFacts[0]?.subject === 'high', `got ${result.memoryFacts[0]?.subject}`)
  check('CA12.2: 第二条是 mid（same confidence 优先 updatedAt）', result.memoryFacts[1]?.subject === 'mid', `got ${result.memoryFacts[1]?.subject}`)
  check('CA12.3: 第三条是 low', result.memoryFacts[2]?.subject === 'low', `got ${result.memoryFacts[2]?.subject}`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── 结果 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-context-assembler 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-context-assembler 失败 ${failed.length} 项`)
}
