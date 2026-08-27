# Project Orca — Agent 启动上下文（AGENT.md）

> **给新会话/新代理的启动引导**：开工前先通读本文档，再按需深读具体文件。本文档是当前代码（**v2.3.0**）的权威快照。
> 与 `README.md`（v2.1.1，部分过期）、`project-orca-overview.md`（早期愿景，已过时）、`dev-log.md`（历史日志）冲突时，**以本文档 + 源码为准**。
> **维护规则（硬性，见 `guide/decisions.md` D-VER-04）**：每次代码有实质变更（新 skill、机制调整、版本升级），**提交前必须同步本文档**——改目录结构/skill 清单/机制/配置键/版本号/待办中任一项即必改对应板块；dev-log 条目末尾标注"AGENT.md 已同步"。代码改了但本文档停在旧状态 = 违规提交。

---

## 0. 一句话定位

**通过飞书聊天的本地桌面 AI 助手**（"全向性室内控制代理"）。给 Orca 发飞书消息，它帮你操作电脑、看屏幕、搜网、点瑞幸咖啡。人设：闷骚技术宅管家，话不多但不冷漠，称用户"老板"。跑在用户 Windows 笔记本上，FastAPI 服务 + SSH 隧道暴露公网收飞书回调。

---

## 1. 快速启动

```bash
# 配置：复制 .env.example 为 .env，填 DEEPSEEK_API_KEY / QWEN_API_KEY / FEISHU_APP_ID / FEISHU_APP_SECRET / AMAP_API_KEY 等
pip install -r requirements.txt
python -m src.main          # 服务起在 http://127.0.0.1:8000
# Windows 一键启动（含 SSH 隧道到 47.76.188.165:8000）：start.bat
```

飞书侧：开放平台创建应用 → 机器人能力 → 事件订阅 URL `http://<公网>:8000/feishu/webhook` → 订阅 `im.message.receive_v1` → 发布。只处理 **p2p 单聊文本消息**。

---

## 2. 当前架构（v2.3.0）：Plan-then-Execute

```
飞书消息 → router/feishu.py（去重/校验）
  → Orchestrator（串行锁 + ACK + 重试）
      → Planner（关键词匹配 → 约束过滤[stub] → LLM 一次输出 JSON DSL）
      → Validator（四层校验：安全[stub] → 格式 → 引用 → 参数）
      → Engine（顺序执行 DSL，narration 进度提示，引用解析）
          → Skill handler（原子操作，唯一可执行单元）
      → reply skill 发最终回复 → 历史写入内存
```

设计原则（详见 `guide/memory-pack.md`）：**LLM=规划器、DSL=行为语言、Runtime=确定性执行器、Skill=原子能力单元**；闭集注册表，LLM 不能发明 skill；fail-fast，plan 最后一步必须是 reply。

### 消息处理全链路（orchestrator._process_new）

1. 加历史 → 检查 `_busy`，忙则入队（串行锁，FIFO）
2. 构建 planner 上下文：`session_state` + `active_task`（格式化注入）
3. **Planner.plan()** → 返回 `(ack_msg, raw_dsl, candidates)`
4. **ACK**：仅当 plan 非"纯闲聊"（>1 步或含操作）才发 ack；纯闲聊（单步 reply）跳过
5. **Validator.validate()**：层 1（格式）或层 3（参数）失败 → 重试一次（错误反馈注入 `_last_error`）；层 2 失败不重试
6. **Engine.execute()**：顺序执行，每步先发 narration；失败 fail-fast 自动发错误消息
7. **active_task 更新**：plan 带 `task_type` → 更新/保持；否则清空
8. 历史记录 + 返回 final_message

---

## 3. 目录结构（当前真实状态，与 README 的旧结构图不同）

```
src/
├── main.py                    # FastAPI 入口；lifespan 里装配 FeishuClient + Orchestrator；版本 2.3.0
├── config.py                  # .env 加载；无 USE_NEW_ARCH（旧开关已随 Phase C 移除）
├── router/
│   └── feishu.py              # webhook：challenge 验证、event_id 60s 去重、仅 p2p 文本、fire-and-forget、/health
├── core/
│   ├── orchestrator.py        # 总调度：串行锁、ACK 条件化、Validator 重试、active_task 状态机
│   ├── planner.py             # 三阶段规划：关键词匹配 → 过滤(stub) → LLM 出 JSON DSL；STAGE_SKILL_MAP
│   ├── history.py             # 内存会话（Conversation：turns≤10 + active_task 字段）
│   ├── persona.py             # ORCA_PERSONA_PROMPT（仅 refine 用；planner 已移除人设）
│   └── search.py              # cn.bing.com 爬取（BeautifulSoup .b_algo）
├── dsl/
│   ├── schema.py              # Plan/SkillCall 数据模型 + REF_PATTERN({{step.<id>.output}})
│   └── validator.py           # 四层校验 + JSON 智能提取（_extract_json）
├── skill/
│   ├── registry.py            # SkillRegistry：闭集，metadata+handler；schemas 属性供 Validator
│   ├── builtins.py            # create_registry()：注册全部 19 个 skill（唯一注册点）
│   └── handlers/              # reply / action / screenshot / analyze / search / refine / luckin
├── runtime/
│   ├── engine.py              # 顺序执行器；SkillDeps（feishu/session_id/luckin_mcp/session_state）
│   └── context.py             # RuntimeContext：纯数据（outputs 字典）
├── feishu/
│   └── client.py              # tenant_access_token 缓存、send_text/reply_text/send_image/upload
└── tasks/
    └── luckin_mcp.py          # LuckinMCPClient：JSON-RPC over streamable-http，Bearer token
scripts/
└── cleanup_tunnel.py          # SSH 隧道旧端口清理（paramiko）
guide/
├── memory-pack.md             # 设计规范（5 层架构、设计原则、5 阶段演进）
├── decisions.md               # 架构决议 D-*（DSL/Skill/Validator/Orchestrator/Planner/Runtime/版本 + D-AGENT-*）
├── orca-cordis-migration-plan.md  # ★ Cordis 迁移方案（v1.0 定稿，见 §9.3）
├── orca-info-agent-framework.md   # ★ 小型信息 Agent 框架设计（v0.2 设计稿，Phase 2 部分落地：food-agent Pull+Push/档案室/R0 查档）
└── orca-iphone-channel.md         # ★ iPhone 数据通道调研（三通道：飞书/webhook/文件同步，D-AGENT-13）
app-cordis/                    # ★ Cordis/TypeScript 版（Phase 1 最小闭环 + Phase 2 信息获取框架 + Phase 0+1/2 Persistent Context Runtime，见 §9.3）
│   ├── src/agents/            # 信息获取框架：types（InfoAgent/InfoRecord）registry（闭集）store（档案室 JSONL）executor（Pull 执行）router（R0/R1）builtins/food-log.ts（food-agent，含 handleDeleteIntent 确定性删除）
│   ├── src/services/          # feishu / llm（DeepSeek）/ vision（Qwen VL Ollama 原生 /api/chat）/ eventBus（v0.5.0 OrcaEvent 流）/ worldState（v0.5.0 Phase 2 WorldStateService + reducer 注册表 + computeTimeContext）
│   ├── src/plugins/           # feishu-channel（p2p/群聊，事件带 chat_id）/ agent（CEO：R0 查档 + 待汇报）/ info-agents / info-receiver（POST /info/records+POST /info/images，含 90s imageUrl 兜底）/ image-router（D-AGENT-15 工位路由）/ food-image（food 管线处理器）/ dashboard（HTTP 8200 + /api/events + /api/world-state + /api/attention + /debug/publish-event）/ orca-runtime（Runtime 装配）/ world-state-updater（WorldState 订阅 EventBus + setInterval time tick）/ attention-engine（Phase 3 纯规则注意力引擎）/ input-adapters/feishu-adapter（翻译层）/ input-adapters/pc-adapter（mock）/ input-adapters/calendar-adapter（mock）/ input-adapters/phone-adapter（mock）
│   ├── src/types/             # event.ts（v0.5.0 OrcaEvent / EventFilter / PublishEventInput）/ worldState.ts（v0.5.0 UserState/DeviceState/TimeContext/WorldState）
│   ├── src/scripts/           # 工具脚本：list-food.mjs（CLI 列出 food-log 档案）
│   └── src/data/              # records/ 档案室 JSONL + images/ 图片落盘（均 gitignore）
```

---

## 4. 核心机制速查

### 4.1 Orchestrator
- **串行锁**：`_busy` + `_pending` 队列 + `asyncio.Lock`；同刻只跑一个 plan，消息排队
- **ACK 条件化**：`_is_simple_chat(raw_dsl)` = 单步且 skill 为 reply → 跳过 ACK
- **重试**：Validator 层 1/3 失败 → 重规划一次（`_last_error` 注入），层 2 不重试
- **active_task**：`{task_type, stage, context}`，挂在 `Conversation` 上；`_format_active_task` 注入 planner；`_sync_task_context` 从 session_state 同步 5 个 key（selected_dept_id/name、store_list、menu_items、specs_shown）

### 4.2 Planner（core/planner.py）
- 候选集 = `{reply, refine}` ∪ 关键词匹配 ∪ **阶段注入**（STAGE_SKILL_MAP）
- 关键词匹配：skill.keywords 子串 → skill.name 子串 → 中文分词双向匹配（2-4 字滑窗 + 单字）
- **STAGE_SKILL_MAP**（按 active_task.stage 强制注入 skill）：
  `store_listed/store_selected → luckin_search_menu`；`menu_searched → luckin_get_product_detail`；`detail_shown → luckin_preview_order`；`previewed → luckin_create_order`
- System prompt 规则 1-11（重点）：只输出 JSON；最后一步必须 reply；reply 必须引用上一步 output（`{{step.<id>.output}}`，不能硬编码）；已知信息直接抄字面量不引用；持续任务带顶层 task_type/stage；转移话题不带 task_type
- LLM 调用：DeepSeek（`deepseek-v4-flash`），temperature 0.3，max_tokens 4000，**不用 function calling**（纯 JSON 文本输出）
- `_strip_markdown_json` 剥 ```json 代码块；`_extract_ack` 兜底"好的，正在处理。"

### 4.3 Validator（dsl/validator.py）
| 层 | 内容 | 失败处理 |
|----|------|---------|
| 0 | 安全审查（**stub**，永远 safe） | — |
| 1 | 格式：合法 JSON、steps 非空、每步有 skill、**最后一步是 reply** | 重试一次 |
| 2 | 引用：`{{step.<id>.output}}` id 存在且在**之前**（支持 skill 名作隐式 id） | fail-fast |
| 3 | 参数：skill 存在、必填/类型(int 自动转换)/enum | 重试一次 |

### 4.4 Engine（runtime/engine.py）
- 顺序执行；step_id = 显式 id 或 skill 名（重名加 `_N` 后缀）
- 每步先发 narration（`step.narration` 优先，fallback `progress_message`）
- `_resolve_refs`：替换 `{{step.x.output}}`；int 参数从文本提取数字（`dept_id: 12345` / 任意数字）
- 失败：fail-fast，自动发错误消息；reply 执行后立即终止
- **SkillDeps**：feishu / session_id / luckin_mcp / session_state（handler 跨轮数据通道）

### 4.5 session_state / active_task（多轮任务核心）
- `session_state`：**handler 写入**（选店、菜单、规格标志）→ Orchestrator 搬运到 `active_task.context` → Planner 注入 LLM prompt → 下一轮 handler 继续用
- `active_task`：**跨 plan 的任务状态机**，挂在会话上；`task_type` 缺失/空 → 自动清空（转移话题即终止任务，无需取消 skill）
- 瑞幸流程示例：`luckin_find_store` 写 store_list → 用户说"第一家" → Planner 从 session_state 取 dept_id 直填字面量 → `luckin_search_menu` …

### 4.6 飞书路由（router/feishu.py）
- challenge 验证；event_id 去重（60s 窗口）；只处理 `chat_type=p2p` + `message_type=text`；`asyncio.ensure_future` fire-and-forget（立即回 200）

---

## 5. Skill 全清单（19 个，注册点：skill/builtins.py）

**通用（11）**

| Skill | 参数 | 说明 |
|-------|------|------|
| `reply` | message(必) | 发最终回复；plan 最后一步必须用它 |
| `capture_screenshot` | — | 截桌面，返回图片路径 |
| `analyze_image` | task(必), image_path(必) | Qwen 视觉分析；图片来源：截图步骤输出/用户提供 |
| `click` | x(必), y(必) | 左键点击（坐标经屏幕范围校验） |
| `double_click` | x(必), y(必) | 双击 |
| `right_click` | x(必), y(必) | 右键 |
| `move_mouse` | x(必), y(必) | 移动鼠标 |
| `type_text` | text(必) | 光标处输入文字 |
| `scroll` | clicks(必), direction(up/down, 默认down) | 滚轮 |
| `refine` | raw_output(必) | 用 DeepSeek 把原始输出润色成 Orca 语气 |
| `search_web` | query(必) | bing 搜索返回摘要 |

**瑞幸点单（8）**

| Skill | 参数 | 说明 |
|-------|------|------|
| `luckin_find_store` | query(选) | 查门店：地点名→城市表；空→.env 坐标→高德 IP 定位 |
| `luckin_search_menu` | dept_id(必), query(必) | 搜菜单；**返回产品级 SKU，不可直接下单** |
| `luckin_get_product_detail` | dept_id(必), product_id(必) | 商品详情+规格选项；返回 **variant 级 SKU**；置 `specs_shown=True` |
| `luckin_switch_product` | dept_id, product_id, sku_code, attribute_id, sub_attribute_id, amount(选) | 切换规格（冰/热/糖度/杯型），返回新 variant SKU |
| `luckin_preview_order` | dept_id, product_id, sku_code, amount(选) | 预览订单；**守卫：必须 specs_shown 过** |
| `luckin_create_order` | dept_id, product_id, sku_code, amount(选) | 下单（坐标用 .env LUCKIN_LAT/LNG） |
| `luckin_query_order` | order_id(必) | 查订单状态/取餐码 |
| `luckin_cancel_order` | order_id(必) | 取消订单 |

**关键约束**：预览/下单必须用 **variant 级 SKU**（get_product_detail/switch_product 产出），不能用 search_menu 的产品级 SKU。MCP 返回常包在 `data` 字段（`data.productName`/`data.productAttrs`）。

---

## 6. 瑞幸点单多轮流程（active_task 阶段推进）

```
"想喝咖啡" → find_store(IP定位) → [store_listed] 列门店
用户选店("第一家") → search_menu → [store_selected]
搜到饮品 → get_product_detail → [menu_searched] 展示规格
选规格("冰的少糖") → switch_product → [detail_shown]
下单 → preview_order → [previewed] → create_order → [ordering]
之后可 query_order / cancel_order
```

阶段由 Planner 顶层 `task_type: "luckin_order"` + `stage` 标记，STAGE_SKILL_MAP 保证每阶段只注入正确 skill。

---

## 7. 配置项（.env，键名来自 config.py）

| 键 | 用途 |
|----|------|
| DEEPSEEK_API_KEY / URL / MODEL | 规划+润色（deepseek-v4-flash） |
| QWEN_API_KEY / URL / MODEL | 视觉分析（qwen3.7-plus，阿里百炼） |
| FEISHU_APP_ID / SECRET | 飞书机器人 |
| AMAP_API_KEY | 高德 IP 定位（瑞幸查门店兜底） |
| LUCKIN_MCP_TOKEN / URL | 瑞幸 MCP（gwmcp.lkcoffee.com） |
| LUCKIN_LAT / LNG | 瑞幸默认坐标（重庆，覆盖 IP 定位） |
| HOST / PORT | 服务监听（默认 0.0.0.0:8000） |
| LOG_LEVEL | 日志级别 |

> **app-cordis 另用**（Cordis 版 v0.4.0+）：`CORDIS_PORT`(8100) / `ORCA_DRY_RUN` / `ORCA_HISTORY_TURNS` / `INFO_RECORDS_DIR` / `IMAGES_DIR` / `INFO_RECEIVER_PORT`(8101) / `INFO_RECEIVER_TOKENS` / `ORCA_CHAT_BINDINGS`（D-AGENT-15）/ `ORCA_VISION_BACKEND`(ollama|dashscope) / `OLLAMA_HOST` / `OLLAMA_VL_MODEL`(qwen3-vl:4b) / **`ORCA_RUNTIME_ENABLED` / `ORCA_RUNTIME_WINDOW` / `ORCA_WORLD_STATE_ENABLED` / `ORCA_WORLD_STATE_REFRESH_MS`（v0.5.0 Persistent Context Runtime + Phase 2）** / **`ORCA_PC_ENABLED` / `ORCA_PC_REFRESH_MS` / `ORCA_CALENDAR_ENABLED` / `ORCA_CALENDAR_REFRESH_MS` / `ORCA_PHONE_ENABLED` / `ORCA_PHONE_REFRESH_MS`（v0.5.0 Phase 2.D mock adapters，全部默认 disabled）**

---

## 8. 技术栈

FastAPI + Uvicorn（reload）；DeepSeek API（规划/润色）；Qwen API（视觉）；pyautogui（桌面控制/截图）；httpx + BeautifulSoup（bing 搜索）；瑞幸官方 MCP Server（JSON-RPC over streamable-http）；python-dotenv；依赖清单 `requirements.txt`（9 个包，无 pydantic 依赖使用）。

---

## 9. 当前状态

### 9.1 已完成
- v2.0.0：ReAct → Plan-then-Execute 重构（DSL + Skill Registry + Runtime），Phase C 旧文件已删（agent/chat/action/vision/tasks/luckin.py）
- v2.1.x：串行锁、ACK 条件化、JSON 提取/编码修复、refine、narration 字段
- v2.2.0：session_state + active_task 多轮状态机；瑞幸流程重构
- v2.3.0：瑞幸 8-skill 全量（含 switch/query/cancel）、下单流程修复（variant SKU、specs_shown 守卫、坐标）

### 9.2 待办（TODO.md）
- [ ] 瑞幸端到端点单测试（token 已配，未验证完整下单）
- [ ] 飞书事件订阅**加密模式**支持（技术债）
- [ ] 远期：摄像头视觉、语音唤醒+ASR、TTS（P2）

### 9.3 Cordis 迁移进行中（Phase 1 完成 + Phase 2 信息获取框架落地）
- 方案文档：`guide/orca-cordis-migration-plan.md`（v1.0 定稿）——学 DeepSeek Harness 用 Cordis 重建，TypeScript 全量重写，代码放 `app-cordis/`
- 已定：纯 Cordis 自写飞书通道（B 方案）；桌面层决策矩阵待实测（默认 A1 Python 子进程桥 + V1 Qwen API）
- **Phase 1 已完成（2026-08-24）**：`app-cordis/` 工程（@deepseek-ai/cordis + TS + tsx；npm 安装，编译产物 `dist/` 用 node 直跑，沙箱下 esbuild/tsx 子进程被拦故 dev 用 tsc build + node start）
  - 自写飞书通道插件（webhook：challenge 验证 / event_id 60s 去重 / 仅 p2p 文本 / fire-and-forget）
  - FeishuClient（tenant_access_token 缓存、reply_text/send_text）+ LlmClient（DeepSeek chat completions）+ 内存 SessionStore + persona
  - Agent 插件：`feishu/message` 事件 → persona+历史 → LLM → reply；`ORCA_DRY_RUN=1` 本地调试不发飞书
  - 端口 `CORDIS_PORT` 默认 8100（避开 Python 版 8000）；配置复用仓库根 `.env`（DEEPSEEK_API_URL 兼容完整端点归一化）
  - 验证：/health、challenge 回显、消息接收、重复事件去重、LLM 回复（dry-run）全部通过
- **Phase 2 信息获取框架已落地（app-cordis v0.2.0 → v0.3.0，2026-08-25）**：按 `guide/orca-info-agent-framework.md` §3/§10/§13 实现 CEO-员工-档案室模型
  - `src/agents/`：types（InfoAgent/InfoRequest/InfoResult/InfoRecord/RecordQuery，§3 原样）+ registry（闭集，D-AGENT-02）+ store（档案室：每 namespace 一 JSONL、append-only + supersedes 更正、软删/整夹清空 + ttl 清理、pending 待汇报队列，D-AGENT-09/11/12）+ executor（Pull 管线：参数校验/串行/超时/输出校验/归一/审计，D-AGENT-03/07）+ router（R0 查档优先 + R1 关键词，D-AGENT-04/10）
  - `src/agents/builtins/food-log.ts`：food-agent（首批 Push 源，pull+push 双模式，推理型内部视觉）；识别结果自动写 food-log 档案（urgency=0 静默、ttlDays=7、payload 只存 photoRef 本地路径——L1 不落明文日志）
  - `src/plugins/info-agents.ts` 装配（provide infoAgents/infoExecutor/infoStore + 注册内置 + 'info/record' 事件写档）+ `src/plugins/info-receiver.ts` 外部上报通道（POST /info/records，Bearer 鉴权 + namespace 白名单，默认端口 8101，未配 token 不启动）——即 D-AGENT-13 iPhone 三通道的通道②
  - `src/plugins/agent.ts` CEO 集成（D-AGENT-10/11）：饮食类问题 R0 查档案注入上下文（命中即复用，零视觉调用）+ urgency=1 待汇报队列（peek 注入下条消息、回复成功后 ack）；**回复用 `sendToChat(chatId)` 独立消息**（非引用回复，像微信聊天）
  - `src/plugins/food-image.ts`（food 管线处理器，由 image-router 接收）+ feishu-channel image 分支 + `downloadImage`：飞书图片闭环（D-AGENT-13 通道①）——image 消息 → 下载（**消息资源接口** `messages/{id}/resources/{key}?type=image`）→ 识别 → 写 food-log 档案 → 独立消息回复
  - `src/plugins/image-router.ts` 会话绑定路由（D-AGENT-15 工位分配）：feishu-channel 放开 chat_type（p2p/群聊）、事件带 chat_id；`ORCA_CHAT_BINDINGS`（JSON `{"<chat_id>":"<agent>"}`）绑定表，图片事件只派发给绑定 agent（不广播），未绑定会话 → 默认 Orca 主管线（当前无图片能力 → 忽略）
  - **视觉后端可切换**：`ORCA_VISION_BACKEND=ollama`（本地 Ollama，`OLLAMA_VL_MODEL=qwen3-vl:4b`，免 apiKey，`max_tokens` 3000 防 reasoning 截断 + 空响应重试）| `dashscope`（默认，QWEN_API_*）
  - **人设**（用户指定）：平级称呼（不喊"老板"）+ 语气"淡淡死感"（平静简短、可靠不煽情、不用 emoji）；识别回复模板 `这份X，约 Y 千卡。记下了。`
  - 配置键：`ORCA_VISION_BACKEND`、`QWEN_API_KEY/URL/MODEL`、`OLLAMA_HOST/OLLAMA_VL_MODEL`、`INFO_RECORDS_DIR`（默认 app-cordis/data/records）、`IMAGES_DIR`（默认 app-cordis/data/images）、`INFO_RECEIVER_PORT`（默认 8101）、`INFO_RECEIVER_TOKENS`、`ORCA_CHAT_BINDINGS`
  - 验证：typecheck/build ✅；冒烟 `node scripts/smoke-info-agent.mjs` **61/61** ✅（含 chat_id 绑定路由、inject 断言、平级模板断言、直连图片上传用例）；真实 iPhone 闭环 ✅ —— 食物群发图 → 消息资源下载 → 本地 qwen3-vl 识别"荷兰豆炒鸡丁 ≈ 320kcal" → 写档 → 独立消息回复 → 问"吃了多少卡" R0 命中
  - 合规修复（2026-08-25）：①控制台 exporter `levels.default: 1 → 2`（fork 语义：level ≤ 阈值才导出，default:1 吞 WARN）；②`downloadImage` 消息资源接口 + 10s 超时 + 错误带 code/msg；③`store.append` 校验 ts/urgency；④food-agent `timeoutMs` 60s + executor 超时 abort 底层请求；⑤image-router 补 `plugin.inject` + 监听器 try/catch（防 unhandledRejection 崩服务）
  - **直连图片上传（app-cordis v0.4.0，2026-08-25）**：`POST /info/images`（info-receiver 新端点，Bearer 鉴权，token 白名单须含 food-agent）——iPhone 快捷指令 Base64 直传跳过飞书 → food 管线识别 → 写 food-log 档案 → **同步返回** `{food,kcal,confidence,recordId,reply}`（快捷指令可直接弹结果）；base64 往返校验防非法输入；`infoReceiver.inject=['infoStore','vision']`（cordis 服务访问必须声明 inject，漏则激活即崩）。验证：smoke 61/61 + 手动 401/200/400 全通
  - **Persistent Context Runtime Phase 0+1（app-cordis v0.5.0，2026-08-26）**：让 Orca 从"被动响应 Agent"演化为"持续接收信息的 Runtime"的第一步。EventBus（内存 pub/sub + 滑动窗口，默认 200 条，超出丢弃最老并 warn）与现有 `ctx.emit/on` **共存**（不替代——EventBus 是高层抽象带过滤与窗口；ctx.emit 是低层一次性通知）；feishu-adapter **旁路**订阅 `feishu/message` + `feishu/image`，翻译为 OrcaEvent publish（feishu-channel.ts 零修改，现有 agent/image-router/dashboard 订阅完全不受影响）；完全 **默认关闭**（`ORCA_RUNTIME_ENABLED=0`，严格 `==='1'` 才挂载 orcaRuntime plugin）；dashboard 新增 `/api/events` JSON 端点（`?limit=N` 上限500，`?source=xxx` 过滤）。**与 InfoAgent/infoStore 共存不冲突**——EventBus 是流（滑动窗口，自动丢弃），infoStore 是档案（append-only JSONL，按 ttl 清理）；两者职责互补。验证：typecheck/build ✅ + smoke 69/69 ✅（现有 9 阶段测试零回归）+ 真实飞书 E2E ✅（`start-cordis.bat` 启用后，飞书连发 10+ 条消息 → `/api/events` 返回 bufferSize=10 count=10）。**Phase 2~5 路线（不实现，仅规划）**：Phase 2 WorldState + Reducer（v0.6.0）/ Phase 3 AttentionEngine 规则引擎（v0.7.0）/ Phase 4 Decision Executor（v0.8.0）/ Phase 5 LLM 增强
  - **WorldState Phase 2（app-cordis v0.5.0，2026-08-27，2 commits: 2cfbde8 + 44885de）**：在 Phase 0+1 EventBus 之上引入"当前世界状态"实时视图。**WorldStateService**（只读 `getState()` 深拷贝快照）+ **WorldStateUpdater**（订阅 EventBus + setInterval time tick + 字段级变化检测 → emit `'orca/state_changed'`）。WorldState 含 4 块：`user: UserState`（status / currentActivity / lastSeenAt / doNotDisturb）、`device: DeviceState`（activeApp / isLocked / powerMode / network）、`time: TimeContext`（timeOfDay / dayOfWeek / isWorkday / isWeekend）、`extensions: Record<string, Record<string, unknown>>`（未来 calendar/pc/phone 扩展预留）。**reducer 注册表** key = `${source}:${type}`。Phase 2.A（v0.5.0 commit `2cfbde8`）只注册一个 reducer：`feishu:message` → `user.lastSeenAt = event.timestamp, status = 'awake'`（**不**做 away 推导）。Phase 2.C（v0.5.0 commit `44885de`）增加 **time tick + away 自动推导**：`AWAY_THRESHOLD_MS = 30 * 60 * 1000` 硬编码，`deriveUserStatus(state, now)` 纯函数，**仅 awake → away 单向推导**；busy / sleeping / away 不主动覆盖（用户主动状态或 phone-sleep 等其他信号才解除）；30:00 整不算、30:00.001 才算 away（严格 `>`）；setInterval `timeRefreshMs` 默认 60000（`ORCA_WORLD_STATE_REFRESH_MS`），tick 内 `computeTimeContext` + `deriveUserStatus`，任一字段变化才更新 state + emit（无变化零开销）；dispose 钩子 `clearInterval + unsubscribe`。dashboard 新增 `/api/world-state` 端点（worldState 未注入返回 503）。**与 infoStore 边界**：WorldState = 实时（自动覆盖）；infoStore = 历史（append-only + ttl）；两者职责互补。**零侵入**：feishu-channel / agent / image-router / food-image / info-receiver 全部零修改；ORCA_RUNTIME_ENABLED=0 时现有所有行为完全不变；ORCA_RUNTIME_ENABLED=1 但 ORCA_WORLD_STATE_ENABLED=0 时 WorldState 也禁用。验证：typecheck/build ✅ + smoke (info-agent) 69/69 ✅（零回归）+ smoke:world-state **94/94 PASS**（R0 21 + R1 8 + R2 14 + R3 5 + R4 26 + R5 20：纯函数 reducer + 真实 ctx.emit 链路集成 + setInterval 集成 + away 单向推导 + 不覆盖 busy/sleeping + 多次 tick 无变化不 emit）。**Phase 2.D/3/4 路线（不实现，仅规划）**：Phase 2.D PC/Phone/Calendar adapter mock + 真实 reducer / Phase 3 AttentionEngine 规则引擎 / Phase 4 Decision Executor / Phase 5 LLM 增强
  - **WorldState Phase 2.D mock adapters（app-cordis v0.5.0，2026-08-27）**：在 Phase 2.A/C 骨架上增加 3 个 mock 输入 adapter + 对应 reducer + 1 个 debug publisher 端点。**PC adapter**（`input-adapters/pc-adapter.ts`）：周期性 publish `pc:app_focus`（mock 从 VSCode/Chrome/Feishu/Terminal/Cursor/WeChat 随机选一个，默认 refreshMs=60000 / `ORCA_PC_REFRESH_MS`）；对应 reducer `pcAppFocusReducer` → `device.activeApp = event.data.app`。**Calendar adapter**（`calendar-adapter.ts`）：周期性 publish `calendar:calendar_event`（mock 4 个模板：项目同步会/设计 review/深度工作时间/午饭，activity = meeting/focus/break，默认 refreshMs=120000 / `ORCA_CALENDAR_REFRESH_MS`）；对应 reducer `calendarEventReducer` → `user.currentActivity = event.data.activity`。**Phone adapter**（`phone-adapter.ts`）：周期性 publish `phone:sleep` 或 `phone:activity`（mock 3 种状态：asleep/in_bed/active，默认 refreshMs=300000 / `ORCA_PHONE_REFRESH_MS`）；对应 reducer `phoneSleepReducer` → `user.status = 'sleeping'`（首次引入"主动设置非 awake" reducer）。**Debug publisher**（`dashboard.ts` 新增 `POST /debug/publish-event`）：Body `{source, type, data?, priority?}` → 调用 `ctx.eventBus.publish`，便于手动验证 reducer 链路；仅本地开发用（生产应在反向代理层禁用）。**三个 adapter 全部默认 disabled**（`ORCA_PC_ENABLED=1` 等显式启用）；dispose 钩子统一 `clearInterval` 不泄漏 timer；EventBus 未注入时 no-op + warn log。**新配置项**：`runtime.pc/calendar/phone: { enabled, refreshMs }`，env 变量 `ORCA_PC_ENABLED` / `ORCA_PC_REFRESH_MS` 等。零侵入：feishu-channel / agent / image-router / food-image / info-receiver 全部零修改；ORCA_RUNTIME_ENABLED=0 时现有所有行为不变。验证：typecheck/build ✅ + smoke:world-state **94/94 PASS**（用户本地手动跑确认，4 个失败用例已修正为 `sensor:reading` 作为"未注册 reducer"测试 key）
  - **v0.4.0 后期热修补（2026-08-26，4 commits 未单独升 PATCH）**：v0.4.0 → v0.5.0 之间 4 个增量 commit 未单独升版本号（违反 D-VER-02），详见 `dev-log.md` v0.4.0 hotfix 批段。涉及：`vision.ts` 切到 Ollama 原生 `/api/chat` + `num_ctx=16384` 修复大图 400（965c697）+ food-agent `handleDeleteIntent` 确定性删除命令按食物名/噪音/全部三条规则 + smoke 69/69（b53d508）+ info-receiver imageUrl 远程拉取兜底超时 90s + kcal 文案带"千卡"单位 + AbortSignal 透传（7870f4f）+ `scripts/list-food.mjs` 辅助 CLI 列出 food-log 档案（c33ad18）
- 下一步：Phase 3 AttentionEngine 规则引擎（事件 + WorldState → ignore/remember/notify/act 决策）/ Phase 4 Decision Executor（执行 Attention 决策：act → agent / notify → feishu.sendToChat / remember → infoStore.append）；迁移 search_web / capture_screenshot / analyze_image 为 InfoAgent（Pull），refine 留主 agent；会话持久化（jsonl）；urgency=2 主动推送（按落地安排后置）；独立飞书 bot 的 app_id 路由（远期，D-AGENT-13）；群聊免 @ 替代方案（图片走 p2p）
  - **v0.6.0 release（app-cordis，2026-08-27）**：Phase 2 WorldState Runtime 完整闭环（Phase 2.A + 2.C + 2.D，3 commits: 2cfbde8 + dcff0ed + 47b5fd9）。**事件流（EventBus）+ 世界状态（WorldState）+ Mock 输入适配器（pc/calendar/phone）+ Debug Publisher** 已就位，Orca 进入"持续接收信息的 Runtime"阶段。`git tag v0.6.0` 标记。下一步进入 Phase 3 Attention Engine（**先规则，不引入 LLM**）。
  - **Phase 3 Attention Engine（app-cordis，2026-08-27，待 tag）**：纯规则注意力系统，**不引入 LLM**（用户决策：LLM 留给 Phase 5 做"理解/规划"，不替代基础层）。架构：`Event + WorldState (+ prevState) → Attention Rules → AttentionItem[] → emit 'orca/attention'`（Phase 4 Decision 订阅）。关键设计：WorldStateService 接口扩展 `getPrevState()` + `applyUpdate()`（让 Attention 能感知"事件发生前的 state"，避免"规则写了但触发不了"）；service 内部管理 state + prev capture（不再由 WorldStateUpdater 闭包持有）。5 条内置规则：sleeping-quiet（用户睡眠忽略）/ feishu-deadline（飞书消息含 deadline 关键词 → 高优先级 remember）/ calendar-busy-soon（用户忙时收到 ≤5 分钟会议 → wait_until_available）/ away-arrival（away 时事件入档）/ focus-interrupt（focus/meeting 时飞书消息仅入档）。emit `'orca/attention'` 单条 + 可选 `'orca/attention_batch'` 批量（Phase 4 扩展）。dashboard 新增 `/api/attention` GET（ruleCount）+ POST `/api/attention/evaluate`（手动触发评估，便于测试规则）。**零侵入**：Phase 0+1 / Phase 2 全部零修改（仅 WorldStateService 接口扩展，向后兼容）；ORCA_ATTENTION_ENABLED=0 关闭。**前置依赖**：Attention Engine 必须在 WorldStateUpdater 之后挂载（依赖 worldState service）。

  **🔒 关键架构约束（Phase 3.A 确定，未来 Attention/Decision 必读）**：
  - Attention Rule predicate 中判断"事件发生前的环境状态"时，**必须使用 `prevState`**（事件处理前的 WorldState snapshot）。
  - `state` 表示**事件处理后**的世界（reducer 已应用过），不可用于"事件前的判断"。
  - 错误示范：away-arrival 原写 `predicate: ({ state }) => state.user.status === 'away'`——但 `feishuMessageReducer` 会把 status 改回 `awake`，导致规则永远不触发。正确写法：`predicate: ({ prevState }) => prevState?.user.status === 'away'`。
  - **典型场景**（Phase 4 Decision 会高频遇到）：
    - 用户原本 idle，收到任务后变 active → 需要 prev=idle 才能解释"刚被激活"
    - 用户原本 offline，设备上线事件导致 online → 需要 prev=offline 才能触发"上线通知"
    - 用户原本 focus，收到打断事件 → 需要 prev=focus 才能解释"刚被打断"
  - **实现层面**：`prevState` 在 state-only 触发（如 `orca/state_changed`）时为 `undefined`；event 触发时由 `ws.getPrevState()` 提供（WorldStateService.applyUpdate 内部 capture）。

  - **R8 smoke-attention（48 用例）**：覆盖 4 条规则 + 1 个 SKIP（urgent-keyword TODO Phase 3.B）+ 9 个 prevState 集成回归。脚本 `scripts/smoke-attention.mjs`，跑法 `npm run smoke:attention`。验证：smoke:world-state 94/94 ✅（零回归）+ smoke:attention 48/48 ✅。

  - **Phase 3.B 路线（规划中）**：
    1. **Attention 去重（dedup）**：相同 (ruleId, eventId) 在窗口期内合并，避免噪声
    2. **Attention 节流（throttle/cooldown）**：同一 source 在 N ms 内只 emit 一次 notify；hourly cap 防止过度提醒
    3. **Rule 配置化（YAML/JSON）**：外部加载规则，覆盖/扩展内置
    4. **设计目标**：让 Attention Stream 先稳定再可配置，避免去重逻辑和配置逻辑交叉复杂度

  - **下一步 Phase 4 Decision Executor（订阅 'orca/attention'，按 priority 排序 + throttle + 执行 notify/act/remember）**：用户已确认 Phase 3.B 优先于 Phase 4。

---

## 10. 文档地图（新会话按需取用）

| 文档 | 内容 | 何时读 |
|------|------|--------|
| **本文档 AGENT.md** | 当前状态全貌 | 每次会话必读 |
| `guide/memory-pack.md` | 设计哲学（LLM=规划器等） | 理解设计动机时 |
| `guide/decisions.md` | 40+ 条 D-* 架构决议 | 改架构/加机制前必读 |
| `guide/orca-cordis-migration-plan.md` | Cordis 迁移方案 | 做迁移工作时 |
| `guide/orca-info-agent-framework.md` | 小型信息 Agent 框架设计（v0.2，Pull+Push/记录库/D-AGENT-01~12；Phase 2 部分落地见 §9.3） | 做 Phase 2 工具迁移/接信息源时 |
| `guide/orca-iphone-channel.md` | iPhone 数据通道调研（三通道/D-AGENT-13） | 接手机数据（照片/健康/文件）时 |
| `dev-log.md` | 版本历史 v1.0→v2.3.0 | 查"为什么这么改"时 |
| `README.md` | 对外简介（**部分过期**：版本号、目录结构、USE_NEW_ARCH） | 对外介绍时，改前先对照代码 |
| `project-orca-overview.md` | 早期愿景（微信 ClawBot/语音/硬件，**已过时**） | 参考远期方向时 |

深读优先级（改代码前）：`core/orchestrator.py` → `core/planner.py` → `dsl/validator.py` → `runtime/engine.py` → `skill/builtins.py`（改 skill 时再读对应 handler）。

---

## 11. 常见陷阱（历史踩坑）

1. **SKU 两级**：search_menu 给产品级 SKU，下单必须 get_product_detail/switch_product 的 variant 级
2. **reply 不能硬编码结果**：必须 `{{step.<id>.output}}` 引用（规则 3，Validator 不查这个但 Planner 规则约束）
3. **MCP 返回包 data**：`result.get("data") or result` 是通用解包姿势
4. **int 参数引用解析**：Engine 会从文本抠数字（`dept_id: 12345` 模式），别在 DSL 里传字符串数字
5. **会话全在内存**：HistoryManager 重启即失；迁移到 Cordis 的动机之一
6. **中文乱码**：Windows 下用 `-X utf8` / `chcp 65001` / `PYTHONUTF8=1`（start.bat 已处理）
7. **LLM 输出非 JSON**：Validator `_extract_json` 兜底 + 层 1 重试一次；Planner prompt 反复强调"只输出 JSON"

---

*维护者：ka。本文档与代码同步于 **v2.3.0（Python） + app-cordis v0.5.0（含 WorldState Phase 2.A/2.C/2.D，2026-08-27）**。*
