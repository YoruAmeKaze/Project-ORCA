# app-cordis — Project Orca Cordis 版（Phase 1 + Phase 2 信息获取框架）

Project Orca 的 Cordis(TypeScript) 重写版，与 Python 版平行开发。
迁移方案见仓库根 `guide/orca-cordis-migration-plan.md`，信息获取框架设计见 `guide/orca-info-agent-framework.md`（v0.2）。

## 已完成

### Phase 1：飞书 → AI 回复最小闭环

- [x] Cordis 工程骨架（`@deepseek-ai/cordis` + TypeScript + tsx）
- [x] 纯 Cordis 自写飞书通道插件（webhook：challenge 验证 / event_id 60s 去重 / 仅 p2p 文本 / fire-and-forget）
- [x] Feishu 服务（tenant_access_token 缓存、reply_text / send_text）
- [x] DeepSeek LLM 服务（chat completions）
- [x] 内存会话（每会话最近 N 轮）
- [x] Agent 插件：`feishu/message` 事件 → persona + 历史 → LLM → reply

### Phase 2：信息获取框架（InfoAgent，CEO-员工-档案室模型）

- [x] `src/agents/`：types（InfoAgent/InfoRecord/RecordQuery，§3 原样）+ registry（闭集）+ store（档案室 JSONL：append-only + supersedes、软删/整夹清空 + ttl 清理、pending 待汇报队列）+ executor（Pull 管线：校验/串行/超时/归一/审计）+ router（R0 查档优先 + R1 关键词）
- [x] `src/agents/builtins/food-log.ts`：food-agent（首批 Push 源，pull+push 双模式，推理型内部 Qwen 视觉，识别结果自动写 food-log 档案）
- [x] `src/plugins/info-agents.ts` 装配 + `src/plugins/info-receiver.ts` 外部上报通道（POST /info/records，Bearer 鉴权 + namespace 白名单）
- [x] Agent CEO 集成：饮食类问题 R0 查档案（命中即复用，零视觉调用）+ urgency=1 待汇报队列（下条消息自然带一句）
- [x] 飞书图片闭环（D-AGENT-13 通道① + D-AGENT-15 工位路由）：feishu-channel image 消息（带 chat_id）→ `src/plugins/image-router.ts` 按 chat_id → agent 绑定表派发 → `src/plugins/food-image.ts` → Qwen 识别 → 写 food-log 档案 → 回复确认
- [x] 会话绑定路由（D-AGENT-15）：一个 bot 多个群 = 工位，`ORCA_CHAT_BINDINGS` 绑定 chat_id → agent，事件只到绑定 agent（不广播），未绑定 → 默认 Orca 主管线；feishu-channel 放开 chat_type（支持群聊）
- [x] 合规修复：控制台 exporter `levels.default: 2`（放行 WARN，fork 语义 level ≤ 阈值才导出）、downloadImage 10s 超时、store 信封校验
- [ ] urgency=2 紧急推送（按落地安排后置）

## 快速开始

```bash
# 依赖（npm 缓存放在 app-cordis/.npm-cache，避免沙箱拦截系统缓存目录）
npm install --cache .npm-cache

# 构建 + 冒烟测试（52 项：注册表/档案室/执行管线/路由/上报通道/food-agent 全链路/日志级别回归/chat 绑定路由，视觉用 stub）
npm run build && node scripts/smoke-info-agent.mjs

# L1 真实视觉识别（需 .env 配 QWEN_API_KEY）：真实照片 → Qwen 识别 → 写 food-log 档案 → 档案回读
node scripts/recognize-food.mjs <图片路径> [备注]

# 本地调试（AI 回复只写日志，不真正发飞书）
ORCA_DRY_RUN=1 npm run dev

# 正常启动（复用仓库根 .env 的 DEEPSEEK_*/FEISHU_*/QWEN_* 配置）
npm run dev
```

服务默认监听 `0.0.0.0:8100`（避开 Python 版 8000），可通过 `CORDIS_HOST/CORDIS_PORT` 覆盖。

- `GET /health` — 健康检查
- `POST /feishu/webhook` — 飞书事件订阅回调
- `POST /info/records` — 外部 App Push 上报通道（默认端口 8101，Bearer 鉴权，未配 token 不启动）

## 配置

默认读取仓库根 `.env`（与 Python 版共用 `DEEPSEEK_API_KEY/DEEPSEEK_API_URL/DEEPSEEK_MODEL/FEISHU_APP_ID/FEISHU_APP_SECRET/QWEN_API_KEY/QWEN_API_URL/QWEN_VL_MODEL`），
`app-cordis/.env` 可覆盖。额外键见 `.env.example`：

| 键 | 默认 | 说明 |
|----|------|------|
| `CORDIS_PORT` | 8100 | 飞书通道端口 |
| `ORCA_DRY_RUN` | — | 1 = AI 回复只写日志，不发飞书 |
| `ORCA_HISTORY_TURNS` | 10 | 每会话保留轮数 |
| `INFO_RECORDS_DIR` | `data/records` | 档案室 JSONL 目录（每 namespace 一文件） |
| `IMAGES_DIR` | `data/images` | 飞书图片落盘目录（food-image 用） |
| `INFO_RECEIVER_PORT` | 8101 | 外部 Push 通道端口 |
| `INFO_RECEIVER_TOKENS` | 空 | JSON `{"<token>":["<namespace>"]}`，每 App 独立 token + namespace 白名单 |
| `ORCA_CHAT_BINDINGS` | 空 | JSON `{"<chat_id>":"<agent>"}` 会话绑定路由（D-AGENT-15）；未绑定会话 → 默认 Orca 主管线 |
| `ORCA_VISION_BACKEND` | `dashscope` | 视觉后端：`ollama`（本地 Ollama，免 key，用 `OLLAMA_HOST`+`OLLAMA_VL_MODEL`）或 `dashscope`（云端，用 `QWEN_API_*`） |
| `OLLAMA_VL_MODEL` | `qwen2.5vl:3b` | 本地视觉模型（推荐 `qwen3-vl:4b`；纯文本模型不能识图） |

## 目录结构

```
src/
├── index.ts                 # 入口：loadEnv → Context → 服务注册 → 插件装配
├── config.ts                # env 加载与配置组装（含 qwen / infoReceiver / infoRecordsDir / chatBindings）
├── persona.ts               # Orca 人设 system prompt
├── context.ts               # Cordis Context 类型增强（feishu/llm/vision/sessions/info*）
├── session.ts               # SessionStore：内存会话
├── services/
│   ├── feishu.ts            # FeishuClient：token 缓存、reply_text / send_text / downloadImage
│   ├── llm.ts               # LlmClient：DeepSeek chat completions
│   └── vision.ts            # VisionClient：Qwen VL（food-agent 内部用）
├── agents/                  # ★ 信息获取框架
│   ├── types.ts             # InfoAgent / InfoRequest / InfoResult / InfoRecord / RecordQuery
│   ├── registry.ts          # InfoAgentRegistry（闭集）
│   ├── executor.ts          # InfoExecutor（Pull 执行管线）
│   ├── store.ts             # JsonlInfoRecordStore（档案室）
│   ├── router.ts            # R0 查档 + R1 关键词
│   └── builtins/food-log.ts # food-agent（pull+push）
└── plugins/
    ├── feishu-channel.ts    # 飞书 webhook 通道（HTTP + 事件去重；p2p/群聊，text → feishu/message，image → feishu/image，事件带 chat_id）
    ├── info-agents.ts       # 框架装配（registry/executor/store + 内置注册）
    ├── info-receiver.ts     # 外部 App Push 通道（POST /info/records）
    ├── image-router.ts      # 图片事件路由（D-AGENT-15：chat_id → agent 工位分配，不广播）
    ├── food-image.ts        # food 管线处理器（下载 → 识别 → food-log 档案 → 回复，由 image-router 接收）
    └── agent.ts             # feishu/message → R0 查档+待汇报 → persona+历史 → LLM → reply
```

## 与 Python 版对照（已落地部分）

| Python 版 | Cordis 版 |
|-----------|-----------|
| `router/feishu.py` | `plugins/feishu-channel.ts` |
| `feishu/client.py` | `services/feishu.ts` |
| `core/persona.py` | `persona.ts` |
| `core/history.py` | `session.ts`（内存，持久化后置） |
| `core/orchestrator.py` 调度 | Cordis 事件总线（`feishu/message`）+ `plugins/agent.ts` |
| `core/planner.py` + `dsl/` + `runtime/engine.py` | 待 Phase 2 后续（工具迁移为 InfoAgent） |
| `skill/handlers/analyze.py`（Qwen 视觉） | `services/vision.ts` + `agents/builtins/food-log.ts` |
| — | `agents/` 框架（InfoAgent 抽象，`guide/orca-info-agent-framework.md`） |
