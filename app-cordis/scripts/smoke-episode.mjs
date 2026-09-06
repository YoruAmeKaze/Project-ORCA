/**
 * EpisodeEngine 冒烟测试（Phase 5.1）
 * 运行：npm run build && node scripts/smoke-episode.mjs
 *
 * 覆盖：
 *  E1   Episode CRUD（append/query/reload）
 *  E2   message.burst 生成（≥3 条消息）
 *  E3   message.burst 不重复生成（同一 sender）
 *  E4   state.transition 生成（user.status 转换）
 *  E5   TTL prune
 *  E6   restart reload（episodes.jsonl → 内存索引一致）
 *  E7   getTodayEpisodes
 *  E8   getRecentEpisodes
 *  E9   queryEpisodes 过滤（category/kind/entity）
 *  E10  pruneExpiredEpisodes 清理
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../dist/services/memoryStore.js'
import { EpisodeEngine } from '../dist/services/episodeEngine.js'

const STABLE_SALT = 'test-salt-episodes'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// ── 辅助 ─────────────────────────────────────────────────────────────────

function mkConfig(dir) {
  return {
    enabled: true,
    dataDir: dir,
    fingerprintSalt: STABLE_SALT,
    maxActiveFacts: 100,
    promoteThreshold: 0.7,
  }
}

function mkEpisode(overrides = {}) {
  const now = Date.now()
  return {
    id: overrides.id ?? `ep_${Math.random().toString(36).slice(2)}`,
    category: overrides.category ?? 'message',
    kind: overrides.kind ?? 'message.burst',
    summary: overrides.summary ?? 'test summary',
    ts: overrides.ts ?? now,
    entities: overrides.entities ?? ['user1'],
    sourceEventIds: overrides.sourceEventIds ?? ['evt_1'],
    importance: overrides.importance ?? 'normal',
    ttlDays: overrides.ttlDays ?? 7,
    state: overrides.state ?? 'active',
    ...overrides,
  }
}

/** 模拟一个 feishu message OrcaEvent */
function mkFeishuEvent(id, openId, text, ts) {
  return {
    id,
    source: 'feishu',
    type: 'message',
    priority: 1,
    ts,
    data: { openId, text, chatId: 'test_chat', messageId: id },
  }
}

// ── E1: Episode CRUD ───────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e1-'))
  const store = createMemoryStore(mkConfig(dir))

  const ep = mkEpisode({ id: 'ep_crud', summary: 'CRUD test', entities: ['alice'] })
  await store.appendEpisode(ep)

  const all = await store.queryEpisodes({})
  check('E1.1: appendEpisode 后 queryEpisodes 返回 1 条', all.length === 1)
  check('E1.2: episode summary 正确', all[0]?.summary === 'CRUD test')
  check('E1.3: episode entities 正确', all[0]?.entities[0] === 'alice')
  check('E1.4: episode kind 正确', all[0]?.kind === 'message.burst')
  check('E1.5: episode state=active', all[0]?.state === 'active')
  check('E1.6: episode ttlDays 正确', all[0]?.ttlDays === 7)

  rmSync(dir, { recursive: true, force: true })
}

// ── E2: message.burst 生成 ─────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2-'))
  const store = createMemoryStore(mkConfig(dir))

  // 构造 mock Context
  const memory = store
  const mockCtx = {
    get: (k) => (k === 'memory' ? memory : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: () => () => {}, // unsubscribe returns noop
  }

  // burstMinCount=3, burstWindowMs=90000
  const engine = new EpisodeEngine(mockCtx, 7, 90_000, 3)

  const base = Date.now()
  // 发送 2 条消息（未达阈值）
  await engine.handleEvent(mkFeishuEvent('e1', 'alice', 'msg1', base))
  await engine.handleEvent(mkFeishuEvent('e2', 'alice', 'msg2', base + 10_000))
  let eps = await store.getRecentEpisodes(10)
  check('E2.1: 2 条消息时无 burst episode', eps.length === 0)

  // 第 3 条消息，触发 burst
  await engine.handleEvent(mkFeishuEvent('e3', 'alice', 'msg3', base + 20_000))
  eps = await store.getRecentEpisodes(10)
  check('E2.2: ≥3 条消息后产生 burst episode', eps.length === 1)
  check('E2.3: burst episode kind=message.burst', eps[0]?.kind === 'message.burst')
  check('E2.4: burst episode entities 包含 alice', eps[0]?.entities.includes('alice'))
  check('E2.5: burst episode sourceEventIds 有 3 条', eps[0]?.sourceEventIds.length === 3)
  check('E2.6: burst episode summary 包含 3', eps[0]?.summary.includes('3'))

  rmSync(dir, { recursive: true, force: true })
}

// ── E3: burst 不重复生成 ────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e3-'))
  const store = createMemoryStore(mkConfig(dir))

  const memory = store
  const mockCtx = {
    get: (k) => (k === 'memory' ? memory : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: () => () => {},
  }

  const engine = new EpisodeEngine(mockCtx, 7, 90_000, 3)

  const base = Date.now()
  // 第一轮 burst
  await engine.handleEvent(mkFeishuEvent('eb1', 'bob', 'hi', base))
  await engine.handleEvent(mkFeishuEvent('eb2', 'bob', 'hi2', base + 20_000))
  await engine.handleEvent(mkFeishuEvent('eb3', 'bob', 'hi3', base + 40_000))

  let eps = await store.getRecentEpisodes(10)
  check('E3.1: 第一轮 burst 产生 1 条', eps.length === 1)

  // 继续发消息，不应触发新的 burst episode（已标记 done）
  await engine.handleEvent(mkFeishuEvent('eb4', 'bob', 'hi4', base + 60_000))
  await engine.handleEvent(mkFeishuEvent('eb5', 'bob', 'hi5', base + 80_000))

  eps = await store.getRecentEpisodes(10)
  check('E3.2: 同一 sender 不重复生成 burst', eps.length === 1)

  rmSync(dir, { recursive: true, force: true })
}

// ── E4: state.transition 生成 ─────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e4-'))
  const store = createMemoryStore(mkConfig(dir))

  const memory = store
  const mockCtx = {
    get: (k) => (k === 'memory' ? memory : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: () => () => {},
  }

  const engine = new EpisodeEngine(mockCtx)

  const prevState = { user: { status: 'away' }, device: {}, time: {}, extensions: {} }
  const newState = { user: { status: 'active' }, device: {}, time: {}, extensions: {} }

  await engine.handleStateChange(newState, prevState)

  const eps = await store.getRecentEpisodes(10)
  check('E4.1: away→active 产生 state.transition episode', eps.length === 1)
  check('E4.2: kind=state.transition', eps[0]?.kind === 'state.transition')
  check('E4.3: category=state', eps[0]?.category === 'state')
  check('E4.4: entities 包含 user', eps[0]?.entities.includes('user'))
  check('E4.5: away→active importance=normal（不是 high）', eps[0]?.importance === 'normal')
  check('E4.6: sourceEventIds 为空（state_changed 无 eventId）', eps[0]?.sourceEventIds.length === 0)

  // 测试 sleeping→active（高重要性）
  const prevSleep = { user: { status: 'sleeping' }, device: {}, time: {}, extensions: {} }
  const newAwake = { user: { status: 'active' }, device: {}, time: {}, extensions: {} }
  await engine.handleStateChange(newAwake, prevSleep)

  const eps2 = await store.getRecentEpisodes(10)
  check('E4.7: sleeping→active 高优先级', eps2.find((e) => e.kind === 'state.transition')?.importance === 'high')

  // 测试无意义转换（same status）不产生 episode
  const sameState = { user: { status: 'active' }, device: {}, time: {}, extensions: {} }
  await engine.handleStateChange(sameState, newState)

  const eps3 = await store.getRecentEpisodes(10)
  check('E4.8: 同状态转换不产生 episode', eps3.length === eps2.length)

  rmSync(dir, { recursive: true, force: true })
}

// ── E5: TTL prune（episodes 不应过期，正常查询保留）────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e5-'))
  const store = createMemoryStore(mkConfig(dir))

  const ep = mkEpisode({ id: 'ep_ttl', summary: 'ttl test', ts: Date.now() - 6 * 86_400_000 })
  await store.appendEpisode(ep)

  const before = await store.queryEpisodes({})
  check('E5.1: 未到期 episode 仍可查询', before.length === 1)

  // 写入一条已过期的 episode（ts = 8 天前）
  const expired = mkEpisode({ id: 'ep_expired', summary: 'expired', ts: Date.now() - 8 * 86_400_000, ttlDays: 7 })
  await store.appendEpisode(expired)

  const count = await store.pruneExpiredEpisodes()
  check('E5.2: pruneExpiredEpisodes 返回 ≥1', count >= 1)

  const after = await store.queryEpisodes({})
  check('E5.3: 已过期 episode 被移除', after.every((e) => e.id !== 'ep_expired'))

  rmSync(dir, { recursive: true, force: true })
}

// ── E6: restart reload ─────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e6-'))

  // 写入 episodes
  {
    const store = createMemoryStore(mkConfig(dir))
    await store.appendEpisode(mkEpisode({ id: 'ep_r1', summary: 'reload test 1' }))
    await store.appendEpisode(mkEpisode({ id: 'ep_r2', summary: 'reload test 2', kind: 'state.transition', category: 'state' }))
    const count = store.getEpisodeCountForTest()
    check('E6.1: 写入 2 条后 count=2', count === 2)
  }

  // 重启新 store
  {
    const store2 = createMemoryStore(mkConfig(dir))
    const eps = await store2.queryEpisodes({})
    check('E6.2: restart 后 queryEpisodes 返回 2 条', eps.length === 2)
    const summaries = eps.map((e) => e.summary).sort()
    check('E6.3: restart 后数据完整', summaries.join(',') === 'reload test 1,reload test 2')
    const r2 = eps.find((e) => e.id === 'ep_r2')
    check('E6.4: restart 后 kind 正确', r2?.kind === 'state.transition')
  }

  rmSync(dir, { recursive: true, force: true })
}

// ── E7: getTodayEpisodes ────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e7-'))
  const store = createMemoryStore(mkConfig(dir))

  const now = Date.now()
  const todayStart = new Date().setHours(0, 0, 0, 0)

  await store.appendEpisode(mkEpisode({ id: 'ep_today', summary: 'today ep', ts: now }))
  await store.appendEpisode(mkEpisode({ id: 'ep_yest', summary: 'yesterday ep', ts: todayStart - 86_400_000 }))

  const today = await store.getTodayEpisodes()
  check('E7.1: getTodayEpisodes 返回今天 episode', today.length === 1)
  check('E7.2: 今天 episode id 正确', today[0]?.id === 'ep_today')

  rmSync(dir, { recursive: true, force: true })
}

// ── E8: getRecentEpisodes ──────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e8-'))
  const store = createMemoryStore(mkConfig(dir))

  const now = Date.now()
  for (let i = 0; i < 10; i++) {
    await store.appendEpisode(mkEpisode({ id: `ep_recent_${i}`, summary: `recent ${i}`, ts: now - i * 60_000 }))
  }

  const recent5 = await store.getRecentEpisodes(5)
  check('E8.1: getRecentEpisodes(5) 返回 5 条', recent5.length === 5)
  check('E8.2: 默认按 ts 降序', recent5[0]?.id === 'ep_recent_0')

  const recentAll = await store.getRecentEpisodes(100)
  check('E8.3: 不传 limit 默认最多 50 条', recentAll.length <= 50)

  rmSync(dir, { recursive: true, force: true })
}

// ── E9: queryEpisodes 过滤 ───────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e9-'))
  const store = createMemoryStore(mkConfig(dir))

  await store.appendEpisode(mkEpisode({ id: 'ep_msg', category: 'message', kind: 'message.burst', entities: ['alice'] }))
  await store.appendEpisode(mkEpisode({ id: 'ep_state', category: 'state', kind: 'state.transition', entities: ['user'] }))

  const msgOnly = await store.queryEpisodes({ category: 'message' })
  check('E9.1: category=message 过滤正确', msgOnly.length === 1 && msgOnly[0]?.id === 'ep_msg')

  const stateOnly = await store.queryEpisodes({ category: 'state' })
  check('E9.2: category=state 过滤正确', stateOnly.length === 1 && stateOnly[0]?.id === 'ep_state')

  const entityFilter = await store.queryEpisodes({ entity: 'alice' })
  check('E9.3: entity=alice 过滤正确', entityFilter.length === 1 && entityFilter[0]?.id === 'ep_msg')

  const kindFilter = await store.queryEpisodes({ kind: 'state.transition' })
  check('E9.4: kind=state.transition 过滤正确', kindFilter.length === 1 && kindFilter[0]?.id === 'ep_state')

  rmSync(dir, { recursive: true, force: true })
}

// ── E10: pruneExpiredEpisodes 重启持久化 ───────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e10-'))

  // 写入一条已过期 episode
  {
    const store = createMemoryStore(mkConfig(dir))
    await store.appendEpisode(mkEpisode({ id: 'ep_will_prune', summary: 'will prune', ts: Date.now() - 10 * 86_400_000 }))
    const count = await store.pruneExpiredEpisodes()
    check('E10.1: pruneExpiredEpisodes 返回 1', count === 1)
    const remaining = await store.queryEpisodes({})
    check('E10.2: prune 后剩余 0 条', remaining.length === 0)
  }

  // 重启验证过期 episode 未持久化
  {
    const store2 = createMemoryStore(mkConfig(dir))
    const eps = await store2.queryEpisodes({})
    check('E10.3: restart 后过期 episode 未重新加载', eps.length === 0)
  }

  rmSync(dir, { recursive: true, force: true })
}

// ── E11: burst 跨 sender 隔离 ─────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e11-'))
  const store = createMemoryStore(mkConfig(dir))

  const memory = store
  const mockCtx = {
    get: (k) => (k === 'memory' ? memory : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: () => () => {},
  }

  const engine = new EpisodeEngine(mockCtx, 7, 90_000, 3)
  const base = Date.now()

  // alice 触发 burst
  await engine.handleEvent(mkFeishuEvent('ea1', 'alice', 'a1', base))
  await engine.handleEvent(mkFeishuEvent('ea2', 'alice', 'a2', base + 20_000))
  await engine.handleEvent(mkFeishuEvent('ea3', 'alice', 'a3', base + 40_000))

  // bob 触发 burst（独立 sender，不受 alice 影响）
  await engine.handleEvent(mkFeishuEvent('eb1', 'bob', 'b1', base + 50_000))
  await engine.handleEvent(mkFeishuEvent('eb2', 'bob', 'b2', base + 70_000))
  await engine.handleEvent(mkFeishuEvent('eb3', 'bob', 'b3', base + 90_000))

  const eps = await store.getRecentEpisodes(10)
  check('E11.1: 两个 sender 各产生 1 条 burst', eps.length === 2)
  const aliceEps = eps.filter((e) => e.entities.includes('alice'))
  const bobEps = eps.filter((e) => e.entities.includes('bob'))
  check('E11.2: alice 有 1 条', aliceEps.length === 1)
  check('E11.3: bob 有 1 条', bobEps.length === 1)

  rmSync(dir, { recursive: true, force: true })
}

// ── E12: importance 阈值（5+ 条 = high）───────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'orca-e12-'))
  const store = createMemoryStore(mkConfig(dir))

  const memory = store
  const mockCtx = {
    get: (k) => (k === 'memory' ? memory : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: () => () => {},
  }

  const engine = new EpisodeEngine(mockCtx, 7, 90_000, 3)
  const base = Date.now()

  // 发送 5 条消息
  for (let i = 0; i < 5; i++) {
    await engine.handleEvent(mkFeishuEvent(`el${i}`, 'long_user', `msg${i}`, base + i * 15_000))
  }

  const eps = await store.getRecentEpisodes(5)
  const burst = eps.find((e) => e.kind === 'message.burst')
  check('E12.1: 3 条消息 burst importance=normal（≥5 才 high）', burst?.importance === 'normal')

  rmSync(dir, { recursive: true, force: true })
}

// ── 结果 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-episode 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-episode 失败 ${failed.length} 项`)
}
