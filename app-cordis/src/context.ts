import type { FeishuClient } from './services/feishu.js'
import type { LlmClient } from './services/llm.js'
import type { VisionClient } from './services/vision.js'
import type { EventBus } from './services/eventBus.js'
import type { WorldStateService } from './services/worldState.js'
import type { AttentionEngineService } from './types/attention.js'
import type { DecisionEngineService } from './types/decision.js'
import type { ActionExecutorService } from './types/action.js'
import type { SessionStore } from './session.js'
import type { FeishuMessageEvent, FeishuImageEvent } from './plugins/feishu-channel.js'
import type { InfoAgentRegistry } from './agents/registry.js'
import type { InfoExecutor } from './agents/executor.js'
import type { JsonlInfoRecordStore } from './agents/store.js'
import type { InfoRecord } from './agents/types.js'
import type { OrcaEvent } from './types/event.js'
import type { WorldState } from './types/worldState.js'
import type { AttentionItem } from './types/attention.js'
import type { Decision } from './types/decision.js'
import type { ActionResult } from './types/action.js'
import type { ContextAssembler } from './types/context.js'
import type { CognitiveSchedulerService, CognitiveRequest } from './types/cognition.js'
import type { CognitionCoreService } from './services/cognition-core.js'
import type { CognitionResult } from './types/cognition-core.js'

/**
 * CognitionActionIntent —— Phase D Cognition 产生的结构化 action 意图
 *
 * 设计原则：
 * - 独立于 legacy DecisionAction，不绑定旧架构枚举
 * - action: 字符串（与 DecisionAction 字符串值暂时兼容）
 * - 未来删除 DecisionEngine 时，只需修改 cognition-output-plugin 内的局部转换函数
 *
 * Phase D 最小字段：action + reason + attentionId
 */
export interface CognitionActionIntent {
  /** action 名称字符串（暂时与 DecisionAction 字符串值兼容） */
  action: string
  /** 触发该 action 的原因 */
  reason: string
  /** 关联的 AttentionItem.id */
  attentionId: string
}

/**
 * CognitionOutput —— CognitionCore 的输出边界事件载荷
 *
 * 设计原则：
 * - CognitionCore 只负责"认知得到了什么结果"，不负责"结果如何处理"
 * - outputType 区分输出性质，使下游 consumer 可以选择如何处理
 * - sessionId 关联到原始 CognitionSession（用于追溯）
 * - text/reply 类输出 → Feishu consumer → sendToChat()
 * - observation 类输出 → 未来可接入 Memory/Reflection
 * - error 类输出 → 未来可接入告警/logging
 * - action 类输出（Phase D）→ cognition-output-plugin 转换为 Decision → ActionExecutor
 *
 * Phase C + D：处理 text/reply / observation / error；Phase D 增加 action 类型
 */
export interface CognitionOutput {
  cognitionId: string
  requestId: string
  output: string
  /** 'text/reply' | 'observation' | 'error' | 'action' */
  outputType: 'text/reply' | 'observation' | 'error' | 'action'
  /** Phase D：action 类型输出时的结构化意图（仅 outputType='action' 时存在） */
  actionIntent?: CognitionActionIntent
  /** 关联的 AttentionItem IDs（用于追溯触发源）*/
  attentionIds: string[]
  /** Feishu chatId（从 AttentionItem.stateSnapshot 提取，用于路由 reply）*/
  chatId?: string
}

/**
 * 向 Cordis Context 声明本项目提供的服务与用到的混合方法。
 * 说明：fork 版 @deepseek-ai/cordis 内部用 `declare module './context.ts'` 做相对路径增强，
 * 在部分解析模式下不生效，因此这里在应用侧显式补齐 on/emit/plugin 的声明。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    feishu: FeishuClient
    llm: LlmClient
    vision: VisionClient
    sessions: SessionStore
    infoAgents: InfoAgentRegistry
    infoExecutor: InfoExecutor
    infoStore: JsonlInfoRecordStore
    eventBus: EventBus
    worldState: WorldStateService
    attention: AttentionEngineService
    decision: DecisionEngineService
    actionExecutor: ActionExecutorService
    contextAssembler: ContextAssembler
    cognitiveScheduler: CognitiveSchedulerService
    cognitionCore: CognitionCoreService
    on(name: string, listener: (...args: any[]) => any, options?: unknown): () => boolean
    emit(name: string, ...args: any[]): void
    plugin(plugin: unknown, config?: unknown): unknown
  }

  interface Events {
    'feishu/message'(msg: FeishuMessageEvent): void
    'feishu/image'(msg: FeishuImageEvent): void
    'info/record'(record: InfoRecord): void
    'orca/event'(event: OrcaEvent): void
    'orca/state_changed'(state: WorldState): void
    'orca/attention'(item: AttentionItem): void
    'orca/decision'(decision: Decision): void
    'orca/action-result'(result: ActionResult): void
    'orca/cognition-request'(request: CognitiveRequest): void
    'cognition/started'(sessionId: string, requestId: string): void
    'cognition/completed'(sessionId: string, result: CognitionResult): void
    'cognition/failed'(sessionId: string, error: string): void
    'orca/cognition-output'(output: CognitionOutput): void
  }
}
