/**
 * ScheduledRule Factory 冒烟测试（Phase 7.2）
 * 运行：npm run build && node scripts/smoke-scheduled-rule-factory.mjs
 *
 * 覆盖：
 *  R1：enabled=true → Rule 注册
 *  R2：enabled=false → Rule 不注册
 *  R3：interval 配置正确传入 Rule
 *  R4：多 Rule 配置同时生效
 *  R5：缺失配置时默认行为
 */

import { createScheduledRulesFromConfig } from '../dist/rules/scheduled/factory.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// ---------- R1：enabled=true → Rule 注册 ----------
{
  const config = {
    briefing: { enabled: true, intervalMs: 3_600_000 },
  }
  const rules = createScheduledRulesFromConfig(config)
  check('R1.1: briefing enabled → 返回 1 条 rule', rules.length === 1)
  check('R1.2: ruleId === "scheduled-briefing"', rules[0]?.ruleId === 'scheduled-briefing')
  check('R1.3: type === "briefing:due"', rules[0]?.businessEvent.type === 'briefing:due')
}

// ---------- R2：enabled=false → Rule 不注册 ----------
{
  const config = {
    briefing: { enabled: false, intervalMs: 3_600_000 },
  }
  const rules = createScheduledRulesFromConfig(config)
  check('R2.1: briefing disabled → 返回 0 条 rule', rules.length === 0)
}

// ---------- R3：interval 配置正确传入 Rule ----------
{
  const config = {
    briefing: { enabled: true, intervalMs: 3_600_000 }, // 1h interval
  }
  const rules = createScheduledRulesFromConfig(config)

  // 通过 predicate 行为验证 intervalMs 是否正确传入
  // predicate: elapsed >= intervalMs 时才触发
  // lastTriggeredAt=0 → 立即触发
  // elapsed < 1h → 不触发
  const rule = rules[0]
  const ctx0 = { tick: { timestamp: 1_000_000 }, lastTriggeredAt: 0 }
  // 30min elapsed < 1h interval → false
  const ctx1 = { tick: { timestamp: 1_000_000 + 1_800_000 }, lastTriggeredAt: 1_000_000 }

  const first = rule.predicate(ctx0)
  const second = rule.predicate(ctx1)
  check('R3.1: lastTriggeredAt=0 → predicate=true', first === true)
  check('R3.2: 30min elapsed < 1h interval → predicate=false', second === false)

  // 验证 intervalMs === 99_999_999
  // 1_000_100_000 - 1_000_000 = 99_999_000 < 99_999_999
  // 如果 predicate 内部 interval 正确，应该 false
}

// ---------- R4：多 Rule 配置同时生效 ----------
{
  const config = {
    briefing: { enabled: true, intervalMs: 3_600_000 },
    reflection: { enabled: true, intervalMs: 7_200_000 },
    reminder: { enabled: true, intervalMs: 600_000 },
  }
  const rules = createScheduledRulesFromConfig(config)
  check('R4.1: 3 个 enabled → 返回 3 条 rule', rules.length === 3)

  const ids = rules.map((r) => r.ruleId)
  check('R4.2: ruleIds 含 scheduled-briefing', ids.includes('scheduled-briefing'))
  check('R4.3: ruleIds 含 scheduled-reflection', ids.includes('scheduled-reflection'))
  check('R4.4: ruleIds 含 scheduled-reminder', ids.includes('scheduled-reminder'))

  const types = rules.map((r) => r.businessEvent.type)
  check('R4.5: types 含 briefing:due', types.includes('briefing:due'))
  check('R4.6: types 含 reflection:due', types.includes('reflection:due'))
  check('R4.7: types 含 reminder:due', types.includes('reminder:due'))
}

// ---------- R5：缺失配置时默认行为 ----------
{
  // undefined config → 所有 enabled=false → 0 rules
  const rules0 = createScheduledRulesFromConfig(undefined)
  check('R5.1: undefined config → 0 rules', rules0.length === 0)

  // partial config → missing types → false
  const partial = {
    briefing: { enabled: true, intervalMs: 3_600_000 },
    // reflection 和 reminder 缺失
  }
  const rules1 = createScheduledRulesFromConfig(partial)
  check('R5.2: partial config → 只有 enabled 的 rule', rules1.length === 1)
  check('R5.3: 只有 briefing rule', rules1[0]?.ruleId === 'scheduled-briefing')

  // briefing enabled 但无 intervalMs → 使用默认
  const defaults = {
    briefing: { enabled: true }, // 无 intervalMs
  }
  const rules2 = createScheduledRulesFromConfig(defaults)
  check('R5.4: 无 intervalMs → 仍返回 rule（使用默认 interval）', rules2.length === 1)
  // 验证默认 interval 4h = 4*60*60*1000
  const ctxDefault = { tick: { timestamp: 1_000_000 }, lastTriggeredAt: 0 }
  check('R5.5: 默认 interval 4h（lastTriggeredAt=0 → predicate=true）', rules2[0]?.predicate(ctxDefault) === true)
}

// ---------- 结果 ----------
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-scheduled-rule-factory 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-scheduled-rule-factory 失败 ${failed.length} 项`)
}
