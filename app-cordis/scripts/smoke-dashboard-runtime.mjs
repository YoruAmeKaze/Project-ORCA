/**
 * Dashboard → EventBus → Attention → Cognition → SSE reply 冒烟测试。
 * 运行：npm run build && node scripts/smoke-dashboard-runtime.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import { EventBus } from '../dist/services/eventBus.js'
import { createWorldStateService } from '../dist/services/worldState.js'
import { attentionEngine } from '../dist/plugins/attention-engine.js'
import { dashboardAdapter } from '../dist/plugins/input-adapters/dashboard-adapter.js'
import { createCognitiveScheduler } from '../dist/services/cognitive-scheduler.js'
import { createCognitionCore } from '../dist/services/cognition-core.js'
import { cognitionOutputPlugin } from '../dist/plugins/cognition-output-plugin.js'

const checks = []
function check(name, condition) {
  checks.push(Boolean(condition))
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
}

const config = { runtime: { enabled: true } }
const ctx = new Context()
ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })
ctx.provide('eventBus', new EventBus({ windowSize: 20 }, ctx.logger))
ctx.provide('worldState', createWorldStateService())
ctx.provide('llm', { chat: async () => 'Dashboard runtime reply' })
ctx.provide('feishu', { sendToChat: async () => { throw new Error('dashboard reply must not use Feishu') } })

const attentions = []
const replies = []
ctx.on('orca/attention', (item) => attentions.push(item))
ctx.eventBus.subscribe({ source: 'orca', type: 'dashboard-reply' }, (event) => replies.push(event))

await ctx.plugin(attentionEngine, config)
await ctx.plugin(cognitionOutputPlugin, config)

const scheduler = createCognitiveScheduler(ctx)
const core = createCognitionCore(ctx)
ctx.on('orca/attention', (item) => scheduler.enqueue(item))
ctx.on('orca/cognition-request', (request) => core.onCognitionRequest(request))
dashboardAdapter(ctx, config)

ctx.emit('dashboard/message', { id: 'dashboard-smoke-1', text: '请告诉我当前状态', device: 'mobile' })
await new Promise((resolve) => setTimeout(resolve, 120))

check('DR1 dashboard/message 已进入 EventBus', ctx.eventBus.recent(10, { source: 'dashboard', type: 'message' }).length === 1)
const dashboardEvent = ctx.eventBus.recent(10, { source: 'dashboard', type: 'message' })[0]
check('DR1b 用户消息语义与设备字段已透传', dashboardEvent?.data?.actor === 'user' && dashboardEvent?.data?.messageKind === 'user_message' && dashboardEvent?.data?.device === 'mobile')
check('DR2 Dashboard 消息触发 Attention', attentions.length === 1 && attentions[0]?.ruleId === 'dashboard-message')
check('DR3 Attention 保留 Dashboard 请求 id', attentions[0]?.dashboardMessageId === 'dashboard-smoke-1')
check('DR4 Cognition 输出已回到 Dashboard EventBus', replies.length === 1)
check('DR5 回复关联原请求且内容正确', replies[0]?.data.id === 'dashboard-smoke-1' && replies[0]?.data.reply === 'Dashboard runtime reply')

if (checks.every(Boolean)) {
  console.log(`\n${checks.length}/${checks.length} PASS`)
  process.exit(0)
}
console.error(`\n${checks.filter(Boolean).length}/${checks.length} PASS`)
process.exit(1)
