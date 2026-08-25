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

  /**
   * 向会话发送独立文本消息（receive_id_type=chat_id，p2p 与群聊均可）。
   * 注意：用「发送消息」接口（im/v1/messages）而不是「回复消息」接口（messages/{id}/reply）——
   * 回复接口在飞书 UI 显示为引用气泡；发送接口是普通聊天消息（2026-08-25 用户要求）。
   */
  async sendToChat(chatId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken()
    const res = await fetch(`${this.config.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
    })
    const data = (await res.json().catch(() => null)) as ApiResponse | null
    if (!res.ok || !data || data.code !== 0) {
      throw new Error(`feishu sendToChat failed: http ${res.status} code ${data?.code} ${data?.msg ?? ''}`)
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

  /**
   * 下载图片消息的二进制（im.message.receive_v1 image 消息 → 图片字节）。
   * 注意：消息里收到的图片必须走「消息资源下载」接口（im/v1/messages/{message_id}/resources/{file_key}?type=image），
   * 不能用 im/v1/images/{image_key}（那是上传场景的 key，对消息图片返回 234001 Invalid request param）。
   */
  async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    const token = await this.getTenantAccessToken()
    const url = `${this.config.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`
    // 10s 超时：防止网络挂起时 food-image 监听器永久 pending（坏 key 正常 ~1s 抛 400）
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      // 带上飞书返回的 code/msg，便于定位（权限/参数/key 时效等）
      const body = await res.text().catch(() => '')
      throw new Error(`feishu image download http ${res.status}: ${body.slice(0, 300)}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('feishu image empty')
    return buf
  }
}
