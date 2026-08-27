# Project Orca — 本地桌面 AI 助手

> **给 AI 代理/新会话的启动上下文请读 [`AGENT.md`](AGENT.md)**（权威快照，本文档只做对外概述）。
> 开发进度见 [`dev-log.md`](dev-log.md)，待办见 [`TODO.md`](TODO.md)。

通过飞书聊天的本地桌面 AI 助手（"全向性室内控制代理"）。发飞书消息给 Orca，它帮你操作电脑、看屏幕、搜网、点瑞幸咖啡、拍食物识别热量。**当前主线为 Cordis/TypeScript 版（`app-cordis/`，v0.6.0），Python 版已废弃。**

## 当前状态（2026-08-27）

- **v0.6.0（app-cordis）**：Persistent Context Runtime 完整闭环 —— EventBus 事件流 + WorldState 世界状态 + 3 个 Mock 输入适配器（PC/Calendar/Phone）+ Debug Publisher
- **Phase 3（开发中）**：Attention Engine 纯规则注意力系统（已实现：引擎 + 去重 dedup + 节流 throttle + 规则注册表 rule-registry；下一步：规则配置化）
- **Phase 4（规划）**：Decision Executor 决策执行
- Python 版（v2.3.0 Plan-then-Execute）已废弃，待删除

## 功能

- **飞书聊天** — 发消息给 Orca 即可对话（p2p / 群聊 @）
- **食物识别** — 发食物照片 → 本地视觉识别（kcal）→ 写入 food-log 档案 → 之后可查询"吃了多少卡"（R0 档案优先，零视觉调用）
- **直连图片上传** — iPhone 快捷指令 Base64 直传 `POST /info/images`，同步返回识别结果
- **持续感知 Runtime** — EventBus 事件流 + WorldState 世界状态（用户状态/设备/时间），为主动提醒打基础（Phase 3+）
- 桌面控制 / 联网搜索（Python 版能力，迁移规划中）

## 快速开始（app-cordis）

前置：Node.js ≥ 20（`D:\node\node.exe`）、Ollama（本地视觉，`qwen3-vl:4b`）。

```bash
# 1. 配置：复制 .env.example 为根 .env，填 DEEPSEEK_API_KEY / FEISHU_APP_ID / FEISHU_APP_SECRET 等
#    （app-cordis 复用根 .env；app-cordis/.env 可覆盖）

# 2. 安装依赖（npm 缓存放工作区内，避免沙箱拦系统缓存目录）
cd app-cordis && npm install --cache .npm-cache

# 3. 构建 + 冒烟测试
npm run build
npm run smoke             # InfoAgent 框架 69 项
npm run smoke:world-state # WorldState 94 项
npm run smoke:attention   # Attention 110 项（Phase 3）

# 4. 启动（本地调试：AI 回复只写日志不发飞书）
ORCA_DRY_RUN=1 npm run dev
# 或正常启动（复用根 .env）
npm run dev

# 5. 生产部署：tsc build 后 node 直跑
npm run build && npm start
```

Windows 一键启动（含 SSH 隧道）：根目录 `start-cordis.bat`（构建 + 隧道 + 启动）。

服务监听 `0.0.0.0:8100`（飞书 webhook），`8101`（外部 Push 通道），`8200`（Dashboard）。

## 架构（app-cordis v0.6.0 + Phase 3）

```
飞书 webhook → feishu-channel（ctx.emit feishu/message + feishu/image）
  → agent（CEO：R0 查档 + LLM 回复）
  → image-router（D-AGENT-15：chat_id → agent 工位分配）
  → [Orca Runtime，ORCA_RUNTIME_ENABLED=1 启用]
      feishu-adapter → EventBus（滑动窗口 200）
        → WorldStateUpdater（reducer 注册表 + time tick）→ WorldStateService
        → pc/calendar/phone adapters（mock，默认 disabled）
        → AttentionEngine（Phase 3：规则评估 → dedup → throttle）→ 'orca/attention'
        → [Phase 4] Decision Executor（规划中）
```

设计文档：`guide/orca-cordis-migration-plan.md`（迁移方案）、`guide/orca-info-agent-framework.md`（InfoAgent 框架）、`guide/orca-iphone-channel.md`（iPhone 数据通道）。

## 配置（.env，详见 .env.example）

| 键 | 默认 | 说明 |
|----|------|------|
| `DEEPSEEK_API_KEY` / `DEEPSEEK_API_URL` / `DEEPSEEK_MODEL` | deepseek-v4-flash | 主 LLM（对话 + 规划） |
| `QWEN_API_KEY` / `QWEN_API_URL` / `QWEN_VL_MODEL` | qwen3.7-plus | 云端视觉（dashscope） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | — | 飞书机器人 |
| `ORCA_VISION_BACKEND` | dashscope | 视觉后端：`ollama`（本地，用 `OLLAMA_HOST`+`OLLAMA_VL_MODEL`）或 `dashscope` |
| `OLLAMA_HOST` / `OLLAMA_VL_MODEL` | localhost:11434 / qwen3-vl:4b | 本地视觉 |
| `CORDIS_HOST` / `CORDIS_PORT` | 0.0.0.0:8100 | 服务监听 |
| `ORCA_DRY_RUN` | — | 1 = 只写日志不发飞书 |
| `ORCA_HISTORY_TURNS` | 10 | 每会话保留轮数 |
| `INFO_RECORDS_DIR` / `IMAGES_DIR` | app-cordis/data/records·images | 档案室 JSONL / 图片落盘 |
| `INFO_RECEIVER_PORT` / `INFO_RECEIVER_TOKENS` | 8101 / 空 | 外部 Push 通道（Bearer + namespace 白名单，未配不启动） |
| `ORCA_CHAT_BINDINGS` | 空 | 会话绑定路由 `{"<chat_id>":"<agent>"}`（D-AGENT-15） |
| `ORCA_RUNTIME_ENABLED` | 0 | 1 = 启用 Persistent Context Runtime（EventBus + WorldState + Attention） |
| `ORCA_RUNTIME_WINDOW` | 200 | EventBus 滑动窗口 |
| `ORCA_WORLD_STATE_ENABLED` / `ORCA_WORLD_STATE_REFRESH_MS` | 1 / 60000 | WorldState 开关 / time tick 间隔 |
| `ORCA_PC_ENABLED` / `ORCA_PC_REFRESH_MS` | 0 / 60000 | PC adapter（mock） |
| `ORCA_CALENDAR_ENABLED` / `ORCA_CALENDAR_REFRESH_MS` | 0 / 120000 | Calendar adapter（mock） |
| `ORCA_PHONE_ENABLED` / `ORCA_PHONE_REFRESH_MS` | 0 / 300000 | Phone adapter（mock） |
| `ORCA_ATTENTION_ENABLED` | 1 | Attention Engine（纯评估，安全默认） |

> 注意：`ORCA_RUNTIME_ENABLED` 必须严格写 `1`（`true`/`yes`/`on` 不生效）；`ORCA_*_ENABLED` 同理。

## 项目结构

```
app-cordis/                  # ★ Cordis/TypeScript 版（当前主线，v0.6.0）
│   ├── src/
│   │   ├── index.ts         # 入口：loadEnv → Context → 插件装配
│   │   ├── config.ts        # .env 加载（根 .env + app-cordis/.env 覆盖）
│   │   ├── persona.ts       # Orca 人设（平级称呼 + "淡淡死感"语气）
│   │   ├── context.ts       # Cordis Context 类型增强
│   │   ├── session.ts       # 内存会话
│   │   ├── agents/          # InfoAgent 框架（types/registry/store/executor/router + food-log）
│   │   ├── services/        # feishu / llm / vision / eventBus / worldState / attention
│   │   ├── plugins/         # feishu-channel / agent / info-agents / info-receiver / image-router / food-image / dashboard / orca-runtime / world-state-updater / attention-engine / input-adapters/
│   │   ├── types/           # event.ts / worldState.ts / attention.ts
│   │   └── data/            # records/ 档案室 JSONL + images/ 图片落盘（gitignore）
│   └── scripts/             # smoke-info-agent / smoke-world-state / smoke-attention / recognize-food / list-food
guide/                       # 设计文档（memory-pack / decisions / cordis-migration-plan / info-agent-framework / iphone-channel）
AGENT.md                     # ★ 权威启动上下文（新会话必读）
dev-log.md                   # 开发日志（版本历史）
TODO.md                      # 待办
```

## 技术栈

| 模块 | 选型 |
|------|------|
| 框架 | @deepseek-ai/cordis（4.x）+ TypeScript |
| IM 平台 | 飞书开放平台（webhook 自写通道） |
| 主 LLM | DeepSeek（deepseek-v4-flash） |
| 视觉 | Ollama qwen3-vl:4b（本地，默认） / 阿里百炼（云端） |
| 事件流 | 自写 EventBus（内存 pub/sub + 滑动窗口） |
| 世界状态 | WorldStateService + reducer 注册表 + time tick |
| 注意力 | AttentionEngine（纯规则）+ dedup + throttle + rule-registry |

## License

MIT
