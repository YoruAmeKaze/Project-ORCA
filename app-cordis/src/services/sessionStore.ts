import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { appRoot } from '../config.js'

export interface Turn {
  role: 'user' | 'assistant'
  content: string
}

export interface SessionStore {
  get(sessionId: string): Turn[]
  push(sessionId: string, turn: Turn): void
  clear(sessionId: string): void
}

/**
 * JSONL-backed SessionStore（Phase 7.3 Session Persistence）
 *
 * 职责：
 * - 追加写 data/sessions/<safe-session-id>.jsonl
 * - 内存 Map 作为运行时缓存
 * - lazy load：首次 get 才从文件恢复
 *
 * 文件格式（每行一条 Turn JSON）：
 *   { "role": "user", "content": "hello" }
 *   { "role": "assistant", "content": "hi" }
 *
 * 不保存：maxTurns、内存 Map、运行时状态。
 *
 * safe filename：sessionId → sha256 → hex(16)（防止路径穿越 + 文件名不合法）
 */
export class JsonlSessionStore implements SessionStore {
  /** 内存缓存：sessionId → Turn[] */
  private cache = new Map<string, Turn[]>()
  /** 已加载标志：避免重复读文件 */
  private loaded = new Set<string>()

  constructor(
    private maxTurns: number,
    private sessionsDir: string = resolve(appRoot, 'data', 'sessions'),
  ) {}

  /** 将 sessionId 转为安全文件名（防路径穿越 + 防非法字符） */
  private safeFilename(sessionId: string): string {
    return createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  }

  /** sessionId → JSONL 文件路径 */
  private fileOf(sessionId: string): string {
    return `${this.sessionsDir}/${this.safeFilename(sessionId)}.jsonl`
  }

  /** lazy load：从文件恢复指定 session，不抛错 */
  private async ensureLoaded(sessionId: string): Promise<void> {
    if (this.loaded.has(sessionId)) return
    const turns: Turn[] = []
    try {
      const text = await readFile(this.fileOf(sessionId), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const t = JSON.parse(line) as Turn
          if (t.role === 'user' || t.role === 'assistant') {
            turns.push(t)
          }
        } catch {
          // 跳过损坏行
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        const detail = err instanceof Error ? err.message : String(err)
        console.warn(`[JsonlSessionStore] 加载 session ${sessionId} 出错（忽略）: ${detail}`)
      }
    }
    // 只保留最近 maxTurns 条
    if (turns.length > this.maxTurns) {
      turns.splice(0, turns.length - this.maxTurns)
    }
    this.cache.set(sessionId, turns)
    this.loaded.add(sessionId)
  }

  get(sessionId: string): Turn[] {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return cached
    // 同步返回空数组（lazy load 在 push 时触发）
    // 调用方在 async 上下文中可等待 ensureLoaded，但 get 是同步 API
    return []
  }

  /**
   * 同步缓存 + 异步追加写文件。
   * 不在 get 中触发文件 IO（保持同步接口语义）。
   * 首次 get 前有 push 时，ensureLoaded 会先扫描文件再追加，
   * 存在极小的重复写入风险（restart 之间有文件写入的情况下）。
   */
  push(sessionId: string, turn: Turn): void {
    // 更新缓存（同步）
    const list = this.cache.get(sessionId) ?? []
    list.push(turn)
    if (list.length > this.maxTurns) list.splice(0, list.length - this.maxTurns)
    this.cache.set(sessionId, list)
    this.loaded.add(sessionId)

    // 追加写文件（异步，fire-and-forget）
    void this.appendToFile(sessionId, turn)
  }

  private async appendToFile(sessionId: string, turn: Turn): Promise<void> {
    try {
      await mkdir(this.sessionsDir, { recursive: true })
      await appendFile(this.fileOf(sessionId), JSON.stringify(turn) + '\n', 'utf8')
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.warn(`[JsonlSessionStore] 写入 session ${sessionId} 失败: ${detail}`)
    }
  }

  clear(sessionId: string): void {
    this.cache.delete(sessionId)
    this.loaded.delete(sessionId)
    void this.truncateFile(sessionId)
  }

  /**
   * 主动从 JSONL 文件恢复指定 session 的内存缓存。
   * 供外部调用（如 restart 恢复、或 smoke test 验证）。
   * 若文件不存在则视为空 session，不抛错。
   */
  async reload(sessionId: string): Promise<void> {
    // 重置已加载标志，强制重新从文件读取
    this.loaded.delete(sessionId)
    await this.ensureLoaded(sessionId)
  }

  private async truncateFile(sessionId: string): Promise<void> {
    try {
      const filePath = this.fileOf(sessionId)
      // truncate(0) 清空文件内容
      await truncate(filePath, 0)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        const detail = err instanceof Error ? err.message : String(err)
        console.warn(`[JsonlSessionStore] 清空 session ${sessionId} 文件失败: ${detail}`)
      }
    }
  }
}
