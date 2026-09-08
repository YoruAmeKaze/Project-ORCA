# IM Bridge v1 Architecture Review

> 日期：2026-09-06
> 依据：`guide/orca-im-bridge-report.md`（第一版设计）+ Orca 新定位（Local-first Personal AI Agent Runtime / "感知个人消息流，辅助处理低价值沟通"）
> 性质：**Review 报告，非实现稿**；不写代码，仅输出设计裁决

---

## 0. 定位再确认

**原定位（偏聊天机器人）**：
> "让 Orca 当 QQ/微信的消息代理——消息进，决策四种形态，再回送原平台"

**Review 后的定位（切合 Orca 定位）**：
> "让 Orca 感知个人消息流，在明确授权的场景下辅助处理低价值沟通，其余交还用户决定"

**核心差异**：

| 维度 | 旧定位 | 新定位 |
|---|---|---|
| 自动回复 | 核心功能，主动出击 | 有限授权场景下的辅助 |
| LLM 使用 | 默认，审批是例外 | 最小化，大多数消息不进 LLM |
| IM 消息价值 | 需要经过 Attention 评估 | 大多数消息是"背景噪音" |
| 设计目标 | 全功能 IM 中转 | MVP：观察 → 通知 → 有限自动回复 |

---

## 1. Runtime 边界 Review

### 现状判定

```
IM Adapter
  ↓
EventBus
  ↓
Attention
  ↓
Decision
  ↓
ActionExecutor
```

| 边界约束 | 现状 | 判定 | 说明 |
|---|---|---|---|
| Adapter 不承担业务决策 | ✅ | PASS | normalize() 是纯函数，无 if-else 业务逻辑 |
| Adapter 不直接调用 LLM | ✅ | PASS | normalize() 无网络请求，无 LLM 调用 |
| Adapter 不直接发送回复 | ⚠️ | **需澄清** | ImAdapter.sendText() 在接口里，但调用权在 ActionExecutor——adapter 提供传输能力，不自主决策发送 |
| Adapter 不直接修改 Memory | ⚠️ | **需重构** | imArchiver.push() 目前直接调 infoStore.append()，与 Memory 层的关系不清晰 |

### 需要修改的设计

**问题 1：Adapter 的 sendText 在接口里，但调用链正确**

现有 `ImAdapter.sendText()` 是对的（ActionExecutor 控制调用权），但命名容易误导——看起来像"Adapter 自动发送"，实际是"Adapter 提供发送能力"。

**裁决**：保留接口，改名为 `transportText()` 更清晰：

```ts
interface ImAdapter {
  // ... normalize() ...
  /**
   * Orca ActionExecutor 通过此方法发送消息。
   * - 调用权在 ActionExecutor，不在 Adapter 自主决策
   * - Adapter 只负责协议传输
   */
  transportText(target: { chatId: string; isGroup: boolean }, text: string): Promise<{ ok: boolean; error?: string }>
}
```

**问题 2：imArchiver 直接写 infoStore，与 Memory 层边界不清**

Phase 6 Memory 的 MemoryArchiver 是统一归档入口，IM 消息的持久化应该通过 EventBus 订阅由 MemoryArchiver 统一处理，而不是 imArchiver 直接调 infoStore。

**裁决**：重划边界——imArchiver 退化为"协议解析 + EventBus 发布"，Memory 写入由 MemoryArchiver 负责（Phase 6 Memory 框架内）。当前设计 imArchiver.push() 并行于 EventBus.publish 是对的，但写入路径要统一。

### 保留设计（Runtime 边界）

```
IM Adapter.normalize()
    ↓
EventBus.publish({ source:'im.qq', type:'im.message.received', data:{ envelope } })
    ↓ 分叉
┌─► WorldStateUpdater（更新 contact lists + user.status）
└─► MemoryArchiver（统一写入，所有 source 共用）
         ↓
    AttentionEngine（规则评估，不是所有消息都触发）
         ↓
    DecisionEngine
         ↓
    ActionExecutor
```

**关键约束确认**：
- Adapter 的唯一输出是 `MessageEnvelope`
- Adapter 不做 Attention 判断
- Adapter 不决定是否归档
- Adapter 不决定是否回复

---

## 2. Event 设计 Review

### 2.1 核心问题：received vs. sent 缺失

**现有设计**：
```ts
// EventBus 只有一种 IM 消息类型
source: 'im.qq'
type: 'im.message'
```

**问题**：
- Orca 发送的回复（经 ActionExecutor → im.send）没有记录进 EventBus
- Orca 无法感知"自己发了什么"，Audit Log / 存档均缺失
- received/sent 不分，Attention 规则无法区分"有人给我发消息"和"Orca 刚代我回复了"

### 2.2 裁决：增加 direction 字段

在 `MessageEnvelope` 级别加 `direction`：

```ts
interface MessageEnvelope {
  // ... 现有字段 ...
  /** 消息方向：in = 收到，out = 发出 */
  direction: 'in' | 'out'
}
```

Event 类型相应更新：

| direction | Event type | 来源 |
|---|---|---|
| `in` | `im.message.received` | Adapter.normalize() → EventBus |
| `out` | `im.message.sent` | imSendActHandler → EventBus.publish() |

**为什么 sent 也走 EventBus**：Audit Log 完整性 + Attention 未来可能需要感知"发出了什么消息"（如：发出后对方没回复，可能需要 follow-up 提醒）。

### 2.3 namespace 不重复

`namespace = im-bridge` 统一存储，方向通过 `envelope.direction` 区分，**不需要按 direction 拆 namespace**。

### 2.4 Event type 命名原则对照

| 现有 type | 问题 | 建议 | 原因 |
|---|---|---|---|
| `im.message` | 过于笼统，分不清收/发 | `im.message.received` / `im.message.sent` | 符合 Orca event 命名规范（`${source}.${detail}`） |
| `im.send` | 与 ActionExecutor 的 action 概念混淆 | 删除 or 改为 `im.message.outbound` | `im.send` 不是事件，是 Action |

### 2.5 保留的 Event 设计

```ts
// 入站（Adapter → Runtime）
Event {
  id: randomUUID(),
  source: 'im.qq' | 'im.wechat',
  type: 'im.message.received',
  ts: envelope.ts,
  data: { envelope: MessageEnvelope & { direction: 'in' } }
}

// 出站（ActionExecutor → Audit Log）
Event {
  id: randomUUID(),
  source: 'im.qq' | 'im.wechat',
  type: 'im.message.sent',
  ts: Date.now(),
  data: { envelope: MessageEnvelope & { direction: 'out' }, text: string, decisionId: string }
}
```

---

## 3. Auto Reply 设计 Review

### 3.1 核心问题：四态模型不符合 Orca 定位

**现有模型（偏聊天机器人）**：
```
act / notify / defer / archive
```

**问题**：
- `act` = 代回，但隐含了"是否需要审批"——审批逻辑藏在 requiresApproval 字段里，决策逻辑不透明
- `notify` 和 `defer` 都走飞书通知，区别只是时机，LLM 使用量相同，不应该合并为同一 Decision action
- `archive` 是静默丢弃，用户无感知，不符合"感知消息流"的定位

**Orca 新定位下的正确模型**：

```
ignore / notify / suggest_reply / auto_reply
```

### 3.2 四态含义（重新定义）

| 状态 | 含义 | LLM 介入 | 用户操作 |
|---|---|---|---|
| `ignore` | 低价值消息，Orca 看到了但什么都不做，不进用户视野 | ❌ | 无 |
| `notify` | 重要消息，需要告知用户，但不代回 | ❌（纯规则）| 用户自行决定如何回复 |
| `suggest_reply` | Orca 起草了回复，供用户确认/修改后发出 | ✅（起草）+ ❌（确认发出）| "确认发送" 或 "修改" 或 "忽略" |
| `auto_reply` | 用户已授权的简单场景，Orca 直接发出 | ❌ | 无（但发送后飞书通知用户"已代回 X"） |

### 3.3 Attention → Decision 映射（修订）

```
AttentionItem.action          Decision.action
──────────────────────────────────────────
ignore                 → ignore
notify_immediately     → notify
wait_until_available   → defer（在 suggest_reply 之后才提醒）
auto_reply (whitelisted) → auto_reply
needs_review           → suggest_reply
```

### 3.4 requiresApproval 字段是否保留？

**结论：不需要 requiresApproval 字段。审批逻辑内化为 suggest_reply 专用的审批流程。**

旧设计：
```
Decision { action: 'act', requiresApproval: true/false }
```

新设计：
```
Decision { action: 'suggest_reply' }  → 触发审批流
Decision { action: 'auto_reply' }     → 直接发出
```

### 3.5 auto_reply 的触发条件（MVP 限定）

auto_reply（无需审批直接发出）必须同时满足：

| 条件 | 说明 |
|---|---|
| `senderId ∈ autoReplyContacts` | 用户明确授权的白名单 |
| `envelope.direction = 'in'` | 必须是收到的消息 |
| `envelope.isGroup = false` | 不在群聊（群消息风险高） |
| `envelope.attachments = undefined` | 无附件，纯文本 |
| `text 匹配固定格式` | 快递取件码 / 外卖通知 / 系统告警等结构化文本 |
| `text 长度 ≤ N` | 简单内容，不超过阈值（如 20 字） |

**以上全是规则判断，不需要 LLM。**

### 3.6 suggest_reply 的触发条件（LLM 参与）

suggest_reply（需要 LLM 起草回复供确认）：

| 条件 | 说明 |
|---|---|
| `senderId ∈ importantContacts` | 重要联系人 |
| `semantic complexity > threshold` | 文本复杂，需要理解（LLM 介入） |
| `envelope.mentionedMe = true` | 群聊 @ 了 Orca |
| `包含多轮上下文` | 需要回顾对话历史才能回复 |
| `包含敏感意图` | 涉及金钱/约见/承诺 |

### 3.7 裁决：四态 vs. 五态

**建议维持四态（ignore/notify/suggest_reply/auto_reply）**，不引入第五态：

- `defer` 可以合并进 `notify`（Orca 在用户可用时提醒，决策类型仍是 notify，不需要单独出来）
- 如果未来需要"延后到时间 X 再提醒"，那是 Phase 4.D DeferredScheduler 的职责，不是 Decision action

---

## 4. LLM 边界 Review

### 4.1 核心原则

**Orca 是 Local-first Personal AI Agent Runtime，不是通用聊天机器人。**

这意味着：
- LLM 是**稀缺资源**，不是默认选项
- 大多数 IM 消息是**背景噪音**（快递到了、广告、群消息），规则即可处理
- LLM 只在**需要理解语义**或**需要生成内容**时介入

### 4.2 消息分类（按 LLM 使用量）

```
IM 消息
  │
  ├─► 规则即可处理（0% LLM）
  │      ├─ 屏蔽名单（blockedContacts）→ ignore
  │      ├─ 重要联系人 → notify
  │      ├─ 群聊非 @ → archive / ignore
  │      └─ autoReplyContacts 白名单 + 简单格式 → auto_reply
  │
  ├─► 需要 Attention 提升（0% LLM）
  │      └─ sleeping + 重要联系人 → defer（等待用户可用）
  │
  └─► 需要 LLM 理解（按需）
         ├─ importantContacts → suggest_reply（LMS 起草，人工确认）
         ├─ 语义复杂消息（超出规则判断）→ suggest_reply
         └─ 用户主动查询"XX 在微信说了什么"→ LLM 查档汇总
```

### 4.3 避免"所有消息进入 LLM"的策略

| 策略 | 说明 |
|---|---|
| **规则优先** | AttentionEngine 是规则的，0 LLM 调用 |
| **auto_reply 纯规则** | 不调用 LLM，直接匹配白名单 + 格式规则 |
| **suggest_reply 是特例** | 只有明确需要起草回复时才调 LLM |
| **查档 RAG 是搜索** | 用户主动查询走 infoStore search，不是 LLM 全量理解 |
| **Phase 6 Memory dedup** | 重复消息不重复进 LLM |

### 4.4 裁决：LLM 介入点（明确）

| 场景 | LLM 介入？ | 方式 |
|---|---|---|
| 快递取件码通知 → auto_reply | ❌ | 规则匹配格式，直接发送 |
| 导师发来"晚上有空吗？"→ suggest_reply | ✅ | LLM 起草回复"好的，几点？"→ 用户确认 |
| 用户主动问"昨天张三在微信说什么了" | ✅ | LLM 查档汇总 |
| 群聊有人 @ Orca → suggest_reply | ✅ | LLM 起草回复 |
| 群聊广告消息 → ignore | ❌ | 规则判断 |
| 重要联系人发来长消息 → suggest_reply | ✅ | LLM 起草，用户确认 |

**LLM 调用量预估（MVP）**：每天 100 条 IM 消息，预期 LLM 介入 ≤ 5 条（5%），其余全规则处理。

---

## 5. Memory 关系 Review

### 5.1 当前设计的问题

现有设计里 `imArchiver.push()` 直接调 `infoStore.append()`，与 Phase 6 Memory 的 MemoryArchiver 是**两条独立写入路径**：

```
imArchiver.push() → infoStore.append()
                        vs.
MemoryArchiver（Phase 6）→ infoStore.append()
```

这会导致：
- 同一消息可能被写两次（如果 EventBus 订阅者同时有 imArchiver 和 MemoryArchiver）
- Phase 6 Memory 的 dedup / ttl / conflict detection 不覆盖 IM 消息

### 5.2 两条路径的权衡

**路径 A（当前设计）：IM 消息独立写档**
```
Adapter → EventBus → imArchiver → infoStore.append()
```
- 优点：简单，IM 消息完全自主管理
- 缺点：与 Phase 6 Memory 框架不兼容；dedup / ttl 各自独立

**路径 B（Phase 6 框架）：统一归档**
```
Adapter → EventBus → MemoryArchiver（统一订阅所有 source）
```
- 优点：dedup / ttl / conflict detection 统一；与 Phase 6 完全兼容
- 缺点：需要 Phase 6 Memory 接口支持

**路径 C（折中）：imArchiver 作为 MemoryArchiver 的 source-specific writer**
```
Adapter → EventBus → imArchiver（source-specific 写入逻辑）
                  → MemoryArchiver（统一订阅，但不重复写）
```
- imArchiver 负责"哪些 IM 消息写档"（source 过滤 + format）
- MemoryArchiver 统一处理 ttl / dedup / conflict

### 5.3 裁决：路径 B（Phase 6 框架内统一归档）

**理由**：
1. Phase 6 Memory 的目标是统一所有 event source 的存储，IM 不应该例外
2. auto_reply / suggest_reply 需要查询历史上下文（MemoryArchiver 提供 R0/R1/R2 查询）
3. conflict detection 对 IM 消息同样有意义（对方撤回/修改）

**实现要求**：
- Phase 6 Memory 的 MemoryArchiver 必须支持 `source: 'im.*'` 的过滤和写入
- imArchiver 退化为"IM 消息专用的 MemoryArchiver 前端"，不做独立存储
- 如果 Phase 6 Memory 尚未实现，imArchiver 临时直接写 infoStore，但标记为"临时方案，Phase 6 实现后迁移"

### 5.4 未来 Memory 接口设计（草案，不实现）

```ts
// MemoryArchiver（Phase 6 框架内）
// 所有 event source 共用，不区分 IM 还是其他
interface MemoryArchiver {
  write(event: OrcaEvent): Promise<void>   // 统一写入，含 dedup + ttl
  query(filter: QueryFilter): Promise<MemoryRecord[]>  // 统一查询
}

// IM 专用前端子模块（imArchiver 演进方向）
interface ImMemoryFrontend {
  // 订阅 im.* 事件，格式化为 memory record
  onEvent(event: OrcaEvent): Promise<void>
  // 查询接口（供 suggest_reply / R0 查档用）
  queryRecent(contactId: string, limit: number): Promise<MessageEnvelope[]>
}
```

---

## 6. MVP 范围定义

### 6.1 MVP = 三阶段，不是完整实现

**原计划（一次性实现完整功能）的问题**：
- 把 Adapter / Attention / Decision / ActionHandler / Archiver 一起实现
- LLM 介入路径设计得过于复杂
- auto_reply 没有边界约束

**新计划（分阶段）**：

```
MVP Phase 1：观察模式
    ↓
MVP Phase 2：重要消息通知
    ↓
MVP Phase 3：有限自动回复
    ↓
v1.1+：复杂语义 → suggest_reply
```

### Phase 1：观察模式（最高优先级）

**目标**：Orca 能看到 IM 消息流，用户在飞书收到摘要

| 实现内容 | 不实现 |
|---|---|
| IM Adapter 骨架（normalize + EventBus） | auto_reply / suggest_reply |
| 观察模式 Attention 规则（全部 = notify） | 决策引擎扩展 |
| 飞书通知（所有 IM 消息都通知） | im-archiver 写档 |
| Dashboard 展示 IM 消息流 | autoReplyContacts / importantContacts |
| 真实协议接入（NapCatQQ / WCF） | 深度集成 |

**验收标准**：用户能在飞书收到"张三（QQ）：晚上吃饭吗？"，在 Dashboard 看到 IM 消息流。

### Phase 2：重要消息通知

**目标**：Orca 能区分重要/不重要，主动通知关键消息

| 新增内容 | 依赖 |
|---|---|
| importantContacts 配置 | Phase 1 |
| 重要联系人 → notify（优先通知）| Phase 1 |
| blockedContacts → ignore | Phase 1 |
| 群聊 → archive（不通知）| Phase 1 |
| sleeping + 重要联系人 → defer | Phase 1 + Phase 4.D |
| im-archiver（统一写档）| Phase 1 + Phase 6 Memory |

**验收标准**：快递/广告等低价值消息静默归档；导师/家人等重要联系人立即飞书通知。

### Phase 3：有限自动回复

**目标**：在用户明确授权的场景下，Orca 代回低价值沟通

| 新增内容 | 约束 |
|---|---|
| autoReplyContacts 白名单 | 用户手动配置 |
| auto_reply 规则（格式 + 长度 + 非群聊）| 纯规则，不调 LLM |
| imSendActHandler | 发送路径 |
| 发送后飞书通知"已代回 X 给 Y" | 用户感知到 Orca 做了什么 |
| autoReplyContacts × auto_reply 的审批旁路 | 无需额外审批 |

**严格限制（MVP 安全约束）**：
- auto_reply 内容长度 ≤ 20 字
- 必须是纯文本，无附件
- 必须在白名单
- 必须在非群聊
- 发送后必须飞书通知

### 暂不实现内容（v1.x 之后再说）

| 内容 | 原因 |
|---|---|
| suggest_reply | 需要 LLM 起草；Phase 3 稳定后再评估 |
| 群聊 @ Orca 处理 | 群聊语义复杂，MVP 只做 archive |
| 多轮对话上下文 | Phase 1-3 全部单轮处理 |
| 情感分析/意图识别 | 超出 MVP 范围 |
| 附件类消息处理 | MVP 只处理纯文本 |
| 跨平台统一会话（QQ ↔ 微信互通）| 架构复杂度过高 |
| NapCatQQ / WCF 深度集成 | Phase 1-3 用 mock adapter；真实接入放 PoC |
| 企业微信双向通信 | 只做 Notify Channel；IM 双向等 v2 |

---

## 7. 保留 / 修改 / 风险总表

### 7.1 保留设计

| 设计 | 保留原因 |
|---|---|
| Adapter.normalize() 纯函数 | Protocol → Envelope，无业务逻辑 |
| MessageEnvelope 双 ID（id + messageId）| 跨通道去重，source-traceability |
| namespace = im-bridge（统一不拆分）| 跨平台聚合查询，简化管理 |
| EventBus 作为唯一接入总线 | Runtime 开放接口，零改动 |
| importantContacts / autoReplyContacts / blockedContacts 分离 | 安全边界清晰 |
| LLM 只在 suggest_reply / 用户主动查询时介入 | 符合 Local-first 定位 |
| 企业微信 = Notify Channel，非 IM Adapter | 协议限制，无法双向 DM |

### 7.2 需要修改的设计

| 修改项 | 从 | 到 | 原因 |
|---|---|---|---|
| `sendText` | ImAdapter 接口方法 | `transportText` | 避免"Adapter 自主发送"的歧义 |
| `im.send` event type | 不存在 | `im.message.sent`（Audit Log）| Orca 需要感知自己发出了什么 |
| `im.message` | 无 direction | `im.message.received` / `im.message.sent` | 区分收/发 |
| 四态 | act/notify/defer/archive | ignore/notify/suggest_reply/auto_reply | 符合 Orca 新定位 |
| requiresApproval | Decision 字段 | 去掉；审批逻辑内化为 suggest_reply | 简化决策透明度 |
| imArchiver | 独立写 infoStore | 统一 MemoryArchiver（Phase 6）| 避免双写路径 |
| auto_reply | requiresApproval=false flag | 独立的 auto_reply action；无审批 | 白名单即授权，不需要审批字段 |

### 7.3 风险点

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| **Adapter sendText 被滥用**（绕过 Decision 直接发）| 高 | 严格接口约束 + code review 规范；smoke 测试验证 |
| **auto_reply 无意中发出敏感内容** | 高 | MVP 严格 5 条件限制；autoReplyContacts 用户自管 |
| **Phase 6 Memory 接口未就绪导致 imArchiver 延迟** | 中 | 临时 stub 方案；明确 Phase 6 依赖 |
| **企业微信 webhook 出站合规风险** | 中 | Notify Channel 用途明确；不做 IM 回复 |
| **auto_reply 内容质量差** | 低（MVP）| MVP 只做固定格式匹配，不调 LLM |
| **多 adapter 并发时序问题** | 低 | EventBus 时间戳作为权威；adapter 不维护状态 |
| **Attention 规则膨胀**（规则越来越多难维护）| 低 | IM 规则集独立于其他规则；不与其他 source 共用规则表 |

### 7.4 MVP 开发顺序（最终版）

```
Step 0：文档更新（orca-im-bridge.md + decisions.md + 本 review）
        ↓
Step 1：Phase 1 — 观察模式
        ├ 1.1：MessageEnvelope + direction 字段
        ├ 1.2：IM Adapter 骨架（mock adapter，不接真实协议）
        ├ 1.3：EventBus publish（im.message.received）
        ├ 1.4：Attention 基础规则（全部 → notify）
        ├ 1.5：FeishuClient.notify() 集成（所有 IM 消息通知）
        └ 1.6：Dashboard IM 流展示
        ↓
Step 2：Phase 2 — 重要消息通知
        ├ 2.1：importantContacts / blockedContacts 配置
        ├ 2.2：IM Attention 规则集（5 条）
        ├ 2.3：im-archiver（统一 MemoryArchiver 接口）
        ├ 2.4：Phase 4.D defer 集成
        └ 2.5：smoke 测试（5 条规则 × 3 case）
        ↓
Step 3：Phase 3 — 有限自动回复
        ├ 3.1：autoReplyContacts 配置
        ├ 3.2：auto_reply 规则（5 条件）
        ├ 3.3：imSendActHandler + transportText
        ├ 3.4：发送后飞书通知（"已代回 X"）
        ├ 3.5：im.message.sent Audit Log
        └ 3.6：smoke 测试（auto_reply × 边界条件）
        ↓
Step 4：Phase 4 — PoC 真实协议接入
        ├ 4.1：NapCatQQ 真实 adapter（备用小号）
        └ 4.2：wechatferry 真实 adapter（备用小号）
```

**每步完成后的验证标准**：
- Step 1 完：飞书收到每条 IM 消息的通知
- Step 2 完：低价值消息静默归档；重要联系人消息置顶通知
- Step 3 完：快递通知 5 秒内自动代回；飞书收到"已代回"通知
- Step 4 完：真实账号消息正常处理

---

## 8. 对既有文档的影响

| 文件 | 影响 | 需要更新的条款 |
|---|---|---|
| `guide/orca-im-bridge.md` | ⚠️ 重大修订 | 四态模型 / auto_reply 边界 / direction 字段 / LLM 边界 |
| `guide/decisions.md` | ⚠️ 修订 D-AGENT-16 | 四态改为 ignore/notify/suggest_reply/auto_reply；requiresApproval 字段删除 |
| `guide/orca-im-bridge-report.md` | ⚠️ 替换 | 本 review 替代 §6 自动回复设计；§2 Event 设计需更新 |
| `AGENT.md` | 暂无改动 | Step 1-3 代码实现后再同步 |

---

*本 Review 基于 Orca "Local-first Personal AI Agent Runtime"定位，目标是确保 IM Bridge MVP 不超过必要范围，LLM 最小化介入，安全边界清晰。*
