# app-cordis — Project Orca Cordis 版（Phase 1）

Project Orca 的 Cordis(TypeScript) 重写版，与 Python 版平行开发。
迁移方案见仓库根 `guide/orca-cordis-migration-plan.md`。

## Phase 1 范围（当前）

- [x] Cordis 工程骨架（`@deepseek-ai/cordis` + TypeScript + tsx）
- [x] 纯 Cordis 自写飞书通道插件（webhook：challenge 验证 / event_id 60s 去重 / 仅 p2p 文本 / fire-and-forget）
- [x] Feishu 服务（tenant_access_token 缓存、reply_text / send_text）
- [x] DeepSeek LLM 服务（chat completions）
- [x] 内存会话（每会话最近 N 轮）
- [x] Agent 插件：`feishu/message` 事件 → persona + 历史 → LLM → reply
- [ ] 验收：本地双跑，Python 版不动，新骨架可聊天（待端到端验证）

## 快速开始

```bash
# 依赖（npm 缓存放在 app-cordis/.npm-cache，避免沙箱拦截系统缓存目录）
npm install --cache .npm-cache

# 本地调试（AI 回复只写日志，不真正发飞书）
ORCA_DRY_RUN=1 npm run dev

# 正常启动（复用仓库根 .env 的 DEEPSEEK_*/FEISHU_* 配置）
npm run dev
```

服务默认监听 `0.0.0.0:8100`（避开 Python 版 8000），可通过 `CORDIS_HOST/CORDIS_PORT` 覆盖。

- `GET /health` — 健康检查
- `POST /feishu/webhook` — 飞书事件订阅回调

## 配置

默认读取仓库根 `.env`（与 Python 版共用 `DEEPSEEK_API_KEY/DEEPSEEK_API_URL/DEEPSEEK_MODEL/FEISHU_APP_ID/FEISHU_APP_SECRET`），
`app-cordis/.env` 可覆盖。额外键见 `.env.example`（`CORDIS_PORT` / `ORCA_DRY_RUN` / `ORCA_HISTORY_TURNS` 等）。

## 目录结构

```
src/
├── index.ts                 # 入口：loadEnv → Context → 服务注册 → 插件装配
├── config.ts                # env 加载与配置组装
├── persona.ts               # Orca 人设 system prompt
├── context.ts               # Cordis Context 类型增强（feishu/llm/sessions）
├── session.ts               # SessionStore：内存会话
├── services/
│   ├── feishu.ts            # FeishuClient：token 缓存、reply_text / send_text
│   └── llm.ts               # LlmClient：DeepSeek chat completions
└── plugins/
    ├── feishu-channel.ts    # 飞书 webhook 通道插件（HTTP 服务 + 事件去重）
    └── agent.ts             # feishu/message → persona+历史 → LLM → reply
```

## 与 Python 版对照（Phase 1 落地部分）

| Python 版 | Cordis 版 |
|-----------|-----------|
| `router/feishu.py` | `plugins/feishu-channel.ts` |
| `feishu/client.py` | `services/feishu.ts` |
| `core/persona.py` | `persona.ts` |
| `core/history.py` | `session.ts`（内存，Phase 2 持久化） |
| `core/orchestrator.py` 调度 | Cordis 事件总线（`feishu/message`）+ `plugins/agent.ts` |
| `core/planner.py` + `dsl/` + `runtime/engine.py` | Phase 2 引入工具调用 / agent-loop |
