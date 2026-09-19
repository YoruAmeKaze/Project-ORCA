import type { LlmConfig } from '../config.js'

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
}

interface OllamaTagsResponse {
  models?: { name: string }[]
}

/**
 * LLM Chat Completions 客户端（非流式）。
 *
 * 协议：OpenAI Chat Completions 兼容（DeepSeek / Ollama 均暴露）。
 * baseUrl 语义：根地址（如 https://api.deepseek.com 或 http://localhost:11434/v1），
 *   拼接 `${baseUrl}/chat/completions` 即为端点；不依赖 localhost 字符串嗅探。
 *
 * 后端分支（由 config.backend 显式声明）：
 * - 'dashscope' (默认, DeepSeek 云端)：必须配置 apiKey；Authorization: Bearer ${apiKey}
 * - 'ollama' (本地 Ollama)：apiKey 留空；不发送 Authorization header
 *
 * Ollama fallback（v1.8.0 hotfix）：
 * - 首次 chat() 时探测 `${OLLAMA_HOST}/api/tags`（2s 超时）
 * - 失败 / 超时 / 模型未 pull → 切到 config.fallback（dashscope 配置）
 * - 切换只发生一次；之后复用结果
 * - fallback 未配置（DEEPSEEK_API_KEY 缺失）→ 抛清晰错
 */
export class LlmClient {
  private currentConfig: LlmConfig
  private ollamaProbed = false
  private ollamaAvailable = false

  constructor(private readonly originalConfig: LlmConfig) {
    this.currentConfig = originalConfig
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    // Ollama 首次探测 + 可选 fallback
    if (this.currentConfig.backend === 'ollama' && !this.ollamaProbed) {
      this.ollamaProbed = true
      this.ollamaAvailable = await this.probeOllama()
      if (!this.ollamaAvailable) {
        const fallback = this.originalConfig.fallback
        if (fallback && fallback.apiKey) {
          console.warn(
            `[llm] Ollama 不可用（${this.originalConfig.baseUrl}），fallback 到 dashscope（${fallback.baseUrl}, model=${fallback.model}）`,
          )
          this.currentConfig = fallback
        } else {
          // fallback 不可用：第一次 chat() 直接抛错（agent catch 兜底）
          throw new Error(
            `Ollama 不可用（${this.originalConfig.baseUrl}）且未配置 DEEPSEEK_API_KEY fallback；请检查 ollama 是否启动 / 模型是否 pull / DEEPSEEK_API_KEY 是否设置`,
          )
        }
      }
    }

    if (this.currentConfig.backend === 'dashscope' && !this.currentConfig.apiKey) {
      throw new Error('DEEPSEEK_API_KEY 未配置（dashscope/backend 模式必需）')
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (this.currentConfig.backend !== 'ollama' && this.currentConfig.apiKey) {
      headers['authorization'] = `Bearer ${this.currentConfig.apiKey}`
    }
    const res = await fetch(`${this.currentConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.currentConfig.model,
        messages,
        temperature: this.currentConfig.temperature,
        max_tokens: this.currentConfig.maxTokens,
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

  /**
   * 探测 Ollama 可用性 + 模型已 pull。
   * - GET ${OLLAMA 原生根地址}/api/tags（注意不是 /v1）
   * - 2 秒超时；网络错误 / 状态非 200 / 模型不在 → 返回 false
   */
  private async probeOllama(): Promise<boolean> {
    // baseUrl 形如 http://localhost:11434/v1，原生 API 在 host 根地址
    const rootUrl = this.originalConfig.baseUrl.replace(/\/v1$/, '')
    const model = this.originalConfig.model
    const probeUrl = `${rootUrl}/api/tags`
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 2000)
      const res = await fetch(probeUrl, { signal: ac.signal })
      clearTimeout(timer)
      if (!res.ok) return false
      const data = (await res.json()) as OllamaTagsResponse
      const names = (data.models ?? []).map((m) => m.name)
      const matched = names.some((n) => n === model || n.startsWith(model + ':'))
      if (!matched) {
        console.warn(
          `[llm] Ollama 模型未找到：requested=${model} available=${names.join(',') || '(none)'}`,
        )
      }
      return matched
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.warn(`[llm] Ollama 探测失败（${probeUrl}）：${detail}`)
      return false
    }
  }
}
