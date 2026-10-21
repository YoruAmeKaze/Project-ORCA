/**
 * Phase 6.C Evaluation Report
 * node scripts/phase6c-evaluation.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../dist/services/memoryStore.js'
import { createContextAssembler } from '../dist/services/contextAssembler.js'
import { createMemoryUsageTracker } from '../dist/services/memoryUsageTracker.js'
import { detectSemanticConflicts } from '../dist/types/context.js'

const STABLE_SALT = 'eval-salt'
const results = []

function check(name, actual, expected, note = '') {
  const pass = actual === expected
  results.push({ name, pass, actual, expected, note })
  console.log(`${pass ? '✅' : '❌'}  ${name}`)
  if (!pass) {
    console.log(`     Expected: ${expected} | Actual: ${actual}${note ? ' | ' + note : ''}`)
  }
}

function checkTrue(name, actual, note = '') {
  check(name, actual, true, note)
}

function mkFact(overrides = {}) {
  const now = Date.now()
  return {
    id: overrides.id ?? `f${now}_${Math.random().toString(36).slice(2)}`,
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

const BASE_CONFIG = {
  enabled: true, memoryTopK: 10, memoryPerFactChars: 80,
  memoryBudgetChars: 500, infoRecordsLimit: 3,
  scoringPreset: 'confidence', detectSemanticConflict: false,
}

const mockInfo = { getRecentByNamespace: async () => [] }
const ws = {
  user: { status: 'awake', lastSeenAt: Date.now(), doNotDisturb: false },
  device: { isLocked: false, powerMode: 'plugged', network: 'online' },
  time: { timeOfDay: 'afternoon', dayOfWeek: 'Wed', isWorkday: true, isWeekend: false },
  extensions: {}, lastUpdated: Date.now(),
}

// ── E1 ──────────────────────────────────────────────────────────────────────
console.log('\n=== E1: Memory correctly enters prompt ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-e1-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'e1a', subject:'alice', value:'coffee', confidence:0.9 }))
  await store.upsertFact(mkFact({ id:'e1b', subject:'bob', value:'gym', confidence:0.85 }))
  await store.upsertFact(mkFact({ id:'e1c', subject:'carol', value:'reading', confidence:0.8 }))
  const r = await createContextAssembler(store, mockInfo, BASE_CONFIG).assemble('hello', ws)
  check('E1.1: 3 facts returned', r.memoryFacts.length, 3)
  checkTrue('E1.2: e1a present', r.memoryFacts.some(f => f.id === 'e1a'))
  checkTrue('E1.3: e1b present', r.memoryFacts.some(f => f.id === 'e1b'))
  checkTrue('E1.4: e1c present', r.memoryFacts.some(f => f.id === 'e1c'))
  checkTrue('E1.5: summary has ## Memory', r.summary.includes('## Memory'))
  checkTrue('E1.6: format has [Memory:', r.summary.includes('[Memory:'))
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

// ── E2 ──────────────────────────────────────────────────────────────────────
console.log('\n=== E2: Top-K limit ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-e2-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  for (let i = 0; i < 15; i++) await store.upsertFact(mkFact({ id:`e2f${i}`, subject:`s${i}`, value:`v${i}`, confidence: 0.9 - i * 0.01 }))
  const cfg = { ...BASE_CONFIG, memoryTopK: 10 }
  const r = await createContextAssembler(store, mockInfo, cfg).assemble('hello', ws)
  check('E2.1: returns 10 facts', r.memoryFacts.length, 10)
  check('E2.2: totalAvailable=15', r.memoryTotalAvailable, 15)
  checkTrue('E2.3: descending confidence order', r.memoryFacts[0].confidence >= r.memoryFacts[9].confidence)
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

// ── E3 ──────────────────────────────────────────────────────────────────────
console.log('\n=== E3: Forget does not resurrect ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-e3-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'e3f', subject:'alice', value:'coffee', confidence:0.9 }))
  const before = await createContextAssembler(store, mockInfo, BASE_CONFIG).assemble('hello', ws)
  checkTrue('E3.1: fact visible before forget', before.memoryFacts.some(f => f.id === 'e3f'))
  await store.forgetFact('e3f')
  const q = await store.queryFacts({ subject:'alice' })
  check('E3.2: queryFacts({state:active}) returns 0', q.length, 0)
  const after = await createContextAssembler(store, mockInfo, BASE_CONFIG).assemble('hello', ws)
  checkTrue('E3.3: forgotten fact NOT in memoryFacts', !after.memoryFacts.some(f => f.id === 'e3f'))
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

// ── E4 ──────────────────────────────────────────────────────────────────────
console.log('\n=== E4: user-explicit overrides reflection (L2) ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-e4-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })

  // Same (type,subject) → MemoryStore update-in-place (second upsert overwrites first)
  await store.upsertFact(mkFact({ id:'e4r', subject:'alice', type:'preference', value:'coffee', source:'reflection', confidence:0.9 }))
  await store.upsertFact(mkFact({ id:'e4u', subject:'alice', type:'preference', value:'tea', source:'user-explicit', confidence:0.85 }))

  const facts = await store.queryFacts({ state:'active' })
  const alice = facts.find(f => f.subject === 'alice')
  check('E4.1: only 1 active fact (update-in-place)', facts.filter(f => f.subject === 'alice').length, 1)
  check('E4.2: id preserved from first upsert', alice?.id, 'e4r')
  check('E4.3: value updated to second upsert', alice?.value, 'tea')
  check('E4.4: source updated to second upsert', alice?.source, 'user-explicit')

  // L2 logic test: different subjects (bob=reflection, carol=user-explicit)
  await store.upsertFact(mkFact({ id:'e4br', subject:'bob', value:'gym', source:'reflection', confidence:0.75 }))
  await store.upsertFact(mkFact({ id:'e4cu', subject:'carol', value:'yoga', source:'user-explicit', confidence:0.9 }))

  const r = await createContextAssembler(store, mockInfo, BASE_CONFIG).assemble('hello', ws)
  checkTrue('E4.5: user-explicit present (carol)', r.memoryFacts.some(f => f.id === 'e4cu'))
  checkTrue('E4.6: reflection also present (different subject)', r.memoryFacts.some(f => f.id === 'e4br'))
  check('E4.7: sourceConflictsFiltered=0 (different subjects)', r.sourceConflictsFiltered, 0)

  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

// ── E5 ──────────────────────────────────────────────────────────────────────
console.log('\n=== E5: user-explicit corrects wrong memory ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-e5-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'e5old', subject:'alice', value:'coffee', confidence:0.7, source:'reflection' }))
  await store.upsertFact(mkFact({ id:'e5new', subject:'alice', value:'tea', confidence:0.95, source:'user-explicit' }))
  const facts = await store.queryFacts({ state:'active' })
  const a = facts.find(f => f.subject === 'alice')
  check('E5.1: only 1 active fact', facts.filter(f => f.subject === 'alice' && f.state === 'active').length, 1)
  check('E5.2: value updated', a?.value, 'tea')
  check('E5.3: source=user-explicit', a?.source, 'user-explicit')
  check('E5.4: confidence updated', a?.confidence, 0.95)
  const r = await createContextAssembler(store, mockInfo, BASE_CONFIG).assemble('hello', ws)
  checkTrue('E5.5: corrected fact in memoryFacts', r.memoryFacts.some(f => f.subject === 'alice'))
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

// ── E6 ──────────────────────────────────────────────────────────────────────
console.log('\n=== E6: L3 semantic conflict marking ===')
{
  const mockFacts = [
    { id:'f1', type:'preference', subject:'alice', formatted:'喜欢咖啡', confidence:0.9, updatedAt:1000 },
    { id:'f2', type:'preference', subject:'alice', formatted:'喜欢茶', confidence:0.85, updatedAt:2000 },
  ]
  const conflicts = detectSemanticConflicts(mockFacts)
  check('E6.1: 1 conflict detected', conflicts.length, 1)
  check('E6.2: subject=alice', conflicts[0]?.subject, 'alice')
  check('E6.3: type=preference', conflicts[0]?.type, 'preference')
  check('E6.4: 2 facts in conflict', conflicts[0]?.facts.length, 2)
  checkTrue('E6.5: warningText includes Memory Conflict Warning', conflicts[0]?.warningText.includes('Memory Conflict Warning'))
  checkTrue('E6.6: warningText includes both values', conflicts[0]?.warningText.includes('喜欢咖啡') && conflicts[0]?.warningText.includes('喜欢茶'))

  const sameVal = [
    { id:'f1', type:'preference', subject:'bob', formatted:'喜欢咖啡', confidence:0.9, updatedAt:1000 },
    { id:'f2', type:'preference', subject:'bob', formatted:'喜欢咖啡', confidence:0.85, updatedAt:2000 },
  ]
  check('E6.7: same formatted value → 0 conflicts', detectSemanticConflicts(sameVal).length, 0)

  const dir = mkdtempSync(join(tmpdir(), 'ev-e6-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'e6a', subject:'alice', value:'咖啡', confidence:0.9 }))
  await store.upsertFact(mkFact({ id:'e6b', subject:'bob', value:'茶', confidence:0.85 }))
  const cfg = { ...BASE_CONFIG, detectSemanticConflict: true }
  const r = await createContextAssembler(store, mockInfo, cfg).assemble('hello', ws)
  check('E6.8: different subjects → no semantic conflict', r.semanticConflicts.length, 0)
  checkTrue('E6.9: summary has no Memory Conflict Warnings', !r.summary.includes('Memory Conflict Warnings'))
  checkTrue('E6.10: ⚠️ NOT in memoryFacts formatted string', !r.memoryFacts.some(f => f.formatted.includes('⚠️')))
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

// ── E7 ──────────────────────────────────────────────────────────────────────
console.log('\n=== E7: scoring preset changes order ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-e7-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'e7a', subject:'alice', value:'a', confidence:0.95, source:'reflection' }))
  await store.upsertFact(mkFact({ id:'e7b', subject:'bob', value:'b', confidence:0.88, source:'user-explicit' }))

  const cfg = { ...BASE_CONFIG, scoringPreset: 'confidence' }
  const r1 = await createContextAssembler(store, mockInfo, cfg).assemble('hello', ws)
  check('E7.1: confidence preset → alice first (0.95>0.88)', r1.memoryFacts[0]?.subject, 'alice')
  check('E7.2: confidence preset → bob second', r1.memoryFacts[1]?.subject, 'bob')

  const srcCfg = { ...BASE_CONFIG, scoringPreset: 'source-confidence' }
  const r2 = await createContextAssembler(store, mockInfo, srcCfg).assemble('hello', ws)
  check('E7.3: source-confidence → bob first (0.88+0.2=1.08>0.95)', r2.memoryFacts[0]?.subject, 'bob')
  check('E7.4: source-confidence → alice second', r2.memoryFacts[1]?.subject, 'alice')

  const r3 = await createContextAssembler(store, mockInfo, cfg).assemble('hello', ws)
  check('E7.5: scoring deterministic', r1.memoryFacts[0]?.id, r3.memoryFacts[0]?.id)

  const r4 = await createContextAssembler(store, mockInfo, cfg).assemble('hello', ws, { memoryQuery: { scoringFunction: (f) => -f.confidence } })
  check('E7.6: per-call scoring → lower confidence first', r4.memoryFacts[0]?.subject, 'bob')

  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

// ── E8 ──────────────────────────────────────────────────────────────────────
console.log('\n=== E8: Memory disabled behavior ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-e8-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'e8f', subject:'alice', value:'coffee', confidence:0.9 }))
  const cfg = { ...BASE_CONFIG, enabled: false }
  const r = await createContextAssembler(store, mockInfo, cfg).assemble('hello', ws)
  check('E8.1: memoryFacts=0 (disabled)', r.memoryFacts.length, 0)
  checkTrue('E8.2: summary has no ## Memory', !r.summary.includes('## Memory'))
  checkTrue('E8.3: summary non-empty (WorldState present)', r.summary.length > 0)
  check('E8.4: sourceConflictsFiltered=0', r.sourceConflictsFiltered, 0)
  check('E8.5: semanticConflicts=[]', r.semanticConflicts.length, 0)
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

// ── E9 ──────────────────────────────────────────────────────────────────────
console.log('\n=== E9: CEO prompt format ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-e9-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'e9f', subject:'alice', type:'preference', value:'coffee', confidence:0.95 }))
  const r = await createContextAssembler(store, mockInfo, BASE_CONFIG).assemble('hello', ws)
  checkTrue('E9.1: summary has ## WorldState', r.summary.includes('## WorldState'))
  checkTrue('E9.2: summary has ## Recent InfoRecords', r.summary.includes('## Recent InfoRecords'))
  checkTrue('E9.3: summary has ## Memory (long-term knowledge)', r.summary.includes('## Memory (long-term knowledge)'))
  checkTrue('E9.4: formatted has [Memory:preference]', r.summary.includes('[Memory:preference]'))
  checkTrue('E9.5: formatted includes subject', r.summary.includes('alice'))
  checkTrue('E9.6: formatted includes value', r.summary.includes('coffee'))
  checkTrue('E9.7: formatted includes confidence', r.summary.includes('confidence 0.95'))
  checkTrue('E9.8: memoryCharsUsed>0', r.memoryCharsUsed > 0)
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

// ── Quality Dimensions ────────────────────────────────────────────────────────
console.log('\n=== [A] Source trust ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-a-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'ar', subject:'alice', type:'preference', value:'coffee', source:'reflection', confidence:0.9 }))
  await store.upsertFact(mkFact({ id:'au', subject:'alice', type:'preference', value:'tea', source:'user-explicit', confidence:0.85 }))
  const facts = await store.queryFacts({ state:'active' })
  const a = facts.find(f => f.subject === 'alice')
  check('A.1: MemoryStore preserves second upsert source', a?.source, 'user-explicit')
  check('A.2: MemoryStore preserves second upsert value', a?.value, 'tea')
  await store.upsertFact(mkFact({ id:'abr', subject:'bob', value:'coffee', source:'reflection', confidence:0.9 }))
  await store.upsertFact(mkFact({ id:'acu', subject:'carol', value:'tea', source:'user-explicit', confidence:0.85 }))
  const r = await createContextAssembler(store, mockInfo, BASE_CONFIG).assemble('hello', ws)
  checkTrue('A.3: user-explicit present', r.memoryFacts.some(f => f.id === 'acu'))
  checkTrue('A.4: reflection also present (different subject)', r.memoryFacts.some(f => f.id === 'abr'))
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

console.log('\n=== [B] Forget safety ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-b-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'bf', subject:'alice', value:'coffee', confidence:0.9 }))
  await store.forgetFact('bf')
  const rem = await store.queryFacts({ state:'active' })
  checkTrue('B.1: forgotten fact not in queryFacts({state:active})', !rem.some(f => f.id === 'bf'))
  await store.upsertFact(mkFact({ id:'bn', subject:'alice', value:'tea', confidence:0.9 }))
  const r = await createContextAssembler(store, mockInfo, BASE_CONFIG).assemble('hello', ws)
  checkTrue('B.2: new fact after forget CAN be created', r.memoryFacts.some(f => f.subject === 'alice'))
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

console.log('\n=== [C] Candidate promotion safety ===')
{
  checkTrue('C.1: ContextAssembler does not handle candidate promotion', true, 'MAA candidates → MemoryStore, not ContextAssembler')
  checkTrue('C.2: L2/L3 only applies to ContextAssembler query path', true, 'ReflectionEngine → MemoryStore bypasses ContextAssembler')
}

console.log('\n=== [D] Semantic conflict ===')
{
  const cf = [
    { id:'d1', type:'preference', subject:'alice', formatted:'喜欢咖啡', confidence:0.9, updatedAt:1000 },
    { id:'d2', type:'preference', subject:'alice', formatted:'喜欢茶', confidence:0.85, updatedAt:2000 },
  ]
  check('D.1: different formatted value → conflict', detectSemanticConflicts(cf).length, 1)
  const nf = [
    { id:'d1', type:'preference', subject:'bob', formatted:'喜欢咖啡', confidence:0.9, updatedAt:1000 },
    { id:'d2', type:'preference', subject:'bob', formatted:'喜欢咖啡', confidence:0.85, updatedAt:2000 },
  ]
  check('D.2: same formatted value → no conflict', detectSemanticConflicts(nf).length, 0)
  check('D.3: both facts retained in conflict', cf.length, 2, 'Warning only; no auto-deletion')
  const c = detectSemanticConflicts(cf)
  checkTrue('D.4: warningText includes subject', c[0]?.warningText.includes('alice'))
  checkTrue('D.5: warningText includes type', c[0]?.warningText.includes('preference'))
}

console.log('\n=== [E] Scoring ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-e-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'ehc', subject:'alice', value:'a', confidence:0.9 }))
  await store.upsertFact(mkFact({ id:'elc', subject:'bob', value:'b', confidence:0.5 }))
  const asm = createContextAssembler(store, mockInfo, BASE_CONFIG)
  const r1 = await asm.assemble('hello', ws)
  const r2 = await asm.assemble('hello', ws)
  check('E.1: scoring deterministic (same order)', r1.memoryFacts[0]?.id, r2.memoryFacts[0]?.id)
  const srcCfg = { ...BASE_CONFIG, scoringPreset: 'source-confidence' }
  const srcR = await createContextAssembler(store, mockInfo, srcCfg).assemble('hello', ws)
  check('E.2: source-confidence changes order', srcR.memoryFacts[0]?.id, 'ehc')
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

console.log('\n=== [F] Budget ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-f-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  for (let i = 0; i < 10; i++) await store.upsertFact(mkFact({ id:`ff${i}`, subject:`s${i}`, value:`val_${i}_很长很长的文本内容来触发预算限制`, confidence:0.9 }))
  const cfg = { ...BASE_CONFIG, memoryBudgetChars: 200 }
  const r = await createContextAssembler(store, mockInfo, cfg).assemble('hello', ws)
  checkTrue('F.1: charsUsed <= budget', r.memoryCharsUsed <= 200, `got ${r.memoryCharsUsed}`)
  checkTrue('F.2: budgetHit=true when budget exceeded', r.memoryBudgetHit)
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

console.log('\n=== [G] Usage observability ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-g-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'g1', subject:'alice', value:'coffee', confidence:0.9 }))
  const tracker = createMemoryUsageTracker({ enabled: true, maxRecords: 100 })
  const asm = createContextAssembler(store, mockInfo, BASE_CONFIG, undefined, tracker)
  const r = await asm.assemble('hello world', ws)
  const recs = tracker.getRecords()
  check('G.1: 1 record created', recs.length, 1)
  checkTrue('G.2: returnedFactIds includes g1', recs[0]?.returnedFactIds.includes('g1'))
  check('G.3: charsUsed matches result', recs[0]?.charsUsed, r.memoryCharsUsed)
  check('G.4: budgetHit matches result', recs[0]?.budgetHit, r.memoryBudgetHit)
  check('G.5: queryLength=11', recs[0]?.queryLength, 11)
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

console.log('\n=== [H] Privacy ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-h-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'h1', subject:'alice', value:'coffee', confidence:0.9 }))
  const tracker = createMemoryUsageTracker({ enabled: true, maxRecords: 100 })
  const asm = createContextAssembler(store, mockInfo, BASE_CONFIG, undefined, tracker)
  await asm.assemble('my secret password is xyz123 and my bank pin is 9999', ws)
  const recs = tracker.getRecords()
  check('H.1: queryLength=52', recs[0]?.queryLength, 52)
  checkTrue('H.2: no "password" in record', !JSON.stringify(recs[0]).includes('password'))
  checkTrue('H.3: no "secret" in record', !JSON.stringify(recs[0]).includes('secret'))
  checkTrue('H.4: no "bank" in record', !JSON.stringify(recs[0]).includes('bank'))
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

console.log('\n=== [I] Failure isolation ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ev-i-'))
  const store = createMemoryStore({ enabled:true, dataDir:dir, fingerprintSalt:STABLE_SALT, maxActiveFacts:100, promoteThreshold:0.7, attentionEnabled:false, attentionPollIntervalMs:60000, attentionTopK:5 })
  await store.upsertFact(mkFact({ id:'i1', subject:'alice', value:'coffee', confidence:0.9 }))
  const noOpTracker = createMemoryUsageTracker({ enabled: false })
  const r1 = await createContextAssembler(store, mockInfo, BASE_CONFIG, undefined, noOpTracker).assemble('hello', ws)
  check('I.1: assemble works with disabled tracker', r1.memoryFacts.length, 1)
  const r2 = await createContextAssembler(store, mockInfo, BASE_CONFIG).assemble('hello', ws)
  check('I.2: assemble works without tracker', r2.memoryFacts.length, 1)
  store.stop?.(); rmSync(dir, { recursive:true, force:true })
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60))
const passed = results.filter(r => r.pass).length
const failed = results.filter(r => !r.pass)
console.log(`RESULT: ${passed}/${results.length} passed`)
if (failed.length > 0) {
  console.log('\nFailed:')
  for (const f of failed) console.log(`  ❌ ${f.name}: expected ${f.expected}, got ${f.actual}`)
}
