# Orca Architecture Decisions

> 逐条讨论产生的决议，每次有新决议追加。按话题分组。

---

## 文件结构

```
src/
├── main.py                 # FastAPI 入口（不变）
├── config.py               # 配置（不变）
├── router/
│   └── feishu.py           # 飞书 webhook（不变）
│
├── core/
│   ├── orchestrator.py     # ★ 重写：串起 Planner → Validator → Runtime
│   ├── planner.py          # ★ 新增：关键词匹配 + 约束过滤 + LLM 出 DSL
│   ├── history.py          # 保留
│   └── persona.py          # 保留
│
├── dsl/
│   ├── schema.py           # ★ 新增：Plan / SkillCall 数据模型
│   └── validator.py        # ★ 新增：四层校验
│
├── skill/
│   ├── registry.py         # ★ 新增：SkillRegistry（metadata + handler 映射）
│   └── handlers/
│       ├── screenshot.py   # capture_screenshot
│       ├── analyze.py      # analyze_image
│       ├── action.py       # click / type_text / scroll 等
│       ├── search.py       # search_web
│       └── reply.py        # reply
│
├── runtime/
│   ├── engine.py           # ★ 新增：DSL 顺序执行器
│   └── context.py          # ★ 新增：RuntimeContext
│
├── feishu/
│   └── client.py           # 保留（外部依赖，不进 context）
│
├── tasks/
│   └── luckin.py           # 保留，暂不启用
```

### 删除
- `agent.py` → 被 `planner.py` 替代
- `chat.py` → 闲聊走一步 `reply` plan
- `vision/` → handler 移入 `skill/handlers/`
- `action/` → handler 移入 `skill/handlers/`

### 原则
- 外部依赖（feishu/client.py、httpx）不进 skill handler，由 engine 在构造时注入
- dsl/、skill/、runtime/ 三个新目录职责清晰，不互相越界

---

## 迁移策略

### D-MIG-01: 三阶段过渡

**阶段 A：平行编写**
- 新代码全部新建文件（`dsl/`、`skill/`、`runtime/`、`core/planner.py`）
- 不删不改旧文件（`agent.py`、`action/`、`vision/`）
- 新旧代码互不依赖

**阶段 B：环境变量开关**
- 开关放在 `config.py`：`USE_NEW_ARCH = _bool("USE_NEW_ARCH", False)`
- 本地测试：设置环境变量 `USE_NEW_ARCH=true` 走新流程
- 线上：不设环境变量，默认走旧流程
- `orchestrator.py` 根据 `config.USE_NEW_ARCH` 路由到旧流程或新流程

**阶段 C：清理**
- 新流程验证通过后，删除旧文件（`agent.py`、`action/`、`vision/`、`chat.py`）
- 从文档和 `.env.example` 中移除 `USE_NEW_ARCH`
- 新流程成为唯一路径

---

## DSL

### D-DSL-01: 格式
JSON，LLM 输出 JSON，Runtime 用 `json.loads` 解析。

### D-DSL-02: 引用
支持 `{{step.<id>.output}}` 引用上一步输出。只引用，不计算。无嵌套、无表达式、无条件。

### D-DSL-03: 引用名
统一用单数 `step`，不用复数 `steps`。

### D-DSL-04: 多步串联
Phase 1 允许多步串联，线性执行。

### D-DSL-05: 失败策略
fail-fast。一步失败整个 plan 终止，不重试、不 fallback。

### D-DSL-06: 强制 reply
DSL 的最后一步必须是 `reply`，否则 validator 报错。

### D-DSL-07: Output 类型
每个 skill 必须明确定义 output 类型。当前所有 skill output = `string`，`Any` 预留给以后扩展。

### D-DSL-08: Output 约定
capture_screenshot 输出图片文件路径，非 base64。

---

## Skill Registry

### D-SKILL-01: 函数级原子性
每个 skill 是一个原子操作，不合并多个动作。

### D-SKILL-02: 拆解 execute_action
拆为独立 skill：`click`、`double_click`、`right_click`、`move_mouse`、`type_text`、`scroll`。每个只做一件事。

### D-SKILL-03: scroll 增加 direction 参数
`direction: "up" | "down"`。

### D-SKILL-04: 无 chat skill
去掉 `chat`，只保留 `reply`。闲聊场景 = 一步 `reply`。

### D-SKILL-05: Phase 1 技能清单

| Skill | 参数 | Output |
|-------|------|--------|
| `reply` | `message: string` | `null` |
| `capture_screenshot` | 无 | `string`（图片文件路径） |
| `analyze_image` | `task: string`, `image_path: string` | `string` |
| `click` | `x: int`, `y: int` | `string` |
| `double_click` | `x: int`, `y: int` | `string` |
| `right_click` | `x: int`, `y: int` | `string` |
| `move_mouse` | `x: int`, `y: int` | `string` |
| `type_text` | `text: string` | `string` |
| `scroll` | `clicks: int`, `direction: "up"\|"down"` | `string` |
| `search_web` | `query: string` | `string` |

---

## Validator

### D-VAL-01: 四层校验

| 层级 | 名称 | 校验内容 | 失败处理 |
|------|------|----------|----------|
| 0 | **安全审查** | LLM 判断 plan 整体合理性：返回 `safe` / `warn` / `block` | `warn`→继续；`block`→终止 + reply |
| 1 | **格式校验** | 合法 JSON、含 `steps` 数组、每个 step 含 `skill` 字段 | LLM **重出一次**（共 2 次机会） |
| 2 | **引用校验** | `{{step.<id>.output}}` 的 id 存在且在当前 step **之前** | fail-fast + reply |
| 3 | **Skill 校验** | skill 在 registry 中存在、参数类型/enum/必填匹配 schema | fail-fast + reply |

### D-VAL-02: 重试上限
层级 1（格式校验）失败时 LLM 重出一次，总共 2 次机会。其余层级不重试。

### D-VAL-03: 失败必须 reply
层级 2、3 报错后，Runtime 必须自动执行一条 `reply` 把错误原因发回给用户。

### D-VAL-04: 安全审查最优先
安全审查在格式校验之前执行，最先跑。

---

## Orchestrator

### D-ORC-01: 一条消息 = 一个 plan
用户每发一条消息，Orchestrator 跑一遍完整流程（Planner → Validator → Runtime → reply）。plan 之间无状态关联。

### D-ORC-01a: reply 内容由 Planner 生成
Planner 一次 LLM 调用时顺带生成 reply 的 message 内容，不额外调第二次 LLM。
- 纯闲聊：`message` 直接写死回复文字
- 需执行：`message` 用 `{{step.<id>.output}}` 引用执行结果
用户每发一条消息，Orchestrator 跑一遍完整流程（Planner → Validator → Runtime → reply）。plan 之间无状态关联。

### D-ORC-02: 历史对话复用现有 history.py
Phase 1 不并入 DSL 框架，继续用现有的 `HistoryManager` 维护最近 N 轮对话上下文。

### D-ORC-03: ACK 和 Narration 是 Orchestrator 层行为
- **ack（条件触发）**：仅当 plan 需要实际执行时发送。纯闲聊（一步 reply，固定内容）跳过 ack
- **narration（可选）**：执行过程中告知用户进度的中间消息，Orchestrator 在 Runtime 执行期间触发
- **两者都不是 skill**，不进入 DSL、不入 Skill Registry、不走 step 执行流程。Runtime 完全不知晓它们的存在
- `reply`（DSL 最后一步）只负责发最终结果给用户
- 发送失败均为 fire-and-forget，不影响主流程

### D-ORC-04: Phase 1 串行锁
同一时间只允许一个 plan 在 Runtime 中执行。第二条消息排队等待，当前 plan 完成后自动处理队列中的下一条。

---

## Planner & Skill Selection

### D-PLAN-01: Phase 1 用关键词匹配，不用 embedding
当前 skill 约 10-15 个，embedding 基础设施成本远超收益。等 skill > 50 再迁移。

### D-PLAN-02: reply 强制注入
reply 不参与筛选，始终在候选列表里。

### D-PLAN-03: 三步流水线
```
技能检索（关键词匹配）→ 约束过滤（权限/环境）→ LLM 决策 + DSL 生成（一次调用）
```

### D-PLAN-04: 约束过滤在 LLM 介入前跑完
硬规则，不可跳过。Phase 1 做：
- 权限检查：skill.permission <= system.current_permission
- 环境检查：依赖特定 adapter 的 skill，adapter 不可用时过滤掉

Phase 1 不做参数匹配过滤，留到 Phase 2。

### D-PLAN-05: 不拆两阶段 LLM
约束过滤后的候选 skill 列表直接注入 system prompt，LLM 一次性完成选择和 DSL 编排。不做 scoring-then-assembly。

### D-PLAN-06: Skill 描述用自然语言
system prompt 中 skill 描述用自然语言（标题 + 描述 + 参数简述 + 输出简述）。完整 JSON Schema 只给 Validator 用，不给 LLM。

### D-PLAN-07: 检索结果为空时直接 reply
候选 skill 列表为空或无匹配时，不把全量 skill 列表兜底给 LLM，直接触发 reply 告知用户"当前无法完成该操作"。

### D-PLAN-08: 一次性出完整 plan
LLM 拿到用户意图和候选 skill 列表，一次生成完整 DSL。Runtime 执行全程不回调 LLM。执行完毕强制 reply 返回结果。
所有分支判断在 plan 生成阶段由 LLM 完成，Runtime 不做 mid-plan 决策。

### D-PLAN-09: 多轮交互靠用户驱动
每轮交互是一个独立闭环：
```
用户说 → 出 plan → 执行 → reply 结果 → 用户看结果后决定下一步
```
LLM 不决定"继续执行什么"，用户看到结果后发起新一轮交互。

### D-PLAN-10: 不选迭代式的原因
- 迭代式 LLM 在执行过程中介入，破坏 plan-then-execute 的审计边界
- 每步回调 LLM 成本线性增长
- 用户失去对执行过程的控制感

---

## Skill Registry

### D-SKILL-06: Registry 同时存储 metadata 和 handler
`registry.py` 承担两个职责：
- 存储 skill 的 metadata（名称、描述、参数 schema、权限等级、progress_message 等）
- 维护名称 → handler 的映射

Planner 的关键词匹配和约束过滤直接从 registry 读 metadata，不另建文件。

### D-SKILL-07: progress_message 字段
每个 skill 可设 `progress_message`（如 `analyze_image` → "正在分析截图…"），
Orchestrator 在 Runtime 执行该 step 前自动发出 narration，不入 DSL。

---

## Runtime

### D-RT-01: RuntimeContext 是纯数据容器
- 只存 session 状态和 step 数据（`outputs` 字典）
- 外部依赖（FeishuClient、httpx 等）不进 context
- 外部依赖由 executor 构造函数注入

### D-RT-02: Outputs 用自动 key
Runtime 自动生成内部 key，格式 `_step_0`、`_step_1`，按 steps 数组索引。即使 step 没写 `id` 也能保证 outputs 字典完整。

### D-RT-03: 引用解析失败 = 抛异常终止
`{{step.capture.output}}` 解析时如果 `outputs["capture"]` 不存在，抛异常，plan 终止。

### D-RT-04: RuntimeContext 定义

```python
@dataclass
class RuntimeContext:
    session_id: str
    outputs: dict[str, Any]       # key = step id 或 _step_N
    plan: Plan                    # 当前执行的 DSL
    # 无外部依赖
```

---

## 版本号管理

### D-VER-01: 语义化版本 vMAJOR.MINOR.PATCH

| 级别 | 触发条件 | 示例 |
|------|---------|------|
| MAJOR | 架构级变更、DSL schema 不兼容 | ReAct → PTE 重构 |
| MINOR | 新增功能 | 新 skill、active_task、接入瑞幸 MCP |
| PATCH | bug 修复、小幅调整 | 修 Validator 逻辑漏洞、调 prompt 措辞 |

### D-VER-02: 版本号与 commit 对齐
每次完成一个功能点或修复后准备 commit 时：
1. 判断本次改动级别
2. 更新 `src/main.py` 中 `version`
3. 写 `dev-log.md` 对应条目
4. commit message 带版本号前缀（如 `v2.2.0: xxx`）

禁止攒多个改动一次性升版本。

### D-VER-03: 混合改动处理
如果一次 commit 同时包含 bug 修复和新功能，按新功能升 MINOR，但 dev-log 条目里分别说明两类改动，不笼统带过。

### D-VER-04: 提交前必须同步 AGENT.md
`AGENT.md` 是新会话/新代理的启动上下文，代码变更后必须保持同步。每次 commit 前：
1. 判断改动是否触及 AGENT.md 内容（目录结构、skill 清单、机制、配置键、版本号、待办）
2. 触及则更新 AGENT.md 对应板块（架构/技能/机制变更必改；纯注释、日志、文档措辞可跳过）
3. dev-log 条目末尾标注"AGENT.md 已同步"

禁止"代码改了但 AGENT.md 还停留在旧状态"的提交。AGENT.md 头部维护规则与本节互为引用。

---

## 信息获取框架（InfoAgent）

> 详细设计见 `guide/orca-info-agent-framework.md`（v0.2 设计稿）。2026-08-24 提出：Orca 未来需接入小 agent 获取各种信息；2026-08-25 扩展 CEO-员工-档案室模型（待机接收 / Push 上报 / 记录库）。

### D-AGENT-01: 信息获取统一抽象为 InfoAgent
每个信息源 = 一份能力描述（meta：name/description/inputSchema/outputSchema/超时/并发声明）+ 一个唯一执行入口（execute）。主 agent 只做决策与汇总，不感知具体信息源。新增信息源 = 注册一个 InfoAgent，主循环零改动。

### D-AGENT-02: 注册表闭集
InfoAgentRegistry 是闭集注册表，LLM 只能从 list() 中选择，不能发明 agent（与 D-SKILL 闭集原则一致）。

### D-AGENT-03: 结果必须结构化 canonical
InfoAgent 返回 `{ok, data|error, tookMs, source}`，数据按 outputSchema 校验。禁止自由文本直出；主 agent 负责汇总润色。

### D-AGENT-04: 路由三阶段演进
R1 关键词匹配（Phase 2 起步，对齐 planner 思路）→ R2 LLM 工具选择 / function calling（信息源 > 8 个时，对齐迁移终局）→ R3 多源并行聚合（有聚合需求时）。

### D-AGENT-05: 执行后端可插拔
四种后端：in-process（默认）、subprocess-bridge（Python worker，对齐桌面层 A1）、MCP（外部信息源，自动包装为 InfoAgent，公开名 `mcp__<server>__<tool>`）、remote-http（预留）。统一由 InfoAgent 实现隐藏。

### D-AGENT-06: 安全分级 + 最小权限
L0 公开信息直接执行；L1 用户私有数据执行但不落明文日志 + 参数级白名单；L2 外部副作用走审批（一次性 grant）。AgentDeps 只注入 llm/session/logger/signal，不注入发送与写能力。

### D-AGENT-07: 委托可审计
每次委托记录路由回执（选了谁/为什么/参数/耗时/结果摘要），写入会话历史的结构化标记 `[info:<agent> <摘要>]`。

### D-AGENT-08: 双向模式（Pull + Push）
InfoAgent 支持两种协作模式：Pull（Orca 问询，v0.1）与 Push（InfoAgent 自主写档案，v0.2 新增）。`modes: ['pull'] | ['pull','push']` 声明，可同时具备。Push 是"员工档案"的写入通道，外部 App 通过 HTTP webhook（Bearer 鉴权）或 MCP 上报。

### D-AGENT-09: 记录库（员工档案室）
每 namespace 一个档案夹，统一信封 `InfoRecord{id, namespace, type, ts, source, confidence?, urgency?, payload, ttlDays?}`；append-only + `supersedes` 更正（对齐事件溯源）。检索与门控只依赖信封字段，不解析 payload。Phase A 用 JSONL（每 namespace 一文件，内存索引），SQLite 视查询量再迁。

### D-AGENT-10: Orca = CEO，查档案优先（R0）
Orca 只做理解/查档/派活/汇总/回复，具体事项由 InfoAgent 执行。决策时先查记录库（R0），档案命中直接用（零成本复用），未命中才派活（R1-R3）。

### D-AGENT-11: 待机行为门控
Push 记录默认静默入库；urgency 0 静默 / 1 进待汇报队列（下条消息带一句）/ 2 紧急推送（默认关闭，需用户开启 + 审批放行）。对齐 memory-pack 自主度模型（Level 1 通知 / Level 2 建议，Level 2 以上默认关闭）。

### D-AGENT-12: 记录生命周期与隐私
记录支持 ttl + 软删/硬清理；L1 私有数据（食物照片等）不落明文日志、可一键清空 namespace；外部 Push 通道每 App 独立 Bearer token + namespace 白名单。

### D-AGENT-13: iPhone 数据通道（手机 = 共享数据源，不是 agent）
手机是多个 InfoAgent 共用的数据源，用三通道统一获取（详见 `guide/orca-iphone-channel.md`）：①飞书（图片/文件/文本，主通道，抗断连）；②HTTP webhook `POST /info/records`（结构化数据，Bearer 鉴权）；③本地文件同步（iCloud for Windows / Phone Link）+ 文件夹监听。手机端统一用 iOS 快捷指令（零开发者账号）；健康数据优先 Health Auto Export，免费替代为快捷指令定时"查找健康样本"。

### D-AGENT-15: 会话绑定路由（工位分配）
**一个飞书 bot 账号，多个会话（群/单聊）= 多个"工位"，每个会话固定绑定一个 InfoAgent**：图片/文件/文本事件按 `chat_id → agent` 绑定表路由，**每个事件只到一个 agent，不广播**。食物群 → food-agent；主聊天 → Orca（通用主管线）；未来新图片类 agent（如"拍照聊天"）= 新开一个群。意图由"发到哪个工位"声明（确定性、零 LLM 开销、不加第二个飞书应用/凭据）。独立账号方案降级为远期（第三方对接/最小权限隔离时才考虑）。处理层始终与账号无关：无论照片从哪个会话进来，都交给绑定表中对应的 agent 处理（用户 2026-08-25 确认采纳）。

### D-AGENT-16: IM 中转代理层（Orca 作为 QQ/微信消息代理）
> 2026-09-05 入册。详细设计：`guide/orca-im-bridge.md`（v1.1.1 Accepted，未实现；代码落地待 Orca 记忆能力实装后再开工）。用户 2026-09-05 review 批准。注：D-AGENT-14 留空，跳号至 16 对齐现有 D-AGENT-* 编号习惯。

**架构边界（核心）**

- **16-01 角色分离 — Adapter ≠ Agent**：**IM Adapter** 只做"原协议 ↔ MessageEnvelope"（`start/stop/normalize/sendText`）；**InfoAgent** 只做"查档"。两者通过 EventBus（消息流）+ infoStore（档案）协作，**互不直接调用**。CEO 永远不会说"bridge-agent 帮我接 QQ"——接 QQ 是 Adapter 的事，查 QQ 消息是 archive-agent 的事。
- **16-02 通用信封 MessageEnvelope**：所有 IM / 飞书 / Telegram / Discord 共用 `MessageEnvelope{id, messageId, platform, chatId, senderId, senderName?, text, ts, isGroup, mentionedMe, attachments?}`。Orca 只认 Envelope，**不认识 OneBot / WCF / NapCat / openclaw**；未来接 Discord / Telegram 零 Orca 主体改动。
- **16-14 MessageEnvelope 双 ID（v1.1.1）**：`id` = Orca 内部 Event ID（`randomUUID()`），用于 EventBus / infoStore / Decision back-trace；`messageId` = 平台原始消息 ID（OneBot `message_id` / WCF `msgid` / feishu `message_id`），用于**跨通道去重 + supersedes 更正**，去重键 `(${platform},${messageId})`。**两者不混淆**。
- **16-15 namespace 不按平台拆分（v1.1.1）**：统一 `im-bridge`（不拆 `im-qq` / `im-wechat` / `im-feishu`）。`platform` 仅作 `MessageEnvelope` 字段与查询过滤参数，不入 namespace key。跨平台聚合查询 `query({namespaces:['im-bridge']})` 一次完成。

**决策与执行**

- **16-03 四态决策**：Decision 终态 = `act / notify / defer / archive`（不再做 `remember_only → remember` 二次映射）；`ignore` 作为 AttentionEngine 终结态不下到 Decision。`archive ≠ ignore`：`archive` 入档可被 R0 检索；`ignore` 完全丢弃。
- **16-04 act + handler 解耦（v1.1.1 含 requiresApproval）**：`act` 不再绑定"自动回复"；Decision 必须带 `handler: 'im.send' | 'feishu.reply' | 'tts.speak' | 'calendar.create' | 'todo.add' | ...`，同一种 action 可挂任意 handler。**审批作为 Action 元数据**：`requiresApproval?: boolean`，默认 true（所有 act 走审批，L2 副作用），仅 Attention 规则显式置 false 才跳过（`im-auto-reply` + autoReplyContacts + 首次授权后）。
- **16-05 联系人群分离**：`importantContacts`（提醒 + **绝不代回**）与 `autoReplyContacts`（允许 act + handler=im.send）完全独立配置，**交集为空**——同一人不能同时是"重要"和"自动回复"。导师 / 女朋友走 importantContacts；快递机器人走 autoReplyContacts。
- **16-06 入站第一版 = Manual Sync Channel**：用户从 QQ/微信侧配"转发到飞书机器人"，由 Orca 飞书通道接管（D-AGENT-13 通道①外延）；**不是 IM Adapter**；零代码、零封号风险。
- **16-07 出站合规优先**：第一版 Notify Channel 只走企业微信 webhook（合规、零封号风险）；NapCatQQ 小号纯外发作为 QQ 侧补充；openclaw-weixin 作微信侧合规口子跟踪。
- **16-08 企业微信 ≠ IM 通道**：只作 **Notify Channel**（Orca→你 的通知）；**不是 IM 回复通道**（企业微信群机器人不能给普通微信好友发消息）；真正的 IM 回复只能走 IM Adapter。三角色严格分开：IM Adapter（原协议 ↔ Envelope）/ Notify Channel（Orca → 用户通知）/ Manual Sync Channel（用户 → 飞书 → Orca）。

**安全与边界**

- **16-09 L1 隐私**：IM 消息 = L1（私有数据），不落明文日志（D-AGENT-12），payload `ttlDays` 默认 7，用户可一键清空 `im-bridge` namespace（`DELETE /info/records?namespace=im-bridge`）。
- **16-10 WorldState 严格只存当前状态**：`extensions.im.{importantContacts,autoReplyContacts,blockedContacts}` + `user.status` + `focus_mode`；**不存历史**（`lastSeen / lastMessage / recentChats` 删；历史走 EventBus + infoStore）。Attention 规则需要"最近一条"时用 `EventBus.recent({source:'im.qq', limit:1})[0]`，**不在 WorldState 缓存**。
- **16-11 PoC 边界**：`ORCA_IM_*_ENABLED=0` 默认 + `ORCA_IM_ACT_ENABLED=0` 默认；开启前需用户二次确认承担账号风险；仅备用小号 / 测试号使用，不用于用户主账号。审批记录（批准/拒绝）= 一条 InfoRecord（namespace='decision-action', type='act-approval'），可审计可回放。

**工程与可演进**

- **16-12 决策可见性**：Attention 规则 JSON 显式可看；importantContacts/autoReplyContacts 完全由用户掌控；Decision.handler + Decision.requiresApproval 字段让代回路径与审批状态可见；执行日志可回放。
- **16-13 主循环零改动**：IM 中转作为 Cordis 插件（`im-bridge`）挂载；EventBus 新 source 类型 `im.qq` / `im.wechat` / `im.feishu`；WorldStateUpdater 新 reducer（contact 列表变更）；AttentionRuleRegistry 新 5 条规则（`im-urgent-from-important` / `im-private-default` / `im-auto-reply` / `im-group-default` / `im-spam-throttle` / `im-overnight-from-important`）；ActionExecutor 新 ActHandlerRegistry；InfoAgent 注册表新 `im-archive-agent`。

**Attention 规则索引（落地于 `AttentionRuleRegistry`）**

| ruleId | 优先级 | AttentionAction | 触发 |
|---|---|---|---|
| `im-urgent-from-important` | high | `notify_immediately` | `event.data.envelope.senderId` ∈ `importantContacts`（**绝不代回**） |
| `im-private-default` | normal | `notify_immediately` | `im.*` 私聊，非 important 命中 |
| `im-auto-reply` | normal | `act` | `senderId` ∈ `autoReplyContacts` |
| `im-group-default` | low | `archive` | `im.*` 群聊，非 important 命中 |
| `im-spam-throttle` | — | `ignore` | `senderId` ∈ `blockedContacts` |
| `im-overnight-from-important` | high | `wait_until_available` | `prevState.user.status='sleeping'` ∧ `senderId` ∈ `importantContacts` |

**配置键索引（仅占位，实现时再确定）**

`ORCA_IM_ENABLED` / `ORCA_IM_QQ_ENABLED` / `ORCA_IM_QQ_HTTP` / `ORCA_IM_WECHAT_ENABLED` / `ORCA_IM_WECHAT_BACKEND` / `ORCA_IM_CORPWECHAT_ENABLED` / `ORCA_IM_CORPWECHAT_WEBHOOK` / `ORCA_IM_IMPORTANT_CONTACTS` / `ORCA_IM_AUTO_REPLY_CONTACTS` / `ORCA_IM_BLOCKED_CONTACTS` / `ORCA_IM_TTL_DAYS` / `ORCA_IM_ACT_ENABLED`（全部默认 0 / `[]`）。

**落地顺序（用户明确）**：Memory → InfoStore → IM Bridge → NapCat / OpenClaw PoC；不提前接协议层。

---

## 记忆系统（Memory）

> 详细设计见 `guide/orca-memory-design.md`（v1.2 设计稿；2026-08-27 更新）。本次决议仅记录契约与边界，不包含任何 MemoryStore / ReflectionService / handler 的代码落地。
>
> 与既有决议的边界：D-AGENT-09 / D-AGENT-11 / D-AGENT-12 / D-AGENT-16-03 / D-AGENT-16-10 全部不修改；AGENT.md §4.3 / §8.3 分层铁律保留；本次新增 D-AGENT-17 / D-AGENT-18 / D-AGENT-19 单独成节。
>
> **v1.1 架构安全修订要点**（相对 v1.0）：①读写分离三角色（消除"唯一"语义冲突）；②新增 ForgetMarker 防止 forget 后 Reflection 重新生成被遗忘事实；③AuditEvent schema 移除 prevValue/newValue（与 hard-purge 隐私冲突）；④Reflection 写权限收窄为"维护提案者"而非直接 mutator；⑤LongMemoryFact/MemoryCandidate/AuditEvent/ForgetMarker 职责验证无重叠。
>
> **v1.2 Memory Contract Hardening**（D-AGENT-18，2026-08-27）：①正式纳入 `CandidateQuery{state?, type?, subject?, limit?}`；②正式确认 `isSubjectSuppressed(subject)` subject-level 抑制；③`promoteCandidate()` 内置 user-explicit 保护 invariant；④Rule A 定位收敛为"pipeline 验证 fixture"。
>
> **Phase 5.4 前置设计**（D-AGENT-19，2026-08-27）：定义 Memory → Attention/Decision 的合法路径（MemoryAttentionAdapter 轮询 + AttentionItem 映射）；明确禁止访问 Memory 的模块；CEO 双通道 Memory 读取；conflict detection 边界。

### D-AGENT-17: LongMemory 生命周期与写入控制（v1.1 架构安全修订版）

**目标**：把 LongMemory 定义为 Orca 对用户及长期环境形成的、可验证、可修正、可压缩、可删除的长期知识状态。LongMemory **不是** append-only 永久事实表。

#### 生命周期四阶段

```
Episode → Reflection → MemoryCandidate → LongMemory
```

- **Episode**：短期事实单元（hours~7d），确定性规则生成（MVP 不调 LLM）；字段 `id / category / summary / ts / entities / sourceEventIds / importance / ttlDays / state`（`active` / `pruned`）；按 D-AGENT-12 L1 隐私，ttl 默认 7。
- **MemoryCandidate**：Reflection 推断出的待晋升候选；字段含 `proposedFact{type,subject,value}` / `confidence` / `evidenceEpisodeIds` / `reason` / `source='reflection'`（**必填且固定**）/ `state`（`pending` / `promoted` / `rejected` / `expired`）/ `decidedAt` / `decidedBy`。
- **Reflection（Maintenance & Consolidation）**：周期性维护整合，**不是**"每天把 Episode 写成 LongMemory"。六职责：
  1. **Discover** new facts → 生成 MemoryCandidate
  2. **Update** existing facts → 现有 active fact 的 confidence / value 微调
  3. **Merge** duplicates → `mergedInto` 关系链
  4. **Detect conflict → supersede** → 新 fact 晋升 + 旧 fact `state='superseded'`
  5. **Compress evidence** → `representativeEvidenceIds` 超 5 时合并 + 更新 `evidenceSummary`
  6. **Candidate generation / promotion** → 按 `confidence ≥ 阈值`（默认 0.7）晋升 candidate → active fact
- **LongMemory**：当前生效的知识状态，**二态持久** ——
  - **`active`**：正常检索
  - **`superseded`**：被新事实取代，保留关系链（`supersededBy`），**不**进正常检索
  - **`forget` 默认 hard-purge**：物理删除 fact 记录（**不再保留 `state='deleted'` 持久态**）；可选 privacy-safe tombstone 受 §17-10 4 条硬约束保护

#### 17-01 数据契约

- `LongMemoryFact` 字段：`id / type / subject / value / confidence / source / state / supersededBy? / supersedes? / mergedInto? / representativeEvidenceIds[] (≤5) / evidenceSummary? (≤200) / evidenceCount / createdAt / updatedAt / createdBy / privacyLevel('L1') / ttlDays?`。
- **identity** = `(type, subject)`：同 `(type, subject)` 至多一条 `active`；upsert / supersede。
- **subject 弱约定**：字符串允许 `.` 自然分层（`'girlfriend.coffee'` / `'ui.design'` / `'user.sleep'`），检索支持 prefix 匹配；**不**建立固定 namespace registry。
- `Episode` 与 `MemoryCandidate` 字段集见设计稿 §3.1 / §3.2；`AuditEvent` 字段见 §3.4（独立审计日志，不进 R0/CEO 检索结果）。

#### 17-02 LongMemory 操作矩阵（v1.0 收敛）

| 操作 | 写者 | 关系链影响 | 审计 |
|---|---|---|---|
| **create** | user-explicit 直达 active（`memory.remember` handler）；reflection 经 candidate→promoted | — | `AuditEvent{created, actor=user-explicit\|reflection}` |
| **update** | user-explicit / reflection | `representativeEvidenceIds` append；`evidenceCount++`；超上限触发 compress | `AuditEvent{updated}` |
| **merge** | reflection（合并重复） | 源 `state='superseded'` + `mergedInto=target.id`；目标仍 active | `AuditEvent{merged, factId=source.id}` |
| **supersede** | reflection（新事实取代旧事实） | 新 fact create(active) + 旧 fact `state='superseded'` `supersededBy=new.id` | 两条 AuditEvent：`superseded`（旧） + `created`（新） |
| **compress/consolidate** | reflection（representativeEvidenceIds 超 5） | 不改 state；只刷新 `representativeEvidenceIds` + `evidenceSummary` | `AuditEvent{compressed, evidenceDelta}` |
| **forget/delete** | user-explicit（用户命令） | **物理删除 fact**（默认）+ 同步创建 ForgetMarker（原子）；可选 privacy-safe tombstone 受 §17-10 硬约束保护 | `AuditEvent{forgotten, actor=user-forget, changedFields=undefined}`；后续 Reflection candidate 被 ForgetMarker 拒绝 |

**不变量**：
- 同一 `(type, subject)` 至多一条 `active`。
- `supersede` 方向单向（新 → 旧）；复活只能再次 supersede 旧 supersede。
- `merge` 不允许 `active → mergedInto=superseded`（目标若已 superseded 则报错，防环）。
- `forget` 是**单向不可恢复**（除用户重新显式 create）；不再保留 `state='deleted'` 持久态。
- `forgetFact` 后 fact 不进 `queryFacts` 默认结果；`getFact(id)` 在不传 `includeTombstone` 时返回 `undefined`。
- `compress` 不丢失 evidence 历史：EpisodeStore 中的 Episode 仍保留完整内容；LongMemoryFact 只丢 representativeEvidenceIds 中的引用 id。

#### 17-03 forget 与 supersede 的严格区分（v1.0 收紧）

| 维度 | supersede | forget/delete |
|---|---|---|
| 触发 | 系统检测（新事实取代旧事实） | **用户显式命令**（"忘掉 X"） |
| 旧 fact 状态 | `superseded`（保留关系链） | **物理删除** fact 记录（v1.0 默认） |
| 历史是否可见 | 审计可见（可回看"曾经的旧值"） | 审计**仅记录 forget 操作本身**，不记被遗忘的 value |
| tombstone | 不适用 | 可选 privacy-safe tombstone（§17-10 4 条硬约束） |
| 反向操作 | 新 supersede 旧 supersede | **不可逆**（除用户重新显式 create） |

#### 17-04 source 必填 + 门控

- `LongMemoryFact.source` ∈ `{ 'user-explicit', 'reflection' }`，**必填**。
- `'user-explicit'`（用户命令）：可直达 `active`；写者仅 `memory.remember` Action handler；**默认 `requiresApproval=false`**（v1.0 用户拍板：用户显式命令已隐含授权）；可通过 `ORCA_MEMORY_REQUIRE_APPROVAL_USER_EXPLICIT=true` 显式打开审批。
- `'reflection'`：必须经过 `MemoryCandidate` 门控 → `promoteCandidate` 才晋升；门控条件：`confidence ≥ 阈值`（实现阶段默认 0.7）。
- 严禁两者混淆或隐式升级。

#### 17-05 读写分离三角色（v1.1 修订）

LongMemory 的读/写权限按角色严格分离，不存在"唯一读+写子系统"的矛盾：

**角色一：唯一业务消费者（read-only）**

| 调用方 | 读 | 写 |
|---|---|---|
| **CEO / agent 主循环**（R0 context-building） | ✅ `queryFacts`（仅 active）+ `getFact`（仅 active） | ❌ |

**角色二：维护所有者（read + 受控 write via MemoryStore API）**

| 调用方 | 读 | 写（全部经 MemoryStore typed API） |
|---|---|---|
| **ReflectionService** | ✅ Episode / MemoryCandidate / active LongMemoryFact | ✅ `appendCandidate` / `promoteCandidate` / `upsertFact(update)` / `mergeFacts` / `supersedeFact` / `compressFactEvidence`（**proposer 非 mutator**，详见 §17-16） |

**角色三：用户命令写入入口（write-only）**

| 调用方 | 读 | 写 |
|---|---|---|
| **`memory.remember` Action handler**（注册到 `ActionHandlerRegistry`） | ❌ | ✅ `upsertFact(create/update)`（source='user-explicit'） |
| **`memory.forget` Action handler**（注册到 `ActionHandlerRegistry`） | ⚠️ 查询存在性（forget 前确认） | ✅ `createForgetMarker` + `forgetFact` / `forgetByQuery` |

**禁止**：
- 普通 Cordis 插件 / InfoAgent / agent 插件 / 业务代码**直接**调用写 API。
- **DecisionEngine** / **AttentionEngine** **永远不读不写** Memory（保留 AGENT.md §4.3 铁律）。
- **WorldState / WorldStateUpdater** **不读** Memory（本次设计**不**包含 Memory → WorldState 投影；留作远期扩展）。
- **绕过 `ActionHandlerRegistry` 直接注册 `memory.remember` / `memory.forget` handler**（v1.1 用户拍板：handler 必须经 ActionExecutor，不绕过 Orca 副作用层）。
- **ReflectionService 直接修改** JSONL 文件或 in-memory LongMemoryFact 对象（所有写必须经 MemoryStore typed API，详见 §17-15）。

#### 17-06 Memory 与 Decision/Action 词汇对齐

- Decision 终态以 D-AGENT-16-03 四态为准（`act / notify / defer / archive`），**不新增**记忆相关终态。
- `memory.remember` / `memory.forget` 作为 **ActionHandler** 注册到 `ActionHandlerRegistry`，走 Decision `act` 分支。
- **v1.0 用户拍板**：默认 `requiresApproval=false`（用户显式"记住"/"忘掉"已隐含授权）；实现层可通过 `ORCA_MEMORY_REQUIRE_APPROVAL_USER_EXPLICIT=true` 显式打开。
- D-AGENT-16-03 已删除 `remember_only → remember` 二次映射——本决议与之**一致**，不引入新的 remember action 终态；显式记忆通过 Attention 规则（或未来 CEO 直接路径）落入 `act(memory.remember)`。

#### 17-07 消费方（CEO / context only）

- 唯一消费者：**CEO / agent 主循环**（R0 查档扩为"档案 + 记忆双查"）。
- 检索时只取 `state='active'` 的 fact；每条只取 `(id, type, subject, value, confidence, evidenceSummary, evidenceCount)` 单行表示；**不展开** evidence 详情。
- Memory 检索按需触发（CEO 判定问句命中"用户/偏好/习惯"类别时），**不是**每轮全量注入；Top-K 默认 5。
- **不消费 Memory** 的层：DecisionEngine / AttentionEngine / NotifyHandler / DeferredScheduler / WorldState / EventBus（详见设计稿 §6.2）。
- 详见 §17-05 读写分离三角色：CEO/context 只读，ReflectionService 维护者经 MemoryStore API 读写，memory handler 用户命令写入。

#### 17-08 独立 MemoryStore（与 InfoRecordStore 边界）

- 新增独立 `MemoryStore`（Phase A 用 JSONL + 内存索引，与 D-AGENT-09 §7A 同模式），**不修改** InfoRecordStore 信封。
- 目录独立：`app-cordis/data/memory/{episodes,long,candidates,audit}.jsonl`（gitignore）。
- **不引入** SQLite / 向量库 / 外部嵌入依赖（本阶段查询量在用户级百/千，内存索引足够）。
- 切换 SQLite 的触发条件见设计稿 §13 Q12（实现阶段再确认）。

边界依据（精简）：
- 数据性质：Memory 是**知识状态**（upsert / 二态持久 + 物理删除），InfoRecord 是**事件日志**（append-only / supersedes 链接）。
- 操作语义：Memory 有 create/update/merge/supersede/compress/forget；InfoRecord 仅 append + supersedes。
- 检索语义：Memory 按类型化字段 + 关系链；InfoRecord 按信封字段 + payload 关键词。
- 信封污染风险：把 `state` / `supersededBy` / `mergedInto` 等结构化字段塞进 InfoRecord 信封会破坏 D-AGENT-09 "检索只依赖信封字段"原则。

#### 17-09 Evidence 三字段与 Audit 的边界（v1.0 重写）

- 单条 fact `representativeEvidenceIds` **最多 5 条**（v1.0 用户拍板，**仅作为"快速解释/审计"的引用**，**不**理解为"最多 5 条历史证据"）；超出触发 `compress`。
- `evidenceSummary` ≤ 200 字符；按 fact 单行注入 prompt。
- `evidenceCount` 单调递增（用于 Reflection 判断稳定度，如 ≥ 20 才升 habit）。
- **完整 evidence 历史仅存于 EpisodeStore**（短期，可 prune）；LongMemoryFact 不堆积 evidence，避免 active 变聊天记录数据库。
- `AuditEvent` **不进** R0/CEO 检索结果；仅审计 UI / 调试读取。
- AuditEvent 容量无硬上限；保留期默认永久（合规要求）。

#### 17-10 forget 隐私硬约束（v1.1 修订）

`forgetFact(id)` / `forgetByQuery(q)` 默认行为：**物理删除 fact 记录**（从 `long.jsonl` 移除），同步原子创建 ForgetMarker + 追加 `AuditEvent{forgotten, actor=user-forget, changedFields=undefined}`（value 内容不进入审计）。

若实现层因一致性 / 审计 / 索引需求保留 tombstone，**必须同时满足**：

1. **正常 Memory 查询不可见**：tombstone 不进 `queryFacts()` 默认结果；`getFact()` 在 `includeTombstone=false` 时返回 `undefined`。
2. **不保留原始 value**：tombstone 仅保留 `id` / `type` / `subject` / `forgottenAt` / `source`；**不**保留 `value` / `confidence` / `evidenceSummary` / `representativeEvidenceIds`。
3. **不保留可恢复的完整敏感内容**：tombstone 不能反向 hydrate 完整 fact；不能用于 undo / restore。
4. **AuditEvent 仅记录 forget 操作本身**：prevValue/newValue 已从 AuditEvent schema 移除（v1.1）；只记录 `factId` + `actor=user-forget` + `ts` + `kind='forgotten'` + `changedFields=undefined`，value 内容永不进入审计记录。

`AuditEvent.kind` 收紧（v1.1）：
- 移除 `hard-purged`（forget 默认就是 hard-purge，无需单独审计 kind）。
- 移除 `actor: 'system-prune'`（不再保留 soft-delete 状态机；tombstone 是隐私实现细节，不入审计 kind）。
- **prevValue / newValue 从 schema 移除**（v1.1）：变更内容通过 `changedFields[]`（字段名列表）表达，value 本身不进入审计日志。
- `forgotten` 事件的 `actor` 仅 `'user-forget'`。

#### 17-11 Reflection 调度契约（v1.0 新增）

- 默认策略：**每日固定 + 空闲检测提前触发**。
- 配置键契约（实现阶段落 `app-cordis/src/config.ts`，**本次不落代码**）：
  - `ORCA_REFLECTION_INTERVAL_HOURS=24`：两次固定 Reflection 之间的最长间隔。
  - `ORCA_REFLECTION_IDLE_TRIGGER=true`（默认 true）：当系统检测到用户 `away` 且无活跃事件 ≥ N 小时时，可提前触发一次 Reflection（不等满 24h）。
- tick 行为：每次 tick 调用 `executeReflectionTick()`，**纯函数 + 调度器**模式（对齐 Phase 4.D `executeTick(store, worldState, emit, isDisposed)` 设计）。
- 不修改 WorldState / Attention / Decision；不直接修改 EventBus；仅在 MemoryStore 内部写。
- disposed 闸门：plugin dispose 后 in-flight tick 短路（对齐 Phase 4.B Review dispose race 模式）。

#### 17-12 与现有决议的兼容性

| 既有决议 | 与 D-AGENT-17 v1.1 关系 |
|---|---|
| D-AGENT-09（InfoRecord 信封） | 不修改；MemoryStore 是独立模块 |
| D-AGENT-11（urgency 门控） | 不直接复用；Memory 有独立 confidence 门控 |
| D-AGENT-12（ttl / 软删 / 硬清 / L1） | 直接借鉴；forget 默认 hard-purge（v1.1 新增 ForgetMarker 原子创建） |
| D-AGENT-16-03（四态决策） | 一致；`memory.remember` / `memory.forget` 走 `act` 分支 |
| D-AGENT-16-10（WorldState 当前态） | 一致；本次不引入 Memory → WorldState 投影 |
| AGENT.md §4.3 / §8.3（分层铁律） | 一致；DecisionEngine 不读 Memory；memory handler 必须经 ActionExecutor（不绕过副作用层）；ReflectionService 写必须经 MemoryStore API（v1.1 新增） |

#### 17-13 实施阶段拍板的开放问题

> 用户 2026-09-06 已拍板 7 项（subject 弱约定、Reflection 周期、remember 免审批默认、forget 默认 hard-purge、Evidence 三字段、二态持久、LongMemory + Reflection 核心语义）。本节保留剩余未拍板的实施细节。

| # | 问题 | 默认建议 |
|---|---|---|
| Q2 | confidence 自动晋升阈值 | 默认 0.7；`ORCA_REFLECTION_PROMOTE_THRESHOLD` 控制 |
| Q4 | `representativeEvidenceIds` 单条 fact 上限 N | 默认 5；`ORCA_MEMORY_MAX_REPRESENTATIVE_EVIDENCE` 可覆盖 |
| Q9 | Memory 检索注入 prompt 的 Top-K 与截断 | Top-K=5；value 截断 60 字；evidenceSummary 默认不入主 prompt |
| Q10 | MemoryStore 与 InfoRecordStore 物理目录 | 独立目录（便于备份/迁移/一键清空） |
| Q11 | AuditEvent 保留期 | 默认永久；`ORCA_MEMORY_AUDIT_RETENTION_DAYS` 可覆盖 |
| Q12 | SQLite 切换触发条件 | long facts > 5000 或 query p95 > 200ms；本阶段不实现 |
| Q13 | `ORCA_MEMORY_REQUIRE_APPROVAL_USER_EXPLICIT`（审批开关） | 默认 `false`（v1.0 用户拍板） |
| Q14 | `ORCA_REFLECTION_IDLE_TRIGGER`（空闲提前触发开关） | 默认 `true` |

#### 17-15 ForgetMarker（v1.1 新增）

用户执行 `forget X` 后，Reflection 未来可能从旧 Episode 重新推断相同事实，导致 privacy bypass。ForgetMarker 提供确定性抑制信号。

**数据模型**：`ForgetMarker{id, fingerprint, subject, type, createdAt, createdBy:'user-forget'}`，fingerprint = SHA-256(salt + lower(subject)) 前 16 字符（大小写不敏感）。

**生命周期**：
- 创建：与 `forgetFact` / `forgetByQuery` **原子**执行（先 createForgetMarker，再物理删除 fact）。
- 抑制：Reflection 每次生成新 MemoryCandidate 前，查询所有 active ForgetMarker；若 `sha256(salt, lower(candidate.proposedFact.subject))` 匹配任意 marker 的 fingerprint **且** `candidate.proposedFact.type === marker.type`，则**拒绝该 candidate**（rejectedReason='suppressed-by-forget-marker'）。
- 清除：用户提供显式"不再抑制 X"命令 → 删除 ForgetMarker（Phase 5.x 后续功能，本次不设计）。

**MemoryStore API**：`createForgetMarker(type, subject)` + `queryForgetMarkers(q)`。

**与 tombstone 的区别**：ForgetMarker 用于 Reflection candidate 生成门控（写入抑制），与可选的物理 tombstone（占位）是两个独立机制；即使不保留 tombstone，ForgetMarker 也必须创建。

#### 17-16 Reflection 写权限边界（v1.1 新增）

ReflectionService 享有 Memory 读写权限，但这个权限的语义必须收窄为"维护提案者"而非"直接 mutator"。

**原则**：
- Reflection = **维护提案生产者**（proposer）。它分析、推理、生成候选操作，但不直接修改 JSONL 或 in-memory LongMemoryFact 对象。
- MemoryStore = **mutation authority**。所有状态变更必须经过 MemoryStore 的类型化 API。
- Reflection **永远不直接修改** JSONL 文件或 in-memory LongMemoryFact 对象。

**四类操作的处理路径**：

| 操作类型 | Reflection 行为 | MemoryStore API |
|---|---|---|
| 置信度/evidence 轻量维护（evidenceCount++、append representativeEvidenceIds、刷新 evidenceSummary） | 生成 update 提案 | `upsertFact(update)` — 原地更新 active fact |
| 语义 value 变更（"喜欢咖啡"→"讨厌咖啡"） | 识别冲突，构造新 fact，生成 supersede 提案 | `supersedeFact(oldId, newFact)` — 旧→superseded + 新→created + 两条 AuditEvent |
| merge（两条 active fact 实质重复） | 识别重复，计算目标，生成 merge 提案 | `mergeFacts(sourceIds, targetId)` — 源→superseded+mergedInto + 目标保留 active + AuditEvent |
| compress（representativeEvidenceIds 超 5） | 检测到超限，生成 compress 提案 | `compressFactEvidence(id, {keepRecent:5})` — 仅驱逐 representativeEvidenceIds 引用 + 刷新 evidenceSummary |

**禁止行为**：
- Reflection 直接 `JSON.parse(fs.readFileSync(...))` 然后 push 到数组 → 必须经 `upsertFact`。
- Reflection 直接 `fact.state = 'superseded'` 然后写回 → 必须经 `supersedeFact`。
- Reflection 直接修改 `long.jsonl` 文件 → 必须经 MemoryStore API。

#### 17-14 阶段路线建议（不修改现有路线代码）

| 编号 | 内容 | 与既有路线关系 |
|---|---|---|
| **Phase 5.0** | MemoryStore 基础（JSONL + 内存索引 + 受控 API + 写者白名单 + 隐私/审计骨架）；forget 默认 hard-purge；二态持久语义 | 新增；不依赖 4.F |
| **Phase 5.1** | Episode 层（feishu 消息 burst + WorldState 转换派生，纯规则，零 LLM）；CEO 双查接入；evidence 三字段语义落实 | 新增；解锁 IM Bridge 阶段 B |
| **Phase 5.2** | LongMemory create/update/supersede/merge；显式 `memory.remember` / `memory.forget` Action handler（默认 `requiresApproval=false`） | 新增 |
| **Phase 5.3** | ReflectionService（每日 / 空闲 tick，配置键 `ORCA_REFLECTION_INTERVAL_HOURS=24`）；MemoryCandidate 门控（confidence ≥ 0.7）；自动晋升 + supersede/merge/compress | 新增 |
| **Phase 6** | 真实 act handler 最小权限白名单（原 Phase 4.F 剩余部分） | 推迟；与 Memory 解耦 |
| **Phase 7** | 旧 Phase 5（Attention LLM 增强） | 顺延 |

**本次未实现任何 Memory 代码**。实现阶段需按 D-VER-04 同步 AGENT.md §5 / §8.3 / §9.3 + TODO.md + dev-log.md，并显式收口 §10.2-A（`createRememberHandler` 与 D-AGENT-16-03 的历史冲突）与 §10.2-B（IM Bridge §10 阶段 B 验收措辞修订）。

---

### D-AGENT-18: Memory Contract Hardening（2026-08-27，v1.2 设计稿）

**目标**：Phase 5.3 Reflection Engine MVP 实际暴露三个 Memory contract 缺口；本次仅收口缺口，**不重做 Memory 架构**。

#### 18-01 `CandidateQuery` 正式 contract

Phase 5.3 已实际需要 `MemoryStore.queryCandidates()`（dedup + 状态查询）。Phase 5.3 之前作为内部 API；Phase 5.3 已暴露但未文档化；本次落定为正式 contract。

```ts
interface CandidateQuery {
  state?: 'pending' | 'promoted' | 'rejected' | 'expired'
  type?: LongMemoryFact['type']
  subject?: string
  limit?: number   // 默认 100；上限 1000；按 createdAt 降序截断
}
```

**实现**：`MemoryStore.queryCandidates` 已存在；补 `limit` 截断（默认 100、上限 1000）。

**不引入**：复杂 Candidate repository abstraction；分页系统（当前查询量在用户级百/千，limit 足够）。

#### 18-02 Subject-level Forget Suppression

**两种 API 并存**：

| API | 语义 | 用途 |
|---|---|---|
| `isSuppressed(type, subject)` | **type-scoped** 抑制 | D-AGENT-17 v1.1 原设计；保留用于未来"类型精细化抑制"扩展 |
| `isSubjectSuppressed(subject)` | **subject-level** 抑制（忽略 type） | D-AGENT-18 privacy gate；Reflection promotion 必须使用此版本 |

**硬保证**：

```
forget subject X
→ ForgetMarker{fingerprint=sha256(salt,X), type=T, subject=X}
→ 任何 candidate (type=任意, subject=X)
  → isSubjectSuppressed(X) === true
  → promote 必须拒绝
```

**实现**：`MemoryStore.isSubjectSuppressed(subject)` 已存在；fingerprint 存储已支持 subject-only 查询（fingerprint 与 type 无关，仅依赖 subject）。

#### 18-03 User-explicit Protection 下沉到 MemoryStore

**v1.1 状态**：

```
ReflectionEngine
  → queryFacts
  → 检查 source=user-explicit
  → rejectCandidate
```

**v1.2 修订**：在 `MemoryStore.promoteCandidate()` 内部强制 invariant 检查：

```
MemoryStore.promoteCandidate(id, decidedBy)
  → isSubjectSuppressed(subject) === true
    → candidate.state = 'rejected'，reason='suppressed-by-forget-marker'，抛错
  → queryFacts({type, subject, state='active'}) 含 source='user-explicit'
    → candidate.state = 'rejected'，reason='user-explicit-fact-exists'，抛错
  → 否则正常 promote
```

**保证**：
- 任何未来调用 `promoteCandidate()` 的 subsystem 都自动受到 user-explicit 保护。
- ReflectionEngine 层 guard 仅作 early-exit 优化（减少无意义查询），不再承担安全边界。
- **不覆盖、不 supersede、不修改 user-explicit fact**。

**原则**（与 D-AGENT-17 §17-16 一致）：
- ReflectionEngine = proposer / policy（可以拒绝生成 candidate）
- MemoryStore = mutation authority / invariant enforcement（promote 必须安全）

#### 18-04 Rule A 定位收敛

**当前 Rule A**（`message.burst × sender → behavioral_pattern/high_burst_frequency`）：
- **仅用于验证 Reflection pipeline 的 deterministic candidate generation**（Phase 5.3 测试 fixture）。
- **不是**已经成熟的"用户长期行为推断"。
- **不要**扩展成 personality inference。

**后续真正有价值的 Reflection rule**（D-AGENT-18 不实现，需另行设计）：
- user preference（用户偏好）
- repeated explicit choices（重复显式选择）
- stable user behavior（稳定行为模式）

#### 18-05 不变量清单（D-AGENT-18 引入）

1. `MemoryStore.queryCandidates(q)` 支持 `state` / `type` / `subject` / `limit` 过滤；limit 默认 100 上限 1000。
2. `MemoryStore.isSubjectSuppressed(subject)` 返回 true ⇔ 存在 ForgetMarker 使 `sha256(salt, lower(subject))` 匹配 marker fingerprint（忽略 type）。
3. `MemoryStore.promoteCandidate()` 内部强制：subject 被任意 type ForgetMarker 抑制 → candidate rejected；user-explicit fact 已存在 for `(type, subject)` → candidate rejected；拒绝时抛错。
4. ReflectionEngine 层 guard 是优化，不承担安全边界；可以省略（MemoryStore 仍会拒绝）。

#### 18-06 与现有决议边界

- **不修改** D-AGENT-17 v1.1 任何既有条款。
- **不修改** D-AGENT-09 / D-AGENT-11 / D-AGENT-12 / D-AGENT-16。
- **不引入** LLM / vector DB / embedding / 新 priority system / 新 transaction abstraction。
- **不修改** Phase 5.x 实施路线；当前为 Phase 5.3 后的 contract hardening。

---

### D-AGENT-19: Memory Consumption Boundary（2026-08-27，Phase 5.4 前置设计稿）

**目标**：定义 Memory 如何合法地影响 Orca 行为，同时保持分层铁律（DecisionEngine/AttentionEngine 纯函数、WorldState 纯态、MemoryStore 被动存储），**不实现代码**。

#### 19-01 核心约束

| 模块 | 铁律 |
|---|---|
| AttentionEngine | 纯函数；`evaluate() → AttentionItem[]`；无 IO；**不读 Memory** |
| DecisionEngine | 纯函数；`decide() → Decision`；无 IO；**不读 Memory** |
| WorldState | 当前态快照；**不接受 Memory 写入** |
| MemoryStore | LongMemory 唯一 mutation authority；**不推送**；被动接受查询 |
| ActionExecutor | 执行副作用；不读 Memory 做决策 |
| CEO / context | R0 读 active LongMemoryFact（已达成的设计） |

**Phase 5.4 核心问题**：Memory 如何影响行为，同时不破坏上述铁律？

**答案**：MemoryAttentionAdapter（MAA）是**唯一**获准将 Memory 接入 Attention/Decision 流水线的桥接组件。MemoryStore 保持被动存储角色；MAA 主动轮询，将 LongMemoryFact 转化为 AttentionItems 注入事件流。

#### 19-02 MemoryAttentionAdapter（MAA）

**定位**：Orca Runtime adapter 层（与 PC adapter、Calendar adapter 同级）。**唯一**合法 Memory → Attention/Decision 路径。

**架构**：

```
MemoryStore ──(polling)──→ MemoryAttentionAdapter ──(AttentionItems)──→ EventBus ──→ AttentionEngine ──→ DecisionEngine ──→ ActionExecutor
```

**轮询查询契约**：

```ts
await memory.queryFacts({ state: 'active' })
// 结果按 updatedAt 降序，取 Top-K（默认 5，配置键 ORCA_MEMORY_ATTENTION_TOP_K）
```

**AttentionItem 映射规则**（MAA 内部）：

| Memory FactType | AttentionItem type | AttentionItem action |
|---|---|---|
| `preference` | `preference` | `remember_only` |
| `person` | `person` | `notify_immediately` |
| `habit` | `habit` | `remember_only` |
| `fact` | `fact` | `notify_immediately` |
| `behavioral_pattern` | `habit` | `remember_only` |
| `state_pattern` | `fact` | `notify_immediately` |

**metadata 标注**（所有 Memory 来源的 AttentionItem 必须包含）：

```ts
metadata: {
  memoryFactId: string           // LongMemoryFact.id
  memoryFactType: FactType      // 'preference' | 'person' | 'habit' | 'fact' | 'behavioral_pattern' | 'state_pattern'
  memorySource: 'user-explicit' | 'reflection'
  memoryConfidence: number
  memoryCreatedAt: number
  memoryUpdatedAt: number
}
```

**去重**：`seenFactIds: Set<string>`（内存 Map）。同一 `fact.id` 不重复生成 AttentionItem。Forget 后 fact 自然淡出（`queryFacts` 不返回）。

**防震荡**：仅当 `updatedAt` 发生变化时才重新生成 AttentionItem。

**调度**：轮询间隔默认 60s（`ORCA_MEMORY_ATTENTION_POLL_INTERVAL_MS`）；disposed 闸门。

#### 19-03 禁止访问 Memory 的模块（铁律）

以下模块**严格禁止**直接调用 MemoryStore（除 CEO/R0 context-building 路径外）：

| 模块 | 禁止原因 |
|---|---|
| AttentionEngine | 纯函数约束；不得有 IO |
| DecisionEngine | 纯函数约束；不得有 IO |
| WorldState | 当前态快照；不接受 Memory 写入 |
| ActionExecutor | 执行层；不读 Memory 做决策 |
| NotifyHandler | 特定 Action handler；不读 Memory |
| DeferredScheduler | 调度层；不读 Memory |
| EpisodeEngine | 写入层；不读 LongMemory |
| ReflectionEngine | 已有 Memory 写入权；不读其他 facts 影响自身逻辑 |
| FeishuChannel | 通道层；不读 Memory |
| InfoAgent | 已有自己的 InfoRecordStore；不跨域读 Memory |

**唯一例外**：
- **CEO / agent 主循环**：调用 `memory.queryFacts` 构建 prompt（已达成的设计）
- **MemoryAttentionAdapter**：调用 `memory.queryFacts` 生成 AttentionItems（本决议新增）

#### 19-04 CEO 双通道 Memory 读取

Phase 5.4 后，CEO 对 Memory 有两个读取通道：

| 通道 | 用途 | 读取方式 |
|---|---|---|
| **直接查询**（已达成的） | CEO 构建系统 prompt 时注入 fact summary | CEO 在 context-building 时调用 `memory.queryFacts` |
| **MAA 间接通道**（新增） | Memory facts 间接通过 AttentionItem → Decision → Action 影响行为 | MAA 生成 AttentionItem → EventBus → AttentionEngine |

两个通道互补，不冲突。

#### 19-05 Memory conflict detection 边界

**冲突场景**：同一 `(type, subject)` 同时有 EventBus 来源和 Memory 来源的 AttentionItem。

**检测位置**：MAA 内部（不在 DecisionEngine — DecisionEngine 不读 Memory）。

**处理策略**：**Memory wins**。保留 Memory 来源的版本，丢弃 EventBus 版本。

**理由**：Memory fact 通常有 confidence 评估或 user-explicit 确认，比单次事件更可靠。

**不处理**：跨 Memory fact 冲突（同 type+subject 两条 Memory facts）。MemoryStore upsert/supersede 语义已处理，不在 Phase 5.4 范围内。

#### 19-06 查询数量、token 限制、隐私

**查询数量**：MAA 每次 tick 一次 `queryFacts`；轮询间隔 60s → 每分钟最多 1 次。

**token 限制（LLM prompt 注入）**：

| 字段 | 限制 |
|---|---|
| `value` | 截断至 60 字符 |
| 单条 fact 注入字符数 | ≤ 100 字符 |
| Top-K | 默认 5 |
| prompt 中 Memory 总字符 | ≤ 500 字符 |

**隐私**：L1 固定；ForgetMarker fingerprint 不可逆；AuditEvent 不记录 fact value（D-AGENT-17 v1.1 约束）。

#### 19-07 与现有决议边界

- **不修改** D-AGENT-17（MemoryStore mutation authority）
- **不修改** D-AGENT-18（Memory contract hardening）
- **不修改** DecisionEngine / AttentionEngine 纯函数约束
- **不修改** WorldState 当前态快照约束
- **不引入** Memory → WorldState 投影
- **不引入** LLM / vector DB / embedding
- **不引入** real-time Memory push（polling 是 MVP 简化）

**关联决议**：
- D-AGENT-09（InfoRecord 边界）：MemoryStore 与 InfoRecordStore 独立，MAA 不跨域读 InfoRecord
- D-AGENT-11（urgency 门控）：MAA 不修改 AttentionEngine 规则
- D-AGENT-12（ttl / 软删 / L1）：直接适用，L1 privacyLevel 固定

---

### D-AGENT-20: Memory-aware CEO Context（2026-08-27，Phase 6 设计稿）

**目标**：定义 CEO（R0）在构建 context 时如何系统性整合 LongMemoryFact；制定 Memory retrieval 策略；明确 Memory → CEO 的接口契约。不实现代码。

#### 20-01 核心约束

| 模块 | 铁律 |
|---|---|
| CEO / agent 主循环 | R0 在 context 构建时调用 `memory.queryFacts`（已达成的设计，D-AGENT-19 §19-04） |
| CEO Memory 查询 | 使用确定性规则查询（type / subject / confidence），不使用 embedding 或语义搜索 |
| AttentionEngine | **不读 MemoryStore**（D-AGENT-19 §19-01 保持） |
| DecisionEngine | **不读 MemoryStore**（D-AGENT-19 §19-01 保持） |
| WorldState | MemoryCache 是 WorldState 的 optional 字段，CEO 管理，不接受 Memory 主动写入 |

#### 20-02 CEO Context Assembly 四元组

CEO 每次响应前构建的 context 由四个正交维度组成：

```
CEO Context = {
  input:      当前用户输入（原始文本）
  worldState: WorldState snapshot（当前设备/用户/时间态）
  info:       InfoRecord 最新 3 条（近期限时上下文）
  memory:     LongMemoryFact 相关子集（长期知识）  ← Phase 6 新增
}
```

注入层次（从下到上，R0 最先，R4 最后）：

```
R0: persona（静态）
R1: worldState snapshot（每次构建）
R2: infoRecords（最近 3 条）
R3: memoryFacts（Phase 6 新增，按策略选取）
R4: 当前用户输入
```

#### 20-03 Memory Retrieval 策略

**触发条件**：

| 类型 | 条件 | 是否查询 |
|---|---|---|
| 主动查询 | 用户明确提及已知 subject | ✅ |
| 主动查询 | 用户请求与自身偏好/习惯相关内容 | ✅ |
| 主动查询 | 系统 prompt 构建阶段（R3 注入） | ✅ |
| 条件查询 | WorldState 显著变化（离线→在线） | ✅ |
| 条件查询 | Episode 话题转换 | ✅ |
| 条件查询 | InfoRecord 出现与已知 Memory subject 匹配的新条目 | ✅ |
| 不查询 | 纯任务指令且与个人偏好无关 | ❌ |
| 不查询 | Episode 时长 < 2 条消息（冷启动） | ❌ |
| 不查询 | 5 分钟内刚查询过 | ❌ |

**匹配优先级**：
1. subject 精确匹配（最高）
2. type 过滤（用户意图 → FactType 映射）
3. 全局查询（无关键词时，按 confidence 降序）

**排序与限制**：
- primary: `confidence` 降序；secondary: `updatedAt` 降序
- Top-K: 10（可配置 `ORCA_MEMORY_CONTEXT_TOP_K`）
- 每条 fact ≤ 80 字符；R3 总字符 ≤ 500（可配置）

#### 20-04 Memory → CEO 接口契约

```ts
interface MemoryRetrievalQuery {
  type?: FactType          // 可选：精确匹配 type
  subject?: string         // 可选：精确匹配 subject（大小写不敏感）
  minConfidence?: number   // 可选：最低 confidence 阈值
  limit?: number          // 可选：默认 10
  sortBy?: ('confidence' | 'updatedAt' | 'createdAt')[]  // 默认 [confidence, updatedAt]
}

/** CEO（R0）调用的 Memory 查询接口（MemoryStore.queryFacts 的调用模式） */
async queryFacts(query: MemoryRetrievalQuery): Promise<LongMemoryFact[]>
```

**格式化**（注入 prompt）：

```
[Memory:{type}] {subject}: {value} (confidence {confidence})
```

**不注入的字段**：id、evidenceIds、representativeEvidenceIds、createdBy、privacyLevel。

#### 20-05 MAA 与 CEO Memory 查询的关系

| 维度 | MAA 路径 | CEO Memory 查询路径 |
|---|---|---|
| 起点 | MemoryAttentionAdapter | CEO（R0） |
| 终点 | EventBus → AttentionEngine | prompt context（R3） |
| 频率 | 轮询 60s + 事件驱动 | 按需（每次 context 构建） |
| 输出 | AttentionItem | LongMemoryFact[] |
| 消费者 | AttentionEngine / DecisionEngine | LLM（通过 prompt） |
| 配置 | `ORCA_MEMORY_ATTENTION_*` | `ORCA_MEMORY_CONTEXT_*` |

两个通道互补独立。MAA 让 Memory 自动影响 Attention/Decision；CEO Memory 查询让人工智能在生成回复时知道用户背景。

#### 20-06 MemoryCache（可选，Phase 6.B）

**不作为 MVP 实现**，但设计如下：

- WorldState 增加可选字段 `memoryCache: { lastRetrievedAt, lastRetrievedFacts, lastQueryHash }`
- TTL = 5 分钟（`ORCA_MEMORY_CACHE_TTL_MS`）
- `memory_changed` 事件**立即失效** MemoryCache（CEO 订阅 `memory_changed`，清除缓存）
- 命中 cache 时直接使用，不调用 `queryFacts`

#### 20-07 Summary 层结论（当前 MVP 不需要）

当前不需要 Memory Summary 层：
- LongMemoryFact 已是 summarization 的产物（Episode → Reflection → Candidate → MemoryStore，每步都有压缩）
- `value` 字段已截断至 60 字符
- 活跃 Memory facts < 100 条，全量注入 token 预算内可覆盖

未来扩展（Phase 6+）：按 type 分桶，每桶取 Top-3；不做 abstractive summarization。

#### 20-08 与现有决议边界

- **不修改** D-AGENT-17（MemoryStore mutation authority）
- **不修改** D-AGENT-18（Memory contract hardening）
- **不修改** D-AGENT-19（Memory Consumption Boundary；CEO 查询路径是 §19-04 的直接实现；MAA 路径不变）
- **不修改** DecisionEngine / AttentionEngine 纯函数约束
- **不修改** WorldState 接口（MemoryCache 是 optional 字段，CEO 管理）
- **不引入** vector DB / embedding / SQLite
- **不引入** Memory → WorldState 主动投影
