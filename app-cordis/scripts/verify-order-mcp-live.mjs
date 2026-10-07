import assert from 'node:assert/strict'
import { getConfig, loadOrcaEnv } from '../dist/config.js'
import { createOrderActionHandlers, createOrderMcpService } from '../dist/services/orderMcp.js'

loadOrcaEnv()
const config = getConfig()
if (!config.orderMcp.luckin.token || !config.orderMcp.mcd.token) {
  console.error('FAIL credentials missing: check LUCKIN_COFFEE_TOKEN and MCDONALD_TOKEN in a private local .env')
  process.exit(1)
}

// 只用上海人民广场周边的公开参考坐标验证瑞幸门店查询；不读用户定位/地址，也不写回配置。
config.orderMcp.luckin.enabled = true
config.orderMcp.luckin.longitude = 121.475
config.orderMcp.luckin.latitude = 31.23
config.orderMcp.mcd.enabled = true

const service = createOrderMcpService(config.orderMcp)
try {
  await service.initialize()
  const handlers = new Map(createOrderActionHandlers({ service }).map((handler) => [handler.action, handler]))
  for (const [action, reason] of [
    ['order.luckin.stores', JSON.stringify({ deptName: '上海市' })],
    ['order.mcd.stores', JSON.stringify({ beType: 1, city: '上海市', keyword: '人民广场' })],
  ]) {
    const handler = handlers.get(action)
    assert.ok(handler, `${action} was not registered from the official tool list`)
    const result = await handler.execute({
      decisionId: `live-${action}`, attentionId: 'live-verification', ruleId: 'live-smoke',
      action, priority: 'normal', reason, eventId: 'live-readonly-event', decidedAt: Date.now(),
    })
    assert.equal(result.success, true, `${action} did not succeed`)
    assert.ok(result.message && result.message.length > 0, `${action} returned no user-safe summary`)
    assert.ok(result.message.length < 1_500, `${action} summary was not compact`)
    assert.match(result.message, /门店/, `${action} did not summarize store information`)
    assert.equal(result.sourceEventId, 'live-readonly-event')
    console.log(`PASS ${action}: official MCP query succeeded; summary chars=${result.message.length}`)
  }
  console.log(`PASS tools/list: 瑞幸 ${service.availableActions().filter((name) => name.startsWith('order.luckin.')).length} read-only actions; 麦当劳 ${service.availableActions().filter((name) => name.startsWith('order.mcd.')).length} read-only actions`)
} finally {
  service.dispose()
}
