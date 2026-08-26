/**
 * WorldState 冒烟测试（Phase 2.A 最小骨架）
 * 运行：npm run build && node scripts/smoke-world-state.mjs
 *
 * 覆盖：
 *  R0：getInitialState / computeTimeContext 纯函数
 *  R1：applyReducers + feishu:message reducer（不可变 + 字段更新 + 无匹配）
 *  R2：WorldStateUpdater 集成（EventBus + 真实 Cordis Context）
 *      - getState 返回深拷贝（外部 mutation 不污染内部）
 *      - feishu:message 事件后 lastSeenAt/status 更新
 *      - state_changed 事件 emit 次数
 *      - 无 reducer 的事件不触发 emit
 *      - 同 timestamp 不触发新变化（reducer 字段未变化）
 *  R3：dashboard /api/world-state 端点逻辑（mock HTTP，复刻 dashboard handler 逻辑）
 *      - Runtime disabled → 503
 *      - Runtime enabled → 200 + state
 */
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { EventBus } from '../dist/services/eventBus.js'
import {
  applyReducers,
  computeTimeContext,
  createWorldStateService,
  getInitialState,
  reducerRegistrySize,
} from '../dist/services/worldState.js'
import { worldStateUpdater } from '../dist/plugins/world-state-updater.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const logger = {
  info: (...a) => console.log('[log]', ...a),
  warn: (...a) => console.log('[warn]', ...a),
}

// ---------- R0：getInitialState / computeTimeContext 纯函数 ----------
{
  // 已知时间：Wed Aug 27 2026 10:30:00 GMT+0800（周三上午，workday）
  const t0 = new Date('2026-08-26T10:30:00+08:00').getTime()
  const s0 = getInitialState(t0)
  check('R0.1: getInitialState user.status=awake', s0.user.status === 'awake')
  check('R0.2: getInitialState user.doNotDisturb=false', s0.user.doNotDisturb === false)
  check('R0.3: getInitialState device.isLocked=false', s0.device.isLocked === false)
  check('R0.4: getInitialState device.powerMode=plugged', s0.device.powerMode === 'plugged')
  check('R0.5: getInitialState device.network=online', s0.device.network === 'online')
  check('R0.6: getInitialState timeOfDay=morning', s0.time.timeOfDay === 'morning')
  check('R0.7: getInitialState dayOfWeek=Wed', s0.time.dayOfWeek === 'Wed')
  check('R0.8: getInitialState isWorkday=true', s0.time.isWorkday === true)
  check('R0.9: getInitialState isWeekend=false', s0.time.isWeekend === false)
  check('R0.10: getInitialState lastUpdated=t0', s0.lastUpdated === t0)
  check('R0.11: getInitialState extensions={}', JSON.stringify(s0.extensions) === '{}')

  // 已知时间：Sat Aug 29 2026 22:30:00 GMT+0800（周六深夜，night + weekend）
  const tSat = new Date('2026-08-29T22:30:00+08:00').getTime()
  const sSat = getInitialState(tSat)
  check('R0.12: 周六 22:30 → timeOfDay=night', sSat.time.timeOfDay === 'night')
  check('R0.13: 周六 22:30 → dayOfWeek=Sat', sSat.time.dayOfWeek === 'Sat')
  check('R0.14: 周六 22:30 → isWeekend=true', sSat.time.isWeekend === true)
  check('R0.15: 周六 22:30 → isWorkday=false', sSat.time.isWorkday === false)

  // 凌晨 03:00 → night
  const tDawn = new Date('2026-08-26T03:00:00+08:00').getTime()
  check('R0.16: 03:00 → night（跨午夜）', computeTimeContext(tDawn).timeOfDay === 'night')

  // 06:00 → dawn
  const t6 = new Date('2026-08-26T06:00:00+08:00').getTime()
  check('R0.17: 06:00 → dawn', computeTimeContext(t6).timeOfDay === 'dawn')

  // 08:00 → morning 边界
  const t8 = new Date('2026-08-26T08:00:00+08:00').getTime()
  check('R0.18: 08:00 → morning（边界）', computeTimeContext(t8).timeOfDay === 'morning')

  // 12:00 → afternoon 边界
  const t12 = new Date('2026-08-26T12:00:00+08:00').getTime()
  check('R0.19: 12:00 → afternoon（边界）', computeTimeContext(t12).timeOfDay === 'afternoon')

  // 18:00 → evening 边界
  const t18 = new Date('2026-08-26T18:00:00+08:00').getTime()
  check('R0.20: 18:00 → evening（边界）', computeTimeContext(t18).timeOfDay === 'evening')

  // 22:00 → night 边界
  const t22 = new Date('2026-08-26T22:00:00+08:00').getTime()
  check('R0.21: 22:00 → night（边界）', computeTimeContext(t22).timeOfDay === 'night')
}

// ---------- R1：applyReducers + feishu:message reducer ----------
{
  const t0 = 1_000_000
  const initial = getInitialState(t0)
  check('R1.1: feishu:message reducer 已注册', reducerRegistrySize() >= 1)

  // 匹配 reducer：feishu:message
  const ev = { id: 'e1', source: 'feishu', type: 'message', timestamp: 2_000_000, data: { text: 'hi' }, priority: 1 }
  const next = applyReducers(initial, ev)
  check('R1.2: feishu:message 后 user.lastSeenAt 更新', next.user.lastSeenAt === 2_000_000)
  check('R1.3: feishu:message 后 user.status=awake', next.user.status === 'awake')
  check('R1.4: 返回新 state 引用（非原对象）', next !== initial)
  check('R1.5: device 不被 reducer 触碰（保持原样）', JSON.stringify(next.device) === JSON.stringify(initial.device))
  check('R1.6: time 不被 reducer 触碰（保持原样）', JSON.stringify(next.time) === JSON.stringify(initial.time))

  // 不匹配的 source：pc:app_focus（未注册 reducer）
  const pcEv = { id: 'e2', source: 'pc', type: 'app_focus', timestamp: 3_000_000, data: { app: 'VSCode' }, priority: 1 }
  const noChange = applyReducers(initial, pcEv)
  check('R1.7: 未注册 reducer → 返回原 state 引用（applyReducers 不创建空 partial）', noChange === initial)

  // 不匹配的 type：feishu:image（只有 :message 注册了）
  const imgEv = { id: 'e3', source: 'feishu', type: 'image', timestamp: 4_000_000, data: {}, priority: 1 }
  const noImgChange = applyReducers(initial, imgEv)
  check('R1.8: feishu:image（type 不匹配）→ 返回原 state 引用', noImgChange === initial)
}

// ---------- R2：WorldStateUpdater 集成 ----------
{
  const ctx = new Context()
  // 安装 logger exporter 避免 Node.js 默认 stderr 噪声
  ctx.logger.exporter({ colors: 0, levels: { default: 2 }, export() {} })
  const bus = new EventBus({ windowSize: 10 }, logger)
  ctx.provide('eventBus', bus)
  // 挂载 plugin（需要等待 fiber 启动）
  ctx.plugin(worldStateUpdater, { runtime: { worldState: { enabled: true } } })
  await new Promise((r) => setTimeout(r, 200))

  const ws = ctx.get('worldState')
  check('R2.1: worldState Service 已 provide', !!ws)
  check('R2.2: worldState.inject 声明 eventBus', Array.isArray(worldStateUpdater.inject) && worldStateUpdater.inject.includes('eventBus'))

  // getState 返回 WorldState
  const initial = ws.getState()
  check('R2.3: getState 返回 user/device/time', !!(initial.user && initial.device && initial.time))

  // 深拷贝：mutate 副本不影响内部
  const snap = ws.getState()
  snap.user.status = 'busy'
  snap.user.lastSeenAt = 99999
  const after = ws.getState()
  check('R2.4: getState 返回深拷贝（外部 mutate 不影响内部）', after.user.status === 'awake' && after.user.lastSeenAt !== 99999)

  // 订阅 state_changed
  let changedCount = 0
  let lastChanged = null
  ctx.on('orca/state_changed', (s) => { changedCount++; lastChanged = s })
  await new Promise((r) => setTimeout(r, 50))

  // publish feishu:message
  bus.publish({ source: 'feishu', type: 'message', data: { text: 'hi' }, timestamp: 5_000_000, priority: 1 })
  await new Promise((r) => setTimeout(r, 150))
  const after1 = ws.getState()
  check('R2.5: feishu:message 后 lastSeenAt=5_000_000', after1.user.lastSeenAt === 5_000_000)
  check('R2.6: feishu:message 后 status=awake', after1.user.status === 'awake')
  check('R2.7: feishu:message 后 lastUpdated=5_000_000', after1.lastUpdated === 5_000_000)
  check('R2.8: feishu:message 后 lastEventId 已设置', typeof after1.lastEventId === 'string' && after1.lastEventId.length > 0)
  check('R2.9: state_changed emit 1 次', changedCount === 1)
  // WorldStateService.getState() 返回深拷贝（JSON.parse(JSON.stringify)），所以 lastChanged（emit 时的内部引用）
  // 不可能 === after1（getState 深拷贝）。改为字段一致性断言。
  check('R2.10: state_changed payload 字段与 getState 一致',
    lastChanged?.user?.lastSeenAt === after1.user.lastSeenAt &&
    lastChanged?.lastEventId === after1.lastEventId &&
    lastChanged?.lastUpdated === after1.lastUpdated)

  // publish pc:app_focus（无 reducer） → 不应触发 emit
  bus.publish({ source: 'pc', type: 'app_focus', data: { app: 'VSCode' }, priority: 1 })
  await new Promise((r) => setTimeout(r, 100))
  check('R2.11: pc:app_focus（无 reducer）不触发 state_changed', changedCount === 1)

  // publish feishu:message 同 timestamp 5000000（字段无变化）→ 不应 emit
  bus.publish({ source: 'feishu', type: 'message', data: { text: 'hi2' }, timestamp: 5_000_000, priority: 1 })
  await new Promise((r) => setTimeout(r, 100))
  check('R2.12: 同 timestamp 不触发 state_changed（字段未变化）', changedCount === 1)

  // publish feishu:message 不同 timestamp → 应 emit
  bus.publish({ source: 'feishu', type: 'message', data: { text: 'hi3' }, timestamp: 6_000_000, priority: 1 })
  await new Promise((r) => setTimeout(r, 100))
  check('R2.13: 不同 timestamp 触发 state_changed', changedCount === 2)
  check('R2.14: lastEventId 反映最新事件', ws.getState().lastEventId !== after1.lastEventId)
}

// ---------- R3：dashboard /api/world-state 端点（mock HTTP） ----------
// 复刻 dashboard.ts 的 handleWorldState 逻辑（5 行）：ctx.get('worldState') 缺失 → 503；否则 200 + state
{
  // 503 case
  const s503 = createServer((req, res) => {
    if (req.url !== '/api/world-state') { res.writeHead(404).end(); return }
    const ws = undefined  // 模拟 Runtime 未启用
    if (!ws) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'WorldState 未启用' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, ts: Date.now(), state: ws.getState() }))
  })
  await new Promise((r) => s503.listen(0, '127.0.0.1', r))
  const port503 = s503.address().port

  const r503 = await fetch(`http://127.0.0.1:${port503}/api/world-state`, { headers: { connection: 'close' } })
  check('R3.1: Runtime disabled → 503', r503.status === 503)
  const j503 = await r503.json()
  check('R3.2: 503 body ok=false + error', j503.ok === false && typeof j503.error === 'string')

  s503.close()
  s503.closeAllConnections()

  // 200 case
  const ws3 = createWorldStateService(() => getInitialState())
  const s200 = createServer((req, res) => {
    if (req.url !== '/api/world-state') { res.writeHead(404).end(); return }
    if (!ws3) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'WorldState 未启用' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, ts: Date.now(), state: ws3.getState() }))
  })
  await new Promise((r) => s200.listen(0, '127.0.0.1', r))
  const port200 = s200.address().port

  const r200 = await fetch(`http://127.0.0.1:${port200}/api/world-state`, { headers: { connection: 'close' } })
  check('R3.3: Runtime enabled → 200', r200.status === 200)
  const j200 = await r200.json()
  check('R3.4: 200 body ok=true + state.user.status=awake', j200.ok === true && j200.state?.user?.status === 'awake')
  check('R3.5: 200 body 含 state.device + state.time', !!(j200.state?.device && j200.state?.time))

  s200.close()
  s200.closeAllConnections()
}

// ---------- 结果 ----------
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-world-state 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-world-state 失败 ${failed.length} 项`)
}