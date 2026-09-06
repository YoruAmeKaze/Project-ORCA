# Orca Memory Consumption 架构设计稿 v1.1（Phase 5.4 前置设计 + Phase 6 设计稿）

> **状态**：Phase 5.4 前置架构设计稿（v1.0，已收敛）+ Phase 6 设计稿（v1.1，本版本新增）。不实现代码。
> **日期**：2026-08-27
> **关联**：
> - `guide/orca-memory-design.md` v1.2（Memory 架构，D-AGENT-17/18）
> - `guide/decisions.md` D-AGENT-19（Memory Consumption Boundary）/ D-AGENT-20（Phase 6 Memory-aware CEO Context）
> - `guide/orca-cordis-migration-plan.md`（Orca Cordis Runtime 架构）

---

## 0. 设计目标

Phase 5.3 完成后的 Memory pipeline：

```
Episode → ReflectionEngine → MemoryCandidate → LongMemory
                                        ↓
                              CEO/context（R0 读 active facts）
```

**Phase 5.4 目标**：定义 Memory 如何合法地影响 Attention/Decision 层，**不破坏**既有的分层铁律。

---

## 1. 核心约束（不可违反）

### 1.1 分层铁律（Phase 4.B 已确立）

| 模块 | 铁律 |
|---|---|
| **AttentionEngine** | 纯函数：`evaluate() → AttentionItem[]`，无 IO，不读 Memory |
| **DecisionEngine** | 纯函数：`decide() → Decision`，无 IO，不读 Memory |
| **WorldState** | 当前态快照，不接受 Memory 写入 |
| **ActionExecutor** | 执行副作用，不读 Memory |
| **MemoryStore** | LongMemory 唯一 mutation authority；不推送；只被动接受查询 |
| **CEO / context** | R0 读 active LongMemoryFact（已达成的设计） |

**Phase 5.4 核心问题**：Memory 如何影响行为，同时**不破坏**上述铁律？

### 1.2 Memory 的本质约束

- MemoryStore 是**被动存储**（passive store）：不主动 emit 事件，不 push 数据
- Memory facts 不会自动产生 AttentionItems
- LongMemoryFact 是**知识状态**，不是**事件**

因此，Memory → Behavior 的合法路径必须是：

```
外部消费者（Adapter） → 主动查询 MemoryStore → 生成 AttentionItems → 事件流
```

不允许：

- MemoryStore 主动推送
- AttentionEngine 直接查询 MemoryStore
- DecisionEngine 直接查询 MemoryStore
- WorldState 接受 Memory 写入

---

## 2. MemoryAttentionAdapter（MAA）

### 2.1 定位

**唯一**获准将 Memory 接入 Attention/Decision 流水线的桥接组件。

```
MemoryStore ──(polling)──→ MemoryAttentionAdapter ──(AttentionItems)──→ EventBus ──→ AttentionEngine
                                                                                     ↓
                                                                              DecisionEngine
                                                                                     ↓
                                                                              ActionExecutor
```

MAA 属于 Orca Runtime 的 adapter 层（与 PC adapter、Calendar adapter 同级），负责：
- 定时轮询 MemoryStore
- 将满足条件的 LongMemoryFact 转化为 AttentionItems
- 将 AttentionItems 注入事件流

### 2.2 为什么需要 polling 而非 push

MemoryStore 是被动存储，不持有事件发射能力。如果让 MemoryStore 直接 emit，会引入 MemoryStore → EventBus 的耦合，违背 MemoryStore 作为"存储服务"的单一职责。

Polling 模式（外部 adapter 主动查询）保留了 MemoryStore 的被动性质，同时让 adapter 决定何时以及如何将 Memory facts 转化为事件。

### 2.3 查询契约

MAA 每次 tick 查询 MemoryStore：

```typescript
await memory.queryFacts({
  state: 'active',
  // 可选过滤
  type?: 'preference' | 'person' | 'habit' | 'fact' | 'behavioral_pattern' | 'state_pattern',
  subject?: string,        // 可选 prefix 匹配
})
```

**不传递**：confidence 阈值过滤（MemoryStore.queryFacts 目前不支持按 confidence 过滤，MVP 不扩展）。

**结果处理**：按 `updatedAt` 降序返回，取 Top-K（默认 5，配置键 `ORCA_MEMORY_ATTENTION_TOP_K`）。

### 2.4 AttentionItem 映射规则

从 LongMemoryFact 映射到 AttentionItem 的规则（MAA 内部逻辑）：

```typescript
function factToAttentionItem(fact: LongMemoryFact): AttentionItem {
  return {
    id: `memory:${fact.id}`,                    // 前缀区分来源
    source: 'memory',                          // 明确标注来源
    sourceEventIds: [fact.id],                 // 指向 LongMemoryFact.id
    type: mapFactTypeToAttentionType(fact.type),
    subject: fact.subject,
    content: fact.value,                        // Memory fact value 作为 content
    importance: factConfidenceToImportance(fact.confidence),
    reason: `[Memory] ${fact.type}: ${fact.subject} (confidence ${fact.confidence})`,
    ruleId: 'memory-attention-adapter',        // 固定 ruleId
    action: mapFactTypeToAttentionAction(fact.type),
    metadata: {
      memoryFactId: fact.id,
      memoryFactType: fact.type,
      memorySource: fact.source,                // 'user-explicit' | 'reflection'
      memoryConfidence: fact.confidence,
      memoryCreatedAt: fact.createdAt,
      memoryUpdatedAt: fact.updatedAt,
    },
  }
}
```

**type 映射**（Memory type → AttentionItem type）：

| Memory FactType | AttentionItem type |
|---|---|
| `preference` | `preference` |
| `person` | `person` |
| `habit` | `habit` |
| `fact` | `fact` |
| `behavioral_pattern` | `habit`（近似映射） |
| `state_pattern` | `fact`（近似映射） |

**action 映射**（Memory FactType → AttentionItem action）：

| Memory FactType | AttentionItem action |
|---|---|
| `preference` | `remember_only` |
| `person` | `notify_immediately` |
| `habit` | `remember_only` |
| `fact` | `notify_immediately` |
| `behavioral_pattern` | `remember_only` |
| `state_pattern` | `notify_immediately` |

### 2.5 去重与防震荡

**去重**：MAA 内部维护 `seenFactIds: Set<string>`（内存 Map）。同一 `fact.id` 在 `seenFactIds` 中存在时，不再生成 AttentionItem。

**防震荡**：如果 LongMemoryFact 的 `updatedAt` 未发生变化（与上次查询一致），不重新生成 AttentionItem。

**遗忘处理**：如果 LongMemoryFact 被 forget（hard-purge），`queryFacts` 不会返回，AttentionItem 不会续期，自然淡出。

### 2.6 调度契约

- **轮询间隔**：默认 60 秒（配置键 `ORCA_MEMORY_ATTENTION_POLL_INTERVAL_MS`）
- **不引入**实时推送；Memory 变化不会立即触发 AttentionItems
- **disposed 闸门**：plugin dispose 后 tick 中断

---

## 3. CEO / context 层 Memory 读取

### 3.1 现有设计（已达成的）

CEO（R0 context-building）在每次对话时查询 MemoryStore（`queryFacts`）并注入 prompt。已达成的设计，不被本稿修改。

### 3.2 Memory 作为 R0 的双通道

Phase 5.4 后，CEO 对 Memory 有两个读取通道：

| 通道 | 用途 | 读取方式 |
|---|---|---|
| **直接查询**（已达成的） | CEO 构建系统 prompt 时注入 fact summary | CEO 在 context-building 时调用 `memory.queryFacts` |
| **MAA 间接通道**（新增） | Memory facts 间接通过 AttentionItem → Decision → Action 影响行为 | MAA 生成 AttentionItem → EventBus → AttentionEngine |

两个通道互补，不冲突。

---

## 4. AttentionItem 的 memory 来源标注

### 4.1 metadata.memorySource

所有由 Memory fact 生成的 AttentionItem 必须在 `metadata` 中包含：

```typescript
interface MemoryAttentionMetadata {
  memoryFactId: string          // LongMemoryFact.id
  memoryFactType: FactType      // 'preference' | 'person' | 'habit' | 'fact' | 'behavioral_pattern' | 'state_pattern'
  memorySource: 'user-explicit' | 'reflection'   // MemoryStore 中的 source 字段
  memoryConfidence: number      // 原始 confidence
  memoryCreatedAt: number       // fact 创建时间（Unix ms）
  memoryUpdatedAt: number       // fact 最后更新时间（Unix ms）
}
```

### 4.2 用途

- DecisionEngine 可以读取 metadata 辅助决策（但不读 Memory）
- ActionExecutor 可以读取 metadata 辅助执行（但不读 Memory）
- 调试/审计时可以追溯 AttentionItem 的 Memory 来源

---

## 5. Memory conflict detection 边界

### 5.1 冲突来源

Memory conflict 发生在：
1. **MAA 生成的 AttentionItem** 与 **EventBus 原始事件生成的 AttentionItem** 同时存在
2. 两者 `type` + `subject` 相同但 `source` 不同

### 5.2 检测位置

**不在 DecisionEngine**（DecisionEngine 是纯函数，不读 Memory）。

**在 MAA 内部**：MAA 在生成 AttentionItem 前，检查 `seenFactIds` 是否已有相同 `(type, subject)` 的 entry：

```typescript
// MAA 内部去重逻辑
const existingIds = Array.from(seenFactIds).filter((id) => {
  const item = attentionItems.get(id)
  return item && item.subject === fact.subject && item.type === mappedType
})
if (existingIds.length > 0) {
  // 用 Memory 版本替换 EventBus 版本
  // （Memory fact 的 confidence 通常更高，或来自 user-explicit，更可信）
}
```

### 5.3 冲突处理策略

**Memory wins**：如果同一 `(type, subject)` 同时有 EventBus 来源和 Memory 来源的 AttentionItem，保留 Memory 来源的版本（丢弃 EventBus 版本）。

**理由**：
- Memory fact 通常有 confidence 评估，比单次事件更可靠
- user-explicit facts 代表用户直接确认的偏好
- reflection facts 经过多次 episode 验证

**不实现**：跨 Memory fact 的冲突解决（两条 Memory facts 同一 type+subject）。这是 MemoryStore upsert/supersede 语义已经处理的场景，不在 Phase 5.4 范围内。

---

## 6. 查询数量、token 限制、隐私限制

### 6.1 查询数量

- MAA 每次 tick 调用一次 `queryFacts`
- 轮询间隔 60 秒 → 每分钟最多 1 次 Memory 查询
- 不对 MemoryStore 产生显著压力

### 6.2 token 限制（面向 LLM prompt 注入）

当 CEO 读取 Memory facts 并注入 prompt 时：

| 字段 | 限制 |
|---|---|
| `value` | 截断至 60 字符 |
| `evidenceSummary` | 不注入 prompt（仅审计/调试可见） |
| 单条 fact 注入字符数 | ≤ 100 字符（value + type + subject） |
| Top-K | 默认 5 条（配置键 `ORCA_MEMORY_ATTENTION_TOP_K`） |
| prompt 中 Memory 总字符 | ≤ 500 字符（5 × 100） |

### 6.3 隐私限制

- MAA 查询时传入 `privacyLevel?: 'L1'`（MemoryStore 支持按 privacyLevel 过滤）
- `memory.remember` 写入时 `privacyLevel='L1'` 固定，不开放用户配置
- ForgetMarker 的 fingerprint 不泄露 subject 内容（SHA-256 + salt，不可逆）
- AuditEvent 不记录 Memory fact value（已由 D-AGENT-17 v1.1 约束）

---

## 7. 禁止访问 Memory 的模块

以下模块**严格禁止**直接调用 MemoryStore：

| 模块 | 禁止原因 |
|---|---|
| AttentionEngine | 纯函数约束；不得有 IO |
| DecisionEngine | 纯函数约束；不得有 IO |
| WorldState | 当前态快照；不接受 Memory 写入 |
| ActionExecutor | 执行层；不读 Memory 做决策 |
| NotifyHandler | 特定 Action handler；不读 Memory |
| DeferredScheduler | 调度层；不读 Memory |
| EpisodeEngine | 写入层；不读 LongMemory 做判断 |
| ReflectionEngine | 已有的 Memory 写入者；不读其他 Memory facts 影响自身逻辑 |
| FeishuChannel | 通道层；不读 Memory |
| InfoAgent | 信息获取框架；已有自己的 InfoRecordStore |

**例外**（唯一合法读取路径）：
- **CEO / agent 主循环**：调用 `memory.queryFacts` 构建 prompt
- **MemoryAttentionAdapter**：调用 `memory.queryFacts` 生成 AttentionItems

---

## 8. 配置键契约

Phase 5.4 引入的新配置键：

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `ORCA_MEMORY_ATTENTION_ENABLED` | `true` | MAA 总开关 |
| `ORCA_MEMORY_ATTENTION_POLL_INTERVAL_MS` | `60000` | 轮询间隔（毫秒） |
| `ORCA_MEMORY_ATTENTION_TOP_K` | `5` | 每次最多生成 AttentionItems 数 |
| `ORCA_MEMORY_ATTENTION_TYPES` | `preference,person,habit` | 生成 AttentionItem 的 Memory fact types（可覆盖） |

---

## 9. 与既有一致性

| 既有问题 | Phase 5.4 处理方式 |
|---|---|
| DecisionEngine 纯函数（不读 Memory） | 不修改；MAA 是唯一 Memory → AttentionItems 路径 |
| AttentionEngine 纯函数（不读 Memory） | 不修改；MAA 在 AttentionEngine 上游生成 AttentionItems |
| WorldState 不接受 Memory 写入 | 不修改；MAA 不写 WorldState |
| CEO 是 Memory 唯一消费者 | 保留；同时 MAA 间接扩展了 Memory 对行为的影响 |
| MemoryStore 是被动存储 | 保留；MAA 主动查询，不改变 MemoryStore 角色 |
| D-AGENT-09 InfoRecord 边界 | 不冲突；MemoryStore 与 InfoRecordStore 独立 |

---

## 10. Phase 5.4 MVP 范围

### 10.1 MVP 必须实现

- `MemoryAttentionAdapter`（轮询 + AttentionItem 映射）
- `seenFactIds` 去重
- `metadata.memorySource` 标注
- 配置键 `ORCA_MEMORY_ATTENTION_ENABLED` / `POLL_INTERVAL_MS` / `TOP_K`
- `factToAttentionItem` 映射逻辑

### 10.2 MVP 不实现

- 按 confidence 过滤 Memory facts（MemoryStore.queryFacts 暂不支持）
- 按 `updatedAt` 变化检测过滤（简化为 `seenFactIds` 去重）
- 跨 Memory fact 冲突解决（MemoryStore upsert/supersede 已处理）
- LLM-based memory summarization（MAA 输出的是结构化 AttentionItem，不是文本）
- Memory fact 实时推送（polling 是 MVP 简化）

---

## 11. 待确认问题（Q）

| # | 问题 | 建议 |
|---|---|---|
| Q1 | `behavioral_pattern` / `state_pattern` 映射到哪个 AttentionItem action？ | MVP 用 `remember_only`（保守）；后续按需调整 |
| Q2 | MAA 如果发现 `source='user-explicit'` 的 fact，是否优先生成 AttentionItem？ | MVP 不区分；所有 active facts 平等轮询 |
| Q3 | Episode 生成 Burst 时，如果同一 sender 也有 Memory fact，冲突处理策略是否"Memory wins"？ | 是；Q5.3 已定义 |
| Q4 | MAA tick 间隔 60s 是否合适？ | MVP 默认 60s；配置键开放可调 |
| Q5 | MemoryAttentionAdapter 是否需要自己的 Cordis plugin？ | MVP 是独立 plugin（与 PC adapter / Calendar adapter 同级） |

---

## 12. Phase 6：Memory-aware CEO Context（设计稿 v1.0）

> **状态**：设计稿，不实现代码。
> **日期**：2026-08-27
> **关联**：D-AGENT-17（MemoryStore）/ D-AGENT-18（Contract Hardening）/ D-AGENT-19（Consumption Boundary）/ D-AGENT-20（Phase 6 Memory-aware CEO Context，本文档新立）

### 12.1 背景与问题

Phase 5.0~5.4 完成后，Orca 已有：

```
MemoryStore（LongMemory source of truth）
EpisodeStore（短期对话记忆）
ReflectionEngine（Episode → Candidate）
MemoryAttentionAdapter（Memory → AttentionItems → EventBus）
memory_changed event bridge（Phase 5.4.B）
```

**遗留问题**：CEO（R0 / agent 主循环）在构建 context 时，如何系统性地整合 Memory、WorldState、InfoRecord 和当前用户输入，而不只是"在 prompt 里塞一些 facts"？

**当前 CEO context 构建状态（推测）**：

```
CEO context = [persona] + [当前用户输入] + [WorldState snapshot] + [InfoRecord 最近 N 条]
```

**Phase 6 目标**：在上述组合中正式纳入 LongMemoryFact，形成可配置的、结构化的 Memory-aware context assembly，同时保持：
- 不破坏 AttentionEngine / DecisionEngine 纯函数约束（D-AGENT-19 §19-01）
- 不引入向量数据库或 embedding
- 不修改 MemoryStore / EpisodeStore 架构
- Local-first，不依赖远程服务

---

### 12.2 核心设计：CEO Context Assembly

#### 12.2.1 四元组 context 模型

CEO 在每次响应前构建 context，context 由四个正交维度组成：

```
CEO Context = {
  input:      当前用户输入（原始文本）
  worldState: WorldState snapshot（当前设备/用户/时间态）
  info:       InfoRecord 最新条目（近期限时上下文）
  memory:     LongMemoryFact 相关子集（长期知识）
}
```

**关键约束**：四个维度**正交**，各自独立查询、独立注入、独立更新频率。CEO 负责组合，不存在单一的"memory context"抽象侵入其他层。

#### 12.2.2 注入层次

```
Layer 0（R0）：persona（静态，不变）
Layer 1（R1）：worldState snapshot（每次构建）
Layer 2（R2）：infoRecords（最近 3 条，按时间倒序）
Layer 3（R3）：memoryFacts（按策略选取，见 §12.3）
Layer 4（R4）：当前用户输入
```

**R3 是 Phase 6 的核心新增**。R1/R2 在 Phase 3/4 已存在，R4 是基础输入。

#### 12.2.3 Memory 查询与 context 注入的分离

**原则**：CEO 向 MemoryStore 发起查询，得到 `LongMemoryFact[]`，然后自行决定如何格式化注入 prompt。

这与 MAA（MemoryAttentionAdapter）的路径**完全独立**：

| 通道 | 起点 | 终点 | 机制 |
|---|---|---|---|
| MAA 路径 | MAA | EventBus → AttentionEngine → DecisionEngine | 异步，事件驱动，AttentionItem |
| CEO 路径 | CEO（R0） | prompt context 构建 | 同步，按需查询，LongMemoryFact 原文 |

两个通道互不干扰。MAA 不改变 CEO 的 memory 查询行为；CEO 查询 memory 也不经过 MAA。

---

### 12.3 Memory Retrieval 策略

#### 12.3.1 查询触发条件（何时查询 Memory）

Memory 查询是**有成本的**，不是每次都查。以下是触发条件：

**主动查询（每次都查）**：
- 用户明确提及已知 subject（"上次你说的那个 X"）
- 用户请求跟自身偏好/习惯相关的内容（"我记得我更喜欢..."）
- 系统 prompt 构建阶段（R3 注入）

**条件查询（有条件地查）**：
- WorldState 发生显著变化（如用户从离线变为在线）
- 当前 Episode 的话题发生转换（EpisodeEngine 报告 topic shift）
- InfoRecord 中出现与已知 Memory subject 匹配的新条目

**不查询（主动跳过）**：
- 用户输入为纯任务指令（"帮我查一下天气"），且与个人偏好无关
- 当前 Episode 时长 < 2 条消息（冷启动阶段）
- 已有的 Memory facts 在极短时间内（< 5 分钟）刚被查询过（避免重复）

#### 12.3.2 匹配策略

Memory 查询使用**确定性规则**，不使用 embedding 或语义相似度：

```
queryFacts({
  state: 'active',
  // 以下条件可组合
  type?: FactType,       // 可选：精确匹配 fact type
  subject?: string,      // 可选：精确匹配 subject（大小写不敏感）
  confidence?: number,   // 可选：最低 confidence 阈值
})
```

**匹配优先级**：

1. **subject 精确匹配**（最高优先级）：用户输入中提取 entity/service/product name，精确匹配 `subject` 字段
2. **type 过滤**：如果用户输入有明确的类型意图（如"我的习惯"→ type=`habit`），按 type 过滤
3. **全局查询**（无线索时）：查询所有 active facts，按 `updatedAt` 降序

#### 12.3.3 排序与 Top-K 限制

查询结果排序：

```
primary:   confidence 降序
secondary: updatedAt 降序（相同 confidence 时）
```

**Top-K 限制**：

| Context Layer | Top-K | 字符限制 |
|---|---|---|
| R3 memory facts 注入 | 10 | 每条 ≤ 80 字符，总计 ≤ 500 字符 |

这是**硬限制**。超出时按 confidence 顺序截断，不做加权。

#### 12.3.4 Token 预算

Memory 注入 prompt 的 token 预算（LLM 输入 token 限制内的配额）：

| 槽位 | 保留 token | 用途 |
|---|---|---|
| persona | 300 | R0 静态 |
| worldState | 150 | R1 snapshot |
| infoRecords | 200 | R2 最近 3 条 |
| **memoryFacts（R3）** | **500** | **Phase 6 新增** |
| 当前输入 | 动态 | R4 + 富余空间 |

**总计约 1150 token** 固定开销，富余 token 全归当前输入。

超出预算时的降级策略：

1. 超出 memoryFacts → 按 confidence 截断至 500 字符
2. 仍超出 → 跳过 memoryFacts 注入（不报错，不影响生成）
3. 降级后记录 `audit` 事件（记录本次 budget miss）

---

### 12.4 Memory → CEO 接口契约

#### 12.4.1 CEO 使用的 MemoryStore 查询 API

```ts
interface MemoryRetrievalQuery {
  /** 可选：精确匹配 type */
  type?: FactType
  /** 可选：精确匹配 subject（大小写不敏感） */
  subject?: string
  /** 可选：最低 confidence 阈值 */
  minConfidence?: number
  /** 可选：返回上限，默认 10 */
  limit?: number
  /** 可选：排序字段，默认 ['confidence', 'updatedAt'] */
  sortBy?: ('confidence' | 'updatedAt' | 'createdAt')[]
}

/**
 * CEO（R0）在 context 构建时调用的查询接口。
 * 返回满足条件的 LongMemoryFact，按 confidence + updatedAt 降序。
 */
async queryFacts(query: MemoryRetrievalQuery): Promise<LongMemoryFact[]>
```

**注意**：`queryFacts` 是 MemoryStore 的已有方法，Phase 6 不新增 API，只定义 **CEO 调用模式**。

#### 12.4.2 Memory Fact 格式化（注入 prompt）

LongMemoryFact 注入 prompt 时，CEO 将其格式化为**结构化文本行**：

```
[Memory:{type}] {subject}: {value} (confidence {confidence})
```

示例：

```
[Memory:preference] alice: coffee, high quality (confidence 0.95)
[Memory:habit] bob: late night coding, 2-3x/week (confidence 0.88)
[Memory:behavioral_pattern] carol: high_burst_frequency, project deadline mode (confidence 0.82)
```

**不注入的字段**：id、evidenceIds、representativeEvidenceIds、createdBy、privacyLevel（L1 可见但不在 prompt 中暴露）。

#### 12.4.3 Memory 与 InfoRecord 的边界

| 维度 | InfoRecord | LongMemoryFact |
|---|---|---|
| 生命周期 | 临时（TTL 内） | 长期（无过期） |
| 触发方式 | 用户操作自动记录 | ReflectionEngine promotion 或 user-explicit |
| 查询方式 | `queryInfos({ recent: N })` | `queryFacts({ type, subject })` |
| CEO 注入位置 | R2（infoRecords） | R3（memoryFacts） |
| 遗忘机制 | TTL 自然过期 | forgetFact（原子 + ForgetMarker） |

两者**不合并**，在 context 中独立共存。InfoRecord 是"最近发生了什么"，Memory 是"关于用户我知道什么"。

---

### 12.5 设计讨论

#### 12.5.1 是否需要 Memory Summary 层？

**结论：当前 MVP 不需要**。

理由：
- LongMemoryFact 已经是 summarization 的产物（Episode → ReflectionEngine → Candidate → MemoryStore，每步都有信息压缩）
- `value` 字段已经是压缩后的字符串（截断 60 字符）
- 当前 Memory facts 数量有限（< 100 条），全量注入 token 预算内可覆盖

**未来扩展**（Phase 6+ 后续）：
- 当 Memory facts 超过 50 条活跃记录时，可考虑按 type 分桶，每桶取 Top-3
- 不做 abstractive summarization（不引入 LLM 做摘要）
- 可做 extractive summary：将同一 subject 的多条 facts 合并为一条

#### 12.5.2 是否需要短期 Context Cache？

**结论：不需要独立缓存组件**。

理由：
- MemoryStore 本身已有 in-memory 索引（`factsById` Map）
- CEO 查询结果可以放在 WorldState 中作为 `worldState.memoryCache` 字段
- EpisodeStore 已经有 session 级别的 episode 数据

**实现方案**：在 WorldState 中增加可选字段：

```ts
interface WorldState {
  // ... 现有字段 ...
  memoryCache?: {
    /** 最近一次 memory 查询时间 */
    lastRetrievedAt: number
    /** 最近一次 memory 查询结果（已格式化的字符串） */
    lastRetrievedFacts: string[]
    /** 上一次 memory 查询时使用的 query 参数 */
    lastQueryHash: string
  }
}
```

**更新策略**：
- MemoryCache TTL = 5 分钟（可配置 `ORCA_MEMORY_CACHE_TTL_MS`）
- 任何 memory mutation（created/updated/forgotten）**立即失效** MemoryCache（MAA 发出 `memory_changed` 事件，CEO 订阅并清除缓存）
- CEO 下次 context 构建时，若 cache 有效则直接使用，无需再查 MemoryStore

#### 12.5.3 是否需要 Conversation Episode 关联？

**结论：不需要 Memory 主动关联 Episode**。

理由：
- MemoryStore 中每个 `LongMemoryFact` 已有 `representativeEvidenceIds`，指向原始 evidence
- evidence 可以是 Episode 中的消息 ID（如果 EpisodeStore 支持 ID 引用）
- CEO 在 context 构建时，Episode 已经作为 `infoRecords` 或独立 session 数据存在

**可行方案**（不强制实现）：
- `EpisodeStore` 在 Episode 关闭时，输出一个 `{ episodeId, topic, summary, involvedSubjects }` 结构
- CEO 查询 Memory 时，可以传入 `involvedSubjects` 列表做 subject 过滤
- MemoryStore 不存储 Episode 引用，只通过 evidenceIds 间接关联

**不做的理由**：过早引入跨 Store 引用会增加复杂度，当前 Memory facts 数量和 Episode 流量都不需要这个关联层。

---

### 12.6 架构影响

#### 12.6.1 分层影响

Phase 6 在现有分层中的位置：

```
当前分层（Phase 5.4）：
  EventBus → WorldState → AttentionEngine → DecisionEngine → ActionExecutor → ActionHandler

Phase 6 新增：
  MemoryStore ─────────────────────────────────────────────────────────────────────┐
                                           │                                      │
                                    CEO（R0）◄────────────────────────────────────┘
                                    │
                                    └── queryFacts() → LongMemoryFact[] → R3 注入
```

**关键**：CEO 查询 Memory 发生在 **AttentionEngine 之前**，是 R0 的独立行为。AttentionEngine 不感知这个查询。

#### 12.6.2 与 MAA 的关系

| 维度 | MAA | CEO Memory 查询 |
|---|---|---|
| 方向 | Memory → AttentionItem → EventBus | Memory → CEO prompt |
| 频率 | 轮询 60s + 事件驱动 | 按需（每次 context 构建） |
| 输出 | AttentionItem | LongMemoryFact[] |
| 消费者 | AttentionEngine → DecisionEngine | LLM（通过 prompt） |
| 触发者 | MAA（自动） | CEO（主动） |
| 配置 | `ORCA_MEMORY_ATTENTION_*` | `ORCA_MEMORY_CONTEXT_*` |

**互补，不重叠**：MAA 让 Memory 自动影响 Attention/Decision；CEO Memory 查询让人工智能在生成回复时知道用户背景。

#### 12.6.3 保留的约束（与 D-AGENT-19 一致）

- AttentionEngine **不读 MemoryStore**
- DecisionEngine **不读 MemoryStore**
- WorldState **不接受 Memory 写入**（MemoryCache 是 WorldState 的 optional 字段，不是 Memory 主动写入）
- MemoryStore **不知道** 谁在查询它（CEO 调用 `queryFacts`，MemoryStore 只返回数据）

---

### 12.7 实现优先级

Phase 6 建议分两个子阶段：

**Phase 6.A（MVP）**：
1. CEO 在 context 构建时调用 `queryFacts({ state: 'active', limit: 10 })`
2. 将结果格式化为 R3 注入 prompt
3. 配置键：`ORCA_MEMORY_CONTEXT_ENABLED`（默认 true）/ `ORCA_MEMORY_CONTEXT_TOP_K`（默认 10）
4. 字符截断逻辑（每条 ≤ 80，总计 ≤ 500）
5. 不实现 MemoryCache（Phase 6.B）

**Phase 6.B（完整版）**：
1. 实现 MemoryCache（TTL 5 分钟，`memory_changed` 事件失效）
2. subject 智能提取（从用户输入中抽取 entity → 做 subject 匹配查询）
3. type 过滤（根据用户意图关键词映射到 FactType）
4. audit budget miss 事件

---

### 12.8 配置键（Phase 6.A）

| 键 | 默认值 | 说明 |
|---|---|---|
| `ORCA_MEMORY_CONTEXT_ENABLED` | `true` | 是否在 context 中注入 Memory facts |
| `ORCA_MEMORY_CONTEXT_TOP_K` | `10` | R3 注入的最大 facts 数 |
| `ORCA_MEMORY_CONTEXT_MAX_CHARS` | `500` | R3 总字符数硬限制 |
| `ORCA_MEMORY_CONTEXT_PER_FACT_CHARS` | `80` | 单条 fact 注入字符上限 |
| `ORCA_MEMORY_CACHE_TTL_MS` | `300000` | MemoryCache TTL（Phase 6.B） |

---

### 12.9 与现有决议的边界

- **不修改** D-AGENT-17（MemoryStore mutation authority）
- **不修改** D-AGENT-18（Memory contract hardening）
- **不修改** D-AGENT-19（Memory Consumption Boundary；MAA 路径不变；CEO 查询路径是 D-AGENT-19 §19-04 的直接实现）
- **不修改** DecisionEngine / AttentionEngine 纯函数约束
- **不修改** WorldState 接口
- **不引入** vector DB / embedding / SQLite
- **不引入** Memory → WorldState 的主动投影（MemoryCache 是 WorldState 的 optional 字段，CEO 管理）

---

## 13. 待确认问题（Phase 6）

| # | 问题 | 建议 |
|---|---|---|
| Q6 | CEO 查询 Memory 时，如果 user-explicit fact 和 reflection fact 同时存在，是否优先取 user-explicit？ | 是；`source='user-explicit'` 优先于 `source='reflection'` |
| Q7 | MemoryCache TTL 5 分钟是否合适？ | MVP 默认 5 分钟；可配置 |
| Q8 | CEO 注入 Memory facts 时，如果用户当前输入与某条 Memory fact 直接矛盾，CEO 是否有权忽略该 fact？ | 是；Memory 是参考，不是绝对约束；最终决策属于 LLM/CEO |
| Q9 | EpisodeStore 关闭时是否输出 `involvedSubjects` 以便后续 Memory 关联查询？ | 可选；Phase 6.B 再定 |
| Q10 | 如果 MemoryCache 命中，是否还需要调用 `queryFacts`？ | 不需要；直接用 cache 中已序列化的字符串 |
