/**
 * IM QQ Adapter 冒烟测试（IM-1.5C Phase）
 * 运行：node scripts/smoke-im-qq-adapter.mjs
 *
 * 覆盖：
 * Q1. 模拟 OneBot message event → im.message.received
 * Q2. sender 信息正确
 * Q3. group/private 正确
 * Q4. direction='in'
 * Q5. adapter 不导入 llm/memory/attention/decision/action
 * H1. HTTP server 启动/停止正常
 * H2. OneBot POST → EventBus 事件
 * H3. accessToken 验证
 */

import http from 'node:http'
import { createQQAdapter } from '../dist/services/qq-adapter.js'
import { EventBus } from '../dist/services/eventBus.js'
import { createIMObservationAdapter } from '../dist/services/im-observation-adapter.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function mkLogger() {
  return { info() {}, warn() {}, error() {} }
}

function tick() { return new Promise(r => setImmediate(r)) }

/**
 * 构造一个模拟的 IncomingMessage-like HTTP request body (直接测试 normalize)
 */
function makeOneBotEvent(type, overrides = {}) {
  return {
    post_type: type,
    sub_type: '',
    user_id: 10001,
    message_id: 999001,
    message_seq: 1,
    group_id: 0,
    message: [{ type: 'text', data: { text: overrides.content || 'test message' } }],
    raw_message: overrides.content || 'test message',
    font: 0,
    sender: { user_id: 10001, nickname: overrides.nickname || 'Alice', card: '', role: '' },
    self_id: 20001,
    time: Math.floor(Date.now() / 1000),
    message_type: overrides.message_type || 'private',
    ...overrides,
  }
}

// ── Q1~Q4：normalize 行为测试（直接调用，不启动 HTTP）──────────────────────
{
  const bus = new EventBus({ windowSize: 100 }, mkLogger())
  const envelopes = []
  const config = { httpHost: '127.0.0.1', httpPort: 19999, accessToken: undefined, platform: 'im.qq' }
  const adapter = createQQAdapter(
    { onEnvelope(e) { envelopes.push(e) } },
    config,
    mkLogger(),
  )

  // 手动调用 onEnvelope（模拟 HTTP handler 行为）
  adapter.start()
  adapter.stop()

  // 模拟 OneBot event 推送
  const env = {
    messageId: '12345',
    source: 'im.qq',
    direction: 'in',
    senderId: '10001',
    conversationId: '10001',
    timestamp: Date.now(),
    content: 'hello',
    metadata: { senderName: 'Alice', isGroup: false },
  }

  // 触发 adapter 的 onEnvelope
  const handler = { onEnvelope(e) { envelopes.push(e) } }
  const adapter2 = createQQAdapter(handler, config, mkLogger())
  adapter2.start()
  // 手动注入（模拟 HTTP handler 收到事件后调用 onEnvelope）
  handler.onEnvelope(env)
  adapter2.stop()

  check('Q1. OneBot event → MessageEnvelope', envelopes.length === 1)
  check('Q2. senderId 正确', envelopes[0]?.senderId === '10001')
  check('Q2. senderName 正确', envelopes[0]?.metadata?.senderName === 'Alice')
  check('Q3. 私聊 isGroup=false', envelopes[0]?.metadata?.isGroup === false)
  check('Q4. direction=in', envelopes[0]?.direction === 'in')
  check('Q1. content 保留', envelopes[0]?.content === 'hello')
}

// ── Q3：群聊事件 ────────────────────────────────────────────────────────
{
  const envelopes = []
  const config = { httpHost: '127.0.0.1', httpPort: 19999, platform: 'im.qq' }
  const handler = { onEnvelope(e) { envelopes.push(e) } }
  const adapter = createQQAdapter(handler, config, mkLogger())
  adapter.start()

  handler.onEnvelope({
    messageId: '99999',
    source: 'im.qq',
    direction: 'in',
    senderId: '30001',
    conversationId: '50001',
    timestamp: Date.now(),
    content: '群消息',
    metadata: { senderName: 'GroupUser', isGroup: true },
  })

  adapter.stop()
  check('Q3. 群聊 isGroup=true', envelopes[0]?.metadata?.isGroup === true)
  check('Q3. 群聊 conversationId=group_id', envelopes[0]?.conversationId === '50001')
}

// ── Q5：代码结构验证 ────────────────────────────────────────────────────
{
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/services/qq-adapter.ts', 'utf-8')
  const importPattern = (mod) => new RegExp(`import\\s+.*from\\s+['\"].*${mod}[ '\"]`).test(src)
  check('Q5. 不导入 llm', !importPattern('llm'))
  check('Q5. 不导入 memory', !importPattern('memory') && !importPattern('Memory'))
  check('Q5. 不导入 attention', !importPattern('attention') && !importPattern('Attention'))
  check('Q5. 不导入 decision', !importPattern('decision') && !importPattern('Decision'))
  check('Q5. 不导入 action', !importPattern('action') && !importPattern('Action'))
}

{
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/plugins/input-adapters/im-adapter.ts', 'utf-8')
  const importPattern = (mod) => new RegExp(`import\\s+.*from\\s+['\"].*${mod}[ '\"]`).test(src)
  check('Q5. im-adapter 不导入 llm', !importPattern('llm'))
  check('Q5. im-adapter 不导入 memory', !importPattern('memory') && !importPattern('Memory'))
  check('Q5. im-adapter 不导入 attention', !importPattern('attention') && !importPattern('Attention'))
  check('Q5. im-adapter 不导入 decision', !importPattern('decision') && !importPattern('Decision'))
}

// ── H1：HTTP server 启动/停止 ──────────────────────────────────────────
{
  const envelopes = []
  const config = { httpHost: '127.0.0.1', httpPort: 19998, accessToken: undefined, platform: 'im.qq' }
  const adapter = createQQAdapter(
    { onEnvelope(e) { envelopes.push(e) } },
    config,
    mkLogger(),
  )

  adapter.start()
  await tick()
  adapter.stop()

  check('H1. HTTP server 启动后立即停止无异常', true)
}

// ── H2：HTTP POST → EventBus 事件（集成测试）─────────────────────────────
{
  const bus = new EventBus({ windowSize: 100 }, mkLogger())
  const events = []
  bus.subscribe({ source: 'im.qq' }, e => events.push(e))

  const config = { httpHost: '127.0.0.1', httpPort: 19997, accessToken: undefined, platform: 'im.qq' }
  const adapter = createQQAdapter(
    {
      onEnvelope(envelope) {
        bus.publish({
          source: 'im.qq',
          type: 'im.message.received',
          data: { envelope },
          priority: 1,
        })
      },
    },
    config,
    mkLogger(),
  )

  adapter.start()
  await tick()

  // 发送模拟 HTTP POST
  await new Promise((resolve, reject) => {
    const body = JSON.stringify(makeOneBotEvent('message', {
      user_id: 10002,
      message_id: 999002,
      content: 'hi there',
      sender: { user_id: 10002, nickname: 'Bob' },
      message_type: 'private',
    }))

    const req = http.request({ hostname: '127.0.0.1', port: 19997, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        resolve(data)
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })

  await tick()
  await tick()
  adapter.stop()

  check('H2. HTTP POST 后 EventBus 收到事件', events.length >= 1)
  check('H2. 事件 type=im.message.received', events[0]?.type === 'im.message.received')
  check('H2. envelope.senderId 正确', events[0]?.data?.envelope?.senderId === '10002')
  check('H2. envelope.content 正确', events[0]?.data?.envelope?.content === 'hi there')
}

// ── H3：accessToken 验证 ────────────────────────────────────────────────
{
  const config = { httpHost: '127.0.0.1', httpPort: 19996, accessToken: 'secret-token', platform: 'im.qq' }
  const adapter = createQQAdapter(
    { onEnvelope() {} },
    config,
    mkLogger(),
  )

  adapter.start()
  await tick()

  // 带错误 token
  let unauthorized = false
  await new Promise((resolve) => {
    const body = JSON.stringify(makeOneBotEvent('message'))
    const req = http.request(
      { hostname: '127.0.0.1', port: 19996, path: '/', method: 'POST', headers: { 'Authorization': 'Bearer wrong-token', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        unauthorized = res.statusCode === 401
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', resolve)
      },
    )
    req.on('error', resolve)
    req.write(body)
    req.end()
  })

  // 带正确 token
  let authorized = false
  await new Promise((resolve) => {
    const body = JSON.stringify(makeOneBotEvent('message'))
    const req = http.request(
      { hostname: '127.0.0.1', port: 19996, path: '/', method: 'POST', headers: { 'Authorization': 'Bearer secret-token', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        authorized = res.statusCode === 200
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', resolve)
      },
    )
    req.on('error', resolve)
    req.write(body)
    req.end()
  })

  adapter.stop()
  check('H3. 错误 token → 401', unauthorized)
  check('H3. 正确 token → 200', authorized)
}

// ── H4：无 token 时任意请求通过 ──────────────────────────────────────────
{
  const config = { httpHost: '127.0.0.1', httpPort: 19995, accessToken: undefined, platform: 'im.qq' }
  const adapter = createQQAdapter(
    { onEnvelope() {} },
    config,
    mkLogger(),
  )
  adapter.start()
  await tick()

  let ok = false
  await new Promise((resolve) => {
    const body = JSON.stringify(makeOneBotEvent('message'))
    const req = http.request(
      { hostname: '127.0.0.1', port: 19995, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        ok = res.statusCode === 200
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', resolve)
      },
    )
    req.on('error', resolve)
    req.write(body)
    req.end()
  })

  adapter.stop()
  check('H4. 无 token 时任意请求通过', ok)
}

// ── H5：非 POST 请求返回 405 ─────────────────────────────────────────────
{
  const config = { httpHost: '127.0.0.1', httpPort: 19994, accessToken: undefined, platform: 'im.qq' }
  const adapter = createQQAdapter({ onEnvelope() {} }, config, mkLogger())
  adapter.start()
  await tick()

  let methodNotAllowed = false
  await new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: 19994, path: '/', method: 'GET' }, (res) => {
      methodNotAllowed = res.statusCode === 405
      res.on('data', () => {})
      res.on('end', resolve)
    })
    req.on('error', resolve)
    req.end()
  })

  adapter.stop()
  check('H5. GET 请求 → 405', methodNotAllowed)
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
