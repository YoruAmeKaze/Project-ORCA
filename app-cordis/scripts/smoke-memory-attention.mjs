/**
 * D-AGENT-19 Phase 5.4.A MemoryAttentionAdapter 冒烟测试
 * 运行：npm run build && node scripts/smoke-memory-attention.mjs
 *
 * 覆盖（M1~M5）：
 *  M1: active fact 生成 AttentionItem
 *  M2: superseded fact 不生成
 *  M3: forget 后不生成
 *  M4: duplicate tick 不重复
 *  M5: confidence metadata 正确
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../dist/services/memoryStore.js'
import {
  createMemoryAttentionAdapter,
  factToAttentionItem,
} from '../dist/services/memoryAttentionAdapter.js'

const STABLE_SALT = 'test-salt-maa'
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

function makeEmitter() {
  const emitted = []
  const emit = (event, item) => emitted.push({ event, item })
  return { emit, emitted }
}

// ── M1: active fact 生成 AttentionItem ───────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-maa-m1-'))
  const store = createMemoryStore(mkConfig(dir))
  const { emit, emitted } = makeEmitter()

  const adapter = createMemoryAttentionAdapter(
    store,
    emit,
    { enabled: true, pollIntervalMs: 60000, topK: 5 },
    undefined,
  )

  // 写入 3 个 active facts
  const f1 = mkFact({ subject: 'alice', type: 'preference', value: 'coffee', confidence: 0.95 })
  const f2 = mkFact({ subject: 'bob', type: 'habit', value: 'late_night', confidence: 0.78 })
  const f3 = mkFact({ subject: 'carol', type: 'behavioral_pattern', value: 'high_burst', confidence: 0.72 })
  await store.upsertFact(f1)
  await store.upsertFact(f2)
  await store.upsertFact(f3)

  await adapter.tick()

  check('M1.1: 3 个 facts → 3 个 AttentionItems', emitted.length === 3, `got ${emitted.length}`)
  check('M1.2: 所有 items 的 source=memory', emitted.every((e) => e.item.source === 'memory'))
  check('M1.3: 所有 items 的 ruleId=memory-attention-adapter', emitted.every((e) => e.item.ruleId === 'memory-attention-adapter'))
  check('M1.4: item id 格式为 memory:{factId}', emitted.every((e) => e.item.id.startsWith('memory:')))
  check('M1.5: items 包含 metadata', emitted.every((e) => e.item.metadata && 'factId' in e.item.metadata))
  check('M1.6: metadata.factId 正确', emitted.find((e) => e.item.metadata.factId === f1.id) !== undefined)

  adapter.stop()
  rmSync(dir, { recursive: true, force: true })
}

// ── M2: superseded fact 不生成 ───────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-maa-m2-'))
  const store = createMemoryStore(mkConfig(dir))
  const { emit, emitted } = makeEmitter()

  const adapter = createMemoryAttentionAdapter(store, emit, { enabled: true, pollIntervalMs: 60000, topK: 5 }, undefined)

  // 写入 fact，然后 supersede 它
  const f1 = mkFact({ subject: 'dave', type: 'preference', value: 'old_value', confidence: 0.9 })
  await store.upsertFact(f1)

  // 制造 supersede：写入新 fact 触发 supersede
  const f2 = mkFact({ subject: 'dave', type: 'preference', value: 'new_value', confidence: 0.95 })
  await store.upsertFact(f2) // upsert 会保留原 id 还是新建？让我检查...

  // 实际上 upsertFact 的行为：identity=(type,subject)，同 identity 原地更新
  // 所以 f1 被原地更新了，不是 supersede
  // 要制造 supersede 需要用 supersedeFact
  await store.supersedeFact(f1.id, { ...f2, id: f2.id + '_superseding' })

  await adapter.tick()

  const daveItem = emitted.find((e) => e.item.metadata?.factId === f1.id)
  check('M2.1: superseded fact 的 AttentionItem 未生成', daveItem === undefined, daveItem ? '但实际上生成了' : '正确未生成')

  adapter.stop()
  rmSync(dir, { recursive: true, force: true })
}

// ── M3: forget 后不生成 ──────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-maa-m3-'))
  const store = createMemoryStore(mkConfig(dir))
  const { emit, emitted } = makeEmitter()

  const adapter = createMemoryAttentionAdapter(store, emit, { enabled: true, pollIntervalMs: 60000, topK: 5 }, undefined)

  const f1 = mkFact({ subject: 'eve', type: 'preference', value: 'sensitive', confidence: 0.9 })
  await store.upsertFact(f1)

  await adapter.tick()
  check('M3.1: forget 前 AttentionItem 生成', emitted.some((e) => e.item.metadata?.factId === f1.id), `emitted=${emitted.length}`)

  // 清空 emitted
  emitted.length = 0

  // forget
  await store.forgetFact(f1.id)

  await adapter.tick()
  const afterForget = emitted.find((e) => e.item.metadata?.factId === f1.id)
  check('M3.2: forget 后 AttentionItem 未生成', afterForget === undefined, afterForget ? '但实际上生成了' : '正确未生成')

  adapter.stop()
  rmSync(dir, { recursive: true, force: true })
}

// ── M4: duplicate tick 不重复 ───────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-maa-m4-'))
  const store = createMemoryStore(mkConfig(dir))
  const { emit, emitted } = makeEmitter()

  const adapter = createMemoryAttentionAdapter(store, emit, { enabled: true, pollIntervalMs: 60000, topK: 5 }, undefined)

  const f1 = mkFact({ subject: 'frank', type: 'habit', value: 'pattern', confidence: 0.88 })
  await store.upsertFact(f1)

  // 第一次 tick
  await adapter.tick()
  const afterFirst = emitted.length
  check('M4.1: 第一次 tick 生成 1 个 item', afterFirst === 1, `got ${afterFirst}`)

  // 第二次 tick（same updatedAt）
  await adapter.tick()
  check('M4.2: 第二次 tick 不重复（same updatedAt）', emitted.length === 1, `got ${emitted.length}（应为 1）`)

  // 更新 fact（updatedAt 变化）
  const updated = { ...f1, value: 'updated_value', updatedAt: Date.now() }
  await store.upsertFact(updated)

  await adapter.tick()
  check('M4.3: updatedAt 变化后重新生成', emitted.length === 2, `got ${emitted.length}（应为 2）`)

  adapter.stop()
  rmSync(dir, { recursive: true, force: true })
}

// ── M5: confidence metadata 正确 ─────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-maa-m5-'))
  const store = createMemoryStore(mkConfig(dir))
  const { emit, emitted } = makeEmitter()

  const adapter = createMemoryAttentionAdapter(store, emit, { enabled: true, pollIntervalMs: 60000, topK: 5 }, undefined)

  const f1 = mkFact({ subject: 'grace', type: 'preference', value: 'high_conf', confidence: 0.95 })
  const f2 = mkFact({ subject: 'henry', type: 'habit', value: 'mid_conf', confidence: 0.73 })
  const f3 = mkFact({ subject: 'iris', type: 'fact', value: 'low_conf', confidence: 0.55 })
  await store.upsertFact(f1)
  await store.upsertFact(f2)
  await store.upsertFact(f3)

  await adapter.tick()

  const grace = emitted.find((e) => e.item.metadata?.factId === f1.id)?.item
  const henry = emitted.find((e) => e.item.metadata?.factId === f2.id)?.item
  const iris = emitted.find((e) => e.item.metadata?.factId === f3.id)?.item

  check('M5.1: metadata.memoryType=preference', grace?.metadata?.memoryType === 'preference')
  check('M5.2: metadata.memorySource=user-explicit', grace?.metadata?.memorySource === 'user-explicit')
  check('M5.3: metadata.confidence=0.95', grace?.metadata?.confidence === 0.95)
  check('M5.4: metadata.createdAt 存在', typeof grace?.metadata?.createdAt === 'number')
  check('M5.5: metadata.updatedAt 存在', typeof grace?.metadata?.updatedAt === 'number')
  check('M5.6: confidence >= 0.9 → priority=urgent', grace?.priority === 'urgent')
  check('M5.7: 0.7 <= confidence < 0.8 → priority=normal', henry?.priority === 'normal')
  check('M5.8: confidence < 0.7 → priority=low', iris?.priority === 'low')
  check('M5.9: action=remember_only', grace?.action === 'remember_only')
  check('M5.10: reason 包含 type 和 subject', grace?.reason?.includes('preference/grace'))

  adapter.stop()
  rmSync(dir, { recursive: true, force: true })
}

// ── M6: TopK 限制 ────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-maa-m6-'))
  const store = createMemoryStore(mkConfig(dir))
  const { emit, emitted } = makeEmitter()

  // TopK = 2
  const adapter = createMemoryAttentionAdapter(store, emit, { enabled: true, pollIntervalMs: 60000, topK: 2 }, undefined)

  // 写入 5 个 facts
  for (let i = 0; i < 5; i++) {
    await store.upsertFact(mkFact({ subject: `subj_${i}`, confidence: 0.9 - i * 0.05 }))
  }

  await adapter.tick()
  check('M6.1: topK=2 时最多生成 2 个 items', emitted.length <= 2, `got ${emitted.length}`)

  adapter.stop()
  rmSync(dir, { recursive: true, force: true })
}

// ── M7: factToAttentionItem 导出函数单测 ────────────────────────────────
{
  const fact = mkFact({
    id: 'test_fact_123',
    type: 'behavioral_pattern',
    subject: 'alice',
    value: 'high_burst_frequency',
    confidence: 0.82,
    source: 'reflection',
    createdAt: 1000,
    updatedAt: 2000,
  })

  const item = factToAttentionItem(fact, 'test-rule')

  check('M7.1: id = memory:{factId}', item.id === 'memory:test_fact_123')
  check('M7.2: ruleId 自定义', item.ruleId === 'test-rule')
  check('M7.3: priority = high（0.82）', item.priority === 'high')
  check('M7.4: action = remember_only', item.action === 'remember_only')
  check('M7.5: source = memory', item.source === 'memory')
  check('M7.6: reason 包含 type/subject/value/confidence', item.reason.includes('behavioral_pattern') && item.reason.includes('alice'))
  check('M7.7: metadata.factId', item.metadata.factId === 'test_fact_123')
  check('M7.8: metadata.memoryType', item.metadata.memoryType === 'behavioral_pattern')
  check('M7.9: metadata.memorySource = reflection', item.metadata.memorySource === 'reflection')
  check('M7.10: metadata.confidence', item.metadata.confidence === 0.82)
  check('M7.11: metadata.createdAt', item.metadata.createdAt === 1000)
  check('M7.12: metadata.updatedAt', item.metadata.updatedAt === 2000)
  check('M7.13: stateSnapshot 存在', !!item.stateSnapshot && 'user' in item.stateSnapshot)
}

// ── 结果 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-memory-attention 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-memory-attention 失败 ${failed.length} 项`)
}
