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

  async describe(image: VisionImage, prompt: string, opts?: { maxTokens?: number }): Promise<string> {
    if (!this.config.apiKey) throw new Error('QWEN_API_KEY 未配置')
    const imageBlock = image.dataUrl
      ? { type: 'image_url', image_url: { url: image.dataUrl } }
      : { type: 'image_url', image_url: { url: image.url ?? '' } }
    const res = await fetch(this.endpoint(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
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
        max_tokens: opts?.maxTokens ?? 500,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`vision http ${res.status}: ${body.slice(0, 300)}`)
    }
    const data = (await res.json()) as VisionResponse
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('vision empty response')
    return content
  }
}
