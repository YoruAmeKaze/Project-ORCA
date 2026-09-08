/**
 * IM Observation 冒烟测试（IM-1.5A Phase）
 * 运行：node scripts/smoke-im-observation.mjs
 *
 * 覆盖：
 * O1. im.message.received → CommunicationSignal
 * O2. im.message.sent → CommunicationSignal
 * O3. signal 不包含 content / text / summary
 * O4. Observation 不调用 MemoryStore（代码结构验证）
 * O5. Episode 可保存 im.burst（类型扩展验证）
 * O6. restart / prune 行为（burst tracker 内存正确清理）
 * B1. burst 检测：3条消息内触发 burst.detected
 * B2. burst 后 tracker 重置，不重复触发
 */

import { EventBus } from '../dist/services/eventBus.js'
import { createMockIMAdapter } from '../dist/services/mock-im-adapter.js'
import { createIMObservationAdapter } from '../dist/services/im-observation-adapter.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function mkLogger() {
  return {
    info() {},
    warn() {},
  }
}

function tick() { return new Promise(r => setImmediate(r)) }

/**
 * 构造一个 im.message.received OrcaEvent
 */
function makeIMEvent(type, envelope) {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    source: envelope.source,
    type,
    timestamp: envelope.timestamp,
    data: { envelope },
    priority: 1,
  }
}

// ── O1/O2：message.received / message.sent → CommunicationSignal ──────────
{
  const bus = new EventBus({ windowSize: 100 }, mkLogger())
  const signals = []
  const config = { enabled: true, burstWindowMs: 999_999_999, burstMinCount: 3, emitEpisodes: false }
  const adapter = createIMObservationAdapter({ onSignal(s) { signals.push(s) } }, config, mkLogger())

  const imAdapter = createMockIMAdapter(bus, { enabled: true, platform: 'im.qq', mockIntervalMs: 999_999_999 }, mkLogger())

  // 触发 incoming
  imAdapter.simulateIncomingMessage()
  // 触发 sent
  imAdapter.simulateSentMessage({ conversationId: 'c:private:1', content: 'test' })

  // adapter 通过 EventBus 订阅处理
  // 需要手动调用 adapter.handleEvent，因为 smoke test 不挂载 plugin
  const events = []
  bus.subscribe({ source: 'im.qq' }, e => events.push(e))
  imAdapter.simulateIncomingMessage()
  await tick()
  for (const e of events) adapter.handleEvent(e)
  imAdapter.simulateSentMessage({ conversationId: 'c:private:2', content: 'test' })
  await tick()
  const events2 = []
  bus.subscribe({ source: 'im.qq' }, e => events2.push(e))
  // 直接模拟 adapter 处理：手动创建 signal
  // O1/O2 实际上只验证 adapter.handleEvent 正确路由
}

// ── 直接测试 adapter.handleEvent ─────────────────────────────────────────
{
  const signals = []
  const config = { enabled: true, burstWindowMs: 999_999_999, burstMinCount: 3, emitEpisodes: false }
  const adapter = createIMObservationAdapter({ onSignal(s) { signals.push(s) } }, config, mkLogger())

  const recvEvent = makeIMEvent('im.message.received', {
    source: 'im.qq', senderId: 'alice', conversationId: 'c:private:1', timestamp: Date.now(),
    direction: 'in', metadata: { isGroup: false }
  })
  const sentEvent = makeIMEvent('im.message.sent', {
    source: 'im.qq', senderId: 'orca-self', conversationId: 'c:private:1', timestamp: Date.now(),
    direction: 'out', metadata: { isGroup: false }
  })

  adapter.handleEvent(recvEvent)
  adapter.handleEvent(sentEvent)

  check('O1. message.received 生成 signal', signals.some(s => s.signalType === 'message.received'))
  check('O2. message.sent 生成 signal', signals.some(s => s.signalType === 'message.sent'))
  check('O1. signal 含 senderId', signals.find(s => s.signalType === 'message.received')?.senderId === 'alice')
  check('O2. signal 含 conversationId', signals.find(s => s.signalType === 'message.sent')?.conversationId === 'c:private:1')
}

// ── O3：signal 不包含 content ─────────────────────────────────────────────
{
  const signals = []
  const adapter = createIMObservationAdapter(
    { onSignal(s) { signals.push(s) } },
    { enabled: true, burstWindowMs: 999_999_999, burstMinCount: 3, emitEpisodes: false },
    mkLogger()
  )

  adapter.handleEvent(makeIMEvent('im.message.received', {
    source: 'im.qq', senderId: 'alice', conversationId: 'c:private:1', timestamp: Date.now(),
    direction: 'in',
    content: '这是秘密消息内容！',  // ← 这个 content 字段不应该出现在 signal 中
    metadata: { isGroup: false }
  }))

  const sig = signals[0]
  check('O3. signal 不含 content/text 字段', !('content' in sig) && !('text' in sig) && !('summary' in sig))
  check('O3. signal.signalType 存在', sig.signalType === 'message.received')
  check('O3. signal.senderId 存在', sig.senderId === 'alice')
}

// ── O4：代码结构验证（不调用 MemoryStore）────────────────────────────────
{
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/services/im-observation-adapter.ts', 'utf-8')
  // 检查是否导入了这些模块（精确：import ... from '...' 包含特定字符串）
  const importPattern = (mod) => new RegExp(`import\\s+.*from\\s+['\"].*${mod}[ '\"]`).test(src)
  check('O4. 不导入 memoryStore', !importPattern('memory') && !importPattern('Memory'))
  check('O4. 不导入 llm', !importPattern('llm'))
  check('O4. 不导入 attention', !importPattern('attention') && !importPattern('Attention'))
  check('O4. 不导入 decision', !importPattern('decision') && !importPattern('Decision'))
  check('O4. 不导入 action', !importPattern('action') && !importPattern('Action'))
}

{
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/plugins/im-observation-adapter.ts', 'utf-8')
  const importPattern = (mod) => new RegExp(`import\\s+.*from\\s+['\"].*${mod}[ '\"]`).test(src)
  check('O4. plugin 不导入 memoryStore', !importPattern('memory') && !importPattern('Memory'))
  check('O4. plugin 不导入 llm', !importPattern('llm'))
  check('O4. plugin 不导入 attention/decision', !importPattern('attention') && !importPattern('Attention'))
}

// ── O5：Episode 支持 im.burst ───────────────────────────────────────────
{
  const fs = await import('node:fs')
  const typesSrc = fs.readFileSync('src/types/memory.ts', 'utf-8')
  check('O5. Episode.kind 包含 im.burst', typesSrc.includes("'im.burst'"))
  check('O5. Episode.category 包含 communication', typesSrc.includes("'communication'"))
}

// ── O6：burst tracker 内存正确清理 ───────────────────────────────────────
{
  const signals = []
  const adapter = createIMObservationAdapter(
    { onSignal(s) { signals.push(s) } },
    { enabled: true, burstWindowMs: 10, burstMinCount: 3, emitEpisodes: false }, // 10ms 窗口
    mkLogger()
  )

  const now = Date.now()
  adapter.handleEvent(makeIMEvent('im.message.received', { source: 'im.qq', senderId: 'alice', conversationId: 'c:1', timestamp: now, direction: 'in', metadata: { isGroup: false } }))
  await tick()
  adapter.handleEvent(makeIMEvent('im.message.received', { source: 'im.qq', senderId: 'alice', conversationId: 'c:1', timestamp: now + 3, direction: 'in', metadata: { isGroup: false } }))
  await tick()
  // 窗口外过期，tracker 被清理
  await new Promise(r => setTimeout(r, 20))
  adapter.handleEvent(makeIMEvent('im.message.received', { source: 'im.qq', senderId: 'alice', conversationId: 'c:1', timestamp: now + 30, direction: 'in', metadata: { isGroup: false } }))
  await tick()

  // 旧 tracker 过期后，新消息作为第1条重新开始，不会立即 burst
  const burstSignals = signals.filter(s => s.signalType === 'burst.detected')
  check('O6. 过期 tracker 不产生错误 burst', burstSignals.length === 0)
}

// ── B1：burst 检测 ────────────────────────────────────────────────────────
{
  const signals = []
  const adapter = createIMObservationAdapter(
    { onSignal(s) { signals.push(s) } },
    { enabled: true, burstWindowMs: 60 * 60 * 1000, burstMinCount: 3, emitEpisodes: false },
    mkLogger()
  )

  const now = Date.now()
  for (let i = 0; i < 3; i++) {
    adapter.handleEvent(makeIMEvent('im.message.received', {
      source: 'im.qq', senderId: 'bob', conversationId: 'c:private:bob',
      timestamp: now + i * 1000, direction: 'in', metadata: { isGroup: false }
    }))
  }

  check('B1. 3条消息内触发 burst.detected', signals.some(s => s.signalType === 'burst.detected'))
  const burst = signals.find(s => s.signalType === 'burst.detected')
  check('B1. burst.signalType === "burst.detected"', burst?.signalType === 'burst.detected')
  check('B1. burst.senderId === "bob"', burst?.senderId === 'bob')
  check('B1. burst.burstDetail.messageCount === 3', burst?.burstDetail?.messageCount === 3)
  check('B1. burst.burstDetail.durationMs >= 0', burst?.burstDetail?.durationMs >= 0)
}

// ── B2：burst 后 tracker 重置，不重复触发 ───────────────────────────────
{
  const signals = []
  const adapter = createIMObservationAdapter(
    { onSignal(s) { signals.push(s) } },
    { enabled: true, burstWindowMs: 60 * 60 * 1000, burstMinCount: 3, emitEpisodes: false },
    mkLogger()
  )

  const now = Date.now()
  for (let i = 0; i < 3; i++) {
    adapter.handleEvent(makeIMEvent('im.message.received', {
      source: 'im.qq', senderId: 'charlie', conversationId: 'c:private:charlie',
      timestamp: now + i * 1000, direction: 'in', metadata: { isGroup: false }
    }))
  }
  const burstCountBefore = signals.filter(s => s.signalType === 'burst.detected').length

  // 再发3条
  for (let i = 0; i < 3; i++) {
    adapter.handleEvent(makeIMEvent('im.message.received', {
      source: 'im.qq', senderId: 'charlie', conversationId: 'c:private:charlie',
      timestamp: now + 10000 + i * 1000, direction: 'in', metadata: { isGroup: false }
    }))
  }

  const burstCountAfter = signals.filter(s => s.signalType === 'burst.detected').length
  check('B2. burst 后 tracker 重置，第二次 burst 仍触发', burstCountAfter === 2)
}

// ── B3：群聊消息不触发 burst ─────────────────────────────────────────────
{
  const signals = []
  const adapter = createIMObservationAdapter(
    { onSignal(s) { signals.push(s) } },
    { enabled: true, burstWindowMs: 60 * 60 * 1000, burstMinCount: 3, emitEpisodes: false },
    mkLogger()
  )

  const now = Date.now()
  for (let i = 0; i < 5; i++) {
    adapter.handleEvent(makeIMEvent('im.message.received', {
      source: 'im.qq', senderId: 'alice', conversationId: 'c:group:1',
      timestamp: now + i * 1000, direction: 'in', metadata: { isGroup: true }  // ← 群聊
    }))
  }

  const burstSignals = signals.filter(s => s.signalType === 'burst.detected')
  check('B3. 群聊消息不触发 burst', burstSignals.length === 0)
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length
const failed = results.filter(r => !r.ok).length
console.log(`\n${passed} passed / ${failed} failed`)
if (failed > 0) {
  console.log('FAILED:')
  results.filter(r => !r.ok).forEach(r => console.log(`  ${r.name}`))
  process.exit(1)
}
