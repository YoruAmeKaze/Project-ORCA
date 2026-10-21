import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../dist/services/memoryStore.js'

const dir = mkdtempSync(join(tmpdir(), 'orca-category-'))
const store = createMemoryStore({ enabled: true, dataDir: dir, fingerprintSalt: 'test-salt', maxActiveFacts: 100 })
const base = { id: 'fact-category', type: 'preference', subject: 'coffee', value: '燕麦', confidence: 0.9, source: 'user-explicit', state: 'active', representativeEvidenceIds: [], evidenceCount: 1, createdAt: Date.now(), updatedAt: Date.now(), createdBy: 'user-explicit', privacyLevel: 'L1' }
await store.upsertFact({ ...base, category: { domain: 'ordering', subdomain: 'luckin', function: 'products' } })
assert.equal((await store.queryFacts({ category: { domain: 'ordering' } })).length, 1)
assert.equal((await store.queryFacts({ category: { subdomain: 'mcdonalds' } })).length, 0)
await store.upsertFact({ ...base, value: '无糖燕麦', category: { domain: 'not-registered', subdomain: 'x', function: 'y' } })
const fact = (await store.queryFacts({ subject: 'coffee' }))[0]
assert.equal(fact?.category?.domain, 'uncategorized')
rmSync(dir, { recursive: true, force: true })
console.log('smoke-memory-category: PASS')
