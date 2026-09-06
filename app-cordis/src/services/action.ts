/**
 * Orca Action Executor —— 执行层实现（Phase 4.B + Phase 4.D）
 *
 * 职责：
 * - ActionHandlerRegistry 标准实现（register/unregister/get/list/size/clear）
 * - DeferredActionStore 内存实现（Phase 4.B；Phase 4.D 增加 consume(pendingId) 原子删除）
 * - ActionExecutor 服务：execute(decision) → Promise<ActionResult>
 *
 * 第一版内置 5 个 ActionHandler（按 action 一一对应）：
 * - noopHandler    (no_action)   —— 安全 no-op；success=true
 * - rememberHandler (remember)    —— 复用 infoStore；写 InfoRecord
 * - deferHandler   (defer)       —— 入队到 DeferredActionStore；不消费
 * - notifyStubHandler (notify)   —— stub：success=false + "notification handler not configured"
 * - actStubHandler (act)         —— 安全闸：未配置时 success=false；不执行任意 shell / JS / 插件
 *
 * 严格安全约束（用户决策，2026-08-27）：
 * - act handler **禁止执行任意 shell / 任意 JS / 任意插件调用**
 * - act stub 默认返回 success=false + "action handler not configured"
 * - 不允许 fake shell executor
 * - Executor 内部捕获所有 handler 异常 → 转化为 success=false ActionResult
 *
 * Phase 4.D 增加的能力：
 * - DeferredActionStore.consume(pendingId) —— 原子删除；scheduler 调用
 * - 不修改 5 个 handler；不修改 ActionExecutor；不修改 DecisionEngine
 *
 * 不做（Phase 4.B + Phase 4.D 范围外）：
 * - 排序 / 排重 / 节流
 * - 持久化（DeferredActionStore 仅 in-memory）
 * - LLM 增强
 * - scheduler 内部逻辑（由 DeferredActionScheduler plugin 负责）
 */

import { randomUUID } from 'node:crypto'
import type { Decision } from '../types/decision.js'
import type { OrcaEvent } from '../types/event.js'
import type {
  ActionExecutorService,
  ActionHandler,
  ActionHandlerRegistry,
  ActionResult,
  DeferredActionEntry,
  DeferredActionStore,
} from '../types/action.js'

// ── ActionHandlerRegistry 标准实现 ─────────────────────────────────────

/**
 * ActionHandlerRegistryImpl —— 按 action 索引 handler（Last-Write-Wins）
 *
 * - 同 action 重复 register 会覆盖（最后注册的生效）
 * - unregister 不存在不报错（fail-soft）
 */
class ActionHandlerRegistryImpl implements ActionHandlerRegistry {
  private handlers = new Map<string, ActionHandler>()

  register(handler: ActionHandler): void {
    this.handlers.set(handler.action, handler)
  }

  unregister(action: string): void {
    this.handlers.delete(action)
  }

  get(action: string): ActionHandler | undefined {
    return this.handlers.get(action)
  }

  list(): ActionHandler[] {
    return [...this.handlers.values()]
  }

  size(): number {
    return this.handlers.size
  }

  clear(): void {
    this.handlers.clear()
  }
}

/** 工厂函数：创建独立的（空）Registry；用于 R14 测试和未来配置化场景 */
export function createActionHandlerRegistry(): ActionHandlerRegistry {
  return new ActionHandlerRegistryImpl()
}

// ── DeferredActionStore 内存实现 ────────────────────────────────────────

/**
 * DeferredActionStoreImpl —— Phase 4.B + Phase 4.D pending store
 *
 * - 仅 in-memory（不持久化）
 * - 不调度（scheduler 由 DeferredActionScheduler plugin 负责）
 * - Phase 4.D 增加 consume(pendingId) 原子删除能力
 *
 * 不做：
 * - 不持久化（重启即失）
 * - 不调度（不在 store 内部做时间判断）
 * - 不做 eligibility 判定（user.status 过滤由 scheduler 负责）
 */
class DeferredActionStoreImpl implements DeferredActionStore {
  private entries = new Map<string, DeferredActionEntry>()

  enqueue(decision: Decision): string {
    const pendingId = randomUUID()
    this.entries.set(pendingId, {
      pendingId,
      decision,
      queuedAt: Date.now(),
    })
    return pendingId
  }

  get(pendingId: string): DeferredActionEntry | undefined {
    return this.entries.get(pendingId)
  }

  list(): DeferredActionEntry[] {
    return [...this.entries.values()].sort((a, b) => a.queuedAt - b.queuedAt)
  }

  size(): number {
    return this.entries.size
  }

  /**
   * 消费一个 pending（原子删除）。
   *
   * Map.delete 本身是原子的；语义：consume 后同 pendingId 不再可见。
   * 如果同一 tick 内重复 consume 同一 pendingId：第二次返回 false（已删）。
   */
  consume(pendingId: string): boolean {
    return this.entries.delete(pendingId)
  }

  clear(): void {
    this.entries.clear()
  }
}

/** 工厂函数：创建独立的 DeferredActionStore；用于 R14 测试 */
export function createDeferredActionStore(): DeferredActionStore {
  return new DeferredActionStoreImpl()
}

// ── ActionResult 构造工具 ──────────────────────────────────────────────

function okResult(decision: Decision, metadata?: Record<string, unknown>): ActionResult {
  const r: ActionResult = {
    success: true,
    action: decision.action,
    decisionId: decision.decisionId,
    executedAt: Date.now(),
  }
  if (metadata) r.metadata = metadata
  return r
}

function failResult(decision: Decision, error: string): ActionResult {
  return {
    success: false,
    action: decision.action,
    decisionId: decision.decisionId,
    error,
    executedAt: Date.now(),
  }
}

// ── 内置 5 个 ActionHandler ────────────────────────────────────────────

/**
 * noopHandler —— no_action 的安全 no-op handler
 *
 * - 始终 success=true
 * - 不做任何副作用（不查 ctx / 不写文件 / 不发消息）
 * - 是默认安全 handler（用户决策：ignore action 必须真的什么都不做）
 */
export const noopHandler: ActionHandler = {
  name: 'noop',
  action: 'no_action',
  async execute(_decision: Decision): Promise<ActionResult> {
    return okResult(_decision)
  },
}

/**
 * RememberActionContext —— remember handler 需要的最小依赖
 *
 * 第一版不复用整个 InfoAgent framework（避免耦合 InfoRecord envelope 校验）；
 * 直接调 JsonlInfoRecordStore.append（已有最小契约）。
 *
 * 未来可升级为完整 InfoAgent Push 模式（带 agent 选择 / 校验 / 路由）。
 */
export interface RememberActionContext {
  /** 档案室（来自 ctx.infoStore） */
  store: {
    append(record: {
      id?: string
      namespace: string
      type: string
      ts?: number
      source: string
      confidence?: number
      urgency?: 0 | 1 | 2
      payload: unknown
      ttlDays?: number
      supersedes?: string
    }): Promise<void>
  }
  /** Logger（warn 级别） */
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

/**
 * rememberHandler —— remember action 的 handler
 *
 * 行为：
 * - 从 Decision 构造 InfoRecord，写入 infoStore
 * - namespace 固定 'decision-action'（与现有 food-agent 等 namespace 区分）
 * - type 固定 'decision-remember'（Phase 4.B 第一版；后续可按 ruleId 分桶）
 * - urgency = 0（静默；D-AGENT-11 默认）
 * - payload = { attentionId, ruleId, priority, reason, eventId, source, decidedAt }
 * - source = 'action-executor'
 *
 * 严格不副作用：
 * - 不修改 Decision
 * - 不调 LLM
 * - 不发飞书
 * - 写档失败 → success=false（捕获异常，不抛）
 */
export function createRememberHandler(ctx: RememberActionContext): ActionHandler {
  return {
    name: 'remember',
    action: 'remember',
    async execute(decision: Decision): Promise<ActionResult> {
      try {
        const record = {
          namespace: 'decision-action',
          type: 'decision-remember',
          source: 'action-executor',
          urgency: 0 as const,
          payload: {
            attentionId: decision.attentionId,
            ruleId: decision.ruleId,
            priority: decision.priority,
            reason: decision.reason,
            eventId: decision.eventId,
            source: decision.source,
            decidedAt: decision.decidedAt,
          },
        }
        await ctx.store.append(record)
        return okResult(decision)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        ctx.logger?.warn('[action:remember] 写档失败: %s', detail)
        return failResult(decision, `remember failed: ${detail}`)
      }
    },
  }
}

/**
 * DeferActionContext —— defer handler 需要的最小依赖
 *
 * 第一版不依赖任何外部服务；仅持有一个 DeferredActionStore。
 * 外部可通过 store 参数注入自定义 store（测试用）。
 */
export interface DeferActionContext {
  /** Pending store（默认独立 in-memory 实例） */
  store?: DeferredActionStore
  /** Logger */
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

/**
 * deferHandler —— defer action 的 handler
 *
 * 行为：
 * - 入队到 DeferredActionStore
 * - 返回 success=true + metadata.pendingId
 * - Phase 4.B 第一版**不消费**（仅记录）
 * - Phase 4.C+ 真实 scheduler 接入后读 store.list() 消费
 *
 * 严格不副作用：
 * - 不写 infoStore
 * - 不发飞书
 * - 不调 LLM
 */
export function createDeferHandler(ctx: DeferActionContext = {}): ActionHandler {
  const store = ctx.store ?? createDeferredActionStore()
  return {
    name: 'defer',
    action: 'defer',
    async execute(decision: Decision): Promise<ActionResult> {
      try {
        const pendingId = store.enqueue(decision)
        return okResult(decision, { pendingId })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        ctx.logger?.warn('[action:defer] 入队失败: %s', detail)
        return failResult(decision, `defer failed: ${detail}`)
      }
    },
  }
}

/**
 * NotifyStubActionContext —— notify stub handler 需要的依赖（Phase 4.B 保留的 fallback）
 *
 * 注：真实 notify handler 由 createNotifyHandler 实现（Phase 4.C），
 * createNotifyStubHandler 仅作为 fallback：
 * - 当 plugin 检测到 feishu 或 eventBus 缺失时，notify stub 保留
 * - 当外部不调用 createActionHandlerRegistry.register 覆盖时，stub 仍生效
 */
export interface NotifyStubActionContext {
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

/**
 * notifyStubHandler —— notify action 的默认 stub handler
 *
 * 行为：
 * - 始终 success=false
 * - error = "notification handler not configured"
 *
 * 安全语义：
 * - 不调用 FeishuClient
 * - 不调用任何外部通知 SDK
 * - 真实 notify handler 必须由 Phase 4.C+ 显式注册并配置 FeishuClient 依赖
 *
 * 设计动机（用户决策，2026-08-27）：
 * "如果现有项目没有成熟 notification service：不要自己重新实现 Feishu API。
 *  可以先提供一个明确的 notify handler stub：success = false + error = 'notification handler not configured'。
 *  不要伪造成功。"
 */
export function createNotifyStubHandler(ctx: NotifyStubActionContext = {}): ActionHandler {
  return {
    name: 'notify-stub',
    action: 'notify',
    async execute(decision: Decision): Promise<ActionResult> {
      ctx.logger?.warn(
        '[action:notify] notify handler not configured（Phase 4.B stub）。decisionId=%s ruleId=%s',
        decision.decisionId, decision.ruleId,
      )
      return failResult(decision, 'notification handler not configured')
    },
  }
}

/**
 * ActActionContext —— act handler 需要的依赖（Phase 4.B 第一版仅 stub）
 *
 * 严格安全约束（用户决策，2026-08-27）：
 * - act handler **禁止执行任意 shell / 任意 JS / 任意插件调用**
 * - 未配置 handler 时 success=false
 * - **绝对不要默认执行任意 command**
 *
 * 后续 act 真实实现必须经过：
 * 1. 显式注册 ActionHandler（不允许内部 fallback 调 InfoAgent / Plugin）
 * 2. ActionHandler 内部必须实现 D-AGENT-06 最小权限注入
 * 3. 调用任何 shell 都需经过白名单校验（属 Phase 4.C+）
 */
export interface ActActionContext {
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

/**
 * actStubHandler —— act action 的默认 stub handler
 *
 * 行为：
 * - 始终 success=false
 * - error = "action handler not configured"
 *
 * 这是最重要的安全边界。
 *
 * 设计动机（用户决策，2026-08-27）：
 * "act 必须经过显式注册的 ActionHandler。"
 * "不要为了测试而加入 fake shell executor。"
 */
export function createActStubHandler(ctx: ActActionContext = {}): ActionHandler {
  return {
    name: 'act-stub',
    action: 'act',
    async execute(decision: Decision): Promise<ActionResult> {
      ctx.logger?.warn(
        '[action:act] act handler not configured（Phase 4.B 安全 stub；禁止任意 shell）。decisionId=%s ruleId=%s',
        decision.decisionId, decision.ruleId,
      )
      return failResult(decision, 'action handler not configured')
    },
  }
}

// ── 真实 NotifyHandler（Phase 4.C：Orca 第一个真实 Action）────────────

/**
 * NotifyFeishuLike —— NotifyHandler 依赖的 Feishu 最小接口
 *
 * 结构化类型（structural typing）：仅声明 sendToChat；不强制注入完整 FeishuClient。
 * 这样 NotifyHandler 不依赖完整 FeishuClient，便于测试用 mock 替代。
 *
 * FeishuClient.sendToChat 已存在（services/feishu.ts:49）；结构兼容。
 */
export interface NotifyFeishuLike {
  sendToChat(chatId: string, text: string): Promise<void>
}

/**
 * NotifyEventBusLike —— NotifyHandler 依赖的 EventBus 最小接口
 *
 * 结构化类型：仅声明 get（按 eventId 反查 OrcaEvent）。
 * EventBus.get(id) 已存在（services/eventBus.ts:140，Phase 4.C 最小增量）。
 */
export interface NotifyEventBusLike {
  get(id: string): OrcaEvent | undefined
}

/**
 * NotifyActionContext —— NotifyHandler 依赖上下文
 *
 * 关键约束：
 * - feishu + eventBus 是必须依赖（dryRun=true 时 feishu 仍需注入但不被调用）
 * - dryRun 复用现有 OrcaConfig.dryRun（ORCA_DRY_RUN=1）
 * - logger 可选；用于 dryRun 日志 + 成功/失败日志
 *
 * NotifyHandler 是 Feishu-aware 的；Decision / Attention / DecisionEngine 不感知 Feishu。
 */
export interface NotifyActionContext {
  feishu: NotifyFeishuLike
  eventBus: NotifyEventBusLike
  dryRun: boolean
  logger?: {
    info(msg: string, ...args: unknown[]): void
    warn(msg: string, ...args: unknown[]): void
  }
}

/**
 * FeishuEventData —— Feishu event.data 的最小视图
 *
 * 由 feishu-adapter.ts 翻译 FeishuMessageEvent / FeishuImageEvent 时写入 OrcaEvent.data。
 * 最小契约：
 * - chatId 必需（用于 sendToChat）
 * - text 可选（仅 message 类型事件有；image 类型无；用于上下文回显）
 *
 * 不读其他字段（openId / messageId / meta 等）；Phase 4.C 第一版不需要。
 *
 * extends Record<string, unknown> 是为了让 isFeishuEventData 的 type predicate
 * 能通过 TS 的"参数类型与谓词类型必须可赋值"约束。
 */
interface FeishuEventData extends Record<string, unknown> {
  /** 飞书 chat id（p2p / 群聊均可；sendToChat 走 receive_id_type=chat_id） */
  chatId: string
  /** 原始文本（仅 message 类型事件有；image 类型无） */
  text?: string
}

/**
 * 类型守卫：OrcaEvent.data 形如 FeishuEventData
 *
 * 不使用 any；只校验 chatId 字段（必须为非空 string）。
 * 校验通过后 TypeScript 视 data 为 FeishuEventData，可安全访问 chatId。
 */
function isFeishuEventData(d: Record<string, unknown>): d is FeishuEventData {
  return typeof d.chatId === 'string' && (d.chatId as string).length > 0
}

/**
 * createNotifyHandler —— notify action 的真实 handler（Phase 4.C）
 *
 * 行为（顺序判断，任一失败立即返回 success=false）：
 * 1. decision.eventId undefined  → "no source event for state-only trigger"
 *    （state-only 触发如 orca/state_changed 没有源事件）
 * 2. eventBus.get(eventId) === undefined  → "event evicted from window"
 *    （事件已被 sliding window 丢弃；windowSize 默认 200）
 * 3. event.source !== 'feishu'  → "unsupported source for notify: ${source}"
 *    （当前仅支持 feishu；其他 source 留作 Phase 4.D+ 扩展）
 * 4. !isFeishuEventData(event.data)  → "feishu event missing chat context"
 *    （Feishu 事件但 data.chatId 缺失 / 非字符串 / 空字符串）
 * 5. dryRun=true  → 仅日志，return success=true + metadata={dryRun,chatId,textPreview}
 * 6. dryRun=false → feishu.sendToChat(chatId, text)；
 *    成功 → success=true + metadata={chatId}；失败 → success=false + error
 *
 * 消息文本（第一版最小化；不引入模板系统 / 卡片 DSL / i18n / LLM 生成）：
 *   [Orca] ${priority}
 *   ${reason}
 *
 *   源消息: ${originalText.slice(0, 200)}    // 仅当 text 存在
 *
 * 严格安全 / 不允许：
 * - ❌ 任何 shell / exec / plugin 调用（NotifyHandler 不持有 shell 接口）
 * - ❌ 自动 fallback（source 非 feishu 即失败，不尝试其他通道）
 * - ❌ 伪造 success（任何错误都明确返回 success=false + error）
 * - ❌ 修改 Decision / AttentionItem / WorldState
 * - ❌ LLM 生成消息内容
 */
export function createNotifyHandler(ctx: NotifyActionContext): ActionHandler {
  return {
    name: 'notify',
    action: 'notify',
    async execute(decision: Decision): Promise<ActionResult> {
      // 1. eventId 必须存在（state-only 触发没源事件）
      if (!decision.eventId) {
        return failResult(decision, 'no source event for state-only trigger')
      }

      // 2. 从 EventBus 反查原始 OrcaEvent
      const event = ctx.eventBus.get(decision.eventId)
      if (!event) {
        return failResult(decision, 'event evicted from window')
      }

      // 3. 仅支持 feishu source
      if (event.source !== 'feishu') {
        return failResult(decision, `unsupported source for notify: ${event.source}`)
      }

      // 4. narrow event.data 到 FeishuEventData（type guard；不使用 any）
      if (!isFeishuEventData(event.data)) {
        return failResult(decision, 'feishu event missing chat context')
      }

      const chatId = event.data.chatId
      const originalText = typeof event.data.text === 'string' ? event.data.text : ''

      // 5. 构造通知文本（第一版最小化）
      const lines: string[] = [
        `[Orca] ${decision.priority}`,
        decision.reason,
      ]
      if (originalText) {
        lines.push('', `源消息: ${originalText.slice(0, 200)}`)
      }
      const text = lines.join('\n')

      // 6. dryRun 拦截：仅记录日志，不发送
      if (ctx.dryRun) {
        ctx.logger?.info(
          '[action:notify] dryRun=true 不发送。chatId=%s decisionId=%s text=%s',
          chatId, decision.decisionId, text.slice(0, 80),
        )
        return okResult(decision, {
          dryRun: true,
          chatId,
          textPreview: text.slice(0, 80),
        })
      }

      // 7. 真实发送
      try {
        await ctx.feishu.sendToChat(chatId, text)
        ctx.logger?.info(
          '[action:notify] 发送成功。chatId=%s decisionId=%s',
          chatId, decision.decisionId,
        )
        return okResult(decision, { chatId })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        ctx.logger?.warn(
          '[action:notify] sendToChat 失败 (decisionId=%s chatId=%s): %s',
          decision.decisionId, chatId, detail,
        )
        return failResult(decision, `feishu sendToChat failed: ${detail}`)
      }
    },
  }
}

// ── ActionExecutor 服务工厂 ─────────────────────────────────────────────

/**
 * ActionExecutorOptions —— Executor 创建参数
 *
 * 设计原则：
 * - registry / deferredStore 可由外部注入（测试用；默认使用内置实例）
 * - 外部可注册额外 handler（fire-and-forget）
 */
export interface ActionExecutorOptions {
  registry?: ActionHandlerRegistry
  deferredStore?: DeferredActionStore
}

// ── Memory handlers（Phase 5.2）────────────────────────────────────────────

/**
 * MemoryRememberContext —— memory.remember handler 需要的最小依赖
 */
export interface MemoryRememberContext {
  memory: import('../types/memory.js').MemoryStore
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

/**
 * MemoryForgetContext —— memory.forget handler 需要的最小依赖
 */
export interface MemoryForgetContext {
  memory: import('../types/memory.js').MemoryStore
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

/**
 * memory.remember handler（Phase 5.2）
 *
 * 行为：
 * - 从 Decision.reason 中解析 JSON { subject, type, value, confidence? }
 * - 调用 MemoryStore.upsertFact，source='user-explicit'，createdBy='user-explicit'
 * - 同 type+subject 已存在时原地更新（Phase 5.0 upsert 语义）
 *
 * 约束：
 * - 不经过 Reflection（source='user-explicit' 直接写入 active）
 * - 不调用 createForgetMarker（那是 forget 的职责）
 * - 写失败 → success=false（不抛异常给 caller）
 * - Decision.reason 不是合法 JSON 时：尝试用 reason 本身作为 value，subject 尝试解析
 */
export function createMemoryRememberHandler(ctx: MemoryRememberContext): ActionHandler {
  return {
    name: 'memory.remember',
    action: 'memory.remember',
    async execute(decision: Decision): Promise<ActionResult> {
      try {
        const parsed = tryParseRememberReason(decision.reason)
        if (!parsed) {
          return failResult(decision, `memory.remember: cannot parse reason: ${decision.reason}`)
        }

        const { subject, type, value, confidence } = parsed

        const fact: import('../types/memory.js').LongMemoryFact = {
          id: '', // upsert 时自动生成或保持已有 id
          type: type ?? 'fact',
          subject: subject ?? decision.reason.slice(0, 100),
          value: value ?? decision.reason,
          confidence: confidence ?? 0.9,
          source: 'user-explicit',
          state: 'active',
          representativeEvidenceIds: [],
          evidenceCount: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: 'user-explicit',
          privacyLevel: 'L1',
        }

        const saved = await ctx.memory.upsertFact(fact)
        return {
          success: true,
          action: 'memory.remember',
          decisionId: decision.decisionId,
          executedAt: Date.now(),
          metadata: {
            factId: saved.id,
            subject: saved.subject,
            type: saved.type,
          },
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        ctx.logger?.warn('[action:memory.remember] 写入失败: %s', detail)
        return failResult(decision, `memory.remember failed: ${detail}`)
      }
    },
  }
}

/**
 * memory.forget handler（Phase 5.2）
 *
 * 行为：
 * - 从 Decision.reason 中解析 JSON { subject?, type?, id? } 作为查询条件
 * - 调用 MemoryStore.forgetByQuery（原子操作，内部包含 createForgetMarker + fact purge + audit）
 * - 返回被删除的事实数量
 *
 * 约束：
 * - 不直接调用 createForgetMarker（由 forgetByQuery 内部处理）
 * - 不自己写 audit（MemoryStore.forgetByQuery 内部处理）
 * - MemoryStore.forgetByQuery 是幂等的（找不到 = 0，不报错）
 * - 返回 forgottenCount === 0 时仍为 success=true（"已经没有了"也是成功）
 */
export function createMemoryForgetHandler(ctx: MemoryForgetContext): ActionHandler {
  return {
    name: 'memory.forget',
    action: 'memory.forget',
    async execute(decision: Decision): Promise<ActionResult> {
      try {
        const query = tryParseForgetQuery(decision.reason)
        if (!query) {
          return failResult(decision, `memory.forget: cannot parse reason: ${decision.reason}`)
        }

        const forgottenCount = await ctx.memory.forgetByQuery(query)
        return {
          success: true,
          action: 'memory.forget',
          decisionId: decision.decisionId,
          executedAt: Date.now(),
          metadata: {
            forgottenCount,
            query,
          },
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        ctx.logger?.warn('[action:memory.forget] 执行失败: %s', detail)
        return failResult(decision, `memory.forget failed: ${detail}`)
      }
    },
  }
}

// ── JSON reason 解析辅助 ───────────────────────────────────────────────

interface RememberParse {
  subject?: string
  type?: import('../types/memory.js').FactType
  value?: string
  confidence?: number
}

interface ForgetQueryParse {
  subject?: string
  type?: import('../types/memory.js').FactType
  subjectPrefix?: string
}

/**
 * 解析 Decision.reason 中的 remember 参数。
 * 期望 JSON: { subject, type?, value?, confidence? }
 * 如果 reason 本身不是 JSON，尝试提取。
 */
function tryParseRememberReason(reason: string): RememberParse | null {
  try {
    const parsed = JSON.parse(reason)
    if (typeof parsed === 'object' && parsed !== null) {
      return {
        subject: String(parsed.subject ?? ''),
        type: parsed.type,
        value: parsed.value !== undefined ? String(parsed.value) : undefined,
        confidence: parsed.confidence !== undefined ? Number(parsed.confidence) : undefined,
      }
    }
  } catch {
    // 不是 JSON，尝试提取
  }
  // 兜底：如果 reason 包含 key=value 模式
  const match = reason.match(/"subject"\s*:\s*"([^"]+)"/)
  if (match) {
    return { subject: match[1] }
  }
  return null
}

/**
 * 解析 Decision.reason 中的 forget 查询参数。
 * 期望 JSON: { subject?, type?, subjectPrefix? }
 */
function tryParseForgetQuery(reason: string): ForgetQueryParse | null {
  try {
    const parsed = JSON.parse(reason)
    if (typeof parsed === 'object' && parsed !== null) {
      return {
        subject: parsed.subject !== undefined ? String(parsed.subject) : undefined,
        type: parsed.type,
        subjectPrefix: parsed.subjectPrefix !== undefined ? String(parsed.subjectPrefix) : undefined,
      }
    }
  } catch {
    // 不是 JSON
  }
  // 兜底：直接用 reason 作为 subject
  return { subject: reason.trim() }
}

/**
 * 工厂函数：创建 ActionExecutor 实例
 *
 * - 默认 registry 已注册 5 个内置 handler（noop/remember(defer-store)/defer/notify-stub/act-stub）
 * - remember handler 需要 RememberActionContext.store；无 ctx 时默认 success=false + error
 * - defer / notify-stub / act-stub 可独立构造
 *
 * 注意：Phase 4.B 第一版默认**不提供** remember handler（需要 ctx 注入 store）。
 * 调用方可在外层手动 register(createRememberHandler({ store })) 注入。
 */
export function createActionExecutor(opts: ActionExecutorOptions = {}): ActionExecutorService {
  const registry = opts.registry ?? createActionHandlerRegistry()
  const deferredStore = opts.deferredStore ?? createDeferredActionStore()

  // 默认注册安全 handler：
  // - noop / defer / notify-stub / act-stub 不依赖外部 ctx，进来即可用
  // - remember handler 需要 store 依赖，由调用方显式 register（如 plugin 装配时）
  registry.register(noopHandler)
  registry.register(createDeferHandler({ store: deferredStore }))
  registry.register(createNotifyStubHandler())
  registry.register(createActStubHandler())

  return {
    registry,
    deferredStore,

    async execute(decision: Decision): Promise<ActionResult> {
      const handler = registry.get(decision.action)
      if (!handler) {
        // 未知 action / 未注册 handler → 明确错误（不抛）
        return failResult(decision, `no handler registered for action: ${decision.action}`)
      }
      try {
        // handler.execute 内部应捕获自身异常；此处再 catch 一次作为兜底
        return await handler.execute(decision)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return failResult(decision, `handler ${handler.name} threw: ${detail}`)
      }
    },
  }
}
