/**
 * Orca EventBus —— 内存事件总线（Phase 0+1 最小版）
 *
 * 职责：
 * - 接收 publish 的 OrcaEvent
 * - 维护滑动窗口（默认 200 条，超出丢弃最老的）
 * - 派发给匹配的订阅者（按 source/type/minPriority 过滤）
 *
 * 不做的事（Phase 0+1 范围外）：
 * - 不持久化（重启即失，符合"实时流"语义）
 * - 不直接触发 Agent（订阅者决定如何反应）
 * - 不替代 ctx.emit/on（与 Cordis 现有事件机制共存）
 */

import { randomUUID } from 'node:crypto'
import type {
  EventFilter,
  EventHandler,
  OrcaEvent,
  OrcaEventPriority,
  PublishEventInput,
} from '../types/event.js'

export interface EventBusOptions {
  /** 滑动窗口大小，默认 200 */
  windowSize?: number
}

export interface EventBusLogger {
  info: (msg: string, ...args: unknown[]) => void
  warn: (msg: string, ...args: unknown[]) => void
}

interface Subscription {
  filter: EventFilter
  handler: EventHandler
}

const DEFAULT_WINDOW_SIZE = 200
const DEFAULT_PRIORITY: OrcaEventPriority = 1

export class EventBus {
  private readonly buffer: OrcaEvent[] = []
  private readonly subscriptions = new Set<Subscription>()
  private readonly windowSize: number
  private readonly logger: EventBusLogger | undefined
  private disposed = false

  constructor(opts: EventBusOptions = {}, logger?: EventBusLogger) {
    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE
    this.logger = logger
    this.logger?.info(
      '[event-bus] 已创建 windowSize=%d%s',
      this.windowSize,
      this.windowSize <= 0 ? '（禁用窗口）' : '',
    )
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * 发布事件。EventBus 内部补默认 id / timestamp / priority。
   * publish 同步返回；handler 异步派发（通过 setImmediate），handler 抛错不阻塞 caller。
   */
  publish(input: PublishEventInput): void {
    if (this.disposed) {
      this.logger?.warn('[event-bus] 已 dispose，拒绝 publish: %s:%s', input.source, input.type)
      return
    }

    const event: OrcaEvent = {
      id: input.id ?? randomUUID(),
      source: input.source,
      type: input.type,
      timestamp: input.timestamp ?? Date.now(),
      data: input.data ?? {},
      priority: input.priority ?? DEFAULT_PRIORITY,
      sessionId: input.sessionId,
      userId: input.userId,
      meta: input.meta,
    }

    // 推入滑动窗口
    if (this.windowSize > 0) {
      this.buffer.push(event)
      while (this.buffer.length > this.windowSize) {
        const dropped = this.buffer.shift()
        if (dropped) {
          this.logger?.warn(
            '[event-bus] 滑动窗口满，丢弃最老事件 %s (%s:%s)',
            dropped.id,
            dropped.source,
            dropped.type,
          )
        }
      }
    }

    // 派发给订阅者（异步，handler 异常不阻塞 publish）
    setImmediate(() => this.dispatch(event))
  }

  /**
   * 订阅事件。返回 unsubscribe 函数。
   * handler 抛错被 try/catch 捕获并 warn 日志（防止 unhandledRejection 崩进程）。
   */
  subscribe(filter: EventFilter, handler: EventHandler): () => boolean {
    if (this.disposed) {
      this.logger?.warn('[event-bus] 已 dispose，subscribe 无效')
      return () => false
    }
    const sub: Subscription = { filter, handler }
    this.subscriptions.add(sub)
    return () => this.subscriptions.delete(sub)
  }

  /** 最近 N 个事件，按时间倒序（最新在前） */
  recent(n: number, filter?: EventFilter): OrcaEvent[] {
    const slice = this.buffer.slice(-n).reverse()
    return filter ? slice.filter((e) => this.matchesFilter(e, filter)) : slice
  }

  /** 时间范围内事件 [from, to]（闭区间），按时间正序 */
  range(from: number, to: number, filter?: EventFilter): OrcaEvent[] {
    const out: OrcaEvent[] = []
    for (const e of this.buffer) {
      if (e.timestamp < from || e.timestamp > to) continue
      if (filter && !this.matchesFilter(e, filter)) continue
      out.push(e)
    }
    return out
  }

  /** 当前窗口中的事件数 */
  size(): number {
    return this.buffer.length
  }

  /** 当前订阅者数 */
  subscriberCount(): number {
    return this.subscriptions.size
  }

  /** 释放资源（停止接收 publish，已有的 handler 仍会触发一次） */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.logger?.info(
      '[event-bus] dispose（bufferSize=%d subscribers=%d）',
      this.buffer.length,
      this.subscriptions.size,
    )
    this.subscriptions.clear()
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private dispatch(event: OrcaEvent): void {
    for (const sub of this.subscriptions) {
      if (!this.matchesFilter(event, sub.filter)) continue
      // handler 抛错吞掉，记 warn（防止 unhandledRejection 崩进程——cordis quirk）
      Promise.resolve()
        .then(() => sub.handler(event))
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err)
          this.logger?.warn(
            '[event-bus] handler 异常 (source=%s type=%s): %s',
            event.source,
            event.type,
            detail,
          )
        })
    }
  }

  private matchesFilter(event: OrcaEvent, filter: EventFilter): boolean {
    if (filter.source !== undefined && event.source !== filter.source) return false
    if (filter.type !== undefined && event.type !== filter.type) return false
    if (filter.minPriority !== undefined && event.priority < filter.minPriority) return false
    return true
  }
}