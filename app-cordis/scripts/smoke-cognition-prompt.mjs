import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCognitionCore } from '../dist/services/cognition-core.js'
import { createContinuationStateService } from '../dist/services/continuationState.js'
import { getInitialState } from '../dist/services/worldState.js'
import { createCapabilityHandlers } from '../dist/services/capability-actions.js'

const prompts = []
const ctx = new Context()
ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })
ctx.provide('llm', { chat: async (messages) => {
  prompts.push(messages.find((message) => message.role === 'system')?.content ?? '')
  return '已确认当前上下文。'
} })
ctx.provide('actionExecutor', {
  registry: {
    list: () => [
      { action: 'system.info', llmDescription: '读取当前系统快照。' },
      ...createCapabilityHandlers({ workspaceRoot: process.cwd() }),
    ],
  },
})
ctx.provide('actionDescriptions', () => ['- location.current: 读取当前位置（参数：{}）。'])
ctx.provide('skillCatalog', {
  search: () => [{
    id: 'system-info',
    category: { domain: 'basic-control', subdomain: 'system', function: 'system-info' },
    summary: '读取受限的本机系统快照。',
    actions: ['system.info'],
    risk: 'read_only',
    confirmation: 'none',
    available: true,
    keywords: ['系统'],
  }],
})
ctx.provide('skillLoader', { load: () => '# system-info\n仅用于说明，不是执行入口。', loadedCount: () => 1 })
const continuation = createContinuationStateService()
continuation.getOrCreate('feishu:prompt-test', '查询系统状态')
continuation.setSlot('feishu:prompt-test', 'scope', {
  value: 'memory', sourceAction: 'system.info', confidence: 1,
})
continuation.recordAction({
  channelSessionId: 'feishu:prompt-test', action: 'system.info', args: { scope: ['memory'] },
  success: true, resultRef: 'result-1', resultSummary: 'memory available',
})
ctx.provide('continuationState', continuation)

const core = createCognitionCore(ctx)
core.onCognitionRequest({
  id: 'prompt-request-1',
  trigger: '查询系统状态',
  createdAt: Date.now(),
  sessionId: 'feishu:prompt-test',
  attentions: [{
    id: 'prompt-attention-1', ruleId: 'dashboard-message', priority: 'normal',
    reason: '用户问：当前系统状态如何？', action: 'remember_only',
    source: 'dashboard', sessionId: 'feishu:prompt-test', eventId: 'event-1',
    stateSnapshot: getInitialState(Date.now()), evaluatedAt: Date.now(),
  }],
})
await new Promise((resolve) => setTimeout(resolve, 40))

assert.equal(prompts.length, 1)
const prompt = prompts[0]
assert.match(prompt, /Skill 只提供 Action 组织和使用说明，不是执行对象/u)
assert.match(prompt, /ActionHandler 是实现，ActionExecutor 是统一调度入口/u)
assert.match(prompt, /当前可用 Action 只来自本轮 Runtime 注入的清单/u)
assert.match(prompt, /名称、说明、schema、风险和确认要求以清单为唯一依据/u)
assert.match(prompt, /每轮最多选择一个当前清单中的原子 Action/u)
assert.match(prompt, /ActionResult 是当前观察，不自动成为 WorldState/u)
assert.match(prompt, /本轮运行时上下文开始/u)
assert.match(prompt, /本轮运行时上下文结束/u)
assert.match(prompt, /registry\.list\(\) 只是 Runtime 构造本轮清单/u)
assert.match(prompt, /当前只是静态 Action 清单注入，不等于运行时分层 capability discovery/u)
assert.match(prompt, /当前轮决策规则/u)
assert.match(prompt, /已确认事实、当前不可确认、设计建议/u)
assert.match(prompt, /WorkingMemory：当前 cognition 短期信息/u)
assert.match(prompt, /ContinuationState：跨 cognition 任务状态/u)
assert.match(prompt, /system\.info/u)
assert.match(prompt, /location\.current/u)
assert.match(prompt, /filesystem\.read/u)
assert.match(prompt, /workspaceRoot 内的文件内容/u)
assert.match(prompt, /filesystem\.edit/u)
assert.match(prompt, /必须先取得用户批准/u)
assert.match(prompt, /web\.search/u)
assert.match(prompt, /通过 Bing 公开网页搜索/u)
assert.match(prompt, /不要假设 capability\.list、capability\.describe/u)
assert.doesNotMatch(prompt, /system-info.*action/u)
assert.ok(prompt.indexOf('固定执行协议') < prompt.indexOf('本轮运行时上下文开始'))
assert.ok(prompt.indexOf('本轮运行时上下文开始') < prompt.indexOf('运行时可用 Action'))
assert.ok(prompt.indexOf('运行时可用 Action') < prompt.indexOf('匹配的受控技能'))
assert.ok(prompt.indexOf('匹配的受控技能') < prompt.indexOf('ContinuationState'))
assert.ok(prompt.indexOf('ContinuationState') < prompt.indexOf('WorkingMemory'))
console.log('smoke-cognition-prompt: PASS')
