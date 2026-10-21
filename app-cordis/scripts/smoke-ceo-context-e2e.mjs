/**
 * Phase 6.B CEO Context Integration E2E 冒烟测试
 * 运行：npm run build && node scripts/smoke-ceo-context-e2e.mjs
 *
 * 覆盖（CE1~CE8）：
 * CE1: contextAssembler.assemble() → memoryFacts 格式化正确
 * CE2: 无 memory facts → memoryContext 为空字符串
 * CE3: contextAssembler disabled → memoryContext 为空
 * CE4: memory disabled（MemoryStore off）→ assemble() 返回 empty context，memoryFacts=0
 * CE5: infoRecords 仍在 R2 注入（向后兼容）
 * CE6: summary 包含 WorldState + InfoRecords + Memory 分层
 * CE7: CEO prompt 格式：persona + archive.context + memoryContext
 * CE8: 多个 memory facts 按 confidence 降序排列
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../dist/services/memoryStore.js'
import { createContextAssembler } from '../dist/services/contextAssembler.js'

const STABLE_SALT = 'test-salt-ceo-e2e'
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

/**
 * 模拟 agent.ts 的 memoryContext 拼接逻辑
 */
async function buildMemoryContext(contextAssembler, worldState, userInput) {
  let memoryContext = ''
  if (!contextAssembler || !worldState) return memoryContext
  const result = await contextAssembler.assemble(userInput, worldState)
  if (result.memoryFacts.length > 0) {
    const memLines = result.memoryFacts.map((f) => f.formatted)
    memoryContext = `\n\n【长期记忆】以下事实来自你的长期记忆（直接引用，无需核实）：\n${memLines.join('\n')}`
  }
  return memoryContext
}

/** 模拟完整的 CEO system prompt 构建 */
function buildCeoSystemPrompt(personaText, archiveContext, memoryContext) {
  return personaText + (archiveContext ? `\n\n${archiveContext}` : '') + memoryContext
}

// ── CE1: assemble() → memoryFacts 格式化正确 ────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-ce1-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'alice', type: 'preference', value: 'coffee', confidence: 0.95 }))
  await store.upsertFact(mkFact({ subject: 'bob', type: 'habit', value: 'late_night', confidence: 0.78 }))

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('hello', makeWorldState())

  check('CE1.1: 返回 2 条 memoryFacts', result.memoryFacts.length === 2, `got ${result.memoryFacts.length}`)
  check('CE1.2: 第一条 confidence 最高', result.memoryFacts[0].confidence === 0.95, `got ${result.memoryFacts[0].confidence}`)
  check('CE1.3: 格式化包含 [Memory:preference]', result.memoryFacts[0].formatted.includes('[Memory:preference]'))
  check('CE1.4: 格式化包含 subject: coffee', result.memoryFacts[0].formatted.includes('alice: coffee'))
  check('CE1.5: 格式化包含 (confidence 0.95)', result.memoryFacts[0].formatted.includes('(confidence 0.95)'))
  check('CE1.6: FormattedMemoryFact 有 id/type/subject/confidence/updatedAt',
    !!(result.memoryFacts[0].id && result.memoryFacts[0].type && result.memoryFacts[0].subject &&
       result.memoryFacts[0].confidence !== undefined && result.memoryFacts[0].updatedAt))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CE2: 无 memory facts → memoryContext 为空字符串 ─────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-ce2-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const mc = await buildMemoryContext(assembler, makeWorldState(), 'test')

  check('CE2.1: 无 facts → memoryContext 为空', mc === '', `got "${mc}"`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CE3: contextAssembler disabled → memoryContext 为空 ──────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-ce3-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'alice', confidence: 0.95 }))

  const infoStore = makeMockInfoStore([])
  const disabledAssembler = createContextAssembler(store, infoStore, { ...DEFAULT_CONFIG, enabled: false })
  const mc = await buildMemoryContext(disabledAssembler, makeWorldState(), 'test')

  check('CE3.1: disabled → memoryContext 为空', mc === '', `got "${mc}"`)

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CE4: memory disabled → assemble() 返回 empty context ─────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-ce4-'))
  // MemoryStore enabled but contextAssembler disabled
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'alice', confidence: 0.95 }))

  const infoStore = makeMockInfoStore([])
  const disabledAssembler = createContextAssembler(store, infoStore, { ...DEFAULT_CONFIG, enabled: false })
  const result = await disabledAssembler.assemble('test', makeWorldState())

  check('CE4.1: disabled → memoryFacts 为空', result.memoryFacts.length === 0)
  check('CE4.2: disabled → summary 为空', result.summary === '')
  check('CE4.3: disabled → input 仍传递', result.input === 'test')

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CE5: infoRecords 仍在 R2 注入（向后兼容）────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-ce5-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  const infoStore = makeMockInfoStore([
    { id: 'r1', namespace: 'food', type: 'food-log', ts: Date.now(), source: 'app', payload: { text: '午餐' } },
  ])

  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('test', makeWorldState())

  check('CE5.1: infoRecords 非空', result.infoRecords.length === 1, `got ${result.infoRecords.length}`)
  check('CE5.2: infoRecords 格式化正确', result.infoRecords[0].formatted.includes('[food]'))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CE6: summary 包含 WorldState + InfoRecords + Memory 分层 ───────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-ce6-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'alice', value: 'coffee', confidence: 0.95 }))

  const infoStore = makeMockInfoStore([
    { id: 'r1', namespace: 'food', type: 'food-log', ts: Date.now(), source: 'app', payload: { text: '午餐' } },
  ])

  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const result = await assembler.assemble('test', makeWorldState())

  check('CE6.1: summary 包含 ## WorldState', result.summary.includes('## WorldState'))
  check('CE6.2: summary 包含 ## Recent InfoRecords', result.summary.includes('## Recent InfoRecords'))
  check('CE6.3: summary 包含 ## Memory', result.summary.includes('## Memory'))
  check('CE6.4: summary 包含 user.status', result.summary.includes('user:'))
  check('CE6.5: summary 包含 memory formatted', result.summary.includes('[Memory:'))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CE7: CEO prompt 格式：persona + archive + memoryContext ──────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-ce7-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'alice', value: 'coffee', confidence: 0.95 }))

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)

  const PERSONA = '你叫 Orca。'
  const ARCHIVE = '【档案室 R0 命中】饮食记录：午餐。'
  const mc = await buildMemoryContext(assembler, makeWorldState(), 'hello')
  const systemPrompt = buildCeoSystemPrompt(PERSONA, ARCHIVE, mc)

  check('CE7.1: prompt 包含 persona', systemPrompt.includes('你叫 Orca'))
  check('CE7.2: prompt 包含 archive', systemPrompt.includes('【档案室 R0 命中】'))
  check('CE7.3: prompt 包含 【长期记忆】', systemPrompt.includes('【长期记忆】'))
  check('CE7.4: prompt 包含 memory formatted', systemPrompt.includes('[Memory:'))
  check('CE7.5: prompt memory block 前有空行分隔', systemPrompt.includes('\n\n【长期记忆】'))
  check('CE7.6: prompt archive 和 memoryContext 之间有空行', systemPrompt.includes('饮食记录：午餐。\n\n【长期记忆】'))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CE8: 多个 facts 按 confidence 降序排列 ──────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-ce8-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'low', confidence: 0.5 }))
  await store.upsertFact(mkFact({ subject: 'high', confidence: 0.98 }))
  await store.upsertFact(mkFact({ subject: 'mid', confidence: 0.75 }))

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)
  const mc = await buildMemoryContext(assembler, makeWorldState(), 'test')

  check('CE8.1: 第一条是 high confidence', mc.includes('high') && mc.indexOf('high') < mc.indexOf('mid') && mc.indexOf('mid') < mc.indexOf('low'))
  check('CE8.2: memoryContext 不为空', mc.length > 0)
  check('CE8.3: 三个 facts 都在', mc.includes('high') && mc.includes('mid') && mc.includes('low'))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── CE9: worldState snapshot 透传到 assemble ─────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-ce9-'))
  const store = createMemoryStore({
    enabled: true, dataDir: dir, fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100, promoteThreshold: 0.7,
    attentionEnabled: false, attentionPollIntervalMs: 60000, attentionTopK: 5,
  })

  await store.upsertFact(mkFact({ subject: 'alice', confidence: 0.95 }))

  const infoStore = makeMockInfoStore([])
  const assembler = createContextAssembler(store, infoStore, DEFAULT_CONFIG)

  const ws = makeWorldState()
  const result = await assembler.assemble('hello', ws)

  check('CE9.1: worldState 透传正确', result.worldState.user.status === 'awake')
  check('CE9.2: summary 包含 ws time', result.summary.includes('afternoon'))

  store.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── 结果 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-ceo-context-e2e 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-ceo-context-e2e 失败 ${failed.length} 项`)
}
