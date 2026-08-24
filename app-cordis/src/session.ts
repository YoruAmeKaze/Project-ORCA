import type { ChatRole } from './services/llm.js'

export interface Turn {
  role: Exclude<ChatRole, 'system'>
  content: string
}

/**
 * 内存会话存储（Phase 1）：sessionId → 最近 N 轮对话。
 * 持久化（jsonl / sqlite）按迁移方案留到 Phase 2。
 */
export class SessionStore {
  private sessions = new Map<string, Turn[]>()

  constructor(private maxTurns: number) {}

  get(sessionId: string): Turn[] {
    return this.sessions.get(sessionId) ?? []
  }

  push(sessionId: string, turn: Turn): void {
    const list = this.sessions.get(sessionId) ?? []
    list.push(turn)
    if (list.length > this.maxTurns) list.splice(0, list.length - this.maxTurns)
    this.sessions.set(sessionId, list)
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
