# Orca LongMemory 架构设计稿 v1.2（设计阶段，已收敛）

> **状态**：v1.2 设计稿（**已收敛**，可作为 Phase 5.3+ 实现依据）。本次不重做 Memory 架构，仅收口 Phase 5.3 实际暴露的三个 contract 缺口。
> **日期**：2026-09-06（v1.0）；2026-09-07（v1.1）；2026-08-27（v1.2 D-AGENT-18）
> **版本演进**：
> - v0.1（2026-09-06 上午）— 初次起草，三态（active/superseded/deleted）+ 软删默认。
> - **v1.0（2026-09-06 下午）** — 落实用户最终拍板的 7 项开放问题：subject 弱约定、Reflection 周期、remember 免审批默认、forget 默认 hard-purge、evidence 三字段语义、forget 后 privacy-safe tombstone（不保留完整 fact）。详见 §15 版本记录。
> - **v1.1（2026-09-07）** — 5 项架构安全修订：①修正 §5.2/§6.2 读/写 ownership 语义冲突（"唯一"措辞问题）；②新增 ForgetMarker 防止 forget 后 Reflection 重新生成被遗忘事实；③AuditEvent 移除 prevValue/newValue（与 hard-purge 隐私冲突）；④Reflection 写权限收窄为"维护提案者"而非直接 mutator；⑤验证 LongMemoryFact/MemoryCandidate/AuditEvent/ForgetMarker 职责无重叠。详见 §15 版本记录。
> - **v1.2（2026-08-27）** — D-AGENT-18 Memory Contract Hardening：①正式纳入 `CandidateQuery{state?, type?, subject?, limit?}` contract（含 limit）；②正式纳入 `isSubjectSuppressed(subject)` subject-level 抑制 API（与 type-scoped `isSuppressed(type, subject)` 并存，Reflection promotion 必须使用 subject-level 版本）；③`MemoryStore.promoteCandidate()` 内置 user-explicit 保护 invariant（不再依赖 ReflectionEngine 提前 guard）；④Rule A 定位收敛为"验证 pipeline 的 deterministic candidate generation"，非"用户长期行为推断"。详见 §15 版本记录。
>
> **关联**：
> - `guide/decisions.md` D-AGENT-09 / D-AGENT-11 / D-AGENT-12 / D-AGENT-16 / **D-AGENT-17** / **D-AGENT-18**
> - `guide/orca-info-agent-framework.md` §3（InfoRecord 信封）
> - `guide/orca-im-bridge.md` §10（"Orca 记忆能力实装"作为 IM Bridge 阶段 B 解锁条件）
> - `AGENT.md` §4.3 / §8.3（Runtime 分层铁律）
> - `TODO.md` / `dev-log.md`（路线衔接建议，未改实现代码）

---

## 0. TL;DR（最终）

1. **LongMemory** = Orca 对用户/环境形成的**当前长期知识状态**（不是 append-only 永久事实表）。支持 create / update / merge / supersede / compress / forget 六种操作。
2. 生命周期四阶段：**Episode → Reflection → MemoryCandidate → LongMemory**。Reflection 是 **Maintenance & Consolidation** 子系统，**不是** Episode → LongMemory 的转换器。
3. LongMemory **持久状态**：`active` / `superseded` / **物理删除（forget 默认 hard-purge）**。
4. **`source` 必填**：`'user-explicit'` 与 `'reflection'` 区分。前者走 `memory.remember` Action handler 直达 active（**默认 `requiresApproval=false`**，用户显式授权已隐含在命令里）；后者必须经 `MemoryCandidate` / confidence 门控。
5. **`forget` 默认 hard-purge**。若实现层因一致性/审计需要保留 tombstone，必须满足：正常查询不可见 + 不保留原始 value + 不保留可恢复的完整敏感内容 + AuditEvent **不记录被遗忘的 value**（prevValue/newValue 已从 schema 移除，详见 §3.4 / §5.1）。
6. **Evidence 三字段**：`representativeEvidenceIds`（最多 5 个，用于快速解释/审计）+ `evidenceSummary`（≤ 200 字符，注入 prompt）+ `evidenceCount`（累计证据数量）。完整 Episode 历史仍由 EpisodeStore 保存，LongMemoryFact 不堆积 evidence。
7. **subject 弱约定**：允许 `.` 分层（如 `girlfriend.coffee` / `ui.design` / `user.sleep`），prefix 查询；不建立固定 namespace registry。
8. **MemoryStore 与 InfoRecordStore 独立**：JSONL + 内存索引；不引入 SQLite / 向量库。
9. **读写分离三角色**：①CEO/context 层是**唯一业务消费者**（只读 active LongMemory）；②ReflectionService 是**唯一维护所有者**（读 Episode/Candidate/active，写 candidate/update/merge/supersede/compress）；③`memory.remember`/`memory.forget` ActionHandler 是**用户命令写入入口**（只写）。三者各司其职，不存在"唯一读+写子系统"的矛盾。
10. **本次未实现任何 Memory 代码**；实现阶段按 D-VER-04 同步 AGENT.md / TODO.md / dev-log.md。

---

## 1. 问题陈述与现状盘点

### 1.1 三层分层（现状已隐含，不重复定义）

| 层 | 定义 | 现状 |
|---|---|---|
| **WorldState（现在）** | 用户/设备/时间/扩展块的"当前事实" | ✅ `services/worldState.ts` + `plugins/world-state-updater.ts`（Phase 2.A/B/C/D）；D-AGENT-16-10 严格只存当前态，不缓存历史 |
| **Short Memory（最近）** | 最近发生、TTL 有限、可被 Reflection 提炼的 Episode | ❌ 现状没有统一 Episode 层；最接近的：EventBus 滑动窗口（内存，window=200，无结构化摘要）+ InfoRecordStore（按 namespace 的领域档案，非统一 episode 视图） |
| **Long Memory（长期）** | 类型化、可修正、可压缩、可遗忘的长期知识状态 | ❌ 现状只有 `createRememberHandler`（Phase 4.B）写 infoStore `decision-action`/`decision-remember`，是 free-payload 单条记录，不是结构化用户画像库 |

### 1.2 现有相关决议/事实（必须尊重，不重复）

- **D-AGENT-09**：记录库每 namespace 一个 JSONL，统一信封 `InfoRecord{id, namespace, type, ts, source, confidence?, urgency?, payload, ttlDays?}`；**append-only** + `supersedes` 更正；检索只依赖信封字段。
- **D-AGENT-11**：Push 记录默认静默入库；urgency 0/1/2 门控。
- **D-AGENT-12**：ttl + 软删/硬清理；L1 私有数据不落明文日志、可一键清空 namespace；外部 Push 通道需 Bearer 鉴权 + namespace 白名单。
- **D-AGENT-16-03**：Decision 终态 = `act / notify / defer / archive`；**不再做 `remember_only → remember` 二次映射**；`archive ≠ ignore`，archive 入档可被 R0 检索。
- **D-AGENT-16-10**：WorldState 严格只存当前状态；历史走 EventBus + InfoRecordStore。
- **AGENT.md §4.3 / §8.3** 铁律：DecisionEngine 纯函数、无 IO / 不调 LLM / 不写 infoStore；ActionExecutor 是唯一可发飞书/写 infoStore/调 LLM 的层；ORCA_ACTION_ENABLED 默认 false。
- **`guide/orca-im-bridge.md` §10 阶段 B**："Orca 记忆能力实装" 是 IM Bridge 阶段 B 的 P0 阻塞条件（用户 2026-09-05 既定顺序：Memory → InfoStore → IM Bridge → PoC）。

### 1.3 现状缺口（本设计稿要解决的）

1. 没有"最近发生"统一 Episode 层；Reflection 找不到干净输入。
2. 没有结构化、类型化的用户/环境长期知识库；CEO 回话只能查档案（领域数据），无法回答"你知道我讨厌香菜吗"。
3. `createRememberHandler` 与 D-AGENT-16-03 决策词汇存在历史未消化冲突（详见 §10）。
4. Reflection 的定位在 D-AGENT-09/11/12 中没有占位；现有调度先例是 `deferredScheduler`（30s tick，Phase 4.D）——Reflection 可借鉴其调度模型。

---

## 2. 设计原则

| # | 原则 | 落点 |
|---|---|---|
| P1 | LongMemory 是**当前知识状态**，不是聊天记录 | Evidence / Audit 单独存；active 不堆积 evidence |
| P2 | **可验证**：每条 LongMemory 可指回 evidence | `representativeEvidenceIds` + `evidenceSummary`（不堆全量） |
| P3 | **可修正**：supersede 是正常路径 | `supersededBy` 关系链 + 原值进 Audit |
| P4 | **可压缩**：重复 / 低信号记忆合并 | `mergedInto` 关系；合并源进 Audit |
| P5 | **可遗忘**：forget 默认 hard-purge（隐私优先） | 物理删除 fact；可保留 privacy-safe tombstone 但不保留 value |
| P6 | **source 区分**：`user-explicit`（直达 active、免审批）vs `reflection`（必经 candidate 门控） | `MemoryCandidate.state` + 晋升策略 |
| P7 | **不与 InfoRecordStore 混用** | 独立 MemoryStore（§7） |
| P8 | **DecisionEngine 不读 Memory**；Memory 仅在 CEO/context 层被检索 | AGENT.md §4.3 铁律保留 |
| P9 | **Memory 写入受控**：只有 ReflectionService + 显式记忆 Action handler | 受控 API + 写者白名单（§5） |
| P10 | **不提前引入 SQLite / 向量库** | Phase A 用 JSONL + 内存索引（同 D-AGENT-09 §7A 模式） |
| P11 | **不设计 Memory → WorldState / Attention 投影**（本次） | 第一阶段 Memory consumer 仅 CEO/context；留作远期扩展 |

---

## 3. 数据模型（设计稿契约，非实现代码）

> 以下为类型契约草案，用于 Phase 5.0 实现阶段对齐。**本次不提交任何 .ts 文件。**

### 3.1 Episode（短期记忆单元）

```ts
// draft — contract only
interface Episode {
  id: string                  // uuid
  category:
    | 'message'               // MVP 第一类：feishu 消息 burst
    | 'location'              // 后续：WorldState 位置转换
    | 'calendar'              // 后续：calendar adapter
    | 'activity'              // 后续：PC adapter
  summary: string             // 确定性规则生成；MVP 不调用 LLM
  ts: number                  // happenedAt；与 InfoRecord 信封 `ts` 同义
  entities: string[]          // 主体/对象（人、地、物）；MVP 先用字符串集合
  sourceEventIds: string[]    // back-trace 到 EventBus（同 D-AGENT-16-14 `id`）
  importance: 'low' | 'normal' | 'high'
  ttlDays: number             // 默认 7（对齐 D-AGENT-12 / D-AGENT-16-09）
  // —— 生命周期 ——
  state: 'active' | 'pruned'  // pruned = ttl 到期清理（软删）
  prunedAt?: number
}
```

**与 InfoRecord 的关系**：Episode 是 Memory 体系自有对象。MVP 阶段**不**塞进 InfoRecordStore（理由 §7）；EpisodeStore 与 InfoRecordStore 平级。

### 3.2 MemoryCandidate（Reflection 推断的、待晋升候选）

```ts
// draft — contract only
interface MemoryCandidate {
  id: string                  // uuid
  proposedFact: {
    type: 'preference' | 'person' | 'habit' | 'fact'
    subject: string           // 弱约定命名空间：允许 '.' 分层，如 'girlfriend.coffee' / 'user.sleep'
    value: string             // 例如 'acid design' / 'afternoon coffee → insomnia' / '~01:00'
  }
  confidence: number          // 0..1；由 Reflection 评估
  evidenceEpisodeIds: string[]// 支持该候选的 Episode（来源是 EpisodeStore，可超过 5 条）
  reason: string              // Reflection 写的人话理由（"连续 20 天 1 点睡 → 习惯"）
  source: 'reflection'        // 必填且固定；user-explicit 不走 candidate
  // —— 晋升门控 ——
  state: 'pending' | 'promoted' | 'rejected' | 'expired'
  decidedAt?: number
  decidedBy?: 'auto-confidence-threshold' | 'user-confirmed'
  promotedFactId?: string     // state === 'promoted' 时指向 LongMemoryFact.id
  rejectedReason?: string
  ttlDays: number             // 默认 30；超期未晋升则 expired
  createdAt: number
}
```

**CandidateQuery**（D-AGENT-18 正式 contract）：

```ts
interface CandidateQuery {
  state?: 'pending' | 'promoted' | 'rejected' | 'expired'
  type?: LongMemoryFact['type']
  subject?: string
  limit?: number   // 默认 100；上限 1000；按 createdAt 降序截断
}
```

**v1.2 补充（D-AGENT-18，2026-08-27）**：`MemoryStore.queryCandidates(q)` 正式纳入 contract。当前 ReflectionEngine 已使用（去重 + 状态查询）；Phase 5.3 之前作为内部 API；Phase 5.3 已暴露但未文档化，本节正式落定。**不引入**复杂 Candidate repository abstraction；limit 是简单内存截断。

### 3.3 LongMemoryFact（长期知识，**当前知识状态**）

```ts
// draft — contract only
interface LongMemoryFact {
  id: string                  // uuid

  type: 'preference' | 'person' | 'habit' | 'fact'
  subject: string             // 弱约定命名空间（'girlfriend.coffee' 等）；与 type 一起决定 identity
  value: string               // 当前生效的陈述

  confidence: number          // 0..1；每次 update/supersede 时重算

  // —— 来源（必填，决定晋升路径）——
  source: 'user-explicit' | 'reflection'
  // user-explicit：用户显式"记住 X"；由 memory.remember Action handler 调用，可直达 active
  // reflection：经 candidate 门控后才晋升为 active

  // —— 状态：核心持久态 ——
  state: 'active' | 'superseded'
  // active：当前可供正常检索的知识
  // superseded：被新事实取代；保留关系链（supersededBy），不进正常检索
  // —— forget 后的删除：默认物理删除 fact 记录本身（§3.4 / §5.1）；若实现保留 tombstone，必须是 privacy-safe（§5.1 硬约束）

  // —— 关系链 ——
  supersededBy?: string       // state === 'superseded' 时指向新 fact.id
  supersedes?: string         // 替代了哪条旧 fact（可选；用于审计）
  mergedInto?: string         // 被合并到哪条 fact（合并源 → 目标）

  // —— Evidence 三字段（v1.0 新设计）——
  representativeEvidenceIds: string[]   // 最多 5 个，用于快速解释/审计；append 满则触发 compress
  evidenceSummary?: string              // 单行人类可读摘要（≤ 200 字符）；用于注入 prompt
  evidenceCount: number                 // 累计证据数量（单调递增；用于稳定度判断）

  // —— 审计字段 ——
  createdAt: number
  updatedAt: number           // 每次 update / supersede / merge 时刷新
  createdBy: 'reflection' | 'user-explicit' | 'initial-import'
  // initial-import：未来从外部导入的固定事实（如 iPhone 健康数据导出的身高）

  // —— 隐私 ——
  privacyLevel: 'L1'          // Memory 默认 L1（用户私有）；PII 字段统一打码
  ttlDays?: number            // 仅在用户标记"有时效的事实"时设；默认不设 = 永久 active
}
```

**identity**：`(type, subject)` 是事实的唯一键（subject 允许 `.` 自然命名空间，如 `girlfriend.coffee`、`sleep.weekday`）；同一 `(type, subject)` 不能同时存在两条 `active`——upsert / supersede。

**subject 查询约定**（v1.0 用户拍板）：
- 弱约定：subject 是字符串，允许 `.` 分层（`'girlfriend.coffee'` / `'ui.design'` / `'user.sleep'`）。
- 检索支持 **prefix 匹配**：查询 `'girlfriend'` 命中 `girlfriend.coffee` 与 `girlfriend.tea`。
- **不**建立固定 namespace registry（避免过度工程）。

**Evidence 三字段语义**（v1.0 用户拍板）：
- `representativeEvidenceIds` ≤ 5 条：仅用于"快速解释/审计"场景，append 超出触发 compress。
- `evidenceSummary` ≤ 200 字符：注入 prompt 的单行摘要。
- `evidenceCount` 单调递增：用于 Reflection 判断稳定度（如 `evidenceCount ≥ 20` 才升 habit）。
- **完整 Episode 历史仍由 EpisodeStore 保存**；LongMemoryFact 不再堆积 evidence，避免 active 变聊天记录数据库。

### 3.4 AuditEvent（独立审计日志，**不进 active**）

```ts
// draft — contract only
interface AuditEvent {
  id: string
  factId: string              // 指向被审计的 LongMemoryFact.id（forget 后 factId 仍可指向 tombstone id）
  ts: number

  kind:
    | 'created'
    | 'updated'               // value 或 confidence 变化
    | 'superseded'            // 被新 fact 取代
    | 'merged'                // 被合并到目标 fact
    | 'compressed'            // evidence 压缩（§4.3）
    | 'forgotten'             // 用户要求遗忘；**仅记录操作本身，不记录被遗忘的 value**

  // v1.1：prevValue/newValue 从 schema 移除
  // 字段级变更追踪用 changedFields[]；value 内容不进入审计记录
  changedFields?: string[]    // 本次变更涉及的字段名，如 ['value', 'confidence']
  prevConfidence?: number
  newConfidence?: number

  actor: 'reflection' | 'user-explicit' | 'user-forget'
  reason?: string             // human-readable；可注入审计 UI
  evidenceDelta?: {
    added: string[]
    removed: string[]
  }
}
```

**v1.1 关键变更**（相对 v1.0）：
- `prevValue` / `newValue` **从 schema 中移除**。变更内容通过 `changedFields[]`（字段名列表）表达，value 本身不进入审计日志。
- `forgotten` 事件的 `changedFields` 不填、`prevConfidence`/`newConfidence` 不填；仅记录 `factId` + `kind='forgotten'` + `actor='user-forget'` + `ts`。
- 理由：AuditEvent 是**操作元数据日志**，不是内容备份；prevValue/newValue 会使 hard-purge 的隐私保证失效（审计记录本身成为被遗忘内容的备份）。

**v1.0 → v1.1 迁移说明**：实现阶段创建 AuditEvent 时，移除所有 `prevValue`/`newValue` 赋值逻辑；历史 v1.0 的 `prevValue`/`newValue` 数据**不**需要迁移（v1.0 设计稿中 schema 有字段但 forget 操作已强制 undefined，实际存储中 forget 事件的这两个字段本来就是空的）。

### 3.5 ForgetMarker（遗忘抑制标识，v1.1 新增）

```ts
// draft — contract only
interface ForgetMarker {
  id: string                   // uuid
  fingerprint: string          // 确定性抑制身份：lower-case(sha256(salt, subject))
  subject: string              // 原始 subject（不是 memory value）
  type: LongMemoryFact['type'] // 用于类型作用域抑制
  createdAt: number
  createdBy: 'user-forget'     // 固定值
}
```

**设计目的**：用户执行 `forget X` 后，若 Reflection 未来又从旧 Episode 中重新推断出相同的 fact，ForgetMarker 提供确定性抑制信号，使该 candidate 在生成阶段就被拒绝。

**fingerpint 语义**：
- 输入：盐值（实现固定字符串）+ 小写 subject。
- 算法：SHA-256 → 取前 16 字符（hex）作为 fingerprint。
- 特性：subject 大小写不敏感（统一小写）；不同 subject 的 fingerprint **不**存在已知碰撞风险；无法从 fingerprint 反推 subject（抗彩虹表，需盐值）。

**与 tombstone 的区别**：

| 维度 | ForgetMarker | tombstone |
|---|---|---|
| 内容 | 仅有 subject/type/fingerprint（无 value） | 可选保留 id/type/subject/forgottenAt |
| 用途 | Reflection Candidate 生成门控（写入抑制） | 物理删除后的最小占位（可选） |
| 生命周期 | 永久保留（用户主动清除前一直抑制） | 可选，实现层可完全不保留 |
| 查询键 | `(type, fingerprint)` | `id` |

**生命周期**：
- 创建：`forgetFact(id)` / `forgetByQuery(q)` 执行时同步创建（原子操作）。
- 抑制：Reflection 每次生成新的 MemoryCandidate 前，查询所有 active ForgetMarker；若 `sha256(salt, lower(candidate.proposedFact.subject))` 匹配任意 marker 的 fingerprint **且** `candidate.proposedFact.type === marker.type`，则**拒绝该 candidate**（不晋升，不写 store）。
- 清除：用户提供显式"不再抑制 X"命令 → 删除 ForgetMarker（Phase 5.x 后续功能，本次不设计）。

**v1.2 补充（D-AGENT-18，2026-08-27）**：增加 **subject-level 抑制语义**。除原 type-scoped 抑制外，`MemoryStore.isSubjectSuppressed(subject)` API 提供 subject-only 抑制检查（不依赖 type）。这意味着：

- `isSuppressed(type, subject)`：**type-scoped**，用于 D-AGENT-17 原设计场景；候选 subject 匹配任意 marker fingerprint **且** type 相同时返回 true。
- `isSubjectSuppressed(subject)`：**subject-level 抑制**，用户对 subject 的全局抑制；候选 subject 匹配任意 marker fingerprint 即返回 true，忽略 type。

Reflection promotion **必须使用 subject-level suppression**（D-AGENT-18 hardening），确保：

```
forget subject X
→ 任何 candidate (type=B, subject=X)
→ 都不得被 promote
```

两个 API 并存，type-scoped 版本保留用于未来可能出现的"类型精细化抑制"需求；subject-level 版本作为 privacy gate。

**隐私语义**：ForgetMarker 不包含 memory value，仅存储 subject 字符串；subject 本身可能含敏感信息（如"我讨厌妈妈"），但 fingerprint 无法反推，且 marker 与 LongMemoryFact 独立存储。

---

### 3.6 Evidence 与 Audit 的边界（防止 active 变聊天记录）

| 维度 | 边界 |
|---|---|
| `representativeEvidenceIds` 长度 | 单条 fact 最多 5 条（v1.0 用户拍板，不再以"最多 5 条历史证据"理解）；超出触发 `compress`（§4.3） |
| `evidenceSummary` 长度 | ≤ 200 字符；注入 prompt 时按 fact 单行 |
| `evidenceCount` 语义 | 单调递增；超阈（如 ≥ 20）可作 stability signal；不参与压缩 |
| 完整 evidence 历史 | 仅存于 `EpisodeStore`（短期，可被 prune）；长期不重复存储 |
| AuditEvent 容量 | 单条 fact 审计无硬上限，但**不进 R0/CEO 检索结果**；仅审计 UI / 调试读取 |
| `forgotten` 事件内容 | **禁止**记录被遗忘的 fact value / confidence / 完整敏感内容；只记录操作本身 + factId |
| 长 evidence 检索 | 检索时只回 `(id, summary, count)`；展开 evidence 详情是显式 user action |

---

## 4. 生命周期阶段

### 4.1 Episode → Reflection

**Episode 的生成路径**（MVP 第一版）：

| 来源 | 触发 | 生成方式 | LLM 调用 |
|---|---|---|---|
| feishu 消息 burst | 同 sender 在 N 秒内 ≥3 条消息 | 确定性规则生成 summary | ❌ |
| WorldState 转换 | `user.location` 变化 | 确定性规则 | ❌ |
| Calendar adapter 事件 | 真实 adapter 就绪后 | 适配器输出 + 规则 | ❌ |
| PC adapter 活动 | 真实 adapter 就绪后 | 适配器输出 + 规则 | ❌ |

**Episode → MemoryCandidate**：
- ReflectionService 周期性扫描最近 Episode 窗口（默认 24h，可被空闲检测提前触发，§4.2）。
- 启发式：检测"重复出现 ≥K 次 / N 天"的模式 → 生成 `MemoryCandidate`，`reason` 写明依据，`evidenceEpisodeIds` 引用 EpisodeStore 中的全部证据（**不受 5 条限制**，5 条限制只约束 LongMemoryFact.representativeEvidenceIds）。
- LLM 仅在 Reflection 周期使用一次（批量），不每事件调用；与现有 DSH 成本控制经验一致。
- confidence 初值 = 启发式评估（如 `min(episode_count / 10, 1.0)`），不依赖 LLM 直出。

### 4.2 Reflection 调度（v1.0 用户拍板）

- **默认策略**：每日固定 + 空闲检测提前触发。
- **配置键契约**（实现阶段落 `app-cordis/src/config.ts`，**本次不落代码**）：
  - `ORCA_REFLECTION_INTERVAL_HOURS=24`：两次固定 Reflection 之间的最长间隔。
  - `ORCA_REFLECTION_IDLE_TRIGGER=true`（默认 true）：当系统检测到用户 `away` 且无活跃事件 ≥ N 小时时，可提前触发一次 Reflection（不等满 24h）。
- **tick 行为**：每次 tick 调用 `executeReflectionTick()`，**纯函数 + 调度器**模式（对齐 Phase 4.D `executeTick(store, worldState, emit, isDisposed)` 设计）。
- **不修改 WorldState / Attention / Decision**；不直接修改 EventBus；仅在 MemoryStore 内部写。
- **disposed 闸门**：plugin dispose 后 in-flight tick 短路（对齐 Phase 4.B Review dispose race 模式）。

### 4.3 Reflection 的真正职责（Maintenance & Consolidation）

> Reflection **不是**"每天把 Episode 写成 LongMemory"。它是 Memory 的维护/整合子系统。

每次 Reflection 周期做以下六件事（含 v1.0 明确"candidate generation / promotion"为独立职责）：

| 任务 | 输入 | 输出 |
|---|---|---|
| **1. Discover new facts** | Episode 窗口 | 新增 `MemoryCandidate` |
| **2. Update existing facts** | active LongMemoryFact + 新 Episode | 现有 fact 的 `confidence` / `value` 微调（**不替换为新事实**，否则走 supersede）；`evidenceCount` 单调递增；`representativeEvidenceIds` append；触发 `evidenceSummary` 刷新 |
| **3. Merge duplicates** | active LongMemoryFacts 之间（subject 接近 / type 相同） | `mergedInto` 关系；源 → superseded（保留关系链）；目标保留 active；evidence 合并去重 |
| **4. Detect conflict → supersede** | active fact 与 candidate / 新 evidence 冲突 | 新 fact 晋升（active）+ 旧 fact `supersededBy=new.id`；旧 fact 进 Audit |
| **5. Compress evidence** | 单条 fact `representativeEvidenceIds` 超上限（5） | 触发 `compress`：保留最近 5 条 representativeEvidenceIds + 重新生成/更新 `evidenceSummary`；被移除的 evidence 进 Audit（仅记录 removed id，不复制 Episode 内容） |
| **6. Candidate generation / promotion** | pending MemoryCandidate 列表 | 按 `confidence ≥ 阈值`（默认 0.7）晋升 → `LongMemoryFact`（active，source='reflection'）；未达阈值保留 pending / 标记 expired |

### 4.4 LongMemory 操作矩阵（v1.0 收敛）

| 操作 | 何时 | 写入路径 | 关系链影响 | 审计 |
|---|---|---|---|---|
| **create** | 新 fact 出现（user-explicit 经 memory.remember handler 直达 active；reflection 经 candidate→promoted） | `MemoryStore.upsertFact` | 无 | `AuditEvent{created, actor=user-explicit\|reflection}` |
| **update** | value 微调 / confidence 调整 | 同 `(type, subject)` 的 active fact 原地写 | `representativeEvidenceIds` append；`evidenceCount++`；超上限触发 compress | `AuditEvent{updated}` |
| **merge** | 两条 active fact 实质重复 | `mergeFacts(sourceIds, targetId)` | 源 `state='superseded'` + `mergedInto=target.id`；目标保留 active | `AuditEvent{merged, factId=source.id}` |
| **supersede** | 新事实**取代**旧事实（如"喜欢咖啡"→"讨厌咖啡"，或"单身"→"有女友"） | `supersedeFact(oldId, newFact)` | 新 fact create(active) + 旧 fact `state='superseded'` `supersededBy=new.id` | 两条 `AuditEvent`：`{superseded, factId=old.id}` + `{created, factId=new.id}` |
| **compress/consolidate** | `representativeEvidenceIds` 超 5 | `compressFactEvidence(id)` | 不改 state；只刷新 `representativeEvidenceIds` + `evidenceSummary` | `AuditEvent{compressed, evidenceDelta}` |
| **forget/delete** | 用户明确"忘掉 X" / "删除关于 Y 的所有记忆" | `createForgetMarker(type, subject)`（原子） + `forgetFact(id)` 默认 hard-purge → 物理删除 fact；`forgetByQuery(q)` 批量 | **删除 fact 记录**（不设 `state='deleted'` 持久态）；同步抑制相关 MemoryCandidate；可选 privacy-safe tombstone（§5.1） | `AuditEvent{forgotten, actor=user-forget, changedFields=undefined}`；后续 Reflection 生成 candidate 时被 ForgetMarker 拒绝 |

**关键不变量**：

- 同一 `(type, subject)` **至多一条** `active` fact。
- `supersede` 方向单向：新 → 旧。旧 fact 不能 reverse supersede 复活；如需回滚，**新 supersede** 旧 supersede（保留全链）。
- `merge` 不允许 `active → mergedInto=superseded` 形成环；目标若已 superseded 则报错。
- `forget` 是**单向不可恢复**（除用户重新显式 create）；不再保留 `state='deleted'` 持久态。
- `forgetFact` 后 fact 不进 `queryFacts` 默认结果；`getFact(id)` 在不传 `includeTombstone` 时返回 `undefined`。
- `compress` 不丢失 evidence 历史：EpisodeStore 中的 Episode 仍然保留完整内容；LongMemoryFact 只丢 representativeEvidenceIds 中的引用 id。

### 4.6 ForgetMarker 完整生命周期（v1.1 新增，v1.2 D-AGENT-18 修订）

```
user says "forget X"
  → memory.forget ActionHandler
    → MemoryStore.createForgetMarker(type, subject)
        fingerprint = sha256(salt, lower(subject))
        creates ForgetMarker{id, fingerprint, subject, type, createdAt, createdBy:'user-forget'}
    → MemoryStore.forgetFact(id) or MemoryStore.forgetByQuery(q)
        hard-purge: 从 long.jsonl 移除 LongMemoryFact
        拒绝/物理删除所有相关 MemoryCandidate 记录
        追加 AuditEvent{forgotten, factId, actor:'user-forget', changedFields=undefined}
    → ReflectionService 后续运行：
        生成新 MemoryCandidate 前：
          type-scoped 检查：调用 MemoryStore.isSuppressed(type, subject)
          subject-only 检查（v1.2 新增）：调用 MemoryStore.isSubjectSuppressed(subject)
          if isSuppressed(type, subject)  // type-scoped gate
             OR isSubjectSuppressed(subject)  // subject-only privacy gate (v1.2)
          → REJECT candidate（不晋升，不写 store；标记 rejectedReason='suppressed-by-forget-marker'）
```

**v1.2 关键特性**（D-AGENT-18 修订）：
- ForgetMarker 与 forgetFact **原子创建**（同一事务，或写前者成功后才执行后者）。
- fingerprint 是确定性的：相同 subject 总是产生相同 fingerprint，与大小写无关。
- 抑制在 **candidate 生成阶段**生效，而非晋升阶段（避免无效 candidate 浪费资源）。
- **v1.2 跨类型抑制（subject-level）**：除原有 type-scoped 抑制外，新增 subject-level 抑制。即：若 forget 时 type=`preference` subject=`X`，则 type=`habit` subject=`X` 的 candidate 也被 subject-level gate 拒绝（隐私硬保证）；type-scoped 版本保留用于未来"类型精细化抑制"扩展。
- **D-AGENT-18 MemoryStore invariant**：`MemoryStore.promoteCandidate()` 内部同时检查 `isSubjectSuppressed` + user-explicit 冲突；任何未来调用 `promoteCandidate()` 的 subsystem 都自动受到保护，即使 ReflectionEngine 没有做提前 guard。

### 4.7 Reflection 写权限边界：维护提案者，非直接 mutator（v1.1 新增）

> 背景（v1.1 安全修订）：ReflectionService 享有 Memory 读写权限，但这个权限的语义必须收窄为"维护提案者"而非"直接 mutator"。直接 JSONL 写入或 in-memory 对象修改属于越界。

**原则**：
- Reflection = **维护提案生产者**（proposer）。它分析、推理、生成候选操作。
- MemoryStore = **mutation authority**（mutator）。所有状态变更必须经过 MemoryStore 的类型化 API。
- Reflection **永远不直接修改** JSONL 文件或 in-memory LongMemoryFact 对象。

**四类操作的处理路径**：

| 操作类型 | Reflection 行为 | MemoryStore API |
|---|---|---|
| 置信度/evidence 轻量维护（`evidenceCount++`、`append representativeEvidenceIds`、`刷新 evidenceSummary`） | 生成 update 提案 | `upsertFact(update)` — 原地更新 active fact |
| 语义 value 变更（"喜欢咖啡"→"讨厌咖啡"） | 生成 supersede 提案（识别冲突，构造新 fact） | `supersedeFact(oldId, newFact)` — 原子：旧→superseded + 新→created + 两条 AuditEvent |
| merge（两条 active fact 实质重复） | 识别重复，计算目标，生成 merge 提案 | `mergeFacts(sourceIds, targetId)` — 原子：源→superseded+mergedInto + 目标保留 active + AuditEvent |
| compress（representativeEvidenceIds 超 5） | 检测到超限，生成 compress 提案 | `compressFactEvidence(id, {keepRecent:5})` — 仅驱逐 representativeEvidenceIds 引用 + 刷新 evidenceSummary |

**禁止行为**：
- Reflection 直接 `JSON.parse(fs.readFileSync(...))` 然后 push 到数组 → 必须经 `upsertFact`。
- Reflection 直接 `fact.state = 'superseded'` 然后写回 → 必须经 `supersedeFact`。
- Reflection 直接修改 `long.jsonl` 文件 → 必须经 MemoryStore API。

**理由**：
- MemoryStore 是唯一知道"如何正确更新索引"的组件；Reflection 直接写 JSONL 会使内存索引失效。
- 所有写操作必须经过 AuditEvent 同步追加；Reflection 直接写会跳过审计。
- typed API 提供边界清晰的可审计点；无界文件写入没有约束。

---

### 4.5 forget / delete 与 supersede 的严格区分（v1.0 收紧）

| 维度 | supersede | forget/delete |
|---|---|---|
| 触发 | 系统检测：新事实取代旧事实 | **用户显式命令**："忘掉 X" / "删除关于 Y 的记忆" |
| 旧 fact 状态 | `superseded`（保留关系链） | **物理删除** fact 记录（v1.0 默认） |
| 历史是否可见 | 审计可见（可回看"曾经的旧值"） | 审计**仅记录 forget 操作本身**，不记被遗忘的 value |
| tombstone | 不适用 | 可选 privacy-safe tombstone（§5.1 硬约束） |
| 反向操作 | 新 supersede 旧 supersede | **不可逆**（除用户重新显式 create） |

---

## 5. 写入控制（受控 API + 写者白名单）

### 5.1 受控 API（MemoryStore 唯一暴露）

> 本稿不实现代码；以下为接口契约草案。

```ts
// draft — contract only
interface MemoryStore {
  // —— Episode ——
  appendEpisode(e: Episode): Promise<void>
  queryEpisodes(q: EpisodeQuery): Promise<Episode[]>
  pruneExpiredEpisodes(): Promise<number>

  // —— LongMemory read ——
  // 默认只返回 active；调用方显式 includeSuperseded 才返回 superseded 历史
  // **不再返回 'deleted'**（v1.0：forget 默认物理删除，无持久 deleted 态；可选 tombstone 受 §5.1 隐私约束保护）
  queryFacts(q: FactQuery, opts?: { includeSuperseded?: boolean; includeTombstone?: boolean }): Promise<LongMemoryFact[]>
  getFact(id: string, opts?: { includeSuperseded?: boolean; includeTombstone?: boolean }): Promise<LongMemoryFact | undefined>

  // —— LongMemory write（受控入口，写者白名单）——
  upsertFact(fact: LongMemoryFact): Promise<LongMemoryFact>             // create + update；同 (type,subject) 唯一 active
  supersedeFact(oldId: string, newFact: LongMemoryFact): Promise<void>  // 旧 → superseded
  mergeFacts(sourceIds: string[], targetId: string): Promise<void>      // 源 → mergedInto=target
  compressFactEvidence(id: string, opts: { keepRecent: number }): Promise<void>
  forgetFact(id: string): Promise<void>                                 // 用户遗忘；默认 hard-purge
  forgetByQuery(q: FactQuery): Promise<number>                          // 批量遗忘（"忘掉所有关于 X"）

  // —— Candidate ——
  appendCandidate(c: MemoryCandidate): Promise<void>
  queryCandidates(q: CandidateQuery): Promise<MemoryCandidate[]>     // D-AGENT-18 正式 contract
  promoteCandidate(id: string, decidedBy: 'auto-confidence-threshold' | 'user-confirmed'): Promise<LongMemoryFact>
  rejectCandidate(id: string, reason: string): Promise<void>
  expireCandidates(): Promise<number>

  // —— ForgetMarker（v1.1 新增）——
  createForgetMarker(type: LongMemoryFact['type'], subject: string): Promise<ForgetMarker>
  // 内部自动计算 fingerprint = sha256(salt, lower(subject))
  // 原子操作：先创建 marker，再执行 forgetFact / forgetByQuery

  queryForgetMarkers(q: { type?: LongMemoryFact['type']; fingerprint?: string }): Promise<ForgetMarker[]>
  // 用于 Reflection candidate 生成门控

  isSuppressed(type: LongMemoryFact['type'], subject: string): Promise<boolean>     // type-scoped
  isSubjectSuppressed(subject: string): Promise<boolean>                            // D-AGENT-18 subject-only privacy gate

  // —— Audit ——
  queryAudit(factId: string, limit?: number): Promise<AuditEvent[]>
}
```

**forget 默认 hard-purge 的隐私硬约束**（v1.0 用户拍板）：

如果实现层因一致性/审计/索引需求保留 tombstone，**必须同时满足**：

1. **正常 Memory 查询不可见**：tombstone 不进 `queryFacts()` 默认结果；`getFact()` 在 `includeTombstone=false` 时返回 `undefined`。
2. **不保留原始 value**：tombstone 仅保留 `id` / `type` / `subject` / `forgottenAt` / `source`；**不**保留 `value` / `confidence` / `evidenceSummary` / `representativeEvidenceIds`。
3. **不保留可恢复的完整敏感内容**：tombstone 不能反向 hydrate 完整 fact；不能用于 undo / restore。
4. **AuditEvent 仅记录 forget 操作本身**：prevValue/newValue 已从 AuditEvent schema 移除（v1.1）；只记录 `factId` + `actor=user-forget` + `ts` + `kind='forgotten'` + `changedFields=undefined`，value 内容永不进入审计记录。

`forgetFact` 实现语义：
- **优先方案**（Phase 5.0 推荐）：**直接物理删除 fact 记录**（从 `long.jsonl` 移除），无需 tombstone。同步原子创建 ForgetMarker。
- **兼容方案**（仅在实现层有强一致需求时）：保留最小 tombstone，但严格满足上述 4 条硬约束，同时**仍必须创建 ForgetMarker**（tombstone 与 ForgetMarker 是两个独立机制）。

### 5.2 读写分离三角色（v1.1 修订：消除"唯一"语义冲突）

LongMemory 的读/写权限按角色严格分离，不存在"唯一读+写子系统"的矛盾描述：

#### 角色一：唯一业务消费者（read-only）

| 调用方 | 读 | 写 | 说明 |
|---|---|---|---|
| **CEO / agent 主循环**（R0 context-building） | ✅ `queryFacts`（仅 active）+ `getFact`（仅 active） | ❌ | 唯一消费者；每次只取 `(id, type, subject, value, confidence, evidenceSummary, evidenceCount)`，不展开 evidence 详情 |

#### 角色二：维护所有者（read + 受控 write via MemoryStore API）

| 调用方 | 读 | 写（全部经 MemoryStore typed API） | 说明 |
|---|---|---|---|
| **ReflectionService** | ✅ Episode / MemoryCandidate / active LongMemoryFact | ✅ `appendCandidate` / `promoteCandidate` / `upsertFact`（update） / `mergeFacts` / `supersedeFact` / `compressFactEvidence` | **维护提案者，非直接 mutator**（§4.7）；写者白名单的核心成员；不直接修改 JSONL 或 in-memory 对象 |

#### 角色三：用户命令写入入口（write-only，via ActionHandler）

| 调用方 | 读 | 写 | 说明 |
|---|---|---|---|
| **`memory.remember` Action handler**（注册到 `ActionHandlerRegistry`） | ❌ | ✅ `upsertFact(create/update)` | 用户命令（"记住 X"）；`source='user-explicit'`；**默认 `requiresApproval=false`** |
| **`memory.forget` Action handler**（注册到 `ActionHandlerRegistry`） | ⚠️ 查询存在性（forget 前确认 fact 存在） | ✅ `createForgetMarker` + `forgetFact` / `forgetByQuery` | 用户命令（"忘掉 X"）；**默认 `requiresApproval=false`** |

**禁止**：

- 普通 Cordis 插件、InfoAgent、agent 插件、其他业务代码**直接**调用 `upsertFact` / `supersedeFact` / `mergeFacts` / `compressFactEvidence` / `forgetFact` / `forgetByQuery` / `createForgetMarker`。
- DecisionEngine、AttentionEngine **永远不读不写** Memory（违反 P8 / 决策铁律）。
- WorldState / WorldStateUpdater **不读** Memory（v1.1 仍不包含 Memory → WorldState 投影；P11）。
- ReflectionService **永远不直接修改** JSONL 文件或 in-memory LongMemoryFact 对象（所有写必须经 MemoryStore typed API，§4.7）。

### 5.3 与 ActionExecutor 的对接

- `memory.remember` / `memory.forget` 作为 **ActionHandler** 注册到 `ActionHandlerRegistry`（与 Phase 4.B builtin handlers 同级）。
- Decision 仍维持 D-AGENT-16-03 四态（`act / notify / defer / archive`）；`memory.remember` 与 `memory.forget` 走 `act` 分支。
- **默认 `requiresApproval=false`**（v1.0 用户拍板）：
  - `user-explicit` 命令已隐含用户授权；写长期记忆属于用户在对话上下文中明确请求的动作。
  - 实现层可在配置中显式打开审批（`ORCA_MEMORY_REQUIRE_APPROVAL_USER_EXPLICIT=true`），但**默认关闭**。
- D-AGENT-16-03 已删除 `remember_only → remember` 二次映射——本设计与之**一致**，不引入新的 remember action 终态；显式记忆通过 Attention 规则（或未来 CEO 直接路径）落入 `act(memory.remember)`。

---

## 6. 消费方（CEO/context only）

### 6.1 唯一消费者

- **CEO / agent 主循环**：在 R0 查档扩为"档案 + 记忆双查"。检索时只取 `state='active'` 的 fact，每条只取 `(id, type, subject, value, confidence, evidenceSummary, evidenceCount)` 单行表示，不展开 evidence 详情。

### 6.2 不消费 Memory 的层

| 层 | 是否允许读 Memory | 说明 |
|---|---|---|
| DecisionEngine | ❌ | AGENT.md §4.3 铁律：纯函数；不查 |
| AttentionEngine | ❌ | 纯规则；后续如需引入 memory → rule projection，应通过**配置层**定期物化，不在规则 predicate 中直查（本次不设计，P11） |
| ActionExecutor | ❌ 读；✅ 写（仅注册 handler） | 写走受控 API；handler 内部可读 active fact 决定参数（如 `memory.forget` 先 queryFact 确认存在） |
| NotifyHandler | ❌ | Phase 4.C 严格 Feishu-only |
| DeferredScheduler | ❌ | 与决策分层 |
| ReflectionService | ✅ 读（Episode / Candidate / active Fact）；✅ 写（经 MemoryStore typed API，提案者非 mutator，§4.7） | 维护所有者；写者白名单成员 |
| WorldState / WorldStateUpdater | ❌ | 本次不设计 projection；P11 |
| EventBus | ❌ | 自身是事件流 |

### 6.3 检索注入预算

为控制 token 成本：

- Memory 检索按需触发（CEO 判定问句命中"用户/偏好/习惯"类别时），**不是**每轮全量注入。
- 注入时按 `(type, subject)` 去重 + 按 `confidence` 排序，取 Top-K（默认 5）；超长 subject/value 截断。
- `evidenceSummary` 仅在用户追问某条 fact 的依据时按需拉取。
- `representativeEvidenceIds` **不进** prompt（仅审计/快速解释场景按需）。
- `evidenceCount` 可入 prompt 但需截断。

---

## 7. 存储：MemoryStore 与 InfoRecordStore 的边界

### 7.1 为什么独立 MemoryStore

| 维度 | InfoRecordStore（档案室） | MemoryStore（本稿设计） |
|---|---|---|
| 数据性质 | 领域事实（食物、日程、IM 消息） | 用户/环境知识画像 |
| 主键 | `(namespace, type, ts, source, messageId)` append-only | `(type, subject)` upsert 唯一 active |
| 操作 | append + supersedes（事件溯源风格） | create / update / merge / supersede / compress / forget（状态机） |
| 检索语义 | 信封字段过滤 + payload 关键词 | 类型化字段 + confidence + 关系链 |
| 状态机 | 单态（append-only；supersedes 只是链接） | 二态持久态（active / superseded）；forget 后物理删除 |
| 写入者 | InfoAgent Push + ActionExecutor remember | ReflectionService + 显式记忆 Action handler（更窄） |
| 删除语义 | ttl 软删 + 一键清空 namespace | **forget 默认 hard-purge**；可选 privacy-safe tombstone |
| 未来规模 | 几万到几十万数（事件日志级） | 几百到几千条（知识级，活跃 subset 很小） |

**结论**：两者在数据性质、操作语义、状态机上根本不同；塞进 InfoRecordStore 会导致：
- 信封字段被破坏（必须为 memory 加 `state` / `supersededBy` / `mergedInto` 等结构化字段，违反 D-AGENT-09 "信封字段框架强制 + 检索只依赖信封"）。
- append-only 与 LongMemory 的 upsert 语义冲突。
- 检索 / 删除语义不同，导致 InfoRecordStore 接口被特殊化污染。

### 7.2 独立 MemoryStore 的落地形态

- **Phase A（本稿适用）**：JSONL + 内存索引（与 D-AGENT-09 §7A InfoRecordStore 同模式），目录独立：`app-cordis/data/memory/episodes.jsonl` + `app-cordis/data/memory/long.jsonl` + `app-cordis/data/memory/candidates.jsonl` + `app-cordis/data/memory/audit.jsonl`。
- **内存索引**：active fact 按 `(type, subject)` 哈希；episode 按 `(category, ts)` 索引；candidate 按 `state` 分桶。
- **不引入 SQLite / 向量库**：本阶段查询量在用户级（百/千级），内存索引足够。SQLite 触发条件在 §14 远期扩展。
- **gitignore**：`app-cordis/data/` 已在 `.gitignore`（继承 InfoRecordStore 做法）。

### 7.3 与 D-AGENT-09 的兼容性

- D-AGENT-09 约束的是 InfoRecordStore 的信封；本稿**不修改** InfoRecordStore 信封，仅新增独立 MemoryStore。
- MemoryStore 的字段集（Episode / MemoryCandidate / LongMemoryFact / AuditEvent）由本稿（D-AGENT-17）单独定义，不受 D-AGENT-09 限制。
- 隐私/ttl 语义借鉴 D-AGENT-12，但删除语义更细分（active/superseded 二态持久 + forget hard-purge）。

---

## 8. 隐私与审计

### 8.1 隐私等级

- LongMemory 默认 `privacyLevel='L1'`（用户私有）。
- 日志：所有 Memory 写入**不落明文日志**（对齐 D-AGENT-12）；写操作仅记"写入事实 + 时间戳"结构化事件；不打印 value 全文。
- TTL：fact 不默认 ttl（长期知识是核心价值）；`state='superseded'` 的 fact 永久归档；forget 后默认物理删除。

### 8.2 forget 的隐私实施（v1.1 收紧）

- **默认行为**：`forgetFact(id)` / `forgetByQuery(q)` 物理删除 fact 记录（从 `long.jsonl` 移除），同步原子创建 ForgetMarker + 追加 `AuditEvent{forgotten, actor=user-forget, changedFields=undefined}`（value 内容不进入审计）。
- **隐私硬约束**（详见 §5.1 4 条）：
  1. 正常查询不可见；
  2. tombstone 不保留 value；
  3. tombstone 不可逆 hydrate；
  4. AuditEvent 不记录被遗忘的 value（prevValue/newValue 已从 schema 移除，v1.1）。

### 8.3 一键清空

- 全清：保留独立 MemoryStore 设计下，`DELETE /memory/facts`（Dashboard 按钮；参考 D-AGENT-12 一键清空 namespace 的设计模式），不动 InfoRecordStore。
- 物理删除：直接清空 `app-cordis/data/memory/*.jsonl`（运维级操作）；AuditEvent 同步清空。

### 8.4 审计可见性

- AuditEvent 不可注入 prompt；仅审计 UI / 调试读取。
- 审计写入者：MemoryStore 内部在每个写操作时同步 append（与 write 同一事务，或最终一致；Phase A 用同步）。
- 审计保留期：默认永久（合规要求）；可选 retention 在 §14 远期考虑。

---

## 9. 与现有架构铁律的边界

### 9.1 必须保留的铁律（本设计稿不得打破）

| 铁律 | 来源 | 本稿落点 |
|---|---|---|
| DecisionEngine 纯函数 | AGENT.md §4.3 / §8.3 | §6.2：Decision ❌ 读 Memory |
| ActionExecutor 唯一副作用层 | AGENT.md §4.3 / §8.3 | §5.2：Memory 写入仅 Reflection + 显式 Action handler |
| WorldState 严格只存当前态 | D-AGENT-16-10 | §6.2 / §14：本次不设计 Memory → WorldState 投影 |
| EventBus 滑动窗口 | AGENT.md §4.3 | 不动 |
| InfoAgent 闭集注册表 | D-AGENT-02 | 不动 |
| Decision 四态（无 remember_only） | D-AGENT-16-03 | §5.3：一致 |
| ORCA_ACTION_ENABLED 默认 false | AGENT.md §4.3 | `memory.remember` / `memory.forget` 默认 `requiresApproval=false`（v1.0 拍板）；handler 仍注册到 ActionHandlerRegistry |
| L1 不落明文日志 | D-AGENT-12 | §8.1 |
| 写入受控（ActionHandlerRegistry） | AGENT.md §4.3 / Phase 4.B | §5.3：memory handler 注册到 `ActionHandlerRegistry` |

### 9.2 本稿**不动**的现有组件

- EventBus（`services/eventBus.ts`、`plugins/orca-runtime.ts`）：只读；Memory 不修改其接口。
- WorldState（`services/worldState.ts`、`plugins/world-state-updater.ts`）：只读；不新增 reducer（本次）。
- AttentionEngine / DecisionEngine / ActionExecutor / DeferredScheduler：只读；Memory 仅通过已注册的 Action handler 接入 ActionExecutor。
- InfoRecordStore / InfoAgentRegistry：只读；MemoryStore 是平级新模块，**不修改** InfoRecordStore 信封。
- 所有现有配置键：不增不减（实现阶段再决定 Memory 配置键）。

---

## 10. 与现有决议的交叉索引 / 修订点

> 本节只指出**冲突与修订方向**，**不修改**既有决议条目。

### 10.1 完全兼容（无修订）

- **D-AGENT-09**（InfoRecord 信封 / append-only / supersedes）：本稿不修改 InfoRecordStore；MemoryStore 是独立模块。✅
- **D-AGENT-11**（urgency 门控）：与本稿无关。✅
- **D-AGENT-12**（ttl / 软删 / 硬清 / L1 / 一键清空）：本稿 §8 直接借鉴。✅
- **D-AGENT-16-03**（四态决策，无 remember_only）：§5.3 一致。✅
- **D-AGENT-16-10**（WorldState 当前态）：§14 不设计 Memory → WorldState 投影。✅
- **AGENT.md §4.3 / §8.3**（决策分层铁律）：§6.2 一致。✅

### 10.2 历史未消化冲突（**设计阶段标注，实现阶段清理**）

#### 冲突 A：`createRememberHandler` 与 D-AGENT-16-03 的兼容性

- **现状**（AGENT.md §4.3 + Phase 4.B）：
  - Decision action 映射含 `remember_only → remember`；
  - `createRememberHandler({infoStore})` 把 remember 决策写进 InfoRecordStore `namespace='decision-action', type='decision-remember'`。
- **冲突**：
  - D-AGENT-16-03 已删除 `remember_only → remember` 二次映射，Decision 终态改 `archive`（archive 入档可 R0 检索）。
  - 但 Phase 4.B `createRememberHandler` 仍存在并写 `decision-remember`，与四态语义不一致。
- **本稿态度**：
  - 本次**不修改** ActionExecutor / `createRememberHandler` 实现；
  - 实现 D-AGENT-17 时，应在 Phase 5.1 / 5.2 中收口：`remember` handler 改造为 `archive` handler（写 InfoRecord `type='decision-archive'`，与四态 `archive` 对齐），或直接吸收进 MemoryStore 下的 `memory.remember` handler（与本设计一致）；
  - 决策词汇以 D-AGENT-16-03 为准；AGENT.md §4.3 仍展示旧映射的快照，下次 AGENT.md 同步时统一。

#### 冲突 B：IM Bridge §10 阶段 B "Orca 记忆能力实装"的精确定义

- **现状**（orca-im-bridge.md §10 阶段 B）：
  - 验收 = `infoStore 持久化层（JSONL 已具备）+ D-AGENT-12 隐私工具就绪 + 用户确认"记忆已实装"`。
  - 这隐含把"Memory"等同于 InfoRecordStore。
- **冲突**：
  - 本稿明确：Memory ≠ InfoRecordStore（§7）；InfoRecordStore 是档案室，MemoryStore 是知识库。
  - 用户口头"记忆已实装"的判定标准应以本稿为准：MemoryStore 就绪 + 隐私工具就绪 + 二态持久语义 + 写者白名单 + CEO 双查。
- **本稿态度**：
  - 本次**不修改** orca-im-bridge.md §10 验收措辞；
  - 在 D-AGENT-17 入册时，明确**修订** orca-im-bridge.md §10 阶段 B 验收：增加"MemoryStore（含 EpisodeStore）+ D-AGENT-17 契约"作为前置，InfoRecordStore 是**并行**而非前置（IM Bridge 自身仍用 InfoRecordStore 落 IM 消息档案，但其**接入**依赖 Memory 契约成熟——例如 importantContacts 是否进 Memory？本稿 §14 留作后续决策）。

### 10.3 新增决议（D-AGENT-17）

详见 `guide/decisions.md` 新增条目（D-AGENT-17 v1.0 收敛版）。本稿是设计文档，decisions 是契约性条目；两者一一对应。

---

## 11. 与现有决议的兼容性矩阵（v1.0 重写）

| 既有决议 | 与 D-AGENT-17 v1.0 关系 |
|---|---|
| D-AGENT-09（InfoRecord 信封） | 不修改；MemoryStore 是独立模块 |
| D-AGENT-11（urgency 门控） | 不直接复用；Memory 有独立 confidence 门控 |
| D-AGENT-12（ttl / 软删 / 硬清 / L1） | 直接借鉴；forget 默认 hard-purge（v1.0 收紧） |
| D-AGENT-16-03（四态决策） | 一致；`memory.remember` / `memory.forget` 走 `act` 分支 |
| D-AGENT-16-10（WorldState 当前态） | 一致；本次不引入 Memory → WorldState 投影 |
| AGENT.md §4.3 / §8.3（分层铁律） | 一致；DecisionEngine 不读 Memory；memory handler 必须经 ActionExecutor（不绕过副作用层） |
| Phase 4.B `createRememberHandler` | 冲突 A：实现阶段收口到 archive handler 或 memory.remember handler |
| `orca-im-bridge.md` §10 阶段 B | 冲突 B：实现阶段修订验收措辞 |

---

## 12. 阶段路线建议（不修改实现路线对应代码）

> 本节是建议；TODO.md / dev-log.md / AGENT.md 中路线相关代码/版本号**本次不动**。实现时按 D-VER-04 同步。

### 12.1 与现有路线的衔接

| 现有 | 内容 | 与 Memory 的关系 |
|---|---|---|
| Phase 4.F（TODO.md） | ActionPlan 拆分 + 真实 act handler + bark/邮件 + urgency=2 门控 | **可与 Phase 5.x 并行**：4.F 的 bark/notify 通道扩展开销小；4.F 的"真实 act handler"建议推到 Phase 6（real-act-handler 风险高） |
| Phase 5（dev-log 旧"可选 LLM Attention"） | Attention LLM 增强 | **延后**：Memory 优先级高于此；建议重新编号为 Phase 7（Attention LLM 增强） |
| IM Bridge 阶段 B（orca-im-bridge.md §10） | "Orca 记忆能力实装" P0 阻塞 | **解锁条件**：MemoryStore 就绪 + D-AGENT-17 二态语义 + CEO 双查 |

### 12.2 推荐 Memory 阶段编号

| 编号 | 内容 | 验收 |
|---|---|---|
| **Phase 5.0** | MemoryStore 基础（JSONL + 内存索引 + 受控 API + 写者白名单 + 隐私/审计骨架）；不接消费者 | 单元测试覆盖 active/superseded 二态 + upsert/supersede/merge/compress/forget 操作矩阵；forget 默认 hard-purge；不依赖 LLM |
| **Phase 5.1** | Episode 层（feishu 消息 burst + WorldState 转换派生，纯规则，零 LLM）；CEO 双查（档案 + 记忆）接入 | "今天发生了什么"类问句命中 episode；L1 不落明文日志 |
| **Phase 5.2** | LongMemory create / update / supersede / merge；显式 `memory.remember` / `memory.forget` Action handler（默认 `requiresApproval=false`）；`source='user-explicit'` 直达 active | "记住 X" → 立即可被 R0 检索；"忘掉 X" → fact 物理删除，下次检索不可见 |
| **Phase 5.3** | ReflectionService（每日 / 空闲 tick，配置键 `ORCA_REFLECTION_INTERVAL_HOURS=24`）；MemoryCandidate 门控（confidence ≥ 0.7）；自动晋升 + supersede/merge/compress 在 reflection 周期内触发；evidence 三字段语义落实 | 连续 N 天同 pattern → 自动晋升；新事实取代旧事实 → 旧 fact state=superseded；representativeEvidenceIds 超 5 自动 compress |
| **Phase 6** | 真实 act handler 最小权限白名单（原 Phase 4.F 剩余部分） | 与 Memory 解耦，可独立交付 |
| **Phase 7** | 旧 Phase 5（Attention LLM 增强）顺延 | 不变 |

### 12.3 与 IM Bridge 解锁

- IM Bridge 阶段 B 解锁 = Phase 5.0 + 5.1 完成（EpisodeStore + MemoryStore 骨架 + CEO 双查）。
- 阶段 C/D 后续按 orca-im-bridge.md §10 计划进行；Memory 完整二态（5.2/5.3）非 IM Bridge 阻塞项，但建议 5.2 完成后才允许 IM Bridge 写 `decision-action/act-approval`（避免审批记录未经 LongMemory 思考就落——本期为建议，不强制）。

---

## 13. 仍需用户决策的开放问题（实施阶段拍板即可）

> 用户 2026-09-06 已拍板 §15 中 7 项；本节保留剩余未拍板的实施细节。

| # | 问题 | 默认建议（设计稿立场） |
|---|---|---|
| Q2 | confidence 自动晋升阈值（实现阶段拍板） | 默认 0.7；`ORCA_REFLECTION_PROMOTE_THRESHOLD` 控制 |
| Q4 | `representativeEvidenceIds` 单条 fact 上限 N | 默认 5（用户已拍板）；`ORCA_MEMORY_MAX_REPRESENTATIVE_EVIDENCE` 可覆盖 |
| Q9 | Memory 检索注入 prompt 的 Top-K 与截断 | Top-K=5；value 截断 60 字；evidenceSummary 默认不入主 prompt |
| Q10 | MemoryStore 与 InfoRecordStore 物理目录 | 独立目录（便于备份/迁移/一键清空） |
| Q11 | AuditEvent 保留期 | 默认永久；`ORCA_MEMORY_AUDIT_RETENTION_DAYS` 可覆盖 |
| Q12 | SQLite 切换触发条件 | long facts > 5000 或 query p95 > 200ms 触发；本阶段不实现 |
| Q13（新增） | `ORCA_MEMORY_REQUIRE_APPROVAL_USER_EXPLICIT`（实现层审批开关） | 默认 `false`（v1.0 用户拍板）；用户可在 `.env` 中显式打开 |
| Q14（新增） | `ORCA_REFLECTION_IDLE_TRIGGER`（实现层空闲提前触发开关） | 默认 `true`；用户可在 `.env` 中关闭 |

---

## 14. 附录：交叉索引与远期扩展

### 14.1 与现有决议/文档的引用

| 引用 | 用于 |
|---|---|
| `guide/decisions.md` D-AGENT-09 | InfoRecordStore 边界借鉴（信封设计哲学 vs MemoryStore 结构化字段） |
| `guide/decisions.md` D-AGENT-11 | urgency 门控不直接用于 Memory；Memory 有独立 confidence 门控 |
| `guide/decisions.md` D-AGENT-12 | ttl / 软删 / 硬清 / L1 / 一键清空 |
| `guide/decisions.md` D-AGENT-16-03 | 四态决策（`memory.remember` / `memory.forget` 走 `act` 分支，不新增终态） |
| `guide/decisions.md` D-AGENT-16-10 | WorldState 严格当前态（本次不引入 projection） |
| `guide/orca-info-agent-framework.md` §3 | InfoRecord 信封设计参考 |
| `guide/orca-im-bridge.md` §10 阶段 B | Memory 实装作为 IM Bridge 解锁条件（**修订**提案见 §10.2-B） |
| `AGENT.md` §4.3 / §8.3 | 分层铁律 |
| `dev-log.md` Phase 5（旧"Attention LLM 增强"） | 顺延为 Phase 7 |

### 14.2 设计稿自我约束

- 本稿**不实现**任何 MemoryStore / ReflectionService / handler 代码。
- 本稿**不修改** AGENT.md / TODO.md / dev-log.md 中路线相关代码/版本号；只在新决议（D-AGENT-17）+ 本稿 §12 给出建议。
- 本稿**不修改** InfoRecordStore 信封。
- 本稿**不引入** SQLite / 向量库 / 外部嵌入依赖。
- 本稿**不设计** Memory → WorldState / Attention 投影（P11）。

### 14.3 远期扩展（本次不设计，留作未来 Phase）

- **Memory → WorldState 投影**：habit（如 `user.sleep ≈ 01:00`）影响 WorldState 的 time tick 推导阈值（sleeping 状态判定阈值可由 LongMemory fact 物化）。需新增"memory → reducer 参数"配置层，不破坏 WorldStateUpdater 纯函数。
- **Memory → Attention 规则配置投影**：importantContacts / autoReplyContacts 等可作为 LongMemory fact 存在（type=`person`, subject=`contact.<id>`），Attention 规则配置层定期从 Memory 读取并物化为 `extensions.im.*`。需新增"memory → rule config"配置层，不破坏 Attention 规则纯函数。
- **SQLite 切换**：long facts > 5000 或 query p95 > 200ms 触发；JSONL + 内存索引退役。

---

## 15. 版本记录

### v1.1 → v1.2（2026-08-27，Memory Contract Hardening，D-AGENT-18）

**背景**：Phase 5.3 Reflection Engine MVP 实际暴露了三个 Memory contract 缺口；D-AGENT-18 收口，不重做 Memory 架构。

| # | 问题 | v1.1 状态 | v1.2 修复 |
|---|---|---|---|
| 1 | `CandidateQuery` 未正式纳入 contract | Phase 5.3 已暴露但未文档化 | §3.2 正式定义 `CandidateQuery{state?, type?, subject?, limit?}`；limit 默认 100 上限 1000；按 createdAt 降序截断；MemoryStore 实现已落实 |
| 2 | `isSubjectSuppressed` 仅作为 Phase 5.3 临时新增 API，subject-level 抑制语义未在 contract 中正式确认 | type-scoped `isSuppressed` 已存在；subject-only 版本仅在 reflection 中使用 | §3.5 + §4.6 正式定义：type-scoped `isSuppressed(type, subject)`（保留）与 subject-level `isSubjectSuppressed(subject)`（privacy gate）并存；Reflection promotion 必须使用 subject-level 版本 |
| 3 | `promoteCandidate()` 无 user-explicit 保护 invariant；ReflectionEngine 层 guard 不是最终安全边界 | ReflectionEngine 层 guard，依赖调用方正确实现 | §4.6 明确：`MemoryStore.promoteCandidate()` 内部强制检查 user-explicit 冲突；任何未来调用 promoteCandidate 的 subsystem 自动受到保护；ReflectionEngine 层 guard 仅作 early-exit 优化 |

**新增内容**：

- §3.2 `CandidateQuery` 正式 contract（含 limit）
- §3.5 v1.2 补充：subject-level 抑制语义
- §4.6 v1.2 修订：双重 gate（type-scoped + subject-only）+ MemoryStore invariant
- §5.1 MemoryStore API 新增 `queryCandidates(q)` + `isSubjectSuppressed(subject)`

**v1.1 已完成且 v1.2 未改动的关键设计**：

- LongMemory 二态持久 + forget 默认 hard-purge
- ForgetMarker data model 与 fingerprint 算法
- Reflection 六职责 + 写权限边界（proposer ≠ mutator）
- memory.remember / memory.forget handler 路径
- CEO / context 唯一消费者约束
- 与 D-AGENT-09 / D-AGENT-11 / D-AGENT-12 / D-AGENT-16 边界

**Rule A 定位收敛**（v1.2 配套说明）：

- 当前 Rule A（`message.burst × sender → behavioral_pattern/high_burst_frequency`）**仅用于验证 Reflection pipeline 的 deterministic candidate generation**。
- **不要**把它描述成已经成熟的"用户长期行为推断"。
- **不要**扩展成 personality inference。
- 后续真正有价值的 Reflection rule（user preference / repeated explicit choices / stable user behavior）需另行设计。

---

### v1.0 → v1.1（2026-09-07，架构安全修订）

**背景**：用户对 v1.0 进行了 5 项架构安全 review，发现真实 architectural gaps：

| # | 问题 | v1.0 状态 | v1.1 修复 |
|---|---|---|---|
| 1 | 读/写 ownership 语义冲突：v1.0 §5.2 说"ReflectionService 是唯一读+写子系统"，§6.2 说"CEO/context 是唯一消费者"，两处"唯一"指向不同维度但表述冲突 | 措辞矛盾，存在安全边界歧义 | §5.2 改为"读写分离三角色"表（角色一：CEO 消费者只读；角色二：Reflection 维护者经 API 写；角色三：memory handler 用户命令写入入口）；§6.2 移除"唯一允许 read+write"措辞 |
| 2 | forget 可被 Reflection 重新生成：用户 forget "我喜欢咖啡"后，Reflection 未来从旧 Episode 重新推断相同事实，导致 privacy bypass | 未考虑抑制机制 | 新增 ForgetMarker（§3.5） + §4.6 完整生命周期 + MemoryStore.createForgetMarker API + Reflection candidate 生成门控（fingerprint 匹配 + type 作用域） |
| 3 | AuditEvent prevValue/newValue 与 hard-purge 隐私冲突：v1.0 TL;DR 说"forget 不记录 value"，但 AuditEvent schema 仍有 prevValue/newValue 字段 | TL;DR 与 schema 矛盾 | AuditEvent schema 移除 prevValue/newValue（§3.4）；改用 changedFields[] 做字段级变更追踪；v1.1 迁移说明明确历史数据无需回填 |
| 4 | Reflection 写权限未明确边界：ReflectionService 有读写权限，但未明确"是 proposer 而非 mutator"，存在 LLM 驱动无界 JSONL 写入风险 | 未明确 proposer/mutator 分离 | 新增 §4.7 Reflection 写权限边界：维护提案者 + MemoryStore 为 mutation authority + 四类操作的处理路径表 + 禁止直接修改 JSONL |
| 5 | LongMemoryFact/MemoryCandidate/AuditEvent/ForgetMarker 职责重叠：需要验证四者边界 | 未明确验证 | §3.5 §4.6 §3.4 交叉验证：LongMemoryFact（当前状态）/ MemoryCandidate（待推断）/ AuditEvent（操作元数据，非内容备份）/ ForgetMarker（抑制身份，无 content）——职责无重叠 |

**新增内容**：

- §3.5 ForgetMarker 数据模型（id/fingerprint/subject/type/createdAt/createdBy，fingerprint = sha256(salt, lower(subject)) 前 16 字符）。
- §4.6 ForgetMarker 完整生命周期（forget → createForgetMarker + forgetFact 原子 → Reflection candidate 生成门控）。
- §4.7 Reflection 写权限边界（proposer vs mutator + 四类操作的处理路径）。
- §5.1 MemoryStore API 新增 `createForgetMarker` + `queryForgetMarkers`。
- §5.2 读写分离三角色表（消除"唯一"语义冲突）。
- AuditEvent schema 移除 prevValue/newValue（v1.1）；TL;DR 同步更新。

**v1.0 已完成且 v1.1 未改动的关键设计**：

- LongMemory 二态持久（active/superseded）+ forget 默认 hard-purge。
- Evidence 三字段语义（representativeEvidenceIds ≤ 5 + evidenceSummary ≤ 200 + evidenceCount）。
- Reflection 六职责（Discover / Update / Merge / Supersede / Compress / Promote）。
- memory.remember / memory.forget 默认 requiresApproval=false。
- CEO/context 为唯一消费者；DecisionEngine/AttentionEngine/WorldState/NotifyHandler/DeferredScheduler/EventBus 不读 Memory。
- MemoryStore 与 InfoRecordStore 独立边界（JSONL + 内存索引）。
- 阶段路线（Phase 5.0–5.3 + Phase 6/7）。

---

### v0.1 → v1.0（2026-09-06 下午，用户拍板）

| # | 用户拍板项 | v0.1 | v1.0 修订 |
|---|---|---|---|
| 1 | subject 命名空间 | 弱约定 + prefix 匹配（默认建议） | **明确**：弱约定 + prefix；documented in §3.3 / §14 |
| 2 | Reflection 周期 | 每日固定 + 空闲提前触发（默认建议） | **明确**：配置键契约 `ORCA_REFLECTION_INTERVAL_HOURS=24` + `ORCA_REFLECTION_IDLE_TRIGGER=true`；不落代码 |
| 3 | `memory.remember` 默认审批 | 默认 `requiresApproval=true`（不可逆决策） | **改为** 默认 `requiresApproval=false`（用户显式命令已隐含授权）；handler 仍必须经 ActionExecutor，不绕过副作用层；可通过 `ORCA_MEMORY_REQUIRE_APPROVAL_USER_EXPLICIT` 显式打开 |
| 4 | forget 默认行为 | 默认软删不立即硬清（`hardPurge=true` 才物理删除） | **改为** 默认 hard-purge；soft-delete 仅作为"实现层一致性 / 审计 / 索引需求"的可选 tombstone 机制，且必须满足 §5.1 4 条隐私硬约束 |
| 5 | evidence 字段 | `evidenceIds` ≤ 5 条（理解为最多 5 条历史证据） | **改为** Evidence 三字段：`representativeEvidenceIds` ≤ 5（快速解释/审计）+ `evidenceSummary` ≤ 200 字符 + `evidenceCount` 单调递增；完整 Episode 历史仍由 EpisodeStore 保存 |
| 6 | LongMemory 持久状态 | 三态 `active` / `superseded` / `deleted` | **改为** 二态持久 `active` / `superseded`；`deleted` 不再作为持久态；forget 默认物理删除；可选 tombstone 受 §5.1 隐私硬约束保护 |
| 7 | LongMemory 核心语义 + Reflection 职责 | 已明确（v0.1） | 保持不变；仅在 §0 / §4.3 / §4.4 / §11 中强化措辞与对齐 |

**v1.0 新增内容**：

- `AuditEvent.kind` 收紧：移除 `'hard-purged'` + 移除 `actor: 'system-prune'`。
- `AuditEvent.actor` 仅保留 `'reflection'` / `'user-explicit'` / `'user-forget'`。
- `forget` 审计硬约束：`prevValue` / `newValue` 强制 undefined。
- `MemoryStore.queryFacts` 默认不再返回 `'deleted'`。
- 设计原则新增 P11（不设计 Memory → WorldState / Attention 投影）。
- 实施阶段开放问题新增 Q13 / Q14（审批开关、空闲触发开关）。

---

*设计稿 v1.2（2026-08-27，D-AGENT-18 Memory Contract Hardening，已收敛）— 收口 Phase 5.3 暴露的三个 contract 缺口，不重做 Memory 架构。已落代码：Phase 5.3 (Episode + Reflection MVP) + Phase 5.3.1 (D-AGENT-18 hardening)。按 D-VER-04 同步 AGENT.md / TODO.md / dev-log.md。*