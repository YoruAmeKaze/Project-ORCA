# Orca IM Bridge — Communication Observation Design

> 日期：2026-09-09
> 阶段：IM-1.5（设计，不实现）
> 状态：草稿，供 review

---

## 1. 背景与目标

IM-1.0 已完成 Message Adapter 基础设施（EventBus 接入 + Mock Adapter）。Orca 现在可以"看到"IM 消息，但还不知道：

- 谁经常联系？
- 什么时候最活跃？
- 哪些对话是"突发"的？
- 用户当前是否方便回复？

**IM-1.5 目标**：设计通信观察层——在**不修改 Runtime 代码**的前提下，明确：
1. IM 消息如何流入 EpisodeEngine（未来扩展路径）
2. 哪些通信行为数据可以被观察
3. 哪些数据**绝对禁止**收集
4. 未来 IM Attention 可消费的 `CommunicationSignal` 接口（设计阶段，不实现）

**核心原则**：
> 记录**通信行为模式**（谁、什么时候、多频繁），而不是**通信内容**或**人际关系**。

---

## 2. Episode vs Memory：数据边界

| | Episode（通信观察）| Memory（长期知识）|
|---|---|---|
| **内容** | 通信行为信号（次数/时间/频率）| 稳定事实、偏好、关系 |
| **示例** | Alice 今天发了 5 条消息（高峰 21:00）| Alice 是我导师 |
| **TTL** | 7 天（自动清理）| 长期，直到用户遗忘 |
| **来源** | EventBus 事件（IM 消息）| Reflection / 用户显式 |
| **LLM 介入** | 无（纯规则）| 无（Phase 5.3 reflection 是规则）|
| **隐私敏感度** | 低（无内容）| 高（内容相关）|

**硬性边界**：通信观察数据**不得晋升为 Memory**。EpisodeEngine 生成的数据是"行为信号"，不是"事实"，不通过 `promoteCandidate` 进入 LongMemory。

---

## 3. IM 消息如何进入 EpisodeEngine（扩展路径）

### 3.1 当前 EpisodeEngine 行为

Phase 5.1 EpisodeEngine 已支持：

| Episode.kind | 触发条件 | 生成内容 |
|---|---|---|
| `message.burst` | 同 sender 在 90s 内发送 ≥3 条消息 | `summary='高频率消息：{sender} 在 {duration}s 内发了 {count} 条'` |
| `state.transition` | WorldState user.status 状态转换 | `summary='状态切换：{from} → {to}'` |

EpisodeEngine 当前只订阅 `feishu` 事件（`event.source === 'feishu' && event.type === 'message'`）。

### 3.2 未来扩展：支持 IM 消息

**不需要修改 Runtime 架构**，只需在 EpisodeEngine 中扩展 source 分支：

```ts
// 未来 EpisodeEngine.handleEvent 扩展（示意，不实现）
async handleEvent(event: OrcaEvent): Promise<void> {
  if (event.source === 'feishu' && event.type === 'message') {
    // 现有逻辑
  }
  // IM-1.5 扩展：当 IM adapter 接入后，IM 消息通过 EventBus 进入同一处理流
  if (event.source.startsWith('im.') && event.type === 'im.message.received') {
    // 检测 im.burst（见 §4.1）
    // 检测 active hours（见 §4.2）
    // 不存储 message content
  }
}
```

**关键约束**：
- EventBus 是唯一入口（已在 IM-1.0 保证）
- EpisodeEngine 只读 EventBus，不主动拉取
- 不修改 EventBus / WorldState / DecisionEngine

---

## 4. 可观察的通信数据

### 4.1 `im.burst`（消息突发）

**定义**：同一 sender 在短时间窗口内发送多条消息。

**Episode.kind = `im.burst`**（新增）

```ts
interface ImBurstEpisode {
  id: string
  category: 'communication'
  kind: 'im.burst'
  summary: string          // 示例："im.burst: alice 15min 内发了 8 条"
  ts: number              // burst 结束时间
  entities: string[]      // [senderId]
  sourceEventIds: string[] // 对应 EventBus 事件 ID 列表（用于 debug）
  importance: 'low' | 'normal' | 'high'
  ttlDays: number         // 7
  state: 'active' | 'pruned'
  metadata: {
    senderId: string
    conversationId: string
    messageCount: number
    durationMs: number    // 首条到最后一条的时间差
    platform: string      // 'im.qq' | 'im.wechat'
    firstMessageTs: number
    lastMessageTs: number
  }
}
```

**生成规则**（确定性，无 LLM）：
- 窗口：60 分钟内，同 senderId + 同 conversationId，≥3 条消息
- `importance=high`：`messageCount ≥ 8` 或 `durationMs ≤ 5min`
- `importance=normal`：`messageCount 3~7`
- `summary` 不含消息内容，只含计数和 senderId

**与 Feishu burst 的区别**：

| | Feishu `message.burst` | IM `im.burst` |
|---|---|---|
| 来源 | `feishu:message` | `im.*:im.message.received` |
| 窗口 | 90s | 60min（IM 消息间隔更大）|
| 最小条数 | 3 | 3 |
| 场景 | 即时聊天突发 | 中长间隔对话 |

### 4.2 Active Hours（活跃时段）

**定义**：按小时统计用户在 IM 上的活跃模式。

**不生成 Episode**，而是通过 Query Episode 数据聚合得到：

```ts
interface ActiveHoursSignal {
  senderId: string
  platform: string
  /** key = 小时（0~23 UTC），value = 该小时消息数 */
  hourDistribution: Record<number, number>
  totalMessages: number
  computedFromTs: number  // 统计起始时间
  computedAt: number      // 计算时间
}
```

**用途**：
- "Alice 经常在 21:00~23:00 发消息" → 重要联系人
- "快递机器人只在工作时间发" → 非重要联系人
- 用户 active hours 与 IM 消息时间的重叠度 → 通知时机决策

**隐私约束**：只聚合消息数量和时间，不存储消息内容。

### 4.3 Sender Frequency（发送者频率）

**定义**：统计每个 sender 在过去 N 天内的消息频率。

```ts
interface SenderFrequencySignal {
  senderId: string
  platform: string
  messagesLast7Days: number
  messagesLast30Days: number
  avgPerDay: number
  lastMessageTs: number | null
  firstSeenTs: number
  /** 'frequent' | 'occasional' | 'rare' | 'new' */
  contactTier: 'frequent' | 'occasional' | 'rare' | 'new'
}
```

**contactTier 规则**（无 LLM，纯规则）：
- `frequent`：过去 7 天平均每天 ≥1 条
- `occasional`：过去 7 天有消息但平均 <1/天
- `rare`：过去 30 天有消息但过去 7 天无
- `new`：过去 7 天内首次出现

**用途**：
- `frequent` sender → 自动加入观察名单
- `rare` sender 突然活跃 → 可能是重要事件

### 4.4 Conversation Burst（会话突发）

**定义**：某个 conversation 在短时间内消息量激增。

与 `im.burst` 的区别：
- `im.burst` 按 sender 聚合（一个人短时间发多条）
- `conversation.burst` 按 conversation 聚合（整个会话消息量激增，含多人）

```ts
interface ConversationBurstSignal {
  conversationId: string
  platform: string
  messageCount: number
  uniqueSenders: number
  durationMs: number
  ts: number
  /** 'group' | 'private' */
  conversationType: 'group' | 'private'
}
```

### 4.5 Response Latency（响应延迟）— 可选

**定义**：Orca 发出消息后，用户在下一次 IM 消息中回复的间隔。

```
Orca 发出（im.message.sent，direction='out'）
  ↓
用户在 T 秒后发送下一条（im.message.received，direction='in'，同一 conversation）
  ↓
Response Latency = T
```

**用途**：
- 延迟长 → 用户可能忙碌或不方便
- 延迟短 → 用户可能在线，重要消息可以通知

**实现注意**：
- 需配对 `im.message.sent` + `im.message.received`，同一 conversation，Orca 先发
- 响应延迟是**观察信号**，不是决策触发器
- 不适用于 group 消息（多人场景复杂）
- 不适用于 auto_reply 消息（规则明确，不观察延迟）

---

## 5. 严格禁止收集的数据

以下数据**绝对禁止**在 IM Observation 层收集、存储或推断，即使未来用户请求也需要先经架构评审：

### 5.1 禁止列表

| # | 禁止项 | 原因 |
|---|---|---|
| **PROHIB-OBS-01** | 消息内容文本 | 违反 L1 隐私；IM 内容不得进入任何存储（Episode/Memory/档案） |
| **PROHIB-OBS-02** | 消息内容摘要（LLM 生成）| 违反"无 LLM 介入观察"原则 |
| **PROHIB-OBS-03** | 联系人关系推断 | 例："Alice 是我女朋友"——这是 Memory，不是 Observation |
| **PROHIB-OBS-04** | 对话话题分类 | 例："这条是工作消息"——需要内容理解，超出行为信号范围 |
| **PROHIB-OBS-05** | 情绪推断 | 例："Alice 最近不开心"——禁止情感分析 |
| **PROHIB-OBS-06** | 附件内容描述 | 图片/语音/视频的内容分析 |
| **PROHIB-OBS-07** | 跨平台身份关联 | 例："微信的 Alice 和 QQ 的 Alice 是同一人"——禁止无显式确认的跨平台身份合并 |
| **PROHIB-OBS-08** | 自动联系人画像 | 例："每月第三个周三 Alice 会发周报"——这是 Memory，不来自 Observation |

### 5.2 边界说明

**允许**：存储 senderId、conversationId、timestamp、messageCount、durationMs 等**元数据**。

**禁止**：存储任何与**内容**相关的字段——text、attachments 的内容、URL 指向的内容。

**Example**：
```
✅ 允许：{ senderId: 'alice', messageCount: 5, durationMs: 300000 }
❌ 禁止：{ senderId: 'alice', lastMessage: '今晚来吃饭吗' }
```

---

## 6. 未来接口设计（IM Attention 的数据契约）

### 6.1 `CommunicationSignal`

供 Attention Engine 消费的结构（不实现，接口定义）：

```ts
/**
 * CommunicationSignal —— 通信观察信号的最小集合（供 IM Attention 使用）
 *
 * 设计原则：
 * - 只含行为信号，不含内容
 * - 来自 EpisodeEngine 聚合（IM-1.5 不实现）
 * - Attention Engine 只读，不写
 */
interface CommunicationSignal {
  /** 信号生成时间 */
  computedAt: number
  /** 数据覆盖范围 */
  windowDays: number

  /** senderId → 发送频率 */
  senderFrequencies: Record<string, SenderFrequencySignal>

  /** senderId → 活跃时段 */
  activeHours: Record<string, ActiveHoursSignal>

  /** 最近 im.burst Episode（用于 Attention 热点检测）*/
  recentBursts: ImBurstEpisode[]

  /** Orca 当前在线状态（从 WorldState 读取）*/
  orcaStatus: 'online' | 'away' | 'busy' | 'sleeping'

  /** 今日已通知次数（用于 throttle）*/
  todayNotifyCount: number
}

/**
 * AttentionContext —— Attention 规则评估时的上下文
 *
 * 由 IMObservationAdapter 填充，供 Attention 规则 predicate 使用。
 * 典型用法：
 *   AttentionRule predicate: ({ event, prevState, commSignal }) => ...
 */
interface IMAttentionContext {
  /** 当前处理的事件 */
  event: OrcaEvent
  /** 事件对应的 MessageEnvelope */
  envelope: MessageEnvelope
  /** 事件前的 WorldState */
  prevState: WorldState
  /** 通信观察信号（从 EpisodeEngine 聚合）*/
  commSignal: CommunicationSignal
}
```

### 6.2 `IMObservationAdapter`（未来扩展，不实现）

```ts
/**
 * IMObservationAdapter —— 通信观察信号提供者
 *
 * 职责：
 * - 从 EpisodeEngine 查询最近的 IM Episode
 * - 聚合生成 CommunicationSignal
 * - 提供给 Attention 规则使用
 *
 * 不做：
 * - 不生成 Memory
 * - 不调用 LLM
 * - 不修改 EventBus / WorldState
 * - 不做决策（只提供数据）
 */
interface IMObservationAdapter {
  /**
   * 获取指定 sender 的通信信号
   */
  getSenderSignal(senderId: string): Promise<SenderFrequencySignal | null>

  /**
   * 获取全局通信信号
   */
  getGlobalSignal(): Promise<CommunicationSignal>

  /**
   * 获取最近活跃的 sender 列表（供 Attention 热点检测）
   */
  getRecentActiveSenders(limit: number): Promise<string[]>
}
```

### 6.3 使用示例（未来 Attention 规则中的用法）

```ts
// 示例 Attention 规则（IM-2.0 伪代码，不实现）
const imFrequentContactRule: AttentionRule = {
  id: 'im-frequent-contact',
  priority: 'high',
  predicate({ event, commSignal }) {
    const envelope = event.data.envelope as MessageEnvelope
    const sender = envelope.senderId
    const signal = commSignal.senderFrequencies[sender]
    // 频繁联系人 + 当前不在睡觉 → 立即通知
    return signal?.contactTier === 'frequent'
      && commSignal.orcaStatus !== 'sleeping'
  },
  action: 'notify',
  reason({ event, commSignal }) {
    const envelope = event.data.envelope as MessageEnvelope
    const signal = commSignal.senderFrequencies[envelope.senderId]
    return `重要联系人 ${envelope.senderId} 发消息（${signal?.messagesLast7Days ?? 0} 条/7天）`
  }
}
```

---

## 7. 与现有 Episode 的关系

| Episode.kind | 来源 | TTL | 生成方式 | 供 Attention 使用 |
|---|---|---|---|---|
| `message.burst` | feishu | 7天 | EpisodeEngine | 需扩展支持 |
| `state.transition` | WorldState | 7天 | EpisodeEngine | 已支持（Phase 3）|
| `im.burst` | IM 消息 | 7天 | **待实现** | 需扩展 EpisodeEngine |
| `im.conversation.burst` | IM 消息 | 7天 | **待实现** | 需扩展 EpisodeEngine |

**EpisodeEngine 扩展规划**（IM-2.0+ 范围）：

```
EventBus.im.message.received
  │
  ▼
EpisodeEngine.handleEvent()
  ├─ 检测 im.burst（sender + 60min 窗口 + ≥3）
  ├─ 检测 im.conversation.burst（conversation + 30min + ≥6）
  └─ 写入 episodes.jsonl
  │
  ▼
IMObservationAdapter.getGlobalSignal()
  ├─ 聚合 senderFrequencies（查 episodes.jsonl）
  ├─ 聚合 activeHours（按 hour 分组 count）
  └─ 返回 CommunicationSignal
  │
  ▼
Attention 规则 predicate 消费
```

---

## 8. 架构风险检查

### 8.1 与现有 Runtime 的兼容性

| 检查项 | 状态 | 说明 |
|---|---|---|
| EventBus 唯一入口 | ✅ | IM 消息通过 EventBus，EpisodeEngine 只订阅 |
| EpisodeEngine 只读 EventBus | ✅ | 不修改 WorldState |
| 四不约束 | ✅ | IMObservationAdapter 只聚合，不决策 |
| Memory 边界 | ✅ | Observation 数据不晋升为 Memory |
| LLM 禁止 | ✅ | 纯规则聚合，无 LLM |
| 隐私 | ✅ | 不存储消息内容 |

### 8.2 潜在风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| EpisodeEngine 扩展后影响现有 feishu burst | 低 | im.burst 与 message.burst 完全独立，不共享状态 |
| activeHours 聚合查询性能 | 低 | 定期预计算（5min 一次），不每次实时计算 |
| senderId 暴露在 Episode 中 | 低 | senderId 已在 AttentionEngine 中使用，不新增泄露 |
| Episode 数据跨 Phase 累积 | 低 | TTL=7天自动清理，与 Memory 隔离 |

### 8.3 明确的设计边界

以下内容**不在 IM-1.5 设计范围内**，留待未来 Phase：

- IM-2.0：EpisodeEngine 扩展支持 im.burst
- IM-2.0：IMObservationAdapter 实现
- IM-2.0：Attention 规则接入 CommunicationSignal
- IM-3.0：真实协议接入（NapCatQQ / openclaw-weixin）
- IM-3.0：auto_reply 实现
- IM-3.0：suggest_reply 实现

---

## 9. IM-1.5 设计冻结确认

以下设计决策经本次 review 后**冻结**：

| # | 决策 | 理由 |
|---|---|---|
| D-IM-OBS-01 | Observation 数据基于 Episode，不进入 Memory | 7天TTL + 行为信号定位 |
| D-IM-OBS-02 | 通信信号接口为 `CommunicationSignal`，字段不含消息内容 | 隐私优先 |
| D-IM-OBS-03 | `im.burst` Episode metadata 只含 messageCount/durationMs，无 text | 内容禁止存储 |
| D-IM-OBS-04 | IMObservationAdapter 是数据提供层，不做决策 | 单一职责 |
| D-IM-OBS-05 | activeHours 按小时聚合，不按分钟 | 精度与隐私平衡 |
| D-IM-OBS-06 | senderId contactTier 完全基于频率，无 LLM 介入 | 规则优先 |

---

## 附录 A：Episode 字段扩展（IM-2.0 范围）

新增 `Episode.metadata` 扩展（向后兼容）：

```ts
// Episode.metadata 扩展（IM-2.0 实现，不修改现有 Episode 结构）
interface ImBurstMetadata {
  senderId: string
  conversationId: string
  platform: 'im.qq' | 'im.wechat'
  messageCount: number
  durationMs: number
  firstMessageTs: number
  lastMessageTs: number
}

interface ConversationBurstMetadata {
  conversationId: string
  platform: 'im.qq' | 'im.wechat'
  messageCount: number
  uniqueSenders: number
  durationMs: number
  isGroup: boolean
}
```

---

## 附录 B：设计文档关联

| 文档 | 关系 |
|---|---|
| `guide/orca-im-bridge.md` | IM Bridge 整体设计 |
| `guide/decisions.md` D-AGENT-16 | IM Bridge 架构决策 |
| `guide/orca-memory-design.md` | Episode + Memory 边界定义（D-AGENT-17）|
| `app-cordis/src/types/memory.ts` | Episode 接口定义（Phase 5.1）|
| `app-cordis/src/services/episodeEngine.ts` | EpisodeEngine 实现（Phase 5.1）|
