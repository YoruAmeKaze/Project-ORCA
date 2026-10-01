/**
 * Stable, frontend-facing projection of the Orca Runtime.
 *
 * This contract intentionally describes what Orca is doing, not how its
 * internal reducers, rules, schedulers, or action handlers are implemented.
 * Any visual frontend may consume this contract without coupling to Runtime
 * implementation details.
 */

export type RuntimePresentationMode = 'idle' | 'attention' | 'cognition' | 'acting' | 'waiting'

export type RuntimePresentationEventType =
  | 'message.received'
  | 'message.completed'
  | 'attention.created'
  | 'cognition.started'
  | 'cognition.completed'
  | 'cognition.failed'
  | 'action.executed'
  | 'runtime.event'

export interface RuntimePresentationEvent {
  id: string
  type: RuntimePresentationEventType
  at: number
  /** A display-safe source identifier, such as dashboard, feishu, or filesystem. */
  source: string | null
  /** Short human-readable text intended for UI timelines and HUDs. */
  summary: string
  /** Lets a frontend reconcile a reply or visual transition with a command. */
  correlationId?: string
  /** Only supplied for the dashboard's own message/reply flow. */
  message?: { direction: 'incoming' | 'outgoing'; text: string }
}

export interface RuntimePresentationState {
  version: 1
  updatedAt: number
  mode: RuntimePresentationMode
  focus: {
    label: string
    source: string | null
    reason: string | null
  }
  cognition: {
    active: boolean
  }
  tasks: {
    active: number
    pendingAttention: number
  }
  agents: Array<{
    id: string
    status: 'online' | 'offline'
    capabilities: string[]
  }>
  memory: {
    total: number
    layers: Array<{ id: 'projects' | 'preferences' | 'knowledge' | 'experiences'; count: number; updatedAt: number | null }>
  }
  recentEvents: RuntimePresentationEvent[]
}
