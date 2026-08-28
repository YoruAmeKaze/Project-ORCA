# Project Orca — Agent 启动上下文（AGENT.md）

> **给新会话/新代理的启动引导**：开工前先通读本文档，再按需深读具体文件。本文档是当前代码（**app-cordis v0.6.0 + Phase 4.B 开发中**）的权威快照。
> 与 `README.md`（对外概述）、`dev-log.md`（历史日志）、`TODO.md`（待办）配合使用；冲突时**以本文档 + 源码为准**。
> **维护规则（硬性，见 `guide/decisions.md` D-VER-04）**：每次代码有实质变更（新机制、版本升级），**提交前必须同步本文档**——改目录结构/机制/配置键/版本号/待办中任一项即必改对应板块；dev-log 条目末尾标注"AGENT.md 已同步"。代码改了但本文档停在旧状态 = 违规提交。

---

## 0. 一句话定位

**通过飞书聊天的本地桌面 AI 助手**（"全向性室内控制代理"）。给 Orca 发飞书消息，它帮你识别食物热量、查询记录、闲聊；底层是持续感知的 Runtime（事件流 + 世界状态 + 注意力系统，为主动提醒打基础）。人设：平级称呼（叫"你"）+ 语气"淡淡死感"（平静简短、可靠不煽情、不用 emoji）。跑在用户 Windows 笔记本上，`app-cordis/`（Cordis/TypeScript）为**唯一主线**，Python 版已删除。

---

## 1. 快速启动（app-cordis）

```bash
# 前置：Node.js ≥ 20（D:\node\node.exe）；本地视觉需 Ollama（qwen3-vl:4b）
# 配置：复制根 .env.example 为 .env，填 DEEPSEEK_API_KEY / FEISHU_APP_ID / FEISHU_APP_SECRET 等
#       （app-cordis 默认读根 .env；app-cordis/.env 可覆盖）

cd app-cordis
npm install --cache .npm-cache    # 沙箱环境需指定工作区内缓存
npm run build                     # tsc 编译到 dist/
npm start                         # node dist/index.js；或 npm run dev（tsx watch）

# Windows 一键启动（含 SSH 隧道到 47.76.188.165）：根目录 start-cordis.bat
```

服务监听：`8100` 飞书 webhook（`POST /feishu/webhook`）、`8101` 外部 Push 通道、`8200` Dashboard。`ORCA_DRY_RUN=1` 本地调试（AI 回复只写日志不发飞书）。

---

## 2. 当前架构（app-cordis v0.6.0 + Phase 4.B）

```
飞书 webhook → feishu-channel（ctx.emit feishu/message + feishu/image，p2p/群聊带 chat_id）
  → agent（CEO：R0 查档 + LLM 回复）        # 信息获取框架（InfoAgent）
  → image-router（D-AGENT-15：chat_id → agent 工位分配）
  → [Orca Runtime，ORCA_RUNTIME_ENABLED=1 启用]
      feishu-adapter → EventBus（滑动窗口 200）
        → WorldStateUpdater（reducer 注册表 + time tick）→ WorldStateService
        → pc/calendar/phone adapters（mock，默认 disabled）
        → AttentionEngine（Phase 3：规则评估 → dedup → throttle）→ emit 'orca/attention'
        → DecisionEngine（Phase 4.A：纯决策层，AttentionItem → Decision）→ emit 'orca/decision'
        → ActionExecutor（Phase 4.B：registry + builtin handlers + deferred store）→ emit 'orca/action-result'
```

设计原则（详见 `guide/orca-cordis-migration-plan.md`）：**纯 Cordis 自写飞书通道（B 方案）**；信息获取用 CEO-员工-档案室模型（`guide/orca-info-agent-framework.md`）；Persistent Context Runtime 分阶段演进（EventBus → WorldState → Attention → Decision）。

### Runtime 消息处理全链路

1. 飞书事件 → feishu-channel → `feishu/message` 事件（去重 60s）
2. agent 插件：R0 查档案（饮食类命中直接引用，零视觉调用）→ persona+历史 → LLM → `sendToChat` 独立消息回复
3. 图片事件 → image-router 按 chat_id 派发 → food 管线（下载 → 识别 → 写 food-log 档案 → 回复）
4. Runtime 启用时：feishu-adapter 旁路订阅 → EventBus → WorldState 更新 → Attention 评估

---

## 3. 目录结构（当前真实状态）

```
app-cordis/                    # ★ Cordis/TypeScript 版（唯一主线）
│   ├── src/
│   │   ├── index.ts           # 入口：loadEnv → Context → 插件装配
│   │   ├── config.ts          # .env 加载（根 .env + app-cordis/.env 覆盖）；全部配置键
│   │   ├── persona.ts         # Orca 人设（平级称呼 + "淡淡死感"）
│   │   ├── context.ts         # Cordis Context 类型增强（feishu/llm/vision/sessions/info*/eventBus/worldState/attention/decision）
│   │   ├── session.ts         # SessionStore：内存会话
│   │   ├── agents/            # 信息获取框架：types/registry（闭集）/store（档案室 JSONL）/executor（Pull）/router（R0+R1）/builtins/food-log.ts（food-agent）
│   │   ├── services/          # feishu / llm（DeepSeek）/ vision（Qwen VL）/ eventBus / worldState / attention / attention-config / decision / action
│   │   ├── plugins/           # feishu-channel / agent / info-agents / info-receiver / image-router / food-image / dashboard / orca-runtime / world-state-updater / attention-engine / decision-engine / action-executor / input-adapters/{feishu,pc,calendar,phone}-adapter
│   │   ├── types/             # event.ts（OrcaEvent）/ worldState.ts / attention.ts / decision.ts / action.ts
│   │   └── data/              # records/ 档案室 JSONL + images/ 图片落盘（gitignore）
│   └── scripts/               # smoke-info-agent / smoke-world-state / smoke-attention / smoke-decision / smoke-action / recognize-food / list-food
guide/                         # 设计文档（memory-pack / decisions / orca-cordis-migration-plan / orca-info-agent-framework / orca-iphone-channel）
AGENT.md                       # ★ 本文档
dev-log.md / TODO.md / README.md
```

---

## 4. 核心机制速查

### 4.1 飞书通道（plugins/feishu-channel.ts）
- webhook：challenge 验证；event_id 60s 去重；p2p + 群聊（事件带 chat_id）；text → `feishu/message`，image → `feishu/image`；fire-and-forget

### 4.2 InfoAgent 框架（agents/）
- **CEO-员工-档案室模型**：主 agent（CEO）只决策汇总；信息源 = InfoAgent（员工）；档案室 = 每 namespace 一 JSONL
- **闭集注册表**（D-AGENT-02）：新增信息源 = 注册一个 InfoAgent，主循环零改动
- **R0 查档优先**（D-AGENT-10）：饮食类问题先查档案，命中直接复用（零视觉调用，省钱核心）
- **档案室**（D-AGENT-09/11/12）：append-only + supersedes 更正、软删/整夹清空 + ttl 清理、pending 待汇报队列

### 4.3 Persistent Context Runtime
- **EventBus**（services/eventBus.ts）：内存 pub/sub + 滑动窗口（默认 200）；与 `ctx.emit/on` 共存（不替代）；异步 setImmediate 派发不阻塞；handler 异常隔离
- **WorldState**（services/worldState.ts + plugins/world-state-updater.ts）：4 块（user/device/time/extensions）；reducer 注册表 key = `${source}:${type}`；字段级变化检测才 emit `'orca/state_changed'`；time tick 推导 away（仅 awake→away 单向，严格 30min）
- **Attention**（services/attention.ts + plugins/attention-engine.ts，Phase 3）：纯规则评估（5 条内置规则）→ dedup（窗口去重）→ throttle（source cooldown + hourly cap）→ emit `'orca/attention'`；**rule-registry**：Engine 与规则解耦，支持热更新
- **Decision**（services/decision.ts + plugins/decision-engine.ts，Phase 4.A）：**纯决策层**——AttentionItem → Decision 1:1 映射；不重新判断 priority / 不重新评估 Attention 规则 / 不执行 action / 不持久化；emit `'orca/decision'`。AttentionItem 新增 `id: string`（randomUUID，Decision back-trace 用）。
- **Action**（services/action.ts + plugins/action-executor.ts，Phase 4.B）：**执行层**——Decision → ActionResult 1:1；ActionHandlerRegistry 索引 handler；内置 5 个 handler（noop/remember/defer/notify-stub/act-stub）+ DeferredActionStore（仅 in-memory）；emit `'orca/action-result'`。**关键安全约束**：act handler 默认 stub，禁止任意 shell / JS / 插件调用；ORCA_ACTION_ENABLED 默认 false。

### 4.4 关键事件（ctx.emit / ctx.on）
| 事件 | 载荷 | 产生者 |
|------|------|--------|
| `feishu/message` | text/openId/chatId/messageId | feishu-channel |
| `feishu/image` | imageKey/chatId/messageId | feishu-channel |
| `info/record` | InfoRecord | info-agents（写档） |
| `orca/event` | OrcaEvent | EventBus |
| `orca/state_changed` | WorldState | world-state-updater |
| `orca/attention` | AttentionItem（含 `id`） | attention-engine |
| `orca/decision` | Decision | decision-engine |
| `orca/action-result` | ActionResult | action-executor |

---

## 5. 能力清单（app-cordis）

| 能力 | 实现 | 说明 |
|------|------|------|
| 飞书对话 | `plugins/agent.ts` | persona + 历史 → DeepSeek → sendToChat |
| 食物识别 | `agents/builtins/food-log.ts` + `plugins/food-image.ts` | 图片 → Qwen VL → food-log 档案 → 回复；R0 查档复用 |
| 直连图片上传 | `plugins/info-receiver.ts` POST /info/images | 快捷指令 Base64 直传，同步返回识别结果 |
| 外部记录上报 | `plugins/info-receiver.ts` POST /info/records | Bearer 鉴权 + namespace 白名单 |
| 事件流 | `services/eventBus.ts` + feishu-adapter | Runtime 输入 |
| 世界状态 | `services/worldState.ts` | 用户/设备/时间实时视图 |
| 注意力评估 | `services/attention.ts` | 纯规则 → dedup → throttle |
| 决策层（Phase 4.A） | `services/decision.ts` + `plugins/decision-engine.ts` | 纯函数：AttentionItem → Decision（不执行 action） |
| 执行层（Phase 4.B） | `services/action.ts` + `plugins/action-executor.ts` | Decision → ActionResult（registry + 5 builtin handlers + deferred store；act/notify 默认 stub） |
| 调试 | `plugins/dashboard.ts` | /dashboard HTML + /api/status + /api/events + /api/world-state + /api/attention + /debug/publish-event |

> Python 版能力（桌面控制、瑞幸点单、联网搜索、截图）已在 Python 版删除时一并移除；如需迁移为 InfoAgent，见 `guide/orca-cordis-migration-plan.md`。

---

## 6. 配置项（.env，键名来自 app-cordis/src/config.ts）

| 键 | 默认 | 用途 |
|----|------|------|
| DEEPSEEK_API_KEY / URL / MODEL | deepseek-v4-flash | 主 LLM（对话） |
| FEISHU_APP_ID / SECRET | — | 飞书机器人 |
| ORCA_VISION_BACKEND | dashscope | 视觉后端：`ollama`（本地）\| `dashscope`（云端） |
| QWEN_API_KEY / URL / QWEN_VL_MODEL | qwen3.7-plus | 云端视觉 |
| OLLAMA_HOST / OLLAMA_VL_MODEL | localhost:11434 / qwen3-vl:4b | 本地视觉 |
| CORDIS_HOST / CORDIS_PORT | 0.0.0.0:8100 | 服务监听 |
| ORCA_DRY_RUN | — | 1 = 只写日志不发飞书 |
| ORCA_HISTORY_TURNS | 10 | 每会话保留轮数 |
| INFO_RECORDS_DIR / IMAGES_DIR | app-cordis/data/records·images | 档案室 / 图片落盘 |
| INFO_RECEIVER_PORT | 8101 | 外部 Push 通道端口 |
| INFO_RECEIVER_TOKENS | 空 | JSON `{"<token>":["<namespace>"]}`；未配不启动 |
| ORCA_CHAT_BINDINGS | 空 | JSON `{"<chat_id>":"<agent>"}` 会话绑定路由（D-AGENT-15） |
| ORCA_RUNTIME_ENABLED | 0 | 1 = 启用 Runtime（**必须严格写 1**） |
| ORCA_RUNTIME_WINDOW | 200 | EventBus 滑动窗口 |
| ORCA_WORLD_STATE_ENABLED | 1 | WorldState 开关（=0 关闭） |
| ORCA_WORLD_STATE_REFRESH_MS | 60000 | time tick 间隔（away 推导） |
| ORCA_PC_ENABLED / ORCA_PC_REFRESH_MS | 0 / 60000 | PC adapter（mock） |
| ORCA_CALENDAR_ENABLED / ORCA_CALENDAR_REFRESH_MS | 0 / 120000 | Calendar adapter（mock） |
| ORCA_PHONE_ENABLED / ORCA_PHONE_REFRESH_MS | 0 / 300000 | Phone adapter（mock） |
| ORCA_ATTENTION_ENABLED | 1 | Attention Engine（纯评估，安全默认） |
| ORCA_DECISION_ENABLED | 1 | Decision Engine（Phase 4.A 纯决策层，安全默认） |
| ORCA_ACTION_ENABLED | 0 | Action Executor（Phase 4.B 执行层；默认禁用，启用前需明确注册 handler） |

> 注意：`ORCA_*_ENABLED` 类必须严格写 `1`（`true`/`yes`/`on` 不生效）；.env 中行首 `#` 视为注释（曾有用户复制 .env.example 带 `#` 导致不生效的坑）。

---

## 7. 技术栈

@deepseek-ai/cordis（4.x）+ TypeScript；DeepSeek（主 LLM）；Ollama qwen3-vl:4b / 阿里百炼（视觉）；飞书开放平台（webhook 自写通道）；Node.js ≥ 20。无 Python 依赖。

---

## 8. 当前状态

### 8.1 已完成
- **Phase 1（v0.1.0，2026-08-24）**：Cordis 骨架 + 飞书→AI 最小闭环
- **Phase 2 信息获取框架（v0.2.0→v0.4.0，2026-08-25）**：InfoAgent（CEO-员工-档案室）+ food-agent + 飞书图片闭环 + 会话绑定路由 + 本地视觉 + 直连图片上传
- **Phase 0+1（v0.5.0，2026-08-27）**：Persistent Context Runtime（EventBus + feishu-adapter + /api/events）
- **Phase 2 Runtime（v0.6.0，2026-08-27）**：WorldState（骨架 + time tick + 3 mock adapters + debug publisher）完整闭环，`git tag v0.6.0`
- **Phase 3.A（2026-08-27）**：Attention Engine 纯规则评估（5 条内置规则 + prevState 快照）
- **Phase 3.B（2026-08-27）**：dedup（去重）→ throttle（节流）→ rule-registry（规则注册表解耦，Engine 接受 AttentionRuleRegistry 注入）
- **Phase 3.B.rule-config（2026-08-27）**：AttentionRuleConfigLoader（JSON 严格白名单 `enabled`，未知 ruleId 抛错）
- **Phase 4.A（2026-08-27）**：Decision Engine 纯决策层（AttentionItem → Decision 1:1 映射；AttentionItem 新增 `id`；不执行 action）；R13 smoke 覆盖 5 条 action 映射 + priority/reason/eventId 透传 + 无副作用 + EventBus 集成
- **Phase 4.B（2026-08-27）**：Action Executor 执行层——ActionHandlerRegistry + 5 个 builtin handler（noop/remember/defer/notify-stub/act-stub）+ DeferredActionStore（仅 in-memory）+ orca/action-result 事件；ORCA_ACTION_ENABLED 默认 false（**安全默认**）。R14 smoke 85 用例覆盖 5 个 action 行为 + registry 生命周期 + 真实 infoStore 写入 + pending store + EventBus 集成 + dispose + act 安全边界（禁止任意 shell）。
- **Python 版删除（2026-08-27）**：v2.3.0 全部源码移除，app-cordis 成为唯一主线

### 8.2 待办（TODO.md）
- **Phase 4.C**：ActionPlan 拆分（payload / channel / target）；真实 notify handler（复用 FeishuClient.sendToChat）；真实 act handler（最小权限 + 白名单校验）；DeferredActionStore scheduler（消费 pending，按 user.status 合并通知）；urgency=2 主动推送
- 迁移 search_web / capture_screenshot / analyze_image 为 InfoAgent（Pull）
- 会话持久化（jsonl）；独立飞书 bot 的 app_id 路由（远期）
- 飞书事件订阅加密模式支持（技术债）

### 8.3 关键架构约束（Phase 3.A + Phase 4.A + Phase 4.B 确定，Attention/Decision/Action 必读）
- **Attention Rule predicate 判断"事件发生前状态"必须用 `prevState`**；`state` 是事件处理后（reducer 已应用）的世界。
- 错误示范：`predicate: ({ state }) => state.user.status === 'away'`（reducer 改 awake 后永远不触发）；正确：`predicate: ({ prevState }) => prevState?.user.status === 'away'`。
- `prevState` 在 state-only 触发时为 `undefined`；event 触发时由 `ws.getPrevState()` 提供。
- 三层职责分离：Engine（是什么）→ Dedup（多不多）→ Throttle（该不该打扰）；throttle 仅限 notify_immediately + act，remember_only/ignore/wait_until_available 直通。
- **AttentionRuleRegistry（Phase 3.B.rule-registry）**：Engine 与规则**解耦**。AttentionRuleRegistry 接口：`register / unregister / getRules / getAllRules / setEnabled / isEnabled / size / clear`。`getRules()` 仅返回启用规则（按注册顺序）；同 id 重复 register 覆盖并保留原位置（热更新）。`createAttentionEngine(registry?)` 不传参使用 `getDefaultRegistry()`（包含 5 条内置规则；行为等同 Phase 3.A）。向后兼容：`registerRule / clearRules / ruleRegistrySize` 委托 defaultRegistry（R8/R9/R10 测试零改动）。
- **AttentionRuleConfigLoader（Phase 3.B.rule-config）**：JSON 配置加载器，**只表达 enabled 状态**，不创建 predicate/expression（防 DSL 倾向）。`{rules: {ruleId: {enabled: bool}}}` 格式；**严格白名单**只解析 `enabled` 字段；未知字段（predicate / expression 等）直接报错（fail-fast）。`unknown ruleId` 抛错（防静默错误）。Loader 接受 registry 参数，**不污染** `getDefaultRegistry()`。**仅支持 JSON**（项目无 YAML 依赖；YAML 为后续扩展）。**禁止**：DSL / 表达式 / JavaScript 注入 / LLM rule generation / 持久化 / 加载内置 5 条规则（这些必须由 TypeScript 代码 register）。`createRuleConfigLoader()` 工厂返回 `{ parse(jsonText), load(config, registry) }`。R12 smoke 28 用例覆盖空配置 / disable / re-enable / 未知 id / JSON 错误 / 结构错误 / 拒绝未知字段 / 独立 Registry / 默认 Registry 兼容性。
- **AttentionItem.id（Phase 4.A 引入）**：每个 AttentionItem 生成时分配 `randomUUID()`；用于 Decision `attentionId` back-trace；不影响 Phase 3 测试（R8/R9/R10/R11/R12 零改动）。
- **DecisionEngine（Phase 4.A 纯决策层）**：严格分层不重新判断 Attention 规则；输入 AttentionItem → 输出 Decision（1:1 映射）；`decide()` / `decideMany()` 是**纯函数**，无 IO / 无 service 调用 / 无副作用 / 不发飞书 / 不写 infoStore / 不调 LLM / 不执行 shell。Action 映射：`notify_immediately→notify`、`remember_only→remember`、`wait_until_available→defer`、`act→act`、`ignore→no_action`；未知 AttentionAction 透传原值（fail-soft）。透传字段：priority / reason / eventId / source / ruleId。不重排 priority / 不排序 / 不持久化。`createDecisionEngine()` 工厂返回 `{ decide, decideMany }`。
- **DecisionEnginePlugin（Phase 4.A Cordis integration）**：订阅 `ctx.on('orca/attention')` → `engine.decide(item)` → `ctx.emit('orca/decision')`。**不阻塞**原始 Attention publisher（ctx.on 是 listener；不影响 emit）；listener try/catch（handler 异常不崩其他 listener）；无 inject 依赖（DecisionEngine 是纯函数）。挂载顺序：**必须在 AttentionEngine 之后**（依赖 `orca/attention` emit；index.ts 已按顺序装配）。
- **ActionExecutor（Phase 4.B 执行层）**：严格分层不重新评估 Decision / Attention / WorldState；输入 Decision → 输出 ActionResult（1:1）。`execute(decision)` 是异步（Promise）但**严格不抛异常给 caller**：handler 异常被内部 catch 转化为 success=false ActionResult。ActionHandlerRegistry 接口：`register / unregister / get / list / size / clear`；同 action 重复 register 覆盖（Last-Write-Wins）。**关键安全约束**：act / notify handler 默认是 stub（`act-stub` / `notify-stub`），禁止任意 shell / JS / 插件调用；未配置 handler 时 success=false + 明确 error；不提供 fake shell executor。`createActionExecutor({ registry?, deferredStore? })` 工厂返回 `{ execute, registry, deferredStore }`。DeferredActionStore 接口：`enqueue / get / list / size / clear`；Phase 4.B 第一版**不调度**（仅 in-memory 记录 + 查询接口；Phase 4.C+ scheduler 消费）。
- **ActionExecutorPlugin（Phase 4.B Cordis integration）**：订阅 `ctx.on('orca/decision')` → `executor.execute(decision)` → `ctx.emit('orca/action-result')`。**不阻塞**原始 Decision publisher（ctx.on 是 listener；不影响 emit）；listener try/catch + Promise.catch 双重兜底（即使 handler 抛错也不崩服务）。`ctx.actionExecutor` service 暴露 executor。remember handler 通过 `ctx.get('infoStore')` 软注入（infoAgents plugin 未挂载时跳过 remember handler 注册，其他 handler 不受影响）。挂载顺序：**必须在 DecisionEngine 之后**（依赖 `orca/decision` emit；index.ts 已按顺序装配）。
- **ORCA_ACTION_ENABLED 默认 false**（用户决策：act handler 暂无显式注册时不应执行任何副作用；启用前应明确注册 handler）。

---

## 9. 文档地图（新会话按需取用）

| 文档 | 内容 | 何时读 |
|------|------|--------|
| **本文档 AGENT.md** | 当前状态全貌 | 每次会话必读 |
| `guide/memory-pack.md` | 设计哲学（早期 PTE 架构，已随 Python 版过时，保留作历史） | 理解历史动机时 |
| `guide/decisions.md` | D-* 架构决议（D-VER 版本规则仍有效；D-AGENT-* InfoAgent 决议） | 改架构/加机制前必读 |
| `guide/orca-cordis-migration-plan.md` | Cordis 迁移方案（v1.0 定稿） | 做迁移工作时 |
| `guide/orca-info-agent-framework.md` | InfoAgent 框架设计（v0.2，CEO-员工-档案室，D-AGENT-01~12） | 接信息源/改 agents 时 |
| `guide/orca-iphone-channel.md` | iPhone 数据通道调研（三通道/D-AGENT-13） | 接手机数据时 |
| `dev-log.md` | 版本历史 v1.0→v0.6.0+Phase 3 | 查"为什么这么改"时 |
| `README.md` | 对外概述（当前主线 app-cordis） | 对外介绍时 |
| `TODO.md` | 待办清单 | 规划下一步时 |

深读优先级（改代码前）：`app-cordis/src/index.ts` → `src/config.ts` → `src/context.ts` → 对应 plugin/service。

---

## 10. 常见陷阱（历史踩坑）

1. **cordis fork 日志级别**：exporter `levels.default` 是导出阈值上限（level ≤ 阈值才导出：ERROR=0/INFO=1/WARN=2/DEBUG=3）；`default:1` 会吞掉全部 WARN——日志"消失"先查 exporter levels，勿怀疑事件总线
2. **cordis 插件 inject 门控**：插件用 ctx 服务必须声明 `plugin.inject`，否则激活即崩；async 监听器必须 try/catch（reject → unhandledRejection 崩进程）
3. **飞书消息图片下载接口**：消息里收到的图片必须走 `im/v1/messages/{id}/resources/{key}?type=image`（消息资源接口）；`im/v1/images/{key}` 是上传场景接口，对消息图返回 234001
4. **reasoning 视觉模型 max_tokens 截断**：本地 qwen3-vl 对长 prompt 大量 thinking，max_tokens 太小（400）会 content 为空；`max_tokens` 3000 + 空响应重试 3 次
5. **Ollama 大图 400**：vision.ts 用 Ollama 原生 `/api/chat` + `num_ctx=16384` 修复
6. **群聊必须 @ 机器人**（飞书平台规则，无免 @ 开关）：p2p 免 @；群聊用独立 bot 或工位路由
7. **`.env` 行首 `#` 是注释**：复制 .env.example 时去掉 `#` 前缀；`ORCA_RUNTIME_ENABLED` 必须写 `1`（true/yes/on 不生效）
8. **Windows 沙箱环境**：node/npm 在 `D:\node`（不在 PATH）；npm 缓存须指工作区（`--cache .npm-cache`）；esbuild/tsx 子进程被拦 → 用 tsc build + node 直跑；浏览器访问用 127.0.0.1（IPv6 坑）
9. **noUncheckedIndexedAccess（tsconfig）**：数组/索引访问必须处理 undefined（`results[i] ?? fallback`）
10. **DBus/进程**：DSH 后台 job kill 后子进程可能残留监听端口，需按 PID 强杀

---

*维护者：ka。本文档与代码同步于 **app-cordis v0.6.0 + Phase 4.B（2026-08-27，Python 版已删除）**。*
