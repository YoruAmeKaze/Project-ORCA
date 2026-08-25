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

/**
 * Qwen 视觉客户端（阿里百炼 compatible-mode，OpenAI 风格 chat completions）。
 * 对应 Python 版 analyze_image 的 QWEN 视觉能力，供推理型 InfoAgent（food-agent）内部调用。
 */
export class VisionClient {
  constructor(private config: VisionConfig) {}

  private endpoint(): string {
    const base = this.config.baseUrl.replace(/\/$/, '')
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  }

  async describe(image: VisionImage, prompt: string, opts?: { maxTokens?: number; signal?: AbortSignal }): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    // 本地后端（Ollama，ORCA_VISION_BACKEND=ollama）免 apiKey；云端必填
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`
    const imageBlock = image.dataUrl
      ? { type: 'image_url', image_url: { url: image.dataUrl } }
      : { type: 'image_url', image_url: { url: image.url ?? '' } }
    // reasoning 模型（如本地 qwen3-vl）冷启动/偶发只输出 thinking、content 为空 → 空响应重试
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(this.endpoint(), {
        method: 'POST',
        headers,
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
          // reasoning 模型（qwen3-vl 等）thinking 会吃大量配额，默认给足；调用方可按需覆盖
          max_tokens: opts?.maxTokens ?? 3000,
        }),
        signal: opts?.signal, // 执行器超时/取消时真正中止底层请求
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`vision http ${res.status}: ${body.slice(0, 300)}`)
      }
      const data = (await res.json()) as VisionResponse
      const content = data.choices?.[0]?.message?.content
      if (content) return content
      // 空 content：重试（最多 3 次），最后一次仍空则抛错
    }
    throw new Error('vision empty response')
  }
}
