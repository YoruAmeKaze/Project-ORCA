# Project Orca — Agent 启动上下文（AGENT.md）

> **给新会话/新代理的启动引导**：开工前先通读本文档，再按需深读具体文件。本文档是当前代码（**app-cordis v1.0.0 + Phase 7.1B 全部完成**）+ 设计稿（**Phase 7.3 Architecture Review + IM Bridge IM-1.0 + guide/orca-memory-quality-design.md**）的权威快照。
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

## 2. 当前架构（app-cordis v0.6.0 + Phase 5.3）

```
飞书 webhook → feishu-channel（ctx.emit feishu/message + feishu/image，p2p/群聊带 chat_id）
  → agent（CEO：R0 查档 + LLM 回复）        # 信息获取框架（InfoAgent）
  → image-router（D-AGENT-15：chat_id → agent 工位分配）
  → [Orca Runtime，ORCA_RUNTIME_ENABLED=1 启用]
      feishu-adapter → EventBus（滑动窗口 200）
        → WorldStateUpdater（Reducer 注册表）→ WorldStateService
        → RuntimeAdapters（Phase 7.1A：统一 { start(), stop() } 接口）
        → SchedulerAdapter（emit scheduler:tick 仅；纯 Time Producer）
        → PC/Calendar/Phone adapters（mock，默认 disabled）
        → AttentionEngine（Phase 3：规则评估 → dedup → throttle）→ emit 'orca/attention'
        → DecisionEngine（Phase 4.A：纯决策层，AttentionItem → Decision）→ emit 'orca/decision'
        → ActionExecutor（Phase 4.B + 4.D + Phase 5.2：registry + builtin handlers + deferred store + scheduler consume + memory.remember/forget）→ emit 'orca/action-result'
        → NotifyHandler（Phase 4.C：EventBus.get(id) 反查 → FeishuClient.sendToChat）
        → Phase 4.E：deferred-scheduler 按 chatId 分组合并 → emit merged notify Decision（上限 5 条）
  → MemoryStore（Phase 5.0：LongMemory mutation authority；JSONL + 内存索引；提供 queryFacts/getFact/upsertFact/supersedeFact/mergeFacts/compressFactEvidence/forgetFact/forgetByQuery/createForgetMarker/queryForgetMarkers/queryAudit + Candidate promote/reject/expire）
  → EpisodeEngine（Phase 5.1：message.burst + state.transition；写入 episodes.jsonl；纯规则无 LLM；EventBus 事件 + WorldState 变化驱动）
  → ReflectionEngine（Phase 5.3：deterministic rule-based；Episode → MemoryCandidate → MemoryStore.promoteCandidate；纯规则无 LLM；subject-only ForgetMarker privacy gate）
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
│   │   ├── services/          # feishu / llm（DeepSeek）/ vision（Qwen VL）/ eventBus / worldState / attention / attention-config / decision / action / memoryStore（Phase 5.0）/ episodeEngine（Phase 5.1）/ reflectionEngine（Phase 5.3）/ scheduledRuleRegistry（Phase 7.1B）
│   │   ├── plugins/           # feishu-channel / agent / info-agents / info-receiver / image-router / food-image / dashboard / orca-runtime / world-state-updater / attention-engine / decision-engine / action-executor / episode-engine（Phase 5.1）/ reflection-engine（Phase 5.3）/ scheduled-rule-registry（Phase 7.1B）/ input-adapters/{feishu,pc,calendar,phone,scheduler}-adapter
│   │   ├── types/             # event.ts（OrcaEvent）/ worldState.ts / attention.ts / decision.ts / action.ts / memory.ts（Phase 5.0+5.1：LongMemoryFact / MemoryCandidate / AuditEvent / ForgetMarker / Episode / MemoryStore 接口）/ runtime-adapter.ts（Phase 7.1A）/ scheduled-rule.ts（Phase 7.1B）
│   │   ├── rules/scheduled/   # briefing.ts / reflection.ts（Phase 7.1B deterministic rules）
│   │   └── data/              # records/ 档案室 JSONL + images/ 图片落盘（gitignore）
│   └── scripts/               # smoke-info-agent / smoke-world-state / smoke-attention / smoke-decision / smoke-action / smoke-memory（Phase 5.0） / smoke-episode（Phase 5.1） / smoke-memory-handler（Phase 5.2） / smoke-reflection（Phase 5.3） / smoke-d-agent-18（Phase 5.3.1） / smoke-memory-attention（Phase 5.4.A） / smoke-memory-event-bridge（Phase 5.4.B） / smoke-scheduled-rule-registry（Phase 7.1B） / smoke-briefing-rule（Phase 7.1B） / smoke-reflection-rule（Phase 7.1B） / smoke-reminder-rule（Phase 7.1B） / recognize-food / list-food
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
- **Action**（services/action.ts + plugins/action-executor.ts + plugins/deferred-scheduler.ts，Phase 4.B + 4.C + 4.D + 4.E）：**执行层**——Decision → ActionResult 1:1；ActionHandlerRegistry 索引 handler；内置 handler（noop/remember/defer/notify-stub/act-stub）+ Phase 4.C 真实 notify handler（依赖 EventBus.get + FeishuClient.sendToChat）+ DeferredActionStore（仅 in-memory；Phase 4.D 增加 `consume(pendingId)` 原子删除）；emit `'orca/action-result'`。**关键安全约束**：act handler 默认 stub，禁止任意 shell / JS / 插件调用；ORCA_ACTION_ENABLED 默认 false。Phase 4.D：deferredScheduler plugin 每 30s tick 一次；user.status in {busy, sleeping} 时保留 pending；awake/away 时 consume pending + emit 'orca/decision'（defer 翻译为 no_action 防循环）。**Phase 4.E：chatId 分组合并**——同 chatId 多条 pending 合并为单条 notify Decision（`MERGED_DECISION_RULE_ID='deferred-merged'`，priority 取最高，reason 多行摘要含 `- [source] priority: reason`，`MAX_MERGED_ITEMS=5` 超出 truncate）；单条 pending 保持原 Decision 语义；无 eventBus / 无法反查 chatId 的 entry 单独 emit（不误合并）。
- **Memory**（services/memoryStore.ts + types/memory.ts，Phase 5.0）：**LongMemory mutation authority**——所有 LongMemory 写必须经过 MemoryStore，不允许 Reflection 直接修改 JSONL 或 in-memory 对象。持久化：JSONL（long.jsonl / candidates.jsonl / markers.jsonl / audit.jsonl / episodes.jsonl）+ 内存 Map 索引（同 D-AGENT-09 JsonlInfoRecordStore 模式，lazy load on first access）。`upsertFact`：identity=(type, subject)，同 identity 原地更新不创建新 id。`supersedeFact`/`mergeFacts`/`compressFactEvidence`：所有写操作产生 AuditEvent。`forgetFact`：**forget operation is owned and orchestrated by MemoryStore; marker creation and fact purge are performed within the MemoryStore operation**（注意：JSONL 是按顺序写的，并非数据库级 transaction；写入顺序固定为 createForgetMarker → persistFact → rejectCandidates → appendAudit，已尽量减少不一致窗口）。`createForgetMarker`：幂等，相同 type+subject 返回已有 marker（fingerprint = sha256(salt + lower(subject)).slice(0,16)）。`queryAudit`：never exposes value content（prevValue/newValue 字段不存在）。Candidate API：`appendCandidate` / `queryCandidates` / `promoteCandidate` / `rejectCandidate` / `expireCandidates`。**Episode API（Phase 5.1）**：`appendEpisode` / `queryEpisodes` / `getTodayEpisodes` / `getRecentEpisodes` / `pruneExpiredEpisodes`。**Privacy API（Phase 5.3）**：`isSubjectSuppressed(subject)` — subject-only ForgetMarker 抑制检查（不依赖 type），作为 ReflectionEngine 的 privacy gate。`isSuppressed(type, subject)` 保留为 type-scoped 检查。**配置**：`ORCA_MEMORY_DIR`（默认 `appRoot/data/memory`）、`ORCA_MEMORY_SALT`（**必须稳定**，否则 restart 后 fingerprint 不一致导致 ForgetMarker 失效）、`ORCA_MEMORY_MAX_ACTIVE_FACTS`、`ORCA_MEMORY_PROMOTE_THRESHOLD`。
- **EpisodeEngine**（services/episodeEngine.ts + plugins/episode-engine.ts，Phase 5.1）：**Short Memory 生成引擎**——监听 EventBus 事件和 WorldState 变化，生成 Episode 写入 MemoryStore。两类 Episode（确定性规则，无 LLM）：`message.burst`（同 sender 在 90s 内发送 ≥3 条消息，产生一条摘要 Episode，sourceEventIds 保留全部消息 id）和 `state.transition`（WorldState user.status 状态转换，如 away→active / sleeping→active，产生一条摘要 Episode，importance=high 当 sleeping→active/busy）。Burst 追踪：内存 Map（senderId → session），session 达到阈值后标记 done 防止重复生成；session 计数满后重置（下一个 burst 可重新计数）。`episodeEnginePlugin` 订阅 `orca/event`（EventBus）和 `orca/state_changed`（WorldState），挂载在 Runtime 之后。
- **ActionHandler（Phase 5.2）**（services/action.ts + plugins/action-executor.ts）：两个新增 handler——`memory.remember`（`Decision.reason` 解析 JSON → `MemoryStore.upsertFact(source='user-explicit')`，upsert 语义同 Phase 5.0）和 `memory.forget`（`Decision.reason` 解析 JSON → `MemoryStore.forgetByQuery`，forget 操作由 MemoryStore own 和 orchestrate：marker 创建与 fact 清除都在 MemoryStore 操作内完成，**禁止 handler 直接调用 createForgetMarker**）。`forgetByQuery` 返回删除数量（0 也为 success=true）；`memory.remember/forget` 注册到 `ActionExecutor.registry`，通过 `ctx.on('orca/decision')` 事件流驱动。
- **ReflectionEngine（Phase 5.3）**（services/reflectionEngine.ts + plugins/reflection-engine.ts）：**deterministic rule-based Reflection**——读取最近 Episode，运行确定性 pattern → 生成 MemoryCandidate → 检查 subject-only ForgetMarker privacy gate + user-explicit fact 冲突 → 在 confidence 阈值以上调用 `MemoryStore.promoteCandidate`。Rule A：同一 sender 在最近 30 条 Episode 中出现 ≥3 次 `message.burst` → candidate (type=`behavioral_pattern`, subject=sender, value=`high_burst_frequency`)。confidence 公式：count=3→0.70, count=4→0.75, count=5→0.80, count=6+→min(0.85+(count-6)*0.05, 0.95)。proposer ≠ mutator：ReflectionEngine 只调 MemoryStore API；**不**直接改 LongMemoryFact / JSONL。Privacy gate：`isSubjectSuppressed(subject)`（subject-only；忽略 type）— user forget 任何 type 的 fact 后，Reflection 不复活该 subject。User-explicit 冲突：若已存在 user-explicit active fact for `(type, subject)`，candidate 被 `rejectCandidate('user-explicit-fact-exists')`。

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
| 执行层（Phase 4.B + 4.C + 4.D + 4.E） | `services/action.ts` + `plugins/action-executor.ts` + `plugins/deferred-scheduler.ts` | Decision → ActionResult（registry + builtin handlers + deferred store；Phase 4.C 真实 notify handler；Phase 4.D scheduler consume + emit；Phase 4.E chatId 分组合并） |
| LongMemory（Phase 5.0） | `services/memoryStore.ts` + `types/memory.ts` | JsonlMemoryStore：queryFacts/getFact/upsertFact/supersedeFact/mergeFacts/compressFactEvidence/forgetFact/forgetByQuery/createForgetMarker/queryForgetMarkers/queryAudit + Candidate API + Episode API；AuditEvent 无 prevValue/newValue（v1.1） |
| Episode（Phase 5.1） | `services/episodeEngine.ts` + `plugins/episode-engine.ts` | message.burst（90s 窗口 ≥3 条）+ state.transition（WorldState user.status 转换）；纯规则无 LLM；episodes.jsonl 持久化 |
| ActionHandler（Phase 5.2） | `services/action.ts` + `plugins/action-executor.ts` | memory.remember（Decision.reason → upsertFact）+ memory.forget（Decision.reason → forgetByQuery）；forget 操作由 MemoryStore own |
| ReflectionEngine（Phase 5.3） | `services/reflectionEngine.ts` + `plugins/reflection-engine.ts` | Episode → Candidate → LongMemory；deterministic rule only；subject-only ForgetMarker privacy gate；user-explicit 冲突保护 |
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
| ORCA_SCHEDULER_ENABLED | 0 | Scheduler adapter（Phase 7.1A；纯 Time Producer） |
| ORCA_SCHEDULER_TICK_MS | 60000 | Scheduler tick 间隔 |
| ORCA_ATTENTION_ENABLED | 1 | Attention Engine（纯评估，安全默认） |
| ORCA_DECISION_ENABLED | 1 | Decision Engine（Phase 4.A 纯决策层，安全默认） |
| ORCA_ACTION_ENABLED | 0 | Action Executor（Phase 4.B 执行层；默认禁用，启用前需明确注册 handler） |
| ORCA_MEMORY_ENABLED | 1 | MemoryStore（Phase 5.0；默认启用） |
| ORCA_MEMORY_DIR | appRoot/data/memory | Memory JSONL 数据目录 |
| ORCA_MEMORY_SALT | CHANGE-ME-… | ForgetMarker fingerprint salt（**必须稳定**，建议 `openssl rand -hex 32` 生成） |
| ORCA_MEMORY_MAX_ACTIVE_FACTS | 100 | LongMemoryFact.active 检索结果上限 |
| ORCA_MEMORY_PROMOTE_THRESHOLD | 0.7 | Candidate confidence 晋升阈值 |

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
- **Phase 4.B（2026-08-27）**：Action Executor 执行层——ActionHandlerRegistry + 5 个 builtin handler（noop/remember/defer/notify-stub/act-stub）+ DeferredActionStore（仅 in-memory）+ orca/action-result 事件；ORCA_ACTION_ENABLED 默认 false（**安全默认**）。R14 smoke 86 用例（85 + Phase 4.B Review 修复 dispose race）覆盖 5 个 action 行为 + registry 生命周期 + 真实 infoStore 写入 + pending store + EventBus 集成 + dispose + act 安全边界（禁止任意 shell）。
- **Phase 4.B Review（2026-08-27，commit 1b20710）**：修复 dispose race condition（plugin dispose 后 in-flight execute 完成时不应 emit / log）。新增 R14.10.2 反向验证：移除 disposed 闸门后失败，恢复后通过。
- **Phase 4.C（2026-08-27）**：Orca 第一个真实 Action——NotifyHandler。EventBus.get(id) 按 eventId 反查原始 OrcaEvent（O(n) 线性扫描，仅作用于 sliding window；找不到返回 undefined）；NotifyHandler 验证 decision.eventId / event.source==='feishu' / event.data.chatId；dryRun 复用现有 OrcaConfig.dryRun；调用 FeishuClient.sendToChat 发送 `[Orca] ${priority}\n${reason}\n\n源消息: ${text.slice(0,200)}`。**严格分层**：Decision / DecisionEngine 不感知 Feishu；NotifyHandler 是 Feishu-aware 的；FeishuEventData 用 type guard narrow（不使用 any）。R15 smoke 54 用例覆盖 EventBus.get / state-only / source 校验 / Feishu context / dryRun / 真实发送 / 失败处理 / EventBus 集成 / 决策追踪。
- **Phase 4.D（2026-08-27）**：DeferredActionStore scheduler——30s tick；user.status in {busy, sleeping} 时保留 pending；awake/away 时 consume pending + emit 'orca/decision'（defer→no_action 翻译防循环；不调 defer handler 避免 re-defer 死循环）；scheduler 不修改 Decision/Attention/WorldState；不调 ActionHandler；不调 store.clear()（store 生命周期独立于 scheduler）；disposed=true 后 tick 短路。DeferredActionStore.consume(pendingId) 原子删除能力（同一 pendingId 只能被 consume 一次；consume 后从 store 消失）。R17 smoke 72 用例覆盖 busy/sleeping/awake/eligibility/consume/def→no_action 翻译/dispose race/store 生命周期/E2E plugin-level。
- **Phase 4.E（2026-08-27）**：Deferred Notification Aggregation——同 chatId 多条 pending 合并为单条 notify Decision（`groupPendingByChatId` / `createMergedDecision` / `composeMergedReason` 纯函数；merged.priority 取 group 最高；merged.reason = `你有 N 条待处理信息` + 每行 `- [source] priority: reason` + 超出 `MAX_MERGED_ITEMS=5` 时 `还有 X 条未展示`；ruleId=`deferred-merged`；merged 保留 first.eventId 供 NotifyHandler 反查 chatId）。单条 pending 保持原 Decision 语义；无 eventBus / 无法反查 chatId 的 entry 单独 emit（不误合并）；scheduler 不做 ruleId 去重（由 Attention 层负责）。R18 smoke 61 用例覆盖分组 / 文本格式 / priority 选择 / Decision 字段 / executeTick 合并路径 / E2E NotifyHandler 发送 / 循环防护。**未引入** ActionPlan / Decision metadata schema / 新 Action 类型 / Store API 变更。
- **Phase 5.1（2026-08-27）**：Episode Engine MVP——Short Memory 生成。`src/types/memory.ts`：新增 Episode 接口（id / category / kind / summary / ts / entities / sourceEventIds / importance / ttlDays / state）+ EpisodeQuery。`src/services/episodeEngine.ts`：`EpisodeEngine` 类 + `createEpisodeEngine` 工厂；纯规则（无 LLM）；Burst 检测（senderId session Map + 90s 窗口 + ≥3 触发）+ 状态转换摘要（transitionSummary + transitionImportance）。`src/plugins/episode-engine.ts`：`episodeEnginePlugin`；订阅 `orca/event` + `orca/state_changed`；返回 dispose 钩子。Episode 持久化：5 个 JSONL 文件（新增 episodes.jsonl）+ `appendEpisode`/`queryEpisodes`/`getTodayEpisodes`/`getRecentEpisodes`/`pruneExpiredEpisodes`；TTL 7 天自动 prune。`index.ts`：plugin 在 Runtime 之后装配。R20 smoke 45 用例覆盖 Episode CRUD + message.burst 生成/防重复 + state.transition 生成 + TTL prune + restart reload + today/recent/过滤查询。**未引入**：ReflectionService / MemoryCandidate 自动生成 / LongMemory promote / LLM 摘要。

- **Phase 5.2（2026-08-27）**：memory.remember / memory.forget ActionHandler。`src/services/action.ts`：新增 `createMemoryRememberHandler`（`Decision.reason` JSON → `upsertFact(source='user-explicit')`，upsert 语义同 Phase 5.0）和 `createMemoryForgetHandler`（`Decision.reason` JSON → `forgetByQuery`，forget operation 由 MemoryStore own and orchestrate；marker 创建与 fact purge 都在 MemoryStore 操作内完成；禁止 handler 直接调用 `createForgetMarker`）。**注意**：JSONL 不是数据库级 transaction，写入顺序固定为 `createForgetMarker → persistFact → rejectCandidates → appendAudit`，已尽量减少不一致窗口。`src/plugins/action-executor.ts`：注册两个 memory handler（依赖 `ctx.memory`）；`ctx.on('orca/decision')` 事件流驱动。R21 smoke 51 用例（H1~H14）覆盖 remember 创建/upsert/ActionResult + forget 删除/ForgetMarker幂等/audit隐私/restart持久化/not-found/批量删除/subjectPrefix + 集成 Decision→Executor→handler。**旧 `remember` handler（Phase 4.B）保留不变**，写入 `infoStore`（decision-action/decision-remember），与 Phase 5.2 的 `memory.remember` 路径并存。**未引入**：Reflection / Episode→Candidate / Candidate→LongMemory 自动 promote / LLM。
- **Phase 5.3（2026-08-27）**：Reflection Engine MVP——Episode → Candidate → LongMemory。`src/services/reflectionEngine.ts`：`createReflectionEngine` 工厂 + `ReflectionEngine` 实例；纯规则无 LLM。Rule A（Repeated Entity Burst）：同一 sender 在最近 30 条 Episode 中出现 ≥3 次 `message.burst` → candidate (type=`behavioral_pattern`, subject=sender, value=`high_burst_frequency`)。confidence 公式：count=3→0.70, count=4→0.75, count=5→0.80, count=6+→min(0.85+(count-6)*0.05, 0.95)。privacy gate：`isSubjectSuppressed(subject)`（subject-only；忽略 type）—— user-explicit fact 被 forget 后，Reflection 不复活该 subject。User-explicit 冲突：若已存在 user-explicit active fact for `(type, subject)`，candidate 被 `rejectCandidate('user-explicit-fact-exists')`。dedup：queryCandidates 返回的 non-expired candidate 视为已处理。`src/services/memoryStore.ts`：新增 `queryCandidates(q)` + `isSubjectSuppressed(subject)` API。`src/types/memory.ts`：FactType 新增 `behavioral_pattern` / `state_pattern`。`src/plugins/reflection-engine.ts`：plugin；提供 `ctx.reflection` service；仅手动 reflect（`reflectNow()` / `reflectRecent(n)`）。`index.ts`：plugin 在 EpisodeEngine 之后装配。R22 smoke 58 用例（R1~R12）覆盖 1/3+ Episode 行为 + confidence 公式 + evidenceEpisodeIds + promote + expire + ForgetMarker suppression（subject-only）+ privacy regression（forget→Episode→Reflection 不复活）+ duplicate promote 安全 + user-explicit 冲突 + restart 持久化。**未引入**：LLM / Episode→Candidate 自动 scheduler / Memory→Attention/Decision/WorldState。

- **Phase 5.3.1（2026-08-27）**：D-AGENT-18 Memory Contract Hardening——三个 contract 缺口收口，不重做 Memory 架构。**①CandidateQuery 正式纳入 contract**：`CandidateQuery{state?, type?, subject?, limit?}` 含 `limit`（默认 100，上限 1000，按 createdAt 降序截断）；`guide/orca-memory-design.md` §3.2 正式定义。**②isSubjectSuppressed 正式确认**：subject-level 抑制 API 与 type-scoped `isSuppressed(type, subject)` 并存；Reflection promotion 必须使用 subject-level；`guide/orca-memory-design.md` §3.5 + §4.6 正式定义；`guide/decisions.md` D-AGENT-18 §18-02 正式落定。**③User-explicit protection 下沉到 MemoryStore**：`MemoryStore.promoteCandidate()` 内部强制 invariant——若 `isSubjectSuppressed(subject)` 为 true 或已存在 user-explicit active fact for `(type, subject)`，则 candidate 被拒绝（state=rejected）；任何 future 调用 `promoteCandidate()` 的 subsystem 自动受到保护；ReflectionEngine 层 guard 仅作 early-exit 优化。**④Rule A 定位收敛**：Rule A 仅用于验证 Reflection pipeline 的 deterministic candidate generation，不作为成熟行为推断，不扩展为 personality inference。`src/services/memoryStore.ts`：promoteCandidate 内部新增 subject-level suppression gate + user-explicit 冲突检查。`src/types/memory.ts`：CandidateQuery 新增 `limit` 字段。`guide/orca-memory-design.md` 升级为 v1.2。`guide/decisions.md` 新增 D-AGENT-18。R23 smoke 44 用例（C1~C8）覆盖 queryCandidates(state/type/subject/limit) + subject-level suppression + forget subject→candidate type B→promote 被拒 + user-explicit fact→reflection candidate→MemoryStore.promoteCandidate 直接拒绝 + 绕过 ReflectionEngine guard 仍被 MemoryStore 拒绝 + 普通 reflection fact 正常 promote + restart 持久化 + 零回归。**未引入**：LLM / vector DB / embedding / new priority system / database abstraction / personality inference。

- **Phase 5.4.A（2026-08-27）**：MemoryAttentionAdapter 基础——Memory → Attention 的唯一桥接层（第一版 MVP）。`src/services/memoryAttentionAdapter.ts`：`createMemoryAttentionAdapter` 工厂 + `MemoryAttentionAdapter` 实例；轮询 MemoryStore 生成 `type='memory.insight'` 的 AttentionItems。`factToAttentionItem(fact)`：将 LongMemoryFact 映射为 AttentionItem；priority 从 confidence 计算（≥0.9=urgent, ≥0.8=high, ≥0.7=normal, else=low）；`action='remember_only'`；metadata 包含 `factId / memoryType / memorySource / confidence / createdAt / updatedAt`。去重：`seenFacts: Map<factId, updatedAt>`，同一 `updatedAt` 不重新生成。TopK 默认 5。`src/plugins/memory-attention-adapter.ts`：Cordis plugin；依赖 `ctx.memory`；通过 `ctx.emit('orca/attention', item)` 注入事件流；`disposed` 闸门。配置键：`ORCA_MEMORY_ATTENTION_ENABLED`（默认 true）/ `ORCA_MEMORY_ATTENTION_POLL_INTERVAL_MS`（默认 60000）/ `ORCA_MEMORY_ATTENTION_TOP_K`（默认 5）。`src/config.ts`：`OrcaMemoryConfig` 新增 `attentionEnabled` / `attentionPollIntervalMs` / `attentionTopK`。R24 smoke 36 用例（M1~M7）覆盖 active fact → AttentionItem 生成 / superseded 不生成 / forget 后不生成 / duplicate tick 去重 / confidence metadata 正确 / TopK 限制 / factToAttentionItem 单测。**未引入**：Memory type → AttentionItem action 映射（统一 remember_only）/ preference 直接触发 notify / 修改 EventBus / ReflectionEngine 参与。

- **Phase 5.4.B（2026-08-27）**：Memory Event Bridge——MemoryStore mutation event 驱动 MAA。`src/types/memory.ts`：`MemoryChangedEvent` 接口（`type: MemoryEventType` / `factId / subject / factType / timestamp / newFactId?`）+ `MemoryEventType` 枚举（`fact.created | fact.updated | fact.superseded | fact.merged | fact.forgotten`）+ `OrcaMemoryConfig.eventEmitter` 可选注入。`src/services/memoryStore.ts`：4 个 mutation 函数均 emit 相应事件（`upsertFact` → created/updated；`supersedeFact` → created+superseded；`mergeFacts` → merged×n+updated；`forgetFact` → forgotten）。`src/index.ts`：MemoryStore 构造时传入 `eventEmitter: (e) => ctx.emit('memory_changed', e)`。`src/services/memoryAttentionAdapter.ts`：`onMemoryChanged(event)` 处理函数；invalidate 类型（superseded/merged/forgotten）直接删除 `seenFacts`；create/update 类型异步查询当前 fact 状态并 emit AttentionItem；`MemoryAttentionAdapter` 接口新增 `onMemoryChanged`。`src/plugins/memory-attention-adapter.ts`：`ctx.on('memory_changed', ...)` 订阅并转发给 adapter；dispose 时 unsubscribe。R25 smoke 39 用例（EB1~EB7）覆盖 event → AttentionItem 生成 / update 刷新 / forget 消失 / supersede 旧fact失效 / dedup 正确性 / merge 失效 / payload 完整性。**未引入**：Memory 直接产生 Action / 修改 AttentionEngine/DecisionEngine/WorldState / 新存储。

- **Phase 6.A（2026-09-06）**：CEO ContextAssembler——`src/types/context.ts` + `src/services/contextAssembler.ts` + `src/plugins/context-assembler.ts`（后者未单独实现，逻辑直接内联在 index.ts）。`ContextAssembler` 是 CEO 访问 Memory/InfoRecords 的唯一入口（不经 MemoryStore 直接查询）；`assemble(input, worldState, options?)` → `ContextAssemblyResult`（四维度 context + formatted summary）。Memory 查询：subject 精确匹配 → type 过滤 → 全局三优先级；Top-K=10（可配置）；per-fact value ≤ 80 字符（可配置）；R3 总计 ≤ 500 字符 budget；排序 confidence↓ then updatedAt↓。格式化：`[Memory:{type}] {subject}: {value} (confidence {confidence})`。`src/config.ts`：新增 `OrcaContextAssemblerConfig` 接口 + `OrcaConfig.contextAssembler`；环境变量 `ORCA_MEMORY_CONTEXT_ENABLED`（默认 1）/ `ORCA_MEMORY_CONTEXT_TOP_K`（默认 10）/ `ORCA_MEMORY_CONTEXT_PER_FACT_CHARS`（默认 80）/ `ORCA_MEMORY_CONTEXT_BUDGET_CHARS`（默认 500）/ `ORCA_MEMORY_CONTEXT_INFO_RECORDS_LIMIT`（默认 3）。`src/context.ts`：新增 `contextAssembler: ContextAssembler` 到 Context 接口声明。`src/index.ts`：装配在 MemoryStore 之后，依赖 `ctx.memory` + `ctx.infoStore`。R26 smoke 38 用例（CA1~CA12）覆盖基本 assembly / 格式化 / budget / per-fact 截断 / Top-K / 空数据 / subject 过滤 / type 过滤 / budgetHit flag / disabled 模式 / 排序。**未引入**：MemoryCache（Phase 6.B）/ scoring interface / 修改 AttentionEngine / DecisionEngine / WorldState。**380/380 smoke PASS（Phase 5.4.B 342 + Phase 6.A 38）**。

- **Phase 6.B（2026-09-06）**：CEO Context Integration——`src/plugins/agent.ts`：在 feishu/message + dashboard/message 两个入口处接入 `ctx.contextAssembler`，在 `persona + archive.context` 之后追加【长期记忆】区块。CEO context 构造路径（已确认在 `src/plugins/agent.ts` 第 109 行）：`personaPrompt() + archive.context + memoryContext`，其中 `memoryContext` = `ctx.contextAssembler.assemble(userInput, worldState)` 的 memoryFacts 格式化字符串拼接。`agent.inject` 扩展为 `['feishu', 'llm', 'sessions', 'infoAgents', 'infoStore', 'eventBus', 'worldState', 'contextAssembler']`。Memory disabled 或 contextAssembler 不可用时 graceful degradation：memoryContext 为空字符串，不影响主流程（CE3/CE4）。infoRecords 注入（R2）完全保留，向后兼容（CE5）。WorldState snapshot 通过 `ctx.worldState.getState()` 透传到 `assemble()`（CE9）。R27 smoke 29 用例（CE1~CE9）覆盖 assemble 格式化 / 空 facts / disabled / infoRecords 兼容 / summary 分层 / CEO prompt 格式 / confidence 排序 / worldState 透传。**未修改**：AttentionEngine / DecisionEngine / MemoryStore 核心语义 / 其他 Agent 行为。**409/409 smoke PASS（Phase 5.4.B 342 + Phase 6.A 38 + Phase 6.B 29）**。

- **Phase 6.C.1（2026-09-06）**：Memory Quality Layer 实现——Scoring Interface + L2 Source Conflict Resolution。`src/types/context.ts`：`ScoringFunction` 类型 + `ScoringPreset = 'confidence' | 'source-confidence'` + `getScoringFunction(preset)` + `scoreByConfidence` + `scoreBySourceConfidence`（user-explicit +0.2 bonus）。`ContextAssemblerConfig` 新增 `scoringPreset` 字段。`src/services/contextAssembler.ts`：`resolveL2SourceConflict()` 实现（按 type+subject 分组，user-explicit 优先），queryMemory 流程改为 query→L2 filter→scoring sort→format→budget cap。`ContextAssemblyResult` 新增 `sourceConflictsFiltered`。Config 新增 `ORCA_MEMORY_SCORING_PRESET`（默认 'confidence'）。**重要约束**：MemoryStore `upsertFact` 同 (type, subject) 第二次 upsert update-in-place（不保留两个 active facts），因此同组多 source 冲突无法在 active facts 中直接构造；L2 filter 逻辑已实现但此场景依赖 MemoryStore 未来支持。Q1~Q8 smoke 18 用例。**427/427 smoke PASS（Phase 6.C.1 18 + 之前 409）**。

- **Phase 6.C.2（2026-09-06）**：L3 Semantic Conflict Detection 实现 + Review 修复。`src/types/context.ts`：`SemanticConflict` 接口 + `detectSemanticConflicts()`（**修复后规则：同 subject + 同 type + ≥2 条 facts + formatted value 不同 = conflict candidate**；相同 formatted value 不是冲突）。`ContextAssemblyResult` 新增 `semanticConflicts: SemanticConflict[]`。`ContextAssemblerConfig` 新增 `detectSemanticConflict: boolean`（默认 false）。`contextAssembler.ts`：assemble 流程增加 semantic conflict detection（L2 filter 之后、scoring 之前）；`buildSummary` 增加 `## Memory Conflict Warnings` section 输出。Config 新增 `ORCA_MEMORY_CONFLICT_DETECT_SEMANTIC` 环境变量（默认 '0'）。**不自动过滤**，只标记 ⚠️。C1~C9 smoke 27 用例（含同 value 不冲突测试）。**重要约束**：MemoryStore `upsertFact` 同 (type, subject) 保留第一次 id 但用第二次的值覆盖，导致同组多 source 场景无法构造两个 active facts；`detectSemanticConflicts()` 逻辑已正确实现，依赖 MemoryStore 未来支持方可覆盖 same-subject+type 多 fact 场景。**454/454 smoke PASS（Phase 6.C.2 27 + 之前 427）**。

- **Phase 6.C.3（2026-09-06）**：MemoryUsageTracker 实现。`src/services/memoryUsageTracker.ts`：**新增** —— `createMemoryUsageTracker(config)` 返回 `MemoryUsageTracker` 接口；in-memory ring buffer（默认容量 100，可配置）；`record(record: MemoryUsageRecord)` 和 `getRecords()` API；`enabled=false` 时零开销。`src/services/contextAssembler.ts`：新增可选参数 `memoryUsageTracker?: MemoryUsageTracker`；`assemble()` 成功后记录 `MemoryUsageRecord`（**隐私保护：query 只记录长度，不记录内容**）。`MemoryUsageRecord`：timestamp / queryLength / returnedFactIds / conflictFilteredIds / semanticConflictCount / charsUsed / budgetHit / scoringPreset / semanticDetectionEnabled。**不写 JSONL / 不持久化 / 不进入 MemoryStore / 不产生 mutation**。U1~U10 smoke 31 用例。**485/485 smoke PASS（新增 31 + 之前 454）**。

- **Phase 6.C Closeout（2026-09-06）**：完整 Phase 6.C（6.C.1 + 6.C.2 + 6.C.3）正式完成。**485/485 smoke PASS；E1-E9 evaluation 77/81（4 项为设计约束）；无 P0/P1 问题。** D-AGENT-21 §21-07 新增 Phase 6.C implementation closeout，记录已验证 invariant / known limitations / architecture boundary。详见 `guide/decisions.md` D-AGENT-21 §21-07。

- **Phase 7.1A（GPT Review Phase 7.0）**：WorldState 架构重构——RuntimeAdapter 统一接口 + EventBus 唯一状态入口 + Scheduler 收敛为纯 Time Producer。**GPT Review 核心修正**：否决 `WorldStateExtensionAdapter.poll() → applyUpdate()` 模式；保持 EventBus 是唯一状态来源；WorldState 必须始终是 Pure Reducer + Snapshot。

- **Phase 7.1A Review 修正（2026-09-08）**：Scheduler Adapter 只 emit `scheduler:tick`；删除全部 4 个 scheduler reducers（`scheduler:tick` 等不产生持久状态变化）；删除 `scheduler:briefing:due/reflection:due/reminder:due` timer。

- **Phase 7.1B（2026-09-08）**：ScheduledRuleRegistry——最小主动行为闭环。`src/types/scheduled-rule.ts`：`ScheduledRule`/`ScheduledRuleContext`/`ScheduledRulePredicate`/`ScheduledBusinessEvent` 接口。`src/services/scheduledRuleRegistry.ts`：`createScheduledRuleRegistry()` + `ScheduledRuleRegistryService`。`src/plugins/scheduled-rule-registry.ts`：`scheduledRuleRegistry` Cordis plugin + `TEST_RULE_ALWAYS_TRIGGER`。**事件流向**：SchedulerAdapter → scheduler:tick → ScheduledRuleRegistry → predicate → EventBus.publish(businessEvent) → AttentionEngine。**26/26 smoke PASS**。

**Phase 7.1A Review 修正（Scheduler 收敛为纯 Time Producer）**：
- Scheduler Adapter **只** emit `scheduler:tick`（纯时间信号）
- 删除 `scheduler:briefing:due` / `scheduler:reflection:due` / `scheduler:reminder:due`（这些属于 ScheduledRuleRegistry，7.1B）
- 删除全部 4 个 scheduler reducers（`scheduler:tick` 等不产生持久状态变化）
- WorldStateUpdater 继续订阅全部事件，允许"无 reducer → 忽略"

**新增文件**：
- `src/types/runtime-adapter.ts`：`RuntimeAdapter` 接口（`{ start(), stop() }`）+ `RuntimeAdapterConfig`
- `src/plugins/input-adapters/scheduler-adapter.ts`：`createSchedulerAdapter()` + `schedulerAdapter()`；**仅 emit `scheduler:tick`**（纯 Time Producer）

**重构文件**：
- `src/plugins/input-adapters/pc-adapter.ts`：实现 `RuntimeAdapter` 接口
- `src/plugins/input-adapters/calendar-adapter.ts`：实现 `RuntimeAdapter` 接口
- `src/plugins/input-adapters/phone-adapter.ts`：实现 `RuntimeAdapter` 接口
- `src/types/event.ts`：新增 `scheduler` source + 事件类型（`scheduler:tick` / `scheduler:briefing:due` / `scheduler:reflection:due` / `scheduler:reminder:due`；为 7.1B 准备）
- `src/services/worldState.ts`：删除全部 scheduler reducers（Phase 7.1A Review）
- `src/config.ts`：`OrcaSchedulerConfig` 简化为仅含 `enabled` + `tickMs`
- `src/index.ts`：RuntimeAdapters 统一生命周期管理 + shutdown 时调用 `stop()`

**架构图（Phase 7.1A）**：
```
RuntimeAdapter (Scheduler / Calendar / PC / Weather)
        ↓
EventBus.publish({source:'scheduler', type:'scheduler:tick', ...})
        ↓
WorldStateUpdater（Reducer 模式）
        ↓
WorldState（Pure Snapshot）
        ↓
AttentionEngine

注：scheduler:briefing:due / reflection:due / reminder:due 由 ScheduledRuleRegistry（7.1B）订阅 scheduler:tick 后决策触发
```

**两条必须保持的架构边界**：
1. **EventBus 是唯一状态入口**：WorldState 永远不主动 polling，只消费 Event 并计算 Snapshot
2. **RuntimeAdapter 统一接口**：`{ start(), stop() }`；所有数据源必须通过 EventBus 发射事件，不直接修改 WorldState

**为什么 Rule 不属于 Adapter**：
- Adapter 职责：**数据获取 + 格式化**（读取数据源 → 发射 Event）
- Rule 职责：**条件判断 + 决策**（订阅 Event → 判断是否触发 Action）
- 分离好处：Adapter 可复用（同一数据源可被不同 Rule 使用）；Rule 可组合（同一 Event 可触发多个 Rule）
- Scheduler 是"纯 Time Producer"，不承载业务逻辑；业务逻辑由 ScheduledRuleRegistry（7.1B）负责

**配置键（Phase 7.1A）**：
| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `ORCA_SCHEDULER_ENABLED` | 0 | Scheduler adapter 开关 |
| `ORCA_SCHEDULER_TICK_MS` | 60000 | tick 心跳间隔 |

**未修改**：Memory / Attention / Decision / Action / EpisodeEngine / ReflectionEngine（按 GPT Review 要求）。

- **Phase 7.1B（2026-09-08）**：ScheduledRuleRegistry——最小主动行为闭环（scheduler:tick → Rule predicate → briefing:due → AttentionEngine）。

**Phase 7.1B 设计目标**：
- 验证 `scheduler:tick → rule hit → business event` 闭环
- Registry 是"业务规则层"，不持有 timer（timer 在 SchedulerAdapter）
- businessEvent 通过 EventBus.publish() 发射，进入现有流水线：EventBus → WorldStateUpdater（无 reducer → 忽略）→ AttentionEngine
- 不直接调用 AttentionEngine / DecisionEngine / ActionExecutor

**新增文件**：
- `src/types/scheduled-rule.ts`：`ScheduledRule` / `ScheduledRuleContext` / `ScheduledRulePredicate` / `ScheduledBusinessEvent` 接口
- `src/services/scheduledRuleRegistry.ts`：`createScheduledRuleRegistry()` + `ScheduledRuleRegistryService` 接口
- `src/plugins/scheduled-rule-registry.ts`：`scheduledRuleRegistry` Cordis plugin + `TEST_RULE_ALWAYS_TRIGGER`（验证用）
- `src/rules/scheduled/briefing.ts`：`createBriefingIntervalRule()` —— 第一个 deterministic rule（基于 lastTriggeredAt 间隔判断）
- `src/rules/scheduled/reflection.ts`：`createReflectionIntervalRule()` —— 第二个 deterministic rule（API/语义与 BriefingIntervalRule 完全一致）
- `src/rules/scheduled/reminder.ts`：`createReminderIntervalRule()` —— 第三个 deterministic rule（API/语义与前两个完全一致）
- `scripts/smoke-scheduled-rule-registry.mjs`：26 个用例覆盖 R1-R7（全部通过）
- `scripts/smoke-briefing-rule.mjs`：14 个用例覆盖 R1-R4（全部通过）
- `scripts/smoke-reflection-rule.mjs`：14 个用例覆盖 R1-R4（全部通过）
- `scripts/smoke-reminder-rule.mjs`：19 个用例覆盖 R1-R5（含三 Rule 共存互不影响验证，全部通过）

**ScheduledRule API**：
```typescript
// 业务事件定义
interface ScheduledBusinessEvent {
  source: OrcaEventSource        // e.g. 'scheduler'
  type: OrcaEventType            // e.g. 'briefing:due'（不含 source 前缀）
  data?: Record<string, unknown> // payload
  priority?: number              // 默认 1
}

// predicate 上下文
interface ScheduledRuleContext {
  tick: OrcaEvent                // 当前 scheduler:tick 事件
  lastTriggeredAt: number        // 上次触发时间戳（毫秒），0=从未触发
}

// predicate 类型
type ScheduledRulePredicate = (ctx: ScheduledRuleContext) => boolean

// 规则定义
interface ScheduledRule {
  readonly ruleId: string
  readonly predicate: ScheduledRulePredicate  // 判断是否触发
  readonly businessEvent: ScheduledBusinessEvent  // 命中时发射
}

// Registry API
interface ScheduledRuleRegistry {
  register(rule: ScheduledRule): void
  unregister(ruleId: string): boolean
  size(): number
  ruleIds(): string[]
}
```

**事件流向（Phase 7.1B）**：
```
SchedulerAdapter → scheduler:tick → ScheduledRuleRegistry
                                      ↓
                              predicate 判断
                                      ↓
                              EventBus.publish(businessEvent)
                                      ↓
                              WorldStateUpdater（无 reducer → 忽略）
                                      ↓
                              AttentionEngine（businessEvent 触发评估）
```

**第一版 test rule**：
- `test-rule-always-trigger`：predicate 始终返回 `true`，每 tick 都触发 `briefing:due`（source='scheduler', type='briefing:due'）
- 用于验证 `scheduler:tick → rule hit → briefing:due` 最小闭环

**第一个 deterministic rule**：
- `createBriefingIntervalRule(ruleId, briefingIntervalMs)`：基于 lastTriggeredAt 间隔判断
- `lastTriggeredAt === 0`（从未触发）→ 立即触发
- `elapsed >= briefingIntervalMs` → 触发
- `elapsed < briefingIntervalMs` → 不触发
- 不生成 briefing 内容，不调用 LLM，只判断"是否到触发时间"

**第二个 deterministic rule**：
- `createReflectionIntervalRule(ruleId, reflectionIntervalMs)`：API/语义与 BriefingIntervalRule 完全一致
- predicate 逻辑相同，businessEvent 为 `reflection:due`（source='scheduler', type='reflection:due'）
- 不生成 reflection 内容，不调用 ReflectionEngine，只判断"是否到反思时间"

**smoke 覆盖（26/26 + 14/14 + 14/14 + 19/19 = 73/73 PASS）**：
- R1：register / unregister / size / ruleIds 纯函数
- R2：predicate 命中 → emit business event
- R3：predicate 不命中 → 不 emit
- R4：多 rule 独立注册/评估
- R5：lastTriggeredAt 上下文正确
- R6：plugin 集成（scheduler:tick → evaluate → business event）
- R7：多个 tick 连续触发（3 tick → 3 business event）

**架构边界（Phase 7.1B）**：
1. Registry 不持有 timer（timer 在 SchedulerAdapter）
2. businessEvent 通过 EventBus 发射，不直接调用 AttentionEngine
3. predicate 异常被 try/catch 捕获，不崩进程
4. Rule 注销同步清理 lastTriggeredAt

**未实现（Phase 7.1B 范围外）**：
- Morning Briefing / Reflection / Reminder 等具体业务规则
- LLM-based scheduling
- External Services Gateway

---

## Phase 7.1 Architecture Freeze Review Report（2026-09-08）

### 架构边界确认

| 边界 | 状态 | 验证 |
|------|------|------|
| **EventBus 单一事件入口** | ✅ 确认 | 所有 Adapter 仅通过 `bus.publish()` 发射事件；`applyUpdate` 仅由 `world-state-updater.ts` 内部调用 |
| **WorldState 纯 Reducer** | ✅ 确认 | 无 polling / 无外部 `applyUpdate` 调用；所有写路径通过 `EventBus.subscribe` → `applyReducers` |
| **SchedulerAdapter 纯 Time Producer** | ✅ 确认 | 仅 `bus.publish({ type: 'scheduler:tick' })`，无业务逻辑 |
| **ScheduledRuleRegistry 无 timer** | ✅ 确认 | 仅订阅 `scheduler:tick`，`evaluate` 在内存中计算间隔 |
| **Rule 无副作用** | ✅ 确认 | `briefing/reflection/reminder` rules 仅调用 `bus.publish()`，不调用 Attention / Decision / Action |
| **Memory 单一职责** | ✅ 确认 | `MemoryStore` 是唯一长期记忆源；`ContextAssembler` 只读；`MemoryAttentionAdapter` 是唯一 Memory→Attention 路径 |

### 隐藏耦合检查

| 检查项 | 结果 |
|--------|------|
| Scheduler 依赖 Attention | ✅ 无 |
| Rule 依赖 Decision / Action | ✅ 无 |
| Attention 依赖具体业务 Rule | ✅ 无 |
| WorldState 被非 EventBus 路径修改 | ✅ 无 |
| Plugin 生命周期资源泄漏 | ✅ 无（所有 plugin 在 dispose 时 unsubscribe / clearInterval） |
| `scheduledRuleRegistry` 未注册到 `index.ts` | ⚠️ **已修复**——新增注册到 `index.ts`（Runtime enabled 时自动加载） |

### Review 修复的问题

| 问题 | 类型 | 处理 |
|------|------|------|
| `index.ts` 第 96-97 行 `imageRouter` 重复注册 | **真 bug**（复制粘贴错误） | 已删除重复行 |
| `scheduledRuleRegistry` plugin 未注册到 `index.ts` | **架构缺口**（Phase 7.1B smoke 通过但生产不加载） | 已添加 `ctx.plugin(scheduledRuleRegistry)` |

### 当前 Runtime 数据流

```
外部信号（飞书/传感器/手动）
    ↓
EventBus.publish()
    ↓
┌──────────────────────────────────────┐
│ WorldStateUpdater（Reducer 模式）      │
│  - feishu:message → user.lastSeenAt │
│  - 其他事件 → 无 reducer → 忽略      │
└──────────────────────────────────────┘
    ↓
WorldState（Pure Snapshot）
    ↓
AttentionEngine（全量事件订阅）
    ↓
DecisionEngine（订阅 orca/attention）
    ↓
ActionExecutor（订阅 orca/decision；默认 disabled）
```

### Scheduler 数据流

```
SchedulerAdapter（setInterval）
    ↓
EventBus.publish({ type: 'scheduler:tick' })
    ↓
ScheduledRuleRegistry（订阅 scheduler:tick）
    ↓
createBriefingIntervalRule / createReflectionIntervalRule / createReminderIntervalRule
    ↓
EventBus.publish({ type: 'briefing:due' / 'reflection:due' / 'reminder:due' })
    ↓
WorldStateUpdater（无 reducer → 忽略）
    ↓
AttentionEngine（business event 进入评估）
```

### 当前已支持能力

| 能力 | 状态 |
|------|------|
| RuntimeAdapter 统一接口（`{ start(), stop() }`） | ✅ |
| EventBus 单一事件入口 | ✅ |
| WorldState 纯 Reducer + Snapshot | ✅ |
| SchedulerAdapter 纯 Time Producer（`scheduler:tick`） | ✅ |
| ScheduledRuleRegistry（规则层） | ✅ |
| BriefingIntervalRule（deterministic，interval 判断） | ✅ |
| ReflectionIntervalRule（deterministic，interval 判断） | ✅ |
| ReminderIntervalRule（deterministic，interval 判断） | ✅ |
| 多 Rule 共存（互不影响，独立 lastTriggeredAt） | ✅ |

### Phase 7.1 正式关闭状态

- **Phase 7.1A**：RuntimeAdapter + SchedulerAdapter + WorldState 边界 ✅
- **Phase 7.1B**：ScheduledRuleRegistry + 3 个 deterministic Rules ✅

### 推荐下一阶段方向

1. **Phase 7.2：Rule 注册系统**——当前 rules 由 smoke test 手动 `registry.register()`，生产需要配置驱动的注册机制（`ORCA_SCHEDULER_BRIEFING_INTERVAL_MS` 等环境变量）
2. **Phase 7.3：Morning Briefing 业务闭环**——`briefing:due` → Decision → Action → Feishu 推送（不修改现有架构，只注册新 rule）
3. **Phase 7.4：Reflection / Reminder 业务闭环**（同 7.3 模式）

### 不进入 Phase 7.2 的边界（Architecture Freeze）

以下功能在 Phase 7.1 架构完全冻结后作为独立业务层叠加，不修改 Runtime 基础架构：

- Morning Briefing 完整业务逻辑
- ReflectionEngine 调度
- Reminder 系统
- Calendar / Weather 集成
- Session Persistence
- Vector DB / Tool Calling
- External Services Gateway

#### Phase 6 Memory 架构边界（Phase 6.C 完成后快照）

```
写入路径：
  ReflectionEngine → MemoryStore.promoteCandidate()
  remember action → MemoryStore.upsertFact()（user-explicit source）
  forget action → MemoryStore.forgetFact() + ForgetMarker

读取路径（CEO）：
  MemoryStore.queryFacts({state:'active'})
      ↓
  ContextAssembler（query → L2 filter → L3 detection → scoring → format → budget cap）
      ↓
  CEO Context（memoryFacts[] + semanticConflicts[] + summary string）

Memory → Attention（唯一路径）：
  MemoryStore
      ↓
  MemoryAttentionAdapter（polling）
      ↓
  AttentionItem → EventBus → AttentionEngine → DecisionEngine → ActionExecutor
```

**关键 invariant（Phase 6.C 验证保证）**：
1. **Forget safety**：forget 后 fact 不出现在 `queryFacts({state:'active'})` 和 ContextAssembler output
2. **MemoryStore authority**：LongMemoryFact 唯一来源是 MemoryStore，ContextAssembler 只读
3. **L2/L3 隔离**：冲突处理在 ContextAssembler，不修改 MemoryStore，不产生 mutation
4. **Scoring deterministic**：相同输入产生相同输出
5. **Privacy**：MemoryUsageTracker 只记录 `queryLength: number`，不记录文本
6. **Budget enforcement**：`charsUsed <= memoryBudgetChars`，`perFactChars` 限制每条长度
7. **Graceful degradation**：memory disabled 时 `memoryFacts=[]`，不影响其他 context 维度

**Known Limitation（MemoryStore contract）**：
- `upsertFact` 同 (type, subject) 保留第一次 source（不可变）
- 同 (type, subject) 第二次 upsert 保留第一次 id，更新 value/confidence
- 因此无法在 active facts 中保留"同 subject+type + 不同 source 两个 facts"
- L2/L3 逻辑正确，依赖 MemoryStore 未来支持方可覆盖上述场景

### 8.2 待办（TODO.md）
- **Phase 6 设计稿（2026-08-27）**：Memory-aware CEO Context——`guide/orca-memory-consumption-design.md` §12 + D-AGENT-20。CEO Context 四元组：input / worldState / info / memory；R3 层注入 memoryFacts，按 subject 匹配 → type 过滤 → 全局查询三优先级；Top-K=10，字符限制每条 ≤ 80 / R3 总计 ≤ 500；Token 预算 500 token 固定配额。**Phase 6.A（ContextAssembler）已实现（见 Phase 6.A 条目）**。**Phase 6.B：MemoryCache（TTL 5 分钟，`memory_changed` 事件失效）未实现**。
- **Phase 4.F**：ActionPlan 拆分（payload / channel / target）；真实 act handler（最小权限 + 白名单校验）；支持 bark / 邮件等其他通知渠道（NotifyHandler 按 event.source 分支扩展）；urgency=2 推送门控
- 迁移 search_web / capture_screenshot / analyze_image 为 InfoAgent（Pull）
- 会话持久化（jsonl）；独立飞书 bot 的 app_id 路由（远期）
- 飞书事件订阅加密模式支持（技术债）

### 8.3 关键架构约束（Phase 3.A + Phase 4.A + Phase 4.B + Phase 4.D + Phase 4.E + Phase 5.0 确定，Attention/Decision/Action/Memory 必读）
- **Attention Rule predicate 判断"事件发生前状态"必须用 `prevState`**；`state` 是事件处理后（reducer 已应用）的世界。
- 错误示范：`predicate: ({ state }) => state.user.status === 'away'`（reducer 改 awake 后永远不触发）；正确：`predicate: ({ prevState }) => prevState?.user.status === 'away'`。
- `prevState` 在 state-only 触发时为 `undefined`；event 触发时由 `ws.getPrevState()` 提供。
- 三层职责分离：Engine（是什么）→ Dedup（多不多）→ Throttle（该不该打扰）；throttle 仅限 notify_immediately + act，remember_only/ignore/wait_until_available 直通。
- **AttentionRuleRegistry（Phase 3.B.rule-registry）**：Engine 与规则**解耦**。AttentionRuleRegistry 接口：`register / unregister / getRules / getAllRules / setEnabled / isEnabled / size / clear`。`getRules()` 仅返回启用规则（按注册顺序）；同 id 重复 register 覆盖并保留原位置（热更新）。`createAttentionEngine(registry?)` 不传参使用 `getDefaultRegistry()`（包含 5 条内置规则；行为等同 Phase 3.A）。向后兼容：`registerRule / clearRules / ruleRegistrySize` 委托 defaultRegistry（R8/R9/R10 测试零改动）。
- **AttentionRuleConfigLoader（Phase 3.B.rule-config）**：JSON 配置加载器，**只表达 enabled 状态**，不创建 predicate/expression（防 DSL 倾向）。`{rules: {ruleId: {enabled: bool}}}` 格式；**严格白名单**只解析 `enabled` 字段；未知字段（predicate / expression 等）直接报错（fail-fast）。`unknown ruleId` 抛错（防静默错误）。Loader 接受 registry 参数，**不污染** `getDefaultRegistry()`。**仅支持 JSON**（项目无 YAML 依赖；YAML 为后续扩展）。**禁止**：DSL / 表达式 / JavaScript 注入 / LLM rule generation / 持久化 / 加载内置 5 条规则（这些必须由 TypeScript 代码 register）。`createRuleConfigLoader()` 工厂返回 `{ parse(jsonText), load(config, registry) }`。R12 smoke 28 用例覆盖空配置 / disable / re-enable / 未知 id / JSON 错误 / 结构错误 / 拒绝未知字段 / 独立 Registry / 默认 Registry 兼容性。
- **AttentionItem.id（Phase 4.A 引入）**：每个 AttentionItem 生成时分配 `randomUUID()`；用于 Decision `attentionId` back-trace；不影响 Phase 3 测试（R8/R9/R10/R11/R12 零改动）。
- **DecisionEngine（Phase 4.A 纯决策层）**：严格分层不重新判断 Attention 规则；输入 AttentionItem → 输出 Decision（1:1 映射）；`decide()` / `decideMany()` 是**纯函数**，无 IO / 无 service 调用 / 无副作用 / 不发飞书 / 不写 infoStore / 不调 LLM / 不执行 shell。Action 映射：`notify_immediately→notify`、`remember_only→remember`、`wait_until_available→defer`、`act→act`、`ignore→no_action`；未知 AttentionAction 透传原值（fail-soft）。透传字段：priority / reason / eventId / source / ruleId。不重排 priority / 不排序 / 不持久化。`createDecisionEngine()` 工厂返回 `{ decide, decideMany }`。
- **DecisionEnginePlugin（Phase 4.A Cordis integration）**：订阅 `ctx.on('orca/attention')` → `engine.decide(item)` → `ctx.emit('orca/decision')`。**不阻塞**原始 Attention publisher（ctx.on 是 listener；不影响 emit）；listener try/catch（handler 异常不崩其他 listener）；无 inject 依赖（DecisionEngine 是纯函数）。挂载顺序：**必须在 AttentionEngine 之后**（依赖 `orca/attention` emit；index.ts 已按顺序装配）。
- **ActionExecutor（Phase 4.B 执行层）**：严格分层不重新评估 Decision / Attention / WorldState；输入 Decision → 输出 ActionResult（1:1）。`execute(decision)` 是异步（Promise）但**严格不抛异常给 caller**：handler 异常被内部 catch 转化为 success=false ActionResult。ActionHandlerRegistry 接口：`register / unregister / get / list / size / clear`；同 action 重复 register 覆盖（Last-Write-Wins）。**关键安全约束**：act handler 默认 stub（`act-stub`），禁止任意 shell / JS / 插件调用；未配置 handler 时 success=false + 明确 error；不提供 fake shell executor。`createActionExecutor({ registry?, deferredStore? })` 工厂返回 `{ execute, registry, deferredStore }`。DeferredActionStore 接口：`enqueue / get / list / size / clear / consume`；Phase 4.D 新增 `consume(pendingId): boolean` 原子删除能力。
- **deferredScheduler（Phase 4.D 调度层）**：新建 Cordis plugin（`plugins/deferred-scheduler.ts`）。30s tick 一次（硬编码；不暴露配置键）。挂载顺序：必须在 actionExecutor 之后（依赖 `ctx.actionExecutor.deferredStore`）。Tick 流程：读 `ctx.worldState.getState().user.status` → 若 `busy` 或 `sleeping` 则跳过 → 否则遍历 `store.list()` → 对每个 entry 先 `store.consume(pendingId)` 再 emit 'orca/decision'。**关键约束**：scheduler **不直接调 ActionHandler**；**不调 DecisionEngine.decideMany**（store 中只有 Decision，无 AttentionItem 无法重新评估）；**不调 store.clear()**（store 生命周期独立于 scheduler）。`executeTick(store, worldState, emit, isDisposed)` 是 module-level 纯函数（独立可测）。disposed=true 后 tick 短路（Phase 4.B Review dispose race 防护模式）。
- **defer→no_action 翻译（防循环）**：scheduler 消费 defer pending 时，将 `decision.action` 从 `'defer'` 改为 `'no_action'` 再 emit。理由：defer handler 接收 action='defer' 的 Decision 会再次入队，形成 scheduler → defer → scheduler 死循环；翻译为 no_action 后走 noopHandler.execute（noop；不入队），循环彻底断裂。这是 Phase 4.D 第一版对"合并通知"语义的设计空白占位——真正的合并通知留待 Phase 4.E。
- **ActionExecutorPlugin（Phase 4.B + Phase 4.C Cordis integration）**：订阅 `ctx.on('orca/decision')` → `executor.execute(decision)` → `ctx.emit('orca/action-result')`。**不阻塞**原始 Decision publisher（ctx.on 是 listener；不影响 emit）；listener try/catch + Promise.catch 双重兜底（即使 handler 抛错也不崩服务）；**disposed 闸门**（Phase 4.B Review）：plugin dispose 后 in-flight execute 完成时不再 emit / 不再 logger.warn。`ctx.actionExecutor` service 暴露 executor。remember handler 通过 `ctx.get('infoStore')` 软注入（infoAgents plugin 未挂载时跳过 remember handler 注册，其他 handler 不受影响）。notify handler 通过 `ctx.get('feishu') + ctx.get('eventBus')` 软注入（任一缺失则保留 notify-stub）。挂载顺序：**必须在 DecisionEngine 之后**（依赖 `orca/decision` emit；index.ts 已按顺序装配）。
- **EventBus.get(id)**（Phase 4.C 最小增量）：按 id 反查 sliding window 中的事件（O(n) 线性扫描；找不到返回 undefined）。仅作用于现有 sliding window（不改 windowSize；不持久化；超 windowSize 的最老事件已被丢弃 → 返回 undefined）。**不**把 EventBus 改造成永久事件数据库。
- **NotifyHandler（Phase 4.C Orca 第一个真实 Action）**：Feishu-aware（持有 FeishuClient 依赖）；Decision / Attention / DecisionEngine 不感知 Feishu。输入 Decision → 顺序判断：eventId undefined / eventBus.get 找不到 / source !== 'feishu' / FeishuEventData type guard 失败 → 全部 success=false + 明确 error（绝不伪装成功）。dryRun=true → 仅日志不发送；dryRun=false → feishu.sendToChat。文本格式：`[Orca] ${priority}\n${reason}\n\n源消息: ${text.slice(0,200)}`（第一版最小化；不引入模板系统 / 卡片 DSL / i18n / LLM 生成）。`createNotifyHandler({ feishu, eventBus, dryRun, logger? })` 工厂。
- **ORCA_ACTION_ENABLED 默认 false**（用户决策：act handler 暂无显式注册时不应执行任何副作用；启用前应明确注册 handler）。
- **MemoryStore 是 LongMemory 的唯一 mutation authority（Phase 5.0）**：Reflection 永远不直接修改 JSONL 或 in-memory LongMemoryFact 对象；所有写必须经过 MemoryStore API。`upsertFact` identity = (type, subject)，同 identity 原地更新保持原 id。`forgetFact` **owned by MemoryStore**：forget operation 是 MemoryStore 内部编排，marker 创建与 fact purge 在 MemoryStore 操作内按固定顺序完成（JSONL 非数据库 transaction；写入顺序已尽量减少不一致窗口）。
- **ForgetMarker fingerprint salt 必须稳定**：`ORCA_MEMORY_SALT` 必须跨进程重启保持不变；随机 salt 导致 restart 后 fingerprint 不一致，ForgetMarker 无法 suppress 新事实。
- **AuditEvent 不保存 prevValue / newValue（v1.1）**：仅通过 `changedFields[]` 表达字段变化；`forgotten` kind 的 `changedFields = undefined`。
- **memory.remember / memory.forget ActionHandler**：Phase 5.2 才实现；当前 `createRememberHandler` 写的是 `infoStore`（Phase 4.B），与 D-AGENT-16-03 四态 decision 的 remember_only 存在历史冲突（见 `guide/orca-memory-design.md` v1.1 §10.2-A），Phase 5.0 不修改现有 handler。

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

*维护者：ka。本文档与代码同步于 **app-cordis v1.0.0 + Phase 7.1B（2026-09-08）**；设计稿 **Phase 7.3 Architecture Review + IM Bridge IM-1.0 + guide/orca-memory-quality-design.md（2026-09-08）**。*
