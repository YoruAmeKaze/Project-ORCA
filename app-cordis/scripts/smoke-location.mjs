import assert from 'node:assert/strict'
import { createCurrentLocationHandler, createLocationService } from '../dist/services/location.js'

const config = { enabled: true, timeoutMs: 1_000, cacheTtlMs: 2_000 }
let now = 1000
const service = createLocationService(config, {
  now: () => now,
  read: async () => ({ latitude: 29.55, longitude: 106.45, accuracyMeters: 25 }),
})
const handler = createCurrentLocationHandler(service)
const result = await handler.execute({
  action: 'location.current', decisionId: 'location-smoke', attentionId: 'attention-smoke',
  ruleId: 'smoke', reason: '{}', eventId: 'dashboard-smoke', priority: 'normal', decidedAt: now,
})
assert.equal(result.success, true)
assert.match(result.message ?? '', /已获取本机当前位置/)
assert.equal(JSON.stringify(result).includes('29.55'), false)
assert.equal(JSON.stringify(result).includes('106.45'), false)
assert.ok(service.getLatest())
now += 2_000
assert.equal(service.getLatest(), undefined)

const failed = createCurrentLocationHandler(createLocationService(config, {
  read: async () => { throw new Error('系统没有位置数据') },
}))
const failure = await failed.execute({
  action: 'location.current', decisionId: 'location-failure', attentionId: 'attention-smoke',
  ruleId: 'smoke', reason: '{}', eventId: 'dashboard-smoke', priority: 'normal', decidedAt: Date.now(),
})
assert.equal(failure.success, false)
assert.equal(failure.message, '系统没有位置数据')
console.log('PASS location.current: success, expiry, failure feedback, coordinate privacy')
