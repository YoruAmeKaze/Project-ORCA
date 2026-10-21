# Project Orca — Message Adapter 设计报告

> 状态：设计报告（**已冻结；代码落地待 Phase B 记忆能力实装后开工**）
> 日期：2026-09-05
> 依据：`guide/orca-im-bridge.md`（v1.1.1 Accepted）+ `guide/decisions.md` D-AGENT-16（15 条）+ AGENT.md 当前架构 + Phase 6 Memory 成果
> 读者：开发者 / review 者；含 TS 类型签名（均为签名，不含实现）

---

## 1. 当前 Message Adapter 设计

### 1.1 设计原则

Message Adapter 是 Orca 与外部 IM 平台（QQ / 微信）之间的**协议翻译层**。核心原则：

1. **Adapter ≠ Agent**：Adapter 只做"原协议 ↔ MessageEnvelope"，**不调 LLM、不写 infoStore、不做决策**
2. **Orca 只认 Envelope**：无论消息来自 NapCatQQ（OneBot v11）、wechatferry（WCF）还是 openclaw-weixin（腾讯准官方），Orca EventBus 收到的永远是同一个 `MessageEnvelope` 结构
3. **双向对称**：Adapter 同时负责**入站**（接收消息）和**出站**（发送消息）；两者完全对称，都经过 Envelope
4. **无状态 Adapter**：Adapter 本身不维护会话状态；状态由 Orca Runtime（WorldState + infoStore）管理

### 1.2 接口契约

```ts
// src/plugins/im-bridge/adapters/types.ts（草案）
interface ImAdapter {
  /** 平台标识；与 MessageEnvelope.platform 对应 */
  readonly platform: 'qq' | 'wechat'

  /** EventBus source 标识 */
  readonly source: 'im.qq' | 'im.wechat'

  /** 启动连接；连接后开始监听入站消息 */
  start(): Promise<void>

  /** 断开连接；停止监听 */
  stop(): Promise<void>

  /**
   * 将平台原生消息翻译为 MessageEnvelope。
   * - 同步纯函数，无 IO
   * - 平台消息 ID → envelope.messageId
   * - Orca 内部事件 ID 由 envelopeToOrcaEvent() 统一分配
   */
  normalize(raw: PlatformMessage): MessageEnvelope

  /**
   * 通过平台协议发送文本消息。
   * - target 从 envelope.chatId / envelope.isGroup 取
   * - 返回 { ok, error? }
   * - 出错不抛异常，返回 ok:false + error string
   */
  sendText(
    target: { chatId: string; isGroup: boolean },
    text: string
  ): Promise<{ ok: boolean; error?: string }>
}
```

### 1.3 MessageEnvelope（通用信封）

所有 IM 平台共用同一个信封，**Orca 内部不认识任何平台特有概念**：

```ts
// src/types/messageEnvelope.ts（草案）
interface MessageEnvelope {
  /** Orca 内部 Event ID；randomUUID；EventBus / infoStore / Decision back-trace 用 */
  id: string

  /**
   * 平台原始消息 ID。
   * - QQ: OneBot message_id
   * - 微信: WCF msgid / openclaw message_id
   * - 飞书: feishu message_id（已兼容）
   * 用途：跨通道去重 + supersedes 更正的真正键
   */
  messageId: string

  platform: 'qq' | 'wechat' | 'feishu' | 'telegram' | 'discord' | ...

  /** 会话 ID；p2p = 对方用户 ID；群聊 = 群 ID */
  chatId: string

  senderId: string
  senderName?: string        // 昵称；不入档案，仅日志

  text: string               // 纯文本；图片/文件走 attachments
  ts: number                // 消息时间戳（毫秒，UTC）

  isGroup: boolean
  mentionedMe: boolean      // 是否 @ 了 Orca

  attachments?: Array<{
    kind: 'image' | 'file' | 'audio' | 'video'
    /** feishu-style image_key / local path / URL；不存二进制 */
    ref: string
  }>
}
```

**关键约束**：
- `id` ≠ `messageId`：前者 Orca 管（randomUUID），后者平台原生；两者从不混淆
- `text` 必填；非文本内容走 `attachments[]`（引用而非内联二进制）
- 未来接入 Telegram / Discord 只需新增 `platform` 枚举值，Orca 主体**零改动**

### 1.4 Adapter 实现差异（各平台不同，Orca 屏蔽）

| 平台 | 底层协议 | Adapter 需处理的事 | Orca 感知不到的事 |
|---|---|---|---|
| **QQ** | NapCatQQ（OneBot v11 HTTP）| 调用 `/send_msg` API；处理 OneBot 事件帧 | NTQQ 协议版本号 / 登录态 token 刷新 |
| **微信** | wechatferry（WCF HTTP）| 调用 WCF API；处理 WCF 消息帧 | 微信版本 / 消息加密方式 |
| **微信（准官方）** | openclaw-weixin / ClawBot API | 调用腾讯官方 API；处理 API 限频 | 微信官方接口配额 / 签名算法 |
| **企业微信** | 企业微信官方 webhook | POST JSON 到 webhook URL | 企业微信应用Secret 管理 |

Adapter 对 Orca 屏蔽了所有平台特有的协议细节。

### 1.5 namespace 与存储

```
namespace = im-bridge（统一，不按 platform 拆）
type = im-message

payload.envelope = MessageEnvelope（完整入档）

查询跨平台（如"昨天 X 在所有平台给我发的消息"）
  → query({ namespaces: ['im-bridge'] })
  → 在 payload.envelope.platform 上过滤
  → 无需 union 多个 namespace
```

---

## 2. 文件结构

```
app-cordis/src/
├── types/
│   └── messageEnvelope.ts          ★ 新增：MessageEnvelope 类型（所有 IM 平台共用）
│
├── plugins/
│   └── im-bridge/                  ★ 新增：IM 中转插件（整体作为 Cordis 插件挂载）
│       ├── index.ts                 # 插件入口：注册 adapter + 监听 adapter 入站 + 发布 EventBus
│       │
│       ├── adapters/               # ★ 适配器层（各平台独立文件）
│       │   ├── types.ts            # ImAdapter 接口 + PlatformMessage（平台原生消息类型）
│       │   ├── qq-adapter.ts       # NapCatQQ 实现（PoC）
│       │   ├── wechat-adapter.ts   # wechatferry / openclaw 实现（PoC）
│       │   └── utils.ts            # normalize 辅助（时间戳/ID 提取等）
│       │
│       ├── message-bus.ts          # Adapter → EventBus 桥：
│       │                            #   adapter.start() → adapter.on('message') → envelopeToOrcaEvent → EventBus.publish
│       │                            #   adapter.stop()  → EventBus 无缝断开
│       │
│       ├── config.ts               # ORCA_IM_* 配置读取
│       │
│       └── im-bridge-registry.ts  # 多 adapter 注册与管理（startAll / stopAll）
│
├── agents/builtins/
│   └── im-archive-agent.ts        ★ 新增：im-archive-agent（InfoAgent；只做 Pull 查档）
│
├── services/
│   └── im-archiver.ts              ★ 新增：im-archive-service（Adapter → infoStore Push 写档；
│                                      与 message-bus.ts 分开，因为 Push 写档是异步的）
│
└── plugins/
    └── action-handlers/
        ├── im-send-handler.ts       ★ 新增：ActionHandler（act, handler='im.send'）
        └── registry.ts              # ActHandlerRegistry（可注册多个 handler）
```

**新增文件总计**（Phase C ~ I 全部实现后）：

| 文件 | 性质 | 归属阶段 |
|---|---|---|
| `types/messageEnvelope.ts` | 新增类型 | C |
| `plugins/im-bridge/adapters/types.ts` | 接口 | C |
| `plugins/im-bridge/adapters/qq-adapter.ts` | 实现（PoC） | I |
| `plugins/im-bridge/adapters/wechat-adapter.ts` | 实现（PoC） | J |
| `plugins/im-bridge/adapters/utils.ts` | 辅助 | C |
| `plugins/im-bridge/message-bus.ts` | 桥接逻辑 | C |
| `plugins/im-bridge/config.ts` | 配置 | C |
| `plugins/im-bridge/im-bridge-registry.ts` | 多 adapter 管理 | C |
| `plugins/im-bridge/index.ts` | 插件入口 | C |
| `agents/builtins/im-archive-agent.ts` | InfoAgent | G |
| `services/im-archiver.ts` | Push 写档服务 | C |
| `plugins/action-handlers/im-send-handler.ts` | ActionHandler | H |
| `plugins/action-handlers/registry.ts` | handler 注册表 | H |

**不变文件（零改动）**：
- `services/eventBus.ts`、`services/worldState.ts`、`services/attention.ts`、`services/decision.ts`、`services/action.ts` — 这些是 Orca Runtime 核心，IM 中转通过 EventBus 接入，不改内部实现
- `plugins/feishu-channel.ts` — 飞书通道独立，IM 中转不碰

---

## 3. 数据流

### 3.1 入站数据流（消息从 IM 平台进 Orca）

```
QQ 消息 / 微信消息
   │
   ▼
IM Adapter.normalize(raw)
   │  输出：MessageEnvelope
   │  ├ id: randomUUID()         ← Orca 内部 ID
   │  ├ messageId: "xxx"         ← 平台原生 ID（跨通道去重用）
   │  ├ platform: "qq"
   │  ├ chatId: "group_678"
   │  ├ senderId: "user_123"
   │  ├ text: "晚上吃饭吗？"
   │  └ ts: 1736140800000
   │
   ▼
imBridgeRegistry.onMessage(envelope)
   │
   ├─► imArchiver.push(envelope)    【异步，不阻塞 EventBus】
   │      └─► infoStore.append({
   │             namespace: "im-bridge",
   │             type: "im-message",
   │             payload: { envelope },
   │             ttlDays: 7
   │           })
   │
   └─► EventBus.publish({
          id: randomUUID(),
          source: "im.qq",
          type: "im.message",
          ts: envelope.ts,
          data: { envelope }
        })
           │
           ▼
        WorldStateUpdater
        （IM reducer：更新 extensions.im.lastSeen + extensions.im.recentSender）
           │
           ▼
        AttentionEngine
        （6 条 IM 规则评估：im-urgent / im-private-default / im-auto-reply / im-group-default / im-spam-throttle / im-overnight）
           │
           ▼
        DecisionEngine
        （四态终态：act / notify / defer / archive）
           │
           ▼
        ActionExecutor
        （按 Decision.action 分派）
        ┌──────┬──────────┬───────────┬──────────┐
        ▼      ▼          ▼           ▼          ▼
      act    notify     defer     archive    ignore
     (H)   (Phase4.E)  (Phase4.D)  (noop)   (noop)
     im.send
     + requiresApproval
```

**关键点**：
- `normalize()` 是**同步纯函数**，无任何 IO；平台消息的解析在 `adapter.normalize()` 内部完成，Orca EventBus 收到时已经是干净的 Envelope
- `push()` 写档是**异步非阻塞**，不影响 EventBus 实时性
- `EventBus.publish()` 是 **fire-and-forget**，不等待下游处理

### 3.2 出站数据流（Orca 的回复 / 代回）

```
用户飞书消息 / Dashboard 命令 / Attention 自动触发
   │
   ▼
Orca agent（CEO：理解意图 → 查档 → 汇总）
   │
   ▼
Decision { action: "act", handler: "im.send", requiresApproval: true/false, ... }
   │
   ▼
ActionExecutor.execute(decision)
   │
   ▼
ActHandlerRegistry.get("im.send")
   │
   ▼
imSendActHandler.handle({ envelope, text })
   │
   ├─► requiresApproval?
   │      ├─ true:  走 Phase 4.E 审批流（飞书通知用户"批准/拒绝"）
   │      └─ false: 直接发送
   │
   └─► Orca 选定的 adapter.sendText(target, text)
           └─► QQ: POST /send_msg
               微信: WCF HTTP API
```

**Orca 发起的消息（notify / defer）不走此路径**，走 Phase 4.C NotifyHandler，直接调 `FeishuClient.sendToChat`（飞书通道），完全独立于 IM Adapter。

### 3.3 Push 中转数据流（第三方 Bot → Orca，不自建 Adapter 时）

当用户不想自建 NapCatQQ / wechatferry，可通过已有的 HTTP Push 通道：

```
第三方 Bot（NapCatQQ / wechatferry 外部实例）
   │
   │ POST /info/records
   │ Authorization: Bearer <token>
   │ Content-Type: application/json
   │
   ▼
info-receiver 已有端点（已实现，D-AGENT-12）
   │
   ▼
infoStore.append({ namespace: "im-bridge", type: "im-message", payload: { envelope }, ... })
   │
   ▼
EventBus.publish({ source: "im.external", type: "im.message", data: { envelope } })
   │
   ▼
（后续同入站数据流：WorldState → Attention → Decision → Action）
```

**注意**：这种方式 adapter 不存在，`source` 为 `"im.external"`，Attention 规则仍可匹配（`event.source.startsWith('im.')`）。

---

## 4. Event 类型

### 4.1 新增 Event 类型

| Event type | 产生位置 | 载荷 | 流向 |
|---|---|---|---|
| `im.message` | `message-bus.ts`（adapter.start() 后平台消息到达） | `{ envelope: MessageEnvelope }` | EventBus → WorldStateUpdater → AttentionEngine → DecisionEngine |
| `im.send` | `imSendActHandler`（ActExecutor 调 handler 时） | `{ envelope, text, decisionId }` | 本地事件，不进 EventBus（只在 ActionExecutor 内部） |

### 4.2 OrcaEvent 结构（完整）

```ts
// src/types/event.ts（草案扩展）
interface OrcaEvent {
  id: string              // randomUUID
  source: 'feishu' | 'calendar' | 'pc' | 'phone' | 'iot' | 'environment' | 'internal' | 'im.qq' | 'im.wechat' | 'im.external' | ...
  type: string            // e.g. 'im.message' | 'feishu.message' | 'orca/state_changed' | ...
  ts: number
  data: unknown           // 类型窄化由各 adapter / channel 负责
}
```

### 4.3 WorldState 新增字段

```ts
// src/types/worldState.ts（草案扩展）
interface WorldState {
  user: { status: 'awake' | 'busy' | 'sleeping' | 'away'; focus_mode: boolean }
  device: { ... }
  time: { ... }
  extensions: {
    im: {
      importantContacts: Array<{ platform: 'qq' | 'wechat' | 'feishu'; id: string; name: string }>
      autoReplyContacts:  Array<{ platform: 'qq' | 'wechat' | 'feishu'; id: string; name: string }>
      blockedContacts:   Array<{ platform: 'qq' | 'wechat' | 'feishu'; id: string; name: string }>
      // ★ 注意：不存 lastSeen / lastMessage / recentChats（见 §1 边界）
    }
  }
}
```

**WorldState 的 IM 相关字段严格只存当前配置**（三个联系人列表 + 用户状态），**不存历史缓存**。历史消息查 `infoStore.query()`。

### 4.4 EventBus Source 标识对照

| source | 含义 |
|---|---|
| `im.qq` | QQ 消息（NapCatQQ adapter） |
| `im.wechat` | 微信消息（wechatferry / openclaw adapter） |
| `im.external` | 外部 Push（`POST /info/records`，不经 adapter） |
| `im.feishu` | 飞书消息（已有 `feishu` 通道；但 Orca 飞书通道不使用 `im.feishu`——`im.feishu` 仅当 IM 中转的飞书端才出现） |

---

## 5. 是否涉及 LLM

**结论：Message Adapter 层本身不涉及 LLM。但 IM 消息触发 CEO 决策时经过 LLM（与飞书消息完全相同）。**

### 5.1 Adapter 层（无 LLM）

```ts
// adapter.normalize() — 纯函数，无任何网络请求，无 LLM
function normalize(raw: PlatformMessage): MessageEnvelope {
  return {
    id: randomUUID(),
    messageId: raw.message_id,      // 平台 ID 直接映射
    platform: 'qq',
    chatId: raw.group_id ?? raw.user_id,
    senderId: raw.user_id,
    text: raw.message,               // 纯文本提取，无理解
    ts: raw.time * 1000,
    isGroup: Boolean(raw.group_id),
    mentionedMe: raw.message.includes('[CQ:at,qq=Orca]'),
    // ...
  }
}
```

**normalize() 是确定性解析**，不做任何语义理解。

### 5.2 IM Archiver（Push 写档，无 LLM）

```ts
// imArchiver.push() — 纯写档，无 LLM
async function push(envelope: MessageEnvelope): Promise<void> {
  await ctx.infoStore.append({
    namespace: 'im-bridge',
    type: 'im-message',
    payload: { envelope },
    ts: Date.now(),
    source: `im.${envelope.platform}`,
    confidence: 1.0,
    urgency: 0,
    ttlDays: 7,
  })
}
```

### 5.3 LLM 介入点（与飞书消息相同路径）

```
EventBus.publish('im.message')
   │
   ▼
AttentionEngine（纯规则，无 LLM）→ Decision
   │
   ▼
Decision.action
   │
   ├─ archive / ignore     → 无 LLM
   ├─ notify / defer       → 无 LLM（Phase 4.C NotifyHandler 直接调 FeishuClient）
   └─ act
        │
        ├─ requiresApproval=true → LLM 介入（Orca CEO：生成待审批内容）
        └─ requiresApproval=false → 直接发送（无 LLM）
```

**具体说明**：

| 场景 | LLM 是否介入 | 原因 |
|---|---|---|
| `im-auto-reply` + autoReplyContacts | ❌ 无 | autoReplyContacts = 用户已授权白名单；Decision(act, handler='im.send', requiresApproval=false) 直接调 adapter.sendText |
| `im-urgent-from-important` + requiresApproval=true | ✅ LLM 介入 | Orca CEO 生成"张三（QQ）问你晚上吃饭吗。要我代回吗？"的审批通知，经 FeishuClient 推给用户 |
| 用户主动问"昨天 X 在微信说什么了" | ✅ LLM 介入 | CEO R0 查档未命中 → LLM 参与理解意图 + 汇总回复 |
| `im-group-default`（群聊默认归档）| ❌ 无 | archive action → noopHandler，直接写档 |
| `im-overnight-from-important` → defer | ❌ 无 | defer → Phase 4.D scheduler；scheduler 不调 LLM |

**LLM 介入的唯一路径是 Orca CEO（agent.ts）**，与消息来自飞书还是 IM 无关。IM Adapter 本身的存在不改变 LLM 调用逻辑。

---

## 6. 自动回复设计

### 6.1 四态决策（完整映射）

```
AttentionItem.action           Decision.action       需要 LLM   需要审批   执行方式
────────────────────────────────────────────────────────────────────────────────────
act (im-auto-reply)           act                   ❌           ❌        adapter.sendText()
act (需审批)                  act                   ✅           ✅        审批流 → adapter.sendText()
notify_immediately            notify                ❌           ❌        FeishuClient.sendToChat()
wait_until_available          defer                 ❌           ❌        Phase 4.D scheduler
remember_only                 archive               ❌           ❌        infoStore.append()（已由 imArchiver 完成）
ignore                        ignore                ❌           ❌        丢弃
```

### 6.2 自动回复的具体路径

**路径 A：autoReplyContacts 白名单（无需审批）**

```
收到快递机器人消息（senderId ∈ autoReplyContacts）
   ↓
AttentionEngine → im-auto-reply 命中
   ↓
Decision { action: "act", handler: "im.send", requiresApproval: false }
   ↓
ActionExecutor → imSendActHandler.handle({ envelope, text: "好的，明天上午 10 点取。" })
   ↓
adapter.sendText({ chatId, isGroup }, "好的，明天上午 10 点取。")
   ↓
Orca 飞书通知你：（代回已发）快递机器人 QQ：好的，明天上午 10 点取。
```

**路径 B：需要审批的 act**

```
收到导师消息（senderId ∈ importantContacts，但非 autoReplyContacts）
   ↓
AttentionEngine → im-urgent-from-important 命中
   ↓
Decision { action: "act", handler: "im.send", requiresApproval: true, reason: "导师消息，需审批" }
   ↓
ActionExecutor → imSendActHandler.handle({ envelope, text: "李老师，您找我什么事？" })
   ↓
requiresApproval=true → 审批流
   ↓
FeishuClient.sendToChat({
  text: `导师（微信）发来消息：您找我什么事？
---
是否代回？回"代回 + 内容"或"忽略"。`
})
   ↓
用户回复"代回 好的，李老师，我在处理"
   ↓
Phase 4.E 审批消费 → adapter.sendText({ chatId, isGroup }, "好的，李老师，我在处理")
```

### 6.3 requiresApproval 决策逻辑

```ts
// Decision 引擎中（草案）
function decideAttention(attentionItem: AttentionItem): Decision {
  const base = createBaseDecision(attentionItem)

  // 默 all act 需要审批
  if (base.action === 'act') {
    base.requiresApproval = true

    // 规则可显式覆盖（im-auto-reply 配置过 autoReplyContacts）
    if (attentionItem.ruleId === 'im-auto-reply') {
      base.requiresApproval = false   // autoReplyContacts 已在白名单
      base.reason = `senderId 在 autoReplyContacts 中，自动代回（无需审批）`
    }
  }

  return base
}
```

### 6.4 ActHandlerRegistry（可扩展）

```ts
// src/plugins/action-handlers/registry.ts（草案）
type ActHandlerName =
  | 'im.send'
  | 'feishu.reply'
  | 'tts.speak'
  | 'calendar.create'
  | 'todo.add'
  // 未来可扩展：mqtt.publish / webhook.post / ...

interface ActHandler {
  name: ActHandlerName
  /** 返回 true 表示支持此 decision */
  canHandle(decision: Decision): boolean
  handle(input: unknown, ctx: ActionContext): Promise<ActionResult>
}

// 全局注册表（单例）
const actHandlerRegistry = new Map<ActHandlerName, ActHandler>()

function registerActHandler(h: ActHandler): void {
  actHandlerRegistry.set(h.name, h)
}

// ActionExecutor.execute() 内部分派
async function executeAct(decision: Decision, ctx: ActionContext): Promise<ActionResult> {
  const handler = actHandlerRegistry.get(decision.handler as ActHandlerName)
  if (!handler) return { ok: false, error: { code: 'UNKNOWN_HANDLER', message: `no handler for ${decision.handler}` } }
  if (!handler.canHandle(decision)) return { ok: false, error: { code: 'HANDLER_REJECT', message: `handler ${handler.name} cannot handle this decision` } }
  return handler.handle(decision.handlerInput, ctx)
}
```

---

## 7. 和现有 Runtime 的连接方式

### 7.1 接入点一览

| Runtime 组件 | IM 中转的接入方式 | 是否改动内部实现 |
|---|---|---|
| **EventBus** | IM Adapter → `EventBus.publish(orcaEvent)` | ❌ 零改动；EventBus 是 pub/sub 总线，IM 只是又一个 publisher |
| **WorldState** | IM Adapter → `WorldStateUpdater`（注册 reducer：`'im:*'`）| ❌ 零改动；WorldStateUpdater.reducer 注册表对所有 source 开放 |
| **AttentionEngine** | 新增 6 条规则 → `AttentionRuleRegistry.register()` | ❌ 零改动；registry 是开放接口 |
| **DecisionEngine** | 零改动；Decision 四态是现有结构的扩展 | ❌ 零改动 |
| **ActionExecutor** | 新增 `ActHandlerRegistry` + `im.send` handler | ❌ 零改动；registry 是开放接口 |
| **NotifyHandler** | 无改动；IM 消息通知走 FeishuClient（已有）| ❌ 零改动 |
| **infoStore** | `imArchiver.push()` → `infoStore.append()` | ❌ 零改动；infoStore 是通用存储 |
| **feishu-channel** | 完全独立；IM 消息触发通知时调 FeishuClient | ❌ 零改动 |
| **Dashboard** | `/api/status` / `/api/events` 自然包含 IM 数据 | ❌ 零改动 |

**总结**：IM 中转对 Runtime 的所有接入都是**接口开放**的（EventBus publish / WorldStateUpdater reducer 注册 / AttentionRuleRegistry / ActionHandlerRegistry / infoStore.append），Runtime 内部实现**零改动**。

### 7.2 插件挂载顺序

```ts
// src/index.ts（草案扩展）
function loadOrcaPlugins(ctx: Context) {
  // ... 现有插件 ...

  // IM 中转（新增）
  // 挂载顺序依赖：
  //   1. infoAgents（infoStore 必须已注册）
  //   2. actionExecutor（ActHandlerRegistry 依赖）
  //   3. attentionEngine（IM 规则注册在其之后 OR 单独 registry）
  //   4. decisionEngine（在 attentionEngine 之后）
  //   5. imBridge（注册 adapter，启动 start()）

  ctx.use(infoAgentsPlugin)           // infoStore 必须先有
  ctx.use(actionExecutorPlugin)        // ActHandlerRegistry 必须先有
  ctx.use(attentionEnginePlugin)       // IM 规则在 registry 上注册
  ctx.use(decisionEnginePlugin)        // 在 attention 之后

  // IM 规则注册（在 attentionEngine 之后注册到它的 registry）
  ctx.attention.registerIMRules()      // 6 条 IM 规则

  // ActHandler 注册（在 actionExecutor 之后注册到它的 registry）
  ctx.actionExecutor.registerActHandler(createImSendActHandler(adapters))

  // 最后挂载 IM Bridge（触发 adapter.start()）
  ctx.use(imBridgePlugin)             // start() 是异步的，在 .afterMount 中 await
}
```

### 7.3 与 Phase 6 Memory 的关系

| Phase 6 Memory 组件 | 与 IM 中转的关系 |
|---|---|
| `MemoryStore` | **共用**；IM 消息作为 `source: 'im.qq'` 等写入 MemoryStore；Attention 评估规则与 Phase 6 规则完全独立 |
| `ReflectionEngine` | IM 消息的 reflection 走 Phase 6 框架（source filter `'im.*'`）；与现有 `feishu` 等并行 |
| `AttentionEngine` | IM 规则注册到同一个 `AttentionRuleRegistry`；throttle / dedup 自然复用（`source='im.qq'`） |
| `MemoryArchiver` | IM Push 写档走 `infoStore.append()`，不是 MemoryArchiver（两者是不同存储路径） |
| `ConflictDetector` | IM 消息产生的 memory 与其他 source 并行检查冲突；不影响冲突检测逻辑 |

**结论**：Phase 6 Memory 是通用层，IM 中转是另一个 source 的数据生产者。两者完全正交，不互相依赖。

---

## 8. 测试计划

### 8.1 测试分层

| 层级 | 测试对象 | 测试方式 | 验收标准 |
|---|---|---|---|
| **L1 单元** | `normalize()` | 纯函数，输入平台原生消息，断言输出 MessageEnvelope 字段正确 | messageId / chatId / senderId / text / ts / isGroup / mentionedMe 全对 |
| **L1 单元** | `ActHandlerRegistry` | register / get / canHandle / handle 正常注册查找 | 重复注册覆盖；未知 handler 返回明确 error |
| **L1 单元** | Attention IM 规则 | 输入各种 OrcaEvent，断言 ruleId / action / priority | 6 条规则每条至少 3 个 case；throttle / dedup 验证 |
| **L1 单元** | Decision 四态映射 | 输入 AttentionItem，断言 Decision.action / handler / requiresApproval | act → 4 种组合全覆盖；notify / defer / archive / ignore 直通 |
| **L1 单元** | MessageEnvelope 双 ID | 输入 `{ id, messageId }`，断言去重键正确 | `(platform, messageId)` 唯一 |
| **L2 集成** | `message-bus.ts` | mock adapter.start() / on('message') / EventBus.publish | 入站消息 → EventBus.publish 被调用 1 次；参数正确 |
| **L2 集成** | `imArchiver.push()` | mock infoStore.append()；断言 append 被调用 1 次 | namespace='im-bridge' / type='im-message' / payload 含 envelope |
| **L2 集成** | `im-send-handler` | mock adapter.sendText()；断言正确 adapter 被调用 | platform 对应 / text 原样传递 |
| **L2 集成** | adapter 选择逻辑 | Decision { handler: 'im.send', platform: 'qq' } → assert qq-adapter 被选 | wechat / qq 路由正确 |
| **L3 E2E** | IM Adapter + Runtime | mock adapter（不发真实网络）；完整数据流从 EventBus 到 ActionResult | archive / notify / defer / act 每条路径 smoke |
| **L3 E2E** | requiresApproval=true | mock FeishuClient；断言审批通知被发送 | requiresApproval=false 不触发 FeishuClient |
| **L3 E2E** | 多 adapter 并存 | 同时启动 qq-adapter + wechat-adapter；发 QQ 消息 + 微信消息 | 各自路由正确，不混淆 |
| **L4 PoC** | NapCatQQ 真实连接 | 备用小号登录 NapCatQQ；发真实消息 | normalize 解析正确；EventBus 收到消息 |
| **L4 PoC** | 真实发送 | autoReplyContacts 白名单；真实代回 | 对方收到消息；Orca 飞书通知用户 |

### 8.2 建议测试框架

- **L1 / L2**：Node.js 内置 `assert`（或 `node:test`）+ `vitest` 任选
- **L3 E2E**：mock adapter 不发真实网络，可本地跑
- **L4 PoC**：manual test + screen recording；不设自动化（协议可能变）

### 8.3 冒烟测试清单（smoke-im-bridge）

```
normalize
  ✓ QQ 私聊消息 → envelope.chatId=对方ID, isGroup=false
  ✓ QQ 群聊消息 → envelope.chatId=群ID, isGroup=true, mentionedMe 正确
  ✓ 微信文本消息 → messageId 映射正确
  ✓ 带图片附件 → attachments.length=1, kind='image'

Decision 四态
  ✓ act + autoReply → requiresApproval=false, handler='im.send'
  ✓ act + importantContact → requiresApproval=true
  ✓ notify → action='notify'
  ✓ defer → action='defer'
  ✓ archive → action='archive'
  ✓ ignore → action='ignore'

Attention IM 规则
  ✓ importantContacts → im-urgent-from-important
  ✓ 私聊非 important → im-private-default
  ✓ autoReplyContacts → im-auto-reply
  ✓ 群聊非 important → im-group-default
  ✓ blockedContacts → im-spam-throttle
  ✓ sleeping + important → im-overnight-from-important

Throttle
  ✓ 同一 source 5 秒内 2 条 → 第 2 条被 throttle（不产生 AttentionItem）
  ✓ 不同 source 各自独立 throttle

Adapter 路由
  ✓ platform='qq' → qq-adapter.sendText 被调用
  ✓ platform='wechat' → wechat-adapter.sendText 被调用

requiresApproval
  ✓ false → sendText 直接调用
  ✓ true → FeishuClient.sendToChat 被调用（审批通知）
```

**总用例数**：约 30–40 个 L1/L2 smoke + 5–8 个 L3 E2E = **40–50 个用例**。

### 8.4 测试不覆盖的内容（PoC 阶段不管）

| 内容 | 原因 |
|---|---|
| NapCatQQ 协议解析细节 | 由 NapCatQQ 自身维护；Orca 只消费 Envelope |
| 真实账号封号 | PoC 阶段用备用小号；正式阶段用户自管 |
| WCF 消息帧格式 | 由 wechatferry 维护；Orca 只消费 Envelope |
| 多设备同时在线的时序问题 | 属于平台侧问题；Orca 以 EventBus 时间戳为准 |

---

## 附录 A：快速对照表

| 问题 | 答案 |
|---|---|
| Adapter 是否调 LLM？ | ❌ 否；normalize() 是纯函数；LLM 只在 CEO 决策时介入 |
| IM 消息是否走 EventBus？ | ✅ 是；Adapter.start() → EventBus.publish({ source:'im.qq', type:'im.message' }) |
| IM 消息是否存 infoStore？ | ✅ 是；imArchiver.push() 异步写档 |
| 自动回复是否需要 LLM？ | ❌ 否；autoReplyContacts 白名单直接调 adapter.sendText |
| 重要联系人来消息是否自动回复？ | ❌ 否；importantContacts → notify（提醒用户亲自回），绝不代回 |
| WorldState 存 IM 历史？ | ❌ 否；只存 importantContacts / autoReplyContacts / blockedContacts + user.status |
| 同时接 QQ 和微信会混淆？ | ❌ 否；source='im.qq' / source='im.wechat' 完全独立路由 |
| 是否改动 EventBus 内部实现？ | ❌ 否；EventBus 是 pub/sub 总线，IM 只是又一个 publisher |
| 企业微信是 IM Adapter 吗？ | ❌ 否；企业微信 webhook 是 Notify Channel（Orca→你），不是 IM 回复通道 |
| 未来接 Telegram 要改什么？ | 新增 adapter + enum platform='telegram'；Orca 主体零改动 |

---

## 附录 B：与现有设计的对应关系

| 设计文档 | 在本报告中的落地点 |
|---|---|
| `guide/orca-im-bridge.md` §5.1 | §1 当前设计 |
| D-AGENT-16 16-01 | §1.1 Adapter ≠ Agent 原则 |
| D-AGENT-16 16-02/16-14 | §1.3 MessageEnvelope 双 ID |
| D-AGENT-16 16-03/16-04 | §6 自动回复四态 |
| D-AGENT-16 16-05 | §6.3 requiresApproval 逻辑 |
| D-AGENT-16 16-08 | §1.4 企业微信 ≠ IM Adapter |
| D-AGENT-16 16-10 | §4.3 WorldState 边界 |
| D-AGENT-16 16-13 | §7 Runtime 接入点 |
| D-AGENT-16 16-15 | §1.5 namespace 不拆 |
| AGENT.md §8.3 Runtime | §7.2 插件挂载顺序 |

---

*本报告基于 `guide/orca-im-bridge.md`（v1.1.1 Accepted）+ D-AGENT-16（15 条）编写，作为代码开工前的设计确认稿。代码落地待 Orca 记忆能力实装（Phase B）。*
