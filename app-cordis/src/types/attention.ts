/**
 * Orca Attention Engine —— 注意力系统类型（Phase 3）
 *
 * 设计动机：
 * - WorldState 持续接收外部信号 → 用户当前状态被持续推导
 * - Attention Engine 决定"这个事件/状态变化是否值得关注"
 * - 输出 AttentionItem（建议的行为方向）→ Phase 4 Decision 决定具体执行
 *
 * 关键设计：AttentionItem.action 是**建议**（不立即执行），Decision 才是**执行**。
 * Phase 4 才会真正发飞书消息 / 调 agent / 写 infoStore。
 *
 * 与 EventBus / WorldState 的关系：
 * - EventBus → 持续事件流（OrcaEvent）
 * - WorldState → 持续状态（user/device/time）
 * - **Attention** = Event × State → AttentionItem[]
 * - Decision = AttentionItem[] → 具体 action（Phase 4）
 * - LLM 增强在 Phase 5（评审 AttentionItem，非替代）
 */

import type { OrcaEvent } from './event.js'
import type { WorldState } from './worldState.js'

/** 建议采取的行为方向（Phase 4 Decision 实际执行；当前仅 emit 不执行） */
export const ORCA_ATTENTION_ACTIONS = [
  'notify_immediately',   // 立即推送（飞书消息 / Bark 推送）
  'wait_until_available',  // 等待用户可用时合并通知（不在 busy / sleeping 时打扰）
  'remember_only',        // 只入档案（infoStore），不打扰用户
  'ignore',                // 完全忽略
  'act',                   // 需要调用 InfoAgent / agent plugin 做点什么（Phase 4 扩展）
] as const

export type AttentionAction = (typeof ORCA_ATTENTION_ACTIONS)[number] | (string & {})

/** 紧急度（Phase 4 排序用；high > normal > low） */
export const ORCA_ATTENTION_PRIORITIES = [
  'urgent',
  'high',
  'normal',
  'low',
] as const

export type AttentionPriority = (typeof ORCA_ATTENTION_PRIORITIES)[number] | (string & {})

/**
 * 评估时的输入。
 *
 * - event: 触发的具体事件（state-only 触发如 `orca/state_changed` 监听器调用 → event=null）
 * - state: 当前 WorldState 快照
 * - prevState: event 处理前的 WorldState 快照（state-only 触发 → undefined）
 *
 * 关键点：Attention 规则可写"prevState→state"的状态变化判断，例如：
 *   prevState.user.status !== 'busy' && state.user.status === 'busy'  → "用户刚进入 busy"
 */
export interface AttentionInput {
  event: OrcaEvent | null
  state: WorldState
  prevState?: WorldState
}

/**
 * 评估输出（一条规则 = 一个 item）。
 *
 * - id: 稳定唯一 ID（Phase 4.A 引入；Decision back-trace + debug 日志关联）
 * - ruleId: 触发规则的唯一 ID（用于追溯）
 * - priority / action / reason: 规则的语义产出
 * - eventId: 触发的具体事件（state-only 触发为 undefined）
 * - source: 触发的 source（feishu / pc / calendar / phone / 'state' 等）；Phase 3.B.throttle 用作 source cooldown 决策
 *   - 'state' 表示 state-only 触发（orca/state_changed），Throttle 不应用 source cooldown（避免 state_changed 被任意 source cooldown 限制）
 *   - undefined 表示 evaluate 时无法识别 source（极少；Throttle 不应用 source cooldown）
 * - stateSnapshot: 评估时的 WorldState 快照（用于追溯，**深拷贝避免外部 mutation**）
 * - evaluatedAt: 评估时间戳
 */
export interface AttentionItem {
  /** 稳定唯一 ID（AttentionEngine.evaluate 时生成 randomUUID）；Phase 4.A Decision back-trace 用 */
  id: string
  ruleId: string
  priority: AttentionPriority
  reason: string
  action: AttentionAction
  eventId?: string
  /** Feishu chatId（feishu 消息来源）；用于 CognitionOutput 路由回飞书 */
  chatId?: string
  /** Dashboard 请求 id（dashboard 消息来源）；用于 CognitionOutput 路由回 SSE */
  dashboardMessageId?: string
  /** 通道会话标识；区别于一次 CognitionSession */
  sessionId?: string
  /** 输入适配器观测到的客户端设备类别 */
  device?: string
  source?: string
  stateSnapshot: WorldState
  evaluatedAt: number
}

/** 规则判定函数：返回 true 表示触发 */
export type AttentionPredicate = (input: AttentionInput) => boolean

/** 规则产物生成：触发后如何描述（除 id / ruleId / stateSnapshot / evaluatedAt 外的字段；id 由 Engine 生成） */
export type AttentionProducer = (
  input: AttentionInput
) => Omit<AttentionItem, 'id' | 'ruleId' | 'stateSnapshot' | 'evaluatedAt'>

/** 完整规则（id 必须全局唯一） */
export interface AttentionRule {
  id: string
  /** 人类描述（debug 用；不参与逻辑） */
  description: string
  predicate: AttentionPredicate
  produce: AttentionProducer
}

/**
 * AttentionEngine 是 Cordis 暴露给其他 plugin 的服务。
 *
 * 设计原则：
 * - 纯评估：evaluate() 只返回 AttentionItem[]，不执行任何 action
 * - 不持久化（重启即失）
 * - 不去重 / 不节流（Phase 3 第一版；Phase 3.B 增加去重；Phase 4+ 节流）
 */
export interface AttentionEngineService {
  evaluate(input: AttentionInput): AttentionItem[]
  /** 已注册规则数（debug 用） */
  ruleCount(): number
}

/**
 * AttentionDedup —— Attention Stream 去重层（Phase 3.B）
 *
 * 职责分离：
 * - AttentionEngine：判断事件是否值得关注 + 产生 AttentionItem（**关注"是什么"**）
 * - AttentionDedup：  控制同一 (ruleId, eventId) 是否在窗口期内重复 emit（**关注"多不多"**）
 *
 * 不做（Phase 3.B 第一版）：
 * - 不做 priority 合并（多个 item 不合并，只决定 emit/drop）
 * - 不做 throttle / cooldown（按 source 节流属 Phase 3.B 第二步）
 * - 不做持久化
 * - 不暴露配置（默认窗口 5000ms，构造参数仅供测试用）
 *
 * key 设计：`${ruleId}:${eventId ?? '__state__'}`
 * - 同 ruleId + 同 eventId 在窗口期内 → 第二次 drop
 * - state-only 触发（eventId=undefined，如 orca/state_changed）→ 用 '__state__' 兜底
 *   （否则多个 state_changed 触发会因 key 全部相同而被 dedup，丢失信息）
 */
export interface AttentionDedupService {
  /**
   * 判断 item 是否应 emit（true）或 drop（false）。
   * - true：从未 emit 过（或窗口已过期），且已记录本次 emit
   * - false：窗口期内重复，drop
   *
   * 副作用：调用即更新内部 map（lastEmitTs = now）。
   */
  shouldEmit(item: AttentionItem): boolean
  /** 当前 map 大小（debug 用） */
  size(): number
  /** 清空 map（测试 / dispose） */
  clear(): void
}

/**
 * AttentionRuleRegistry —— 规则注册表（Phase 3.B.rule-registry）
 *
 * 职责：
 * - Engine 不直接持有规则列表（之前硬编码模块全局 ruleRegistry）
 * - 通过 registry.getRules() 获取当前启用的规则（按注册顺序）
 * - 支持动态 register / unregister / setEnabled（未来可对接配置系统）
 *
 * 设计原则：
 * - 数组保序（Map.values() 顺序依赖插入序；改用数组更显式）
 * - enabled 状态由 Registry 维护（不污染 Rule 本身——Rule 是纯数据 + 谓词）
 * - 同 ruleId 重复 register 覆盖（保留原位置，便于热更新）
 * - getRules() 只返回 enabled 的；getAllRules() 含 disabled（debug 用）
 */
export interface AttentionRuleRegistry {
  /**
   * 注册规则。同 id 重复注册会**覆盖并保留原位置**（便于热更新）。
   * 注册后默认 enabled=true。
   */
  register(rule: AttentionRule): void
  /** 注销规则（从列表移除）。不存在不报错。 */
  unregister(ruleId: string): void
  /**
   * 获取当前启用的规则列表（按注册顺序）。
   * Engine 调用此方法遍历 evaluate。
   */
  getRules(): AttentionRule[]
  /**
   * 获取所有规则（含 disabled），按注册顺序。debug / 监控用。
   */
  getAllRules(): AttentionRule[]
  /**
   * 启用 / 禁用规则。已注册才能禁用；未注册抛错。
   * 禁用后规则仍在 registry 中（getAllRules 可见），但 getRules 不返回。
   */
  setEnabled(ruleId: string, enabled: boolean): void
  /** 查询规则是否启用（未注册返回 false） */
  isEnabled(ruleId: string): boolean
  /** 当前启用规则数（getRules().length） */
  size(): number
  /** 清空所有规则（含 disabled）—— 测试 / dispose */
  clear(): void
}

/**
 * AttentionRuleConfigEntry —— 单条规则的配置项（Phase 3.B.rule-config）
 *
 * **严格约束**：只允许表达"启用/禁用"和未来可调的简单参数。
 * **禁止** predicate / expression / JavaScript 代码等 DSL 形态。
 * 当前仅 `enabled`；未来扩展字段（如 priority、cooldownMs）只需在 loader 解析白名单。
 */
export interface AttentionRuleConfigEntry {
  /** true / false；缺省 true（不写 = 启用） */
  enabled: boolean
}

/**
 * AttentionRuleConfig —— 配置文件根形态（Phase 3.B.rule-config）
 *
 * 严格 JSON 格式（Phase 3.B 第一版；YAML 为后续扩展）：
 * ```json
 * {
 *   "rules": {
 *     "sleeping-quiet": { "enabled": true },
 *     "away-arrival": { "enabled": false }
 *   }
 * }
 * ```
 *
 * **不**支持：
 * - predicate / 表达式
 * - 新建规则（Rule 必须先由 TypeScript 代码 register）
 * - JavaScript 注入
 */
export interface AttentionRuleConfig {
  rules: Record<string, AttentionRuleConfigEntry>
}

/**
 * AttentionRuleConfigLoader —— 配置加载器（Phase 3.B.rule-config）
 *
 * 职责：
 * 1. parse(jsonText)：JSON string → AttentionRuleConfig（纯函数，无副作用）
 * 2. load(config, registry)：应用配置到 registry（副作用；仅设置 enabled 状态）
 *
 * 设计原则：
 * - **不创建新 Rule**——Rule 必须先由 TypeScript 代码 register
 * - **未知 ruleId 抛错**（fail-fast；不静默）
 * - **拒绝未知字段**（防 DSL 倾向：写 `predicate: "..."` 直接报错）
 * - Loader 接受 registry 参数（不假设用 default；测试可用独立 Registry）
 *
 * 不做：
 * - YAML parser（项目无 YAML 依赖；后续可加）
 * - DSL / 表达式 / JavaScript 注入
 * - LLM rule generation（Phase 5+）
 */
export interface AttentionRuleConfigLoader {
  /**
   * Parse JSON string → AttentionRuleConfig（纯函数；失败抛错）
   * @throws JSON parse error / 结构校验失败
   */
  parse(jsonText: string): AttentionRuleConfig
  /**
   * 应用配置到 registry（仅设置 enabled 状态，不创建新 Rule）
   * @throws 未知 ruleId / 其他规则校验失败
   */
  load(config: AttentionRuleConfig, registry: AttentionRuleRegistry): void
}

/**
 * AttentionThrottle —— Attention Stream 节流层（Phase 3.B.throttle）
 *
 * 职责分离：
 * - AttentionEngine：判断事件是否值得关注 + 产生 AttentionItem（**关注"是什么"**）
 * - AttentionDedup：  控制同一 (ruleId, eventId) 是否在窗口期内重复 emit（**关注"是不是新刺激"**）
 * - AttentionThrottle：**关注"现在该不该打扰用户"**——即使值得注意，也要避免短时间内反复打扰
 *
 * 限制范围（用户决策）：
 * - **仅对会打扰用户的 action 生效**：`notify_immediately` + `act`
 * - `remember_only` / `ignore` / `wait_until_available` **直通**（不被 throttle 影响）
 * - state-only 触发的 item（source='state'）**直通**（不应用 source cooldown，避免 state_changed 被任意 source 限制）
 *
 * 不做（Phase 3.B 第二步）：
 * - 不持久化
 * - 不规则配置化（用户决策：先稳定再配置）
 * - 不 LLM 增强
 */
export interface AttentionThrottleService {
  /**
   * 判断 item 是否应通过 throttle emit（true）或被节流（false）。
   *
   * - true：item 应 emit（首次 / cooldown 外 / cap 未满）
   * - false：被 cooldown 或 hourly cap 拦截
   *
   * 注意：是否真正 emit 仍取决于 Dedup 决定（Throttle 在 Dedup 之后；只决定是否放行已经通过 Dedup 的 item）
   */
  shouldEmit(item: AttentionItem): boolean
  /** 清空所有状态（dispose / 测试） */
  reset(): void
  /** 注入 clock（仅测试用，避免 setTimeout 真实等待） */
  setClock(fn: () => number): void
}
