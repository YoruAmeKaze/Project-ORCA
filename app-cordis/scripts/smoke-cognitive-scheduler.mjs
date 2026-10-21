/**
 * Cognitive Scheduler 冒烟测试（Phase A）
 * 运行：npm run build && node scripts/smoke-cognitive-scheduler.mjs
 *
 * 覆盖：
 *  RA.A  createCognitiveScheduler 基础行为
 *    RA.1:   enqueue 一次 attention → 立即产生 cognition-request
 *    RA.2:   enqueue 多次 attention → 一次 cognition-request（按 Phase A 策略：清空后立即触发）
 *    RA.3:   enqueue 的 attention 字段原样保留（id / ruleId / priority / reason / action / eventId / source）
 *    RA.4:   cognition-request.id 是 UUID 格式
 *    RA.5:   cognition-request.createdAt 是数字时间戳
 *    RA.6:   cognition-request.trigger 字符串非空
 *
 *  RA.B  cognition-running 状态管理
 *    RA.7:   cognition/started 后 isCognitionRunning() === true
 *    RA.8:   cognition/started 后 getActiveSessionId() === sessionId
 *    RA.9:   cognition/completed 后 isCognitionRunning() === false
 *    RA.10:  cognition/completed 后 getActiveSessionId() === null
 *    RA.11:  cognition/failed 后 isCognitionRunning() === false
 *    RA.12:  enqueue 在 cognition 运行时 → pending 累积，不立即产生 request
 *    RA.13:  cognition/completed 后再 enqueue → 立即产生新 request
 *
 *  RA.C  Cordis 集成（cognitiveSchedulerPlugin）
 *    RA.14:  emit('orca/attention') → 产生 emit('orca/cognition-request')
 *    RA.15:  ctx.cognitiveScheduler service 可用
 *    RA.16:  listener try/catch：Scheduler listener 抛错不阻塞 DecisionEngine listener
 *
 *  RA.D  边界与清理
 *    RA.17:  destroy() 后事件订阅被清理（dispose 后 cognition 状态不再更新）
 *    RA.18:  pendingAttentions 不进入 WorldState（ephemeral 状态隔离）
 *    RA.19:  getPendingCount() 反映当前 pending 数量
 */

import { Context } from '@deepseek-ai/cordis'
import { createCognitiveScheduler } from '../dist/services/cognitive-scheduler.js'
import { cognitiveSchedulerPlugin } from '../dist/plugins/cognitive-scheduler-plugin.js'
import { decisionEngine } from '../dist/plugins/decision-engine.js'
import { getInitialState } from '../dist/services/worldState.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// 测试辅助：构造 AttentionItem
function mkAttention(overrides = {}) {
  return {
    id: overrides.id ?? `att_${Math.random().toString(36).slice(2)}`,
    ruleId: overrides.ruleId ?? 'test-rule',
    priority: overrides.priority ?? 'normal',
    reason: overrides.reason ?? 'test reason',
    action: overrides.action ?? 'remember_only',
    eventId: overrides.eventId ?? 'evt_test',
    source: overrides.source ?? 'feishu',
    stateSnapshot: overrides.stateSnapshot ?? getInitialState(Date.now()),
    evaluatedAt: overrides.evaluatedAt ?? Date.now(),
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────
// RA.A  createCognitiveScheduler 基础行为
// ────────────────────────────────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  // 收集 cognition-request emit
  const requests = []
  ctx.on('orca/cognition-request', (r) => requests.push(r))

  const scheduler = createCognitiveScheduler(ctx)

  // RA.1: enqueue 一次 → 立即产生 request
  scheduler.enqueue(mkAttention({ id: 'a1' }))
  check('RA.1.1: enqueue 一次后立即产生 cognition-request',
    requests.length === 1)
  check('RA.1.2: cognition-request 含 1 个 attention',
    requests[0]?.attentions.length === 1)
  check('RA.1.3: cognition-request.attentions[0].id = a1',
    requests[0]?.attentions[0]?.id === 'a1')

  // RA.2: 连续 enqueue 多次 → Phase A 策略下每次清空 pending 后立即产生 request
  requests.length = 0
  scheduler.enqueue(mkAttention({ id: 'a2' }))
  scheduler.enqueue(mkAttention({ id: 'a3' }))
  // Phase A 策略：每次 enqueue 后 evaluate，立即 emit，清空 pending
  // 第一次 enqueue: pending=[a2] → emit [a2]
  // 第二次 enqueue: pending=[a3] → emit [a3]
  check('RA.2.1: 两次连续 enqueue 产生两个 request',
    requests.length === 2)
  check('RA.2.2: 第一个 request 含 a2',
    requests[0]?.attentions[0]?.id === 'a2')
  check('RA.2.3: 第二个 request 含 a3',
    requests[1]?.attentions[0]?.id === 'a3')

  // RA.3: 字段透传
  const itemR3 = mkAttention({
    id: 'a4',
    ruleId: 'feishu-deadline',
    priority: 'high',
    reason: '透传测试',
    action: 'notify_immediately',
    eventId: 'evt_r3',
    source: 'feishu',
  })
  requests.length = 0
  scheduler.enqueue(itemR3)
  check('RA.3.1: attention.ruleId 透传',
    requests[0]?.attentions[0]?.ruleId === 'feishu-deadline')
  check('RA.3.2: attention.priority 透传',
    requests[0]?.attentions[0]?.priority === 'high')
  check('RA.3.3: attention.reason 透传',
    requests[0]?.attentions[0]?.reason === '透传测试')
  check('RA.3.4: attention.action 透传',
    requests[0]?.attentions[0]?.action === 'notify_immediately')
  check('RA.3.5: attention.eventId 透传',
    requests[0]?.attentions[0]?.eventId === 'evt_r3')
  check('RA.3.6: attention.source 透传',
    requests[0]?.attentions[0]?.source === 'feishu')

  // RA.4: request.id 是 UUID 格式
  check('RA.4.1: cognition-request.id 是 UUID 格式',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requests[0]?.id ?? ''))

  // RA.5: createdAt 是数字时间戳
  check('RA.5.1: cognition-request.createdAt 是 number',
    typeof requests[0]?.createdAt === 'number')
  const beforeTime = Date.now()
  requests.length = 0
  scheduler.enqueue(mkAttention({ id: 'a5' }))
  const afterTime = Date.now()
  check('RA.5.2: createdAt 在调用时间范围内',
    requests[0]?.createdAt >= beforeTime && requests[0]?.createdAt <= afterTime)

  // RA.6: trigger 非空
  check('RA.6.1: cognition-request.trigger 非空字符串',
    typeof requests[0]?.trigger === 'string' && requests[0]?.trigger.length > 0)

  // ── RA.19: getPendingCount 反映当前 pending ──
  // 注意：Phase A 策略下每次 enqueue 后立即 evaluate，pending 总会被清空
  // 所以在没有 cognition running 的情况下，getPendingCount 总是 0
  check('RA.19.1: 默认情况下（无 running cognition）getPendingCount() === 0',
    scheduler.getPendingCount() === 0)
  check('RA.19.2: isCognitionRunning() === false（初始）',
    scheduler.isCognitionRunning() === false)
  check('RA.19.3: getActiveSessionId() === null（初始）',
    scheduler.getActiveSessionId() === null)

  // 清理
  scheduler.destroy()
}

// ────────────────────────────────────────────────────────────
// RA.B  cognition-running 状态管理
// ────────────────────────────────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  const scheduler = createCognitiveScheduler(ctx)

  // RA.7: cognition/started → isCognitionRunning = true
  ctx.emit('cognition/started', 'session_001')
  check('RA.7.1: cognition/started 后 isCognitionRunning() === true',
    scheduler.isCognitionRunning() === true)

  // RA.8: cognition/started 后 activeSessionId === sessionId
  check('RA.8.1: cognition/started 后 getActiveSessionId() === sessionId',
    scheduler.getActiveSessionId() === 'session_001')

  // RA.12: cognition 运行时 enqueue → pending 累积，不立即产生 request
  const requests = []
  ctx.on('orca/cognition-request', (r) => requests.push(r))
  scheduler.enqueue(mkAttention({ id: 'b1' }))
  scheduler.enqueue(mkAttention({ id: 'b2' }))
  scheduler.enqueue(mkAttention({ id: 'b3' }))
  check('RA.12.1: cognition 运行时 enqueue 不产生 request',
    requests.length === 0)
  check('RA.12.2: cognition 运行时 pending 累积',
    scheduler.getPendingCount() === 3)

  // RA.9: cognition/completed → isCognitionRunning = false
  ctx.emit('cognition/completed', 'session_001')
  check('RA.9.1: cognition/completed 后 isCognitionRunning() === false',
    scheduler.isCognitionRunning() === false)

  // RA.10: cognition/completed 后 activeSessionId === null
  check('RA.10.1: cognition/completed 后 getActiveSessionId() === null',
    scheduler.getActiveSessionId() === null)

  // RA.13: Phase B 闭环行为：
  // cognition/completed 后 evaluate() 立即被调用（新增行为），
  // pending (b1/b2/b3) 立即触发第一个 request
  // 然后 enqueue(b4) 触发第二个 request
  check('RA.13.0: cognition/completed 后 evaluate() 立即触发第一个 request',
    requests.length === 1)
  check('RA.13.0b: 第一个 request 含 pending 的 3 个 attention',
    requests[0]?.attentions.length === 3)

  scheduler.enqueue(mkAttention({ id: 'b4' }))
  check('RA.13.1: enqueue(b4) 后产生第二个 request（总共 2 个）',
    requests.length === 2)
  check('RA.13.2: 第二个 request 只含 b4',
    requests[1]?.attentions.length === 1)

  // RA.11: cognition/failed → isCognitionRunning = false
  ctx.emit('cognition/started', 'session_002')
  check('RA.11.pre: cognition/started 后 isCognitionRunning() === true',
    scheduler.isCognitionRunning() === true)
  ctx.emit('cognition/failed', 'session_002', 'test error')
  check('RA.11.1: cognition/failed 后 isCognitionRunning() === false',
    scheduler.isCognitionRunning() === false)
  check('RA.11.2: cognition/failed 后 getActiveSessionId() === null',
    scheduler.getActiveSessionId() === null)

  // 清理
  scheduler.destroy()
}

// ────────────────────────────────────────────────────────────
// RA.C  Cordis 集成（cognitiveSchedulerPlugin）
// ────────────────────────────────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  // 模拟 eventBus + worldState service（plugin inject 需要）
  // 注：cognitiveSchedulerPlugin 声明 inject=['eventBus','worldState'] 但实际内部不直接用
  // Cordis v4 inject 门控：如果声明的服务不存在，plugin 不挂载
  // 这里我们 mock 一下
  ctx.provide('eventBus', { publish() {}, subscribe() { return () => {} }, recent: () => [], size: () => 0 })
  ctx.provide('worldState', { getState: () => getInitialState(Date.now()), getPrevState: () => null, applyUpdate() {} })

  // 同时挂载 DecisionEngine（验证 Scheduler 不阻塞 DecisionEngine listener）
  // 注意：decisionEngine plugin 内部会自己 ctx.provide('decision', engine)，不要重复 provide
  decisionEngine(ctx, {})

  // 挂载 CognitiveSchedulerPlugin
  cognitiveSchedulerPlugin(ctx, {})

  // 收集 cognition-request 和 decision
  const requests = []
  const decisions = []
  ctx.on('orca/cognition-request', (r) => requests.push(r))
  ctx.on('orca/decision', (d) => decisions.push(d))

  // RA.14: emit('orca/attention') → 产生 emit('orca/cognition-request')
  ctx.emit('orca/attention', mkAttention({
    id: 'c1',
    ruleId: 'feishu-deadline',
    action: 'notify_immediately',
    priority: 'high',
  }))

  // Cordis listener 异步派发，polling 等
  await new Promise((resolve) => {
    let waited = 0
    const poll = () => {
      if ((requests.length > 0 && decisions.length > 0) || waited > 200) {
        resolve()
        return
      }
      waited += 5
      setTimeout(poll, 5)
    }
    poll()
  })

  check('RA.14.1: emit orca/attention 后产生 orca/cognition-request',
    requests.length === 1)
  check('RA.14.2: 同时 DecisionEngine 也产生 orca/decision（兼容路径）',
    decisions.length === 1)
  check('RA.14.3: cognition-request.attentions[0].id === c1',
    requests[0]?.attentions[0]?.id === 'c1')
  check('RA.14.4: decision.attentionId === c1（DecisionEngine 拿到相同 attention）',
    decisions[0]?.attentionId === 'c1')

  // RA.15: ctx.cognitiveScheduler service 可用
  const svc = ctx.cognitiveScheduler
  check('RA.15.1: ctx.cognitiveScheduler service 可用（enqueue 方法）',
    typeof svc?.enqueue === 'function')
  check('RA.15.2: ctx.cognitiveScheduler service 可用（getPendingCount 方法）',
    typeof svc?.getPendingCount === 'function')
  check('RA.15.3: ctx.cognitiveScheduler service 可用（isCognitionRunning 方法）',
    typeof svc?.isCognitionRunning === 'function')
  check('RA.15.4: ctx.cognitiveScheduler service 可用（getActiveSessionId 方法）',
    typeof svc?.getActiveSessionId === 'function')

  // RA.16: listener try/catch：Scheduler listener 抛错不阻塞 DecisionEngine listener
  // 通过直接调用 scheduler.enqueue 传入一个会导致 evaluate 异常的 attention 来模拟
  // 这里改为：emit 一个 attention 让 scheduler 处理，然后 emit 一个会让 Scheduler listener 内部出错的 item
  // 简化方案：模拟 scheduler listener 内部调用 enqueue 时，pendingAttentions 已被外部直接修改（破坏封装）
  // 不便直接模拟；改为验证 listener try/catch 通过 catch 日志验证
  // 这里用一个空对象 attention 触发可能的异常处理
  // 由于 Cordis fork 的 listener try/catch 行为依赖于 fork 实现，本测试仅做基础验证
  requests.length = 0
  decisions.length = 0
  // 注意：scheduler.enqueue 对 AttentionItem 的 id 取值用于 pendingAttentions.set key
  // 传入 null id 会抛错，应被 try/catch 捕获
  try {
    ctx.emit('orca/attention', { ...mkAttention({ id: 'invalid_null_test' }), id: null })
  } catch {
    // emit 本身不会抛
  }

  // 等异步派发
  await new Promise((resolve) => setTimeout(resolve, 50))

  // listener 内部异常被 try/catch 捕获后，DecisionEngine 仍正常工作
  // 这次验证需要重新 emit 一个 valid attention
  ctx.emit('orca/attention', mkAttention({
    id: 'c2',
    action: 'remember_only',
  }))

  await new Promise((resolve) => {
    let waited = 0
    const poll = () => {
      if (decisions.length > 0 || waited > 200) {
        resolve()
        return
      }
      waited += 5
      setTimeout(poll, 5)
    }
    poll()
  })

  check('RA.16.1: Scheduler listener 内部异常不阻塞 DecisionEngine listener（再次 emit 后 DecisionEngine 仍产生 decision）',
    decisions.some((d) => d.attentionId === 'c2'))
}

// ────────────────────────────────────────────────────────────
// RA.D  边界与清理
// ────────────────────────────────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  const scheduler = createCognitiveScheduler(ctx)

  // RA.17: destroy() 后事件订阅被清理
  scheduler.destroy()
  ctx.emit('cognition/started', 'session_after_destroy')
  check('RA.17.1: destroy 后 cognition/started 不再更新 isCognitionRunning（仍是 false）',
    scheduler.isCognitionRunning() === false)
  check('RA.17.2: destroy 后 cognition/started 不再更新 activeSessionId（仍是 null）',
    scheduler.getActiveSessionId() === null)

  // RA.18: pendingAttentions 不进入 WorldState（ephemeral 状态隔离）
  // 这里仅验证：scheduler 是纯内存状态，没有任何 emit 到 orca/state_changed 之类的 WorldState mutation 事件
  const stateChanges = []
  ctx.on('orca/state_changed', (s) => stateChanges.push(s))
  const freshScheduler = createCognitiveScheduler(ctx)
  freshScheduler.enqueue(mkAttention({ id: 'd1' }))
  // 短暂等待（如有异步派发）
  await new Promise((resolve) => setTimeout(resolve, 30))
  check('RA.18.1: Scheduler 操作不产生 orca/state_changed 事件',
    stateChanges.length === 0)
}

// ────────── 结果 ──────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-cognitive-scheduler 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-cognitive-scheduler 失败 ${failed.length} 项`)
}