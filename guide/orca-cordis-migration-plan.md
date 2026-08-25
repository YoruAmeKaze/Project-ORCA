# Project Orca → Cordis 迁移方案

> 基于 DeepSeek Harness (DSH) 架构研读的技术选型与迁移规划文档
> 状态：v1.0 定稿（7 模块源码研读已完成）
> 日期：2026-06

---

## 0. TL;DR

- **DSH 本身就是 Cordis 应用**：`@deepseek-ai/cordis` 是 Cordis 元框架的官方 fork（作者 Shigma，Koishi 作者），DSH 的 150+ 个 `@deepseek-ai/dsh-*` 包全部是 Cordis 插件
- **迁移 = 语言全量重写**：Cordis 生态是 TypeScript/Node.js，Python 版 Orca 无法直接"换底座"
- **核心收益**：把 Orca 手写的 Planner/Validator/Runtime/SkillRegistry 四件套，换成 Cordis 生态中经过验证的 agent 运行时 + 工具执行管线 + 沙箱/审批机制
- **关键捷径**：Koishi 生态有现成飞书适配器（`@koishijs/plugin-adapter-feishu`），可复用
- **最大取舍**：桌面控制层（pyautogui）是 Python 独有能力，迁移方案待定（见 §6 决策矩阵）
- **代码位置**：同仓库新目录 `app-cordis/`，与 Python 版平行开发，验证后切流（参照 DSH 自己的迁移策略）

---

## 1. 背景与目标

### 1.1 Orca 现状（Python 版）

- 飞书聊天驱动的本地桌面 AI 助手，v2.3.0
- 架构：Plan-then-Execute（Planner → DSL → Validator → Runtime → Skill）
- 19 个 skill：通用 11 个（回复/截图/视觉/桌面控制 6 个/搜索/润色）+ 瑞幸点单 8 个
- 核心痛点（迁移动机）：
  - Planner/Validator/Runtime/SkillRegistry 全部手写，LLM 输出 JSON DSL 需要大量 prompt 规则约束（10 条规则 + 示例），脆弱
  - Validator 层 0 安全审查是 stub，桌面控制等高危操作缺少真正的安全边界
  - 无持久化：会话历史在内存，重启即失
  - 无审批流：所有操作直接执行
  - 无 agent 级抽象：无法做子代理、工作流、后台任务

### 1.2 目标

学 DeepSeek Harness 的架构模式，用 Cordis 作为底层框架重建 Orca：

| 维度 | 现状 | 目标 |
|------|------|------|
| 语言 | Python | TypeScript |
| 框架 | FastAPI + 自研流水线 | Cordis（插件/服务/事件） |
| Skill | 自研闭集注册表 | dsh-tools / dsh-skill 模式 |
| Agent | 无（一次性 plan） | agent-loop + session |
| 安全 | Validator stub | 沙箱 + 审批 + 作用域 |
| 持久化 | 内存 | session 持久化（jsonl/sqlite） |
| 多轮任务 | active_task 状态机 | goal 机制 |

---

## 2. DSH 架构拆解（研读汇总）

> 本节内容由 7 个并行研读子代理产出，覆盖 cordis 核心 / profile / agent / tools / 编排 / 沙箱 / web。

### 2.1 Cordis 元框架核心

> 研读对象：`@deepseek-ai/cordis@4.0.1`（含 src 源码）+ loader / include / hmr / schemastery

- **Context = Proxy 化依赖容器**：`new Context()` 返回 Proxy，属性读取走服务解析器；内置 `reflect`（服务解析）、`registry`（插件注册表）、`events`（事件总线）、`logger` 四个核心服务，通过 `ctx.mixin()` 挂到 ctx 上（`ctx.plugin`/`ctx.on`/`ctx.provide`/`ctx.effect`…）
- **子上下文三件套**：`ctx.extend(meta)` 原型继承；`ctx.isolate(name)` 服务独立作用域；`ctx.intercept(name, config)` 下游配置覆盖
- **服务注册**：`ctx.provide(name, value, check?)` 或继承 `Service` 基类（`super(ctx, 'foo')` 自动注册）；可选 `[Service.invoke]`（可调用服务）、`[Service.check]`（可用性谓词，如"连接就绪"）、`[Service.init]`（async-generator 启动体，yield 清理函数）
- **依赖解析是动态的**：插件声明 inject 后，服务出现→自动激活，提供者卸载→依赖者级联卸载（epoch 变化触发 reload）
- **插件模型**：函数 `(ctx, config) => effect` / 类 / 对象 `{apply}` 三种入口；元数据挂入口上：`inject`、`Config`（schema）、`name`、`provide`；`ctx.plugin()` 返回 **Fiber**（状态机 PENDING→LOADING→ACTIVE→DISPOSED）；返回值即 effect（disposer），卸载时逆序执行；`fiber.update(config)` 支持热补丁
- **事件系统 5 种分发**：`emit`（同步广播）/ `parallel`（并发）/ `serial`（串行）/ `bail`（首个非空返回）/ `waterfall`（洋葱模型中间件，不调 next 即否决整条链）；命名 `foo/bar` 斜杠分层，`internal/xxx` 保留给框架；类型通过 `declare module` 增强全静态化
- **配置与 schema**：插件静态 `Config` 用 schemastery `z.object()` 声明，激活前同步校验；支持 `.required()/.default()/.description()/.role()` 链式，可 JSON 序列化
- **加载器**：Loader 是 EntryTree 服务；`entry.update()` diff——仅 config 变→`fiber.update()` 热补丁，name/inject 变→dispose 旧 + import 新 + 失败回滚；**patch 层**把 YAML/JSON 配置按 id 覆盖叠加（bundle 层→用户层→--patch overlay），支持 `!!js` 惰性表达式；**HMR** 按依赖图分类变更文件（框架文件→全量重启 / accepted / declined），清缓存重 import 后按旧 fiber 的 parent/config 重启
- **最小骨架**（见研读报告 §6）：`new Context()` → `root.plugin(Service)` → `root.plugin(插件, config)` → 事件驱动 → `await root.fiber.dispose()` 级联清理
- **依赖基础**：cosmokit（cordis 唯一硬依赖之一）提供 `DisposableList`、`defineProperty`、`getTraceable`（跨上下文追踪包装）、`deepEqual`、`Dict` 等基础设施
- **对 Orca 的启示**：Feishu 客户端、LLM 调用应建模为 Service（`[Service.check]` 表达连接就绪）；聊天驱动逻辑用事件（`feishu/message` 命名）+ 插件按需订阅；技能/工具天然适合做成 loader 管理的插件树，白拿配置文件 + 热重载能力

### 2.2 Profile 与配置分层

> 研读对象：dsh CLI / dsh-base / dsh-app-boot / dsh-cordis-client-runner / dsh-launch-environment / dsh-cmdline / dsh-settings(-file) / dsh-home-paths

- **Profile** = 一个可启动的配置组合：目录含 `package.json`（含 `dsh.profile.bundles` 有序列表）、`cordis.patch.yml`（用户 patch 层）、`cordis.yml`（空根锚点）
- **配置分层（空根 + 有序叠加）**：按 bundles 顺序 → profile `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层；**整行 config 覆盖、不做深合并**；`!!js` 表达式在挂载时惰性求值；用户层最后赢；可用 `--dump-config` 检查组合结果
- **Bundle = 发布单元**：bundle 是声明了 `dsh.bundle.patch` 的 npm 包，其 `cordis.patch.yml` 是一层插件行 patch；`dsh-base` 是"profile 打包层"——一次 insert **~90 行基础插件**（agent/LLM/工具/沙箱/存储分类齐全）；`dsh-web-app`、`dsh-headless` 只是 bundles 组合不同（模式 = 组合，不是不同程序）
- **启动链路**：dsh CLI（只解析自身 flag，其余交给应用）→ composeProfile → boot（`new Context` + Loader + mountRootInclude + **assertEntriesActivated** 断言）→ HMR 监视用户层；`dsh --profile headless "job"` 跑一次性会话，`dsh web` 是 `--profile web` 别名
- **设置系统**：namespace + schemastery schema 注册，三层解析（默认→base→用户文档），文件 provider 带写锁 + 原子写 + 热重载
- **对 Orca 的启示**：照此拆出"核心 bundle（agent+工具+会话）+ 启动包 + 薄 CLI + 横切包（环境/路径/设置）"；Orca 可声明自己的 profile 名（如 `orca-feishu`），配置全走 YAML patch 层

### 2.3 Agent 运行时（loop / session / LLM）

> 研读对象：dsh-agent / agent-loop / agent-presets / session / session-persistence-jsonl / session-projection / llm / llm-deepseek / system-prompt / compaction-basic / token-meter

- **Agent 模型**：Agent = session + 作用域 ctx + 可替换 driver；`ctx.agents` 注册表与 `AgentFactory`（create/resume）解耦接口与实现；事件词汇分两类——`agent/*` 生命周期/决策钩子（waterfall，可 veto）与持久化 `turn/*`、`step/*`、`assistant/chunk` 会话事件；initiator scope 是 AsyncLocalStorage 进程内因果归因
- **Agent Loop**：一次回复 = 一个 turn 内多个 step；preStep claim inbox（取走待处理消息）→ 组装 prompt → `llm.stream` 流式逐 chunk 落库 → tool-call 配对回写（exclusive 屏障 + 并行池上限 10，对照 Orca 串行锁：DSH 是"独占屏障 + 有界并发"而非简单互斥）→ `turn/end` 记 reason；流式是全量 chunk 级落库
- **Session = event-sourced append-only 日志**：日志是唯一真源，LLM 历史由 surface 投影派生（surfaceOp append/replace）；jsonl 持久化 append-only + fsync + 崩溃恢复，支持 resume / fork（取已完成回合前缀）
- **LLM 抽象**：LlmRuntime = adapter 注册表 + 唯一流式 API（`stream(GenerateOptions): AsyncIterable<StreamChunk>`，失败归一为终态 finish）；`llm/stream` waterfall 可拦截；DeepSeek 以插件实现 LlmAdapter 注册 provider 路由
- **System Prompt 组装**：注册表式贡献（section / tool / variable / context 四种 + `{{var}}` 严格插值 + assemble waterfall 改写），作用域 agent→preset→global——即 Orca 可借鉴的"插槽/注入"扩展点，persona 可按作用域分层注入
- **Compaction**：tokenMeter 启发式测压 → 摘要调用重放前缀复用 KV cache → 检查点 replace
- **对 Orca 的启示**：Planner→DSL→Validator→Runtime 的显式阶段被降为"事件 + 作用域钩子"；最值得借鉴的是"一切可观察事实都进事件日志、扩展点全走作用域 waterfall"的组织哲学

### 2.4 工具与 Skill 体系

> 研读对象：dsh-tools（核心）/ dsh-skill / dsh-skill-filesystem / dsh-tool-skill / dsh-agent-tool-presentation / dsh-tool-fs / dsh-tool-bash / dsh-tool-web / dsh-mcp-client

- **ToolDefinition** = schema（name/description/parameters）+ 必填 `output`（schema + render + presentationMeta）+ `execute(args, exec)`；可选 `finalizeContent`（同步最后一道内容变换）、`timeoutMs`、`isConcurrencySafe(args)`、`presentCall/presentResult`（UI 卡片意图）。`defineTool()` 用参数 DSL 编译成 JSON Schema，执行前自动校验参数，输出按 `output.schema` 强制校验 canonical 值
- **执行管线**：materialize（快照+冻结）→ `tools/pre-execute`（可重排 waterfall，`allow/deny/ask` 三态门；ask 走审批服务，allowed-once 放行）→ guard（单调同步守卫，返回 string 即拒绝）→ `tools/execute`（around 包装：timeout/retry/metrics）→ body execute → `tools/post-execute`（可替换 content/value、附加上下文）→ `finalizeContent` → materialize（校验+render）→ `tools/result`（只读通知；agent loop 再追加持久 `tool/result` 会话事件）；任何阶段抛错归一为 `isError`
- **并发与取消**：`isConcurrencySafe(args) === true` 才并行，否则 fail-closed 独占；每次调用强制携带调用方 `AbortSignal`，body 必须观察/转发，已启动的 promise 从不弃置、drain 到静止
- **作用域**：普通插件 ctx 注册→全局层；`agent.ctx` 注册→该 agent 层（shadow 同名全局）；`restrict({allow|deny})` 只过滤继承面（live 可见性组合，非安全边界）
- **Skill 体系**：`ctx.skills` 是**纯 provider 注册表**（provider 工厂提供 list/get，带 modelInvocable/userInvocable 双面调用策略、rank 覆盖、渐进加载）；`dsh-skill-filesystem` 扫描本地 markdown（frontmatter: name/description/whenToUse/invocation）作为 provider；`dsh-tool-skill` 是模型侧消费者——渲染 `<available_skills>` 目录 + 注册 `skill` 工具。**skill 与 tool 的关系**：skill 是"可加载的指令内容"，tool 是"可执行的 schema+handler"；skill 必须经一个普通工具进入模型视野
- **工具插件典型结构**：apply 内 ① `ctx.systemPrompt.section()` 注册引导语 ② `ctx.tools.register(defineTool(...))` ③ execute 经 seam（`ctx.fs`/`ctx.shell`/`ctx.web`）而非直接 I/O，转发 exec.signal ④ 结构化 canonical 返回，throw 走 isError ⑤ 只读操作声明 `isConcurrencySafe: () => true`
- **MCP 客户端**：每 server 一个插件实例（stdio/streamable-http）；`tools/list` 拉取 → 每工具生成 ToolDefinition（公开名 `mcp__<server>__<raw>`）→ `ctx.tools.register()`；execute 用 raw name 发 `tools/call`；`tools/list_changed` 触发两阶段重同步
- **对 Orca 的对照**：handler→defineTool（补 output schema 与 render）；Skill Registry→dsh-skill provider；关键词匹配路由→目录描述让模型自选（不再需要 DSL 文本协议与 10 条 prompt 规则）；闭集注册表→开放注册表 + restrict/审批/guard

### 2.5 任务编排（goal / subagent / workflow / jobs）

> 研读对象：dsh-goal / goal-round-driver / subagent(+3 驱动) / workflow / workflow-worker-thread / jobs / jobs-local / schedule / tool-todo

- **Goal**：事件源状态（`goal/change` 事件追加进 session 日志，严格重放恢复）；一个 session 一个 current goal；phase ∈ {active/paused/blocked/complete}，所有变更走 `{id, revision}` CAS；activation（armed/disarmed）永不持久化，resume/fork 后强制 disarm 需显式 rearm；**round driver** 在 agent idle + armed + 有预算时用 `Agent.followup()` 追加 `<goal_round>` 消息实现同会话多轮续跑（人工消息不占轮次、优先级更高）；**省 token**：goal 本身不注入模型上下文，`get_goal` 按需读取——对比 Orca 把 active_task 格式化注入 Planner prompt 的做法；tool-goal 配置 `blockedAfterConsecutiveRounds: 3` 限制模型自报阻塞（连续 ≥3 轮才机械放行）；权威校验（create/edit 要求当前 turn 有直接人工消息，subagent 无权限）
- **Subagent**：spawn（无历史）/ fork（父已完成 turn 前缀一次性快照）/ 共享 in-process 驱动；工具/权限不继承，子权限在委托边界冻结（approval='never'）；父子通过 inbox FIFO turn 通信（父 send_message、子 report、settle 时 manager 无条件发 notice）；支持 outputSchema/depthLimit/toolFilter/persona 四能力
- **Workflow**：模型写的 JS 脚本（agent/parallel/pipeline/phase/log hooks），每 run 一个 worker thread + vm 执行（防阻塞事件循环，非安全沙箱）；与 goal/subagent 三层正交
- **Jobs**：注册制后台任务，`<kind>-N` id + owner 隔离 + running/stopping/terminal 状态机 + 单游标输出读 + kill/wait/完成 notice；jobs-local 纯内存实现，每 owner 并发上限（默认 10，满则 start 直接报错）
- **Schedule**：`schedule_create(after_seconds|at|every_seconds)`，`schedule/change` 事件持久化，到期以固定 framing 追加为下一轮 user 消息
- **Todo**：与 goal 无直接联动——纯 per-session 整体替换清单（`todo/write` last-write-wins），靠模型层协作
- **对 Orca 的对照**：active_task 可变状态字典 → goal（事件源持久化、CAS 围栏、显式生命周期、轮次预算）；瑞幸点单建议"每订单一 goal"（objective 承载订单、roundsStarted≈推进轮数），stage 语义移入自有 `order/change` 事件 + fold；缺支付/缺地址映射为 blocked phase；多订单用 workflow

### 2.6 沙箱与安全

> 研读对象：dsh-sandbox / sandbox-local / sandbox-policy / fs-sandbox / fs-observation-policy / pwsh-bash-sandbox / user-approval / permission-presets / scope / spill / tool-call-timeout-policy

- **核心心智模型：模型不可信，机制可信**。"该不该做"的决定性判断全部下沉到机制（沙箱 deny、审批 grant、事件门拦截），"怎么做"的指导性判断留给提示
- **沙箱分层**：`ctx.sandbox.confine(argv, policy) → ConfinedArgv` 是唯一接口；词汇表只有**文件效应**：`SandboxMode = read-only | workspace-write | danger-full-access`；无后端可用抛 `SANDBOX_UNAVAILABLE`，**fail-closed 绝不裸跑**；策略随调用走（mode + workspaceRoot + sessionId），不固定于 provider；sandbox-policy 解析"会话 override ＞部署默认"，workspaceRoot 用会话创建时不可变的 cwd
- **平台实现**：Linux bwrap→Landlock，macOS Seatbelt，**Windows ACL 受限令牌**（`CreateRestrictedToken` 的 WRITE_RESTRICTED，限制 SID = logon + Everyone + workspace；只限写，报告 enforcement:'partial'）；read-only 下 pwsh 自动进 ConstrainedLanguage（Add-Type/COM/反射全拒）；受限进程内管道捕获孙进程输出遇命名管道→EPERM（spawn+inherit/ignore 可行）
- **FS 观察策略（先读后写）**：`fs/write-intent`/`fs/edit-intent`/`fs/observed` 事件门——edit 必须先 read（否则 `FS_NOT_OBSERVED`），write 用观察到的版本做 CAS；防模型盲写、盲覆盖
- **审批流**：`ctx.approval.request(...) → allowed-once | rejected | cancelled | unavailable`，fail-closed（缺 answerer→unavailable）；策略 ask | never（'never' 确定性拒绝，headless 用）；审计成对 log-only（asked+decided）；挂载点在 `tools/pre-execute`；沙箱升级共用 `approveEscalation`（**执行前就失败**）
- **权限预设**：permission-presets 把 mode+policy 打包成用户可选预设（默认 workspace-write=workspace-write+ask；danger-full-access=full+never）；会话创建时 pin 住不可变
- **作用域**：每 live agent 一个 scope，注册既定可见又定生命周期；`scopeTarget(base,key)` 让 `tools/*` 事件只路由给同 key 或祖先 listener；但 scope 是路由机制**不是安全边界**（安全边界在 tools/execute）
- **四问定位任何操作**：作用域管"谁能看到"、沙箱管"能碰到什么"、审批管"要不要问人"、观察策略管"改前必须看过"
- **对 Orca 的对照**：Validator 层 0 安全审查（stub）应升级为机制层而非提示词——格式/引用/参数校验对应 schema 校验+事件门（机制化）；**桌面控制（键鼠/屏幕/进程）超出 SandboxMode 的文件效应词汇表，需自建 capability seam**（见 §6 方案 A 的配套防护）：默认不挂载 fail-closed、每次高危调用走 approval 一次性 grant、pre-execute 上做参数级白名单 guard、会话预设一键选"桌面控制允许度"、工具声明 timeoutMs + spill 防巨输出

### 2.7 Web host/runner/client（可选项）

> 研读纠偏：`dsh-web` 实为"联网能力"（web search/fetch 服务定义层），真正的 Web 应用是 `dsh-web-app` + `dsh-web-frontend`。

- **Host（Node 进程）= 单一事实源**：agent loop、工具、会话持久化、jobs、goal、模型路由全部在 host；浏览器只消费 host 的状态投影
- **Client（浏览器 React）= 投影消费端**：client 自身也是一个 cordis 应用（`dsh-client-web` shell + `dsh-client-runtime` 服务层 + React 胶水），UI 插件即 cordis 插件，通过 `cordis.patch.yml` 的浏览器插件名单装配
- **连接协议**：HTTP 一元 RPC（`POST /api/<method>`，应答回显 rpcId）+ 两条仅下行 WebSocket（`/api/events.mux` 会话级事件流、`/api/events.host` host 级流）；事件订阅=流式基线（打开即发全量快照帧 + 重放 pending 的 approval/question，随后推增量事件）；重连靠"全量快照帧 + higher-seq-wins"收敛
- **能力暴露**：agent 会话→`session/event` 流；工具调用→`tool/call`/`tool/result` 事件；goal/todos→`session/projection` 通用投影；jobs→`session/jobs` 快照帧
- **前端插件化**：`dsh-client-ui-slots` 的 slot 注册表——一次调用完成"声明插槽 + 注册组件 + 声明 store"，插槽声明即渲染授权；30+ 个 `dsh-client-ui-*` 包各自是 cordis 插件
- **安全**：loopback trust fence（Host 头 + Origin 校验防 DNS rebinding），本地服务零认证
- **对 Orca 的启示**：飞书通道与未来 Web 界面应共享同一 host 核心，各自只是"channel"；可砍掉动态双半插件（模型自产 UI）、配置管理全家桶、Typert 网关

---

## 3. Orca → Cordis 概念映射

| Orca（Python，手写） | Cordis/DSH 对应物 | 迁移方式 | 备注 |
|---------------------|------------------|---------|------|
| `core/planner.py`（关键词匹配→LLM 出 DSL） | agent + system-prompt 组装 + LLM provider | 直接使用 | LLM 直接 function calling 或工具 schema，不再需要 JSON DSL 文本协议 |
| `dsl/schema.py`（Plan/SkillCall/`{{step.x.output}}` 引用） | 工具 schema（schemastery）+ session 事件流 | 删除 DSL，用原生工具调用 | 引用解析由 agent loop 的 session 处理 |
| `dsl/validator.py` 四层校验 | 工具 schema 校验 + 沙箱边界 + pre-execute guard + 审批 | 拆分到不同层 | 层 0 安全审查 → 审批/guard；层 1/2/3 → schema 校验 |
| `runtime/engine.py`（顺序执行器） | agent-loop（turn 循环） | 使用/扩展 | fail-fast 语义可保留在工具错误处理 |
| `skill/registry.py` + `builtins.py` | dsh-tools 注册表（register/restrict/schemas） | 逐个重写 | 15 个 handler → 15 个工具插件或一个工具包 |
| `skill/handlers/action.py`（pyautogui） | 桌面工具（方案待定，见 §6） | 子进程桥 / nut.js | **最大迁移风险** |
| `skill/handlers/analyze.py`（Qwen 视觉） | 视觉工具（Qwen API 或本地 Ollama） | 重写 | 用户点名要评估"本地视觉模型"方案 |
| `skill/handlers/search.py`（bing 爬取） | 搜索工具（可换 DSH 的 dsh-web-search 模式） | 重写 | |
| `core/history.py`（内存会话） | dsh-session（event-sourced）+ persistence | 使用 | 获得持久化能力 |
| `core/orchestrator.py` 串行锁 | session 级串行机制 | 确认/替换 | |
| `active_task` 状态机（task_type/stage/context） | dsh-goal（跨会话目标） | 迁移 | 瑞幸点单流程 goal 化 |
| `feishu/client.py` + `router/feishu.py` | Koishi 飞书适配器 或 自写 Cordis 插件 | 待选型（见 §5） | 初步倾向自写 |
| `tasks/luckin_mcp.py`（JSON-RPC MCP 客户端） | dsh-mcp-client 模式 | 复用思路 | 瑞幸本身就是 MCP server |
| `core/persona.py` | system-prompt 组装（persona 片段） | 迁移 | |
| `config.py`（.env） | settings 系统 + schema 声明 | 迁移 | |

---

## 4. 目标架构（app-cordis/）

### 4.1 目录结构（草案）

```
app-cordis/
├── package.json / tsconfig.json / pnpm-workspace.yaml
├── profiles/
│   └── orca/
│       ├── dsh.profile          # profile manifest（bundles 列表）
│       ├── cordis.patch.yml     # 用户配置层
│       └── package.json
├── src/                         # 或 packages/ monorepo
│   ├── index.ts                 # 入口：装配 profile → 启动
│   ├── plugins/
│   │   ├── feishu/              # 飞书通道（adapter 或自写）
│   │   ├── desktop/             # 桌面控制工具（方案待定）
│   │   ├── vision/              # 视觉分析工具
│   │   ├── search/              # 联网搜索工具
│   │   ├── luckin/              # 瑞幸点单工具 + goal 流程
│   │   └── persona/             # 人设 prompt 注入
│   └── services/                # 自定义服务（如 Orca 特有状态）
└── tests/
```

### 4.2 最小闭环（Phase 1 验收）

```
飞书消息 → feishu 插件 → session 写入
       → agent-loop：system prompt（persona + 工具 schema）→ LLM
       → 工具调用（reply 等 2-3 个）
       → 回复写回 session → 飞书发出
```

---

## 5. 通道选型：Koishi 框架 vs 纯 Cordis

> 背景事实（web 调研确认）：
> - Cordis 是 Koishi 的插件内核，作者 Shigma；DSH 使用官方 fork `@deepseek-ai/cordis`
> - Koishi 生态有现成飞书适配器 `@koishijs/plugin-adapter-feishu`（[npm](https://www.npmjs.com/package/%40koishijs/plugin-adapter-feishu) / [docs](https://github.com/koishijs/docs/blob/95608a92cca2b4a7038f6e83156af7708d6dc620/plugins/adapter/feishu.md)），版本、peer 依赖、独立可用性待本地验证（npm registry 在沙箱下不可达）

| 选项 | 形态 | 优点 | 缺点 |
|------|------|------|------|
| A：Koishi 框架 | 直接以 Koishi 为底座（含 adapter、控制台、插件市场） | 飞书适配器开箱即用；有控制台 UI；生态成熟 | 偏离"学 DSH"目标；Koishi 的 bot 模型与 agent 运行时模型有差异；引入大量用不到的框架面 |
| B：纯 Cordis | 自写飞书通道插件（webhook + 消息收发） | 完全贴近 DSH 形态；依赖面最小；代码量可控（Orca 只需 p2p 文本消息） | 飞书事件订阅/加解密需自己实现（加密模式是已知技术债） |
| C：混合 | 纯 Cordis + 复用 koishi 的 feishu adapter | 省 adapter 工作量，保持 agent 层自主 | 依赖兼容性风险（koishi 插件通常假设 koishi 上下文） |

**初步倾向**：B（纯 Cordis 自写飞书通道）。理由：Orca 的飞书需求极小（p2p 文本收发 + challenge 验证），现有 Python 版已有可对照的成熟实现（`feishu/client.py` + `router/feishu.py`），重写成本低；且 B 最贴合"学 DSH"的初衷。若后续要加密模式或群聊等高级能力，再评估 C。

---

## 6. 桌面层决策矩阵（多方案待定）

> 用户要求列出多种方案，不急于定论。这是迁移中影响最大的单项决策。
> 注意：这是**两个独立的决策轴**——轴 1 是"桌面控制怎么执行"（键鼠/截图），轴 2 是"视觉分析怎么跑"（看图的模型）。可以自由组合。

### 轴 1：桌面控制执行层

#### 方案 A1：Python 子进程桥（保留 pyautogui）
- 形态：`app-cordis/` 旁放一个小型 Python worker（`desktop-worker/`），暴露 stdin/stdout JSON-RPC 或 HTTP；Cordis 侧 `orca-desktop` 工具通过 subprocess 调用
- 符合 DSH 自身模式：DSH 的 `dsh-tool-bash`/`dsh-tool-pwsh` 就是 shell 出子进程，`dsh-subprocess-local` 是现成的子进程管理抽象
- 优点：pyautogui 截图/键鼠零重写，行为与线上完全一致；worker 顺带可承载轴 2 的本地视觉
- 缺点：双运行时（Node + Python）部署复杂度；进程间通信延迟
- 配套防护（结合 §2.6）：默认不挂载（fail-closed）、每次高危调用走 approval 一次性 grant、pre-execute 参数级白名单 guard、会话预设"桌面控制允许度"、timeoutMs + 输出截断

#### 方案 A2：纯 Node 方案（nut.js 等）
- 形态：全部换 npm 生态：`@nut-tree/nut-js`（键鼠）+ `screenshot-desktop`（截图）
- 优点：单一运行时
- 缺点：Windows 兼容性与精度需实测（pyautogui 在 Windows 经过实战检验）；多显示器/DPI 可能有坑

#### 方案 A3：WebSocket 常驻桥（变体）
- 形态：Python worker 常驻 + WebSocket 双向通信（而非每次 spawn）
- 优点：无 spawn 开销，可流式回传截图/进度
- 缺点：进程生命周期管理复杂度；与 DSH 的"无状态子进程"哲学相悖

### 轴 2：视觉分析层

#### 方案 V1：Qwen API（现状延续）
- 形态：`analyze_image` 工具直连阿里百炼 Qwen API
- 优点：效果最好、零本地开销
- 缺点：截图出本机（隐私）、按量计费、依赖网络

#### 方案 V2：本地视觉模型（Ollama qwen2.5vl 等）
- 形态：Ollama 跑 qwen2.5vl:7b，视觉工具调本地接口；与 `project-orca-overview.md` 早期愿景一致
- 优点：延迟低、隐私好（截图不出本机）、零 API 成本
- 缺点：7B 级模型效果弱于云端大模型；需要 GPU 或接受较慢推理；截图坐标识别精度可能不足

#### 方案 V3：本地优先 + API 兜底
- 形态：默认走本地模型，失败/低置信时回落 Qwen API（对齐旧架构"Ollama 本地优先，DeepSeek/Qwen API 兜底"的设计）
- 优点：兼顾隐私、成本与效果
- 缺点：双路径实现与维护成本

### 组合建议（待实测验证）

| 组合 | 场景 | 风险 |
|------|------|------|
| A1 + V1 | 最快达成功能等价（推荐 Phase 3 起点） | 双运行时 |
| A1 + V3 | 隐私优先的完整形态 | 本地模型效果 |
| A2 + V1 | 单运行时 + 云端视觉 | nut.js 兼容性 |
| A2 + V2 | 全 Node 全本地 | 双重不确定 |

**待决策**：@todo Phase 3 前实测 nut.js 与本地视觉模型在目标机器的可行性，再定终局组合；默认按 A1 + V1 起步，保证功能等价。

---

## 7. 分阶段迁移路线图

### Phase 0 — 研读与选型（本文档）
- [x] DSH 架构研读（7 模块并行，见 §2）
- [x] 通道选型倾向（§5：纯 Cordis 自写飞书通道）
- [ ] 桌面层决策矩阵初评（§6，Phase 3 前实测 nut.js / 本地视觉模型）
- 验收：本方案文档评审通过

### Phase 1 — Cordis 骨架 + 最小闭环
- 搭 `app-cordis/` 工程（pnpm + TS + cordis）
- 实现飞书收发（adapter 或自写）+ session + agent-loop + LLM（DeepSeek）
- 实现 `reply` 工具，跑通"飞书消息 → AI 回复"
- 验收：本地双跑，Python 版不动，新骨架可聊天

### Phase 2 — 工具迁移（低风险组）
- 迁移 search_web、capture_screenshot、analyze_image、refine
- 引入 persona 注入、会话持久化（jsonl）
- 验收：新骨架支持"看图/搜网/润色"闭环

### Phase 3 — 桌面控制层落地
- 按 §6 决策落地（默认方案 A1：Python 子进程桥）
- 迁移 click/double_click/right_click/move_mouse/type_text/scroll
- 接入审批/guard：高危操作（键鼠）要求确认
- 验收：新骨架支持完整桌面控制 + 审批流

### Phase 4 — 瑞幸点单流程 goal 化
- 迁移 luckin MCP 客户端（dsh-mcp-client 模式）
- 用 dsh-goal 重写 active_task 状态机
- 验收：端到端点单闭环跑通

### Phase 5 — 切流与收尾
- 双跑对照（Python 版 vs Cordis 版）→ 修复差异
- 飞书事件订阅切到新服务 → 下线 Python 版
- 更新 README/dev-log/决策文档
- 验收：Cordis 版成为唯一线上路径

---

## 8. 风险与开放问题

| 风险 | 影响 | 缓解 |
|------|------|------|
| 语言全量重写（Python→TS） | 工作量大 | 分阶段迁移，每阶段可验收 |
| 桌面控制层生态迁移 | 功能回归 | §6 决策矩阵；先保功能等价 |
| Cordis/DSH 版本早期（rc） | API 变动 | 锁定版本；研读源码而非文档 |
| 飞书适配器成熟度 | 通道可靠性 | 对比 koishi adapter vs 自写 |
| 学习成本 | 团队上手 | 本文档 §2 研读汇总作为教材 |

### 开放问题
- [ ] 桌面层终局组合（§6：A1/A2/A3 × V1/V2/V3）
- [ ] 是否引入 Koishi 框架本体（拿控制台 UI）——目前倾向不引入
- [ ] 是否复用 koishi 的飞书 adapter——目前倾向自写（§5）
- [ ] 本地视觉模型（V2）是否值得投入（对比 Qwen API）
- [ ] 新骨架是否需要 Web 界面（DSH host/runner/client 模式，§2.7）——飞书通道先行，Web 可后置
- [ ] 瑞幸点单 goal 化的具体事件 schema（§2.5 建议）

---

*本文档由 DSH 源码研读（7 模块并行子代理）+ Orca 现状分析合成。研读基线：`@deepseek-ai/cordis@4.0.1` + dsh-rc.6 全套 npm 包（本地源码）。*
