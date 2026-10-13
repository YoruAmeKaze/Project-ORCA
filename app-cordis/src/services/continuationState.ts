import { createHash, randomUUID } from 'node:crypto'

export type ContinuationStatus = 'active' | 'waiting-confirmation' | 'completed' | 'failed' | 'expired'

export interface ContinuationSlot {
  value: unknown
  sourceAction: string
  sourceEventId?: string
  confidence?: number
}

export interface CompletedAction {
  action: string
  argsFingerprint: string
  success: boolean
  resultRef?: string
  completedAt: number
}

export interface ContinuationState {
  id: string
  channelSessionId: string
  goal: string
  status: ContinuationStatus
  workflow?: { skillId?: string; name: string; currentStep?: string; expectedNextActions?: string[] }
  slots: Record<string, ContinuationSlot>
  completedActions: CompletedAction[]
  lastAction?: { action: string; args: Record<string, unknown>; result: 'success' | 'failure'; resultSummary?: string }
  rounds: number
  startedAt: number
  updatedAt: number
  expiresAt: number
}

export interface ContinuationStateService {
  get(channelSessionId: string): ContinuationState | undefined
  getOrCreate(channelSessionId: string, goal: string): ContinuationState
  recordAction(input: { channelSessionId: string; action: string; args: Record<string, unknown>; success: boolean; resultRef?: string; resultSummary?: string }): { state: ContinuationState; duplicate: boolean; retry: boolean }
  setSlot(channelSessionId: string, name: string, slot: ContinuationSlot): void
  clear(channelSessionId: string): void
  cleanup(now?: number): void
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function actionFingerprint(taskId: string, action: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(`${taskId}|${action}|${stableJson(args)}`).digest('hex')
}

export function createContinuationStateService(opts: { ttlMs?: number; maxTasks?: number } = {}): ContinuationStateService {
  const states = new Map<string, ContinuationState>()
  const ttlMs = opts.ttlMs ?? 30 * 60 * 1000
  const maxTasks = opts.maxTasks ?? 128
  const touch = (state: ContinuationState) => { state.updatedAt = Date.now(); state.expiresAt = state.updatedAt + ttlMs }
  return {
    get(sessionId) {
      const state = states.get(sessionId)
      if (!state || state.expiresAt <= Date.now()) { if (state) states.delete(sessionId); return undefined }
      return state
    },
    getOrCreate(sessionId, goal) {
      const existing = this.get(sessionId)
      if (existing) { if (goal) existing.goal = goal; touch(existing); return existing }
      while (states.size >= maxTasks) states.delete(states.keys().next().value as string)
      const now = Date.now()
      const state: ContinuationState = { id: randomUUID(), channelSessionId: sessionId, goal, status: 'active', slots: {}, completedActions: [], rounds: 0, startedAt: now, updatedAt: now, expiresAt: now + ttlMs }
      states.set(sessionId, state)
      return state
    },
    recordAction({ channelSessionId, action, args, success, resultRef, resultSummary }) {
      const state = this.getOrCreate(channelSessionId, '')
      const fp = actionFingerprint(state.id, action, args)
      const attempts = state.completedActions.filter((entry) => entry.argsFingerprint === fp)
      const previous = attempts[attempts.length - 1]
      if (previous?.success) return { state, duplicate: true, retry: false }
      const retry = Boolean(previous && !previous.success && attempts.length === 1)
      if (previous && !retry) return { state, duplicate: true, retry: false }
      state.completedActions.push({ action, argsFingerprint: fp, success, resultRef, completedAt: Date.now() })
      state.lastAction = { action, args, result: success ? 'success' : 'failure', resultSummary }
      state.rounds++
      touch(state)
      return { state, duplicate: false, retry }
    },
    setSlot(sessionId, name, slot) { const state = this.getOrCreate(sessionId, ''); state.slots[name] = slot; touch(state) },
    clear(sessionId) { states.delete(sessionId) },
    cleanup(now = Date.now()) { for (const [key, state] of states) if (state.expiresAt <= now) states.delete(key) },
  }
}
