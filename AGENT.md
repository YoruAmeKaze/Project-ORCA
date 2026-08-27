# Project Orca — Agent 启动上下文（AGENT.md）

> **给新会话/新代理的启动引导**：开工前先通读本文档，再按需深读具体文件。本文档是当前代码（**app-cordis v0.6.0 + Phase 3 开发中**）的权威快照。
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

## 2. 当前架构（app-cordis v0.6.0 + Phase 3）

```
飞书 webhook → feishu-channel（ctx.emit feishu/message + feishu/image，p2p/群聊带 chat_id）
  → agent（CEO：R0 查档 + LLM 回复）        # 信息获取框架（InfoAgent）
  → image-router（D-AGENT-15：chat_id → agent 工位分配）
  → [Orca Runtime，ORCA_RUNTIME_ENABLED=1 启用]
      feishu-adapter → EventBus（滑动窗口 200）
        → WorldStateUpdater（reducer 注册表 + time tick）→ WorldStateService
        → pc/calendar/phone adapters（mock，默认 disabled）
        → AttentionEngine（Phase 3：规则评估 → dedup → throttle）→ emit 'orca/attention'
        → [Phase 4 规划] Decision Executor
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
│   │   ├── context.ts         # Cordis Context 类型增强（feishu/llm/vision/sessions/info*/eventBus/worldState/attention）
│   │   ├── session.ts         # SessionStore：内存会话
│   │   ├── agents/            # 信息获取框架：types/registry（闭集）/store（档案室 JSONL）/executor（Pull）/router（R0+R1）/builtins/food-log.ts（food-agent）
│   │   ├── services/          # feishu / llm（DeepSeek）/ vision（Qwen VL）/ eventBus / worldState / attention
│   │   ├── plugins/           # feishu-channel / agent / info-agents / info-receiver / image-router / food-image / dashboard / orca-runtime / world-state-updater / attention-engine / input-adapters/{feishu,pc,calendar,phone}-adapter
│   │   ├── types/             # event.ts（OrcaEvent）/ worldState.ts / attention.ts
│   │   └── data/              # records/ 档案室 JSONL + images/ 图片落盘（gitignore）
│   └── scripts/               # smoke-info-agent / smoke-world-state / smoke-attention / recognize-food / list-food
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

### 4.4 关键事件（ctx.emit / ctx.on）
| 事件 | 载荷 | 产生者 |
|------|------|--------|
| `feishu/message` | text/openId/chatId/messageId | feishu-channel |
| `feishu/image` | imageKey/chatId/messageId | feishu-channel |
| `info/record` | InfoRecord | info-agents（写档） |
| `orca/event` | OrcaEvent | EventBus |
| `orca/state_changed` | WorldState | world-state-updater |
| `orca/attention` | AttentionItem | attention-engine |

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
- **Phase 3.B（2026-08-27）**：dedup（去重）→ throttle（节流）→ rule-registry（规则注册表解耦）
- **Python 版删除（2026-08-27）**：v2.3.0 全部源码移除，app-cordis 成为唯一主线

### 8.2 待办（TODO.md）
- **Phase 3.B.rule-config**：YAML/JSON 规则加载（基于 registry 接口）
- **Phase 4 Decision Executor**：订阅 'orca/attention'，按 priority 排序 + 复用 throttle + 执行 notify/act/remember
- 迁移 search_web / capture_screenshot / analyze_image 为 InfoAgent（Pull）
- 会话持久化（jsonl）；urgency=2 主动推送；独立飞书 bot 的 app_id 路由（远期）
- 飞书事件订阅加密模式支持（技术债）

### 8.3 关键架构约束（Phase 3.A 确定，Attention/Decision 必读）
- **Attention Rule predicate 判断"事件发生前状态"必须用 `prevState`**；`state` 是事件处理后（reducer 已应用）的世界。
- 错误示范：`predicate: ({ state }) => state.user.status === 'away'`（reducer 改 awake 后永远不触发）；正确：`predicate: ({ prevState }) => prevState?.user.status === 'away'`。
- `prevState` 在 state-only 触发时为 `undefined`；event 触发时由 `ws.getPrevState()` 提供。
- 三层职责分离：Engine（是什么）→ Dedup（多不多）→ Throttle（该不该打扰）；throttle 仅限 notify_immediately + act，remember_only/ignore/wait_until_available 直通。

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

*维护者：ka。本文档与代码同步于 **app-cordis v0.6.0 + Phase 3.B（2026-08-27，Python 版已删除）**。*
