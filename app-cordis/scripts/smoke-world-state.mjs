/**
 * WorldState 冒烟测试（Phase 2.A 最小骨架 + Phase 2.B 集成 + Phase 2.C time tick）
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
 *  R4（Phase 2.B）：feishu-adapter → EventBus → WorldStateUpdater 端到端集成
 *      - 真实 ctx.emit('feishu/message', ...) 模拟 feishu-channel emit
 *      - feishu-adapter 翻译 + bus.publish
 *      - WorldStateUpdater 收到 EventBus 事件 + applyReducers
 *      - user.lastSeenAt / user.status / lastEventId 正确更新
 *      - 多订阅者共存（feishu-adapter + 新增 ctx.on 不互相影响）
 *      - 用 polling 等异步派发（避免任意 sleep 掩盖竞态）
 *  R5（Phase 2.C）：time tick + away 自动推导
 *      R5.A：deriveUserStatus 纯函数（边界 + 单向推导 + 不覆盖 busy/sleeping/away）
 *      R5.B：setInterval 集成（timeRefreshMs=50 加速；lastSeenAt=past → away）
 *      R5.C：fresh state + lastSeenAt=recent → 多次 tick 后仍 awake + 无变化不 emit
 */
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { EventBus } from '../dist/services/eventBus.js'
import {
  applyReducers,
  AWAY_THRESHOLD_MS,
  computeTimeContext,
  createWorldStateService,
  deriveUserStatus,
  getInitialState,
  reducerRegistrySize,
} from '../dist/services/worldState.js'
import { worldStateUpdater } from '../dist/plugins/world-state-updater.js'
import { feishuAdapter } from '../dist/plugins/input-adapters/feishu-adapter.js'

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

  // 不匹配的 source：使用完全未注册的 sensor:reading（Phase 2.D 也没注册这个 key）
  const pcEv = { id: 'e2', source: 'sensor', type: 'reading', timestamp: 3_000_000, data: { value: 23 }, priority: 1 }
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

  // publish sensor:reading（Phase 2.D 未注册 reducer） → 不应触发 emit
  bus.publish({ source: 'sensor', type: 'reading', data: { value: 23 }, priority: 1 })
  await new Promise((r) => setTimeout(r, 100))
  check('R2.11: sensor:reading（无 reducer）不触发 state_changed', changedCount === 1)

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

// ---------- R4（Phase 2.B）：feishu-adapter → EventBus → WorldStateUpdater 端到端集成 ----------
// 模拟真实 feishu-channel 通过 ctx.emit('feishu/message', ...) 推送消息。
// 完整链路：ctx.emit → feishuAdapter (顶层 ctx.on) → bus.publish → setImmediate 派发 →
// WorldStateUpdater handler → applyReducers → WorldState 更新 → emit 'orca/state_changed'
//
// 异步处理：用 polling（每 10ms 检查 state 变化，最多 1s）而非任意 sleep，
// 减少"任意过大 sleep 掩盖竞态"风险（用户明确要求）。
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 2 }, export() {} })
  const bus = new EventBus({ windowSize: 10 }, logger)
  ctx.provide('eventBus', bus)

  // feishuAdapter 不是 plugin（无 inject/fiber），直接调用即可，
  // 内部 ctx.on(...) 立即注册到 Context 顶层
  feishuAdapter(ctx, {})
  // worldStateUpdater 是 plugin（inject=['eventBus']），需要 ctx.plugin + 等 fiber 启动
  ctx.plugin(worldStateUpdater, { runtime: { worldState: { enabled: true } } })
  await new Promise((r) => setTimeout(r, 200))

  const ws = ctx.get('worldState')
  check('R4.0: worldState Service 已 provide', !!ws)

  // 记录当前 lastSeenAt 作 baseline
  const baseline = ws.getState().user.lastSeenAt

  // 模拟 feishu-channel emit('feishu/message', ...)
  const feishuEventId = 'feishu_evt_p2b_001'
  const tBeforeEmit = Date.now()
  ctx.emit('feishu/message', {
    eventId: feishuEventId,
    sessionId: 'ou_test_session',
    openId: 'ou_test_user',
    messageId: 'om_test_msg_p2b_001',
    chatId: 'oc_test_chat',
    text: '测试 Phase 2.B 集成',
  })
  const tAfterEmit = Date.now()

  // 异步派发 polling：等待 user.lastSeenAt 反映事件 timestamp
  // 注意：feishuAdapter 调 bus.publish → setImmediate → dispatch → handler。
  // handler 同步执行 applyReducers + 更新 state。
  let dispatched = false
  for (let i = 0; i < 100; i++) { // 最多 1000ms
    await new Promise((r) => setTimeout(r, 10))
    if (ws.getState().lastEventId === feishuEventId) { dispatched = true; break }
  }
  check('R4.1: 真实 ctx.emit 后 WorldState 在 1s 内更新（polling 检测）', dispatched)

  // 验证 OrcaEvent 已 publish 到 EventBus
  const events = bus.recent(10)
  check('R4.2: EventBus 收到 1 条 OrcaEvent', events.length === 1)
  const evt = events[0]
  check('R4.3: OrcaEvent.source === "feishu"', evt?.source === 'feishu')
  check('R4.4: OrcaEvent.type === "message"', evt?.type === 'message')
  check('R4.5: OrcaEvent.priority === 1', evt?.priority === 1)
  check('R4.6: OrcaEvent.data.text 透传', evt?.data.text === '测试 Phase 2.B 集成')
  check('R4.7: OrcaEvent.data.chatId 透传', evt?.data.chatId === 'oc_test_chat')
  check('R4.8: OrcaEvent.data.messageId 透传', evt?.data.messageId === 'om_test_msg_p2b_001')
  check('R4.9: OrcaEvent.data.openId 透传', evt?.data.openId === 'ou_test_user')
  check('R4.10: OrcaEvent.sessionId 使用 Feishu channel:chat 会话标识', evt?.sessionId === 'feishu:oc_test_chat')
  check('R4.11: OrcaEvent.id === feishu eventId（adapter 透传作为幂等键）', evt?.id === feishuEventId)
  // timestamp 用 Date.now()（adapter 显式设置，不从 eventId 推导）
  check('R4.12: OrcaEvent.timestamp 在 [tBeforeEmit, tAfterEmit] 区间内',
    typeof evt?.timestamp === 'number' && evt.timestamp >= tBeforeEmit && evt.timestamp <= tAfterEmit)

  // 验证 WorldState 字段
  const state = ws.getState()
  check('R4.13: WorldState.user.lastSeenAt === OrcaEvent.timestamp', state.user.lastSeenAt === evt?.timestamp)
  check('R4.14: WorldState.user.status === "awake"', state.user.status === 'awake')
  check('R4.15: WorldState.lastEventId === OrcaEvent.id === feishuEventId',
    state.lastEventId === evt?.id && state.lastEventId === feishuEventId)
  check('R4.16: WorldState.lastSeenAt 较 baseline 更新', state.user.lastSeenAt > baseline)

  // 多订阅者共存：feishu-adapter 之后注册 ctx.on('feishu/message', ...) 也应收到
  // （image-router 等业务订阅者与此独立，本测试只验证"新增 ctx.on 不破坏 feishu-adapter 链路"）
  let otherSubsReceived = 0
  ctx.on('feishu/message', () => { otherSubsReceived++ })
  ctx.emit('feishu/message', {
    eventId: 'feishu_evt_p2b_002',
    sessionId: 'ou_test_session',
    openId: 'ou_test_user',
    messageId: 'om_test_msg_p2b_002',
    chatId: 'oc_test_chat',
    text: '第二条消息（验证多订阅者）',
  })
  // polling 等 WorldState 反映第二条
  let secondDispatched = false
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10))
    if (ws.getState().lastEventId === 'feishu_evt_p2b_002') { secondDispatched = true; break }
  }
  check('R4.17: 第二条 emit 后 WorldState 反映新 eventId', secondDispatched)
  check('R4.18: EventBus 现持有 2 条 OrcaEvent', bus.recent(10).length === 2)
  check('R4.19: 新订阅者收到第二条 emit（不影响既有订阅链）', otherSubsReceived === 1)
  check('R4.20: WorldState.lastEventId 更新到第二条', ws.getState().lastEventId === 'feishu_evt_p2b_002')
  check('R4.21: WorldState.lastSeenAt 严格大于第一条（先后顺序）',
    ws.getState().user.lastSeenAt > state.user.lastSeenAt)

  // feishu/image 也走同一链路 → 测试 image 翻译不影响 message reducer（不污染 WorldState）
  // 注：feishu:image 转 OrcaEvent type='notification'，现有 feishuMessageReducer 只匹配 'message'，
  // 所以 image 事件应被 EventBus 接收但 WorldState 不更新（字段无变化）
  const stateBeforeImage = ws.getState()
  const imageEvtId = 'feishu_evt_p2b_img_001'
  ctx.emit('feishu/image', {
    eventId: imageEvtId,
    sessionId: 'ou_test_session',
    openId: 'ou_test_user',
    messageId: 'om_test_img_p2b_001',
    chatId: 'oc_test_chat',
    imageKey: 'img_key_test_001',
  })
  // 等 EventBus 收到 image 事件
  let imageDispatched = false
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10))
    const all = bus.recent(10)
    if (all.some((e) => e.id === imageEvtId)) { imageDispatched = true; break }
  }
  check('R4.22: feishu/image 也通过 adapter → EventBus', imageDispatched)
  check('R4.23: feishu:image 事件 type=notification（不影响 reducer）',
    bus.recent(10).find((e) => e.id === imageEvtId)?.type === 'notification')
  // 关键断言：image 事件不应改变 WorldState.lastSeenAt / status（reducer 只匹配 feishu:message）
  const stateAfterImage = ws.getState()
  check('R4.24: feishu:image 不污染 WorldState.lastEventId（reducer 不匹配 type=notification）',
    stateAfterImage.lastEventId !== imageEvtId)
  check('R4.25: feishu:image 不污染 WorldState.user.lastSeenAt（reducer 不匹配）',
    stateAfterImage.user.lastSeenAt === stateBeforeImage.user.lastSeenAt)
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

// ---------- R5（Phase 2.C）：time tick + away 自动推导 ----------
// 设计原则（与代码一致）：
//   - 仅 awake → away 单向推导；busy/sleeping/away 不主动覆盖
//   - lastSeenAt <= 0 兜底 → 不推导
//   - now - lastSeenAt > AWAY_THRESHOLD_MS (30min 整不算，30min+1ms 算)
//   - time tick 每 N ms 检查 time + status 任一字段变化才 emit（无变化零开销）
//   - dispose 钩子 clearInterval + unsubscribe
{
  // ── R5.A：deriveUserStatus 纯函数（无 setInterval） ──
  const t0 = 1_700_000_000_000 // 固定时间锚点（避免依赖 Date.now）
  const makeState = (status, lastSeenAt) => ({
    ...getInitialState(t0),
    user: { ...getInitialState(t0).user, status, lastSeenAt },
  })

  check('R5.A1: AWAY_THRESHOLD_MS === 30 分钟', AWAY_THRESHOLD_MS === 30 * 60 * 1000)

  // 边界：30:00 整不算，30:00.001 才算 away
  check('R5.A2: awake + 29:59 → null（保持 awake）',
    deriveUserStatus(makeState('awake', t0), t0 + 29 * 60 * 1000 + 59 * 1000) === null)
  check('R5.A3: awake + 30:00 整 → null（边界，不到阈值）',
    deriveUserStatus(makeState('awake', t0), t0 + 30 * 60 * 1000) === null)
  check('R5.A4: awake + 30:00.001 → "away"',
    deriveUserStatus(makeState('awake', t0), t0 + 30 * 60 * 1000 + 1) === 'away')
  check('R5.A5: awake + 60:00 → "away"（长时间不活动）',
    deriveUserStatus(makeState('awake', t0), t0 + 60 * 60 * 1000) === 'away')

  // 不覆盖 busy / sleeping / away
  check('R5.A6: busy + 31 分钟 → null（不覆盖 busy）',
    deriveUserStatus(makeState('busy', t0), t0 + 31 * 60 * 1000) === null)
  check('R5.A7: sleeping + 31 分钟 → null（不覆盖 sleeping）',
    deriveUserStatus(makeState('sleeping', t0), t0 + 31 * 60 * 1000) === null)
  // away 不自恢复：已经 away 状态，time tick 不会主动改回 awake
  check('R5.A8: away + 31 分钟 → null（不反向，away 自维持）',
    deriveUserStatus(makeState('away', t0), t0 + 31 * 60 * 1000) === null)
  // 兜底：lastSeenAt <= 0（极不可能但容错）
  check('R5.A9: awake + lastSeenAt=0 → null（兜底）',
    deriveUserStatus(makeState('awake', 0), t0) === null)
  check('R5.A10: awake + lastSeenAt=-1 → null（负数兜底）',
    deriveUserStatus(makeState('awake', -1), t0) === null)

  // ── R5.B：setInterval 集成（timeRefreshMs=50 加速）──
  // 验证：emit feishu:message with timestamp=past → lastSeenAt=past → time tick 检测 → status='away'
  {
    const ctx = new Context()
    ctx.logger.exporter({ colors: 0, levels: { default: 2 }, export() {} })
    const bus = new EventBus({ windowSize: 10 }, logger)
    ctx.provide('eventBus', bus)
    ctx.plugin(worldStateUpdater, {
      runtime: { worldState: { enabled: true, timeRefreshMs: 50 } },
    })
    await new Promise((r) => setTimeout(r, 200))

    const ws = ctx.get('worldState')
    let stateChangedCount = 0
    ctx.on('orca/state_changed', () => stateChangedCount++)
    await new Promise((r) => setTimeout(r, 50)) // 等 listener 注册

    // R5.B1: emit feishu:message with timestamp=past（31 分钟前）
    const past = Date.now() - 31 * 60 * 1000
    bus.publish({ source: 'feishu', type: 'message', data: { text: 'past' }, timestamp: past })

    // polling 等 status='away'（setInterval tick 时间）
    let becameAway = false
    for (let i = 0; i < 50; i++) { // 最多 500ms
      await new Promise((r) => setTimeout(r, 10))
      if (ws.getState().user.status === 'away') { becameAway = true; break }
    }
    check('R5.B1: lastSeenAt=31分钟前 → 500ms 内 status=away', becameAway)
    check('R5.B2: state_changed 被 emit（bus.publish + timer tick 各至少1次）', stateChangedCount >= 2)
    check('R5.B3: WorldState.lastSeenAt === past（reducer 生效）',
      ws.getState().user.lastSeenAt === past)

    // R5.B4: 多次 timer tick（无新事件）+ status 已 away → away 自维持（time tick 不主动反向）
    // 用户语义：away 状态只能由 feishu:message（新事件）触发 feishuMessageReducer 设回 awake，
    // time tick 不能自己把 away 改回 awake（必须靠用户实际活动）。
    const awayStatus = ws.getState().user.status
    const awayLastSeenAt = ws.getState().user.lastSeenAt
    await new Promise((r) => setTimeout(r, 400)) // 8+ 次 tick
    check('R5.B4: 多次 timer tick 后 status 仍 away（away 自维持，time tick 不反向）',
      ws.getState().user.status === awayStatus && ws.getState().user.status === 'away')
    check('R5.B5: lastSeenAt 不变（无新事件，无 reducer 触发）',
      ws.getState().user.lastSeenAt === awayLastSeenAt)
  }

  // ── R5.C：fresh state + lastSeenAt=recent → 多次 tick 后保持 awake + 无变化不 emit ──
  // 验证：R5.A 测了 deriveUserStatus 纯函数（lastSeenAt=10分钟前 → null → 不变）；
  // 这里验证 setInterval tick 实际行为：user 不变 + time 短期不变 → 无 emit
  {
    const ctx = new Context()
    ctx.logger.exporter({ colors: 0, levels: { default: 2 }, export() {} })
    const bus = new EventBus({ windowSize: 10 }, logger)
    ctx.provide('eventBus', bus)
    ctx.plugin(worldStateUpdater, {
      runtime: { worldState: { enabled: true, timeRefreshMs: 50 } },
    })
    await new Promise((r) => setTimeout(r, 200))

    const ws = ctx.get('worldState')
    let count = 0
    ctx.on('orca/state_changed', () => count++)
    await new Promise((r) => setTimeout(r, 50))

    // emit lastSeenAt=10分钟前（不到 30 分钟阈值）→ reducer 改 lastSeenAt → emit 1 次
    const recent = Date.now() - 10 * 60 * 1000
    bus.publish({ source: 'feishu', type: 'message', data: { text: 'recent' }, timestamp: recent })
    await new Promise((r) => setTimeout(r, 150)) // 等 bus handler（setImmediate）
    const afterPublish = count
    check('R5.C1: bus.publish 后 state_changed +1（reducer 改 lastSeenAt）', afterPublish === 1)
    check('R5.C2: status 保持 awake（10 分钟 < 30 分钟阈值）',
      ws.getState().user.status === 'awake')
    check('R5.C3: lastSeenAt === recent（reducer 生效）',
      ws.getState().user.lastSeenAt === recent)

    // 等多次 timer tick（timeRefreshMs=50，300ms = 6 次 tick）
    // 预期：user 不变（10 分钟 < 30 分钟）；time 短期不变（timeOfDay 按小时，dayOfWeek 按日）
    await new Promise((r) => setTimeout(r, 300))
    check('R5.C4: 6 次 timer tick 后 status 仍 awake',
      ws.getState().user.status === 'awake')
    check('R5.C5: 多次 tick 但状态无变化 → state_changed 不再增加',
      count === afterPublish)
  }
}

// ---------- 结果 ----------
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-world-state 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-world-state 失败 ${failed.length} 项`)
}
