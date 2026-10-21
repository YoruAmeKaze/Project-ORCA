import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCognitionCore } from '../dist/services/cognition-core.js'
import { createContinuationStateService } from '../dist/services/continuationState.js'
import { getInitialState } from '../dist/services/worldState.js'

const prompts = []
const ctx = new Context()
ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })
ctx.provide('llm', { chat: async (messages) => {
  prompts.push(messages.find((message) => message.role === 'system')?.content ?? '')
  return '已确认当前上下文。'
} })
ctx.provide('actionExecutor', {
  registry: {
    list: () => [{ action: 'system.info', llmDescription: '读取当前系统快照。' }],
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
assert.match(prompt, /Skill 是相关函数的小类、函数包和使用说明，不是可执行对象/u)
assert.match(prompt, /Action 是唯一的原子执行单位/u)
assert.match(prompt, /ActionHandler 是某个 Action 的具体实现；ActionExecutor 是统一调度入口/u)
assert.match(prompt, /当前是静态 Action 清单注入，不是真正的运行时分层 capability discovery/u)
assert.match(prompt, /不要猜测、创造相似名称、直接调用 MCP/u)
assert.match(prompt, /ActionResult、原始工具全文、Action 日志和临时推理不会自动成为 WorldState/u)
assert.match(prompt, /EventBus 主要负责事件传播/u)
assert.match(prompt, /已确认事实（当前上下文、日志、Action 结果或代码明确提供）/u)
assert.match(prompt, /当前不可确认（超出当前可见范围）/u)
assert.match(prompt, /设计建议（未来方案，不代表已经实现）/u)
assert.match(prompt, /WorkingMemory：当前 cognition 短期信息/u)
assert.match(prompt, /ContinuationState：跨 cognition 任务状态/u)
assert.match(prompt, /system\.info/u)
assert.match(prompt, /location\.current/u)
assert.doesNotMatch(prompt, /capability\.list.*已实现/u)
assert.doesNotMatch(prompt, /system-info.*action/u)
console.log('smoke-cognition-prompt: PASS')
