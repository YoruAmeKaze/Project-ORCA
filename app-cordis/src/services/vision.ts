export interface VisionConfig {
  apiKey: string
  /** 可能带 /chat/completions 完整端点，归一化处理 */
  baseUrl: string
  model: string
}

export interface VisionImage {
  /** 本地图片转 data URL（data:image/...;base64,...） */
  dataUrl?: string
  /** 远程图片公网 URL */
  url?: string
}

interface VisionResponse {
  choices?: { message?: { content?: string } }[]
}

interface OllamaChatResponse {
  message?: { content?: string }
}

/**
 * Qwen 视觉客户端，双后端：
 * - Ollama 本地后端（无 apiKey，ORCA_VISION_BACKEND=ollama）：走原生 /api/chat（图片走 images 数组、
 *   options.num_ctx 放大上下文——手机大图默认 4096 装不下会 400；OpenAI 兼容端点不认 num_ctx）
 * - 云端（阿里百炼 compatible-mode，有 apiKey）：OpenAI 风格 /chat/completions
 */
export class VisionClient {
  constructor(private config: VisionConfig) {}

  private endpoint(): string {
    const base = this.config.baseUrl.replace(/\/$/, '')
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  }

  private ollamaRoot(): string {
    return this.config.baseUrl
      .replace(/\/$/, '')
      .replace(/\/v1\/chat\/completions$/, '')
      .replace(/\/chat\/completions$/, '')
  }

  async describe(image: VisionImage, prompt: string, opts?: { maxTokens?: number; signal?: AbortSignal }): Promise<string> {
    const maxTokens = opts?.maxTokens ?? 3000
    if (!this.config.apiKey) {
      return this.describeOllama(image, prompt, { maxTokens, signal: opts?.signal })
    }
    return this.describeCloud(image, prompt, { maxTokens, signal: opts?.signal })
  }

  /** Ollama 原生 /api/chat：options.num_ctx 真正生效（OpenAI 兼容端点会忽略） */
  private async describeOllama(image: VisionImage, prompt: string, opts: { maxTokens: number; signal?: AbortSignal }): Promise<string> {
    // 原生接口 images 要裸 base64（不带 data:...;base64, 前缀）
    let imageBase64 = ''
    if (image.dataUrl) {
      imageBase64 = image.dataUrl.includes(',') ? image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) : image.dataUrl
    } else if (image.url) {
      const res = await fetch(image.url, { signal: opts.signal })
      if (!res.ok) throw new Error(`vision image url http ${res.status}`)
      imageBase64 = Buffer.from(await res.arrayBuffer()).toString('base64')
    }
    if (!imageBase64) throw new Error('vision: 无图片数据')

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(`${this.ollamaRoot()}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
          stream: false,
          options: {
            temperature: 0.2,
            num_predict: opts.maxTokens,
            num_ctx: 16_384, // 手机大图图 token 多，默认 4096 装不下（曾实测 4125 tokens 400）
          },
        }),
        signal: opts.signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`vision http ${res.status}: ${body.slice(0, 300)}`)
      }
      const data = (await res.json()) as OllamaChatResponse
      const content = data.message?.content
      if (content) return content
      // 空 content（reasoning 模型偶发只出 thinking）：重试
    }
    throw new Error('vision empty response')
  }

  /** 云端（阿里百炼）OpenAI 风格 chat completions */
  private async describeCloud(image: VisionImage, prompt: string, opts: { maxTokens: number; signal?: AbortSignal }): Promise<string> {
    const imageBlock = image.dataUrl
      ? { type: 'image_url', image_url: { url: image.dataUrl } }
      : { type: 'image_url', image_url: { url: image.url ?? '' } }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(this.endpoint(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                imageBlock,
              ],
            },
          ],
          temperature: 0.2,
          max_tokens: opts.maxTokens,
        }),
        signal: opts.signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`vision http ${res.status}: ${body.slice(0, 300)}`)
      }
      const data = (await res.json()) as VisionResponse
      const content = data.choices?.[0]?.message?.content
      if (content) return content
    }
    throw new Error('vision empty response')
  }
}
