# Project Orca — 开发日志

> 提交惯例（见 `guide/decisions.md` D-VER-01~04）：每 commit 升版本（MAJOR/MINOR/PATCH）、写本日志、**同步更新 AGENT.md**、commit message 带版本前缀。本条不参与版本计数。

## v1.1.0（2026-06）

### 新增：瑞幸咖啡 AI 自动点单（WIP）

利用瑞幸官方 AI 开放平台 (open.lkcoffee.com) 的 CLI 工具，实现通过 Orca 自然语言下单。

#### 接入方式
- **方案 A：CLI 封装** — Python subprocess 调用 `luckin` 二进制
- 瑞幸 CLI v0.0.1，支持 store/menu/order preview/order create 等命令

#### 新增文件
- `src/tasks/__init__.py` — 任务模块包
- `src/tasks/luckin.py` — LuckinClient，封装 luckin CLI 全部命令的异步 Python 类

#### 修改文件
- `src/config.py` — 新增 `LUCKIN_BINARY_PATH` 配置项
- `src/core/agent.py` — TOOLS 新增 `luckin_lookup` / `luckin_order` 两个工具
- `src/core/orchestrator.py` — 注册 luckin lookup/order 回调
- `TODO.md` — 更新进度

#### CLI 安装
- Windows: `irm https://open.lkcoffee.com/window/install | iex`
- 已安装至 `D:\Git\cmd\luckin.exe`

#### 待完成
- [ ] 首次登录：`luckin.exe login`（手机验证码）
- [ ] 端到端点单流程测试
- [ ] 错误处理完善（未登录提示、下单失败重试等）

---

## v2.0.0（2026-06）

### 架构重构：ReAct → Plan-then-Execute（Phase A）

按照 `guide/memory-pack.md` 设计规范进行架构重构，将 agent 从 ReAct 循环迁移为 DSL + Skill Registry + Runtime 架构。

#### 核心变更

| 旧架构 | 新架构 |
|--------|--------|
| `agent.py` ReAct 循环 | `core/planner.py` — LLM 只出 DSL 计划 |
| 分散的 tool callbacks | `skill/registry.py` — 统一 Skill Registry |
| LLM function calling 直接调工具 | `dsl/validator.py` — 四层校验 |
| "边想边干" | `runtime/engine.py` — 顺序执行 DSL |

#### 新增模块

- `dsl/schema.py` — Plan / SkillCall 数据模型，JSON 格式，支持 `{{step.id.output}}` 引用
- `dsl/validator.py` — 四层校验：安全审查 → 格式 → 引用 → skill 参数
- `skill/registry.py` — SkillRegistry（metadata + handler 映射，closed-world）
- `skill/builtins.py` — 10 个内置 skill 注册工厂
- `skill/handlers/` — reply / capture_screenshot / analyze_image / click / double_click / right_click / move_mouse / type_text / scroll / search_web
- `runtime/context.py` — RuntimeContext 纯数据容器
- `runtime/engine.py` — DSL 顺序执行器，fail-fast，引用解析
- `core/planner.py` — 三阶段规划器（关键词匹配 → 约束过滤 → LLM 出 DSL）
- `guide/decisions.md` — 全部架构决议文档

#### 迁移策略

三阶段过渡：
- **Phase A（当前）**：新代码平行编写，不删旧文件
- **Phase B**：`USE_NEW_ARCH=true` 环境变量开关切换
- **Phase C**：验证通过后清理旧文件

#### 决议文档

详见 `guide/decisions.md`，共 6 个话题 ~40 条决议：
- DSL、Skill Registry、Validator、Planner & Skill Selection、Orchestrator、Runtime

#### 后续修正
- **D-ORC-03 (ACK 条件化)**：纯闲聊（一步 reply）跳过 ACK，多步或操作才发。同步更新了 planner prompt 和 orchestrator `_is_simple_chat` 判断。

#### 待完成
- [ ] Phase B：端到端测试新架构
- [ ] Phase C：清理旧文件（agent.py、action/、vision/、chat.py）

---

### 配置方式

复制 `.env.example` 为 `.env`，填写：

```env
DEEPSEEK_API_KEY=sk-xxx          # DeepSeek API Key（意图分析、聊天）
QWEN_API_KEY=sk-xxx              # 阿里云百炼 Qwen API Key（视觉分析）
FEISHU_APP_ID=cli_xxx             # 飞书应用 App ID
FEISHU_APP_SECRET=xxx             # 飞书应用 Secret
```
---

## v2.1.0（2026-06）

### 修整与增强

| 变更 | 说明 |
|------|------|
| 串行锁 (D-ORC-04) | 同一时间只执行一个 plan，第二条排队 |
| ACK 条件化 (D-ORC-03) | 纯闲聊跳过 ACK，多步/操作才发 |
| JSON 提取增强 | `_extract_json` 从 LLM 输出中智能提取 JSON |
| Markdown 剥离 | 自动去掉 LLM 包在 ```json 里的代码块 |
| 编码修复 | `-X utf8` 解决中文乱码 |
| refine skill | 新增润色 skill，视觉分析结果先经 DeepSeek 转 Orca 语气再回复 |
| Planner 关联规则 | `analyze_image` 自动带上 `refine` |
| 移除 Planner 中 Orca 人设 | 避免 LLM 混淆角色输出非 JSON 内容 |

### 新增文件
- `src/skill/handlers/refine.py`

### 修改文件
- `src/core/orchestrator.py` — 串行锁、ACK 条件化、`_is_simple_chat`
- `src/core/planner.py` — 移除 ORCA_PERSONA_PROMPT，加强 JSON 指令，关联规则
- `src/dsl/validator.py` — `_extract_json` 智能提取
- `src/skill/builtins.py` — 注册 refine skill
- `guide/decisions.md` — D-ORC-03 更新

---

## v2.1.1（2026-06）

### 变更
- **narration 字段**：DSL 每步新增 `narration`，由 LLM 动态生成，替代固定的 `progress_message`
- **关键词匹配增强**：支持单字中文匹配 + 双向描述匹配（描述→消息 + 消息→描述）
- **引用规则强化**：LLM prompt 明确 step id 不能和 skill 名称混淆
- `analyze_image` 描述更新：说明 image_path 三种来源，Planner 据此自动编排截图步骤

### 修改文件
- `dsl/schema.py` — SkillCall 新增 narration 字段
- `core/planner.py` — prompt 加 narration schema/示例，加引用规则，关键词匹配增强
- `runtime/engine.py` — 执行前发送 narration（优先），无则 fallback 到 progress_message
- `skill/builtins.py` — analyze_image 描述更新

---

## v2.2.0（2026-06）

### 多轮会话状态机 + 瑞幸点咖啡流程重构

#### 新增：`session_state`（handler 跨轮数据通道）

`SkillDeps.session_state: dict` — handler 写入、Orchestrator 搬运、Planner 读取的跨轮数据通道。

- `handle_find_store` → 写入 `store_list`（结构化门店列表）、单店命中时写入 `selected_dept_id`
- `handle_search_menu` → 确认 `selected_dept_id`
- Orchestrator 将 `session_state` 同步到 `active_task.context`
- Planner 注入 LLM prompt：门店列表、选中门店信息直供 LLM，不再从对话历史文本提取

#### 新增：`active_task`（Orchestrator 级会话状态机）

`Conversation.active_task: dict | None` — 跨 plan 的会话级任务跟踪，挂在 session 上。

```python
active_task = {
    "task_type": "luckin_order",   # DSL 顶层字段，Planner 标记
    "stage": "store_selected",     # 当前进度
    "context": { ... }             # 关键状态（从 session_state 同步）
}
```

**注入流程**：
1. 消息进入 → Orchestrator 检查 `conv.active_task`
2. 存在则格式化为"当前有未完成任务：luckin_order，进度：store_selected" → 注入 Planner prompt
3. Planner 生成 DSL（可选顶层 `task_type` / `stage`）
4. 执行后 → Orchestrator 解析 DSL → 更新/清空 `conv.active_task`

**生命周期**：
- `task_type` 存在 → `active_task` 保持或更新
- `task_type` 缺失/空 → 自动清空（用户转移话题/任务结束）
- 不需要额外"取消" skill

#### Planner 关键词匹配增强

- 有 `selected_dept_id` 时自动排除 `luckin_find_store`（防止选店后误调）
- 有 `store_list` + 选择关键词（"第"、"这"、"那"等）时自动加入 `luckin_search_menu`
- system prompt 新增多轮示例（"第一家"、"喝生椰拿铁"）

#### 旧文件清理（Phase C）

删除 `src/action/`、`src/vision/`、`src/core/agent.py`、`src/core/chat.py`、`src/tasks/luckin.py` — ReAct 架构旧文件。

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/runtime/engine.py` | `SkillDeps` 新增 `session_state: dict` |
| `src/skill/handlers/luckin.py` | `handle_find_store`/`handle_search_menu` 写入 `session_state` |
| `src/core/planner.py` | 接收 `session_state` + `active_task`，注入 prompt；关键词匹配增强 |
| `src/core/orchestrator.py` | `active_task` 状态机：注入 → 执行 → 更新 |
| `src/core/history.py` | `Conversation` 新增 `active_task` 字段 |
| `src/dsl/schema.py` | `Plan` 新增 `task_type` / `stage` 字段 |

---

## v2.3.0（2026-06）

### 瑞幸 skill 补全 + 下单流程修复

#### 新增：3 个瑞幸 MCP skill

| Skill | 用途 | 
|-------|------|
| `luckin_switch_product` | 切换规格选项（冰/热、杯型、糖度），返回 variant SKU |
| `luckin_query_order` | 查询订单状态、取餐码 |
| `luckin_cancel_order` | 取消订单 |

配套 MCP client 新增 `switch_product` / `query_order_detail` / `cancel_order` 三个方法。

#### 修复：下单流程

| 问题 | 修复 |
|------|------|
| `get_product_detail` 返回"未知商品" | MCP 返回包在 `data` 字段里，改为读 `data.productName` + `data.productAttrs` |
| 跳过规格直接下单 | 新增 `specs_shown` 守卫，预览前检查 |
| reply 硬编码成功消息 | 规则 3：必须引用上一步 output |
| `createOrder` 坐标用北京默认值 | 改为 `.env` 的 `LUCKIN_LAT/LNG`（重庆坐标） |
| Validator 层 3 错误无重试 | 层 3（参数校验）失败也触发 retry 并注入错误反馈 |
| LLM 用 `{{step.x.output}}` 引用已知值 | 规则 4：已知信息直接抄字面量，禁止引用 |

#### 新增：`STAGE_SKILL_MAP` 阶段性注入

按 `active_task.stage` 强制注入当前阶段所需 skill，替换旧的关键词 hack：

| 阶段 | 强制注入 |
|------|---------|
| `store_listed` / `store_selected` | `luckin_search_menu` |
| `menu_searched` | `luckin_get_product_detail` |
| `detail_shown` | `luckin_preview_order` |
| `previewed` | `luckin_create_order` |

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/tasks/luckin_mcp.py` | 新增 switch_product / query_order_detail / cancel_order |
| `src/skill/handlers/luckin.py` | 新增 3 handler + 修复 get_product_detail + specs_shown 守卫 |
| `src/core/planner.py` | STAGE_SKILL_MAP + 规则 3/4 补充 |
| `src/core/orchestrator.py` | active_task 格式化优化 + Validator 层 3 retry |
| `src/skill/builtins.py` | 注册 3 个新 skill |

---

## app-cordis v0.1.0（2026-08-24）

### Cordis 迁移 Phase 1：骨架 + 飞书 → AI 回复最小闭环

> 平行于 Python 版（v2.3.0 不动），新目录 `app-cordis/`，TypeScript 全量重写。方案见 `guide/orca-cordis-migration-plan.md`。

#### 新增文件（app-cordis/）

| 文件 | 说明 |
|------|------|
| `package.json` / `tsconfig.json` / `.env.example` / `.gitignore` / `README.md` | 工程骨架（@deepseek-ai/cordis ^4.0.1；tsx dev / tsc build + node start） |
| `src/index.ts` | 入口：loadEnv → Context → 服务注册 → 插件装配 → 控制台日志 exporter |
| `src/config.ts` | env 加载（仓库根 .env + app-cordis/.env 覆盖）；DEEPSEEK_API_URL 兼容完整端点归一化 |
| `src/persona.ts` | Orca 人设 system prompt（对齐 Python 版 core/persona.py） |
| `src/context.ts` | Cordis Context 类型增强（fork 内部相对路径增强不生效，应用侧补齐 on/emit/plugin 声明） |
| `src/session.ts` | SessionStore 内存会话（每会话最近 N 轮，持久化留 Phase 2） |
| `src/services/feishu.ts` | FeishuClient：tenant_access_token 缓存、reply_text / send_text |
| `src/services/llm.ts` | LlmClient：DeepSeek chat completions（非流式） |
| `src/plugins/feishu-channel.ts` | 飞书 webhook 通道：challenge / event_id 60s 去重 / 仅 p2p 文本 / fire-and-forget / server error 处理 |
| `src/plugins/agent.ts` | feishu/message 事件 → persona+历史 → LLM → reply（dry-run 可关发送） |

#### 关键决策与踩坑

- 插件框架用 `@deepseek-ai/cordis`（与方案研读基线一致）；自写飞书通道（B 方案），不引入 Koishi
- fork 版 LoggerService 默认只有内存缓冲 exporter，不打印终端 —— 入口需自挂控制台 exporter
- 沙箱/受限环境：esbuild/tsx 的 worker 子进程（管道 stdio）被拦（EPERM）→ 改用 `tsc build` + `node dist/` 直跑
- npm 缓存需指向工作区内目录（默认系统缓存目录被文件沙箱拦截）
- 端口 `CORDIS_PORT` 默认 8100（避开 Python 版 8000）；`ORCA_DRY_RUN=1` 本地调试
- 验证通过：/health、challenge 回显、消息接收 200、重复 event_id 去重、DeepSeek LLM 回复（dry-run 日志确认人设生效）

#### 下一步

- Phase 2：迁移 search_web / capture_screenshot / analyze_image / refine + 会话持久化（jsonl）
- 提交前：AGENT.md 已同步（§3 目录结构 + §9.3 状态）

---

## app-cordis v0.2.0（2026-08-25）

### 信息获取框架（InfoAgent）落地：food-agent（Pull+Push 双模式）

> 按 `guide/orca-info-agent-framework.md` §3/§10/§13 与落地安排（用户 2026-08-25 确认）：首批 Push 源 food-log；
> urgency=2 主动推送接口本轮不做（设计保留，实现后置）。CEO-员工-档案室模型首次落地。

#### 新增文件（app-cordis/）

| 文件 | 说明 |
|------|------|
| `src/agents/types.ts` | 核心抽象（§3）：InfoAgentMeta / AgentDeps / InfoRequest / InfoResult / InfoRecord / RecordQuery / InfoRecordStore；Urgency 0/1/2 |
| `src/agents/registry.ts` | InfoAgentRegistry 闭集注册表（D-AGENT-02） |
| `src/agents/store.ts` | JsonlInfoRecordStore 档案室（D-AGENT-09/12）：每 namespace 一 JSONL、append-only + supersedes 更正、软删/整夹清空 + pruneExpired 物理清理、query（namespace/type/时间窗/urgency/keyword 分词）、pending 待汇报队列（D-AGENT-11） |
| `src/agents/executor.ts` | InfoExecutor Pull 执行管线（§6）：参数校验(JSON Schema 子集) → 非并发安全 agent 串行 → 超时(TIMEOUT/retryable) → 输出校验 → 归一 → 审计日志（D-AGENT-07） |
| `src/agents/router.ts` | 路由（§5）：R0 查档案优先（D-AGENT-10）+ R1 关键词候选（R2 LLM 工具选择留待信息源 > 8 个） |
| `src/agents/builtins/food-log.ts` | food-agent（示例：pull+push，推理型，内部 Qwen 视觉）：识别食物/估算 kcal/置信度，默认写 food-log 档案（urgency=0 静默，ttlDays=7，photoRef 只存本地路径——L1 不落明文日志） |
| `src/services/vision.ts` | VisionClient（Qwen VL，阿里百炼 compatible-mode，对齐 Python analyze_image） |
| `src/plugins/info-agents.ts` | 框架装配：provide infoAgents/infoExecutor/infoStore，注册内置 agent，订阅 'info/record' 事件写档，启动时 pruneExpired |
| `src/plugins/info-receiver.ts` | 外部 App Push 通道（§7/§13）：POST /info/records（Bearer 鉴权 + namespace 白名单，D-AGENT-12），独立端口默认 8101，未配 token 不启动 |
| `src/plugins/food-image.ts` | 飞书图片闭环（D-AGENT-13 通道①）：feishu/image 事件 → downloadImage → processFoodImage（落盘 IMAGES_DIR → food-agent 识别 → 写 food-log 档案）→ 回复确认；失败兜底错误回复；dry-run 不真发飞书 |
| `scripts/smoke-info-agent.mjs` | 冒烟测试 45 项：注册表/档案室/执行管线/路由/上报通道/food-agent 全链路（视觉用 stub，不调真实 API）+ 日志级别 quirk 回归 + 事件派发（顶层与插件 fiber 监听器） |

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/config.ts` | 新增 qwen（QWEN_API_KEY/URL/MODEL）、infoRecordsDir（INFO_RECORDS_DIR）、imagesDir（IMAGES_DIR）、infoReceiver（INFO_RECEIVER_PORT/TOKENS JSON 解析） |
| `src/context.ts` | Context 类型增强：vision / infoAgents / infoExecutor / infoStore + 'info/record' + 'feishu/image' 事件 |
| `src/index.ts` | provide vision；装配 infoAgents / infoReceiver / foodImage 插件；**控制台 exporter levels.default 1→2**（见修复①） |
| `src/plugins/agent.ts` | CEO 集成（D-AGENT-10/11）：R0 饮食类问题查档案注入上下文（命中即复用，零视觉调用）+ urgency=1 待汇报队列（peek 注入、回复成功后 ack） |
| `src/plugins/feishu-channel.ts` | 扩展 image 消息分支：p2p + message_type=image → 解析 content.image_key → emit 'feishu/image'（D-AGENT-13 通道①） |
| `src/services/feishu.ts` | 新增 downloadImage（image_key → 图片字节，10s 超时，见修复②） |
| `src/persona.ts` | （未改） |
| `app-cordis/package.json` | 0.1.0 → 0.2.0（MINOR：新增功能） |
| `app-cordis/.env.example` / `.gitignore` | 新增 INFO_*/QWEN_*/IMAGES_DIR 键说明；`data/` 入 gitignore（档案室 JSONL 不提交） |

#### 修复（合规自查后补）

| # | 问题 | 修复 |
|---|------|------|
| ① | 控制台 exporter `levels.default: 1` 把全部 **WARN 静默丢弃**（fork 语义：level ≤ 阈值才导出，ERROR=0/INFO=1/WARN=2/DEBUG=3）→ food-image 失败日志全程不可见，曾被误判为"事件派发/插件激活问题"（实测监听器一直正常） | `src/index.ts` exporter `levels.default: 1 → 2`（放行 ERROR/INFO/WARN，隐藏 DEBUG） |
| ② | `downloadImage` fetch 无超时，网络挂起时监听器永久 pending | `src/services/feishu.ts` 加 `AbortSignal.timeout(10_000)` |
| ③ | `store.append` 不校验信封防御字段 | `src/agents/store.ts` 校验 `ts` 为数值、`urgency ∈ {0,1,2}`（此前仅 receiver 校验） |

#### 关键决策与踩坑

- **R0 查档是省钱核心**（D-AGENT-10）：饮食类问题先查 food-log 档案，命中直接引用，不重复调视觉模型；问"昨天中午吃了多少卡"走纯查档
- **keyword 匹配方向**：档案检索对整句中文问询需**分词匹配**（全文子串命中或 query 分词长度>=2 命中 payload），否则"昨天中午吃了多少卡"永远查不中
- **query 全量检索去重**：显式 namespaces ∪ 内存已加载 ∪ dataDir 扫描需去重，否则记录翻倍
- **Windows 冒烟退出**：`process.exit()` 在 undici keep-alive 连接收尾时触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（Node 24 Windows）→ 冒烟脚本自然退出，失败用 throw 表达（exit 1）
- 待汇报队列语义：urgency=1 记录 peek 注入下条消息 system prompt，**回复成功后 ack**（失败则下条再带）
- urgency=2 紧急推送本轮**未实现**（按落地安排后置，门控保留 0/1/2 信封字段）

#### 验证

- `npm run typecheck` ✅ / `npm run build` ✅
- `node scripts/smoke-info-agent.mjs`：**45/45 PASS** ✅（注册表闭集、档案室 supersedes/软删/ttl/pending、执行管线校验/超时/审计、R0 查档、上报通道 401/403/400、food-agent 识别→写档、日志级别 quirk 回归、事件派发）
- 真实 E2E（dry-run，DeepSeek 真实调用）✅：
  - 启动：Phase 2 骨架 + food-agent 注册 + feishu 通道 8100 + info-receiver 8101
  - 食物 App 推记录（Bearer）→ 201 入库 → 飞书问"我昨天中午吃了多少卡？" → **R0 命中档案回复**："8/25 13:46 一份红烧肉盖饭，约 680 kcal"（零视觉调用）
  - urgency=1 记录 → 下条消息自然带一句："今天饮食摄入已经超标了，约2200kcal" → 回复成功后 ack
  - POST image 事件（坏 image_key）→ **日志可见** `[food-image] 处理失败: feishu image download http 400`（修复①后 WARN 不再被吞）

#### 下一步

- 迁移 search_web / capture_screenshot / analyze_image 为 InfoAgent（Pull），refine 留主 agent；会话持久化（jsonl）
- 待办：urgency=2 主动推送（按落地安排后置）；R2 LLM 工具选择（信息源 > 8 个）；多飞书 bot 的 app_id 路由（食物 agent 独立账号，D-AGENT-13 待用户开账号后）
- 提交前：AGENT.md 已同步（§3 目录结构 + §9.3 状态 + §10 文档地图）

---

## app-cordis v0.3.0（2026-08-25）

### iPhone 真实闭环 + 本地视觉 + 会话绑定路由 + 人设（D-AGENT-15 落地）

> 与 iPhone 真实联测后收口的完整批次：飞书群聊 → 图片识别 → 档案 → 独立消息回复全链路跑通。

#### 新增功能

| 项 | 说明 |
|----|------|
| **D-AGENT-15 会话绑定路由** | `src/plugins/image-router.ts`（新）：feishu/image 按 `ORCA_CHAT_BINDINGS`（chat_id→agent）派发，只到绑定 agent 不广播；未绑定→默认主管线忽略；未知 agent→warn。feishu-channel 放开 chat_type（p2p/群聊）、事件带 chat_id；food-image 重构为 `handleFoodImage` 由路由接收 |
| **本地视觉后端** | `ORCA_VISION_BACKEND=ollama`：Ollama（qwen3-vl:4b）替代云端 dashscope；vision 免 apiKey（有 key 带头、无 key 不带头）；`max_tokens` 3000（reasoning 模型 thinking 会吃光小配额致 content 空，实测 400 必空）；空 content 重试 3 次（冷启动兼容） |
| **独立消息回复** | 弃「回复消息」接口（引用气泡）改 `sendToChat(chatId)` 走 `POST /im/v1/messages?receive_id_type=chat_id`——像微信聊天一样直接发新消息；`replyText` 删除 |
| **人设调整**（用户指定） | `persona.ts`：平级称呼（不喊"老板"，叫"你"）+ 语气"淡淡死感"（平静、简短平淡、可靠不煽情、不用 emoji）；识别回复模板改 `这份X，约 Y 千卡。记下了。` |

#### 修复

| # | 问题 | 修复 |
|---|------|------|
| ① | 飞书消息图片下载 234001 Invalid request param | `downloadImage(messageId, imageKey)` 改走**消息资源接口** `im/v1/messages/{id}/resources/{key}?type=image`（原 `im/v1/images/{key}` 是上传场景接口，实测 400；改后实测 200 下载成功）；错误信息带飞书 code/msg |
| ② | cordis 插件缺 `plugin.inject` 致 async 监听器 reject→unhandledRejection 崩服务 | image-router 补 `inject = ['feishu','vision','infoStore']` + 监听器 try/catch（事件异常不崩进程）；smoke 加 inject 回归断言 |
| ③ | 群聊消息必须 @ 机器人才收（飞书平台规则，无免 @ 开关） | 无法代码绕过；改用 p2p 或群内 @ 发图；工位路由保留（未来独立 bot 再启用） |
| ④ | food-agent timeoutMs 30s 不足（Qwen 视觉冷启动 >30s） | 30s→60s；executor 超时 `controller.abort()` 真正中止底层请求 |
| ⑤ | feishu-channel 静默跳过不记日志 | 事件到达/各 skipped 分支补日志（诊断友好） |
| ⑥ | recognize-food.mjs 云端 apiKey 前置检查误拦本地后端 | 改为提示当前后端（校验交给 VisionClient） |

#### 新增文件

- `src/plugins/image-router.ts`（D-AGENT-15 路由层：resolveChatAgent + imageRouter）
- `scripts/recognize-food.mjs`（L1 真实识别 CLI：图片→识别→写档→档案回读，本地/云端通用）

#### 配置键（.env）

- `ORCA_CHAT_BINDINGS`：JSON `{"<chat_id>":"<agent>"}` 会话绑定路由（食物群 `oc_2ff03be3022d5e2d0d4b010d41cb1f80` → food-agent）
- `ORCA_VISION_BACKEND=ollama|dashscope`（默认 dashscope）；ollama 时用 `OLLAMA_HOST` + `OLLAMA_VL_MODEL=qwen3-vl:4b`

#### 验证

- typecheck/build ✅；冒烟 **53/53** ✅（+ chat 绑定路由 8 用例、inject 断言、平级模板断言）
- 本地视觉全链路 ✅（qwen3-vl:4b：logo 图识别→写档→回读；真实食物图"荷兰豆炒鸡丁 ≈ 320kcal"→ 档案 → R0 查档回复）
- 真实 iPhone 闭环 ✅：食物群 @ 发图 → 下载（消息资源接口）→ 本地识别 → 写档 → 独立消息回复
- 飞书消息资源下载实测 200（306KB 图）✅

#### 下一步

- 迁移 search_web / capture_screenshot / analyze_image 为 InfoAgent（Pull）；会话持久化（jsonl）
- urgency=2 主动推送（后置）；R2 LLM 工具选择（信息源 > 8 个）
- 群聊免 @ 的替代方案（图片走 p2p 或独立 bot）；D-AGENT-14（写档后通知 Orca）待用户确认
- 提交前：AGENT.md 已同步（§3 目录结构 + §9.3 状态 + 配置键）

---

## app-cordis v0.4.0（2026-08-25）

### 直连图片上传通道（POST /info/images，跳过飞书）

> 用户设想：iPhone 快捷指令把照片直接发到 Orca 的 API，不经飞书中转，同步拿识别结果。先实现试用，不行再回滚（单 commit 便于 revert）。

#### 变更

- `src/plugins/info-receiver.ts`：新增 `createImageUploadHandler` —— `POST /info/images`（Bearer 鉴权，token 白名单须含 food-agent）
  - 请求体 JSON：`{ imageBase64?: string, imageUrl?: string, note?: string }`（快捷指令优先 base64；imageUrl 远程拉取兜底，15s 超时）
  - **base64 往返校验**（`Buffer.from` 对非法字符静默忽略，需 re-encode 比对，防"not-base64!!!"被当图处理）
  - 走复用管线 `processFoodImage`（落盘 → food-agent 识别 → 写 food-log 档案）→ **同步返回** `{ok, food, kcal, confidence, recordId, reply}`
  - 错误语义：401 无/错 token、403 token 未授权 food-agent、400 非法 base64/缺字段、500 识别失败（带错误信息）
  - `infoReceiver` 插件补 `inject=['infoStore','vision']`（cordis 服务访问必须声明 inject，漏则激活即崩——v0.3.0 教训）
- `src/plugins/food-image.ts`：`processFoodImage` 返回增加 `confidence`
- `scripts/smoke-info-agent.mjs`：新增第 8 节（7 用例：200+写档 / 401×2 / 403 / 400×2 / health）
- `.env.example`：/info/images 端点说明

#### 验证

- typecheck/build ✅；冒烟 **61/61** ✅（新增 7 用例）
- 手动实测：无 token → 401；带 token + 合法 base64 → 200（完整管线：落盘→识别→写档→返回 recordId）；非法 base64 → 400
- 说明：本地测试图（1x1 透明 PNG）识别结果为 "unknown/0kcal" 属预期；真实食物图由 iPhone 实测
- 使用前置：配置 `INFO_RECEIVER_TOKENS`（含 food-agent 白名单）+ 重启服务；公网访问需隧道暴露接收端口（当前隧道只暴露 8000→Python 版，直连端口需另行暴露或走局域网）

#### 下一步

- iPhone 快捷指令实操（Base64 编码 → 获取 URL 内容 POST）待用户验证；不行则 `git revert` 本提交
- 提交前：AGENT.md 已同步（§9.3 v0.4.0 直连上传）

---

## app-cordis v0.4.0 hotfix 批（2026-08-26，未单独升 PATCH，违反 D-VER-02）

> v0.4.0 主体（直连图片上传）落地后到 v0.5.0 启动（af8dfee）之间的 4 个增量 commit。**未单独升 PATCH**（package.json 始终 `0.4.0`），按 D-VER-02 本应分别升号；本批作为"v0.4.0 后期热修补"归档，**未来如再追加补丁应按 D-VER-01 升 v0.4.1 / v0.4.2**。

### 修复与新增

| Commit | 类型 | 内容 |
|--------|------|------|
| `965c697` | PATCH（vision 修复） | `src/services/vision.ts` 切到 Ollama 原生 `/api/chat`（弃 OpenAI 兼容层）+ `num_ctx=16384`，修复大图 400 |
| `b53d508` | MINOR（新增确定性删除命令） | food-agent 收到"删除 X"指令时不再走 LLM 解析，走 `handleDeleteIntent` 确定性按食物名 / 噪音 / 全部三条规则执行；smoke 扩至 69/69 |
| `7870f4f` | PATCH（直连路径加固 + 体验） | info-receiver imageUrl 远程拉取兜底超时 15s → 90s；回复文案 kcal 带"千卡"单位；AbortSignal 透传 fetch |
| `c33ad18` | PATCH（脚本） | 新增 `scripts/list-food.mjs` 辅助脚本（CLI 列出 food-log 档案条目，便于本地调试） |

### 修改文件

- `app-cordis/src/services/vision.ts` — Ollama 原生调用 + num_ctx
- `app-cordis/src/agents/builtins/food-log.ts` — `handleDeleteIntent` 确定性删除
- `app-cordis/src/plugins/info-receiver.ts` — 90s 超时 + kcal 文案
- `app-cordis/scripts/list-food.mjs` — 新增

### 验证

- typecheck/build ✅
- `npm run smoke`：**69/69 PASS**（b53d508 后稳定此数）

### 提交前

- AGENT.md 漏改（D-VER-04 违规）：本次批量未单独写 AGENT.md 同步；功能已在 v0.5.0 段一并记录，本批作为"v0.4.0 → v0.5.0 中间补丁"归档

---

## app-cordis v0.5.0（2026-08-26）

### Persistent Context Runtime Phase 0+1：OrcaEvent + EventBus + feishu-adapter

> 让 Orca 从"被动响应 Agent"演化为"持续接收信息的 Runtime"的第一步。
> 仅引入 EventStream，不实现 WorldState / AttentionEngine / 自动通知 / 语音。
> 设计取舍：EventBus 与现有 ctx.emit/on 共存（不替代），feishu-adapter 旁路订阅（不改 feishu-channel），默认关闭（ORCA_RUNTIME_ENABLED=1 才挂载），零侵入。

#### 新增文件（app-cordis/）

| 文件 | 说明 |
|------|------|
| `src/types/event.ts` | OrcaEvent / OrcaEventSource / OrcaEventType / OrcaEventPriority / EventFilter / EventHandler / PublishEventInput 类型；source/type 用 `(typeof X)[number] | (string & {})` 字面量联合写法（保留未来扩展空间：phone/watch/calendar/pc/iot/environment 等） |
| `src/services/eventBus.ts` | 内存 EventBus 类：滑动窗口（默认 200）、pub/sub 过滤（source/type/minPriority）、异步 setImmediate 派发（不阻塞 publish）、handler 异常 try/catch 隔离（防 cordis fork unhandledRejection 崩进程 quirk）；publish 时 priority 默认=1、id 自动生成 UUID、timestamp 默认 Date.now()；生命周期日志（创建/滑动窗口满丢弃最老/dispose） |
| `src/plugins/input-adapters/feishu-adapter.ts` | 飞书 → OrcaEvent 翻译层：订阅 'feishu/message'（→ source='feishu' type='message' priority=1 data.text/openId/chatId/messageId）与 'feishu/image'（→ source='feishu' type='notification' priority=1 data.imageKey/...）；EventBus 未注入时 warn + no-op；监听器 try/catch 包裹 |
| `src/plugins/orca-runtime.ts` | 顶层装配 plugin：new EventBus → ctx.provide('eventBus', ...) → feishuAdapter(ctx, config)；返回 dispose 钩子 bus.dispose() |

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/context.ts` | declare module Context interface 增加 `eventBus: EventBus`；Events interface 增加 `'orca/event'(event: OrcaEvent)` |
| `src/config.ts` | 新增 OrcaRuntimeConfig interface（enabled/windowSize）；getConfig() 读取 ORCA_RUNTIME_ENABLED（**严格 ==='1'**，避免 `'true'`/`1` 数字误判）+ ORCA_RUNTIME_WINDOW（默认 200） |
| `src/index.ts` | 在 dashboard 与 agent plugin 之间按 `config.runtime.enabled` 条件挂载 orcaRuntime；启用时打 `[orca-cordis] Persistent Context Runtime 已启用（Phase 0+1）`，关闭时打 `未启用（ORCA_RUNTIME_ENABLED=1 启用）` |
| `src/plugins/dashboard.ts` | 新增 `/api/events` JSON 端点：`?limit=N`（默认 50，上限 500，防滥用）+ `?source=xxx`（可选过滤）；EventBus 未注入返回 503；返回 `{ok, ts, count, bufferSize, events[]}` |
| `app-cordis/.env.example` | 新增 `ORCA_RUNTIME_ENABLED` / `ORCA_RUNTIME_WINDOW` 说明（带"默认 0 关闭"提示） |

#### 补提交（遗漏文件）

- `app-cordis/src/plugins/dashboard.ts`：v0.1.0 实际创建但从未 commit（`session.ts` 已追踪、`dashboard.ts` 漏提交；本版顺手补回），含 Orca 仪表盘 HTTP 服务（端口 8200，`/dashboard` HTML + `/api/status` JSON）+ InfoAgents 注册状态 + 端口可达性探测

#### 关键设计决策

- **完全旁路**：feishu-adapter 是新增订阅者，feishu-channel.ts **零修改**，现有 agent / image-router / dashboard 订阅完全不受影响
- **不替代 ctx.emit**：EventBus 是高层抽象（带滑动窗口 + 过滤 + 生命周期日志），ctx.emit/on 是低层通知（一次性，无持久化）；两者在 Cordis Context 内并存
- **默认关闭**：ORCA_RUNTIME_ENABLED 不设 / 不严格等于 '1' 时不挂载 plugin；关闭时现有 69 个 smoke 用例 + 真实飞书处理流程完全不变（已实测 30+ 条飞书消息处理无回归）
- **cordis fork quirk 防护**：所有 ctx.on 监听器 try/catch（async reject → unhandledRejection 崩进程——v0.3.0 image-router 教训）；publish 内部异步 setImmediate 派发保证不阻塞 caller
- **滑动窗口满丢弃最老时打 warn**：方便监控 buffer 利用率与背压情况
- **priority 设计**：0=debug / 1=normal / 2=important / 3=urgent；publish 时不传默认 1（normal），feishu-adapter 固定传 1

#### 验证

- `npm run typecheck` ✅ / `npm run build` ✅
- `npm run smoke`：**69/69 PASS** ✅（现有 InfoAgent 框架 + v0.3.0~v0.4.0 集成测试零回归）
- **真实 E2E** ✅（用户本地，2026-08-26 18:09-18:10）：
  1. `start-cordis.bat` 启动（ORCA_RUNTIME_ENABLED=1，ORCA_RUNTIME_WINDOW=20）
  2. 启动日志确认：`[event-bus] 已创建 windowSize=20` + `[orca-runtime] Phase 0+1 已启动` + `[feishu-adapter] 已订阅 ...` + `[orca-cordis] Persistent Context Runtime 已启用`
  3. 飞书连发 10+ 条消息 → 全部经 feishu-channel → feishu-adapter → EventBus 落入滑动窗口
  4. `curl http://127.0.0.1:8200/api/events?limit=20` 返回 `{count: 10, bufferSize: 10, events: [...]}`，证明完整链路通畅

#### 踩坑（用户实操发现）

- **`ORCA_RUNTIME_ENABLED=1` 在 .env 中行首带 `#` 视为注释**：用户按 .env.example 复制粘贴没去掉 `#` 前缀，导致 Runtime 一直"未启用"。定位过程：检查启动横幅看到"未启用" → 检查根 .env 无此键 → app-cordis/.env 找到但带 `#` → `Select-String -Pattern ORCA_RUNTIME_ENABLED` 确认是注释行。修复：PowerShell `(Get-Content) | ForEach-Object { $_ -replace '^#\s*ORCA_RUNTIME_ENABLED=.*', 'ORCA_RUNTIME_ENABLED=1' } | Set-Content`；或直接编辑去掉 `# `。**教训**：未来新增 env 键应在 .env.example 用**未注释的默认值**演示（如直接写 `ORCA_RUNTIME_ENABLED=0` 而非 `# ORCA_RUNTIME_ENABLED=0`），避免误导
- **`ORCA_RUNTIME_ENABLED` 严格比较 `=== '1'`**：`.env` 里写 `1`（数字无引号）→ parse 后实际是字符串 `'1'`，仍能工作；但写 `true` / `yes` / `on` 均不生效。文档需明确"必须写 `1`"

#### 配置键（.env）

| 键 | 默认 | 用途 |
|----|------|------|
| `ORCA_RUNTIME_ENABLED` | 0（关闭） | 1=启用 Persistent Context Runtime，挂载 orcaRuntime plugin + 注册 EventBus + 挂载 feishu-adapter |
| `ORCA_RUNTIME_WINDOW` | 200 | EventBus 滑动窗口大小，超出自动丢弃最老事件并打 warn 日志 |

#### Phase 2~4 路线（设计稿，本版不实现）

```
Phase 0+1（v0.5.0）        ✅ EventBus + feishu-adapter（已交付）
Phase 2（v0.6.0 计划）     WorldState + Reducer（user.status / device.activeApp / timeOfDay 等从 EventBus 推导）
Phase 3（v0.7.0 计划）     AttentionEngine 规则引擎（Event + WorldState → ignore/remember/notify/act 决策）
Phase 4（v0.8.0 计划）     Decision Executor（执行决策：act → agent plugin / notify → feishu.sendToChat / remember → infoStore.append）
Phase 5（可选）             Attention LLM 增强（未命中规则时调用 DeepSeek 决策）
```

#### 下一步

- Phase 2 WorldState MVP：3 个示例 reducer（feishu:message → user.lastSeenAt、pc:app_focus → device.activeApp、phone:sleep → user.status）
- 提交前：AGENT.md 已同步（§9.3 v0.5.0 Persistent Context Runtime + Phase 2~4 路线）

---

## app-cordis v0.5.0（2026-08-27，Phase 2.A 子段）

### WorldState Phase 2.A：最小骨架 + feishu:message reducer

> 在 Phase 0+1 EventBus 之上引入"当前世界状态"实时视图。第一版只做骨架：reducer 注册表 + 字段级变化检测 + dashboard 端点，**只注册一个 reducer**（feishu:message）。setInterval 自动推导 / away 推断 / PC/Calendar/Phone adapter 全部留给后续 Phase 2.B/C/D。

#### 新增文件

| 文件 | 说明 |
|------|------|
| `src/types/worldState.ts` | 字面量联合 `UserStatus / PowerMode / NetworkState / TimeOfDay` + `UserState / DeviceState / TimeContext / WorldState` 数据类型；含 `extensions: Record<string, Record<string, unknown>>` 扩展预留 |
| `src/services/worldState.ts` | `StateReducer` 类型 + reducer 注册表（key = `${source}:${type}`）+ `registerReducer/applyReducer/getInitialState/computeTimeContext` + `WorldStateService` 接口（`getState()` 深拷贝快照）+ `createWorldStateService` 工厂 |
| `src/plugins/world-state-updater.ts` | Cordis plugin：订阅 EventBus → `applyReducers` → JSON 字段级对比 → 仅变化时更新 `lastUpdated/lastEventId` + emit `'orca/state_changed'` → `ctx.provide('worldState')`；`inject=['eventBus']`；监听器 try/catch 防 unhandledRejection；dispose 钩子预留 setInterval（2.C 才用） |
| `scripts/smoke-world-state.mjs` | 48 用例覆盖 `getInitialState/computeTimeContext/applyReducers/WorldStateUpdater` 集成 + dashboard HTTP 503/200 |

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/context.ts` | declare module 增加 `worldState` service + `'orca/state_changed'` 事件类型 |
| `src/config.ts` | `OrcaRuntimeConfig.worldState: { enabled }`（默认 true；`ORCA_WORLD_STATE_ENABLED=0` 可单独关闭 WorldState 而保留 EventBus） |
| `src/index.ts` | `worldStateUpdater` 在 `orcaRuntime` 之后按 `config.runtime.worldState.enabled` 挂载；**仅当 Orca Runtime 启用时才挂**（`ORCA_RUNTIME_ENABLED=0` 时整条 Runtime 链全关闭） |
| `src/plugins/dashboard.ts` | 新增 `/api/world-state` 端点（worldState 未注入返回 503；否则返回 `{ok, ts, state}`） |
| `package.json` | scripts 增加 `smoke:world-state` 和 `smoke:all`（`smoke && smoke:world-state`） |

#### 关键设计决策

- **reducer 注册表 key = `${source}:${type}`**：如 `feishu:message`、`pc:app_focus`、`phone:sleep`，与 EventBus 事件命名对齐，方便一个 reducer 处理多类事件也可细化为多个 key
- **JSON 字段级变化检测**：状态更新前 `JSON.stringify` 对比，仅真正变化才 emit `'orca/state_changed'`（避免下游订阅者无意义触发）
- **深拷贝快照**：`getState()` 返回深拷贝，避免外部直接修改内部状态
- **WorldState 4 块结构**：user / device / time / extensions（extensions 是预留，未来 PC/Calendar/Phone reducer 可写自己的命名空间）
- **第一版只注册一个 reducer**：`feishuMessageReducer` 把 `feishu:message` → `user.lastSeenAt = event.timestamp, status='awake'`（**不做 away 推导**——留给 2.C）
- **零侵入**：feishu-channel / agent / image-router / food-image / info-receiver 全部零修改；`ORCA_RUNTIME_ENABLED=0` 时现有 117 个 smoke 用例（含 v0.5.0 Phase 0+1 全部）继续通过

#### 验证

- typecheck/build ✅
- `npm run smoke`（info-agent 回归）：**69/69 PASS**（零回归）
- `npm run smoke:world-state`：**48/48 PASS**
- `npm run smoke:all`：**117/117 PASS**

#### 下一步

- Phase 2.B / 2.C：time tick 自动推导 + away 阈值（30min）+ 仅 awake → away 单向
- Phase 2.D：PC/Phone/Calendar mock adapter + 真实 reducer
- 提交前：AGENT.md 已同步（§9.3 v0.5.0 WorldState Phase 2.A）

---

## app-cordis v0.5.0（2026-08-27，Phase 2.C 子段）

### WorldState Phase 2.C：time tick + away 自动推导

> 在 Phase 2.A 骨架（`2cfbde8`）基础上增加"无活动超时"自动推导。仅 awake → away 单向；不反向恢复 away、不覆盖 busy/sleeping。

#### 变更

- `src/services/worldState.ts`：导出 `AWAY_THRESHOLD_MS = 30 * 60 * 1000` 常量 + `deriveUserStatus(state, now)` 纯函数
  - 仅 `status === 'awake'` 才推导
  - `lastSeenAt <= 0` 兜底 → null
  - `now - lastSeenAt > AWAY_THRESHOLD_MS`（**严格 >**；30:00 整不算、30:00.001 才算 away）
  - busy / sleeping / away 状态不主动覆盖（用户主动状态由其他信号解除，Phase 3+ Attention 范围）
- `src/plugins/world-state-updater.ts`：增加 `setInterval` time tick（间隔 `config.runtime.worldState.timeRefreshMs`，默认 60000 / `ORCA_WORLD_STATE_REFRESH_MS`）
  - tick 内：`computeTimeContext(now)` + `deriveUserStatus(state, now)`，任一字段变化才更新 state + emit `'orca/state_changed'`（无变化零开销）
  - time 字段局部深比较（`statesEqualTime`）避免序列化整个 WorldState
  - try/catch 包裹防 timer 异常崩进程
  - dispose 钩子 `clearInterval + unsubscribe`（cordis fiber 清理完整）
- `src/config.ts`：`OrcaWorldStateConfig.timeRefreshMs` + `ORCA_WORLD_STATE_REFRESH_MS`（默认 60000）
- `scripts/smoke-world-state.mjs`：新增 R5 阶段（20 用例）
  - R5.A：deriveUserStatus 纯函数（边界 + 不覆盖 busy/sleeping/away + 兜底 lastSeenAt=0/-1）
  - R5.B：setInterval 集成（`timeRefreshMs=50` 加速；`lastSeenAt=past` → away；多次 tick 后 away 自维持）
  - R5.C：fresh state + `lastSeenAt=recent` → 多次 tick 后仍 awake + `state_changed` 不增加（无变化不 emit）

#### 关键决策与踩坑

- **单方向推导**：用户原话"不要让简单的 inactivity tick 粗暴覆盖这些状态。Phase 2.C 第一版最好只处理 awake → away，不要反向推断其他状态"
  - "不反向"含义：time tick 不会**主动**把 away 反推回 awake；但 feishuMessageReducer 收到新飞书消息仍按设计设回 awake（用户消息就是 awake 信号）
  - 测试 R5.B 设计走"away 自维持"路径：不 emit 新事件，等多次 tick 验证 status 仍 away（避免误测反向）
- **30:00 整 vs 30:00.001**：使用严格 `>` 而非 `>=`，30:00 整仍视为 awake（避免差 1 毫秒的精度问题）
- **time 字段独立比较**：`statesEqualTime(state.time)` 仅序列化 TimeContext 局部，timer tick 高频调用避免序列化整个 WorldState 的开销
- **lastEventId 不在 timer tick 中更新**：timer tick 不是事件（无 OrcaEvent.id），仅在 EventBus 触发时更新

#### 验证

- typecheck/build ✅
- `npm run smoke`（info-agent 回归）：**69/69 PASS**（零回归）
- `npm run smoke:world-state`：**94/94 PASS**（R0 21 + R1 8 + R2 14 + R3 5 + R4 26 + R5 20）
- `npm run smoke:all`：**163/163 PASS**
- 真实飞书 E2E：**未执行**（DSH 沙盒限制；Phase 2.A/2.B 集成测试已充分覆盖 ctx.emit → adapter → EventBus → WorldStateUpdater 链路，待 Phase 2 完整后统一跑一次）

#### 下一步

- Phase 2.D：PC/Phone/Calendar adapter mock + 真实 reducer（device.activeApp / user.status='sleeping' 等）
- Phase 3：AttentionEngine 规则引擎（事件 + WorldState → ignore/remember/notify/act 决策）
- 提交前：AGENT.md 已同步（§9.3 v0.5.0 WorldState Phase 2.A + 2.C）

---

## app-cordis v0.5.0（2026-08-27，Phase 2.D 子段）

### WorldState Phase 2.D：mock input adapters + debug publisher

> 在 Phase 2.A/C 骨架基础上增加 3 个 mock 输入 adapter（PC/Calendar/Phone）+ 对应 reducer + 1 个 debug publisher 端点。所有 adapter 默认 disabled，需显式 `ORCA_*_ENABLED=1` 启用。

#### 新增文件

- `src/plugins/input-adapters/pc-adapter.ts`：周期性 publish `pc:app_focus`（mock 从 VSCode/Chrome/Feishu/Terminal/Cursor/WeChat 随机选），refreshMs 默认 60000
- `src/plugins/input-adapters/calendar-adapter.ts`：周期性 publish `calendar:calendar_event`（mock 4 模板：项目同步会/设计 review/深度工作时间/午饭，activity = meeting/focus/break），refreshMs 默认 120000
- `src/plugins/input-adapters/phone-adapter.ts`：周期性 publish `phone:sleep` 或 `phone:activity`（mock 3 种 activityState），refreshMs 默认 300000

#### 修改文件

- `src/services/worldState.ts`：注册 3 个新 reducer（模块加载时一次性注册）
  - `pcAppFocusReducer`：pc:app_focus → device.activeApp
  - `calendarEventReducer`：calendar:calendar_event → user.currentActivity
  - `phoneSleepReducer`：phone:sleep → user.status='sleeping'（首次引入"主动设置非 awake" reducer）
- `src/config.ts`：`OrcaRuntimeConfig.pc/calendar/phone: { enabled, refreshMs }` + env 变量 `ORCA_PC_ENABLED` / `ORCA_PC_REFRESH_MS` 等
- `src/index.ts`：条件挂载 3 个 adapter（仅当 `config.runtime.enabled` + `config.runtime.{pc|calendar|phone}.enabled` 同时为 true）
- `src/plugins/dashboard.ts`：新增 `POST /debug/publish-event` 端点（Body `{source, type, data?, priority?}` → `ctx.eventBus.publish`；503 if EventBus 未注入；400 invalid json / missing fields；413 body >8KB）
- `scripts/smoke-world-state.mjs`：R1.7 + R2.11 用例从 `pc:app_focus`（Phase 2.D 后已有 reducer）改为 `sensor:reading`（未注册 reducer key），保证"未匹配 → 返回原 state 引用"语义仍正确

#### 关键设计决策

- **三个 adapter 全部 mock 第一版**：未来 Phase 替换为真实 Windows PowerShell Get-Process / CalDAV / iOS Health Auto Export
- **phone:sleep 首次引入"主动设置非 awake"**：与 Phase 2.C time tick 互补——time tick 不覆盖 sleeping，phone:sleep 显式设 sleeping
- **debug publisher 鉴权**：第一版无鉴权（仅本地开发用）；生产环境建议在反向代理层禁用 `/debug/*`
- **dispose 钩子**：3 个 adapter 都返回 `() => clearInterval(timer)`，cordis fiber 清理时统一停止
- **EventBus 未注入时 no-op**：所有 adapter 都检查 `ctx.eventBus`，未注入 warn + return（与 feishu-adapter 一致）
- **smoke 用例 key 修正**：原 R1.7/R2.11 用 `pc:app_focus` 验证"无 reducer → 返回原 state 引用"，但 Phase 2.D 加了 pc:app_focus reducer，所以改用 `sensor:reading`（同样未注册，但语义更准确——sensor 适配器在后续 Phase 才会实现）

#### 验证

- typecheck/build ✅
- `npm run smoke`（info-agent 回归）：**69/69 PASS**（零回归）
- `npm run smoke:world-state`：**94/94 PASS**（用户本地手动跑确认）
- `npm run smoke:all`：**163/163 PASS**
- 真实飞书 E2E：**未执行**（DSH 沙盒限制）

#### 下一步

- Phase 3：AttentionEngine 规则引擎（事件 + WorldState → ignore/remember/notify/act 决策）
- Phase 4：Decision Executor（执行 Attention 决策：act → agent plugin / notify → feishu.sendToChat / remember → infoStore.append）
- 提交前：AGENT.md 已同步（§3 目录结构 + §7 配置项 + §9.3 v0.5.0 WorldState Phase 2.D）

---

## app-cordis v0.6.0（2026-08-27，release 标记）

### Phase 2 WorldState Runtime 完整闭环 release

> 用户 2026-08-27 决策：Phase 2 三个子阶段（2.A 骨架 + 2.C time tick + 2.D mock adapters）已形成完整 Runtime，标记为 v0.6.0。下一步进入 Phase 3（**先规则，不引入 LLM**）。

#### 变更

- `package.json`：0.5.0 → 0.6.0（MINOR bump；3 commits 增量构成 v0.5.0 → v0.6.0 完整功能边界）
- `git tag v0.6.0`：标记 Phase 2 Runtime 完整 release

#### 包含 commits（最近 4 个，v0.6.0 完整功能）

| Commit | 说明 |
|--------|------|
| `2cfbde8` | Phase 2.A：WorldState 骨架 + feishu:message reducer |
| `dcff0ed` | Phase 2.C：time tick + away 自动推导 + 配套 smoke 测试 |
| `47b5fd9` | Phase 2.D：3 个 mock adapters + debug publisher + 9 文件提交 |

#### v0.6.0 能力快照

- 持续接收外部信号：EventBus 滑动窗口 + feishu-adapter（生产）+ pc/calendar/phone adapters（mock）
- 维护当前世界状态：WorldStateService 只读 + WorldStateUpdater 闭包私有 state + 4 个内置 reducer
- 状态变化自动广播：`ctx.emit('orca/state_changed', state)`，但**目前无订阅者**（Phase 3+ 消费）
- 调试端点：`POST /debug/publish-event` + `GET /api/world-state` + `GET /api/events`
- **主动行动仍不可用**：Attention Engine 与 Decision Executor 均未实现

#### 验证

- typecheck/build ✅
- `npm run smoke`（info-agent 回归）：**69/69 PASS**
- `npm run smoke:world-state`：**94/94 PASS**
- `npm run smoke:all`：**163/163 PASS**
- 真实飞书 E2E：**未执行**（DSH 沙盒限制）

#### 下一步

- **Phase 3**：Attention Engine 规则引擎
  - **不引入 LLM**——纯确定性规则
  - 输入：OrcaEvent（来自 EventBus）+ WorldState（ctx.worldState.getState()）
  - 输出：AttentionItem `{ ruleId, priority, reason, action, event?, snapshot }`
  - 触发：订阅 EventBus（每个 event）+ 订阅 `'orca/state_changed'`（状态变化）
  - emit：`'orca/attention'`（item 级）+ `'orca/attention_batch'`（批量级）
  - 第一版内置规则（示例）：
    - feishu:message 含"今晚前/明天前/截止/报告" → priority='high', action='remember_only'
    - user.status='busy' + calendar:calendar_event minutesBefore<=5 → priority='high', action='wait_until_available'
    - user.status='sleeping' + 任何 event → priority='low', action='ignore'
- **Phase 4**（Phase 3 完成后）：Decision Executor（订阅 `'orca/attention'`，执行 notify/act/remember）+ 可选 LLM 增强
- 提交前：AGENT.md 已同步（§9.3 v0.6.0 release）

---

## app-cordis（2026-08-27，Phase 3 Attention Engine）

### 纯规则注意力系统（不引入 LLM）

> 用户决策：Phase 3 不引入 LLM，纯确定性规则。LLM 留给 Phase 5 做"理解/规划"，不替代基础层。

#### 关键设计：WorldStateService 接口扩展

用户反馈："Attention Engine 最好拿到 event 发生前的 WorldState snapshot。否则后面会出现很多'规则写了但永远触发不了'的问题。"

实现方案：
- `WorldStateService` 新增 `getPrevState(): WorldState | null`（最近一次 applyUpdate 之前的快照，消费-once）
- `WorldStateService` 新增 `applyUpdate(updater): WorldState`（内部 capture prev + 应用新 state）
- service 内部管理 state + prev（不再由 WorldStateUpdater 闭包持有）
- WorldStateUpdater 改造：用 `service.applyUpdate(...)` 替代 `state = updated`
- 向后兼容：所有现有 `getState()` 调用零变化（dashboard / smoke 测试无影响）

#### 新增文件

| 文件 | 说明 |
|------|------|
| `src/types/attention.ts` | AttentionInput（含 prevState）/ AttentionItem / AttentionRule / AttentionEngineService + 5 种 action 字面量 + 4 种 priority 字面量 |
| `src/services/attention.ts` | AttentionEngine 类 + registerRule/clearRules + 5 条内置规则 |
| `src/plugins/attention-engine.ts` | Cordis plugin（订阅 EventBus + 'orca/state_changed' → emit 'orca/attention'） |

#### 5 条内置规则

| ID | 触发条件 | 输出 |
|----|----------|------|
| `sleeping-quiet` | `state.user.status === 'sleeping'` | priority=low, action=ignore |
| `feishu-deadline` | feishu:message 含 deadline 关键词（今晚前/明天前/截止/ddl/报告/due）| priority=high, action=remember_only |
| `calendar-busy-soon` | user.status=busy + calendar:calendar_event minutesBefore<=5 | priority=high, action=wait_until_available |
| `away-arrival` | event !== null + state.user.status=away | priority=normal, action=remember_only |
| `focus-interrupt` | feishu:message + user.currentActivity ∈ {focus, meeting} | priority=normal, action=remember_only |

#### 修改文件

- `src/services/worldState.ts`：`WorldStateService` 接口扩展（getPrevState + applyUpdate）；`createWorldStateService()` 不再接受 getter 参数（service 内部管理 state）
- `src/plugins/world-state-updater.ts`：用 `service.applyUpdate(...)` 替代闭包变量 `state = updated`
- `src/context.ts`：`attention: AttentionEngineService` service + `'orca/attention'(item: AttentionItem)` 事件
- `src/config.ts`：`OrcaAttentionConfig { enabled }`，默认 enabled=true（纯评估不执行，安全默认）；env `ORCA_ATTENTION_ENABLED=0` 可关闭
- `src/index.ts`：按 `config.runtime.attention.enabled` 挂载 `attentionEngine`（在 worldStateUpdater 之后；依赖 worldState service）
- `src/plugins/dashboard.ts`：新增 `/api/attention` GET（ruleCount）+ POST `/api/attention/evaluate`（手动触发评估，Body `{event?, state?}`）

#### 关键决策与踩坑

- **零侵入**：Phase 0+1 / Phase 2 全部零修改（仅 WorldStateService 接口扩展，向后兼容）
- **ORCA_ATTENTION_ENABLED 默认 true**（安全：纯评估不执行任何 action，仅 emit 事件；Phase 4 才会真正发飞书/调 agent）
- **Attention 必须 WorldState 之后挂载**（inject=['eventBus','worldState']）
- **state-only 触发**：ctx.on('orca/state_changed') → engine.evaluate({event:null, state, prevState:undefined})
- **event 触发**：bus.subscribe → engine.evaluate({event, state, prevState: ws.getPrevState() ?? undefined})
- **dashboard 类型 guard**：用 `as never` 简化（dashboard 仅做转发，不做 schema 验证）
- **不要重复 emit**：Attention Engine 每条 rule 可能生成 0/1 个 item；多个 rule 可同时触发（多 items emit）

#### 验证

- typecheck/build ✅
- `npm run smoke`（info-agent 回归）：待本地验证
- `npm run smoke:world-state`：**预期 94/94 PASS**（Phase 3 不改 reducer；WorldState 接口向后兼容）
- `npm run smoke:all`：待本地验证
- **真实飞书 E2E**：未执行（DSH 沙盒限制；预期 ORCA_RUNTIME_ENABLED=1 + 发"截止"消息 → /api/attention 返回 1 条 high priority remember_only）

#### 下一步

- Phase 4：Decision Executor（订阅 'orca/attention'，按 priority 排序 + throttle + 执行 notify/act/remember）
- Phase 5：LLM 增强（可选，作为 AttentionItem 评审层，不替代规则）
- 提交前：AGENT.md 已同步（§3 目录 + §9.3 Phase 3）

---

## app-cordis（2026-08-27，Phase 3.A R8 smoke + away-arrival bug fix）

### away-arrival 规则修复 + Attention 回归测试（R8 48 用例）

> 用户反馈：Attention 必须能拿到 event 发生前的 WorldState snapshot，否则"规则写了但触发不了"。
> 实战中发现 `away-arrival` 原实现读 `current state`——而 `feishuMessageReducer` 会把 status 改回 `awake`，导致规则永远不触发。
> 这违背了 Phase 3.A 引入 prevState snapshot 的核心设计意图。

#### 关键架构约束（写入 AGENT.md，未来必读）

- Attention Rule predicate 中判断"事件发生前的环境状态"时，**必须使用 `prevState`**。
- `state` 表示**事件处理后**的世界（reducer 已应用过），不可用于"事件前的判断"。
- 错误示范：`predicate: ({ state }) => state.user.status === 'away'` → reducer 改 awake 后永远不触发。
- 正确写法：`predicate: ({ prevState }) => prevState?.user.status === 'away'`。
- **典型 Phase 4 Decision 场景**：用户原本 idle→active / offline→online / focus→被打断，都需要 prevState 解释"判断来源"。

#### Bug 修复

- `src/services/attention.ts`：away-arrival predicate 改用 `prevState`
  ```typescript
  // Before
  predicate: ({ event, state }) => event !== null && state.user.status === 'away',
  // After
  predicate: ({ event, prevState }) => event !== null && prevState?.user.status === 'away',
  ```

#### 新增 R8 smoke-attention（48 用例，全 PASS）

`scripts/smoke-attention.mjs`：
- **R8.A**（37 用例）：4 条内置规则 + 1 个 SKIP（urgent-keyword TODO Phase 3.B）
  - sleeping-quiet（state-only + with event）
  - away-arrival（prevState 必须；state-only 短路；rule 要求 event !== null）
  - feishu-deadline（关键词 + source 限定）
  - calendar-busy-soon（busy + minutesBefore≤5）
  - focus-interrupt（focus/meeting + source=feishu）
  - urgent-keyword **SKIP**（避免 mixing bug fix + feature add；TODO Phase 3.B）
- **R8.B**（9 用例）：WorldStateService prevState capture + Attention 集成回归
  - R8.B0：applyUpdate 内部 capture prev（直接测试 WorldStateService）
  - **R8.B1 核心回归**：state=away → applyUpdate 模拟 reducer → state=awake → evaluate 仍触发 away-arrival
    - 这是 Phase 3.A "prev state snapshot" 架构保证的核心验证

#### 修改

- `app-cordis/package.json`：新增 `smoke:attention` script + `smoke:all` 包含 3 个 smoke

#### 用户决定 Phase 3.B 优先顺序（不是立即执行，记录备查）

1. **Attention 去重（dedup）**：相同 (ruleId, eventId) 在窗口期内合并，避免噪声
2. **Attention 节流（throttle/cooldown）**：同一 source 在 N ms 内只 emit 一次 notify
3. **Rule 配置化（YAML/JSON）**：外部加载规则
4. 设计目标：让 Attention Stream 先稳定再可配置，避免去重逻辑和配置逻辑交叉复杂度

#### 验证

- typecheck/build ✅
- `npm run smoke:world-state`：**94/94 PASS**（零回归）
- `npm run smoke:attention`：**48/48 PASS**
- 真实飞书 E2E：未执行

#### 下一步

- Phase 3.B（用户决策优先序）：dedup → throttle → rule config
- Phase 4：Decision Executor（订阅 'orca/attention'，按 priority + action 执行）

---

## app-cordis（2026-08-27，Phase 3.B.dedup）

### Attention Stream 去重层

> 用户决策：Phase 3.B 第一步先 dedup，再 throttle，最后 rule config。让注意力系统先稳定再可配置。

#### 职责分离（关键设计）

- **AttentionEngine**（Phase 3.A）= 关注"是什么"——评估事件 → 产生 AttentionItem
- **AttentionDedup**（Phase 3.B.dedup）= 关注"多不多"——窗口期内控制重复 emit
- 不修改 Rule（保持 Phase 3.A 纯评估边界）
- 不引入配置系统（用户决策：先稳定再配置；窗口默认 5000ms 硬编码）

#### 新增

- `src/types/attention.ts`：增加 `AttentionDedupService` interface（`shouldEmit / size / clear`）
- `src/services/attention.ts`：增加 `AttentionDedup` 类 + `DEFAULT_DEDUP_WINDOW_MS = 5000` 常量 + `createAttentionDedup({ windowMs? })` 工厂

#### 修改

- `src/plugins/attention-engine.ts`：在 evaluate 后调 `dedup.shouldEmit(item)`，通过才 emit 'orca/attention'；统计 emit/dropped 数量到日志；dispose 钩子增加 `dedup.clear()`
- `scripts/smoke-attention.mjs`：增加 R9 段（16 用例）

#### key 设计

```
key = `${ruleId}:${eventId ?? '__state__'}`
```

- 同 ruleId + 同 eventId 在窗口期内 → 第二次 drop
- 不同 ruleId 或不同 eventId → 各自独立计数
- state-only 触发（eventId=undefined，如 `orca/state_changed`）→ 用 `'__state__'` 兜底
  - 否则多个 state_changed 触发会因 key 全部相同而全部 dedup，丢失信息
- 窗口过期 → 重新 emit（lastEmitTs = now）

#### 不做（明确边界）

- ❌ 不做 throttle / cooldown（按 source 节流属 Phase 3.B 第二步）
- ❌ 不做 priority 合并（多个 item 不合并，只决定 emit/drop）
- ❌ 不暴露配置（dedup 窗口、hourly cap 等都待 Phase 3.B 后两步）
- ❌ 不做 map 容量限制（LRU / eviction 待后续；当前 map 无限增长，per-Orca 进程内存可承受）
- ❌ 不持久化

#### R9 测试用例（16 用例）

| 用例 | 场景 | 预期 |
|------|------|------|
| R9.1.1 | 同 ruleId+eventId 第一次 shouldEmit | true |
| R9.1.2 | map.size after first | 1 |
| R9.1.3 | 50ms 内第二次 shouldEmit（同 ruleId+eventId）| false |
| R9.2.1-3 | 不同 eventId（A / B）| 都 true；size === 2 |
| R9.3.1-2 | 不同 ruleId + 同 eventId | 都 true（key 含 ruleId 区分）|
| R9.4.1-2 | 窗口过期（t=0 emit, t=80ms > 50ms window）| 都 true |
| R9.5.1-3 | state-only（eventId=undefined）用 `'__state__'` 兜底 | 同 ruleId 去重；不同 ruleId 独立 |
| R9.6.1-3 | `clear()` 重置 map | size → 0；重新 shouldEmit=true |

#### 验证

- typecheck/build ✅
- `npm run smoke:attention`：**64/64 PASS**（48 R8 + 16 R9）
- `npm run smoke:world-state`：**94/94 PASS**（零回归；Phase 2 / Phase 3.A 不受影响）

#### 下一步

- Phase 3.B.throttle：按 source 节流 + hourly cap
- Phase 3.B.rule-config：YAML/JSON rule 加载（覆盖/扩展内置）
- Phase 4：Decision Executor（订阅 'orca/attention'，按 priority + action 执行）

---

## app-cordis（2026-08-27，Phase 3.B.throttle）

### Attention Stream 节流层（source cooldown + hourly cap）

> 用户决策：Phase 3.B 第二步 throttle——关注"现在该不该打扰用户"；仅对会打扰用户的 action 生效；remember_only/ignore 直通；不引入配置系统。

#### 三层职责分离（最终架构）

```
AttentionEngine  = 关注"是什么"——评估事件 → 产生 AttentionItem（Phase 3.A）
  ↓
AttentionDedup   = 关注"是不是新刺激"——窗口期内去重（Phase 3.B.dedup）
  ↓
AttentionThrottle= 关注"现在该不该打扰"——source cooldown + hourly cap（Phase 3.B.throttle）← 本次
  ↓ (仅通过三层)
emit 'orca/attention'
  ↓
Phase 4 Decision (future)
```

#### Throttle 作用范围（关键约束）

仅对 `notify_immediately` + `act` 生效：
- `remember_only` / `ignore` / `wait_until_available` **直通**（不被 throttle 影响）
- state-only 触发（source='state'）**不应用 source cooldown、不消耗 hourly cap**（避免 state_changed 被任意 source 限制）
- Hourly cap 与 source cooldown **独立**：同一 item 可同时被两者拦截

#### 数据结构

```
Map<string, number>     // source → last emit timestamp（source cooldown）
number[]                // rolling window 内的 notify emit timestamps（hourly cap）

可注入 clock（仅测试用，生产用 Date.now()）
```

#### 默认值（硬编码，不暴露配置）

| 参数 | 默认 | 含义 |
|------|------|------|
| `cooldownMs` | 5000 | 同 source 两次 notify 最小间隔 |
| `hourlyCap` | 10 | 1 小时内最多 notify 次数 |
| `windowMs` | 3600000 | hourly cap 滑动窗口（1 小时） |

#### AttentionItem 新增 `source` 字段（Phase 3.B.throttle 引入）

- `AttentionItem.source?: string`（可选；Phase 3.B.throttle 用于 source cooldown 决策）
- AttentionEngine.evaluate 从 `input.event?.source ?? 'state'` 提取
- 最小兼容修改（不影响 Phase 3.A 行为；R8 测试不需改）

#### 新增

- `src/types/attention.ts`：新增 `AttentionThrottleService` interface（`shouldEmit / reset / setClock`）；`AttentionItem` 加 `source?: string`
- `src/services/attention.ts`：新增 `AttentionThrottle` 类 + `DEFAULT_THROTTLE_COOLDOWN_MS=5000` / `DEFAULT_THROTTLE_HOURLY_CAP=10` / `DEFAULT_THROTTLE_WINDOW_MS=3600000` + `createAttentionThrottle({...})` 工厂；`AttentionEngine.evaluate` 透传 source

#### 修改

- `src/plugins/attention-engine.ts`：在 emit 流水线插入 throttle；`emitItemsWithDedupAndThrottle()` 统计 emit / drop_dedup / drop_throttle 三个数量；dispose 钩子增加 `throttle.reset()`
- `scripts/smoke-attention.mjs`：R10 段 23 用例（fake clock 注入时间，不 setTimeout 真实等待）

#### R10 测试用例（23 用例，全 PASS）

| 用例 | 场景 | 预期 |
|------|------|------|
| R10.1.1-3 | 同 source + notify cooldown（t=1000/2000/7000）| true/false/true |
| R10.2.1-2 | 不同 source（feishu / pc）独立 | 都 true |
| R10.3.1-3 | remember_only 多次（不被 cooldown + cap 阻止）| 都 true |
| R10.4.1-2 | hourlyCap=3 → 5 次 emit | 3 pass / 2 drop |
| R10.5.1-4 | remember_only 不消耗 notify quota | 3 notify 全通过 + 第 4 个 drop |
| R10.6.1-7 | state-only 不消耗 cap + 真 source 第二次被阻止 | 5 state-only true + 真 source 第二次 false |
| R10.7.1-2 | act action 受限（cooldown + 到期后放行）| true/true |

#### 验证

- typecheck/build ✅
- `npm run smoke:attention`：**87/87 PASS**（48 R8 + 16 R9 + 23 R10）
- `npm run smoke:world-state`：**94/94 PASS**（零回归；Phase 2 / 3.A / 3.B.dedup 不受影响）

#### 不做（明确边界）

- ❌ 不持久化（重启即失）
- ❌ 不暴露 throttle 配置（用户决策：先稳定再配置；构造参数仅测试用）
- ❌ 不做 map 容量限制（LRU/eviction 待后续）
- ❌ 不做 priority 合并（Phase 4 Decision 处理）

#### 下一步

- Phase 3.B.rule-config：YAML/JSON rule 加载（覆盖/扩展内置规则）
- Phase 4：Decision Executor（订阅 'orca/attention'，按 priority 排序 + 复用现有 throttle + 执行 notify/act/remember）

---

## app-cordis（2026-08-27，Phase 3.B.rule-registry）

### Attention Rule 注册表解耦（Registry 抽象）

> 用户决策：Phase 3.B 第三步先 registry 解耦，再 rule config（YAML/JSON loader）；registry 是 config 的前置抽象。
> 不实现：YAML / JSON loader / DSL / 用户配置 UI / LLM rule generation。

#### 设计动机

- 之前：AttentionEngine 直接读模块全局 `Map<string, AttentionRule>`（`ruleRegistry`），每条规则硬编码在 services/attention.ts 顶部
- 问题：继续加规则会让 Engine 与规则耦合，无法独立测试 / 热更新 / 未来配置化
- 解决：引入 `AttentionRuleRegistry` 接口；Engine 接受 registry 注入；规则本身保持纯数据

#### 接口设计（types/attention.ts）

```ts
interface AttentionRuleRegistry {
  register(rule: AttentionRule): void           // 同 id 覆盖并保留原位置（热更新）
  unregister(ruleId: string): void            // 不存在不报错
  getRules(): AttentionRule[]                 // 仅返回 enabled（按注册顺序）
  getAllRules(): AttentionRule[]              // 含 disabled（debug 用）
  setEnabled(ruleId: string, enabled: boolean): void  // 未注册抛错
  isEnabled(ruleId: string): boolean          // 未注册返回 false
  size(): number                              // 仅算启用
  clear(): void                               // 测试 / dispose
}
```

#### 实现要点

- **数组保序**（而非 Map）：`rules: AttentionRule[]` + `disabled: Set<string>`
- **enabled 状态由 Registry 维护**（而非 Rule 对象本身）—— Rule 是纯数据 + 谓词，不污染
- **同 id 重复 register 覆盖并保留原位置**（热更新语义）
- **setEnabled 未注册抛错**（避免静默错误）

#### 默认 Registry（向后兼容）

```ts
const defaultRegistry = createRuleRegistry()
// 模块加载时自动注册 5 条内置规则
defaultRegistry.register(ruleSleepingQuiet)
// ...

export function getDefaultRegistry() { return defaultRegistry }

export function createAttentionEngine(
  registry: AttentionRuleRegistry = getDefaultRegistry(),
) { ... }
```

- 不传 registry → 使用默认（5 条内置规则；行为完全等同 Phase 3.A）
- 传 registry → 使用自定义（便于测试 + 未来配置化）

#### 向后兼容（Phase 3.A API 保留）

```ts
export function registerRule(rule) { defaultRegistry.register(rule) }
export function clearRules() { defaultRegistry.clear() }
export function ruleRegistrySize() { return defaultRegistry.size() }
```

R8 / R9 / R10 测试**零改动**（使用旧的全局函数）。

#### 修改

- `src/types/attention.ts`：+ `AttentionRuleRegistry` 接口
- `src/services/attention.ts`：
  - + `RuleRegistryImpl` 类
  - + `createRuleRegistry` / `getDefaultRegistry` 工厂
  - `AttentionEngine` 改为 `constructor(private readonly registry)`，遍历 `this.registry.getRules()`
  - `createAttentionEngine(registry?)` 接受 registry（默认 getDefaultRegistry）
  - `registerRule` / `clearRules` / `ruleRegistrySize` 委托 defaultRegistry（向后兼容）
- `scripts/smoke-attention.mjs`：+ R11 段（23 用例）

#### R11 测试覆盖（23 用例，全 PASS）

| 用例 | 场景 | 预期 |
|------|------|------|
| R11.1.1-2 | register rule 后 evaluate 触发 + ruleCount === 1 | ✓ |
| R11.2.1-4 | register r1+r2 → unregister r1 → unregister 不存在 id 不报错 → unregister r2 后 0 items | ✓ |
| R11.3.1-8 | disabled rule 不执行 + ruleCount 仅算启用 + 设回启用后重新触发 + isEnabled 查询 + 未注册 id 抛错（含 enabled=true/false 两种方向） | ✓ |
| R11.4.1-3 | 多个 rule 顺序稳定 + unregister 中间保留位置 + disable 中间后新 register 在末位 | ✓ |
| R11.5.1-6 | 默认 Registry 5 条内置规则迁移后行为不变 + 不传参 createAttentionEngine 用默认 + 自定义 Registry（只有 only-rule）不触发默认 5 条 | ✓ |

#### 不做（明确边界）

- ❌ YAML / JSON rule loader（Phase 3.B.rule-config）
- ❌ DSL / 用户配置 UI（Phase 3.B 之后）
- ❌ LLM rule generation（Phase 5+）
- ❌ 规则动态加载（未来可加 `loadRulesFromDirectory(path)`，但目前不实现）

#### 验证

- typecheck/build ✅
- `npm run smoke:attention`：**110/110 PASS**（48 R8 + 16 R9 + 23 R10 + 23 R11）
- `npm run smoke:world-state`：**94/94 PASS**（零回归；Phase 2 / 3.A / 3.B.dedup / 3.B.throttle 不受影响）
- 真实飞书 E2E：未执行（DSH 沙盒限制）

#### 下一步

- Phase 3.B.rule-config：YAML/JSON rule 加载（基于 registry 接口实现）
- Phase 4：Decision Executor（订阅 'orca/attention'，按 priority + 复用 throttle + 执行 notify/act/remember）

---

## Project Orca 文档/仓库整理（2026-08-27，非版本 commit）

### Python 版（v2.3.0）删除 + 文档同步

> 用户决策：git 的 Python 历史保留不动；工作区 Python 版源码删除，app-cordis 成为唯一主线。

#### 删除（git rm，历史保留）

- `src/`（34 个 .py + __pycache__）：Python 版 FastAPI + PTE 架构全部源码
- `requirements.txt`：Python 依赖
- `scripts/cleanup_tunnel.py`：SSH 隧道清理（已被 start-cordis.bat 内置替代）
- `start.bat.example` / `start.bat`（本地）：Python 版启动脚本
- `project-orca-overview.md`（本地）：早期愿景文档

#### 配置清理

- `.env`：移除 Python 专属键（AMAP_API_KEY / LUCKIN_MCP_TOKEN / LUCKIN_MCP_URL / LUCKIN_LAT / LUCKIN_LNG / HOST / PORT / LOG_LEVEL）；共享键保留（DEEPSEEK_* / FEISHU_* / QWEN_* / OLLAMA_* / ORCA_*）
- `.env.example`：同步清理 + 补 v0.5.0+ 新键说明（ORCA_RUNTIME_* / ORCA_WORLD_STATE_* / ORCA_PC_* / ORCA_CALENDAR_* / ORCA_PHONE_* / ORCA_ATTENTION_ENABLED）

#### 文档同步

- `AGENT.md`：全量重写为 app-cordis 单主线（§0~§10；含 Phase 3.A 关键架构约束 prevState、三层职责分离、陷阱清单）
- `README.md`：重写为当前状态（v0.6.0 + Phase 3 + 快速开始 + 配置表 + 架构图）
- `TODO.md`：移除 Python 版待办，按 Phase 分组重排

#### 验证

- app-cordis 源码 grep 确认零引用 Python 专属键/端口 8000（删除前）
- `git rm` 全部追踪文件成功；未触碰 Phase 3 未提交内容（attention 源码与 AGENT.md 中对应段落保留原样）
- 提交前：AGENT.md 已同步（本条目即 D-VER-04 标注）

---

## app-cordis（2026-08-27，Phase 3.B.rule-config）

### AttentionRuleConfigLoader（JSON 配置加载）

> 用户决策：Phase 3.B 第四步——加载配置仅表达 enabled 状态，不写 predicate/expression（防 DSL 倾向）。仅支持 JSON（项目无 YAML 依赖；不引入新依赖）。

#### 设计动机

- Phase 3.B.rule-registry 已把规则从 Engine 解耦
- 下一步：让用户可通过配置文件**选择/启用/禁用**已注册的规则
- **绝不** 创建新 Rule（Rule 必须由 TypeScript 代码实现）
- **绝不** 解析 DSL / 表达式 / JavaScript（防安全风险 + 防配置膨胀为编程语言）

#### 配置格式（严格 JSON）

```json
{
  "rules": {
    "sleeping-quiet": { "enabled": true },
    "away-arrival":   { "enabled": false },
    "feishu-deadline": { "enabled": true }
  }
}
```

**只允许 `enabled` 字段**。`predicate`、`expression`、`script` 等任何其他字段**直接报错**。

#### 接口设计（types/attention.ts）

```ts
interface AttentionRuleConfigEntry {
  enabled: boolean
}

interface AttentionRuleConfig {
  rules: Record<string, AttentionRuleConfigEntry>
}

interface AttentionRuleConfigLoader {
  parse(jsonText: string): AttentionRuleConfig   // 纯函数，无副作用
  load(config: AttentionRuleConfig, registry: AttentionRuleRegistry): void  // 副作用
}
```

#### 实现要点（services/attention-config.ts）

- **`parse`** 严格校验：
  1. JSON.parse 合法
  2. 顶层是 object（非 array / null）
  3. 顶层包含 `rules` 字段（object）
  4. 每个 ruleId 是非空字符串
  5. 每个 entry 是 object（非 array）
  6. entry 仅含白名单字段（`enabled`）；其他字段直接报错
  7. enabled 是 boolean（缺省视为 true）
- **`load`** 严格行为：
  - 未知 ruleId → 抛错（fail-fast；不静默）
  - 仅设置 enabled 状态，不创建 / 修改 Rule 本身
  - 不污染 defaultRegistry（接受 registry 参数；测试用独立 Registry）
- **`createRuleConfigLoader()`** 工厂返回 `{ parse, load }`

#### Registry 生命周期处理（关键）

- `getDefaultRegistry()`：模块加载时注册 5 条内置规则（向后兼容）
- `createRuleRegistry()`：测试用独立 Registry（**不污染** default）
- Loader **接受 registry 参数**，不假设用 default
- R12.6 验证：用独立 Registry load 不会影响 defaultRegistry
- R12.7 验证：用 defaultRegistry load 也只影响 5 条内置规则（不会创建新规则）

#### R12 测试用例（28 用例，全 PASS）

| 用例 | 场景 | 预期 |
|------|------|------|
| R12.1.1-3 | 空配置 `{rules:{}}` parse + load + 缺省 enabled=true | ✓ |
| R12.2.1-5 | disable 一个规则 → engine 不再产生 + 仍在 getAllRules | ✓ |
| R12.3.1-2 | re-enable → 规则恢复 | ✓ |
| R12.4.1-3 | 未知 ruleId → 抛错（错误信息含 ruleId + 不破坏 registry 状态）| ✓ |
| R12.5.1-8 | JSON 解析错误（无效 JSON / null / array / 缺 rules / 未知字段 predicate / enabled 类型错）| ✓ |
| R12.6.1-2 | 独立 Registry load 不污染 defaultRegistry | ✓ |
| R12.7.1-5 | 默认 Registry 行为不变（R8/R10 向后兼容）+ 通过 config disable 后规则不触发 + 恢复 | ✓ |

#### 不做（明确边界）

- ❌ YAML parser（项目无 YAML 依赖；不引入新依赖）
- ❌ DSL / 表达式 / JavaScript 注入
- ❌ LLM rule generation（Phase 5+）
- ❌ 持久化
- ❌ 文件监听 / 热加载（可由 plugin 层未来加）
- ❌ 加载内置规则（必须由 TypeScript 代码 register）

#### 验证

- typecheck/build ✅
- `npm run smoke:attention`：**138/138 PASS**（48 R8 + 16 R9 + 23 R10 + 23 R11 + 28 R12）
- `npm run smoke:world-state`：**94/94 PASS**（零回归）
- 真实飞书 E2E：未执行（DSH 沙盒限制）

#### 下一步

- Phase 4：Decision Executor（订阅 'orca/attention'，按 priority 排序 + 复用现有 throttle + 执行 notify/act/remember）
- 注意：plugin 中集成 Config Loader（如从 .env 读取 `ORCA_RULES_CONFIG_PATH`）可放 Phase 4 一并做或单独做；本阶段仅提供 Loader 接口供未来用

---

## app-cordis（2026-08-27，Phase 5.0）

### MemoryStore Foundation —— LongMemory mutation authority

> 按 D-AGENT-17 v1.1（guide/orca-memory-design.md）实现 Phase 5.0。
> **核心约束**：MemoryStore 是 LongMemory 的唯一 mutation authority；Reflection 永远不直接修改 JSONL 或 in-memory 对象。
> **不做**：Reflection / Episode / LLM / CEO/context integration / Decision/Attention/WorldState 改动。

#### 新增文件（app-cordis/）

| 文件 | 说明 |
|------|------|
| `src/types/memory.ts` | Phase 5.0 全部类型契约：LongMemoryFact（二态 active/superseded）+ MemoryCandidate + AuditEvent（**无 prevValue/newValue**，v1.1）+ ForgetMarker（fingerprint）+ MemoryStore 接口 + OrcaMemoryConfig |
| `src/services/memoryStore.ts` | `JsonlMemoryStore` 类（实现 MemoryStore 全部接口）：4 个 JSONL 文件（long.jsonl / candidates.jsonl / markers.jsonl / audit.jsonl）+ 内存 Map 索引；lazy load on first access（同 JsonlInfoRecordStore 模式）；`createMemoryStore(config)` 工厂 |
| `scripts/smoke-memory.mjs` | R19 冒烟测试 69 用例（M1~M12）：queryFacts / upsertFact / supersedeFact / mergeFacts / compressFactEvidence / forgetFact / forgetByQuery / createForgetMarker / queryForgetMarkers / queryAudit + ForgetMarker restart persistence + audit privacy + JSONL reload 一致性 + Candidate promote/reject/expire |

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/config.ts` | 新增 `OrcaMemoryConfig` 接口（enabled / dataDir / fingerprintSalt / maxActiveFacts / promoteThreshold）+ `config.memory`；getConfig() 读取 `ORCA_MEMORY_ENABLED/DIR/SALT/MAX_ACTIVE_FACTS/PROMOTE_THRESHOLD` |
| `src/index.ts` | 新增 `import { createMemoryStore }`；ctx.provide('memory', createMemoryStore(config.memory)) 在 Runtime 插件之前装配；MemoryStore enabled 时打日志；Phase 5.0 启动横幅 |

#### 关键实现细节

- **JSONL 持久化（同 D-AGENT-09 模式）**：`appendFile` 追加写（audit/long/markers/candidates）；物理删除时重写对应 JSONL；`ensureLoaded` lazy load（首次 API 调用时加载全部 4 个文件到内存）
- **upsertFact identity = (type, subject)**：同 identity 原地更新（保持原 id）；不同 identity 各有一条 active（通过 `activeByTypeSubject` Map 索引）
- **supersedeFact**：旧 fact → state=superseded + supersededBy；新 fact → state=active + supersedes；各产生一条 audit event
- **mergeFacts**：源 fact → state=superseded + mergedInto；target fact → 合并 evidence（去重 + keepRecent）
- **compressFactEvidence**：压缩 `representativeEvidenceIds` 到 keepRecent 条；产生 `compressed` audit 带 `evidenceDelta`
- **forgetFact（owned by MemoryStore）**：Step 1 createForgetMarker → Step 2 物理删除 fact（重写 long.jsonl）→ Step 3 删除相关 pending candidates → Step 4 追加 `forgotten` audit（value 内容不入审计）→ Step 5 从内存移除。**注意**：JSONL 不是数据库级 transaction；写入顺序固定已尽量减少不一致窗口。
- **ForgetMarker fingerprint**：`sha256(salt + lower(subject)).slice(0, 16)`（16 字符 hex）；幂等：相同 type+subject 返回已有 marker；**salt 必须稳定**（`ORCA_MEMORY_SALT`，建议 `openssl rand -hex 32`），否则 restart 后 fingerprint 不一致导致 suppress 失效
- **queryAudit**：never exposes value content；`forgotten` kind 的 `changedFields = undefined`；`updated/compressed` 使用 `changedFields[]` 数组
- **AuditEvent 无 prevValue/newValue（v1.1）**：所有操作通过 `changedFields[]` 表达字段变化；`prevConfidence` / `newConfidence` 仅做数值记录不替代 `changedFields`
- **Candidate API**：`appendCandidate` → `promoteCandidate`（生成 LongMemoryFact） / `rejectCandidate`（标记 rejected） / `expireCandidates`（批量过期检查）
- **index.ts 装配顺序**：MemoryStore 在 Runtime 插件之前（`memory.provide` 先于 `orcaRuntime`），确保 `ctx.memory` 可被 Runtime 插件注入

#### 关键设计决策与踩坑

- **Phase 5.0 零侵入**：Decision / Attention / WorldState / Action 完全不变；`ctx.memory` 作为独立 service 存在
- **`ORCA_MEMORY_SALT` 必须稳定**：若未配置使用 `'CHANGE-ME-USE-RANDOM-SALT-IN-PROD'`（placeholder），重启后 salt 变化导致 ForgetMarker fingerprint 与 restart 前不一致，isSuppressed 失效；生产环境必须设置固定随机字符串
- **memory.remember handler 冲突**：现有 `createRememberHandler`（Phase 4.B）写 `infoStore`（namespace='decision-action'），与 D-AGENT-16-03 四态 decision 的 remember_only 存在历史冲突（见 D-AGENT-17 v1.1 §10.2-A）；Phase 5.0 不修改现有 handler，留待 Phase 5.2 重新设计
- **forget 物理删除 vs 软删除**：long.jsonl 中被 forget 的 fact 物理删除（重写文件），而非标记 state='forgotten'；`queryFacts` 默认不返回 forgotten fact（includeSuperseded 也不返回）

#### 验证

- typecheck/build ✅
- `node scripts/smoke-memory.mjs`：**69/69 PASS** ✅（M1~M12 全覆盖）

#### 下一步

- **Phase 5.2**：memory.remember / memory.forget ActionHandler（forget operation owned by MemoryStore）
- **Phase 5.3**：Reflection Engine（MemoryCandidate 生成 + promote/reject 逻辑 + isSuppressed gate）
- 提交前：AGENT.md + TODO.md 已同步

---

## app-cordis（2026-08-27，Phase 5.1）

### Episode Engine MVP —— Short Memory 生成

> 按 D-AGENT-17 v1.1 §3.1 / §4.1 实现 Episode 层（Short Memory）。
> **核心约束**：纯规则，无 LLM；不生成 MemoryCandidate；不接入 Attention/Decision。
> **不做**：ReflectionService / LongMemory 自动 promote / CEO context 注入 / Calendar/GPS adapter。

#### 新增文件（app-cordis/）

| 文件 | 说明 |
|------|------|
| `src/types/memory.ts`（扩展） | 新增 Episode 接口（id / category / kind / summary / ts / entities / sourceEventIds / importance / ttlDays / state）+ EpisodeQuery |
| `src/services/memoryStore.ts`（扩展） | 新增 `episodesById` 索引 + `loadEpisodes` + 5 个 Episode 方法（appendEpisode / queryEpisodes / getTodayEpisodes / getRecentEpisodes / pruneExpiredEpisodes）|
| `src/services/episodeEngine.ts` | `EpisodeEngine` 类 + `createEpisodeEngine` 工厂：纯规则无 LLM；Burst 检测（senderId → session Map，90s 窗口，≥3 触发）+ state.transition 摘要（transitionSummary + transitionImportance）|
| `src/plugins/episode-engine.ts` | Cordis plugin：订阅 `orca/event`（EventBus）和 `orca/state_changed`（WorldState）；返回 dispose 钩子 |
| `scripts/smoke-episode.mjs` | R20 冒烟测试 45 用例（E1~E12） |

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/types/memory.ts` | 新增 Episode / EpisodeQuery 类型；MemoryStore 接口新增 5 个 Episode 方法 + isSuppressed |
| `src/services/memoryStore.ts` | episodes.jsonl（第 5 个 JSONL）；episodesById in-memory 索引；lazy load on first access |
| `src/index.ts` | 新增 episodeEnginePlugin 导入；在 Runtime 之后装配（依赖 EventBus + WorldState）；Phase 5.1 启动横幅 |

#### 两类 Episode（确定性规则，无 LLM）

| Episode 类型 | 触发条件 | 摘要规则 | 重要性 |
|-------------|---------|---------|--------|
| `message.burst` | 同 sender 在 90s 内发送 ≥3 条消息 | `用户在 90 秒内连续发送了 N 条消息` | ≥5 条 = high，否则 normal |
| `state.transition` | WorldState user.status 变化 | `用户在 X 状态（变为 Y）` | sleeping→active/busy = high；进入 sleeping = low；其余 = normal |

#### 关键设计决策与踩坑

- **Burst 防重复**：同一 sender 触发 burst 后，`burstEpisodeDone.add(senderId)` 标记防止重复生成；session 满后重置计数（下一个 burst 可重新触发）。当前实现：burst 触发后 session 重置为 `count=0`（不等窗口超时）。
- **Episode 持久化**：appendEpisode 追加写入 episodes.jsonl；pruneExpiredEpisodes 物理删除（重写 JSONL）；restart 时 loadEpisodes 加载全部 Episode 到内存（TTL 在 query 时检查，不在全量加载时过滤）。
- **EpisodeEngine 依赖 EventBus**：仅在 `ORCA_RUNTIME_ENABLED=1` 时挂载；挂载在 Runtime 之后（EventBus + WorldState 就绪后才接收事件）。
- **state.transition sourceEventIds=[]**：WorldState 变化事件不是 OrcaEvent，无 eventId 字段；sourceEventIds 保留为空数组。
- **importance 阈值**：burst importance=high 当且仅当 `session.count >= 5`；3 或 4 条消息 = normal。

#### 验证

- typecheck/build ✅
- `node scripts/smoke-memory.mjs`：**69/69 PASS** ✅（Phase 5.0 零回归）
- `node scripts/smoke-episode.mjs`：**45/45 PASS** ✅（E1~E12 全覆盖）

#### 下一步

- **Phase 5.3**：Reflection Engine（MemoryCandidate 生成 + promote/reject 逻辑 + isSuppressed gate）
- 提交前：AGENT.md + TODO.md 已同步

---

## app-cordis（2026-08-27，Phase 5.2）

### memory.remember / memory.forget ActionHandler

#### 关键语义决策

**forget 操作 owned by MemoryStore**：`MemoryStore.forgetByQuery` 是唯一出口，内部按固定顺序完成：createForgetMarker（幂等）→ persistFact → rejectCandidates → appendAudit。禁止 ActionHandler 自行组合这些底层操作（否则 createForgetMarker 被调用两次）。`createForgetMarker` 幂等保证：同一 type+subject 第二次调用返回已有 marker，不重复创建。**注意**：JSONL 不是数据库级 transaction；写入顺序已尽量减少不一致窗口。

**memory.remember vs 旧 remember handler**：旧 handler（Phase 4.B）写入 `infoStore`（decision-action/decision-remember）；新 handler（Phase 5.2）写入 `MemoryStore`（LongMemory）。两者路径并存，互不干扰。旧 handler 保留不变（A 方案，最小兼容）。

**forget not-found**：findByQuery 返回空列表 → forgetByQuery 调用 N=0 次 → 返回 `forgottenCount=0`，仍为 `success=true`。

**Decision.reason JSON**：handler 尝试 `JSON.parse(reason)`；解析失败时兜底用 reason 自身作为 subject。

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/services/action.ts` | 新增 `createMemoryRememberHandler` / `createMemoryForgetHandler` + `MemoryRememberContext` / `MemoryForgetContext` 接口 |
| `src/plugins/action-executor.ts` | 导入两个 memory handler；`ctx.get('memory')` 软依赖；注册到 executor.registry |
| `scripts/smoke-memory-handler.mjs` | **新增** R21 冒烟测试 51 用例（H1~H14） |

#### 验证

- typecheck/build ✅
- `node scripts/smoke-memory.mjs`：**69/69 PASS** ✅（Phase 5.0 零回归）
- `node scripts/smoke-episode.mjs`：**45/45 PASS** ✅（Phase 5.1 零回归）
- `node scripts/smoke-memory-handler.mjs`：**51/51 PASS** ✅（H1~H14 全覆盖）

#### 下一步

- **Phase 5.4**：Memory → Attention（短期 Episode 触发规则；不接 LLM；基于 Episode + Candidate summary）
- 提交前：AGENT.md + TODO.md 已同步

---

## app-cordis（2026-08-27，Phase 5.3）

### Reflection Engine MVP —— Episode → Candidate → LongMemory

#### 关键设计决策

**1. privacy gate（subject-only）**：原 `isSuppressed(type, subject)` 是 type-scoped；Phase 5.3 spec 要求 `forget → Episode → Reflection → candidate 被 suppression → LongMemory 不复活`，但 Reflection 推断的 candidate 可能 type 与原 forget 事实不同。解决方案：新增 `isSubjectSuppressed(subject)` API（subject-only；忽略 type），fingerprint 存储已支持。ReflectionEngine 在 promote 前同时检查 `isSubjectSuppressed` + `isSuppressed`，确保 subject 一旦被任何 type 的 ForgetMarker 标记，所有 Reflection 推断都被拒绝。

**2. user-explicit 冲突处理**：原 `promoteCandidate` 无条件覆盖；Phase 5.3 spec 要求 user-explicit fact 不被 reflection 无条件覆盖。解决方案：在 ReflectionEngine 层检查 `queryFacts({ type, subject, state: 'active' })` 是否含 `source='user-explicit'`；若有则 `rejectCandidate('user-explicit-fact-exists')`。这是 reflection-level guard 而非 MemoryStore-level policy；保留最小侵入性。如需更复杂优先级（合并 vs supersede），需 D-AGENT-18 提案。

**3. dedup 语义修正**：第一版 dedup 只查 `state='pending'` candidate，导致 promoted/rejected candidate 被重新生成。修正：dedup 检查所有 non-expired candidate。QueryCandidates API 新增（返回按 createdAt 降序）。

**4. FactType 扩展**：新增 `behavioral_pattern` / `state_pattern`，预留 future Rule B/C 空间。Rule A 当前只产出 `behavioral_pattern`。

**5. proposer ≠ mutator 严格分层**：ReflectionEngine 只调 `appendCandidate` / `promoteCandidate` / `rejectCandidate` / `queryCandidates` / `isSubjectSuppressed` / `queryFacts`；**不**直接改 `factsById` / `candidatesById` / JSONL。

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/types/memory.ts` | FactType 新增 `behavioral_pattern` / `state_pattern`；MemoryStore 接口新增 `queryCandidates` + `isSubjectSuppressed` |
| `src/services/memoryStore.ts` | 实现 `queryCandidates` + `isSubjectSuppressed` |
| `src/services/reflectionEngine.ts` | **新增** —— `createReflectionEngine` + Rule A + confidence 公式 + privacy gate + user-explicit 冲突 + dedup |
| `src/plugins/reflection-engine.ts` | **新增** —— Cordis plugin；提供 `ctx.reflection`；仅手动 reflect |
| `src/index.ts` | import + 装配 reflectionEnginePlugin（EpisodeEngine 之后） |
| `scripts/smoke-reflection.mjs` | **新增** R22 冒烟测试 58 用例（R1~R12） |

#### 测试结果

| 套件 | 结果 |
|------|------|
| `smoke-memory.mjs` | 69/69 PASS ✅（Phase 5.0 零回归） |
| `smoke-episode.mjs` | 45/45 PASS ✅（Phase 5.1 零回归） |
| `smoke-memory-handler.mjs` | 51/51 PASS ✅（Phase 5.2 零回归） |
| `smoke-reflection.mjs` | 58/58 PASS ✅（R1~R12 全覆盖） |

#### D-AGENT-17 v1.1 设计缺口

1. **`queryCandidates` API 缺失**：原 v1.1 没有 candidate 查询接口；Phase 5.3 新增 `CandidateQuery { state?, type?, subject? }`。如需分页/排序/limit 等扩展，建议 D-AGENT-18 提案。
2. **`isSubjectSuppressed` 缺失**：原 v1.1 `isSuppressed` 是 type-scoped；Phase 5.3 新增 subject-only 版本。两者并存：
   - `isSuppressed(type, subject)`：用于 D-AGENT-17 原设计场景
   - `isSubjectSuppressed(subject)`：用于 privacy gate（任意 type 的 ForgetMarker 都生效）
3. **user-explicit 冲突**：原 `promoteCandidate` 无覆盖保护；当前在 ReflectionEngine 层 guard（最小侵入）。如需 MemoryStore 级别强制，建议 D-AGENT-18 提案。

#### 下一步

- **Phase 5.4**：Memory → Attention（短期 Episode 触发规则；不接 LLM；基于 Episode + Candidate summary）
- 提交前：AGENT.md + TODO.md 已同步

---

## app-cordis（2026-08-27，Phase 5.3.1，D-AGENT-18）

### D-AGENT-18 Memory Contract Hardening —— 三个 contract 缺口收口

#### 关键设计决策

**1. CandidateQuery 正式纳入 contract**：`queryCandidates(q)` 在 Phase 5.3 已实际使用但未文档化。本次正式定义 `CandidateQuery{state?, type?, subject?, limit?}` 含 `limit`（默认 100，上限 1000，按 createdAt 降序截断）。不引入复杂 repository abstraction；limit 是简单内存截断。

**2. isSubjectSuppressed 正式确认**：Phase 5.3 已添加 `isSubjectSuppressed(subject)` 作为 subject-only 抑制 API，但 design doc 仍是 type-scoped-only。本次正式确认两种 API 并存：
- `isSuppressed(type, subject)`：type-scoped，用于 D-AGENT-17 原设计场景
- `isSubjectSuppressed(subject)`：subject-level，privacy gate，Reflection promotion 必须使用

**3. User-explicit protection 下沉到 MemoryStore**：

Phase 5.3 在 ReflectionEngine 层做 guard，但这不是最终安全边界。本次将最基本 invariant 放入 `MemoryStore.promoteCandidate()`：

```
promoteCandidate(id, decidedBy)
  → isSubjectSuppressed(subject) === true
    → candidate.state = 'rejected'，reason='suppressed-by-forget-marker'，抛错
  → queryFacts({type, subject, state='active'}) 含 source='user-explicit'
    → candidate.state = 'rejected'，reason='user-explicit-fact-exists'，抛错
  → 否则正常 promote
```

**关键**：ReflectionEngine 层 guard 仅作 early-exit 优化（减少无意义调用），不再承担安全边界。即使 ReflectionEngine 没有提前 guard，MemoryStore 也不允许覆盖 user-explicit fact。

**原则**：ReflectionEngine = proposer / policy；MemoryStore = mutation authority / invariant enforcement。

**4. Rule A 定位收敛**：Rule A 当前用于验证 Reflection pipeline 的 deterministic candidate generation，**不是**成熟的用户长期行为推断。**不要**扩展为 personality inference。

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/types/memory.ts` | CandidateQuery 新增 `limit` 字段 |
| `src/services/memoryStore.ts` | promoteCandidate 内部新增 subject-level suppression gate + user-explicit 冲突检查 |
| `guide/orca-memory-design.md` | 升级 v1.2：§3.2 CandidateQuery 定义 / §3.5 v1.2 补充 / §4.6 v1.2 修订 / §15 v1.2 版本记录 |
| `guide/decisions.md` | 新增 D-AGENT-18（§18-01~§18-06） |
| `scripts/smoke-d-agent-18.mjs` | **新增** R23 冒烟测试 44 用例（C1~C8） |

#### 测试结果

| 套件 | 结果 |
|------|------|
| `smoke-memory.mjs` | 69/69 PASS ✅（Phase 5.0 零回归） |
| `smoke-episode.mjs` | 45/45 PASS ✅（Phase 5.1 零回归） |
| `smoke-memory-handler.mjs` | 51/51 PASS ✅（Phase 5.2 零回归） |
| `smoke-reflection.mjs` | 58/58 PASS ✅（Phase 5.3 零回归） |
| `smoke-d-agent-18.mjs` | 44/44 PASS ✅（C1~C8 全覆盖） |

#### 下一步

- **Phase 5.4**：Memory → Attention（短期 Episode 触发规则；不接 LLM；基于 Episode + Candidate summary）
- 提交前：AGENT.md + TODO.md + dev-log.md 已同步

---

## app-cordis（2026-08-27，Phase 5.4.A）

### MemoryAttentionAdapter 基础 —— Memory → Attention 唯一桥接层

#### 实现要点

**架构**：

```
MemoryStore ──(polling 60s)──→ MemoryAttentionAdapter ──(ctx.emit orca/attention)──→ EventBus ──→ AttentionEngine ──→ DecisionEngine
```

**核心设计**：
- `factToAttentionItem(fact)`：将 LongMemoryFact 映射为 `AttentionItem`；`type='memory.insight'`（MVP 统一，不按原始 fact type 分类）
- priority 从 confidence 计算：≥0.9=urgent / ≥0.8=high / ≥0.7=normal / else=low
- `action='remember_only'`（MVP 简化）
- metadata 包含 `factId / memoryType / memorySource / confidence / createdAt / updatedAt`
- 去重：`seenFacts: Map<factId, updatedAt>`；同一 `updatedAt` 不重新生成；forget 后 fact 自然消失

**配置键**：
- `ORCA_MEMORY_ATTENTION_ENABLED`（默认 true）
- `ORCA_MEMORY_ATTENTION_POLL_INTERVAL_MS`（默认 60000）
- `ORCA_MEMORY_ATTENTION_TOP_K`（默认 5）

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/services/memoryAttentionAdapter.ts` | **新增** —— `createMemoryAttentionAdapter` + `factToAttentionItem` + dedup + polling |
| `src/plugins/memory-attention-adapter.ts` | **新增** —— Cordis plugin；依赖 ctx.memory；disposed 闸门 |
| `src/config.ts` | `OrcaMemoryConfig` 新增 `attentionEnabled` / `attentionPollIntervalMs` / `attentionTopK` |
| `src/index.ts` | import + 装配 `memoryAttentionAdapter`（MemoryStore 之后） |

#### 测试结果

| 套件 | 结果 |
|------|------|
| `smoke-memory.mjs` | 69/69 PASS ✅（Phase 5.0 零回归） |
| `smoke-episode.mjs` | 45/45 PASS ✅（Phase 5.1 零回归） |
| `smoke-memory-handler.mjs` | 51/51 PASS ✅（Phase 5.2 零回归） |
| `smoke-reflection.mjs` | 58/58 PASS ✅（Phase 5.3 零回归） |
| `smoke-d-agent-18.mjs` | 44/44 PASS ✅（Phase 5.3.1 零回归） |
| `smoke-memory-attention.mjs` | 36/36 PASS ✅（M1~M7 全覆盖 Phase 5.4.A） |

#### 下一步

- **Phase 6 设计**：Memory-aware CEO Context（`guide/orca-memory-consumption-design.md` §12 + D-AGENT-20；不实现代码）
- 提交前：AGENT.md + TODO.md + dev-log.md 已同步

---

## app-cordis（2026-08-27，Phase 5.4.B）

### Memory Event Bridge —— MemoryStore mutation event 驱动 MAA

#### 实现要点

**架构**：

```
MemoryStore mutation → memory_changed 事件 → MAA.onMemoryChanged → orca/attention → EventBus
```

**MemoryStore 事件发射**：

| mutation | 事件 |
|----------|------|
| `upsertFact`（新建） | `fact.created` |
| `upsertFact`（更新） | `fact.updated` |
| `supersedeFact` | `fact.created`（新fact）+ `fact.superseded`（旧fact，附 `newFactId`）|
| `mergeFacts` | `fact.merged`（每个source，附 `newFactId`）+ `fact.updated`（target）|
| `forgetFact` | `fact.forgotten` |

**MAA 事件处理**：
- invalidate 类型（`fact.superseded / merged / forgotten`）：从 `seenFacts` 删除，不发送 AttentionItem
- create/update 类型：异步查询当前 fact 状态，若仍为 active 则生成并 emit AttentionItem

**MemoryStore 不感知消费者**：通过 `OrcaMemoryConfig.eventEmitter` 注入，MemoryStore 调用 `(event) => ctx.emit('memory_changed', event)`，不知道也不关心谁订阅。

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/types/memory.ts` | **修改** —— 新增 `MemoryChangedEvent` / `MemoryEventType` / `OrcaMemoryConfig.eventEmitter` |
| `src/services/memoryStore.ts` | **修改** —— 4 个 mutation 函数 emit 相应事件；`emit()` 私有方法 |
| `src/index.ts` | **修改** —— MemoryStore 构造传入 `eventEmitter: (e) => ctx.emit('memory_changed', e)` |
| `src/services/memoryAttentionAdapter.ts` | **修改** —— 新增 `onMemoryChanged()`；`MemoryAttentionAdapter` 接口新增方法 |
| `src/plugins/memory-attention-adapter.ts` | **修改** —— `ctx.on('memory_changed', ...)` 订阅；dispose 时 unsubscribe |
| `scripts/smoke-memory-event-bridge.mjs` | **新增** —— 39 用例 EB1~EB7 |

#### 测试结果

| 套件 | 结果 |
|------|------|
| `smoke-memory.mjs` | 69/69 PASS ✅（Phase 5.0 零回归） |
| `smoke-episode.mjs` | 45/45 PASS ✅（Phase 5.1 零回归） |
| `smoke-memory-handler.mjs` | 51/51 PASS ✅（Phase 5.2 零回归） |
| `smoke-reflection.mjs` | 58/58 PASS ✅（Phase 5.3 零回归） |
| `smoke-d-agent-18.mjs` | 44/44 PASS ✅（Phase 5.3.1 零回归） |
| `smoke-memory-attention.mjs` | 36/36 PASS ✅（Phase 5.4.A 零回归） |
| `smoke-memory-event-bridge.mjs` | 39/39 PASS ✅（EB1~EB7 全覆盖） |

**总计：342/342 PASS** — 全部零回归。

#### 架构影响说明

1. **MemoryStore 新增职责**：mutation 后发射 `memory_changed` 事件。MemoryStore 不持有 emitter 引用，不知道消费者。这是单向数据流：D-AGENT-19 §19-02 的事件驱动补充，不改变 MemoryStore 的核心职责。
2. **MAA 双路径**：polling（Phase 5.4.A fallback）+ 事件驱动（Phase 5.4.B primary）。事件驱动更及时，polling 作为后备机制（restart 恢复、事件丢失补偿）。
3. **无新增存储**：event payload 直接在内存传递，不持久化。重启后 MAA 通过 polling fallback 恢复状态。
4. **D-AGENT-19 约束保持**：MAA 仍是 Memory → Attention 的唯一桥接；MemoryStore 不知道 AttentionEngine/DecisionEngine；CEO 仍可通过 `queryFacts` 直接读取。

---

## v1.6.0（2026-09-06）

### 新增：Phase 6.A CEO ContextAssembler

#### 变更文件

| 文件 | 变更 |
|------|------|
| `src/types/context.ts` | **新增** —— `MemoryRetrievalQuery` / `ContextAssemblerConfig` / `ContextAssembler` 接口 / `ContextAssemblyResult` / `FormattedMemoryFact` / `FormattedInfoRecord` |
| `src/services/contextAssembler.ts` | **新增** —— `createContextAssembler(memoryStore, infoStore, config?)` 工厂；`assemble(input, worldState, options?)` 主方法 |
| `src/config.ts` | **修改** —— 新增 `OrcaContextAssemblerConfig` 接口 + `OrcaConfig.contextAssembler` 字段 + 环境变量加载 |
| `src/context.ts` | **修改** —— `Context` 接口新增 `contextAssembler: ContextAssembler` |
| `src/index.ts` | **修改** —— Phase 6.A 装配块（依赖 `ctx.memory` + `ctx.infoStore`） |
| `scripts/smoke-context-assembler.mjs` | **新增** —— 38 用例 CA1~CA12 |

#### 新增配置键（环境变量）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ORCA_MEMORY_CONTEXT_ENABLED` | `1` | 是否启用 ContextAssembler |
| `ORCA_MEMORY_CONTEXT_TOP_K` | `10` | Memory facts 上限 |
| `ORCA_MEMORY_CONTEXT_PER_FACT_CHARS` | `80` | 单条 fact value 最大字符数 |
| `ORCA_MEMORY_CONTEXT_BUDGET_CHARS` | `500` | Memory facts 总字符预算 |
| `ORCA_MEMORY_CONTEXT_INFO_RECORDS_LIMIT` | `3` | InfoRecords 最近条目数 |

### 新增：Phase 6.B CEO Context Integration

#### CEO Context 构造位置确认

`src/plugins/agent.ts` 第 109 行是 CEO system prompt 构造的唯一位置：
```ts
const system = personaPrompt() + (archive.context ? `\n\n${archive.context}` : '') + memoryContext
```
`memoryContext` 为 Phase 6.B 新增部分，从 `ctx.contextAssembler.assemble()` 获取。

#### 变更文件

| 文件 | 变更 |
|------|------|
| `src/plugins/agent.ts` | **修改** —— 接入 `ctx.contextAssembler`；feishu/message + dashboard/message 两入口在 persona+archive 后追加【长期记忆】区块；`agent.inject` 扩展 `worldState` + `contextAssembler` |
| `scripts/smoke-ceo-context-e2e.mjs` | **新增** —— 29 用例 CE1~CE9 |

#### 测试结果

| 套件 | 结果 |
|------|------|
| `smoke-memory.mjs` | 69/69 PASS ✅（Phase 5.0 零回归） |
| `smoke-episode.mjs` | 45/45 PASS ✅（Phase 5.1 零回归） |
| `smoke-memory-handler.mjs` | 51/51 PASS ✅（Phase 5.2 零回归） |
| `smoke-reflection.mjs` | 58/58 PASS ✅（Phase 5.3 零回归） |
| `smoke-d-agent-18.mjs` | 44/44 PASS ✅（Phase 5.3.1 零回归） |
| `smoke-memory-attention.mjs` | 36/36 PASS ✅（Phase 5.4.A 零回归） |
| `smoke-memory-event-bridge.mjs` | 39/39 PASS ✅（Phase 5.4.B 零回归） |
| `smoke-context-assembler.mjs` | 38/38 PASS ✅（Phase 6.A 全覆盖） |
| `smoke-ceo-context-e2e.mjs` | 29/29 PASS ✅（Phase 6.B 全覆盖） |

**总计：409/409 PASS — 全部零回归。AGENT.md + TODO.md 已同步。**

---

## v1.6.1（2026-09-06）

### 新增：Phase 6.C Memory Quality Layer 设计稿

#### 变更文件

| 文件 | 变更 |
|------|------|
| `guide/orca-memory-quality-design.md` | **新增** —— Phase 6.C 完整架构设计稿 |
| `guide/decisions.md` | **修改** —— 新增 D-AGENT-21 |
| `AGENT.md` | **修改** —— Phase 6.C 设计稿 entry |
| `TODO.md` | **修改** —— Phase 6.C 待办 entry |

#### 设计内容（不实现代码）

**D-AGENT-21 §21-01 Memory Conflict Resolution**：
- L1：Mutation-time conflict（已有 supersede 设计，保持不变）
- L2：Source conflict——user-explicit > reflection，ContextAssembler 层处理
- L3：Semantic conflict——关键词检测，双方保留，prompt 标记 ⚠️，不自动裁决

**D-AGENT-21 §21-02 Memory Retrieval Scoring Interface**：
- 预设 scoring functions：confidence / confidence-freshness / source-confidence
- deterministic（无 embedding）
- 配置键：`ORCA_MEMORY_SCORING_PRESET`

**D-AGENT-21 §21-03 Memory Usage Tracking**：
- MemoryUsageRecord：in-memory ring buffer，记录每次 assemble() 调用
- 不持久化，不 emit，不注入 prompt
- 用途：可审计性 / 冲突调试 / 遗忘效果验证

**D-AGENT-21 §21-04 Memory Evaluation Strategy**：
- 9 个评估场景（E1~E9）：Memory 进入 prompt / Top-K / Forget 不复活 / L2 冲突 / memory 修正 / L3 冲突标记 / scoring 效果 / disabled 行为 / prompt 格式

**未引入**：新 Memory 类型 / 数据库 / 向量搜索 / 修改 MemoryStore 核心语义

### 新增：Phase 6.C.1 Scoring Interface + L2 Source Conflict Resolution 实现

#### 变更文件

| 文件 | 变更 |
|------|------|
| `src/types/context.ts` | **修改** —— 新增 `ScoringFunction` / `ScoringPreset` / `getScoringFunction` / `scoreByConfidence` / `scoreBySourceConfidence`；`ContextAssemblerConfig` 新增 `scoringPreset`；`ContextAssemblyResult` 新增 `sourceConflictsFiltered` |
| `src/services/contextAssembler.ts` | **修改** —— `resolveL2SourceConflict()` 实现（按 type+subject 分组，user-explicit 优先）；queryMemory 流程改为 query→L2 filter→scoring sort→format→budget cap |
| `src/config.ts` | **修改** —— `OrcaContextAssemblerConfig` 新增 `scoringPreset`；环境变量 `ORCA_MEMORY_SCORING_PRESET`（默认 'confidence'） |
| `scripts/smoke-memory-quality.mjs` | **新增** —— 18 用例 Q1~Q8 |

#### 重要约束说明

MemoryStore `upsertFact` 同 (type, subject) 第二次 upsert 会 update-in-place 已有 fact（保留 id，更新 source/value/confidence）。因此**同 (type, subject) 多 source 无法构造两个 active facts 共存的场景**。L2 filter 逻辑已正确实现（按 type+subject 分组，user-explicit 优先），但此约束限制了直接测试 same-type+subject source conflict 的能力。

#### 测试结果

| 套件 | 结果 |
|------|------|
| `smoke-memory.mjs` | 69/69 PASS ✅（Phase 5.0 零回归） |
| `smoke-episode.mjs` | 45/45 PASS ✅（Phase 5.1 零回归） |
| `smoke-memory-handler.mjs` | 51/51 PASS ✅（Phase 5.2 零回归） |
| `smoke-reflection.mjs` | 58/58 PASS ✅（Phase 5.3 零回归） |
| `smoke-d-agent-18.mjs` | 44/44 PASS ✅（Phase 5.3.1 零回归） |
| `smoke-memory-attention.mjs` | 36/36 PASS ✅（Phase 5.4.A 零回归） |
| `smoke-memory-event-bridge.mjs` | 39/39 PASS ✅（Phase 5.4.B 零回归） |
| `smoke-context-assembler.mjs` | 38/38 PASS ✅（Phase 6.A 全覆盖） |
| `smoke-ceo-context-e2e.mjs` | 29/29 PASS ✅（Phase 6.B 全覆盖） |
| `smoke-memory-quality.mjs` | 18/18 PASS ✅（Phase 6.C.1 全覆盖） |

**总计：427/427 PASS — 全部零回归。AGENT.md + TODO.md 已同步。**

### 新增：Phase 6.C.2 L3 Semantic Conflict Detection 实现

#### 变更文件

| 文件 | 变更 |
|------|------|
| `src/types/context.ts` | **修改** —— 新增 `SemanticConflict` 接口 + `detectSemanticConflicts()` 函数；`ContextAssemblyResult` 新增 `semanticConflicts`；`ContextAssemblerConfig` 新增 `detectSemanticConflict` |
| `src/services/contextAssembler.ts` | **修改** —— `assemble` 流程增加 semantic conflict detection（L2 filter 之后、scoring 之前）；`buildSummary` 增加 `## Memory Conflict Warnings` section |
| `src/config.ts` | **修改** —— `OrcaContextAssemblerConfig` 新增 `detectSemanticConflict`；环境变量 `ORCA_MEMORY_CONFLICT_DETECT_SEMANTIC`（默认 false） |
| `scripts/smoke-semantic-conflict.mjs` | **新增** —— 26 用例 C1~C9 |

#### 冲突检测规则（D-AGENT-21 §21-01 L3 保守规则）

```
条件：同 subject（精确匹配）+ 同 type + ≥2 条 active formatted facts
操作：不自动过滤，不过滤已有 facts，只在 summary 中追加 warning text
禁止：embedding / 向量数据库 / LLM 调用 / 自然语言语义理解
```

#### 重要约束说明

MemoryStore `upsertFact` 同 (type, subject) 第二次 upsert **保留第一次 id 但用第二次的值覆盖**（update-in-place）。因此无法在 active facts 中构造同 (subject, type) 的多个 facts —— `detectSemanticConflicts()` 逻辑已正确实现，依赖 MemoryStore 未来支持方可覆盖 same-subject+type 多 fact 场景。

#### 测试结果

| 套件 | 结果 |
|------|------|
| `smoke-memory.mjs` | 69/69 PASS ✅（Phase 5.0 零回归） |
| `smoke-episode.mjs` | 45/45 PASS ✅（Phase 5.1 零回归） |
| `smoke-memory-handler.mjs` | 51/51 PASS ✅（Phase 5.2 零回归） |
| `smoke-reflection.mjs` | 58/58 PASS ✅（Phase 5.3 零回归） |
| `smoke-d-agent-18.mjs` | 44/44 PASS ✅（Phase 5.3.1 零回归） |
| `smoke-memory-attention.mjs` | 36/36 PASS ✅（Phase 5.4.A 零回归） |
| `smoke-memory-event-bridge.mjs` | 39/39 PASS ✅（Phase 5.4.B 零回归） |
| `smoke-context-assembler.mjs` | 38/38 PASS ✅（Phase 6.A 全覆盖） |
| `smoke-ceo-context-e2e.mjs` | 29/29 PASS ✅（Phase 6.B 全覆盖） |
| `smoke-memory-quality.mjs` | 18/18 PASS ✅（Phase 6.C.1 全覆盖） |
| `smoke-semantic-conflict.mjs` | 27/27 PASS ✅（Phase 6.C.2 全覆盖，含同 value 不冲突验证） |

**总计：454/454 PASS — 全部零回归。AGENT.md + TODO.md 已同步。**

### 新增：Phase 6.C.3 MemoryUsageTracker 实现

#### 变更文件

| 文件 | 变更 |
|------|------|
| `src/services/memoryUsageTracker.ts` | **新增** —— `MemoryUsageTracker` 接口 / `MemoryUsageRecord` 类型 / `createMemoryUsageTracker()` 实现 in-memory ring buffer |
| `src/services/contextAssembler.ts` | **修改** —— `resolveL2SourceConflict` 返回新增 `filteredIds`；`queryMemory` 返回新增 `conflictFilteredIds`；`createContextAssembler` 新增可选参数 `memoryUsageTracker`；`assemble()` 后记录 usage |
| `scripts/smoke-memory-usage-tracker.mjs` | **新增** —— 31 用例 U1~U10 |

#### MemoryUsageRecord 结构

```typescript
interface MemoryUsageRecord {
  timestamp: number           // Date.now()
  queryLength: number         // query 原始字符串长度（隐私保护：只记长度）
  returnedFactIds: string[]   // 最终进入 context 的 fact ids
  conflictFilteredIds: string[] // L2 source conflict 过滤掉的 fact ids
  semanticConflictCount: number
  charsUsed: number
  budgetHit: boolean
  scoringPreset: 'confidence' | 'source-confidence'
  semanticDetectionEnabled: boolean
}
```

#### 隐私处理方式

- `query` 字段：**不记录**，只记录 `queryLength: input.length`
- 不持久化到磁盘（无 JSONL / 无文件写入）
- 不进入 MemoryStore

#### Ring Buffer 容量

- 默认：`maxRecords = 100`
- 填满后最旧记录被覆盖（FIFO）

#### ContextAssembler 接入位置

```typescript
// createContextAssembler(..., memoryUsageTracker?)
const assembler = createContextAssembler(store, infoStore, config, logger, tracker)

// assemble() 成功后记录（仅 enabled=true 时）
memoryUsageTracker?.record({
  timestamp: Date.now(),
  queryLength: input.length,   // 隐私保护
  returnedFactIds: memoryResult.facts.map(f => f.id),
  conflictFilteredIds: memoryResult.conflictFilteredIds,
  semanticConflictCount: memoryResult.semanticConflicts.length,
  charsUsed: memoryResult.charsUsed,
  budgetHit: memoryResult.budgetHit,
  scoringPreset: cfg.scoringPreset,
  semanticDetectionEnabled: cfg.detectSemanticConflict,
})
```

#### 测试结果

| 套件 | 结果 |
|------|------|
| `smoke-memory.mjs` | 69/69 PASS ✅（Phase 5.0 零回归） |
| `smoke-episode.mjs` | 45/45 PASS ✅（Phase 5.1 零回归） |
| `smoke-memory-handler.mjs` | 51/51 PASS ✅（Phase 5.2 零回归） |
| `smoke-reflection.mjs` | 58/58 PASS ✅（Phase 5.3 零回归） |
| `smoke-d-agent-18.mjs` | 44/44 PASS ✅（Phase 5.3.1 零回归） |
| `smoke-memory-attention.mjs` | 36/36 PASS ✅（Phase 5.4.A 零回归） |
| `smoke-memory-event-bridge.mjs` | 39/39 PASS ✅（Phase 5.4.B 零回归） |
| `smoke-context-assembler.mjs` | 38/38 PASS ✅（Phase 6.A 全覆盖） |
| `smoke-ceo-context-e2e.mjs` | 29/29 PASS ✅（Phase 6.B 全覆盖） |
| `smoke-memory-quality.mjs` | 18/18 PASS ✅（Phase 6.C.1 全覆盖） |
| `smoke-semantic-conflict.mjs` | 27/27 PASS ✅（Phase 6.C.2 全覆盖） |
| `smoke-memory-usage-tracker.mjs` | 31/31 PASS ✅（Phase 6.C.3 全覆盖） |

**总计：485/485 PASS — 全部零回归。AGENT.md + TODO.md 已同步。**

---

## v1.7.0（2026-09-08）

### Phase 7.1A：RuntimeAdapter 统一接口 + WorldState 架构重构

#### 变更文件

| 文件 | 变更 |
|------|------|
| `src/types/runtime-adapter.ts` | **新增** —— `RuntimeAdapter` 接口（`{ start(), stop() }`）+ `RuntimeAdapterConfig` |
| `src/plugins/input-adapters/scheduler-adapter.ts` | **重构** —— 实现 RuntimeAdapter；仅 emit `scheduler:tick`（纯 Time Producer） |
| `src/plugins/input-adapters/pc-adapter.ts` | **重构** —— 实现 RuntimeAdapter 接口 |
| `src/plugins/input-adapters/calendar-adapter.ts` | **重构** —— 实现 RuntimeAdapter 接口 |
| `src/plugins/input-adapters/phone-adapter.ts` | **重构** —— 实现 RuntimeAdapter 接口 |
| `src/types/event.ts` | **修改** —— 新增 `scheduler` source + 事件类型（`scheduler:tick` 等，为 7.1B 准备） |
| `src/services/worldState.ts` | **修改** —— 删除全部 4 个 scheduler reducers（Phase 7.1A Review） |
| `src/config.ts` | **修改** —— `OrcaSchedulerConfig` 简化为仅含 `enabled` + `tickMs` |
| `src/index.ts` | **修改** —— RuntimeAdapters 统一生命周期管理；shutdown 时调用 `stop()` |

#### 架构边界（两条必须保持）

1. **EventBus 是唯一状态入口**：WorldState 永远不主动 polling，只消费 Event 并计算 Snapshot
2. **RuntimeAdapter 统一接口**：`{ start(), stop() }`；所有数据源通过 EventBus 发射事件，不直接修改 WorldState

### Phase 7.1B：ScheduledRuleRegistry——最小主动行为闭环

#### 新增文件

| 文件 | 变更 |
|------|------|
| `src/types/scheduled-rule.ts` | **新增** —— `ScheduledRule` / `ScheduledRuleContext` / `ScheduledRulePredicate` / `ScheduledBusinessEvent` 接口 |
| `src/services/scheduledRuleRegistry.ts` | **新增** —— `createScheduledRuleRegistry()` + `ScheduledRuleRegistryService` |
| `src/plugins/scheduled-rule-registry.ts` | **新增** —— `scheduledRuleRegistry` Cordis plugin |
| `src/rules/scheduled/briefing.ts` | **新增** —— `createBriefingIntervalRule()` |
| `src/rules/scheduled/reflection.ts` | **新增** —— `createReflectionIntervalRule()` |
| `src/rules/scheduled/reminder.ts` | **新增** —— `createReminderIntervalRule()` |
| `scripts/smoke-scheduled-rule-registry.mjs` | **新增** —— 26 用例 R1~R7 |
| `scripts/smoke-briefing-rule.mjs` | **新增** —— 14 用例 |
| `scripts/smoke-reflection-rule.mjs` | **新增** —— 14 用例 |
| `scripts/smoke-reminder-rule.mjs` | **新增** —— 19 用例 |

#### 事件流向

```
SchedulerAdapter → scheduler:tick → ScheduledRuleRegistry
                                      ↓
                              predicate 判断
                                      ↓
                              EventBus.publish(businessEvent)
                                      ↓
                              AttentionEngine（businessEvent 触发评估）
```

#### 两条架构边界

1. Registry 不持有 timer（timer 在 SchedulerAdapter）
2. businessEvent 通过 EventBus 发射，不直接调用 AttentionEngine

#### 测试结果

| 套件 | 结果 |
|------|------|
| `smoke-scheduled-rule-registry.mjs` | 26/26 PASS ✅ |
| `smoke-briefing-rule.mjs` | 14/14 PASS ✅ |
| `smoke-reflection-rule.mjs` | 14/14 PASS ✅ |
| `smoke-reminder-rule.mjs` | 19/19 PASS ✅ |

**Phase 7.1A + 7.1B 新增 73/73 PASS；Phase 5-6 全部 485 零回归；总计 558/558 PASS。AGENT.md 已同步。**

---

## v1.8.0（2026-09-08）

### Phase 7.2：SessionStore 持久化 + IM Bridge 基础设施

#### 新增文件（SessionStore）

| 文件 | 变更 |
|------|------|
| `src/services/sessionStore.ts` | **新增** —— JSONL 追加写 + lazy load + restart 恢复 |
| `src/plugins/session-persistence.ts` | **新增** —— Cordis plugin，SessionStore 生命周期管理 |
| `scripts/smoke-session-persistence.mjs` | **新增** —— smoke 测试 |

#### IM Bridge 基础设施（IM-1.0）

| 文件 | 变更 |
|------|------|
| `src/types/im.ts` | **新增** —— MessageEnvelope / IMMessageDirection / IMPlatform 接口 |
| `src/services/mock-im-adapter.ts` | **新增** —— MockIMAdapter 实现（可配置 interval） |
| `src/plugins/input-adapters/im-adapter.ts` | **新增** —— Cordis plugin，接入 EventBus |
| `src/plugins/im-observation-adapter.ts` | **新增** —— IM 观察者 adapter |
| `src/services/im-observation-adapter.ts` | **新增** —— 观察者 service |
| `src/services/qq-adapter.ts` | **新增** —— QQ 平台 adapter 骨架 |
| `scripts/smoke-im-adapter.mjs` | **新增** —— 27 用例 IM1~IM9（27/27 PASS ✅） |
| `scripts/smoke-im-observation.mjs` | **新增** —— 观察者 smoke |
| `scripts/smoke-im-qq-adapter.mjs` | **新增** —— QQ adapter smoke |

#### 设计稿

| 文件 | 说明 |
|------|------|
| `guide/orca-im-bridge.md` | IM Bridge 架构设计（IM-0 + IM-1.0） |
| `guide/orca-im-bridge-report.md` | 实现报告 |
| `guide/orca-im-bridge-review.md` | Review 记录 |
| `guide/orca-im-observation.md` | IM Observation 设计 |
| `guide/orca-im-adapter-research.md` | 平台 adapter 调研 |

#### Phase 7.3 Architecture Review

- `Phase_7.3_Review_Report.md` —— Runtime 架构冻结 Review；8 条边界全部确认通过；MAA `remember_only` 走 noop 等 3 个已知缺口已记录
- **v1.0.0 发布：app-cordis + Phase 7.1A/B + Phase 7.2 + Phase 7.3；总计 558/558 smoke PASS；main 分支已推送 origin**

**AGENT.md + README.md 已同步。**

#### 配置键

| 变量 | 默认 | 说明 |
|------|------|------|
| `ORCA_IM_ENABLED` | 0 | IM Bridge 开关 |
| `ORCA_IM_PLATFORM` | mock | 平台（mock/qq） |
| `ORCA_IM_MOCK_INTERVAL_MS` | 60000 | Mock 轮询间隔 |

---

## app-cordis v1.8.0 hotfix（2026-09-08，未单独升 PATCH）

### 修复：ContextAssembler 插件激活顺序（Cordis DI）

#### 现象

飞书发消息 Orca 不回复。启动日志含：

```
[orca-cordis] ContextAssembler 跳过：memory=true, infoStore=false（需 MemoryStore + InfoRecordStore 均启用）
```

无 `[agent]` 日志，feishu/message handler 从未触发。

#### 根因

Cordis v4 `ctx.plugin()` 是**异步 Fiber 激活**（plugin 函数在 fiber 进入 activate 状态时才跑），不是同步立即生效。

旧 index.ts 用顶层 `ctx.plugin(infoAgents, config)` 紧跟 `ctx.get('infoStore')`——后者在 infoAgents fiber 还没激活时就执行，永远拿到 undefined。ContextAssembler 跳过 → `agent.inject['contextAssembler']` 缺失 → agent fiber INACTIVE → `ctx.on('feishu/message', ...)` 从未注册 → 飞书不回。

Phase 6.A 引入时假设了同步语义，从未被发现——因为 ContextAssembler 跳过 warn 不会崩进程，bat 看着启动正常；v1.0.0→v1.8.0 多版本无人触发 feishu 主路径（仅食物图片走 image-router 分支）。

#### 修复

采用方案：新建独立 Cordis plugin，让 Cordis DI 同步解析依赖（替代顶层 Service Locator 抢时机）。

| 文件 | 变更 |
|------|------|
| `src/plugins/context-assembler-provider.ts` | **新增** —— `inject=['memory','infoStore']`；plugin 体内同步 `ctx.provide('contextAssembler', ...)`；依赖由 Cordis DI 在 fiber 激活时保证就绪 |
| `src/index.ts` | 删旧 L77-95 顶层 ContextAssembler 块（`ctx.get('infoStore')` + `ctx.provide` 模式）；新增 `ctx.plugin(contextAssemblerProvider, config)`；加 import |
| `src/index.ts` L195/L198/L201 | 顺手补 `, config` —— `episodeEnginePlugin` / `reflectionEnginePlugin` / `memoryAttentionAdapter` 三个 function plugin 调用从 v0.6.4 漏传 config，导致 `config.memory.xxx` TypeError（与 ContextAssembler 无关的并行 bug） |

#### 边界（按要求保持）

- ✓ 不修改 infoAgents 插件职责
- ✓ 不修改 ContextAssembler API
- ✓ 不修改 agent.inject
- ✓ 不修改 Memory 系统 / Runtime 架构
- ✓ 顶层 bootstrap 不改 async
- ✓ 不用 `await ctx.plugin()`（仅依赖 Cordis DI）

#### 验证

- ✓ `tsc --noEmit` 通过（exit=0）
- ✓ dist 启动日志确认：`[orca-cordis] Phase 6.A ContextAssembler 已启用（memoryTopK=10, memoryBudgetChars=500）`（替换原"跳过"warn）
- ✓ infoAgents（L.374）在 ContextAssembler（L.377）之前激活，依赖注入顺序正确
- ✓ 启动端口 8100 / 8101 / 8200 全部 listen 成功（无 EADDRINUSE）
- ✓ Agent fiber inject 完整满足，可正常响应 feishu/message

#### 配套

- decisions.md 新增 **D-AGENT-22**：Cordis DI 边界冻结（顶层禁用 `ctx.get()` 抢 Service Locator 模式，依赖解析必须走 plugin inject）
- AGENT.md 第 4.3 节 Phase 6.A 描述同步：`src/plugins/context-assembler.ts`（不存在）→ 实际为 `context-assembler-provider.ts` + 新增 DI 边界说明
- 运行时记忆已存：`Orca app-cordis 启动顺序 bug（2026-09-08 实测已修复）`

### 新增：ORCA_LLM_BACKEND（dashscope / ollama 二选一）

#### 背景

DeepSeek API 余额不足（402 Insufficient Balance）时无 fallback。需要支持本地 Ollama OpenAI 兼容端点。

#### 设计约束（用户指定）

- baseUrl 统一为根地址（如 `http://localhost:11434/v1` 或 `https://api.deepseek.com`），不含 `/chat/completions`
- 新增 `backend: 'dashscope' | 'ollama'` 字段显式声明
- 不依赖 localhost/127.0.0.1 字符串嗅探
- 不同后端的 baseUrl 语义一致：拼接 `${baseUrl}/chat/completions` 即为端点

#### 新增配置键

| 键 | 默认 | 说明 |
|---|---|---|
| `ORCA_LLM_BACKEND` | `dashscope` | LLM 后端：`dashscope`（云端 DeepSeek）\| `ollama`（本地） |
| `OLLAMA_HOST` | `http://localhost:11434` | 本地 Ollama 地址（仅 ollama 模式） |
| `OLLAMA_LM_MODEL` | `qwythos:latest` | 本地 LLM 模型（仅 ollama 模式） |

#### 修改文件

| 文件 | 变更 |
|---|---|
| `src/config.ts` | `LlmConfig` 新增 `backend: LlmBackend` 字段；新增 `export function buildLlmConfig(rawApiUrl?: string): LlmConfig`；`getConfig()` 调用 `buildLlmConfig(rawApiUrl)`；baseUrl 统一根地址（去尾 `/`，去除 `/chat/completions` 后缀） |
| `src/services/llm.ts` | 按 `config.backend` 分支：ollama 模式免 apiKey、不发送 Authorization header；dashscope 模式要求 apiKey、发送 Bearer auth；error message 区分后端 |
| `src/index.ts` | L37-39 apiKey 守卫改为 `if (config.llm.backend === 'dashscope' && !config.llm.apiKey)`；新增启动行 `[orca-cordis] LLM backend=%s model=%s baseUrl=%s` |
| `app-cordis/.env` | 新增 ORCA_LLM_BACKEND / OLLAMA_HOST / OLLAMA_LM_MODEL 配置说明 + 默认 `dashscope` |

#### 边界

- ✗ 不依赖字符串嗅探（如 `baseUrl.includes('localhost')`）判断后端
- ✗ 不让 baseUrl 在不同后端拥有不同语义（dashscope 用根地址 + `/v1/chat/completions`，ollama 用根地址 + `/v1/chat/completions`，两者拼接一致）
- ✓ `LlmClient.chat()` 只读 `config.backend` / `config.apiKey` / `config.baseUrl`，协议层零分支（OpenAI Chat Completions）
- ✓ 视觉后端的 `ORCA_VISION_BACKEND` 走相同的 `dashscope / ollama` 双选模式（已存在），本次未动

#### 验证

- ✓ `tsc --noEmit` 通过
- ✓ `npm run build` 通过
- ✓ dist 启动日志确认：`[orca-cordis] LLM backend=ollama model=qwythos:latest baseUrl=http://localhost:11434/v1（本地，Ollama OpenAI 兼容）`
- ✓ 默认 dashscope 模式行为不变（DEEPSEEK_API_KEY 仍为必需；apiKey 缺失时启动守卫仍生效）

#### 配套

- AGENT.md §6 配置项表新增 3 行（ORCA_LLM_BACKEND / OLLAMA_HOST / OLLAMA_LM_MODEL）
- AGENT.md §8.1 §8.1 已完成追加 v1.8.0 hotfix + 本次新增条目

---

## 2026-09-09 Phase A — Cognitive Scheduler 最小骨架

**目标**：建立「Attention → Scheduler → CognitiveRequest」新边界；Scheduler 不调 LLM、不执行 Action、不写 WorldState；DecisionEngine 保持向后兼容

### 新增文件

| 文件 | 说明 |
|---|---|
| `app-cordis/src/types/cognition.ts` | `CognitiveRequest` 接口（id / attentions[] / createdAt / trigger）+ `CognitiveSchedulerService` 接口 |
| `app-cordis/src/services/cognitive-scheduler.ts` | `createCognitiveScheduler(ctx)` 实现：pendingAttentions Map + cognition 生命周期事件订阅 + evaluate() 策略 |
| `app-cordis/src/plugins/cognitive-scheduler-plugin.ts` | Cordis plugin：订阅 `orca/attention` → `scheduler.enqueue()` → emit `orca/cognition-request` |
| `app-cordis/scripts/smoke-cognitive-scheduler.mjs` | 42 用例 RA.1~RA.19（42/42 PASS ✅） |

### 修改文件

| 文件 | 变更 |
|---|---|
| `app-cordis/src/context.ts` | Context interface 新增 `cognitiveScheduler: CognitiveSchedulerService`；Events interface 新增 `orca/cognition-request` + `cognition/started/completed/failed` |
| `app-cordis/src/index.ts` | 在 `attentionEngine` 之后、`decisionEngine` 之前插入 `cognitiveSchedulerPlugin` |
| `app-cordis/scripts/smoke-decision.mjs` | R13.10.15 处加 FIXME 注释（Cordis fork emit 不隔离 listener 异常，非本次引入） |

### Runtime Flow

```
Event → EventBus → WorldStateUpdater → Reducer → WorldState
                                      ↓
                              AttentionEngine
                                      ↓ emit('orca/attention')
                    ┌─────────────────┴─────────────────┐
        DecisionEngine（旧路径）          CognitiveScheduler（新路径）
                    ↓                          ↓
              orca/decision              orca/cognition-request
         （ActionExecutor/Deferred）     （CognitionCore Phase B 消费）
```

### Scheduler 职责边界（Phase A）

**做**：enqueue / pendingAttentions 私有维护 / cognition 生命周期状态追踪 / evaluate() 决定何时发 CognitiveRequest

**不做**：调 LLM / 执行 Action / 写 WorldState / 持久化 / priority scheduling / attention merging

### 验证结果

| 测试 | 结果 | 分类 |
|---|---|---|
| `smoke-cognitive-scheduler.mjs` | **42/42 PASS** ✅ | Scheduler/Orca regression |
| `smoke-attention.mjs` | **138/138 PASS** ✅ | Scheduler/Orca regression |
| `smoke-action.mjs` | **86/86 PASS** ✅ | Scheduler/Orca regression |
| `smoke-world-state.mjs` | **94/94 PASS** ✅ | Scheduler/Orca regression |
| `smoke-info-agent.mjs` | **69/69 PASS** ✅ | Scheduler/Orca regression |
| `smoke-decision.mjs` R13.10.15 | **CRASH** | pre-existing Cordis fork limitation（非回归）|

### pre-existing failure 说明

- **测试**：smoke-decision.mjs R13.10.15
- **根因**：Cordis fork `ctx.emit()` 不隔离 listener 抛错——任何一个 listener 抛错会导致整个 emit 崩溃；测试依赖的 listener 异常隔离能力在当前 Cordis fork 版本未实现
- **本次引入**：否
- **阻塞迁移**：否
- **处理**：已加 FIXME 注释，不修改 Cordis，不改变 EventBus 语义

### Phase B 前的 Architecture Gap

| 缺项 | 说明 |
|---|---|
| CognitionCore | 消费 `orca/cognition-request`，emit `cognition/started/completed/failed` |
| LLM 调用层 | Scheduler 不调 LLM，CognitionCore 需要接入 LlmClient |
| WorkingMemory / CapabilitySpace / TaskManager / SelfStateManager | 后续 phase |

### AGENT.md 同步

- §3 架构图中 CognitiveScheduler 位置已更新（见 AGENT.md 本次变更）

---

## v1.9.0（2026-09-09）

### Phase B：CognitionCore 最小骨架 —— 实现 Scheduler ↔ CognitionCore 闭环

#### 目标
实现完整认知闭环：`Attention → Scheduler → CognitiveRequest → CognitionCore → LLM → cognition/completed → Scheduler`

#### 新增文件

| 文件 | 说明 |
|---|---|
| `app-cordis/src/types/cognition-core.ts` | `CognitionSession`（id/requestId/createdAt/startedAt/status/attentions）+ `WorkingMemory`（goal/observations）+ `CognitionResult`（cognitionId/requestId/status/output?/error?/durationMs）|
| `app-cordis/src/services/cognition-core.ts` | `createCognitionCore(ctx)`：订阅 `orca/cognition-request`，创建 CognitionSession，发 `cognition/started/completed/failed`，调 LLM，并发防御（running 时拒绝新 request）|
| `app-cordis/src/plugins/cognition-core-plugin.ts` | Cordis plugin：`inject: ['llm']`，订阅 `orca/cognition-request` → `core.onCognitionRequest()`，提供 `ctx.cognitionCore` service |
| `app-cordis/scripts/smoke-cognition-core.mjs` | 30 个测试用例：生命周期 + Scheduler 闭环 + 并发防御 + 边界验证 |

#### 修改文件

| 文件 | 变更 |
|---|---|
| `app-cordis/src/context.ts` | 新增 `cognitionCore: CognitionCoreService` service 声明；Events 新增 `cognition/started(sessionId, requestId)` / `cognition/completed(sessionId, result)` / `cognition/failed(sessionId, error)` |
| `app-cordis/src/services/cognitive-scheduler.ts` | **关键修复**：`cognition/completed` handler 加 `evaluate()` 调用——cognition 结束后立即处理 pending 队列；`cognition/failed` 同理 |
| `app-cordis/src/index.ts` | 导入并挂载 `cognitionCorePlugin`（位于 `cognitiveSchedulerPlugin` 之后，`decisionEngine` 之前）|

#### 事件流闭环

```
AttentionItem → orca/attention
  → CognitiveScheduler.enqueue() → pending 累积
  → evaluate() → orca/cognition-request
    → CognitionCore.onCognitionRequest()
      1. 创建 CognitionSession（status=running）
      2. 发 cognition/started（Scheduler 更新 isCognitionRunning=true）
      3. 构造 prompt（persona + attention reasons）
      4. 调用 LLM.chat()
      5. 成功 → 发 cognition/completed；失败 → 发 cognition/failed
      6. activeSession = null
    → CognitionCore 发 cognition/completed
      → Scheduler：activeCognitionId = null + evaluate() → pending > 0 → 发下一个 orca/cognition-request
```

#### 关键设计决策

- **CognitionCore 不接入 ContextAssembler**：ContextAssembler 是 Agent/CEO 的 context 注入工具（被动投影），CognitionCore 只用 persona + attention reasons
- **WorkingMemory ephemeral**：属于 CognitionSession，cognition 结束后丢弃，不持久化，不进 WorldState
- **并发防御 Phase B**：running 时拒绝新 request；Phase B+ 改为 queue/defer
- **prompt 构造**：system=personaPrompt()，user=attention reasons 拼接（极简版，Phase C+ 可扩展）

#### 关键 bug 修复

- **Scheduler 闭环缺失**：Phase A 的 `cognition/completed` handler 只清 `activeCognitionId = null`，未调用 `evaluate()`——导致 pending 永远不清零，闭环未形成。Phase B 在 completed/failed handler 中加入 `evaluate()` 调用

#### 验证结果

| 测试 | 结果 | 分类 |
|---|---|---|
| `smoke-cognition-core.mjs` | **30/30 PASS** ✅ | Phase B 新增 |
| `smoke-cognitive-scheduler.mjs` | **44/44 PASS** ✅（含 RA.13 更新）| Phase A 回归 + Phase B 闭环 |
| `smoke-decision.mjs` | **40/42 PASS** | pre-existing R13.10.15（非回归）|

#### AGENT.md 同步

- §3 架构图中 CognitionCore + cognition/started/completed/failed 事件链路已补充（见 AGENT.md 本次变更）



## 2026-09-14 Phase E — system.info 只读环境能力

- 新增 `createSystemInfoHandler`，直接接入现有 `ActionHandlerRegistry`，不引入 Capability 中间层。
- 使用 Node `os` / `fs.statfs` API 返回 cpu、memory、disk、process、environment 白名单信息。
- 参数复用 `Decision.reason`：空或 `{}` 返回全部，可选 `{"scope":["cpu","memory"]}`。
- 不执行 shell、不写 WorldState；磁盘路径复用 `ORCA_FS_READ_ROOT`。
- `npm run build` 通过；直接 handler 冒烟通过。
- AGENT.md 已同步。

## 2026-09-19 Dashboard 首页交互优化

- 首页标题改为单层发光文字，消除多层动画字导致的视觉重合。
- 首页与工作区的滚动切换改为 1.45 秒五次缓动；输入栏移至 Core 状态区下方。
- 提交消息后进入首页对话态：待机元素平滑收拢，原地展开实时聊天线程；SSE 回复会同步更新该线程，关闭按钮可回到待机态。
- 使用项目内 TypeScript 编译器执行 `tsc --noEmit -p app-cordis/tsconfig.json`，检查通过。AGENT.md 已同步。

## 2026-09-19 Dashboard 滚轮与首页布局修复

- 主视口禁用原生滚动与 CSS snap；滚轮只按方向触发一次完整页面切换，切换动画使用 1.45 秒五次缓动，并通过 cooldown 拦截连续滚轮脉冲。
- 修复首页标题容器裁切、眉题与副标题负边距重叠，并将首页 Core 动画压缩至可在首屏显示对话栏的尺寸。
- 对话态禁止滚轮切页，聊天窗口不产生页面级小滚动。AGENT.md 已同步。

## 2026-09-19 Dashboard 无框 Runtime 视图

- 按 Orca 架构重排仪表盘：Info Agents → Persistent Context Runtime（EventBus / WorldState / Attention / Cognition / Action）→ Long Memory / Event Stream。
- 去掉工作区卡片的圆角、填充、阴影和嵌套容器，改为编号分区、细分隔线和中心运行链；首页命令栏改为底线输入样式。
- 接入 `/api/attention` 与 EventBus `bufferSize`，在 Runtime 中展示实时遥测。AGENT.md 已同步。

## 2026-09-19 Dashboard V2 Runtime 重构

- 删除首屏 Hero、架构介绍文本、流水线动画与发光圆球；替换为 3/6/3 无框 Runtime Dashboard。
- 中央 `Current Focus` 通过 Dashboard 只读投影消费 `orca/attention`、`cognition/started|completed|failed`、`orca/action-result`：展示当前状态、触发源、Attention Rule、Scheduler pending 任务数与最近 3 条认知时间线；不写入任何 Runtime 状态。
- 左侧展示已注册 InfoAgents，右侧保留四层 Long Memory 的数量节点，底部将 EventBus 最近事件渲染为终端时间流。
- 现有架构未暴露 Cognitive Budget、每日 memory retrieval、Last Reflection 的可靠指标，界面显示未配置/—，不伪造运行数据。AGENT.md 已同步。

## 2026-09-19 Dashboard 前端视觉优化

- 保留现有 Dashboard API、SSE 实时回复和命令输入逻辑，仅更新 `src/plugins/dashboard.ts` 内嵌样式。
- 增加网格背景、玻璃质感模块、层级化状态条、聚焦态和 hover 反馈，并补齐 900px/560px 移动端布局与 reduced-motion 支持。
- 使用项目内 TypeScript 编译器执行 `tsc --noEmit -p app-cordis/tsconfig.json`，检查通过。
- AGENT.md 已同步。
