/**
 * ReminderIntervalRule 冒烟测试（Phase 7.1B）
 * 运行：npm run build && node scripts/smoke-reminder-rule.mjs
 *
 * 覆盖：
 *  R1：从未触发（lastTriggeredAt=0）→ 立即触发
 *  R2：间隔内（elapsed < interval）→ 不触发
 *  R3：间隔后（elapsed >= interval）→ 触发
 *  R4：Plugin 集成（scheduler:tick → reminder:due）
 *  R5：三个 Rule 同时注册，互不影响
 */

import { EventBus } from '../dist/services/eventBus.js'
import { createScheduledRuleRegistry } from '../dist/services/scheduledRuleRegistry.js'
import { createReminderIntervalRule } from '../dist/rules/scheduled/reminder.js'
import { createBriefingIntervalRule } from '../dist/rules/scheduled/briefing.js'
import { createReflectionIntervalRule } from '../dist/rules/scheduled/reflection.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const logger = {
  info: (...a) => console.log('[log]', ...a),
  warn: (...a) => console.log('[warn]', ...a),
}

// ---------- R1：从未触发（lastTriggeredAt=0）→ 立即触发 ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)

  const rule = createReminderIntervalRule('reminder-test', 60_000) // 60s 间隔
  registry.register(rule)

  let receivedEvents = []
  bus.subscribe({ source: 'scheduler', type: 'reminder:due' }, (e) => receivedEvents.push(e))

  const tick1 = { id: 'tick-1', source: 'scheduler', type: 'scheduler:tick', timestamp: 1_000_000, data: { tickCount: 1 }, priority: 1 }
  const triggered = registry._evaluate(tick1)

  await new Promise((r) => setImmediate(r))

  check('R1.1: 首次触发（lastTriggeredAt=0）→ triggered=1', triggered === 1)
  check('R1.2: reminder:due 已发射', receivedEvents.length === 1)
  check('R1.3: businessEvent.source === "scheduler"', receivedEvents[0]?.source === 'scheduler')
  check('R1.4: businessEvent.type === "reminder:due"', receivedEvents[0]?.type === 'reminder:due')
  check('R1.5: businessEvent.data.ruleId === "reminder-test"', receivedEvents[0]?.data?.ruleId === 'reminder-test')
}

// ---------- R2：间隔内（elapsed < interval）→ 不触发 ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)

  const rule = createReminderIntervalRule('reminder-test-2', 60_000)
  registry.register(rule)

  let receivedEvents = []
  bus.subscribe({ source: 'scheduler', type: 'reminder:due' }, (e) => receivedEvents.push(e))

  // 第一次触发
  const tick1 = { id: 'tick-1', source: 'scheduler', type: 'scheduler:tick', timestamp: 1_000_000, data: { tickCount: 1 }, priority: 1 }
  registry._evaluate(tick1)
  await new Promise((r) => setImmediate(r))

  // 第二次（30s 后，< 60s 间隔）
  const tick2 = { id: 'tick-2', source: 'scheduler', type: 'scheduler:tick', timestamp: 1_000_000 + 30_000, data: { tickCount: 2 }, priority: 1 }
  const triggered = registry._evaluate(tick2)

  await new Promise((r) => setImmediate(r))

  check('R2.1: 间隔内（30s < 60s）→ triggered=0', triggered === 0)
  check('R2.2: 无新事件发射', receivedEvents.length === 1)
}

// ---------- R3：间隔后（elapsed >= interval）→ 触发 ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)

  const rule = createReminderIntervalRule('reminder-test-3', 60_000)
  registry.register(rule)

  let receivedEvents = []
  bus.subscribe({ source: 'scheduler', type: 'reminder:due' }, (e) => receivedEvents.push(e))

  // 第一次触发
  const tick1 = { id: 'tick-1', source: 'scheduler', type: 'scheduler:tick', timestamp: 1_000_000, data: { tickCount: 1 }, priority: 1 }
  registry._evaluate(tick1)
  await new Promise((r) => setImmediate(r))

  // 刚好 60s 后
  const tick2 = { id: 'tick-2', source: 'scheduler', type: 'scheduler:tick', timestamp: 1_000_000 + 60_000, data: { tickCount: 2 }, priority: 1 }
  const triggered1 = registry._evaluate(tick2)

  await new Promise((r) => setImmediate(r))

  check('R3.1: 刚好 60s（==间隔）→ triggered=1', triggered1 === 1)
  check('R3.2: 第二次 reminder:due 已发射', receivedEvents.length === 2)

  // 120s 后
  const tick3 = { id: 'tick-3', source: 'scheduler', type: 'scheduler:tick', timestamp: 1_000_000 + 120_000, data: { tickCount: 3 }, priority: 1 }
  const triggered2 = registry._evaluate(tick3)

  await new Promise((r) => setImmediate(r))

  check('R3.3: 120s 后（>间隔）→ triggered=1', triggered2 === 1)
  check('R3.4: 第三次 reminder:due 已发射', receivedEvents.length === 3)
}

// ---------- R4：Plugin 集成（scheduler:tick → reminder:due） ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)
  const reminderRule = createReminderIntervalRule('reminder-plugin-test', 10_000) // 10s 间隔
  registry.register(reminderRule)

  let receivedCount = 0
  bus.subscribe({ source: 'scheduler', type: 'reminder:due' }, () => receivedCount++)

  // 手动订阅 scheduler:tick 并触发 evaluate（模拟 plugin 行为）
  bus.subscribe({ source: 'scheduler', type: 'scheduler:tick' }, (tick) => {
    registry._evaluate(tick)
  })

  const t0 = 3_000_000

  // 第一次 tick（lastTriggeredAt=0 → 立即触发）
  bus.publish({ id: 'tick-1', source: 'scheduler', type: 'scheduler:tick', timestamp: t0, data: { tickCount: 1 }, priority: 1 })
  await new Promise((r) => setTimeout(r, 50))

  check('R4.1: 首次 tick → reminder:due 已发射', receivedCount === 1)

  // 第二次 tick（5s 后，< 10s 间隔 → 不触发）
  bus.publish({ id: 'tick-2', source: 'scheduler', type: 'scheduler:tick', timestamp: t0 + 5_000, data: { tickCount: 2 }, priority: 1 })
  await new Promise((r) => setTimeout(r, 50))

  check('R4.2: 间隔内 tick → 不触发', receivedCount === 1)

  // 第三次 tick（10s 后，>= 10s 间隔 → 触发）
  bus.publish({ id: 'tick-3', source: 'scheduler', type: 'scheduler:tick', timestamp: t0 + 10_000, data: { tickCount: 3 }, priority: 1 })
  await new Promise((r) => setTimeout(r, 50))

  check('R4.3: 10s 后 tick → 再次触发', receivedCount === 2)
}

// ---------- R5：三个 Rule 同时注册，互不影响 ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)

  // briefing: 30s interval
  const briefingRule = createBriefingIntervalRule('briefing-multi', 30_000)
  // reflection: 60s interval
  const reflectionRule = createReflectionIntervalRule('reflection-multi', 60_000)
  // reminder: 20s interval
  const reminderRule = createReminderIntervalRule('reminder-multi', 20_000)

  registry.register(briefingRule)
  registry.register(reflectionRule)
  registry.register(reminderRule)

  let briefingCount = 0, reflectionCount = 0, reminderCount = 0
  bus.subscribe({ source: 'scheduler', type: 'briefing:due' }, () => briefingCount++)
  bus.subscribe({ source: 'scheduler', type: 'reflection:due' }, () => reflectionCount++)
  bus.subscribe({ source: 'scheduler', type: 'reminder:due' }, () => reminderCount++)

  // 订阅 scheduler:tick，手动触发 evaluate（模拟 plugin 行为）
  bus.subscribe({ source: 'scheduler', type: 'scheduler:tick' }, (tick) => {
    registry._evaluate(tick)
  })

  // tick at t0
  const t0 = 5_000_000
  bus.publish({ id: 'tick-1', source: 'scheduler', type: 'scheduler:tick', timestamp: t0, priority: 1 })
  // 等两个 setImmediate cycles（dispatch + evaluate）
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 10))

  // all three: lastTriggeredAt=0 → immediate trigger
  check('R5.1: t0 时三个 rule 均首次触发', briefingCount === 1 && reflectionCount === 1 && reminderCount === 1)

  // tick at t0+10s: briefing(30s,未到) reminder(20s,未到) reflection(60s,未到)
  bus.publish({ id: 'tick-2', source: 'scheduler', type: 'scheduler:tick', timestamp: t0 + 10_000, priority: 1 })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 10))
  check('R5.2: t0+10s 时三个 rule 均不触发', briefingCount === 1 && reflectionCount === 1 && reminderCount === 1)

  // tick at t0+20s: reminder 到期
  bus.publish({ id: 'tick-3', source: 'scheduler', type: 'scheduler:tick', timestamp: t0 + 20_000, priority: 1 })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 10))
  check('R5.3: t0+20s reminder 触发（briefing/reflection 仍不触发）', briefingCount === 1 && reflectionCount === 1 && reminderCount === 2)

  // tick at t0+30s: briefing 到期
  bus.publish({ id: 'tick-4', source: 'scheduler', type: 'scheduler:tick', timestamp: t0 + 30_000, priority: 1 })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 10))
  check('R5.4: t0+30s briefing 触发（reminder 不重复，reflection 仍不触发）', briefingCount === 2 && reminderCount === 2 && reflectionCount === 1)

  // tick at t0+60s: briefing 和 reflection 都到期
  bus.publish({ id: 'tick-5', source: 'scheduler', type: 'scheduler:tick', timestamp: t0 + 60_000, priority: 1 })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 10))
  check('R5.5: t0+60s briefing+reflection+reminder 触发（三个 interval 都到期）', briefingCount === 3 && reflectionCount === 2 && reminderCount === 3)
}

// ---------- 结果 ----------
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-reminder-rule 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-reminder-rule 失败 ${failed.length} 项`)
}
