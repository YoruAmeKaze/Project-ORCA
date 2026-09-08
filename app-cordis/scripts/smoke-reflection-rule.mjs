/**
 * ReflectionIntervalRule 冒烟测试（Phase 7.1B）
 * 运行：npm run build && node scripts/smoke-reflection-rule.mjs
 *
 * 覆盖：
 *  R1：从未触发（lastTriggeredAt=0）→ 立即触发
 *  R2：间隔内（elapsed < interval）→ 不触发
 *  R3：间隔后（elapsed >= interval）→ 触发
 *  R4：Plugin 集成（scheduler:tick → reflection:due）
 */

import { EventBus } from '../dist/services/eventBus.js'
import { createScheduledRuleRegistry } from '../dist/services/scheduledRuleRegistry.js'
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

  const rule = createReflectionIntervalRule('reflection-test', 60_000) // 60s 间隔
  registry.register(rule)

  let receivedEvents = []
  bus.subscribe({ source: 'scheduler', type: 'reflection:due' }, (e) => receivedEvents.push(e))

  const tick1 = { id: 'tick-1', source: 'scheduler', type: 'scheduler:tick', timestamp: 1_000_000, data: { tickCount: 1 }, priority: 1 }
  const triggered = registry._evaluate(tick1)

  await new Promise((r) => setImmediate(r))

  check('R1.1: 首次触发（lastTriggeredAt=0）→ triggered=1', triggered === 1)
  check('R1.2: reflection:due 已发射', receivedEvents.length === 1)
  check('R1.3: businessEvent.source === "scheduler"', receivedEvents[0]?.source === 'scheduler')
  check('R1.4: businessEvent.type === "reflection:due"', receivedEvents[0]?.type === 'reflection:due')
  check('R1.5: businessEvent.data.ruleId === "reflection-test"', receivedEvents[0]?.data?.ruleId === 'reflection-test')
}

// ---------- R2：间隔内（elapsed < interval）→ 不触发 ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)

  const rule = createReflectionIntervalRule('reflection-test-2', 60_000)
  registry.register(rule)

  let receivedEvents = []
  bus.subscribe({ source: 'scheduler', type: 'reflection:due' }, (e) => receivedEvents.push(e))

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

  const rule = createReflectionIntervalRule('reflection-test-3', 60_000)
  registry.register(rule)

  let receivedEvents = []
  bus.subscribe({ source: 'scheduler', type: 'reflection:due' }, (e) => receivedEvents.push(e))

  // 第一次触发
  const tick1 = { id: 'tick-1', source: 'scheduler', type: 'scheduler:tick', timestamp: 1_000_000, data: { tickCount: 1 }, priority: 1 }
  registry._evaluate(tick1)
  await new Promise((r) => setImmediate(r))

  // 刚好 60s 后
  const tick2 = { id: 'tick-2', source: 'scheduler', type: 'scheduler:tick', timestamp: 1_000_000 + 60_000, data: { tickCount: 2 }, priority: 1 }
  const triggered1 = registry._evaluate(tick2)

  await new Promise((r) => setImmediate(r))

  check('R3.1: 刚好 60s（==间隔）→ triggered=1', triggered1 === 1)
  check('R3.2: 第二次 reflection:due 已发射', receivedEvents.length === 2)

  // 120s 后
  const tick3 = { id: 'tick-3', source: 'scheduler', type: 'scheduler:tick', timestamp: 1_000_000 + 120_000, data: { tickCount: 3 }, priority: 1 }
  const triggered2 = registry._evaluate(tick3)

  await new Promise((r) => setImmediate(r))

  check('R3.3: 120s 后（>间隔）→ triggered=1', triggered2 === 1)
  check('R3.4: 第三次 reflection:due 已发射', receivedEvents.length === 3)
}

// ---------- R4：Plugin 集成（scheduler:tick → reflection:due） ----------
{
  const bus = new EventBus({ windowSize: 10 }, logger)
  const registry = createScheduledRuleRegistry(bus, logger)
  const reflectionRule = createReflectionIntervalRule('reflection-plugin-test', 10_000) // 10s 间隔
  registry.register(reflectionRule)

  let receivedCount = 0
  bus.subscribe({ source: 'scheduler', type: 'reflection:due' }, () => receivedCount++)

  // 手动订阅 scheduler:tick 并触发 evaluate（模拟 plugin 行为）
  bus.subscribe({ source: 'scheduler', type: 'scheduler:tick' }, (tick) => {
    registry._evaluate(tick)
  })

  const t0 = 2_000_000

  // 第一次 tick（lastTriggeredAt=0 → 立即触发）
  bus.publish({ id: 'tick-1', source: 'scheduler', type: 'scheduler:tick', timestamp: t0, data: { tickCount: 1 }, priority: 1 })
  await new Promise((r) => setTimeout(r, 50))

  check('R4.1: 首次 tick → reflection:due 已发射', receivedCount === 1)

  // 第二次 tick（5s 后，< 10s 间隔 → 不触发）
  bus.publish({ id: 'tick-2', source: 'scheduler', type: 'scheduler:tick', timestamp: t0 + 5_000, data: { tickCount: 2 }, priority: 1 })
  await new Promise((r) => setTimeout(r, 50))

  check('R4.2: 间隔内 tick → 不触发', receivedCount === 1)

  // 第三次 tick（10s 后，>= 10s 间隔 → 触发）
  bus.publish({ id: 'tick-3', source: 'scheduler', type: 'scheduler:tick', timestamp: t0 + 10_000, data: { tickCount: 3 }, priority: 1 })
  await new Promise((r) => setTimeout(r, 50))

  check('R4.3: 10s 后 tick → 再次触发', receivedCount === 2)
}

// ---------- 结果 ----------
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-reflection-rule 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-reflection-rule 失败 ${failed.length} 项`)
}
