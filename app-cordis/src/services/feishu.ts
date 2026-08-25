import type { FeishuConfig } from '../config.js'

interface TokenResponse {
  code?: number
  msg?: string
  tenant_access_token?: string
  expire?: number
}

interface ApiResponse {
  code?: number
  msg?: string
}

/**
 * 飞书开放平台客户端：tenant_access_token 缓存 + 文本消息收发。
 * 与 Python 版 feishu/client.py 对应（send_text / reply_text）。
 */
export class FeishuClient {
  private token: { value: string; expiresAt: number } | null = null

  constructor(private config: FeishuConfig) {}

  async getTenantAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.token && now < this.token.expiresAt - 60_000) return this.token.value
    const res = await fetch(`${this.config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
    })
    if (!res.ok) throw new Error(`feishu token http ${res.status}`)
    const data = (await res.json()) as TokenResponse
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`feishu token error: ${data.code} ${data.msg ?? ''}`)
    }
    this.token = {
      value: data.tenant_access_token,
      expiresAt: now + (data.expire ?? 7200) * 1000,
    }
    return this.token.value
  }

  /** 回复指定消息（im.message.receive_v1 的 message_id） */
  async replyText(messageId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken()
    const res = await fetch(`${this.config.baseUrl}/open-apis/im/v1/messages/${messageId}/reply`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) }),
    })
    const data = (await res.json().catch(() => null)) as ApiResponse | null
    if (!res.ok || !data || data.code !== 0) {
      throw new Error(`feishu reply failed: http ${res.status} code ${data?.code} ${data?.msg ?? ''}`)
    }
  }

  /** 主动给 open_id 发文本消息 */
  async sendText(openId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken()
    const res = await fetch(
      `${this.config.baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) }),
      },
    )
    const data = (await res.json().catch(() => null)) as ApiResponse | null
    if (!res.ok || !data || data.code !== 0) {
      throw new Error(`feishu send failed: http ${res.status} code ${data?.code} ${data?.msg ?? ''}`)
    }
  }

  /** 下载图片消息的二进制（im.message.receive_v1 image 的 image_key → 图片字节） */
  async downloadImage(imageKey: string): Promise<Buffer> {
    const token = await this.getTenantAccessToken()
    // 10s 超时：防止网络挂起时 food-image 监听器永久 pending（坏 key 正常 ~1s 抛 400）
    const res = await fetch(`${this.config.baseUrl}/open-apis/im/v1/images/${encodeURIComponent(imageKey)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`feishu image download http ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('feishu image empty')
    return buf
  }
}
