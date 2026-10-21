# Project Orca — IM Bridge：Personal Communication Attention Layer

> 状态：**架构冻结（IM-0 Phase；代码未实现）**
> 日期：2026-09-05（v1.0）→ 2026-09-05（v1.1）→ 2026-09-05（v1.1.1）→ **2026-09-06 IM-0 修订（Communication Attention Layer）**
> 关联：`guide/orca-info-agent-framework.md`（v0.2 CEO-员工-档案室）、`guide/orca-iphone-channel.md`（v1.0 手机 = 共享数据源）、`guide/decisions.md`（**D-AGENT-16 rev. IM-0**）
> 定位变更：D-AGENT-16 修订记录见 `guide/decisions.md` §D-AGENT-16rev

---

## 0. TL;DR

**Personal Communication Attention Layer——帮助 Orca 管理个人通信注意力：判断哪些消息值得打扰用户，哪些需要通知，哪些可以建议回复，极少部分安全场景自动回复。Orca 不是聊天机器人，不追求"代回所有消息"。**

```
外部 IM 平台（QQ / 微信）
  │
  ▼
IM Adapter（normalize：原协议 → MessageEnvelope）
  │
  ▼
OrcaEvent { source: 'im.qq', type: 'im.message.received', data: { envelope } }
  │
  ▼
EventBus.publish()
  │
  ▼
Runtime：WorldState → Attention → Decision
  │
  ▼
┌─────────────┬──────────────┬──────────────┬───────────────┐
▼              ▼              ▼              ▼               ▼
ignore        notify        suggest_reply  auto_reply     （future:）
（无需关注）  （通知用户）   （起草供确认）  （规则允许    defer（并入
                                                直接发）     notify 即可）
```

**IM-0 Phase 核心约束（IM-0 修订）：**
- **Adapter 四不**：不调 LLM、不做决策、不直接回复、不直接写 Memory
- **四态 = ignore / notify / suggest_reply / auto_reply**（删除 act/notify/defer/archive + 删除 requiresApproval）
- **auto_reply MVP 严格 5 条件**：白名单 ∧ 非群聊 ∧ 纯文本 ∧ 命中格式 ∧ ≤20字；否则只能 notify 或 suggest_reply
- **MessageEnvelope 新增 `direction: 'in' | 'out'`**（区分收到的消息与 Orca 发出的消息）
- **Memory 边界**：不新增 imArchiver 直接写 infoStore；统一走 Episode / MemoryArchiver
- **企业微信 ≠ IM 通道**：只作 Notify Channel

**为什么稳定且合规：**
- **出站（Orca 主动发）**：第一版只走 **企业微信 webhook**（合规、稳定、零账号成本）。NapCatQQ 走"小号+纯外发"作为 QQ 侧补充（封号风险中-高，仅 PoC）。
- **入站（Orca 收）**：第一版**不接 QQ/微信原协议**，而是引导用户把重要对话**转发到飞书**（"人工同步通道"，Manual Sync Channel），由 Orca 已有飞书通道（D-AGENT-13 通道①）接管——零代码、零封号风险。
- **原生协议 PoC**：若用户接受风险，再做 NapCatQQ / wechatferry / openclaw-weixin 中转桥，**默认禁用**（`ORCA_IM_*_ENABLED=0`），L1 隐私 + ttl 7 天 + 一键清空。

---

## 1. 背景与动机

### 1.1 用户设想（2026-09-05）
> "收到消息后经手 Orca，由 Orca 判断是自行回复 + 告知用户，还是提醒用户亲自回复。"

这就是 **消息代理（IM Agent / 代理层）模型**——把 Orca 从"飞书单通道助手"扩展为"多通道即时通信代理"，承担三个职责：

| 职责 | 现有能力 | 缺口 |
|---|---|---|
| 收 IM 消息 | 仅飞书 webhook | QQ / 微信无通道 |
| 决策「代回 / 告知 / 提醒 / 仅归档」 | 无显式机制 | 需新增 Attention 规则 + Decision 四态映射 |
| 回送原平台 | 仅 `feishu.sendToChat` | 缺企业微信 webhook / QQ NapCatQQ SDK / 微信 SDK |

### 1.2 与 iPhone 通道的关系（D-AGENT-13）
iPhone 是"传感器群"，通过三通道（飞书 / HTTP webhook / 文件夹监听）进 Orca；QQ/微信本质是 iPhone / PC 上的两个 App，**应走相同三通道**：

- **通道① 飞书（已有，D-AGENT-13 优先）**：把 QQ/微信消息通过飞书机器人 webhook 转发到 Orca（用户在 QQ/微信侧配"消息同步助手"）—— **此通道在 D-AGENT-16 中改称"人工同步通道（Manual Sync Channel）"，因为严格来说不是 QQ Adapter 的入站**
- **通道② HTTP webhook（已有，`POST /info/records`）**：QQ/微信 Bot 自建中转 → 推结构化消息到 Orca 档案室
- **通道③ 本地文件同步（已有）**：QQ/微信导出文件 → iCloud / Phone Link → 文件夹监听

新增"通道④ 原生协议 PoC"（D-AGENT-16）：NapCatQQ / wechatferry / openclaw-weixin 自家客户端直连。**仅当用户接受风险时启用**。

### 1.3 与 CEO-员工-档案室模型的关系（D-AGENT-08/09/10）
- **Adapter ≠ Agent**：QQ/微信消息作为新 source 类型（`im.qq` / `im.wechat`），由 **IM Adapter** 翻译为 `MessageEnvelope` 推 EventBus；不入业务 InfoAgent
- **InfoAgent = 档案**：新建 `im-archive-agent`（namespace=`im-bridge`，type=`im-message`），与 `food-agent` 平级；只做 Pull 查档，**不收发消息**
- **Namespace 不按平台拆分（v1.1.1 明确）**：`platform` 是 `MessageEnvelope` 字段，**不作为 namespace 拆分依据**；统一用 `im-bridge`（不拆 `im-qq` / `im-wechat` / `im-feishu`）。跨平台查询（"昨天所有平台 X 给我发的消息"）直接 `query({namespaces:['im-bridge']})` 即可，无需 union 多个 namespace
- **复用 R0 查档**（D-AGENT-10）：用户问"昨天 X 说啥了" → Orca 查 `im-bridge` 档案命中 → 直接答，零模型调用
- **Push 主路径**：QQ/微信消息默认经 Push 上报（Adapter 写档），不是 Orca 主动 Pull

---

## 2. 决策形态（**四态映射，IM-0 修订**）

```
收到 MessageEnvelope M（direction='in', platform, chatId, senderId, text, ts, isGroup, mentionedMe）
   ↓
WorldState（user.status / focus_mode / extensions.im.{importantContacts,autoReplyContacts,blockedContacts}）
   ↓
AttentionEngine 规则评估（§3）→ AttentionItem{action, priority, reason}
   ↓
DecisionEngine（纯翻译，无 IO）→ Decision{action}
   ↓
ActionExecutor 按 action 分派
```

**IM-0 四态（IM-0 修订；替代 v1.1 act/notify/defer/archive）：**

| Decision.action | 含义 | LLM 介入 | 用户操作 | 触发条件示例 |
|---|---|---|---|---|
| `ignore` | 低价值消息，什么都不做 | ❌ | 无 | 营销号 / blockedContacts / 群聊非 @ 的水聊 |
| `notify` | 重要消息，立即告知用户 | ❌ | 用户自行决定如何回复 | 重要联系人私聊 / sleeping + 重要联系人来消息 |
| `suggest_reply` | Orca 起草回复，供用户确认后发出 | ✅（起草） | "确认发送" / "修改" / "忽略" | 复杂消息需要理解；群聊 @ Orca；多轮上下文 |
| `auto_reply` | 规则明确允许，直接发出 | ❌ | 无（发送后飞书通知用户"已代回 X"） | 快递取件码 / 系统通知 + 满足全部 5 个 MVP 条件 |

**Attention → Decision 映射（IM-0）：**

```
AttentionAction                  Decision.action
──────────────────────────────────────────
ignore                      → ignore
notify_immediately          → notify
wait_until_available        → notify（defer 并入 notify；Scheduler 负责时机）
auto_reply（白名单）         → auto_reply
needs_review（复杂语义）      → suggest_reply
```

**删除 requiresApproval（IM-0）**：
- 旧设计：`Decision { action: 'act', requiresApproval: true/false }`
- 新设计：审批逻辑由 `suggest_reply` 表达（LLM 起草 → 用户确认 → 发出）；`auto_reply` 无需审批（规则即授权）
- 理由：审批不应作为通用字段存在，而应由明确的 action 类型表达

**Decision 完整结构（IM-0）**：

```ts
interface Decision {
  decisionId: string
  attentionId: string
  ruleId: string
  action: 'ignore' | 'notify' | 'suggest_reply' | 'auto_reply'   // 终态（IM-0）
  priority: number
  reason: string
  eventId: string
  source: string
  decidedAt: number
}
```

**auto_reply MVP 严格 5 条件（IM-0 新增）：**

必须**同时**满足才允许 `auto_reply`，否则降级为 `notify` 或 `suggest_reply`：

| # | 条件 | 说明 |
|---|---|---|
| 1 | `senderId ∈ autoReplyContacts` | 用户明确授权的白名单 |
| 2 | `envelope.isGroup === false` | 非群聊（群聊风险高，MVP 不处理） |
| 3 | `envelope.attachments === undefined` | 纯文本，无附件 |
| 4 | `text 匹配固定格式` | 快递取件码 / 外卖通知 / 系统告警等结构化文本（正则匹配） |
| 5 | `text.length ≤ 20` | 简单内容阈值 |

**auto_reply 边界（IM-0 约束）：**
- **禁止**：LLM 自动决定是否回复、多轮上下文、群聊处理、附件分析
- **必须**：发送后飞书通知用户"已代回 X 给 Y"
- **安全**：autoReplyContacts 用户自管；交集检查（importantContacts ∩ autoReplyContacts = ∅）

---

## 3. Attention 规则（IM-0 修订：四态映射）

> 全部走 `AttentionRuleRegistry.register(...)`，与现有 5 条内置规则同构。

| ruleId | 优先级 | predicate | Decision.action | 备注 |
|---|---|---|---|---|
| `im-urgent-from-important` | high | `event.source` 以 `im.` 开头 且 `envelope.senderId` ∈ `importantContacts` | `notify` | 提醒用户亲自回；绝不代回 |
| `im-private-default` | normal | `event.source` 以 `im.` 开头 且 `envelope.isGroup===false` 且非 `im-urgent-from-important` | `notify` | 默认告知用户 |
| `im-auto-reply` | normal | `event.source` 以 `im.` 开头 且 `envelope.senderId` ∈ `autoReplyContacts` **且满足全部 5 条件** | `auto_reply` | 5 条件：白名单∧非群∧纯文本∧格式匹配∧≤20字 |
| `im-auto-reply-needs-review` | normal | `event.source` 以 `im.` 开头 且 `envelope.senderId` ∈ `autoReplyContacts` **但不满足** auto_reply 5 条件 | `suggest_reply` | 格式/长度不满足，走 LLM 起草 |
| `im-group-mentions-me` | normal | `event.source` 以 `im.` 开头 且 `envelope.isGroup===true` 且 `envelope.mentionedMe===true` | `suggest_reply` | 群聊 @ Orca，需 LLM 起草 |
| `im-group-default` | low | `event.source` 以 `im.` 开头 且 `envelope.isGroup===true` 且非上述命中 | `ignore` | 群聊默认静默 |
| `im-spam-throttle` | — | `event.source` 以 `im.` 开头 且 `envelope.senderId` ∈ `blockedContacts` | `ignore` | 黑名单直接丢弃 |
| `im-overnight-from-important` | high | `event.source` 以 `im.` 开头 且 `prevState.user.status==='sleeping' 且 `envelope.senderId` ∈ `importantContacts` | `notify` | defer 并入 notify；Scheduler 负责时机 |

**IM-0 说明**：importantContacts ∩ autoReplyContacts = ∅（交集为空）；不依赖 WorldState 历史字段（无 lastSeen / lastMessage / recentChats）

**节流配置**：复用 Phase 3.B.throttle（source cooldown + hourly cap），`source='im.qq'` / `source='im.wechat'` 各自一套 cooldown。

**prevState 约束**（与 AGENT.md §8.3 一致）：
- `predicate: ({ prevState, event }) => ...` 中判断用户状态**必须用 prevState**（事件处理后 state 已变）
- state-only 触发（如"重要联系人来消息但 Orca 当前聚焦中"）走 `event.data` 而非 prevState

---

## 4. 执行后端对比（五条路 + 角色分层）

| 路径 | 协议 | 入站 | 出站 | 合规 | 封号风险 | 账号成本 | **角色** |
|---|---|---|---|---|---|---|---|
| **A. 企业微信 webhook** | 官方 | 仅应用消息（用户主动发起会话） | 群机器人 webhook / 智能机器人 SDK | ✅ 完全合规 | 0 | 免费 | **Notify Channel**（Orca→你 的通知；**不是 IM 回复通道**——企业微信群机器人不能给普通微信好友发消息） |
| **B. NapCatQQ**（OneBot v11）| 社区 | HTTP / WS | HTTP / WS | ❌ 协议 | 中-高（NTQQ 协议迭代）| 免费 | **IM Adapter**（QQ 侧入站 + 出站；PoC） |
| **C. wechatferry / ntchat** | 社区 | 共享内存 + HTTP | HTTP | ❌ 协议 | 高（PC 微信封号）| 免费 | **IM Adapter**（微信侧；PoC） |
| **D. tencent-weixin/openclaw-weixin / ClawBot API** | **腾讯准官方** | API | API | ✅ 边缘合规（待跟踪）| 低（按 API 配额）| 免费 | **IM Adapter**（微信侧合规口子；最值得跟踪） |
| **E. WxPusher / Server酱 / Bark** | 公众号推送 / iOS 推送 | ❌ | ✅ HTTPS POST | ✅ | 0 | 免费 | **Notify Channel 补充**（紧急推送；urgency=2 用） |

**v1.1 角色分层结论**：
- **IM Adapter**：原协议 ↔ MessageEnvelope；B / C / D 三选一（QQ 侧选 B，微信侧选 D 跟踪 / C 作 fallback）
- **Notify Channel**：Orca → 用户的通知通道；A 是主推（合规），E 是紧急补充
- **Manual Sync Channel**（人工同步）：用户从 QQ/微信侧配"转发到飞书机器人"，由 Orca 飞书通道接管——**这是入站第一版**，但**不是 IM Adapter**

**v1 推荐组合**：
- **入站第一版**：Manual Sync Channel（飞书转发，零代码）
- **出站第一版**：Notify Channel = 企业微信 webhook（合规、稳定）
- **入站 PoC**：NapCatQQ（B）作 QQ 侧 PoC；openclaw-weixin（D）作微信侧 PoC；两者 `ORCA_IM_*_ENABLED=0` 默认关
- **紧急出站补充**：E（WxPusher / Bark）用于 urgency=2 直推到 iPhone

---

## 5. 接口草案（**不写实现**）

> 仅 TS 类型签名 + 工厂函数轮廓，作为代码开工时的契约。实现待 Orca 记忆能力实装后开始。

### 5.1 MessageEnvelope（**通用信封**，v1.1 新增）

> 所有 IM / 飞书 / 未来 Telegram / Discord 共用；Adapter 只做"原协议 → Envelope"，Orca 只认 Envelope，**不认识 OneBot / WCF / NapCat / openclaw**

```ts
// src/types/messageEnvelope.ts（草案，IM-0）
interface MessageEnvelope {
  /** Orca 内部 Event ID；randomUUID；EventBus / infoStore / Decision back-trace 用 */
  id: string

  /** 平台原始消息 ID；跨通道去重 + supersedes 更正的真正键 */
  messageId: string

  /** 消息方向：in = 收到，out = Orca 发出（IM-0 新增） */
  direction: 'in' | 'out'

  platform: 'qq' | 'wechat' | 'feishu' | 'telegram' | 'discord' | ...
  chatId: string                   // 会话 ID（p2p = 用户 ID，群 = 群 ID）
  senderId: string                 // 发送者 ID（direction='out' 时为 Orca 自身 ID）
  senderName?: string              // 昵称（不入档案，仅日志）
  text: string                     // 纯文本；图片/文件走 attachments
  ts: number                       // 消息时间戳（毫秒，UTC）
  isGroup: boolean
  mentionedMe: boolean
  attachments?: Array<{
    kind: 'image' | 'file' | 'audio' | 'video'
    ref: string                    // feishu-style image_key / local path / URL；不存二进制
  }>
}
```

**设计要点**：
- `platform` 字段 = 路由键（D-AGENT-15 工位绑定可按 platform+chatId 二维绑定）
- **`id`（v1.1.1 拆分）**：Orca 内部 Event ID，`randomUUID()`；只在 Orca 内部使用（EventBus / infoStore / Decision back-trace）
- **`messageId`（v1.1.1 新增）**：平台原始消息 ID；**跨通道去重 + supersedes 更正** 的真正键（D-AGENT-09）；同一条消息从 QQ/微信/飞书三个通道同时进来时用 `(${platform},${messageId})` 去重
- **不混淆**：内部 `id` ≠ 平台 `messageId`；前者 Orca 自管，后者必须保留平台原值（便于溯源 + supersedes 关联平台侧真实消息）
- `text` 必填（纯文本）；非文本走 attachments 引用（D-AGENT-12 L1 隐私：二进制只存本地路径）

### 5.2 IM Adapter（**Adapter 角色**，与 InfoAgent 解耦）

```ts
// src/plugins/im-bridge/adapters/qq-adapter.ts（PoC 草案）
interface ImAdapter {
  readonly platform: 'qq' | 'wechat' | 'feishu'        // ★ 新增 platform 字段，与 Envelope 对齐
  readonly source: 'im.qq' | 'im.wechat' | 'im.feishu' // EventBus source 标识
  start(): Promise<void>     // 连接后端（NapCatQQ / WCF / openclaw）；监听入站
  stop(): Promise<void>      // 断开
  /** 原协议 → MessageEnvelope */
  normalize(raw: unknown): MessageEnvelope
  /** 经 Envelope 发送；target 从 Envelope.chatId 取 */
  sendText(envelope: Pick<MessageEnvelope, 'chatId' | 'isGroup'>, text: string): Promise<{ ok: boolean; error?: string }>
}

// 翻译为 OrcaEvent（IM-0 修订：区分 received / sent）
function envelopeToOrcaEvent(env: MessageEnvelope): OrcaEvent {
  return {
    id: randomUUID(),
    source: `im.${env.platform}`,
    type: env.direction === 'in' ? 'im.message.received' : 'im.message.sent',
    ts: env.ts,
    data: {
      envelope: env,                 // 整 envelope 入 data
    },
  }
}
```

**Event 命名规范（IM-0 确认）**：
- `source`：来源平台（`im.qq` / `im.wechat` / `im.feishu`），**不含 platform 信息在 type 里**
- `type`：消息类型（`im.message.received` / `im.message.sent`），**不包含 source 信息**
- 不要：`wechat.message` / `qq.message`（Orca event 规范：`${source}.${type}`）
- `im.message.sent`（Orca 发送）走 Audit Log；`im.message.received`（收到）走 Attention → Decision
```

**Adapter 边界**：
- Adapter **不知道** Decision / Attention / InfoAgent 存在
- Adapter **不知道** Orca 的 persona / LLM
- Adapter **唯一职责**：原协议 ↔ MessageEnvelope；启停；入站 publish 到 EventBus；出站 sendText

### 5.3 InfoAgent（`im-archive-agent`，**仅做查档**，v1.1 改名）

```ts
// src/agents/builtins/im-archive.ts（PoC 草案）
const imArchiveAgent: InfoAgent<
  { platform?: 'qq' | 'wechat' | 'feishu'; chatId?: string; senderId?: string; fromTs?: number; toTs?: number; keyword?: string; limit?: number },
  { records: ImMessageRecord[] }
> = {
  meta: {
    name: 'im-archive-agent',                                  // ★ v1.1 改名：bridge → archive
    description: '查询 IM 消息档案（按平台 / 联系人 / 群 / 时间窗）',
    tags: ['im', 'message', 'archive', 'history'],             // ★ 加 history
    modes: ['pull'],                                           // ★ 移除 push（push 由 Adapter 完成，不是 Agent）
    recordTypes: ['im-message'],
    kind: 'tool',
    inputSchema: z.object({
      platform: z.enum(['qq', 'wechat', 'feishu']).optional(), // ★ 平台过滤
      chatId: z.string().optional(),
      senderId: z.string().optional(),
      fromTs: z.number().optional(),
      toTs: z.number().optional(),
      keyword: z.string().optional(),
      limit: z.number().int().positive().max(100).default(20),
    }),
    outputSchema: z.object({ records: z.array(imRecordSchema) }),
    timeoutMs: 3000,
    isConcurrencySafe: true,
    costHint: 'free',
  },
  async execute(req, deps) {
    // ★ Pull = 查档（R0 复用）；不调任何 IM SDK
    const records = await deps.store!.query({
      namespaces: ['im-bridge'],
      types: ['im-message'],
      keyword: req.input.keyword,
      from: req.input.fromTs,
      to: req.input.toTs,
      limit: req.input.limit ?? 20,
    })
    // payload 内按 platform 过滤（不解析 payload，靠 envelope 字段）
    const filtered = req.input.platform
      ? records.filter(r => (r.payload as { envelope: MessageEnvelope }).envelope.platform === req.input.platform)
      : records
    return { ok: true, data: { records: filtered }, tookMs: 0, source: 'im-archive-agent' }
  },
}
```

**v1.1 语义对照**：

| 调度 | CEO → ? | 做什么 |
|---|---|---|
| 收到新消息 | EventBus → Attention → Decision → Action | Adapter 推送 + Action 处理 |
| 用户问"昨天 X 说啥了" | CEO → `im-archive-agent`（Pull） | 查档命中 → 直接答 |
| 用户说"代回张三" | CEO → Decision(act, handler='im.send') → Action | 调 Adapter.sendText |

**CEO 永远不会说"bridge-agent 帮我接 QQ"**——这种语义不存在；接 QQ 是 Adapter 的事。

**v1.1.1 namespace 设计明确声明**：
- `im-archive-agent` 操作的 namespace 固定为 `im-bridge`，**不拆 `im-qq` / `im-wechat` / `im-feishu`**
- `platform` 仅作为 `MessageEnvelope` 字段与查询过滤参数；不入 namespace key
- 跨平台聚合查询（"昨天所有 IM X 给我发的消息"）= `query({namespaces:['im-bridge']})` 一次完成，**无需 union 多个 namespace**
- 平台特定配置（如 NapCatQQ endpoint）放 .env（`ORCA_IM_QQ_HTTP`），不入 namespace

### 5.4 Push 上报通道（复用 `POST /info/records`）

> 当用户不愿自建 Adapter 时，可用第三方 Bot（NapCatQQ / wechatferry）经 HTTP 把消息推 Orca 档案室；**Adapter 在此处仅做"协议 → Envelope"**，再走标准入站流程。

```ts
// 第三方 Bot → Orca
// POST http://127.0.0.1:8101/info/records
// Authorization: Bearer <token-from-INFO_RECEIVER_TOKENS>
// Content-Type: application/json
{
  "namespace": "im-bridge",
  "type": "im-message",
  "ts": 1736140800000,
  "source": "qq-bot-poc",
  "confidence": 1.0,
  "urgency": 0,
  "payload": {
    "envelope": {                          // ★ v1.1：payload 直接含 MessageEnvelope
      "id": "msg_xxx",
      "platform": "qq",
      "chatId": "group_67890",
      "senderId": "user_12345",
      "senderName": "张三",
      "text": "晚上吃饭吗？",
      "ts": 1736140800000,
      "isGroup": true,
      "mentionedMe": false
    }
  },
  "ttlDays": 7
}
```

### 5.5 ActionHandler 扩展（`act` + `handler`，v1.1 修订）

```ts
// src/plugins/action-handlers/registry.ts（草案）
type ActHandler =
  | 'im.send'            // 经对应平台 Adapter 回发
  | 'feishu.reply'       // 飞书 sendToChat
  | 'tts.speak'          // 本地 TTS
  | 'calendar.create'    // 创建日历事件
  | 'todo.add'           // 添加待办
  // 未来：'mqtt.publish' / 'webhook.post' / ...

interface ActDecision extends Decision {
  action: 'act'
  handler: ActHandler
  handlerInput: unknown                  // 各 handler 自定义 input
}

interface ActHandlerRegistry {
  register(h: ActHandler, fn: (input: unknown, ctx: ActionContext) => Promise<ActionResult>): void
  get(h: ActHandler): ActHandlerFn | undefined
}

// im.send handler 实现（草案）
function createImSendActHandler(adapters: Record<ImAdapter['platform'], ImAdapter>) {
  return {
    handler: 'im.send' as const,
    async handle(input: { envelope: Pick<MessageEnvelope, 'platform' | 'chatId' | 'isGroup'>; text: string }, _ctx: ActionContext) {
      const adapter = adapters[input.envelope.platform]
      if (!adapter) return { ok: false, error: { code: 'NO_ADAPTER', message: `no adapter for ${input.envelope.platform}` } }
      const r = await adapter.sendText(input.envelope, input.text)
      return r.ok
        ? { ok: true, result: { sent: true, platform: input.envelope.platform } }
        : { ok: false, error: { code: 'SEND_FAILED', message: r.error ?? 'unknown' } }
    },
  }
}
```

### 5.6 NotifyHandler Channel 分支（企业微信，v1.1 定位修订）

```ts
// Phase 4.E channel 分支（草案）
// channel 枚举新增 'corpwechat'；envelope.platform='wechat' 不直接对应 channel
type NotifyChannel = 'feishu' | 'corpwechat' | 'bark' | 'email'

function notifyChannel(decision: Decision, event: OrcaEvent): NotifyChannel {
  // ★ 企业微信 ≠ IM 回复通道；只作 Orca→你 的通知
  // 当 Decision.action='notify' 且 ORCA_IM_CORPWECHAT_ENABLED 时优先企业微信
  if (decision.action === 'notify' && config.ORCA_IM_CORPWECHAT_ENABLED) return 'corpwechat'
  return 'feishu'                                                            // 默认飞书
}
```

**v1.1 语义对照**（避免混淆）：

| 概念 | 角色 | 通道 |
|---|---|---|
| **IM Adapter** | 原协议 ↔ MessageEnvelope | NapCatQQ / WCF / openclaw |
| **Notify Channel** | Orca → 用户的通知 | 企业微信 webhook / Bark / 飞书 |
| **Manual Sync Channel** | 用户从 QQ/微信侧手动转发到飞书 | 飞书机器人 webhook |

### 5.7 WorldState 扩展（**仅当前状态**，v1.1 删历史字段）

```ts
// WorldStateService 扩展（草案）
interface WorldStateExtensions {
  im: {
    importantContacts: Array<{ platform: 'qq' | 'wechat' | 'feishu'; id: string; name: string }>
    autoReplyContacts:  Array<{ platform: 'qq' | 'wechat' | 'feishu'; id: string; name: string }>
    blockedContacts:   Array<{ platform: 'qq' | 'wechat' | 'feishu'; id: string; name: string }>
    // ★ v1.1 删除：lastSeen / lastMessage / recentChats（不该在 WorldState）
    // 这些信息由 EventBus.recent() + infoStore.query() 提供
  }
  // user / device / time 不变
}
```

**为什么删 lastSeen**：
- WorldState = "当前状态"；lastSeen = "历史"（应放 EventBus / infoStore）
- 如果 WorldState 缓存历史，会和 EventBus / infoStore 重复，且不同步风险高
- Attention 规则需要"最近一条消息"时，用 `EventBus.recent({source:'im.qq', limit:1})[0]`，**不在 WorldState 缓存**

### 5.8 配置键草案（仅占位，实现时再确定）

| 键 | 默认 | 用途 |
|---|---|---|
| `ORCA_IM_ENABLED` | 0 | IM Adapter 总开关；=1 才挂载 im-adapter 插件 |
| `ORCA_IM_QQ_ENABLED` | 0 | NapCatQQ Adapter（PoC） |
| `ORCA_IM_QQ_HTTP` | `http://127.0.0.1:3000` | NapCatQQ OneBot v11 HTTP endpoint |
| `ORCA_IM_WECHAT_ENABLED` | 0 | 微信 Adapter（PoC） |
| `ORCA_IM_WECHAT_BACKEND` | `wcf` \| `openclaw` | 后端选型 |
| `ORCA_IM_CORPWECHAT_ENABLED` | 0 | **Notify Channel** 企业微信 webhook（合规，推荐开） |
| `ORCA_IM_CORPWECHAT_WEBHOOK` | — | 群机器人 webhook URL |
| `ORCA_IM_IMPORTANT_CONTACTS` | `[]` | JSON；触发 `im-urgent-from-important`（提醒 + **绝不代回**）|
| `ORCA_IM_AUTO_REPLY_CONTACTS` | `[]` | JSON；触发 `im-auto-reply`（允许 act + handler=im.send）|
| `ORCA_IM_BLOCKED_CONTACTS` | `[]` | 黑名单；触发 `im-spam-throttle` |
| `ORCA_IM_TTL_DAYS` | 7 | L1 隐私默认 ttl（D-AGENT-12） |
| `ORCA_IM_ACT_ENABLED` | 0 | act handler 总开关（L2 副作用；默认禁用）|

---

## 6. 主 Agent 集成（CEO 行为扩展）

```
用户飞书消息 / 任意输入
   ↓
Orca 决策（R0 查档 → 命中？）
   ├── 命中（如「昨天 X 说啥了」）
   │     → R0 查 im-archive-agent → 命中 → 直接回复（零模型调用）
   └── 未命中（如「X 现在在哪」）
         → 派活 im-archive-agent（Pull：查最近 N 条）
         → 结果注入 → 汇总 → reply
   ↓
（自动）若 Attention 评估为 notify / defer / act
   ↓
ActionExecutor → NotifyHandler(channel=corpwechat/feishu/bark) / ImSendActHandler / DeferredStore
```

**复用点（D-AGENT-*）**：
- R0 查档（D-AGENT-10）：`im-archive-agent` 注册后，主 agent 在 `buildArchiveContext` 里自动包含
- 联系人配置查询：用户在飞书发「我的自动回复联系人」→ Orca 查 `extensions.im.autoReplyContacts` 返回
- 会话历史结构化标记：`[record:im-bridge im-message 2026-09-05T10:00 platform=qq chatId=g1 senderName=张三 text=晚上吃饭吗]`

---

## 7. 安全模型（D-AGENT-06 + D-AGENT-12）

| 级别 | 内容 | 策略 |
|---|---|---|
| **L0** | 群聊水聊（已 archive） | 入档不通知 |
| **L1** | IM 消息文本 + 来源元数据 | 入档不落明文日志（D-AGENT-12）；payload ttl 默认 7 天；用户可一键清空 `im-bridge` namespace；图片二进制只存本地路径引用 |
| **L2** | Orca 代发（act 路径） | 走审批（一次性 grant，与 Phase 4.E 一致）；`ORCA_IM_*_ENABLED=0` 默认 + `ORCA_IM_ACT_ENABLED=0` 默认 + 用户在 `extensions.im.autoReplyContacts` 显式配置代回白名单 |

**关键约束**：
- AgentDeps 最小权限（Adapter 不给发送/写文件以外的权限）
- Push 上报通道需鉴权（每 Bot 独立 Bearer token + namespace 白名单，复用 `INFO_RECEIVER_TOKENS`）
- 记录删除 = 软删 + ttl 硬清理（append-only JSONL）
- 用户可一键清空 namespace：`DELETE /info/records?namespace=im-bridge`（D-AGENT-09 已落地）

---

## 8. 与四态决策对应的 Orca 回复（人设示例）

> 平级称呼（叫"你"）+ 淡淡死感（简短平淡、不煽情、不用 emoji）+ 偶尔冷幽默；与现有 persona.ts / food-image.ts 风格一致。

### 8.1 notify（立即通知，请用户决定）
> 张三（QQ，重要联系人）晚上发来"晚上吃饭吗？"；张三在 importantContacts → 触发 `im-urgent-from-important` → notify：

> 张三（QQ）问你晚上吃饭吗。要我代回吗，回个"行"或"不去"就行。
>
> 原文：晚上吃饭吗？

### 8.2 defer（稍后提醒）
> 李四（重要联系人）发来紧急工作消息；用户当前 `status=sleeping` → 触发 `im-overnight-from-important` → defer：

> 你在睡觉，李四（微信）连发了 3 条工作消息。内容我看了，不便代回。醒了看一眼。

### 8.3 archive（仅归档）
> 群聊水聊 → `im-group-default` → archive：

> （已归档）群"周末爬山"新增 12 条消息。

### 8.4 act（Orca 代回）
> 快递机器人（autoReplyContacts）发来取件码 → `im-auto-reply` → Decision(act, handler=im.send) → Adapter.sendText：

> （代回已发）快递机器人 QQ：好的，明天上午 10 点取。

### 8.5 风格守则（落 persona.ts / IM 插件）
- 第一人称 = "我"；第二人称 = "你"；不喊"老板"
- 单条通知 ≤ 2 行 + 一行原文引用；原文截断 100 字内
- 不上感叹号、不堆 emoji；如需情感只用句号 / 偶尔 "行吧" / "好的"
- L2 代发走单独确认流（不在 persona 里展开）

---

## 9. 开源参考（GitHub 调研结论）

### 9.1 DSH 生态同类项目（直接对位你的设想）

| 项目 | 描述 | 借鉴点 |
|---|---|---|
| **[baisama-cloud/dsh-omni-bridge](https://github.com/baisama-cloud/dsh-omni-bridge)** | DSH 多通道消息桥：微信（ClawBot/iLink）+ QQ + 飞书 → DSH agent → 回送发送方 | **完全对位**；协议层 / 鉴权 / 路由表设计可参考 |
| **[PerryLink/dsh-reach](https://github.com/PerryLink/dsh-reach)** | DSH 多通道决策/远程控制桥：approval/question 卡片推到 IM + IM 端回答 + per-channel 安全 + session console + open push service | "代回 vs 提醒"对应"决策卡片在 IM 中转"；per-channel 安全模型可借鉴 |
| **[PerryLink/dsh-wechat](https://github.com/PerryLink/dsh-wechat)** | 微信私聊 ↔ DSH，文本/图片/文件/音视频双向 | 微信侧落地参考 |
| **[amlyczz/dsh-lark-link](https://github.com/amlyczz/dsh-lark-link)** | 飞书 ↔ DSH 桥 | 飞书侧参考（Orca 已有） |
| **[hackerFish/awesome-dsh-plugin](https://github.com/hackerFish/awesome-dsh-plugin)** | DSH 插件精选列表 | 生态总入口 |

### 9.2 多平台 IM AI Agent（非 DSH 生态）

| 项目 | 描述 | 备注 |
|---|---|---|
| **[AstrBot](https://github.com/Soulter/AstrBot)**（5K+⭐，活跃）| Python + 插件化 + WebUI + LLM 适配器；QQ（NapCat）+ 微信（wechatferry）+ 飞书/钉钉/Telegram/Slack/Discord 等十几平台 | 部署最成熟；"代回 vs 提醒"靠规则 + LLM 自决，无显式决策层 |
| **[wangrongding/wechat-bot](https://github.com/wangrongding/wechat-bot)** | Telegram / WhatsApp / Lark / WeChat + ChatGPT/Claude/DeepSeek/Ollama；联系人管理 + 沉默好友检测 + 社区分析 | 多平台 + DeepSeek |
| **[Matrixbirds/openilink-hub](https://github.com/Matrixbirds/openilink-hub)** | 自托管微信 Bot 管理平台 + WebSocket + Webhook + AI 自动回复 + 7 语言 SDK | 偏平台工程 |
| **[LangBot](https://github.com/langbot-app/LangBot)** | 全平台 IM 智能机器人开发框架 | 中文社区活跃 |
| **[lssiran/kirara-ai](https://github.com/lssiran/kirara-ai)** | 多平台 IM | 较新 |

### 9.3 协议层后端

| 平台 | 主流开源 | 维护 | 风险 |
|---|---|---|---|
| QQ | **[NapCatQQ](https://github.com/NapNeko/NapCatQQ)**（NTQQ 协议 + OneBot v11/v12） | 活跃 | 协议迭代快、封号中-高 |
| QQ | go-cqhttp（停维） / [Lagrange.OneBot](https://github.com/LagrangeDev/Lagrange.Core) | 半活跃 | 同上 |
| PC 微信 | **[wechatferry/wcf](https://github.com/wechatferry/wechatferry)** / ntchat | 维护中 | 高封号 |
| PC 微信 | [wechaty](https://github.com/wechaty/wechaty) + puppet-xp / puppet-padlocal | wechaty 框架活跃 | 高 |
| 企业微信 | 官方 API（Webhook / 智能机器人 / 应用消息）| 官方稳定 | **Notify Channel 推荐** |
| 微信准官方 | [tencent-weixin/openclaw-weixin](https://github.com/SkywalkerSpace/weixin-ClawBot-API) / ClawBot API | 新兴 | **最值得跟踪**（合规口子）|

---

## 10. 落地阶段（**仅规划，未开工**）

> 代码落地待 **Orca 记忆能力实装** 后启动。记忆 = `infoStore` 持久化层（Phase 4.E 之后或与之并行）。用户口头指示「记忆功能落地后开工」。

| 阶段 | 内容 | 验收 | 优先级 |
|---|---|---|---|
| **A. 文档沉淀** | 本文件 + `guide/decisions.md` 新增 D-AGENT-16 + AGENT.md §5/§6 增量 | v1.1 review 完成（待最终 review） | P0 |
| **B. 记忆能力就绪** | `infoStore` 持久化层（JSONL 已具备）+ D-AGENT-12 隐私工具就绪 | 用户确认"记忆已实装" | P0 阻塞 |
| **C. MessageEnvelope + Adapter 抽象** | `types/messageEnvelope.ts` + `plugins/im-bridge/adapters/` 骨架（不接真协议）| 编译通过；smoke 覆盖 normalize / start / stop | P1 |
| **D. 出站：企业微信 Notify Channel** | NotifyHandler channel 扩展（Phase 4.E 一部分）| "Orca 通知"经企业微信群机器人送达 | P1 |
| **E. 引导入站：Manual Sync 文档** | 飞书机器人配"消息转发"教程；零代码 | 用户把 QQ/微信重要联系人配到飞书 | P1 |
| **F. Attention 规则 + 四态注册** | 5 条规则（§3）走 `AttentionRuleRegistry.register()` + smoke | R-im smoke ≥ 30 用例覆盖四态映射 + important/autoReply 分离 + handler 字段 | P1 |
| **G. im-archive-agent 注册** | `agents/builtins/im-archive.ts`（§5.3 接口草案落地）| R0 查档命中；smoke 覆盖 platform 过滤 | P2 |
| **H. ActHandler 注册表 + im.send** | `plugins/action-handlers/registry.ts` + `im.send` handler | Decision(act, handler='im.send') 走到 Adapter.sendText | P2 |
| **I. PoC：NapCatQQ Adapter** | OneBot v11 HTTP 客户端 + start/stop + normalize + sendText | 备用小号接入；manual smoke | P3 |
| **J. PoC：openclaw-weixin 跟踪** | 等腾讯开放稳定后接入 | 同上 | P3 |
| **K. Bark / WxPusher 紧急推送** | NotifyHandler urgency=2 通道 | 紧急消息直推到 iPhone | P3 |
| **L. 一键清空 namespace UI** | Dashboard 按钮 + `DELETE /info/records?namespace=im-bridge` | 用户能可视化清理 | P3 |

**回滚策略**：每阶段独立 commit；任一阶段失败 `git revert` 该 commit 即回滚（与 Phase 2 v0.4.0 回滚模型一致）。

---

## 11. 风险与开放问题

| 风险/问题 | 影响 | 缓解 |
|---|---|---|
| QQ/微信封号 | 用户主账号不可逆损失 | `ORCA_IM_*_ENABLED=0` 默认 + 备用小号 + 文档明示风险 + L1 ttl |
| 协议迭代（NTQQ / PC 微信） | Adapter 突然失效 | NapCatQQ OneBot v11 抽象层 + 备用 Lagrange / openclaw-weixin；Adapter ↔ Orca 通过 MessageEnvelope 解耦，切换 Adapter 不影响 Orca 主体 |
| 用户隐私泄漏 | 第三方 SDK 上报 | L1 不落明文日志 + 一键清空 namespace + D-AGENT-12 软删 + ttl |
| Orca 代回误判 | 用户尴尬 / 信任损失 | L2 副作用走审批 + 默认 act=stub + autoReplyContacts 显式白名单 + importantContacts 强制走 notify/defer（绝不代回） |
| 重要消息被合并通知淹没 | 用户错过 | Phase 4.E 合并通知语义（defer→notify 翻译）按 priority 排序 |
| 与 DSH subagent 关系 | 重复造轮子 | Orca 信息获取走 InfoAgent；DSH subagent 仅做复杂多步研究；中转代理是 Orca 专属角色 |
| 通道多时序混乱（同一消息多通道到达）| 重复处理 | MessageEnvelope.id + envelope 去重键；infoStore `supersedes` |
| 用户对 LLM 决策的不信任 | 不敢开 ORCA_IM_* | 透明化：Attention 规则 JSON 显式可看；执行日志可回放；importantContacts/autoReplyContacts 完全由用户掌控；Decision.handler 字段让代回路径可见 |
| WorldState 误用为历史缓存 | 数据不一致 | §5.7 严格只存当前状态；历史走 EventBus / infoStore（见 §修订记录 #2）|

---

## 12. 与现有文档的关系

- `guide/orca-info-agent-framework.md`（v0.2）§2.1 / §3 / §5 → 本文件 §5 接口草案落地其抽象；§5.3 `im-archive-agent` 是 `food-agent` 同级 InfoAgent
- `guide/orca-iphone-channel.md`（v1.0）§0 三通道 → 本文件 §1.2 沿用 + 增"通道④ 原生协议 PoC"；Manual Sync Channel 与通道① 同义但术语更准
- `guide/orca-cordis-migration-plan.md` §2.4 工具模型 / §2.5 subagent → 中转代理是 Plan-then-Execute 之外的"持续对话"角色，与 subagent 正交
- `guide/decisions.md` → 新增 D-AGENT-16（**v1.1 修订版**，含 Adapter/Agent 分离 + 四态 + MessageEnvelope + WorldState 边界 + 企业微信角色定位）
- `AGENT.md` → §5 能力清单 / §6 配置键 / §8 待办 待代码开工后同步（D-VER-04）
- `TODO.md` → "Cordis 版其他待办"新增 IM 中转章节
- `dev-log.md` → 每阶段 commit 时同步条目

---

## 13. 决策记录（**v1.1 草案，待 review**）

### D-AGENT-16（v1.1 修订，未入 `guide/decisions.md`）
**IM 中转代理层（Orca 作为 QQ/微信消息代理）**

- **16-01 角色分离**：**Adapter ≠ Agent**。IM Adapter 只做"原协议 ↔ MessageEnvelope"；InfoAgent 只做"查档"。两者通过 EventBus（消息流） + infoStore（档案）协作，**互不直接调用**
- **16-02 通用信封 MessageEnvelope**：所有 IM / 飞书 / Telegram / Discord 共用 `MessageEnvelope{id, platform, chatId, senderId, text, ts, isGroup, mentionedMe, attachments?}`；Orca 只认 Envelope，**不认识 OneBot / WCF / NapCat / openclaw**
- **16-03 四态决策**：Decision 终态 = `act / notify / defer / archive`（不再做 remember_only→remember 二次映射）；`ignore` 作为 AttentionEngine 终结态不下到 Decision
- **16-04 act + handler 解耦**：`act` 不再绑定"自动回复"；Decision 必须带 `handler: 'im.send' | 'feishu.reply' | 'tts.speak' | 'calendar.create' | 'todo.add' | ...`，同一种 action 可挂任意 handler；`requiresApproval` 字段为审批元数据（默认 true，仅 Attention 规则显式置 false 才跳过）
- **16-05 联系人群分离**：`importantContacts`（提醒 + 绝不代回）与 `autoReplyContacts`（允许代回）完全独立配置；**交集为空**——同一人不能同时是"重要"和"自动回复"
- **16-06 入站第一版 = Manual Sync Channel**：用户从 QQ/微信侧配"转发到飞书机器人"；Orca 飞书通道接管；**不是 IM Adapter**；零代码、零封号风险
- **16-07 出站合规优先**：第一版 Notify Channel 只走企业微信 webhook（合规、零封号风险）；NapCatQQ 小号纯外发作为 QQ 侧补充；openclaw-weixin 作微信侧合规口子跟踪
- **16-08 企业微信 ≠ IM 通道**：只作 Notify Channel（Orca→你 的通知）；**不是 IM 回复通道**（企业微信群机器人不能给普通微信好友发消息）；真正的 IM 回复只能走 IM Adapter
- **16-09 L1 隐私**：IM 消息 = L1（私有数据），不落明文日志，payload ttl 默认 7 天（D-AGENT-12），用户可一键清空 `im-bridge` namespace
- **16-14 MessageEnvelope 双 ID（v1.1.1）**：`id`（Orca 内部 Event ID，randomUUID）用于内部关联（EventBus / infoStore / Decision back-trace）；`messageId`（平台原始消息 ID）用于跨通道去重 + supersedes 更正，**两者不混淆**
- **16-15 namespace 不按平台拆分（v1.1.1）**：统一 `im-bridge`；`platform` 仅作 MessageEnvelope 字段与查询过滤参数；跨平台聚合查询 `query({namespaces:['im-bridge']})` 一次完成
- **16-10 WorldState 严格只存当前状态**：`extensions.im.{importantContacts,autoReplyContacts,blockedContacts}` + `user.status` + `focus_mode`；**不存历史**（lastSeen / lastMessage / recentChats 删；历史走 EventBus + infoStore）
- **16-11 PoC 边界**：`ORCA_IM_*_ENABLED=0` 默认 + `ORCA_IM_ACT_ENABLED=0` 默认；开启前需用户二次确认承担账号风险；仅备用小号 / 测试号使用，不用于用户主账号
- **16-12 决策可见性**：Attention 规则 JSON 显式可看；importantContacts/autoReplyContacts 完全由用户掌控；Decision.handler 字段让代回路径可见；执行日志可回放
- **16-13 主循环零改动**：IM 中转作为 Cordis 插件（`im-bridge`）挂载；EventBus 新 source 类型；WorldStateUpdater 新 reducer；AttentionRuleRegistry 新 5 条规则；ActionExecutor 新 ActHandlerRegistry；InfoAgent 注册表新 `im-archive-agent`

---

## 14. 修订记录

### v1.0 → v1.1（2026-09-05 review）
| # | 问题 | 修订 |
|---|---|---|
| ① | im-bridge-agent 命名误导 | 拆为 `im-adapter`（Adapter，收发）+ `im-archive-agent`（InfoAgent，查档）；CEO 调度语义改干净 |
| ② | WorldState 变数据库 | 删 `lastSeen / lastMessage / recentChats`；WorldState 只留 `user.status / focus_mode / extensions.im.{importantContacts,autoReplyContacts,blockedContacts}`；历史用 EventBus + infoStore |
| ③ | act ≠ 自动回复 | Decision 改为 `act` + `handler: 'im.send' \| 'feishu.reply' \| 'tts.speak' \| ...`；去掉"act = 自动回复"的语义绑定 |
| ④ | importantContacts 一词两义 | 拆 `importantContacts`（优先提醒 + 绝不代回）+ `autoReplyContacts`（允许代回），独立配置独立语义，交集为空 |
| ⑤ | "飞书入站"表述不准 | 改称"Manual Sync Channel（人工同步）"；原生协议才叫 IM Adapter |
| ⑥ | 三态应是四态 | Decision 显式四态 `act / notify / defer / archive`（不再做 remember_only→remember 二次映射） |
| ⑦ | 企业微信定位错 | 降级为 Notify Channel（不是 IM Adapter / 不是 QQ/微信回复通道）；专做 Orca→你 的通知 |
| ⑧ | 协议细节泄漏到 Orca | 新增 `MessageEnvelope` 通用信封；Adapter 只做"原协议 → Envelope"，Orca 只认 Envelope，不认 OneBot / WCF / NapCat |

### v1.1.1 → IM-0（2026-09-06 IM-0 Phase；Communication Attention Layer 定位修订）
| # | 改动 | 修订 |
|---|---|---|
| ⑫ | 定位从"聊天机器人"改为"Personal Communication Attention Layer" | 核心价值：判断哪些消息值得打扰用户，哪些需要通知，哪些可以建议回复，极少部分安全场景自动回复 |
| ⑬ | 删除 act/notify/defer/archive → 改为 ignore/notify/suggest_reply/auto_reply | `act` → `auto_reply`；`defer` 并入 `notify`；新增 `suggest_reply`（需 LLM 起草） |
| ⑭ | 删除 `requiresApproval` 字段 | 审批逻辑内化为 `suggest_reply` 专用流程；`auto_reply` 无需审批（规则即授权） |
| ⑮ | MessageEnvelope 新增 `direction: 'in' \| 'out'` | 区分收到的消息与 Orca 发出的消息；Event type 改为 `im.message.received` / `im.message.sent` |
| ⑯ | Event type 命名规范确认 | `source='im.qq'`，`type='im.message.received'`（不含 source 信息）；Orca→用户发的走 Audit Log |
| ⑰ | Attention 规则 6 条→8 条；Decision 列替换为 Decision.action | `im-auto-reply` 拆为 `auto_reply`（满足全部 5 条件）和 `suggest_reply`（白名单但不满足）；新增 `im-group-mentions-me` |
| ⑱ | auto_reply MVP 5 条件明确 | 白名单∧非群∧纯文本∧格式匹配∧≤20字；禁止 LLM 自动决定、多轮上下文、群聊处理、附件分析 |
| ⑲ | Memory 边界明确 | 不新增 imArchiver 直接写 infoStore；统一走 Episode / MemoryArchiver |
| ⑳ | Auto Reply 设计章节整体重写 | 原 §6 拆分为：四态含义、自动回复两条路径、requiresApproval 删除、auto_reply MVP 约束 |
| ㉑ | 文档元信息更新 | 标题/状态/日期/关联指向 D-AGENT-16 rev. IM-0 |

### v1.1 → v1.1.1（2026-09-05 final 三处小修）
| # | 改动 | 修订 |
|---|---|---|
| ⑨ | MessageEnvelope 拆分 ID | `id`（Orca 内部 Event ID，randomUUID）+ `messageId`（平台原始消息 ID）；跨通道去重 + supersedes 用 `(${platform},${messageId})` |
| ⑩ | Decision.act 加审批元数据 | 新增 `requiresApproval?: boolean`；审批作为 Action 元数据而非规则约定；所有 act handler（im.send / calendar.create / todo.add / mqtt.publish ...）统一审批机制 |
| ⑪ | namespace 不按平台拆 | 明确 `platform` 是 MessageEnvelope 字段，**不作为 namespace 拆分依据**；统一 `im-bridge`；跨平台聚合查询一次完成 |

---

## 15. 关联

- `guide/orca-info-agent-framework.md`（v0.2）
- `guide/orca-iphone-channel.md`（v1.0）
- `guide/decisions.md`（D-AGENT-01~15；**D-AGENT-16 rev. IM-0**）
- `guide/orca-im-bridge-review.md`（2026-09-06 Architecture Review 报告）
- `guide/orca-cordis-migration-plan.md`
- `AGENT.md` §5 能力清单 / §6 配置键 / §8 待办（代码开工后同步）
- `TODO.md` / `dev-log.md`（每阶段 commit 同步）
- 开源参考：`baisama-cloud/dsh-omni-bridge`、`PerryLink/dsh-reach` / `PerryLink/dsh-wechat`、`AstrBot`、`wangrongding/wechat-bot`、`NapCatQQ`、`wechatferry`、`tencent-weixin/openclaw-weixin`

---

*本调研稿基于 GitHub 公开资料 + 工作区文档编写，**仅调研不含实现**。代码落地待 Orca 记忆能力实装后按 §10 阶段开工。*
