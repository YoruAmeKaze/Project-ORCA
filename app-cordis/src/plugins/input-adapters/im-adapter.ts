/**
 * IM Adapter Cordis Plugin（IM-1.0 Phase + IM-1.5C NapCatQQ）
 *
 * 职责：
 * - 持有 MockIMAdapter 或 NapCatQQ HTTP Adapter
 * - start() 后：通过 EventBus 发布 im.message.received / im.message.sent 事件
 * - 严格遵守 RuntimeAdapter 接口 { start(), stop() }
 *
 * IM-1.5C 约束：
 * - 不调 LLM
 * - 不做决策
 * - 不直接回复（transportText 由 ActionExecutor 通过完整链路调用）
 * - 不直接写 Memory
 * - 不调用 AttentionEngine / DecisionEngine
 * - NapCatQQ 模式不调用 send API（只接收消息）
 *
 * 事件流向：
 *   外部消息 → adapter.normalize() → MessageEnvelope
 *     → EventBus.publish({ source:'im.qq', type:'im.message.received', data:{envelope} })
 *     → IMObservationAdapter
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../../config.js'
import type { EventBus } from '../../services/eventBus.js'
import type { OrcaIMConfig } from '../../config.js'
import { createMockIMAdapter } from '../../services/mock-im-adapter.js'
import { createQQAdapter } from '../../services/qq-adapter.js'
import type { RuntimeAdapter } from '../../types/runtime-adapter.js'
import type { MessageEnvelope } from '../../types/im.js'

/**
 * 创建 IM Adapter RuntimeAdapter（内部）
 * 根据 config.mode 选择 mock 或 http（NapCatQQ）
 */
function createIMRuntimeAdapter(
  bus: EventBus,
  config: OrcaIMConfig,
  logger: Context['logger'],
): RuntimeAdapter {
  const mode = config.mode ?? 'mock'

  if (mode === 'http') {
    if (!config.qq) {
      logger.warn('[im-adapter] mode=http 但未配置 qq，请检查 ORCA_IM_QQ_PORT')
      return { start() {}, stop() {} }
    }
    return createQQAdapter(
      {
        onEnvelope(envelope: MessageEnvelope) {
          bus.publish({
            source: envelope.source as 'im.qq' | 'im.wechat',
            type: 'im.message.received',
            data: { envelope },
            priority: 1,
          })
        },
      },
      {
        httpHost: config.qq.httpHost,
        httpPort: config.qq.httpPort,
        accessToken: config.qq.accessToken,
        platform: config.platform,
      },
      logger,
    )
  }

  // mode=mock（默认）
  return createMockIMAdapter(bus, config, logger)
}

/**
 * IM Adapter Cordis Plugin
 *
 * @param ctx Cordis Context
 * @param config OrcaConfig
 * @returns RuntimeAdapter
 */
export function imAdapter(ctx: Context, config: OrcaConfig): RuntimeAdapter {
  const imConfig: OrcaIMConfig = {
    enabled: config.runtime.im?.enabled ?? false,
    platform: config.runtime.im?.platform ?? 'im.qq',
    mode: config.runtime.im?.mode ?? 'mock',
    mockIntervalMs: config.runtime.im?.mockIntervalMs ?? 5_000,
    qq: config.runtime.im?.qq,
  }

  const bus = ctx.eventBus
  if (!bus) {
    ctx.logger.warn('[im-adapter] eventBus 未注入，跳过（Orca Runtime 未启用？）')
    return { start() {}, stop() {} }
  }

  if (!imConfig.enabled) {
    ctx.logger.info('[im-adapter] 未启用（ORCA_IM_ENABLED=0 或未配置）')
    return { start() {}, stop() {} }
  }

  const mode = imConfig.mode ?? 'mock'
  if (mode === 'http') {
    ctx.logger.info(
      '[im-adapter] 已启动（mode=http，NapCatQQ QQ adapter，listen %s:%d）',
      imConfig.qq?.httpHost ?? '127.0.0.1',
      imConfig.qq?.httpPort ?? 3000,
    )
  } else {
    ctx.logger.info(
      '[im-adapter] 已启动（mode=mock，platform=%s，mockIntervalMs=%d）',
      imConfig.platform,
      imConfig.mockIntervalMs,
    )
  }

  const adapter = createIMRuntimeAdapter(bus, imConfig, ctx.logger)
  adapter.start()
  return adapter
}
