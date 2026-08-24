import type { LlmConfig } from '../config.js'

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
}

/**
 * DeepSeek Chat Completions 客户端（非流式）。
 * 对应 Python 版 core/planner.py 的 LLM 调用；工具调用/流式留到 Phase 2。
 */
export class LlmClient {
  constructor(private config: LlmConfig) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    if (!this.config.apiKey) throw new Error('DEEPSEEK_API_KEY 未配置')
    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`llm http ${res.status}: ${body.slice(0, 300)}`)
    }
    const data = (await res.json()) as ChatResponse
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('llm empty response')
    return content
  }
}
