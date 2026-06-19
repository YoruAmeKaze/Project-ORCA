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
