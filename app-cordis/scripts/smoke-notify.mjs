/**
 * Notify Action 冒烟测试（Phase 4.C）
 * 运行：npm run build && node scripts/smoke-notify.mjs
 *
 * 覆盖：
 *  R15.1  EventBus.get(id) 反查能力
 *    R15.1.1: 空 buffer get 返回 undefined
 *    R15.1.2: 已 publish 的事件 get 返回对应 event
 *    R15.1.3: 不存在的 id 返回 undefined
 *    R15.1.4: 超出 sliding window 的事件 get 返回 undefined（已丢弃）
 *
 *  R15.2  state-only Decision（eventId undefined）
 *    R15.2.1: success=false
 *    R15.2.2: error 含 "no source event for state-only trigger"
 *
 *  R15.3  source 校验
 *    R15.3.1: event.source === 'feishu' → 继续（不立即 fail）
 *    R15.3.2: event.source === 'pc' → success=false + "unsupported source"
 *
 *  R15.4  Feishu event.data context 校验
 *    R15.4.1: data.chatId 合法 → 继续
 *    R15.4.2: data.chatId 缺失 → success=false + "missing chat context"
 *    R15.4.3: data.chatId 非字符串 → success=false + "missing chat context"
 *
 *  R15.5  dryRun 复用
 *    R15.5.1: dryRun=true → success=true
 *    R15.5.2: dryRun=true → feishu.sendToChat **未**被调用
 *    R15.5.3: dryRun=true → metadata.dryRun=true
 *    R15.5.4: dryRun=true → metadata.chatId 保留
 *    R15.5.5: dryRun=false → feishu.sendToChat **被**调用（mock 计数器 +1）
 *
 *  R15.6  真实发送（mock FeishuClient）
 *    R15.6.1: sendToChat 收到 (chatId, text)
 *    R15.6.2: text 含 "[Orca] ${priority}" 与 reason
 *    R15.6.3: text 含 "源消息: ${originalText.slice(0,200)}"（当 text 存在）
 *    R15.6.4: success=true + metadata.chatId 保留
 *
 *  R15.7  发送失败（FeishuClient 抛异常）
 *    R15.7.1: success=false
 *    R15.7.2: error 含 "feishu sendToChat failed"
 *    R15.7.3: EventBus 不崩溃（throw 是 handler.execute 内部）
 *
 *  R15.8  EventBus 集成
 *    R15.8.1: emit(orca/decision notify) → orca/action-result（plugin + real handler）
 *    R15.8.2: result.success 反映真实发送结果
 *
 *  R15.9  Decision 追踪字段
 *    R15.9.1: result.decisionId 透传
 *    R15.9.2: result.action === decision.action
 *    R15.9.3: result.executedAt 是 number
 */

import { Context } from '@deepseek-ai/cordis'
import { EventBus } from '../dist/services/eventBus.js'
import { createNotifyHandler } from '../dist/services/action.js'
import { actionExecutor } from '../dist/plugins/action-executor.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// 测试辅助：构造 Decision
function mkDecision(overrides = {}) {
  return {
    decisionId: overrides.decisionId ?? `dec_${Math.random().toString(36).slice(2)}`,
    attentionId: overrides.attentionId ?? `att_${Math.random().toString(36).slice(2)}`,
    ruleId: overrides.ruleId ?? 'test-rule',
    action: overrides.action ?? 'notify',
    priority: overrides.priority ?? 'normal',
    reason: overrides.reason ?? 'test reason',
    eventId: overrides.eventId ?? 'evt_test',
    source: overrides.source ?? 'feishu',
    decidedAt: overrides.decidedAt ?? Date.now(),
    ...overrides,
  }
}

// 测试辅助：mock FeishuClient（结构化类型；只声明 sendToChat）
function mkMockFeishu() {
  const calls = []
  let nextThrow = null
  return {
    calls,
    setNextThrow(msg) { nextThrow = msg },
    sendToChat: async (chatId, text) => {
      calls.push({ chatId, text })
      if (nextThrow) {
        const e = new Error(nextThrow)
        nextThrow = null
        throw e
      }
    },
  }
}

// 测试辅助：构造一个 mock FeishuClient 工厂 + 集成到 bus
function makeMockFeishuAndBus(windowSize = 5) {
  const bus = new EventBus({ windowSize })
  const feishu = mkMockFeishu()
  return { bus, feishu }
}

// 测试辅助：构造 Decision，并立即把对应 eventId publish 到 bus（保证反查可达）
function mkDecisionWithEvent(bus, feishuData, decisionOverrides = {}) {
  bus.publish({
    source: 'feishu',
    type: 'message',
    data: feishuData,
  })
  const eventId = bus.recent(1)[0].id
  return {
    ...mkDecision({ eventId, ...decisionOverrides }),
  }
}

// ────────────────────────────────────────────────────────────
// R15.1  EventBus.get(id) 反查能力
// ────────────────────────────────────────────────────────────
{
  const bus = new EventBus({ windowSize: 3 })

  check('R15.1.1: 空 buffer get(anyId) === undefined', bus.get('anything') === undefined)

  bus.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_a', text: 'hello' } })
  bus.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_b', text: 'world' } })

  const recent = bus.recent(2)
  const idA = recent[1].id
  const idB = recent[0].id

  check('R15.1.2: get(idA) → chatId=oc_a',
    bus.get(idA)?.data?.chatId === 'oc_a')
  check('R15.1.3: get(idB) → chatId=oc_b',
    bus.get(idB)?.data?.chatId === 'oc_b')
  check('R15.1.4: get(不存在的 id) === undefined',
    bus.get('definitely_nonexistent_xyz') === undefined)

  // 超出 sliding window（windowSize=3，已发 5 个 → 老 2 个被丢弃）
  bus.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_c', text: 'c' } })
  bus.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_d', text: 'd' } })
  bus.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_e', text: 'e' } })

  check('R15.1.5: 超出 sliding window 的事件 get 返回 undefined（被丢弃）',
    bus.get(idA) === undefined && bus.get(idB) === undefined)

  // 仍在 window 内的事件仍可查
  const idE = bus.recent(1)[0].id
  check('R15.1.6: 仍在 window 内的事件仍可查',
    bus.get(idE)?.data?.chatId === 'oc_e')
}

// ────────────────────────────────────────────────────────────
// R15.2  state-only Decision（eventId undefined）
// ────────────────────────────────────────────────────────────
{
  const { bus, feishu } = makeMockFeishuAndBus()
  const handler = createNotifyHandler({
    feishu, eventBus: bus, dryRun: false,
  })

  // eventId = undefined（state-only 触发）
  const decision = mkDecision({ eventId: undefined, decisionId: 'dec_state_only_001' })
  const result = await handler.execute(decision)

  check('R15.2.1: state-only → success=false', result.success === false)
  check('R15.2.2: state-only → error 含 "no source event for state-only trigger"',
    typeof result.error === 'string' &&
    result.error.includes('no source event for state-only trigger'))
  check('R15.2.3: state-only → sendToChat 未被调用',
    feishu.calls.length === 0)
}

// ────────────────────────────────────────────────────────────
// R15.3  source 校验
// ────────────────────────────────────────────────────────────
{
  // 3.1 feishu source 合法（继续走到 chatId 校验；后续 R15.4 覆盖）
  {
    const { bus, feishu } = makeMockFeishuAndBus()
    bus.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_x', text: 'hi' } })
    const eventId = bus.recent(1)[0].id

    const handler = createNotifyHandler({ feishu, eventBus: bus, dryRun: false })
    const result = await handler.execute(mkDecision({ eventId }))
    check('R15.3.1: feishu source → success=true（走到 sendToChat）',
      result.success === true && feishu.calls.length === 1)
  }

  // 3.2 非 feishu source → fail
  {
    const { bus, feishu } = makeMockFeishuAndBus()
    bus.publish({ source: 'pc', type: 'app_focus', data: { app: 'VSCode' } })
    const eventId = bus.recent(1)[0].id

    const handler = createNotifyHandler({ feishu, eventBus: bus, dryRun: false })
    const result = await handler.execute(mkDecision({ eventId, decisionId: 'dec_pc_001' }))
    check('R15.3.2: pc source → success=false',
      result.success === false)
    check('R15.3.3: pc source → error 含 "unsupported source"',
      typeof result.error === 'string' && result.error.includes('unsupported source'))
    check('R15.3.4: pc source → error 含具体 source 名',
      typeof result.error === 'string' && result.error.includes('pc'))
    check('R15.3.5: pc source → sendToChat 未被调用',
      feishu.calls.length === 0)
  }
}

// ────────────────────────────────────────────────────────────
// R15.4  Feishu event.data context 校验
// ────────────────────────────────────────────────────────────
{
  // 4.1 data.chatId 合法 → 继续（成功 + sendToChat）
  {
    const { bus, feishu } = makeMockFeishuAndBus()
    bus.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_valid', text: 'hello' } })
    const eventId = bus.recent(1)[0].id

    const handler = createNotifyHandler({ feishu, eventBus: bus, dryRun: false })
    const result = await handler.execute(mkDecision({ eventId }))
    check('R15.4.1: 合法 chatId → success=true', result.success === true)
    check('R15.4.2: 合法 chatId → sendToChat 被调用',
      feishu.calls.length === 1 && feishu.calls[0].chatId === 'oc_valid')
  }

  // 4.2 data.chatId 缺失（undefined）
  {
    const { bus, feishu } = makeMockFeishuAndBus()
    bus.publish({ source: 'feishu', type: 'message', data: { text: 'no chatId' } })
    const eventId = bus.recent(1)[0].id

    const handler = createNotifyHandler({ feishu, eventBus: bus, dryRun: false })
    const result = await handler.execute(mkDecision({ eventId, decisionId: 'dec_no_chat' }))
    check('R15.4.3: chatId 缺失 → success=false', result.success === false)
    check('R15.4.4: chatId 缺失 → error 含 "missing chat context"',
      typeof result.error === 'string' && result.error.includes('missing chat context'))
    check('R15.4.5: chatId 缺失 → sendToChat 未被调用', feishu.calls.length === 0)
  }

  // 4.3 data.chatId 非字符串（数字）
  {
    const { bus, feishu } = makeMockFeishuAndBus()
    bus.publish({ source: 'feishu', type: 'message', data: { chatId: 12345, text: 'wrong type' } })
    const eventId = bus.recent(1)[0].id

    const handler = createNotifyHandler({ feishu, eventBus: bus, dryRun: false })
    const result = await handler.execute(mkDecision({ eventId, decisionId: 'dec_wrong_type' }))
    check('R15.4.6: chatId 非字符串 → success=false', result.success === false)
    check('R15.4.7: chatId 非字符串 → error 含 "missing chat context"',
      typeof result.error === 'string' && result.error.includes('missing chat context'))
  }

  // 4.4 data.chatId 空字符串
  {
    const { bus, feishu } = makeMockFeishuAndBus()
    bus.publish({ source: 'feishu', type: 'message', data: { chatId: '', text: 'empty' } })
    const eventId = bus.recent(1)[0].id

    const handler = createNotifyHandler({ feishu, eventBus: bus, dryRun: false })
    const result = await handler.execute(mkDecision({ eventId, decisionId: 'dec_empty_chat' }))
    check('R15.4.8: chatId 空字符串 → success=false', result.success === false)
    check('R15.4.9: chatId 空字符串 → error 含 "missing chat context"',
      typeof result.error === 'string' && result.error.includes('missing chat context'))
  }
}

// ────────────────────────────────────────────────────────────
// R15.5  dryRun 复用
// ────────────────────────────────────────────────────────────
{
  // 5.1 dryRun=true → 不调用 sendToChat
  const { bus, feishu } = makeMockFeishuAndBus()
  bus.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_dryrun', text: 'dryrun test' } })
  const eventId = bus.recent(1)[0].id

  const handler = createNotifyHandler({ feishu, eventBus: bus, dryRun: true })
  const decision = mkDecision({
    eventId, priority: 'urgent', reason: 'dryrun test',
    decisionId: 'dec_dryrun_001',
  })
  const result = await handler.execute(decision)

  check('R15.5.1: dryRun=true → success=true', result.success === true)
  check('R15.5.2: dryRun=true → sendToChat **未**被调用',
    feishu.calls.length === 0)
  check('R15.5.3: dryRun=true → metadata.dryRun=true',
    result.metadata?.dryRun === true)
  check('R15.5.4: dryRun=true → metadata.chatId 保留',
    result.metadata?.chatId === 'oc_dryrun')
  check('R15.5.5: dryRun=true → metadata.textPreview 存在',
    typeof result.metadata?.textPreview === 'string')

  // 5.2 dryRun=false → 调用 sendToChat
  {
    const { bus: bus2, feishu: feishu2 } = makeMockFeishuAndBus()
    bus2.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_real', text: 'real send' } })
    const eid = bus2.recent(1)[0].id

    const handler2 = createNotifyHandler({ feishu: feishu2, eventBus: bus2, dryRun: false })
    const result2 = await handler2.execute(mkDecision({ eventId: eid }))
    check('R15.5.6: dryRun=false → success=true', result2.success === true)
    check('R15.5.7: dryRun=false → sendToChat **被**调用',
      feishu2.calls.length === 1)
    check('R15.5.8: dryRun=false → metadata 中无 dryRun 字段',
      result2.metadata?.dryRun === undefined)
  }
}

// ────────────────────────────────────────────────────────────
// R15.6  真实发送（mock FeishuClient）验证文本内容
// ────────────────────────────────────────────────────────────
{
  const { bus, feishu } = makeMockFeishuAndBus()
  bus.publish({
    source: 'feishu',
    type: 'message',
    data: { chatId: 'oc_text_test', text: '明天前提交报告' },
  })
  const eventId = bus.recent(1)[0].id

  const handler = createNotifyHandler({ feishu, eventBus: bus, dryRun: false })
  const decision = mkDecision({
    eventId,
    priority: 'urgent',
    reason: '重要消息来了',
    decisionId: 'dec_text_001',
  })
  const result = await handler.execute(decision)

  check('R15.6.1: 真实发送 → success=true', result.success === true)
  check('R15.6.2: 真实发送 → sendToChat 调用 1 次', feishu.calls.length === 1)
  check('R15.6.3: 真实发送 → chatId 正确',
    feishu.calls[0]?.chatId === 'oc_text_test')

  const text = feishu.calls[0]?.text ?? ''
  check('R15.6.4: 真实发送 → text 含 "[Orca] urgent"',
    text.includes('[Orca] urgent'))
  check('R15.6.5: 真实发送 → text 含 reason "重要消息来了"',
    text.includes('重要消息来了'))
  check('R15.6.6: 真实发送 → text 含 "源消息: 明天前提交报告"（前 200 字符）',
    text.includes('源消息: 明天前提交报告'))

  // 无 originalText 时不附加"源消息:"
  {
    const { bus: bus3, feishu: feishu3 } = makeMockFeishuAndBus()
    bus3.publish({ source: 'feishu', type: 'notification', data: { chatId: 'oc_img' } })
    const eid = bus3.recent(1)[0].id
    const handler3 = createNotifyHandler({ feishu: feishu3, eventBus: bus3, dryRun: false })
    await handler3.execute(mkDecision({ eventId: eid, reason: 'image only' }))

    const text3 = feishu3.calls[0]?.text ?? ''
    check('R15.6.7: 无 originalText 时不附加"源消息:"',
      !text3.includes('源消息:') && text3.includes('image only'))
  }

  // originalText > 200 字符时截断
  {
    const { bus: bus4, feishu: feishu4 } = makeMockFeishuAndBus()
    const longText = 'x'.repeat(500)
    bus4.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_long', text: longText } })
    const eid = bus4.recent(1)[0].id
    const handler4 = createNotifyHandler({ feishu: feishu4, eventBus: bus4, dryRun: false })
    await handler4.execute(mkDecision({ eventId: eid, reason: 'long text' }))

    const text4 = feishu4.calls[0]?.text ?? ''
    // "源消息: " + 200 个 x = 209 字符；不含 500 个连续 x
    const hasTruncated = text4.includes('源消息: ' + 'x'.repeat(200))
    const hasFullText = text4.includes('x'.repeat(201))
    check('R15.6.8: 长 text 截断到 200 字符', hasTruncated && !hasFullText)
  }
}

// ────────────────────────────────────────────────────────────
// R15.7  发送失败（FeishuClient 抛异常）
// ────────────────────────────────────────────────────────────
{
  const { bus, feishu } = makeMockFeishuAndBus()
  bus.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_fail', text: 'will fail' } })
  const eventId = bus.recent(1)[0].id

  // 预设下一次 sendToChat 抛错
  feishu.setNextThrow('mock feishu server error 500')

  const handler = createNotifyHandler({ feishu, eventBus: bus, dryRun: false })
  const decision = mkDecision({
    eventId, reason: 'send failure test', decisionId: 'dec_send_fail_001',
  })
  const result = await handler.execute(decision)

  check('R15.7.1: sendToChat 抛异常 → success=false', result.success === false)
  check('R15.7.2: sendToChat 抛异常 → error 含 "feishu sendToChat failed"',
    typeof result.error === 'string' && result.error.includes('feishu sendToChat failed'))
  check('R15.7.3: sendToChat 抛异常 → error 含原始消息',
    typeof result.error === 'string' && result.error.includes('mock feishu server error 500'))
  check('R15.7.4: sendToChat 抛异常 → decisionId 仍透传',
    result.decisionId === 'dec_send_fail_001')
  check('R15.7.5: sendToChat 抛异常 → 不抛给 caller（handler 返回 ActionResult）',
    typeof result.success === 'boolean')

  // EventBus 不应被影响（handler 异常被内部 catch）
  check('R15.7.6: EventBus 仍可继续 publish（handler 异常隔离）',
    (() => {
      try {
        bus.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_next', text: 'x' } })
        return bus.size() > 0
      } catch { return false }
    })())
}

// ────────────────────────────────────────────────────────────
// R15.8  EventBus 集成（真实 plugin + 真实 notify handler）
// ────────────────────────────────────────────────────────────
{
  const ctx = new Context()
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export() {} })

  const bus = new EventBus({ windowSize: 50 })
  const feishu = mkMockFeishu()
  const store = { append: async () => {} }  // stub store（避免 remember 真实写盘）

  ctx.provide('eventBus', bus)
  ctx.provide('infoStore', store)
  ctx.provide('feishu', feishu)

  const results15c = []
  ctx.on('orca/action-result', (r) => { results15c.push(r) })

  // 挂载 actionExecutor plugin（应自动注册真实 notify handler）
  const dispose = actionExecutor(ctx, { dryRun: false })

  // 验证真实 notify handler 已注册（覆盖 stub）
  const handlerList = ctx.actionExecutor.registry.list()
  const notifyHandler = handlerList.find((h) => h.action === 'notify')
  check('R15.8.1: plugin 注册了真实 notify handler（name=notify）',
    notifyHandler?.name === 'notify')

  // publish 一个 feishu 事件，让 eventId 可达
  bus.publish({
    source: 'feishu', type: 'message',
    data: { chatId: 'oc_integration', text: 'integration test' },
  })
  const eventId = bus.recent(1)[0].id

  // emit decision → execute → 真实 sendToChat → emit action-result
  ctx.emit('orca/decision', mkDecision({
    eventId, reason: 'integration test', decisionId: 'dec_int_001',
  }))

  // 等异步派发
  await new Promise((resolve) => {
    let waited = 0
    const poll = () => {
      if (results15c.length > 0 || waited > 500) { resolve(); return }
      waited += 5
      setTimeout(poll, 5)
    }
    poll()
  })

  check('R15.8.2: emit(orca/decision notify) → 1 个 orca/action-result',
    results15c.length === 1)
  check('R15.8.3: result.success=true（真实发送 mock feishu）',
    results15c[0]?.success === true)
  check('R15.8.4: feishu.sendToChat 被调用（mock）',
    feishu.calls.length === 1 && feishu.calls[0]?.chatId === 'oc_integration')

  dispose()
}

// ────────────────────────────────────────────────────────────
// R15.9  Decision 追踪字段完整性
// ────────────────────────────────────────────────────────────
{
  const { bus, feishu } = makeMockFeishuAndBus()
  bus.publish({ source: 'feishu', type: 'message', data: { chatId: 'oc_trace', text: 't' } })
  const eventId = bus.recent(1)[0].id

  const handler = createNotifyHandler({ feishu, eventBus: bus, dryRun: false })
  const beforeTime = Date.now()
  const decision = mkDecision({
    eventId,
    decisionId: 'dec_trace_001',
    priority: 'urgent',
    action: 'notify',
  })
  const result = await handler.execute(decision)
  const afterTime = Date.now()

  check('R15.9.1: result.decisionId 透传', result.decisionId === 'dec_trace_001')
  check('R15.9.2: result.action === decision.action',
    result.action === decision.action)
  check('R15.9.3: result.executedAt 在调用前后时间范围内',
    result.executedAt >= beforeTime && result.executedAt <= afterTime)
  check('R15.9.4: result.success === true', result.success === true)
  check('R15.9.5: 无 error 字段（success=true）',
    result.error === undefined)
}

// ────────── 结果 ──────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== smoke-notify 结果：${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join(' | '))
  throw new Error(`smoke-notify 失败 ${failed.length} 项`)
}
