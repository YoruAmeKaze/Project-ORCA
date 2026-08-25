/**
 * InfoAgent 框架冒烟测试（food-agent Pull+Push 双模式）。
 * 运行：npm run build && node scripts/smoke-info-agent.mjs
 * 覆盖：闭集注册表 / 档案室(JSONL+supersedes+ttl+软删+pending) / Pull 执行管线(校验/超时/审计)
 *      / R0 查档 / 外部上报通道(Bearer 鉴权) / food-agent 识别→写档全链路（视觉用 stub，不调真实 API）
 *      / 日志级别 quirk 回归（default:2 放行 warn）+ 事件派发（顶层与插件 fiber 监听器）
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { InfoAgentRegistry } from '../dist/agents/registry.js'
import { InfoExecutor } from '../dist/agents/executor.js'
import { JsonlInfoRecordStore } from '../dist/agents/store.js'
import { route } from '../dist/agents/router.js'
import { foodLogAgent } from '../dist/agents/builtins/food-log.js'
import { createReceiverHandler } from '../dist/plugins/info-receiver.js'
import { processFoodImage } from '../dist/plugins/food-image.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const logger = {
  info: (...a) => console.log('[log]', ...a),
  warn: (...a) => console.log('[warn]', ...a),
}

const tmpDir = mkdtempSync(join(tmpdir(), 'orca-info-smoke-'))
const recordsDir = join(tmpDir, 'records')

// ---------- 1. 闭集注册表 ----------
{
  const registry = new InfoAgentRegistry()
  registry.register(foodLogAgent)
  check('registry: register food-agent', registry.get('food-agent') === foodLogAgent)
  check('registry: list 包含 food-agent', registry.list().length === 1)
  check('registry: meta 双向模式 pull+push', JSON.stringify(foodLogAgent.meta.modes) === '["pull","push"]')
  check('registry: recordTypes = food-log', JSON.stringify(foodLogAgent.meta.recordTypes) === '["food-log"]')
  let dup = false
  try { registry.register(foodLogAgent) } catch { dup = true }
  check('registry: 重复注册抛错（闭集）', dup)
}

// ---------- 2. 档案室（store） ----------
const store = new JsonlInfoRecordStore(recordsDir)
{
  const now = Date.now()
  const yesterday = now - 86400000
  await store.append({ namespace: 'food-agent', type: 'food-log', ts: yesterday, source: 'food-app', confidence: 0.9, urgency: 0, payload: { food: '重庆小面', kcal: 520 }, ttlDays: 30 })
  const lunch = { id: 'lunch-1', namespace: 'food-agent', type: 'food-log', ts: now, source: 'food-agent', confidence: 0.87, urgency: 0, payload: { food: '红烧肉盖饭', kcal: 680, photoRef: 'local://x.jpg' }, ttlDays: 7 }
  await store.append(lunch)

  const all = await store.query({})
  check('store: 查询全部 = 2 条', all.length === 2)
  const byNs = await store.query({ namespaces: ['food-agent'] })
  check('store: namespace 过滤', byNs.length === 2)
  const kw = await store.query({ keyword: '红烧肉' })
  check('store: keyword 命中 payload', kw.length === 1 && kw[0].payload.food === '红烧肉盖饭')
  const win = await store.query({ from: now - 3600000, to: now })
  check('store: 时间窗过滤（仅今天）', win.length === 1 && win[0].payload.food === '红烧肉盖饭')

  // supersedes 更正（D-AGENT-09）：新记录取代旧记录后，旧记录默认隐藏
  await store.append({ namespace: 'food-agent', type: 'food-log', ts: now + 1000, source: 'food-agent', confidence: 0.95, urgency: 0, payload: { food: '红烧肉盖饭', kcal: 700 }, supersedes: lunch.id })
  const afterFix = await store.query({})
  check('store: supersedes 后旧记录隐藏', afterFix.length === 2 && afterFix[0].payload.kcal === 700)

  // 软删（D-AGENT-12）：delete 后查询隐藏，prune 物理清理
  const target = afterFix[0]
  const delCount = await store.delete('food-agent', [target.id])
  check('store: 软删 1 条', delCount === 1)
  const afterDel = await store.query({})
  check('store: 软删后查询隐藏', afterDel.length === 1)

  // ttl 清理
  await store.append({ namespace: 'food-agent', type: 'food-log', ts: now - 10000, source: 'food-app', urgency: 0, payload: { food: '过期记录', kcal: 1 }, ttlDays: 0.00001 })
  const pruned = await store.pruneExpired()
  check('store: pruneExpired 按 ttl 清理', pruned >= 1)

  // 待汇报队列（D-AGENT-11）：urgency=1
  const urgent = { id: 'urgent-1', namespace: 'food-agent', type: 'food-log', ts: now, source: 'food-agent', urgency: 1, payload: { food: '连续两天超标', kcal: 2200 } }
  await store.append(urgent)
  const pending = await store.peekPending()
  check('store: peekPending 拿到 urgency=1', pending.length === 1 && pending[0].id === urgent.id)
  store.ackPending([urgent.id])
  check('store: ack 后 peekPending 为空', (await store.peekPending()).length === 0)

  // 整夹清空（D-AGENT-12：一键清空 namespace）
  await store.delete('food-agent')
  check('store: 一键清空 namespace', (await store.query({ namespaces: ['food-agent'] })).length === 0)
}

// ---------- 3. Pull 执行管线（executor）+ food-agent 识别→写档 ----------
{
  const store2 = new JsonlInfoRecordStore(join(recordsDir, 'phase3'))
  const executor = new InfoExecutor(logger)
  const registry = new InfoAgentRegistry()
  registry.register(foodLogAgent)

  // stub 视觉（不调真实 Qwen API）
  const stubVision = {
    describe: async () => '```json\n{"food":"红烧肉盖饭","kcal":680,"amount":"一份","confidence":0.87}\n```',
  }
  const deps = { vision: stubVision, store: store2, logger }

  const img = join(tmpDir, 'meal.png')
  writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

  const okRes = await executor.execute(foodLogAgent, { agent: 'food-agent', input: { imagePath: img }, sessionId: 's1' }, deps)
  check('executor: food-agent Pull 识别成功', okRes.ok && okRes.data.food === '红烧肉盖饭' && okRes.data.kcal === 680, JSON.stringify(okRes))
  check('executor: 结果结构化 + source', okRes.ok && okRes.data && okRes.source === 'food-agent' && typeof okRes.tookMs === 'number')

  // Push 副产品：识别结果已写档案（photoRef 本地路径，L1 不落明文日志）
  const written = await store2.query({ namespaces: ['food-agent'], types: ['food-log'] })
  check('food-agent: 识别后自动写 food-log 档案（Push）', written.length === 1 && written[0].payload.photoRef === `local://${img}`)
  check('food-agent: 记录默认 urgency=0 静默入库', written[0].urgency === 0)

  // record=false → 纯 Pull 不写档
  const noRecord = await executor.execute(foodLogAgent, { agent: 'food-agent', input: { imagePath: img, record: false }, sessionId: 's2' }, deps)
  check('executor: record=false 不写档', noRecord.ok && (await store2.query({})).length === 1)

  // 参数校验（BAD_INPUT）
  const badInput = await executor.execute(foodLogAgent, { agent: 'food-agent', input: {}, sessionId: 's3' }, deps)
  check('executor: 缺 imagePath/imageUrl → BAD_INPUT', !badInput.ok && badInput.error.code === 'BAD_INPUT')

  // 视觉失败 → VISION_FAIL retryable
  const failingVision = { describe: async () => { throw new Error('vision api down') } }
  const failRes = await executor.execute(foodLogAgent, { agent: 'food-agent', input: { imagePath: img }, sessionId: 's4' }, { vision: failingVision, store: store2, logger })
  check('executor: 视觉失败 → VISION_FAIL/retryable', !failRes.ok && failRes.error.code === 'VISION_FAIL' && failRes.error.retryable === true)

  // 超时（TIMEOUT/retryable）
  const slowAgent = {
    meta: { name: 'slow-agent', timeoutMs: 50, isConcurrencySafe: true },
    execute: () => new Promise(() => {}),
  }
  const timeoutRes = await executor.execute(slowAgent, { agent: 'slow-agent', input: {}, sessionId: 's5' }, { logger })
  check('executor: 超时 → TIMEOUT/retryable', !timeoutRes.ok && timeoutRes.error.code === 'TIMEOUT' && timeoutRes.error.retryable === true)

  // 非并发安全 agent 串行（food-agent isConcurrencySafe=false 不报错即可）
  const [r1, r2] = await Promise.all([
    executor.execute(foodLogAgent, { agent: 'food-agent', input: { imagePath: img }, sessionId: 's6' }, deps),
    executor.execute(foodLogAgent, { agent: 'food-agent', input: { imagePath: img }, sessionId: 's7' }, deps),
  ])
  check('executor: 并发调用（串行化）均成功', r1.ok && r2.ok)
}

// ---------- 4. 路由：R0 查档优先 ----------
{
  const registry = new InfoAgentRegistry()
  registry.register(foodLogAgent)
  const store3 = new JsonlInfoRecordStore(join(recordsDir, 'phase4'))
  const executor = new InfoExecutor(logger)
  const services = { registry, store: store3, executor, logger }

  await store3.append({ namespace: 'food-agent', type: 'food-log', ts: Date.now() - 86400000, source: 'food-app', urgency: 0, payload: { food: '重庆小面', kcal: 520 } })

  // R0：问"昨天中午吃了多少卡" → 档案命中（关键词命中 payload）
  const hit = await route(services, { query: '昨天中午吃了多少卡 重庆小面', sessionId: 's1', deps: { logger } })
  check('router: R0 查档命中 → archive', hit.source === 'archive' && hit.records.length === 1 && hit.records[0].payload.food === '重庆小面')

  // 未命中 → none（文本问询不自动执行图片型 agent）
  const miss = await route(services, { query: '今天天气怎么样', sessionId: 's2', deps: { logger } })
  check('router: 未命中 → none', miss.source === 'none')

  // 显式 Pull 委托（点名 agent + 图片输入）
  const stubVision = { describe: async () => '{"food":"宫保鸡丁","kcal":560,"confidence":0.8}' }
  const dispatch = await route(services, { agent: 'food-agent', input: { imagePath: join(tmpDir, 'meal.png') }, sessionId: 's3', deps: { vision: stubVision, store: store3, logger } })
  check('router: 显式委托 food-agent 执行成功', dispatch.source === 'agent' && dispatch.result.ok && dispatch.result.data.food === '宫保鸡丁')
}

// ---------- 5. 外部上报通道（receiver）：Bearer 鉴权 ----------
{
  const store4 = new JsonlInfoRecordStore(join(recordsDir, 'phase5'))
  const tokens = { 'food-app-token-1': ['food-agent'] }
  const handler = createReceiverHandler({ port: 0, host: '127.0.0.1', tokens }, (rec) => { void store4.append(rec) })
  const server = createServer((req, res) => { void handler(req, res).catch(() => res.writeHead(500).end()) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  const post = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json().catch(() => ({})) }
  }

  // §13 走查：食物 App 推记录
  const good = await post('/info/records', { namespace: 'food-agent', type: 'food-log', source: 'food-app', confidence: 0.87, urgency: 0, payload: { food: '红烧肉盖饭', kcal: 680, photoRef: 'local://app-photo.jpg' } }, 'food-app-token-1')
  check('receiver: 合法上报 → 201 + id', good.status === 201 && typeof good.json.id === 'string')
  const pushed = await store4.query({ namespaces: ['food-agent'] })
  check('receiver: 记录已写入档案室', pushed.length === 1 && pushed[0].payload.food === '红烧肉盖饭')
  check('receiver: 记录含信封字段', pushed[0].namespace === 'food-agent' && pushed[0].type === 'food-log' && pushed[0].source === 'food-app')

  const noAuth = await post('/info/records', { namespace: 'food-agent', type: 'food-log', source: 'x' }, undefined)
  check('receiver: 无 token → 401', noAuth.status === 401)
  const badToken = await post('/info/records', { namespace: 'food-agent', type: 'food-log', source: 'x' }, 'wrong-token')
  check('receiver: 错误 token → 401', badToken.status === 401)
  const badNs = await post('/info/records', { namespace: 'stock-agent', type: 'quote', source: 'x' }, 'food-app-token-1')
  check('receiver: namespace 不在白名单 → 403', badNs.status === 403)
  const badEnv = await post('/info/records', { type: 'food-log', source: 'x' }, 'food-app-token-1')
  check('receiver: 缺信封字段 → 400', badEnv.status === 400)
  const badUrgency = await post('/info/records', { namespace: 'food-agent', type: 'food-log', source: 'x', urgency: 9 }, 'food-app-token-1')
  check('receiver: urgency 非法 → 400', badUrgency.status === 400)

  const health = await fetch(`${base}/health`, { headers: { connection: 'close' } })
  check('receiver: /health → 200', health.status === 200)

  await new Promise((r) => server.close(r))
  server.closeAllConnections()
}

// ---------- 6. 飞书图片管线（food-image 插件核心，D-AGENT-13 通道①） ----------
{
  const store5 = new JsonlInfoRecordStore(join(recordsDir, 'phase6'))
  const imagesDir = join(tmpDir, 'images')
  const stubVision = { describe: async () => '{"food":"牛肉面","kcal":540,"amount":"一碗","confidence":0.85}' }
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

  const out = await processFoodImage(pngBytes, { vision: stubVision, store: store5, logger, imagesDir })
  check('food-image: 识别成功并生成回复文案', out.food === '牛肉面' && out.kcal === 540 && out.reply.includes('540 kcal'))
  check('food-image: 回复带人设（老板）', out.reply.startsWith('老板'))
  check('food-image: 图片已落盘', (await import('node:fs/promises')).readdir(imagesDir).then((f) => f.length === 1))
  const logged = await store5.query({ namespaces: ['food-agent'], types: ['food-log'] })
  check('food-image: 识别后自动写 food-log 档案', logged.length === 1 && logged[0].payload.food === '牛肉面')

  // 视觉失败 → 抛错（插件层兜底为错误回复）
  const badVision = { describe: async () => { throw new Error('vision down') } }
  let threw = false
  try { await processFoodImage(pngBytes, { vision: badVision, store: store5, logger, imagesDir }) } catch { threw = true }
  check('food-image: 视觉失败 → 抛错（插件兜底错误回复）', threw)
}

// ---------- 7. 日志级别 + 事件派发回归（cordis fork quirk） ----------
{
  // fork 语义：exporter.levels 是导出阈值上限（ERROR=0/INFO=1/WARN=2/DEBUG=3），level ≤ 阈值才导出。
  // index.ts 曾用 default:1 → WARN 全被吞 → food-image 失败日志不可见（被误判为事件派发问题）。
  const ctxA = new Context()
  const seenA = []
  ctxA.logger.exporter({ colors: 0, levels: { default: 2 }, export(m) { seenA.push(m.type) } })
  ctxA.logger.info('i')
  ctxA.logger.warn('w')
  check('logger: levels.default=2 放行 info+warn', seenA.includes('info') && seenA.includes('warn'))

  const ctxB = new Context()
  const seenB = []
  ctxB.logger.exporter({ colors: 0, levels: { default: 1 }, export(m) { seenB.push(m.type) } })
  ctxB.logger.info('i')
  ctxB.logger.warn('w')
  check('logger: levels.default=1 丢弃 warn（回归保护）', seenB.includes('info') && !seenB.includes('warn'))

  // 事件派发：顶层 ctx.on 与插件 fiber 内 ctx.on 的监听器都应被 ctx.emit 触发
  let topFired = 0
  let pluginFired = 0
  ctxA.on('feishu/image', () => { topFired++ })
  function probePlugin(c) { c.on('feishu/image', () => { pluginFired++ }) }
  probePlugin.inject = []
  ctxA.plugin(probePlugin, {})
  await new Promise((r) => setTimeout(r, 200)) // 等插件 fiber 启动并注册监听器
  ctxA.emit('feishu/image', {})
  await new Promise((r) => setTimeout(r, 50))
  check('events: ctx.emit 触发顶层与插件 fiber 监听器', topFired === 1 && pluginFired === 1)
}

// ---------- 清理 ----------
rmSync(tmpDir, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke 失败 ${failed.length} 项`)
}
// 自然退出：不用 process.exit()，避免 Windows 下 undici 连接池收尾触发 uv 断言（exit code 非 0）
