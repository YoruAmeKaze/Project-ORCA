import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOrderActionHandlers, createOrderMcpService } from '../dist/services/orderMcp.js'

const luckinNames = ['queryShopList', 'searchProductForMcp', 'queryProductDetailInfo', 'previewOrder', 'queryOrderDetailInfo']
const mcdNames = ['query-nearby-stores', 'query-meals', 'query-meal-detail', 'calculate-price', 'query-order', 'query-store-coupons', 'now-time-info']
const writeNames = new Set(['createOrder', 'cancelOrder', 'create-order', 'cancel-order', 'auto-bind-coupons', 'delivery-create-address'])
const state = { luckinCalls: [], mcdCalls: [], schemaChanged: false }

function schema(name) {
  if (name === 'queryShopList') return {
    type: 'object', properties: { deptName: { type: 'string' }, longitude: { type: state.schemaChanged ? 'string' : 'number' }, latitude: { type: 'number' } },
    required: ['longitude', 'latitude'], additionalProperties: false,
  }
  if (name === 'now-time-info') return { type: 'object', properties: {}, additionalProperties: false }
  return { type: 'object', properties: {}, additionalProperties: true }
}

function createMockServer(label, expectedToken, toolNames) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (req.headers.authorization !== `Bearer ${expectedToken}`) {
      res.writeHead(401).end()
      return
    }
    if (request.method === 'notifications/initialized') {
      res.writeHead(202).end()
      return
    }
    let result
    if (request.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: label, version: 'test' } }
    } else if (request.method === 'tools/list') {
      result = { tools: toolNames.map((name) => ({ name, inputSchema: schema(name) })) }
    } else if (request.method === 'tools/call') {
      const calls = label === 'luckin' ? state.luckinCalls : state.mcdCalls
      calls.push(request.params.name)
      if (writeNames.has(request.params.name)) {
        res.writeHead(403).end()
        return
      }
      result = { content: [{ type: 'text', text: JSON.stringify({ success: true, data: [{ storeName: 'ORCA Test Store' }] }) }], isError: false }
    } else {
      res.writeHead(400).end()
      return
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    res.writeHead(200, { 'content-type': 'application/json' }).end(body)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    endpoint: `http://127.0.0.1:${server.address().port}`,
  })))
}

const luckin = await createMockServer('luckin', 'luckin-test-secret', luckinNames)
const mcd = await createMockServer('mcd', 'mcd-test-secret', mcdNames)
try {
  const location = { getLatest: () => ({ latitude: 31, longitude: 121, accuracyMeters: 50, capturedAt: Date.now(), expiresAt: Date.now() + 60_000 }) }
  const service = createOrderMcpService({
    luckin: { enabled: true, endpoint: luckin.endpoint, token: 'luckin-test-secret', longitude: 121, latitude: 31 },
    mcd: { enabled: true, endpoint: mcd.endpoint, token: 'mcd-test-secret' },
  }, undefined, location)
  await service.initialize()
  assert.ok(service.availableActions().includes('order.luckin.stores'))
  assert.ok(service.availableActions().includes('order.mcd.server_time'))

  const handlers = createOrderActionHandlers({ service })
  const luckinStoreHandler = handlers.find((handler) => handler.action === 'order.luckin.stores')
  assert.ok(luckinStoreHandler)
  const decision = {
    decisionId: 'test-decision', attentionId: 'test-attention', ruleId: 'test',
    action: 'order.luckin.stores', priority: 'normal', reason: JSON.stringify({ deptName: '上海' }),
    eventId: 'source-event', decidedAt: Date.now(),
  }
  const result = await luckinStoreHandler.execute(decision)
  assert.equal(result.success, true)
  assert.equal(result.sourceEventId, 'source-event')
  assert.match(result.message ?? '', /ORCA Test Store/)

  await service.execute('order.mcd.server_time', {})
  state.schemaChanged = true
  await assert.rejects(
    () => service.execute('order.luckin.stores', { deptName: '上海' }),
    /schema changed/,
  )
  await assert.rejects(() => service.execute('order.mcd.create_order', {}), /此 Action 未注册/)
  assert.deepEqual(state.luckinCalls, ['queryShopList'])
  assert.deepEqual(state.mcdCalls, ['now-time-info'])

  service.dispose()
  const noLocation = createOrderMcpService({
    luckin: { enabled: true, endpoint: luckin.endpoint, token: 'luckin-test-secret' },
    mcd: { enabled: false, endpoint: mcd.endpoint, token: '' },
  })
  await noLocation.initialize()
  assert.ok(!noLocation.availableActions().includes('order.luckin.stores'))
  noLocation.dispose()
  console.log('PASS order MCP readonly handlers: provider isolation, schemas, same-session result, no write tools, location gate')
} finally {
  await Promise.all([new Promise((resolve) => luckin.server.close(resolve)), new Promise((resolve) => mcd.server.close(resolve))])
}
