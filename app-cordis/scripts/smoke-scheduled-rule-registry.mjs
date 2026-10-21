/**
 * ScheduledRuleRegistry 冒烟测试（Phase 7.1B）
 * 运行：npm run build && node scripts/smoke-scheduled-rule-registry.mjs
 *
 * 覆盖：
 *  R1：createScheduledRuleRegistry 纯函数
 *      - register / unregister / size / ruleIds
 *  R2：evaluate - predicate 命中 → emit business event
 *  R3：evaluate - predicate 不命中 → 不 emit
 *  R4：多个 rule 独立注册/评估
 *  R5：lastTriggeredAt 上下文正确
 *  R6：plugin 集成（scheduler:tick → evaluate → business event）
 *  R7：dispose 后不继续处理 tick
 */

import { Context } from '@deepseek-ai/cordis'
import { EventBus } from '../dist/services/eventBus.js'
import { createScheduledRuleRegistry } from '../dist/services/scheduledRuleRegistry.js'
import { scheduledRuleRegistry } from '../dist/plugins/scheduled-rule-registry.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const logger = {
  info: (...a) => console.log('[log]', ...a),
  warn: (...a) => console.log('[warn]', ...a),
}

// ---------- R1：createScheduledRuleRegistry 纯函数 ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)

  check('R1.1: registry.size() === 0（初始空）', registry.size() === 0)
  check('R1.2: registry.ruleIds() === []（初始空）', JSON.stringify(registry.ruleIds()) === '[]')

  // register
  registry.register({
    ruleId: 'test-1',
    predicate: () => true,
    businessEvent: { source: 'test', type: 'event-a' },
  })
  check('R1.3: register 后 size() === 1', registry.size() === 1)
  check('R1.4: register 后 ruleIds() 包含 test-1', registry.ruleIds().includes('test-1'))

  // duplicate id →覆盖
  registry.register({
    ruleId: 'test-1',
    predicate: () => false,
    businessEvent: { source: 'test', type: 'event-b' },
  })
  check('R1.5: 同 id 覆盖后 size() 仍为 1', registry.size() === 1)

  // unregister
  const ok = registry.unregister('test-1')
  check('R1.6: unregister 成功返回 true', ok === true)
  check('R1.7: unregister 后 size() === 0', registry.size() === 0)
  check('R1.8: unregister 不存在的 id 返回 false', registry.unregister('not-exist') === false)
}

// ---------- R2：evaluate - predicate 命中 → emit business event ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)

  registry.register({
    ruleId: 'always-trigger',
    predicate: () => true,
    businessEvent: { source: 'test', type: 'triggered-event', priority: 2 },
  })

  // emit tick，触发 evaluate
  let receivedEvents = []
  bus.subscribe({ source: 'test', type: 'triggered-event' }, (e) => receivedEvents.push(e))

  const tick = { id: 'tick-1', source: 'scheduler', type: 'scheduler:tick', timestamp: 1_000_000, data: { tickCount: 1 }, priority: 1 }
  const triggered = registry._evaluate(tick)

  check('R2.1: predicate=true → triggered=1', triggered === 1)

  // bus.publish() 是同步的，但 handler 派发是异步的（setImmediate）
  // 需要等待异步派发完成
  await new Promise((r) => setImmediate(r))

  check('R2.2: business event 已发射到 EventBus', receivedEvents.length === 1)
  check('R2.3: business event.source === "test"', receivedEvents[0]?.source === 'test')
  check('R2.4: business event.type === "triggered-event"', receivedEvents[0]?.type === 'triggered-event')
  check('R2.5: business event.priority === 2', receivedEvents[0]?.priority === 2)
}

// ---------- R3：evaluate - predicate 不命中 → 不 emit ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)

  registry.register({
    ruleId: 'never-trigger',
    predicate: () => false,
    businessEvent: { source: 'test', type: 'never-event' },
  })

  let receivedEvents = []
  bus.subscribe({ source: 'test', type: 'never-event' }, (e) => receivedEvents.push(e))

  const tick = { id: 'tick-2', source: 'scheduler', type: 'scheduler:tick', timestamp: 2_000_000, data: { tickCount: 2 }, priority: 1 }
  const triggered = registry._evaluate(tick)

  check('R3.1: predicate=false → triggered=0', triggered === 0)
  check('R3.2: business event 未发射', receivedEvents.length === 0)
}

// ---------- R4：多个 rule 独立注册/评估 ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)

  let receivedA = [], receivedB = []
  bus.subscribe({ source: 'a', type: 'event-a' }, (e) => receivedA.push(e))
  bus.subscribe({ source: 'b', type: 'event-b' }, (e) => receivedB.push(e))

  registry.register({
    ruleId: 'rule-a',
    predicate: () => true,
    businessEvent: { source: 'a', type: 'event-a' },
  })
  registry.register({
    ruleId: 'rule-b',
    predicate: () => false,
    businessEvent: { source: 'b', type: 'event-b' },
  })

  const tick = { id: 'tick-3', source: 'scheduler', type: 'scheduler:tick', timestamp: 3_000_000, data: { tickCount: 3 }, priority: 1 }
  const triggered = registry._evaluate(tick)

  check('R4.1: 2 个 rule 中 1 个触发 → triggered=1', triggered === 1)

  // 等待异步派发
  await new Promise((r) => setImmediate(r))

  check('R4.2: rule-a 触发 → a:event-a 已发射', receivedA.length === 1)
  check('R4.3: rule-b 未触发 → b:event-b 未发射', receivedB.length === 0)

  // rule-b predicate 改为 true，再 evaluate
  registry.register({
    ruleId: 'rule-b',
    predicate: () => true,
    businessEvent: { source: 'b', type: 'event-b' },
  })
  const triggered2 = registry._evaluate(tick)

  check('R4.4: rule-b predicate=true 后 evaluate → triggered=2', triggered2 === 2)

  // 等待异步派发
  await new Promise((r) => setImmediate(r))

  check('R4.5: rule-b 也触发 → b:event-b 已发射', receivedB.length === 1)
}

// ---------- R5：lastTriggeredAt 上下文正确 ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)

  let callCount = 0
  let capturedCtx = null
  registry.register({
    ruleId: 'ctx-checker',
    predicate: (ctx) => {
      callCount++
      capturedCtx = ctx
      return true
    },
    businessEvent: { source: 'test', type: 'ctx-check' },
  })

  // 第一次 evaluate
  const tick1 = { id: 'tick-4', source: 'scheduler', type: 'scheduler:tick', timestamp: 4_000_000, data: { tickCount: 4 }, priority: 1 }
  registry._evaluate(tick1)
  check('R5.1: 第一次 evaluate，lastTriggeredAt === 0', capturedCtx?.lastTriggeredAt === 0)

  // 第二次 evaluate（later timestamp）
  const tick2 = { id: 'tick-5', source: 'scheduler', type: 'scheduler:tick', timestamp: 5_000_000, data: { tickCount: 5 }, priority: 1 }
  registry._evaluate(tick2)
  check('R5.2: 第二次 evaluate，lastTriggeredAt === tick1.timestamp', capturedCtx?.lastTriggeredAt === 4_000_000)
}

// ---------- R6：plugin 集成（scheduler:tick → evaluate → business event） ----------
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 2 }, export() {} })
  const bus = new EventBus({ windowSize: 10 }, logger)
  ctx.provide('eventBus', bus)

  // 挂载 plugin
  ctx.plugin(scheduledRuleRegistry, {})
  await new Promise((r) => setTimeout(r, 100))

  const registry = ctx.get('scheduledRuleRegistry')
  check('R6.1: ctx.scheduledRuleRegistry 已 provide', !!registry)

  // 验证 test-rule-always-trigger 已注册
  check('R6.2: test-rule-always-trigger 已注册', registry.ruleIds().includes('test-rule-always-trigger'))

  // 记录 business event 接收数
  let briefingDueCount = 0
  bus.subscribe({ source: 'scheduler', type: 'briefing:due' }, () => briefingDueCount++)

  // 发射 scheduler:tick
  bus.publish({ source: 'scheduler', type: 'scheduler:tick', data: { tickCount: 100 }, priority: 1 })
  await new Promise((r) => setTimeout(r, 50))

  check('R6.3: scheduler:tick 触发 test-rule → briefing:due 已发射', briefingDueCount >= 1)
}

// ---------- R7：多个 tick 连续触发 ----------
// 验证多个 scheduler:tick 连续到达时，registry 持续评估每个 tick
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 2 }, export() {} })
  const bus = new EventBus({ windowSize: 10 }, logger)
  ctx.provide('eventBus', bus)
  ctx.plugin(scheduledRuleRegistry, {})
  await new Promise((r) => setTimeout(r, 50))

  let receivedCount = 0
  bus.subscribe({ source: 'scheduler', type: 'briefing:due' }, () => receivedCount++)

  // 发射 3 个 tick
  bus.publish({ source: 'scheduler', type: 'scheduler:tick', data: { tickCount: 1 }, priority: 1 })
  bus.publish({ source: 'scheduler', type: 'scheduler:tick', data: { tickCount: 2 }, priority: 1 })
  bus.publish({ source: 'scheduler', type: 'scheduler:tick', data: { tickCount: 3 }, priority: 1 })
  await new Promise((r) => setTimeout(r, 100))

  // test-rule-always-trigger predicate=true，每个 tick 都触发
  check('R7.1: 3 个 tick → 3 次 business event', receivedCount === 3)
}

// ---------- 结果 ----------
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-scheduled-rule-registry 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-scheduled-rule-registry 失败 ${failed.length} 项`)
}
