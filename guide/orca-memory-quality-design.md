# Orca Memory Quality Layer 架构设计稿 v1.0（Phase 6.C 设计稿）

> **状态**：Phase 6.C 设计稿，不实现代码。
> **日期**：2026-09-06
> **关联**：
> - `guide/orca-memory-design.md` v1.2（D-AGENT-17/18，Memory 架构）
> - `guide/decisions.md` D-AGENT-17（MemoryStore mutation authority）
> - `guide/decisions.md` D-AGENT-18（Memory contract hardening）
> - `guide/decisions.md` D-AGENT-19（Memory Consumption Boundary）
> - `guide/decisions.md` D-AGENT-20（Phase 6 Memory-aware CEO Context）
> - `guide/orca-memory-consumption-design.md`（Phase 5.4/6 架构设计稿）

---

## 0. 设计背景与问题

Phase 6.A（ContextAssembler）+ Phase 6.B（CEO Context Integration）完成后，Memory 已正式进入 CEO prompt。随之产生了四个新问题：

### 0.1 现有 Memory pipeline 已覆盖

```
写入：memory.remember → MemoryStore.upsertFact
     Episode → ReflectionEngine → Candidate → promote → MemoryStore
遗忘：memory.forget → forgetFact + ForgetMarker
生命周期：MemoryStore（superseded / merged / forgotten）
消费：CEO（R0）通过 ContextAssembler.assemble() 注入 prompt
      MAA 通过 polling → AttentionItem → EventBus 影响行为
```

### 0.2 Phase 6.C 要解决的四个问题

| # | 问题 | 当前状态 |
|---|---|---|
| Q1 | **Memory Conflict Resolution**：user-explicit 与 reflection 冲突；同 subject/type 新旧事实冲突；supersede/merge 策略是否足够 |
| Q2 | **Memory Retrieval Scoring Interface**：当前 `confidence` 排序是否足够；scoring interface 如何设计；Phase 6.B 不实现 scoring |
| Q3 | **Memory Usage Tracking**：CEO 使用了哪些 memory facts；是否需要 MemoryUsageEvent；tracking 数据用于何处 |
| Q4 | **Memory Evaluation Strategy**：如何测试 memory 没有污染 CEO；如何测试 forget 后不复活；如何测试错误 memory 修正 |

---

## 1. Memory Conflict Resolution（D-AGENT-21 §21-01）

### 1.1 冲突来源分类

Memory conflict 发生在三个层级：

```
L1：写入时冲突（Mutation-time conflict）
     - 同一 (subject, type) 的新 fact 写入时
     - 处理方式：upsert → 自然 supersede（已有设计）

L2：来源冲突（Source conflict）
     - 同一 (subject, type) 同时存在 user-explicit 和 reflection 两种 source
     - 处理方式：user-explicit 优先（设计决定）

L3：语义冲突（Semantic conflict）
     - 两条 facts (subject, type 相同，source 不同) value 内容矛盾
     - 检测方式：value 语义分析（不使用 embedding，使用关键词/规则）
     - 处理方式：标记为冲突，由 CEO 决定保留哪条
```

### 1.2 L1 Mutation-time Conflict（已有设计，保持不变）

`MemoryStore.upsertFact` 对同一 `(subject, type)` 的 fact 执行自然 supersede：

```
写入新 fact（相同 subject, type）
  → 旧 fact state → 'superseded'
  → 旧 fact.supersededBy → 新 fact.id
  → 新 fact.representativeEvidenceIds ← 合并新旧 evidence
```

**结论：L1 冲突不需要新设计，保持现有 supersede 语义。**

### 1.3 L2 Source Conflict（新增设计）

**冲突定义**：同一 `(subject, type)` 存在两条 active facts，source 分别为 `user-explicit` 和 `reflection`。

**优先级规则**：

```
user-explicit > reflection
```

**理由**：
- `user-explicit` 代表用户直接确认的事实（高可信度）
- `reflection` 是从多次 episode 推断出来的（有信息损失）
- CEO context 注入时，同一 (subject, type) 只能出现一条 fact

**实现位置**：`ContextAssembler.queryMemory()` 查询结果的后处理（不在 MemoryStore 层）。

```typescript
// ContextAssembler.queryMemory() 后处理
function resolveSourceConflict(facts: LongMemoryFact[]): LongMemoryFact[] {
  // 按 (subject, type) 分组
  const groups = groupBy(facts, (f) => `${f.type}:${f.subject}`)

  // 每组内：user-explicit 优先
  return Object.values(groups).map((group) => {
    const userExplicit = group.find((f) => f.source === 'user-explicit')
    if (userExplicit) return userExplicit
    // 同 type+subject 没有 user-explicit 时，取 confidence 最高的 reflection
    return group.sort((a, b) => b.confidence - a.confidence)[0]
  })
}
```

**触发时机**：每次 `ContextAssembler.assemble()` 调用时，在 `queryMemory()` 之后、格式化之前执行。

**对 MAA 的影响**：MAA 查询不经过此逻辑（MAA 只生成 AttentionItem，不直接注入 prompt）。

### 1.4 L3 Semantic Conflict（标记机制，不做自动裁决）

**冲突定义**：两条 facts（不同 source 或相同 source），(subject, type) 相同，但 `value` 语义矛盾。

**检测方式**（不使用 embedding）：

```typescript
interface SemanticConflictRule {
  type: FactType
  /** 触发矛盾的关键词（大小写不敏感） */
  positiveKeywords: string[]
  /** 触发否定的关键词 */
  negativeKeywords: string[]
}

const SEMANTIC_RULES: SemanticConflictRule[] = [
  {
    type: 'preference',
    positiveKeywords: ['喜欢', '爱', 'prefer', 'want'],
    negativeKeywords: ['不喜欢', '讨厌', 'dislike', 'hate', '不要', '别'],
  },
  {
    type: 'habit',
    positiveKeywords: ['经常', '总是', 'usually', 'always', 'normally'],
    negativeKeywords: ['从不', '从来不', '从不', 'never', '不'],
  },
  // ... 其他 type
]

function detectSemanticConflict(facts: LongMemoryFact[]): SemanticConflict[] {
  // 按 (type, subject) 分组
  // 每组内检测 value 是否包含 positiveKeywords 和 negativeKeywords 同时存在
  // 返回冲突列表：{ type, subject, conflictingFacts }
}
```

**输出**：返回冲突列表，每个冲突包含 `{ type, subject, facts[] }`。

**处理策略（不做自动裁决）**：

```
检测到 L3 冲突
  → 在 ContextAssemblyResult 中新增字段：conflicts: MemoryConflict[]
  → memoryFacts 中**两条冲突 facts 均保留**，同时标记：
    [Memory:preference] alice: coffee (confidence 0.95) ⚠️
    [Memory:preference] alice: NOT coffee (confidence 0.72) ⚠️
  → CEO prompt 中附加：⚠️ 注意：以下事实存在矛盾，请根据上下文判断
  → 最终裁决权交给 LLM / CEO
```

**不对 MAA 输出冲突标记**（MAA 只生成 AttentionItem，不做语义分析）。

### 1.5 Conflict Resolution 配置键

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `ORCA_MEMORY_CONFLICT_RESOLVE_SOURCE` | `user-explicit-first` | L2 冲突解决策略 |
| `ORCA_MEMORY_CONFLICT_DETECT_SEMANTIC` | `false` | 是否启用 L3 语义冲突检测（默认关闭） |
| `ORCA_MEMORY_CONFLICT_MARK_IN_PROMPT` | `true` | 冲突 facts 是否在 prompt 中标记 ⚠️ |

---

## 2. Memory Retrieval Scoring Interface（D-AGENT-21 §21-02）

### 2.1 当前排序现状

Phase 6.A 实现的排序：

```
primary:   confidence 降序
secondary: updatedAt 降序
```

这是**固定权重**排序，不支持自定义 scoring function。

### 2.2 Scoring Interface 设计

Phase 6.B 预留了 `scoringFunction?: (fact: LongMemoryFact) => number` 接口，但未实现。Phase 6.C 正式定义这个接口。

```typescript
/**
 * Memory retrieval scoring function。
 * 输入：一条 LongMemoryFact
 * 输出：number（越高越优先）
 *
 * 设计约束：
 * - 必须是deterministic（相同输入 → 相同输出）
 * - 不使用 embedding 或语义相似度计算
 * - 可以访问 fact 的任何字段
 */
type ScoringFunction = (fact: LongMemoryFact) => number

/**
 * 预设 scoring functions（内置，可直接使用）
 */

/** 预设1：纯 confidence（当前行为） */
function scoreByConfidence(fact: LongMemoryFact): number {
  return fact.confidence
}

/** 预设2：confidence + freshness 加权 */
function scoreByConfidenceAndFreshness(fact: LongMemoryFact): number {
  const confidenceWeight = 0.7
  const freshnessWeight = 0.3
  const now = Date.now()
  const ageHours = (now - fact.updatedAt) / (1000 * 60 * 60)
  const freshnessScore = Math.max(0, 1 - ageHours / (24 * 30)) // 30天内线性衰减
  return confidenceWeight * fact.confidence + freshnessWeight * freshnessScore
}

/** 预设3：user-explicit 优先 + confidence */
function scoreBySourceAndConfidence(fact: LongMemoryFact): number {
  const sourceBonus = fact.source === 'user-explicit' ? 0.2 : 0
  return Math.min(1, fact.confidence + sourceBonus)
}

/**
 * ContextAssemblerConfig.scoringFunction 字段类型
 */
interface ScoringConfig {
  /** 使用预设之一 */
  preset: 'confidence' | 'confidence-freshness' | 'source-confidence'
  /** 自定义 scoring function（JSON-serializable 函数体字符串） */
  customFormula?: string
}
```

### 2.3 Scoring Interface 与 ContextAssembler 的集成

```typescript
// ContextAssembler.queryMemory() 内
function applyScoring(facts: LongMemoryFact[], config: ScoringConfig): LongMemoryFact[] {
  const scorer = getScorer(config)  // 根据 preset 返回对应函数
  return [...facts].sort((a, b) => scorer(b) - scorer(a)) // 降序
}
```

**对 CEO prompt 的影响**：scoring 改变只影响 facts 的选取顺序，不改变格式化格式。

### 2.4 Scoring 配置键

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `ORCA_MEMORY_SCORING_PRESET` | `confidence` | scoring 预设 |
| `ORCA_MEMORY_SCORING_CUSTOM` | `` | 自定义 scoring formula（可选） |

---

## 3. Memory Usage Tracking（D-AGENT-21 §21-03）

### 3.1 追踪目的

**不是为了优化而追踪**，而是为了：
1. **可审计性**：CEO 在哪些轮次使用了哪些 memory facts
2. **冲突调试**：哪些 facts 被频繁使用但同时存在冲突
3. **遗忘效果验证**：被 forget 的 fact 是否在后续 CEO prompt 中消失

### 3.2 MemoryUsageEvent 设计

**不引入新事件类型**。MemoryStore 已有 `memory_changed` 事件族（Phase 5.4.B），usage tracking 复用现有机制，在 `ContextAssembler.assemble()` 内部记录。

```typescript
/**
 * MemoryUsageRecord：每次 assemble() 调用时生成的就地记录
 * 不 emit 到 EventBus，不持久化，仅用于当前 assembly cycle
 */
interface MemoryUsageRecord {
  /** assembly 时间 */
  at: number
  /** 用户输入长度（不记录内容） */
  inputLength: number
  /** 查询参数（subject/type/minConfidence 等） */
  query: MemoryRetrievalQuery
  /** 实际返回的 facts 数量 */
  returnedCount: number
  /** 返回的 fact ids */
  returnedFactIds: string[]
  /** 其中被 L2 冲突解决过滤掉的 fact ids */
  conflictFilteredIds: string[]
  /** L3 语义冲突数量 */
  semanticConflictCount: number
  /** scoring preset */
  scoringPreset: string
  /** total chars used */
  charsUsed: number
  /** budget hit */
  budgetHit: boolean
}

/**
 * MemoryUsageStore：in-memory ring buffer
 * 只记录最近 N 次 assembly（默认 100 次）
 * 不持久化，重启后清空
 */
interface MemoryUsageStore {
  records: MemoryUsageRecord[]
  maxRecords: number

  /** 追加一条 record */
  record(r: MemoryUsageRecord): void

  /** 查询某 fact 是否在某次 assembly 中被使用 */
  wasUsedIn(factId: string, since: number): boolean

  /** 获取某 fact 被使用的次数（用于评估重要性） */
  usageCount(factId: string, since: number): number
}
```

### 3.3 MemoryUsageRecord 与 memory_changed 的关系

```
memory_changed 事件（Phase 5.4.B）
  → MemoryStore emit（mutation 时）
  → MAA / 其他订阅者接收

MemoryUsageRecord
  → ContextAssembler 内部生成（assembly 时）
  → 记录在 in-memory ring buffer
  → 不 emit，不通知其他组件
```

两者独立：mutation 事件 ≠ usage 事件。

### 3.4 MemoryUsageRecord 的用途

**用途1：Audit Log（供开发者/调试）**

```typescript
// ContextAssembler 组装完成后，可选打印：
ctx.logger.debug('[context-assembler] usage: %d facts, chars=%d, budgetHit=%s',
  record.returnedCount, record.charsUsed, record.budgetHit)
```

**用途2：冲突调试**

```typescript
// 如果 L3 冲突检测开启，每次 assembly 后可检查：
if (record.semanticConflictCount > 0) {
  ctx.logger.info('[context-assembler] semantic conflict detected: %d', record.semanticConflictCount)
}
```

**用途3：遗忘效果验证（测试用）**

```typescript
// 在 smoke 测试中：
await memoryStore.forgetFact(factId, 'test-fingerprint')
// 下一次 assemble()：
const result = await assembler.assemble(input, worldState)
// 验证：
assert(!result.memoryFacts.find((f) => f.id === factId), 'forgotten fact should not appear')
assert(!usageStore.wasUsedIn(factId, since), 'forgotten fact should not be in usage records')
```

### 3.5 MemoryUsageRecord 不做的事

- **不用于自动 scoring**（scoring 是 deterministic 规则，不依赖 usage frequency）
- **不持久化到磁盘**（ring buffer 在内存，重启清空是预期行为）
- **不发给 LLM**（仅内部使用，不注入 prompt）
- **不触发 MemoryCache 失效**（这是 memory_changed 的职责）

### 3.6 MemoryUsage 配置键

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `ORCA_MEMORY_USAGE_TRACK` | `true` | 是否启用 usage tracking |
| `ORCA_MEMORY_USAGE_MAX_RECORDS` | `100` | ring buffer 最大记录数 |

---

## 4. Memory Evaluation Strategy（D-AGENT-21 §21-04）

### 4.1 评估目标

确保 Phase 6.C 的四个特性：
1. Memory 没有污染 CEO（正确 facts 出现在 prompt，不相关 facts 不出现）
2. Forget 后 facts 不会复活（forget 是永久的）
3. 错误 memory 可以被修正（user-explicit 覆盖 reflection）
4. L2/L3 冲突处理正确（L2 source 优先，L3 标记而非自动裁决）

### 4.2 测试场景定义

#### 场景 E1：Memory 正确进入 prompt

```
前置条件：
  - MemoryStore 有 3 条 active facts（alice:coffee, bob:gym, carol:reading）
  - ContextAssembler enabled

操作：
  - 调用 assemble('hello', worldState)

验证：
  - memoryFacts.length === 3
  - memoryFacts 包含所有 3 条 facts
  - formatted string 包含 [Memory:...] 格式
  - 排序符合 scoring preset
```

#### 场景 E2：无关 facts 不进入 prompt（Top-K 限制）

```
前置条件：
  - MemoryStore 有 15 条 active facts
  - contextAssembler.config.memoryTopK = 10

操作：
  - 调用 assemble('hello', worldState)

验证：
  - memoryFacts.length === 10（Top-K 限制）
  - totalAvailable === 15
  - 按 scoring 排序取前 10
```

#### 场景 E3：Forget 后 fact 不复活

```
前置条件：
  - MemoryStore 有 1 条 active fact（id: fact_x, subject: alice）
  - ForgetMarker 存在

操作：
  - 调用 forgetFact(fact_x, fingerprint)
  - 调用 assemble('hello', worldState)

验证：
  - queryFacts({ subject: 'alice' }) 返回 0 条
  - memoryFacts 中不包含 fact_x
  - usageStore.wasUsedIn(fact_x, since) === false
```

#### 场景 E4：user-explicit 覆盖 reflection（同 subject+type）

```
前置条件：
  - MemoryStore 有 2 条 facts：
    - fact_A: (subject=alice, type=preference, value=coffee, source=user-explicit, confidence=0.9)
    - fact_B: (subject=alice, type=preference, value=tea, source=reflection, confidence=0.85)

操作：
  - 调用 assemble('hello', worldState)

验证：
  - memoryFacts.length === 1
  - memoryFacts[0].id === fact_A.id（user-explicit 优先）
  - fact_B 被 L2 冲突解决过滤
```

#### 场景 E5：错误 memory 通过 user-explicit 修正

```
前置条件：
  - MemoryStore 有 1 条 fact（source=reflection, confidence=0.7, value=coffee）
  - 用户通过 remember action 写入 user-explicit fact（value=tea, confidence=0.95）

操作：
  - 调用 remember(subject=alice, type=preference, value=tea, source=user-explicit)
  - 调用 assemble('hello', worldState)

验证：
  - memoryFacts 包含 1 条 fact
  - 该 fact.value === 'tea'
  - 该 fact.source === 'user-explicit'
  - 旧的 coffee fact 变为 superseded
```

#### 场景 E6：L3 语义冲突正确标记（不自动裁决）

```
前置条件：
  - MemoryStore 有 2 条 facts（同 subject=alice, type=preference）：
    - fact_A: value='喜欢咖啡'
    - fact_B: value='不喜欢咖啡'

操作：
  - 设置 ORCA_MEMORY_CONFLICT_DETECT_SEMANTIC=true
  - 调用 assemble('hello', worldState)

验证：
  - result.conflicts.length === 1
  - result.conflicts[0].subject === 'alice'
  - result.conflicts[0].type === 'preference'
  - memoryFacts 包含两条冲突 facts（均保留）
  - memoryFacts 中每条都有 conflictMarker === true
```

#### 场景 E7：scoring preset 改变排序

```
前置条件：
  - MemoryStore 有 2 条 facts：
    - fact_A: confidence=0.6, updatedAt=now
    - fact_B: confidence=0.95, updatedAt=now - 30天

操作：
  - preset='confidence' → assemble
  - preset='confidence-freshness' → assemble

验证：
  - confidence preset：第一条是 fact_B（confidence 0.95）
  - confidence-freshness preset：第一条是 fact_A（新鲜度高抵消 confidence 差距）
```

#### 场景 E8：Memory disabled 时行为与 Phase 6.B 前完全一致

```
前置条件：
  - ORCA_MEMORY_CONTEXT_ENABLED=0
  - MemoryStore 有 facts

操作：
  - 调用 assemble('hello', worldState)

验证：
  - memoryFacts.length === 0
  - summary === ''
  - input 仍原样传递
  - infoRecords 和 worldState 不受影响
```

#### 场景 E9：CEO prompt 格式验证

```
前置条件：
  - MemoryStore 有 1 条 fact（subject=alice, type=preference, value=coffee, confidence=0.95）

操作：
  - 调用 assemble('hello', worldState)
  - 构建完整 prompt：persona + archiveContext + memoryContext

验证：
  - prompt 包含 '【长期记忆】'
  - prompt 包含 '[Memory:preference] alice: coffee (confidence 0.95)'
  - memoryContext 前有空行分隔
  - infoRecords 区块在 memoryContext 之前
```

### 4.3 测试套件设计

```
Phase 6.C 评估套件：E1~E9，共 9 个场景

E1~E3（基础行为）：
  - E1: Memory 正确进入 prompt
  - E2: Top-K 限制
  - E3: Forget 不复活

E4~E6（冲突处理）：
  - E4: user-explicit 覆盖 reflection（L2）
  - E5: user-explicit 修正错误 memory
  - E6: L3 语义冲突标记（不裁决）

E7~E9（集成与边界）：
  - E7: scoring preset 效果
  - E8: Memory disabled 行为不变
  - E9: CEO prompt 格式验证
```

### 4.4 与现有 smoke 测试的关系

Phase 6.C 评估场景在以下现有 smoke 套件基础上补充：

```
现有 smoke（Phase 5.0~6.B）：
  - smoke-memory: upsert / supersede / merge / forget
  - smoke-context-assembler: formatting / budget / Top-K / sorting
  - smoke-ceo-context-e2e: E2E assembly / prompt format / backward compat

Phase 6.C 新增：
  - smoke-memory-quality.mjs: E1~E9 覆盖 conflict resolution / scoring / usage tracking / evaluation
```

---

## 5. 架构影响分析

### 5.1 与现有组件的关系

```
MemoryStore（不修改核心语义）
  ↑
  │ upsertFact / forgetFact / mergeFacts / supersedeFact
  │
ContextAssembler（扩展：L2/L3 冲突处理 + scoring interface）
  │
  │ queryMemory() → resolveSourceConflict() → applyScoring()
  │
  └── assemble() → CEO prompt（R3）

MAA（不感知冲突处理和 scoring）
  └── MAA 查询不经过 ContextAssembler，直接 queryFacts
```

### 5.2 新增字段

#### ContextAssemblyResult 新增字段

```typescript
interface ContextAssemblyResult {
  // ... 现有字段 ...

  /** Phase 6.C 新增 */
  conflicts: MemoryConflict[]  // L3 语义冲突列表
}

interface MemoryConflict {
  type: FactType
  subject: string
  facts: FormattedMemoryFact[]  // 冲突的 facts（均保留）
}
```

#### ContextAssemblerConfig 新增字段

```typescript
interface ContextAssemblerConfig {
  // ... 现有字段 ...

  /** Phase 6.C 新增 */
  scoringPreset: 'confidence' | 'confidence-freshness' | 'source-confidence'
  detectSemanticConflict: boolean   // 默认 false
  conflictMarkInPrompt: boolean    // 默认 true
}
```

### 5.3 配置键汇总（Phase 6.C 新增）

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `ORCA_MEMORY_CONFLICT_RESOLVE_SOURCE` | `user-explicit-first` | L2 冲突解决策略 |
| `ORCA_MEMORY_CONFLICT_DETECT_SEMANTIC` | `false` | 是否启用 L3 语义冲突检测 |
| `ORCA_MEMORY_CONFLICT_MARK_IN_PROMPT` | `true` | 冲突 facts 是否标记 ⚠️ |
| `ORCA_MEMORY_SCORING_PRESET` | `confidence` | scoring 预设 |
| `ORCA_MEMORY_USAGE_TRACK` | `true` | 是否启用 usage tracking |
| `ORCA_MEMORY_USAGE_MAX_RECORDS` | `100` | ring buffer 最大记录数 |

---

## 6. 与现有决议的边界

| 决议 | 是否冲突 | 说明 |
|---|---|---|
| D-AGENT-17（MemoryStore mutation authority） | **无冲突** | L2/L3 冲突处理在 ContextAssembler 层，不在 MemoryStore 层 |
| D-AGENT-18（Memory contract hardening） | **无冲突** | 不修改 MemoryStore contract |
| D-AGENT-19（Memory Consumption Boundary） | **无冲突** | 不修改 AttentionEngine / DecisionEngine |
| D-AGENT-20（Phase 6 CEO Context） | **无冲突** | 扩展 ContextAssembler，不改变 CEO context 构造流程 |
| Phase 5.4.B memory_changed event | **无冲突** | MemoryUsageRecord 是独立的 in-memory 结构，不 emit 事件 |

---

## 7. Phase 6.C 实现优先级

### Phase 6.C MVP（必须实现）

| 特性 | 位置 | 说明 |
|---|---|---|
| L2 Source Conflict Resolution | ContextAssembler.queryMemory() 后处理 | user-explicit 优先 |
| Scoring Interface | ContextAssembler 查询结果排序 | 支持 preset 切换 |
| E1~E9 评估套件 | smoke-memory-quality.mjs | 9 个场景 |

### Phase 6.C 扩展（可选实现）

| 特性 | 位置 | 说明 |
|---|---|---|
| L3 Semantic Conflict Detection | ContextAssembler | 基于关键词规则 |
| MemoryUsageRecord Ring Buffer | ContextAssembler | in-memory tracking |
| L3 冲突 prompt 标记 ⚠️ | assemble() → summary |  |

---

## 8. 关键设计决定

| # | 决定 | 理由 |
|---|---|---|
| D1 | L2 冲突在 ContextAssembler 层处理，不在 MemoryStore 层 | MemoryStore 不知道 CEO context 的存在；ContextAssembler 是 CEO 访问 Memory 的唯一入口 |
| D2 | L3 语义冲突不做自动裁决，只标记 | LLM/CEO 有上下文信息做裁决；自动裁决可能错误 |
| D3 | MemoryUsageRecord 不 emit 事件，不持久化 | 轻量级追踪，不需要跨重启持久化 |
| D4 | scoring function 必须是 deterministic | 确保相同查询在任何时候产生相同结果 |
| D5 | 不在 MAA 层实现冲突处理 | MAA 只生成 AttentionItem，不注入 prompt；冲突处理是 CEO context 的职责 |

---

## 9. 待确认问题

| # | 问题 | 建议 |
|---|---|---|
| Q1 | L3 语义冲突检测是否默认开启？ | 默认关闭（性能开销小，但可能产生误报） |
| Q2 | MemoryUsageRecord 是否需要持久化？ | 当前不需要；重启清空是可接受的设计选择 |
| Q3 | scoring function 是否支持运行时切换？ | 是；preset 作为配置键可在运行时变更 |
| Q4 | L2 冲突过滤后，如果 user-explicit 和 reflection confidence 差距过大（如 0.95 vs 0.3），是否仍按 source 优先？ | 是；source 优先级是硬性规则，不考虑 confidence |
| Q5 | L3 冲突 facts 在 prompt 中标记 ⚠️，是否影响 LLM 判断？ | 可能；但保留两条让 LLM 自行裁决更安全 |
