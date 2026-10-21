# Phase 7.3 Architecture Review Report
**Project Orca — 2026-09-08**
**Phase 7.3 Review + Orca v1.0 Roadmap Freeze**

---

## 1. 当前 Orca 能力地图

### Runtime 核心（已冻结）

```
EventBus（滑动窗口 200）
    ↓
WorldStateUpdater（Reducer 模式，无外部 applyUpdate 调用）
    ↓
AttentionEngine（规则评估 → dedup → throttle）
    ↓
DecisionEngine（纯函数：AttentionItem → Decision，零副作用）
    ↓
ActionExecutor（Decision → ActionResult，唯一副作用层）
```

### 支撑层

| 模块 | 状态 | 备注 |
|------|------|------|
| Feishu Channel | ✅ | webhook 接收，8100 端口 |
| SchedulerAdapter | ✅ | 纯 `scheduler:tick` 发射，无业务逻辑 |
| ScheduledRuleRegistry | ✅ | predicate 驱动，`lastTriggeredAt` 私有 |
| Rule Factory | ✅ | env 驱动，briefing/reflection/reminder 三规则 |
| SessionStore | ✅ | JSONL 追加写，lazy load，restart 恢复 |
| MemoryStore | ✅ | LongMemory + Episode + Candidate + ForgetMarker |
| ReflectionEngine | ✅ | 手动触发，deterministic rule，subject-level privacy gate |
| MemoryAttentionAdapter | ✅ | Memory → AttentionItems 注入，polling + event-driven |
| ContextAssembler | ✅ | CEO 双查（档案 + Memory），R3 budget，scoring，L2/L3 conflict detection |
| EpisodeEngine | ✅ | message.burst + state.transition，7d TTL prune |

### 未启用（默认关闭）

| 模块 | 默认 | 说明 |
|------|------|------|
| ORCA_ACTION_ENABLED | 0 | ActionExecutor 默认禁用（安全默认值） |
| ORCA_RUNTIME_ENABLED | 0 | 完整 Runtime 默认关闭 |
| ORCA_SCHEDULER_ENABLED | 0 | Scheduler adapter 默认关闭 |
| ORCA_PC/CALENDAR/PHONE_ENABLED | 0 | 全部 mock adapters |

---

## 2. 已冻结架构边界

以下边界经 Phase 7.1 Architecture Freeze Review 确认，违反 = 架构破坏：

1. **EventBus 是唯一状态入口**：`applyUpdate()` 仅由 `world-state-updater.ts` 内部调用
2. **SchedulerAdapter 是纯 Time Producer**：只发射 `scheduler:tick`，无业务逻辑
3. **ScheduledRuleRegistry 是纯 Evaluator**：`lastTriggeredAt` Map 内部私有
4. **Rule predicate 是纯函数**：不调用 LLM / 发飞书 / 写 Memory / 访问 WorldState
5. **WorldState 是 Pure Reducer**：无 polling，无外部 `applyUpdate` 调用
6. **DecisionEngine 是纯函数**：无 IO / 无副作用 / 不调 LLM
7. **ActionExecutor 是唯一副作用层**：`ORCA_ACTION_ENABLED=0` 默认禁用
8. **MemoryStore 是唯一长期记忆源**：`ContextAssembler` 只读

---

## 3. 当前 Runtime 数据流 Review

### 3.1 越权调用检查

| 检查项 | 结果 |
|--------|------|
| AttentionEngine 是否访问 MemoryStore | ❌ 未访问（正确） |
| DecisionEngine 是否访问 MemoryStore | ❌ 未访问（正确） |
| DecisionEngine 是否调 LLM | ❌ 未调用（正确） |
| WorldState 是否主动 polling | ❌ 无 polling（正确） |
| ScheduledRule predicate 是否调用外部服务 | ❌ 仅 `bus.publish()`（正确） |
| ActionExecutor 是否直接写 EventBus | ❌ 仅通过 handler（正确） |

**结论：无越权调用。**

### 3.2 隐式状态修改检查

| 检查项 | 结果 |
|--------|------|
| `lastTriggeredAt` 是否暴露在 public interface | ❌ 私有 Map，Registry 内部（正确） |
| EventBus 滑动窗口是否产生隐式状态 | ⚠️ 有限窗口（200），超出自动丢弃，可接受 |
| MAA `seenFacts` Map 是否产生隐式去重状态 | ⚠️ 内存 Map，重启丢失，仅影响 MAA 自身，不影响其他层 |

**结论：无隐式状态修改导致的不一致。**

### 3.3 架构耦合检查

| 耦合点 | 性质 | 评估 |
|--------|------|------|
| AttentionEngine → WorldState | 同步快照读取 | ✅ 正常依赖 |
| DecisionEngine → AttentionEngine | 事件订阅 | ✅ 单向 |
| ActionExecutor → DecisionEngine | 事件订阅 | ✅ 单向 |
| MAA → MemoryStore | 直接 API 调用 | ✅ 正常依赖 |
| ContextAssembler → MemoryStore | 直接 API 调用 | ✅ 正常依赖 |
| ScheduledRuleRegistry → EventBus | 双向（subscribe + publish） | ✅ 受控 |

**结论：无循环依赖，依赖链单向无环。**

### 3.4 发现：Memory → Runtime 闭环缺口

当前 Memory 与 Runtime 的关系：

```
MemoryStore
    ↓
MemoryAttentionAdapter（polling 5 facts）
    ↓
ctx.emit('orca/attention', item)  ← AttentionItems 注入 EventBus
    ↓
AttentionEngine（evaluate）
    ↓
DecisionEngine（decide）
    ↓
ActionExecutor（execute）
    ↓
memory.remember / memory.forget  ← 写回 MemoryStore
```

**MAA 产生的 AttentionItem action 是 `remember_only`**（D-AGENT-19 固定映射），对应 `ActionExecutor` 中的 `remember` → `noopHandler`（Phase 4.B 默认），**不触发真正的写操作**。真正写 Memory 的路径是：

```
Decision.action = 'remember'
    ↓
ActionExecutor → memory.remember handler
    ↓
MemoryStore.upsertFact(source='user-explicit')
```

但 MAA 的 `remember_only` 在 Decision 层被映射为 `remember` 时，对应的是 Phase 4.B 的 `createRememberHandler`（写 `infoStore`，不是 `MemoryStore`）。**Phase 5.2 的 `memory.remember` handler 才是写 LongMemory 的**。

**MAA 的 `remember_only` 实际走的是 `noopHandler`，不会写 LongMemory**。这是一个已知的架构空白：MAA 产生的 Memory insight 没有真正注入 LongMemory 的路径。

**影响评估**：
- 对话中 Memory 影响行为（通过 ContextAssembler → CEO）—— 这个路径是通的
- Memory insight 驱动 Runtime 主动行为（through MAA → Attention → Decision → Action）—— **这个路径未打通**

---

## 4. Memory 与 Personal Context Review

### 4.1 当前 Memory 闭环

```
用户行为（飞书消息 / 状态转换）
    ↓
EpisodeEngine（message.burst / state.transition）
    ↓
ReflectionEngine（reflectNow() 手动调用）
    ↓
MemoryCandidate → MemoryStore.promoteCandidate()
    ↓
LongMemoryFact (active)
    ↓
ContextAssembler.assemble()
    ↓
CEO Context（对话时注入 prompt）
```

### 4.2 缺失点

| 缺失 | 说明 | 影响 |
|------|------|------|
| **Reflection 未接入 Scheduler** | ReflectionEngine 现在是手动触发（`reflectNow()` / `reflectRecent(n)`），没有定时调度 | LongMemory 不会自动从 Episode 生成 Candidate，用户必须主动触发或通过其他事件驱动 |
| **ContextAssembler 不在 Runtime 路径** | ContextAssembler 只在 CEO 对话时注入 prompt，不影响 Attention/Decision | Memory 无法影响 Runtime 的主动行为（Attention/Decision/Action） |
| **MAA `remember_only` 不写 Memory** | MAA 产生的 `remember_only` → `noopHandler`，不写 LongMemory | Memory insight 只能通过 CEO 对话被召回，不能驱动主动通知 |

### 4.3 Memory 实际可用能力

| 能力 | 状态 |
|------|------|
| 记住用户显式偏好（`memory.remember` action） | ✅ 可用，需 Decision action = `remember` |
| CEO 召回历史对话上下文 | ✅ ContextAssembler 已集成 |
| 忘记（`memory.forget` action） | ✅ 可用 |
| ForgetMarker subject-level 抑制 | ✅ 已实现 |
| Episode 生成（burst + state.transition） | ✅ 已实现 |
| Reflection（deterministic） | ✅ 手动触发 |
| Memory → Attention（polling） | ✅ MAA 已实现，但 action 不打通 |

---

## 5. Scheduler 与主动能力 Review

### 5.1 当前 Scheduler → Action 完整路径

```
SchedulerAdapter（setInterval tickMs）
    ↓
EventBus.publish({ source:'scheduler', type:'scheduler:tick' })
    ↓
ScheduledRuleRegistry（evaluate predicates）
    ↓
EventBus.publish({ source:'scheduler', type:'briefing:due' })
    ↓
WorldStateUpdater（无 reducer → 忽略）
    ↓
AttentionEngine（business event 进入评估）
    ↓
DecisionEngine（AttentionItem → Decision）
    ↓
ActionExecutor（Decision → ActionResult）
    ↓
NotifyHandler / memory.remember / defer / noop
```

**Scheduler 到 Action 的完整链路已存在并验证。**

### 5.2 当前缺失的不是路径，是内容

| 缺失 | 说明 |
|------|------|
| **Briefing rule 只发射事件，无内容生成** | `briefing:due` 事件没有附带"今天天气如何/有什么日程"等上下文内容 |
| **NotifyHandler 需要 chatId** | `briefing:due` 来源是 scheduler，原始事件 data 里没有 `chatId`，NotifyHandler 依赖它来发送 |
| **Reflection/Reminder rule 同样只有事件，无内容** | `reflection:due` / `reminder:due` 没有附带待反思内容/提醒内容 |

### 5.3 结论

Scheduler 的主动能力基础设施**已经完整**，问题是业务内容生成层（LLM 生成 briefing 内容 / 反思内容 / 提醒内容）和投递目标配置（默认 chatId）还未实现。

---

## 6. Session Persistence Review

### 6.1 能力确认

| 能力 | 状态 |
|------|------|
| JSONL append-only 追加写 | ✅ 已实现 |
| lazy load（首次 get 前不读文件） | ✅ 已实现 |
| restart 恢复 | ✅ 通过 `reload()` + `ensureLoaded()` |
| 多 session 隔离（sha256 hex16） | ✅ 已验证 |
| 滑动窗口（maxTurns） | ✅ 内存 + 恢复时同步截断 |
| dashboard session | ✅ 已验证 |
| clear 后文件截断 | ✅ `truncate(0)` |
| 飞书 openId / 特殊字符 sessionId | ✅ sha256 安全文件名 |

### 6.2 已识别 limitation（Phase 7.3 范围外）

| 问题 | 说明 | 优先级 |
|------|------|--------|
| **JSONL 文件无限增长** | `maxTurns` 只控制内存返回条数，append 文件无限增长 | 低（文件大小可控，用户量级） |
| **Dashboard session 永不清理** | 无 TTL 或大小限制 | 低 |
| **Session 数据无备份/迁移机制** | 只能手动复制 JSONL 文件 | 低 |

### 6.3 结论

Session Persistence **已满足长期运行需求**。无必须立即解决的技术债务。

---

## 7. Orca v1.0 建议路线

### 设计原则

从"个人 AI 使用价值"角度：Orca 首先要做到的是**主动提醒你关心的事**，而不是回答问题（那是 Phase 1~2 已经解决的）。

v1.0 的核心价值主张：**Orca 比你更记得你的事，并在对的时间提醒你。**

### 推荐顺序

#### 第一优先级：Morning Briefing 业务闭环（Phase 7.3 续）

**价值**：每天早上主动推送今日相关上下文（天气/日程/待反思内容），让 Orca 从"问答机器人"升级为"主动助理"。

**需要做的事**：
1. 配置层：添加 `ORCA_BRIEFING_CHAT_ID`（默认投递 chatId）
2. Briefing Rule：保留 `briefing:due` 事件，但 NotifyHandler 在无原始 chatId 时 fallback 到 `ORCA_BRIEFING_CHAT_ID`
3. Briefing 内容生成：Phase 1 最小化——从 WorldState / 最近 Episode / Memory 提取上下文，拼接成固定格式文本（不调 LLM）
4. 移除 `TEST_RULE_ALWAYS_TRIGGER`

**不做的事**：不引入 LLM 生成内容（留 Phase 7.4）

**验收标准**：
- 开启 `ORCA_SCHEDULER_BRIEFING_ENABLED=1` + `ORCA_BRIEFING_CHAT_ID=<chatId>`
- 每 4h 收到一条飞书消息，内容包含：时间/状态/最近活跃摘要

---

#### 第二优先级：Reminder 业务闭环

**价值**：定时提醒（如"下午 3 点提醒开会"），让 Orca 替代手机闹钟的一部分功能。

**需要做的事**：
- `reminder:due` → Attention → Decision → Action → Notify
- 与 Briefing 类似，但内容来自用户配置的提醒词（最简单的实现：预设模板 + 固定内容）

---

#### 第三优先级：Reflection 自动调度接入 Scheduler

**价值**：让 LongMemory 自动从 Episode 中提炼行为模式，不需要用户手动触发。

**需要做的事**：
- 在 `ScheduledRuleRegistry` 中注册一个 `reflection:due` rule（已有 predicate）
- `reflection:due` → `MemoryAttentionAdapter` → Attention → Decision → Action → MemoryStore（promoteCandidate）
- 实际上是让 ReflectionEngine 作为 Scheduler 的消费者，自动定期运行

---

#### 第四优先级：Memory → Runtime 主动行为打通

**价值**：让 Orca 的记忆真正影响主动行为（如"你上周提到想换工作，记得吗？"）。

**需要做的事**：
- 解决 MAA `remember_only` → `noopHandler` 的空白
- 选项 A：MAA 的 AttentionItem 直接触发 `memory.remember` action
- 选项 B：新增 `contextual-notify` action，当 Memory insight 达到高优先级时主动推送
- 需要配合 ContextAssembler 的 conflict detection（已实现），避免推送矛盾信息

---

### 不进入 v1.0 的能力

以下能力按"价值 vs 复杂度"评估，暂不进入 v1.0：

| 能力 | 原因 |
|------|------|
| Voice / 语音唤醒 | P2；依赖硬件；增加隐私顾虑 |
| Camera 视觉感知 | P2；侵入性强；增加隐私顾虑 |
| Multi-agent | v1.0 单用户场景不需要 |
| Tool marketplace | Orca 是 personal，不是 enterprise |
| Cloud sync | 与 local-first 定位冲突；增加复杂度 |
| Database migration（SQLite） | JSONL 足够单用户百/千量级 |

---

## 8. 下一阶段推荐顺序

```
当前状态
    ↓
Phase 7.3（续）：Morning Briefing 完整闭环
    · 配置化 chatId fallback
    · 固定格式 briefing 内容生成（WorldState + Episode 拼装）
    · 移除 TEST_RULE_ALWAYS_TRIGGER
    ↓
Phase 7.4：Reminder 闭环
    ↓
Phase 7.5：Reflection Scheduler 接入
    ↓
Phase 7.6：Memory → Runtime 主动行为打通（MAA remember_only 修复）
    ↓
Orca v1.0（feature freeze）
```

---

## 9. 总结

### 当前最大能力缺口

1. **MAA `remember_only` 走 noop**——Memory insight 无法驱动主动行为（最高优先级修复）
2. **Reflection 无自动调度**——LongMemory 依赖手动触发，长期记忆不会自动更新
3. **Morning Briefing 无内容生成**——Scheduler 路径已通，但事件无附带内容

### 架构就绪度

| 维度 | 就绪度 |
|------|--------|
| EventBus Runtime | ✅ 完全就绪 |
| WorldState | ✅ 完全就绪 |
| Attention + Decision | ✅ 完全就绪 |
| Action Executor | ✅ 完全就绪 |
| Memory 系统 | ✅ 完全就绪（除 MAA → Runtime 路径） |
| Scheduler | ✅ 完全就绪 |
| Session Persistence | ✅ 完全就绪 |
| 主动行为内容生成 | ❌ 未实现 |
| Scheduler 业务接入 | ❌ 未实现（Rule predicate 已通，内容未通） |

**结论**：Orca Runtime 基础设施已经完整，具备 v1.0 的架构基础。下一阶段应聚焦在**让 Scheduler 产生真实业务价值**，而不是继续扩展 Runtime 架构。
