/**
 * JsonlSessionStore 冒烟测试（Phase 7.3 Session Persistence）
 * 运行：npm run build && node scripts/smoke-session-persistence.mjs
 *
 * 覆盖：
 * R1: push 后文件生成
 * R2: 新建实例能从 JSONL 恢复历史
 * R3: maxTurns 滑动窗口行为保持一致
 * R4: 多 session 隔离
 * R5: dashboard session
 * R6: clear 后重新读取为空
 * R7: 不存在文件时 get 返回空数组
 */

import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { JsonlSessionStore } from '../dist/services/sessionStore.js'

const TEST_DIR = join(process.cwd(), 'data', 'test-sessions-' + randomUUID().slice(0, 8))
mkdirSync(TEST_DIR, { recursive: true })

/** 复用 JsonlSessionStore 内部逻辑：sessionId → safe filename */
function safeFilename(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
}

/** 等待异步文件操作完成 */
async function flush(ms = 300) {
  await new Promise((r) => setTimeout(r, ms))
}

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// ---------- R1: push 后文件生成 ----------
{
  const store = new JsonlSessionStore(10, TEST_DIR)
  const sessionId = 'r1-' + randomUUID()
  store.push(sessionId, { role: 'user', content: 'hello' })
  store.push(sessionId, { role: 'assistant', content: 'hi' })
  await flush()

  const filePath = join(TEST_DIR, `${safeFilename(sessionId)}.jsonl`)
  check('R1.1: push 后 JSONL 文件已生成', existsSync(filePath))

  const lines = readFileSync(filePath, 'utf8').trim().split('\n')
  check('R1.2: 文件含 2 行', lines.length === 2)
  const [l1, l2] = lines
  const t1 = JSON.parse(l1)
  const t2 = JSON.parse(l2)
  check('R1.3: 第一行 role=user', t1.role === 'user')
  check('R1.4: 第一行 content=hello', t1.content === 'hello')
  check('R1.5: 第二行 role=assistant', t2.role === 'assistant')
  check('R1.6: 第二行 content=hi', t2.content === 'hi')

  store.clear(sessionId)
  await flush()
}

// ---------- R2: 新建实例能从 JSONL 恢复历史 ----------
{
  const sessionId = 'r2-' + randomUUID()
  const store1 = new JsonlSessionStore(10, TEST_DIR)
  store1.push(sessionId, { role: 'user', content: 'first' })
  store1.push(sessionId, { role: 'assistant', content: 'second' })
  await flush()

  const store2 = new JsonlSessionStore(10, TEST_DIR)
  await store2.reload(sessionId)
  const turns = store2.get(sessionId)
  check('R2.1: restart 后 get 返回 2 条', turns.length === 2)
  check('R2.2: 第一条 role=user', turns[0].role === 'user')
  check('R2.3: 第二条 role=assistant', turns[1].role === 'assistant')
  check('R2.4: 第一条 content=first', turns[0].content === 'first')
  check('R2.5: 第二条 content=second', turns[1].content === 'second')

  store1.clear(sessionId)
  await flush()
}

// ---------- R3: maxTurns 滑动窗口行为保持一致 ----------
{
  const MAX = 3
  const sessionId = 'r3-' + randomUUID()
  const store = new JsonlSessionStore(MAX, TEST_DIR)
  for (let i = 1; i <= 5; i++) {
    store.push(sessionId, { role: 'user', content: `msg-${i}` })
  }
  await flush()

  const turns = store.get(sessionId)
  check('R3.1: 超过 maxTurns 后只保留最近 3 条', turns.length === 3)
  check('R3.2: 第一条是 msg-3', turns[0].content === 'msg-3')
  check('R3.3: 最后一条是 msg-5', turns[2].content === 'msg-5')

  store.clear(sessionId)
  await flush()
}

// ---------- R4: 多 session 隔离 ----------
{
  const store = new JsonlSessionStore(10, TEST_DIR)
  const sidA = 'r4-a-' + randomUUID()
  const sidB = 'r4-b-' + randomUUID()
  store.push(sidA, { role: 'user', content: 'only-a' })
  store.push(sidB, { role: 'user', content: 'only-b' })
  store.push(sidA, { role: 'assistant', content: 'reply-a' })
  await flush()

  const a = store.get(sidA)
  const b = store.get(sidB)
  check('R4.1: session A 有 2 条', a.length === 2)
  check('R4.2: session A content=only-a', a[0].content === 'only-a')
  check('R4.3: session B 有 1 条', b.length === 1)
  check('R4.4: session B content=only-b', b[0].content === 'only-b')

  store.clear(sidA)
  store.clear(sidB)
  await flush()
}

// ---------- R5: dashboard session ----------
{
  const store = new JsonlSessionStore(10, TEST_DIR)
  const dashId = 'dashboard'
  store.push(dashId, { role: 'user', content: 'dashboard msg' })
  store.push(dashId, { role: 'assistant', content: 'dashboard reply' })
  await flush()

  const turns = store.get(dashId)
  check('R5.1: dashboard session 可写入', turns.length === 2)
  check('R5.2: dashboard 第一条 content 对', turns[0].content === 'dashboard msg')

  store.clear(dashId)
  await flush()
}

// ---------- R6: clear 后重新读取为空 ----------
{
  const sessionId = 'r6-' + randomUUID()
  const store1 = new JsonlSessionStore(10, TEST_DIR)
  store1.push(sessionId, { role: 'user', content: 'to-be-cleared' })
  await flush()
  store1.clear(sessionId)
  await flush()

  const store2 = new JsonlSessionStore(10, TEST_DIR)
  await store2.reload(sessionId)
  const turns = store2.get(sessionId)
  check('R6.1: clear 后文件已清空（restart 读为空）', turns.length === 0)
  check('R6.2: 内存缓存也已清空', store2.get(sessionId).length === 0)
}

// ---------- R7: 不存在文件时 get 返回空数组 ----------
{
  const store = new JsonlSessionStore(10, TEST_DIR)
  const unknown = 'never-exist-' + randomUUID()
  const turns = store.get(unknown)
  check('R7.1: 不存在的 sessionId 返回空数组', turns.length === 0)
}

// ---------- R8: 特殊字符 sessionId ----------
{
  const store = new JsonlSessionStore(10, TEST_DIR)
  const weirdId = 'user+special!@#session-id-' + randomUUID()
  store.push(weirdId, { role: 'user', content: 'special' })
  await flush()

  const turns = store.get(weirdId)
  check('R8.1: 特殊字符 sessionId 正常工作', turns.length === 1)
  check('R8.2: 内容正确', turns[0].content === 'special')
  store.clear(weirdId)
  await flush()
}

// ---------- 摘要 ----------
const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok).length
console.log(`\n${passed}/${results.length} PASS${failed > 0 ? `  (${failed} FAIL)` : ''}`)

// 清理测试目录
try {
  rmSync(TEST_DIR, { recursive: true, force: true })
  console.log('[teardown] 测试目录已清理')
} catch {
  // 忽略清理失败
}

if (failed > 0) process.exit(1)
