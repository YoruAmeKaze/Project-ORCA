import type { FeishuClient } from './services/feishu.js'
import type { LlmClient } from './services/llm.js'
import type { SessionStore } from './session.js'
import type { FeishuMessageEvent } from './plugins/feishu-channel.js'

/**
 * 向 Cordis Context 声明本项目提供的服务与用到的混合方法。
 * 说明：fork 版 @deepseek-ai/cordis 内部用 `declare module './context.ts'` 做相对路径增强，
 * 在部分解析模式下不生效，因此这里在应用侧显式补齐 on/emit/plugin 的声明。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    feishu: FeishuClient
    llm: LlmClient
    sessions: SessionStore
    on(name: string, listener: (...args: any[]) => any, options?: unknown): () => boolean
    emit(name: string, ...args: any[]): void
    plugin(plugin: unknown, config?: unknown): unknown
  }

  interface Events {
    'feishu/message'(msg: FeishuMessageEvent): void
  }
}
