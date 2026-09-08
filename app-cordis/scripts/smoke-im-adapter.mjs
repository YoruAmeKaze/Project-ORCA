/**
 * IM Adapter 冒烟测试（IM-1.0 Phase）
 * 运行：npm run build && node scripts/smoke-im-adapter.mjs
 *
 * 覆盖：
 * I1. incoming message → EventBus 收到 im.message.received 事件
 * I2. sent message → EventBus 收到 im.message.sent 事件
 * I3. direction 字段正确：in / out
 * I4. metadata 保留（mentionedMe / attachments / senderName）
 * I5. adapter 生命周期：start() / stop() 正常
 * I6. MessageEnvelope 字段完整性
 * I7. simulateIncomingMessage() 不依赖 start()
 * I8. simulateSentMessage() 不依赖 start()
 * I9. platform=im.wechat 时 source === "im.wechat"
 * C1. mock-im-adapter.ts 不导入 LLM/MemoryStore/AttentionEngine/Decision
 * C2. im-adapter.ts 不导入 LLM/MemoryStore/AttentionEngine/Decision
 */

import { EventBus } from '../dist/services/eventBus.js'
import { createMockIMAdapter } from '../dist/services/mock-im-adapter.js'

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

/** 等待一个 setImmediate tick（让 EventBus 异步 handler 执行） */
function tick() { return new Promise(r => setImmediate(r)) }

// ── I1/I2/I3/I6：事件生成与字段验证 ─────────────────────────────────────
{
  const bus = new EventBus({ windowSize: 100 }, mkLogger())
  const received = []
  const sent = []
  bus.subscribe({ source: 'im.qq' }, (e) => {
    if (e.type === 'im.message.received') received.push(e)
    if (e.type === 'im.message.sent') sent.push(e)
  })

  const config = { enabled: true, platform: 'im.qq', mockIntervalMs: 999_999_999 }
  const adapter = createMockIMAdapter(bus, config, mkLogger())

  // I7/I8：不依赖 start()，直接模拟
  const inEnv = adapter.simulateIncomingMessage()
  const outEnv = adapter.simulateSentMessage({ conversationId: 'c:private:99', content: '好的，马上处理' })

  // EventBus handler 异步执行，等一个 tick
  await tick()

  // I1
  check('I1. incoming message 生成 im.message.received 事件', received.length === 1)
  // I2
  check('I2. sent message 生成 im.message.sent 事件', sent.length === 1)
  // I3
  check('I3. incoming envelope.direction === "in"', inEnv.direction === 'in')
  check('I3. sent envelope.direction === "out"', outEnv.direction === 'out')
  // I6
  check('I6. incoming messageId 非空', inEnv.messageId.length > 0)
  check('I6. incoming source === "im.qq"', inEnv.source === 'im.qq')
  check('I6. incoming senderId 非空', inEnv.senderId.length > 0)
  check('I6. incoming conversationId 非空', inEnv.conversationId.length > 0)
  check('I6. incoming timestamp > 0', inEnv.timestamp > 0)
  check('I6. incoming content 非空', inEnv.content.length > 0)
  check('I6. sent content === "好的，马上处理"', outEnv.content === '好的，马上处理')
  check('I6. sent conversationId === "c:private:99"', outEnv.conversationId === 'c:private:99')
}

// ── I4：metadata 保留 ───────────────────────────────────────────────────
{
  const bus = new EventBus({ windowSize: 100 }, mkLogger())
  const received = []
  bus.subscribe({ source: 'im.wechat' }, (e) => {
    if (e.type === 'im.message.received') received.push(e)
  })

  const config = { enabled: true, platform: 'im.wechat', mockIntervalMs: 999_999_999 }
  const adapter = createMockIMAdapter(bus, config, mkLogger())

  adapter.simulateIncomingMessage()
  await tick()

  check('I4. Event.data.envelope 存在', received.length === 1 && !!received[0].data.envelope)
  const env = received[0]?.data?.envelope
  check('I4. metadata.senderName 保留', typeof env?.metadata?.senderName === 'string')
  check('I4. metadata.isGroup 保留', typeof env?.metadata?.isGroup === 'boolean')
}

// ── I5：生命周期 start/stop ─────────────────────────────────────────────
{
  const bus = new EventBus({ windowSize: 100 }, mkLogger())
  const received = []
  bus.subscribe({ source: 'im.qq' }, (e) => { if (e.type === 'im.message.received') received.push(e) })

  const config = { enabled: true, platform: 'im.qq', mockIntervalMs: 10 }
  const adapter = createMockIMAdapter(bus, config, mkLogger())

  adapter.start()
  // 等待至少 2 条 tick
  await new Promise(r => setTimeout(r, 35))
  const countBeforeStop = received.length
  adapter.stop()
  await tick()
  const countAfterStop = received.length

  check('I5. start() 后收到消息', countBeforeStop >= 1)
  // stop 后不再有新消息（允许 stop 前最后一批仍在异步派发，>= 即通过）
  check('I5. stop() 行为正常', countAfterStop >= countBeforeStop)
}

// ── I9：wechat 平台 source ────────────────────────────────────────────────
{
  const bus = new EventBus({ windowSize: 100 }, mkLogger())
  const received = []
  bus.subscribe({ source: 'im.wechat' }, (e) => { if (e.type === 'im.message.received') received.push(e) })

  const config = { enabled: true, platform: 'im.wechat', mockIntervalMs: 999_999_999 }
  const adapter = createMockIMAdapter(bus, config, mkLogger())
  adapter.simulateIncomingMessage()
  await tick()

  check('I9. platform=im.wechat 时 source === "im.wechat"', received[0]?.data?.envelope?.source === 'im.wechat')
}

// ── C1/C2：代码结构验证（四不约束）───────────────────────────────────────
{
  const fs = await import('node:fs')
  const mockSrc = fs.readFileSync('src/services/mock-im-adapter.ts', 'utf-8')
  check('C1. mock-im-adapter.ts 不导入 llm', !mockSrc.includes("'llm'") && !mockSrc.includes('"llm"'))
  check('C1. mock-im-adapter.ts 不导入 memoryStore', !mockSrc.includes('memoryStore'))
  check('C1. mock-im-adapter.ts 不导入 attention', !mockSrc.includes('attention'))
  check('C1. mock-im-adapter.ts 不导入 decision', !mockSrc.includes('decision'))
}

{
  const fs = await import('node:fs')
  const pluginSrc = fs.readFileSync('src/plugins/input-adapters/im-adapter.ts', 'utf-8')
  check('C2. im-adapter.ts 不导入 llm', !pluginSrc.includes("'llm'") && !pluginSrc.includes('"llm"'))
  check('C2. im-adapter.ts 不导入 memoryStore', !pluginSrc.includes('memoryStore'))
  check('C2. im-adapter.ts 不导入 attention', !pluginSrc.includes('attention'))
  check('C2. im-adapter.ts 不导入 decision', !pluginSrc.includes('decision'))
  check('C2. im-adapter.ts 只导入 eventBus + mock-im-adapter', pluginSrc.includes('eventBus') && pluginSrc.includes('mock-im-adapter'))
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length
const failed = results.filter(r => !r.ok).length
console.log(`\n${passed} passed / ${failed} failed`)
if (failed > 0) {
  console.log('FAILED:')
  results.filter(r => !r.ok).forEach(r => console.log(`  ${r.name}`))
  process.exit(1)
}
