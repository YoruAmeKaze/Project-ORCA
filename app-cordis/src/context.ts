import type { FeishuClient } from './services/feishu.js'
import type { LlmClient } from './services/llm.js'
import type { VisionClient } from './services/vision.js'
import type { SessionStore } from './session.js'
import type { FeishuMessageEvent, FeishuImageEvent } from './plugins/feishu-channel.js'
import type { InfoAgentRegistry } from './agents/registry.js'
import type { InfoExecutor } from './agents/executor.js'
import type { JsonlInfoRecordStore } from './agents/store.js'
import type { InfoRecord } from './agents/types.js'

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
    on(name: string, listener: (...args: any[]) => any, options?: unknown): () => boolean
    emit(name: string, ...args: any[]): void
    plugin(plugin: unknown, config?: unknown): unknown
  }

  interface Events {
    'feishu/message'(msg: FeishuMessageEvent): void
    'feishu/image'(msg: FeishuImageEvent): void
    'info/record'(record: InfoRecord): void
  }
}
