/**
 * EpisodeEngine —— 短期记忆生成引擎（Phase 5.1 MVP）
 *
 * 设计依据：D-AGENT-17 v1.1（guide/orca-memory-design.md v1.1 §3.1 / §4.1）
 *
 * 职责：
 * - 监听 EventBus 事件，生成 Episode
 * - 监听 WorldState 变化，生成 state.transition Episode
 * - 将 Episode 写入 MemoryStore（appendEpisode）
 *
 * 两类 Episode（确定性规则，无 LLM）：
 * 1. message.burst：同 sender 在 90s 内发送 ≥3 条消息
 * 2. state.transition：WorldState user.status 状态转换
 *
 * 约束：
 * - 纯规则，无 LLM 调用
 * - 不修改 EventBus / WorldState
 * - 不生成 MemoryCandidate（Phase 5.3 才做）
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Episode } from '../types/memory.js'
import type { OrcaEvent } from '../types/event.js'
import type { WorldState } from '../types/worldState.js'

// ── 配置常量 ────────────────────────────────────────────────────────────

const BURST_WINDOW_MS = 90_000   // 90 秒窗口
const BURST_MIN_COUNT = 3        // 最少消息数
const EPISODE_TTL_DAYS = 7       // 默认 7 天

// ── 状态追踪 ────────────────────────────────────────────────────────────

interface BurstSession {
  senderId: string
  count: number
  eventIds: string[]
  firstTs: number
  lastTs: number
}

// ── EpisodeEngine 类 ────────────────────────────────────────────────────

export class EpisodeEngine {
  // Burst 追踪表：senderId → session
  private burstSessions = new Map<string, BurstSession>()
  // 已生成的 burst episode sender（防止同一 burst 重复生成）
  private burstEpisodeDone = new Set<string>()

  constructor(
    private ctx: Context,
    private episodeTtlDays = EPISODE_TTL_DAYS,
    private burstWindowMs = BURST_WINDOW_MS,
    private burstMinCount = BURST_MIN_COUNT,
  ) {}

  // ── 事件处理 ─────────────────────────────────────────────────────────

  /**
   * 处理 EventBus 事件，检测 message.burst。
   * 供 plugin 调用（ctx.on 回调透传）。
   */
  async handleEvent(event: OrcaEvent): Promise<void> {
    // 仅处理 feishu 消息事件
    if (event.source !== 'feishu' || event.type !== 'message') return

    const data = event.data as { openId?: string; senderId?: string; text?: string }
    const senderId = data.openId ?? data.senderId ?? 'unknown'
    const now = Date.now()

    // 查找现有 session
    let session = this.burstSessions.get(senderId)

    if (!session) {
      // 新 sender，开始 session
      session = {
        senderId,
        count: 1,
        eventIds: [event.id],
        firstTs: now,
        lastTs: now,
      }
      this.burstSessions.set(senderId, session)
      return
    }

    // 检查是否在窗口内
    const gap = now - session.lastTs
    if (gap > this.burstWindowMs) {
      // 超出窗口，重置 session
      this.burstSessions.set(senderId, {
        senderId,
        count: 1,
        eventIds: [event.id],
        firstTs: now,
        lastTs: now,
      })
      return
    }

    // 在窗口内，累计
    session.count++
    session.lastTs = now
    session.eventIds.push(event.id)

    // 达到 burst 阈值？
    if (session.count === this.burstMinCount) {
      await this.emitBurstEpisode(session)
      // session 标记完成，防止重复生成
      this.burstEpisodeDone.add(senderId)
      // 重置 session 重新开始计数（下一个 burst）
      this.burstSessions.set(senderId, {
        senderId,
        count: 0,
        eventIds: [],
        firstTs: now,
        lastTs: now,
      })
    } else {
      this.burstSessions.set(senderId, session)
    }
  }

  /**
   * 处理 WorldState 变化，检测 state.transition。
   * 供 plugin 调用（ctx.on('orca/state_changed') 回调透传）。
   */
  async handleStateChange(newState: WorldState, prevState: WorldState | null): Promise<void> {
    if (!prevState) return

    const prevStatus = prevState.user.status
    const newStatus = newState.user.status

    if (prevStatus === newStatus) return // 无变化

    // 检测有意义的状态转换
    const summary = this.transitionSummary(prevStatus, newStatus)
    if (!summary) return

    await this.appendEpisode({
      id: randomUUID(),
      category: 'state',
      kind: 'state.transition',
      summary,
      ts: Date.now(),
      entities: ['user'],
      sourceEventIds: [], // state_changed 事件无 eventId
      importance: this.transitionImportance(prevStatus, newStatus),
      ttlDays: this.episodeTtlDays,
      state: 'active',
    })
  }

  // ── Episode 写入 ─────────────────────────────────────────────────────

  private async appendEpisode(episode: Episode): Promise<void> {
    const memory = this.ctx.get('memory')
    if (!memory) {
      this.ctx.logger?.warn('[episode-engine] memory service not available, skipping episode')
      return
    }
    try {
      await memory.appendEpisode(episode)
      this.ctx.logger?.info(
        '[episode-engine] episode created: kind=%s summary=%s',
        episode.kind,
        episode.summary,
      )
    } catch (err) {
      this.ctx.logger?.warn('[episode-engine] appendEpisode failed: %s', String(err))
    }
  }

  // ── Burst Episode 生成 ────────────────────────────────────────────────

  private async emitBurstEpisode(session: BurstSession): Promise<void> {
    if (this.burstEpisodeDone.has(session.senderId)) return // 防重复

    const episode: Episode = {
      id: randomUUID(),
      category: 'message',
      kind: 'message.burst',
      summary: `用户在 90 秒内连续发送了 ${session.count} 条消息`,
      ts: session.firstTs,
      entities: [session.senderId],
      sourceEventIds: session.eventIds,
      importance: session.count >= 5 ? 'high' : 'normal',
      ttlDays: this.episodeTtlDays,
      state: 'active',
    }

    await this.appendEpisode(episode)
    this.burstEpisodeDone.add(session.senderId)
  }

  // ── 状态转换摘要 ────────────────────────────────────────────────────

  /**
   * 生成状态转换的人类可读摘要。
   * 返回 null 表示不是有意义的状态转换。
   */
  private transitionSummary(
    prev: string,
    next: string,
  ): string | null {
    const map: Record<string, Record<string, string | null>> = {
      active: {
        away: '用户离开（变为 away）',
        busy: '用户变为忙碌状态',
        sleeping: '用户进入睡眠状态',
      },
      away: {
        active: '用户回到活跃状态',
        busy: '用户变为忙碌状态',
        sleeping: '用户进入睡眠状态',
      },
      busy: {
        active: '用户结束忙碌，回到活跃状态',
        away: '用户离开（变为 away）',
        sleeping: '用户进入睡眠状态',
      },
      sleeping: {
        active: '用户睡醒，回到活跃状态',
        away: '用户醒来但仍离开',
        busy: '用户睡醒并变得忙碌',
      },
    }

    return map[prev]?.[next] ?? null
  }

  /**
   * 状态转换的重要性。
   */
  private transitionImportance(
    prev: string,
    next: string,
  ): 'low' | 'normal' | 'high' {
    // 睡眠/忙碌恢复 → 高重要性
    if (prev === 'sleeping' && next === 'active') return 'high'
    if (prev === 'sleeping' && next === 'busy') return 'high'
    if (prev === 'busy' && next === 'active') return 'normal'
    // 进入睡眠 → 低重要性
    if (next === 'sleeping') return 'low'
    return 'normal'
  }

  // ── 清理（供 plugin dispose 调用）─────────────────────────────────────

  /**
   * 清理所有 in-memory burst session。
   * plugin dispose 时调用。
   */
  dispose(): void {
    this.burstSessions.clear()
    this.burstEpisodeDone.clear()
  }
}

// ── 工厂函数 ────────────────────────────────────────────────────────────

/**
 * 创建 EpisodeEngine 实例。
 * 调用方负责将 handleEvent / handleStateChange 注册到 ctx.on。
 */
export function createEpisodeEngine(
  ctx: Context,
  episodeTtlDays?: number,
): EpisodeEngine {
  return new EpisodeEngine(ctx, episodeTtlDays)
}
