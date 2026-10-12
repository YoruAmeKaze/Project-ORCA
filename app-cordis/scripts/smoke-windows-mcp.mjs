import assert from 'node:assert/strict'
import { createWindowsDesktopActionHandlers, createWindowsMcpService } from '../dist/services/windowsMcp.js'

const calls = []
const transport = {
  async request(method, params) {
    calls.push({ method, params })
    if (method === 'initialize') return { protocolVersion: '2025-06-18' }
    if (method === 'notifications/initialized') return undefined
    if (method === 'tools/list') {
      const schema = { type: 'object', properties: {}, additionalProperties: false }
      return { tools: [
        { name: 'Screenshot', inputSchema: schema, annotations: { readOnlyHint: true } },
        { name: 'Snapshot', inputSchema: schema, annotations: { readOnlyHint: true } },
        { name: 'DisplayInventory', inputSchema: schema, annotations: { readOnlyHint: true } },
        { name: 'ControlStatus', inputSchema: schema, annotations: { readOnlyHint: true } },
        { name: 'PowerShell', inputSchema: schema, annotations: { readOnlyHint: false } },
      ] }
    }
    if (method === 'tools/call') return { content: [{ type: 'text', text: 'display=1' }, { type: 'image', data: 'secret-base64-image' }] }
    throw new Error(`unexpected method ${method}`)
  },
  dispose() {},
}

const service = createWindowsMcpService({ enabled: true, endpoint: 'https://windows.invalid/mcp', token: 'test-token', timeoutMs: 100, protocolVersion: '2025-06-18' }, undefined, transport)
await service.initialize()
assert.equal(service.availableActions().length, 4)
assert.equal(service.describeActions().length, 4)
const result = await service.execute('windows.desktop.screenshot', {})
assert.match(result.message, /display=1/)
assert.match(result.message, /未保存/)
assert.equal(result.message.includes('secret-base64-image'), false)
await assert.rejects(() => service.execute('windows.desktop.screenshot', { shell: 'nope' }), /unexpected property/)
const handler = createWindowsDesktopActionHandlers(service)[0]
const actionResult = await handler.execute({ action: handler.action, decisionId: 'd1', attentionId: 'a1', ruleId: 'skill', priority: 'normal', reason: '{}', decidedAt: Date.now() })
assert.equal(actionResult.success, true)
assert.equal(calls.filter((call) => call.method === 'tools/call').length, 2)
service.dispose()
console.log('smoke-windows-mcp: PASS')
