# Project Orca — 小型信息 Agent 框架设计（InfoAgent Framework）

> 状态：v0.2 设计稿（未实现）
> 日期：2026-08-25（v0.2 新增 CEO-员工-档案室模型：待机接收 / Push 上报 / 记录库）
> 关联：`guide/orca-cordis-migration-plan.md`（§2.4 工具体系、§2.5 子代理研读）、`app-cordis/`（Phase 1 已完成）
> 决策记录：`guide/decisions.md` 新增 D-AGENT-* 节（01~12）

---

## 0. TL;DR

Orca（Cordis 版）未来需要"获取各种信息"：天气、股票、新闻、日程、设备状态、文件、数据库、外部 API……本框架把这些**信息获取能力统一抽象为"小型信息 Agent"（InfoAgent）**，并支持**两种协作模式**：

- **Pull（问询）**：Orca 需要信息 → 委托 InfoAgent → 即时拿结构化结果
- **Push（上报）**：InfoAgent 像员工一样自主工作 → 把产出**写入记录库（员工档案室）** → Orca 待机接收、按需检索

**CEO-员工-档案室模型：**

| 角色 | 类比 | 职责 |
|------|------|------|
| Orca 主 Agent | **CEO** | 理解需求 → 查档案/派活 → 汇总 → 决定是否回复用户（不亲自执行具体事项） |
| InfoAgent | **员工** | 专职一件事（拍照识别/搜索/监控/分析），被派活或自主上报 |
| Record Store | **档案室** | 每员工一个档案夹（namespace），统一信封，Orca 有全部检索权 |
| Registry / Executor | **HR + 流程** | 员工名册（闭集注册表）+ 派活流程（校验/超时/归一） |

一句话：**Orca 是 CEO，InfoAgent 是员工，记录库是档案室；员工干活写档案，CEO 随时查档案回话。**

新增信息源 = 注册一个 InfoAgent（Pull 能力）+ 可选开一个档案夹（Push 能力），主循环零改动。

---

## 1. 背景与动机

### 1.1 现状
- `app-cordis` Phase 1 完成：飞书 → AI 回复最小闭环（persona + 内存会话 + DeepSeek + reply）
- v0.1 设计（2026-08-24）：Pull 问答式框架（InfoAgent 抽象 / 闭集注册表 / 路由 / 执行后端 / 安全分级）

### 1.2 新需求（v0.2 触发）
- **待机接收**：Orca 空闲时，InfoAgent 产生的信息也能进来，Orca 再决定要不要回复
- **自主产出**：InfoAgent 不一定被 Orca 调用才工作 —— 用户直接用 InfoAgent 的软件干活（如给食物拍照识别热量），产出落在那里
- **档案复用**：Orca 要用时，在 InfoAgent 的历史记录/数据库/知识库里查找
- **CEO 分工**：Orca 只做决策与汇总，具体事项全部下放

### 1.3 为什么好（设计判断）
- **解耦**：InfoAgent 不需要 Orca 在线才能工作；产出累积在档案室，Orca 随时查 —— 天然支持离线/异步
- **可复用**：一次识别（食物照片）的结果，可以被未来多次查询复用，不用重复调用模型（省钱省时）
- **可组合**：CEO 查档案 = 跨 agent 检索（"这周饮食 + 运动"能拼出健康报告）
- **演进平滑**：v0.1 的 Pull 完全保留，Push 是新增通道，不推翻已有设计

### 1.4 与既有研读结论的关系
- 迁移方案 §2.4（工具模型）、§2.5（subagent）→ 本框架落地其研读结论
- 信息获取用轻量 InfoAgent；复杂多步研究未来对齐 DSH subagent 机制
- memory-pack 设计哲学（闭集注册表 / 确定性执行）→ 沿用；**自主度模型（Level 0 被动 → Level 4 自动）→ 本框架的待机行为门控直接对齐它**

---

## 2. 概念模型

```
【Pull 路径】用户消息 → Orca 决策
                 ├── 直接回复
                 └── 查档案（记录库命中？）→ 不够 → 派活（委托 InfoAgent）→ 结果注入 → 汇总 → reply

【Push 路径】InfoAgent 自主工作（外部 App / 定时任务 / 事件触发）
                 → 写记录（Record Store，按 namespace 归档）
                 → 门控判断（urgency）→ 默认静默入库 / 重要事件进"待汇报队列" / 紧急走推送
                 → Orca 下次回话时自动检索相关档案
```

**五个核心角色：**

| 角色 | 职责 | 实现 |
|------|------|------|
| Orca 主 Agent（CEO） | 理解需求 / 查档案 / 派活 / 汇总 / 决定是否回复 | `plugins/agent.ts`（升级） |
| InfoAgent（员工） | 专职信息能力，Pull 被调 + Push 自主写档 | 每个信息源一个 |
| InfoAgentRegistry（名册） | register/list/get，闭集 | `agents/registry.ts` |
| InfoExecutor（流程） | 校验/并发/超时/截断/归一（Pull 执行） | `agents/executor.ts` |
| InfoRecordStore（档案室） | Push 写入 + 跨 namespace 检索 + 生命周期 | `agents/store.ts` |

### 2.1 InfoAgent 的两种形态（沿用 v0.1）
- **工具型**（tool）：无自身 LLM，输入→输出
- **推理型**（llm）：execute 内部自带小 LLM/逻辑（食物识别 agent 即此类：内部用视觉模型）

### 2.2 两种协作模式

| 模式 | 触发 | 数据流 | 典型场景 |
|------|------|--------|----------|
| **Pull（问询）** | Orca 主动调用 | Orca → Registry 选人 → Executor 执行 → 即时返回 | "现在重庆天气" |
| **Push（上报）** | InfoAgent 自主（App 使用/定时/事件） | InfoAgent → 写记录 → 门控 → 静默/汇报/推送 | 食物拍照识别后写档案；股价监控；待办到期 |

一个 InfoAgent 可以**同时具备两种模式**：被 Orca 问询（Pull）+ 自己干活写档案（Push）。由注册时的 `modes: ['pull'] | ['pull','push']` 声明。

---

## 3. 核心抽象（TS 接口草案）

```ts
// src/agents/types.ts

/** 能力描述 —— 给 LLM 选型和路由用 */
interface InfoAgentMeta {
  name: string
  description: string          // 能力描述（注入 system prompt 供 LLM 选择）
  tags?: string[]              // 能力标签：weather / food / finance / news / local ...
  inputSchema: unknown         // Pull 参数校验（schemastery z.object() 或 JSON Schema）
  outputSchema?: unknown       // Pull 结果结构（canonical）
  modes?: Array<'pull' | 'push'>  // 默认 ['pull']；push 需声明 recordTypes
  recordTypes?: string[]       // push 模式产出的记录类型（food-log / stock-quote ...）
  kind?: 'tool' | 'llm'
  timeoutMs?: number
  isConcurrencySafe?: boolean
  costHint?: 'free' | 'cheap' | 'paid'
}

/** 执行依赖 —— 最小权限注入（不给发送/写文件能力） */
interface AgentDeps {
  llm: LlmClient
  session: SessionStore
  store?: InfoRecordStore      // push 模式 agent 用它写档案
  logger: Logger
  signal?: AbortSignal
}

interface InfoRequest<In = unknown> {
  agent?: string
  input: In
  sessionId: string
}

type InfoResult<Out = unknown> =
  | { ok: true; data: Out; tookMs: number; source: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean } }

interface InfoAgent<In = unknown, Out = unknown> {
  meta: InfoAgentMeta
  execute(req: InfoRequest<In>, deps: AgentDeps): Promise<InfoResult<Out>>
}

// ---------- Push 模式：记录信封（员工档案条目） ----------

interface InfoRecord {
  id: string                    // uuid
  namespace: string             // agent 名（food-agent / stock-agent ...）
  type: string                  // 记录类型（food-log / stock-quote ...）
  ts: number                    // 产生时间（InfoAgent 写入时打）
  source: string                // 来源标识（app / mcp-server / worker / cli）
  confidence?: number           // 0-1，推理型 agent 的置信度
  urgency?: 0 | 1 | 2           // 0 静默（默认）/ 1 建议汇报 / 2 紧急推送
  payload: unknown              // agent 私有结构化数据（schema 由 recordTypes 对应声明）
  ttlDays?: number              // 可选过期天数（照片类可设短 ttl）
}

interface RecordQuery {
  namespaces?: string[]
  types?: string[]
  from?: number                  // ts 下限
  to?: number                    // ts 上限
  keyword?: string               // payload 内文本/JSON 关键词
  limit?: number
}

// ---------- 档案室服务 ----------
class InfoRecordStore {
  append(record: InfoRecord): Promise<void>                    // Push 入口（InfoAgent 调用）
  query(q: RecordQuery): Promise<InfoRecord[]>                  // Orca 跨 agent 检索
  delete(namespace: string, ids?: string[]): Promise<number>    // 用户/策略清理
  pruneExpired(): Promise<number>                               // 按 ttl 清理
  // 可选：getRecentByNamespace(namespace, n) 等便捷方法
}
```

**硬性约定（沿用 v0.1）：**
- Pull 结果必须**结构化 canonical**；`retryable` 语义区分网络类/逻辑类
- **记录信封不可变**：append-only（对齐事件溯源思路）；更正 = 新记录 + `supersedes` 字段指向前一条
- 记录 payload 允许 agent 私有 schema，但**信封字段（namespace/type/ts/source/urgency）是框架强制的** —— 检索与门控只依赖信封字段，不解析 payload

---

## 4. 注册与服务（Cordis 集成）

```ts
// src/plugins/info-agents.ts —— 框架装配插件
export function infoAgents(ctx: Context, config: OrcaConfig) {
  ctx.provide('infoAgents', new InfoAgentRegistry())
  ctx.provide('infoExecutor', new InfoExecutor(ctx, config))
  ctx.provide('infoStore', new InfoRecordStore(ctx, config))     // 档案室（JSONL，见 §7A）

  // 内置信息源注册
  ctx.infoAgents.register(searchWebAgent)      // pull
  ctx.infoAgents.register(foodLogAgent)        // pull + push（食物识别，示例）
  ctx.infoAgents.register(weatherAgent)        // pull

  // Push 入口：InfoAgent 或外部 App 通过事件/HTTP 写档
  ctx.on('info/record', (record) => ctx.infoStore.append(record))
}
```

- 注册表**闭集**：LLM 只能从 list() 选，不能发明 agent
- **档案夹自动创建**：register 时若声明 `recordTypes`，框架自动为该 namespace 建档案夹（JSONL 文件）
- 外部 App（用户单独用的 InfoAgent 软件）不需要是 Cordis 插件：通过 HTTP webhook / MCP 写记录（见 §7）

---

## 5. 路由（Pull 路径：怎么选 agent）

**三阶段演进（沿用 v0.1）：**

| 阶段 | 机制 | 何时 |
|------|------|------|
| R1 关键词 | 描述/tags 关键词匹配 → 候选集 | Phase 2 起步 |
| R2 LLM 工具选择 | agent 清单进 system prompt，LLM 直接工具调用 | 信息源 > 8 个 |
| R3 多源聚合 | 同请求并行调多个 agent，结果合并 | 有聚合需求 |

**新增：查档案优先（R0）** —— Orca 决策时**先查记录库**，档案命中则直接用（零成本、复用已有产出），未命中才走 R1-R3 派活。食物例子：问"我昨天中午吃了多少卡" → R0 查 food-agent 档案命中 → 直接回复，不重复调视觉模型。

---

## 6. 执行管线（Executor，Pull 路径）

```
request → 参数校验 → 并发控制 → 超时 → execute → 输出校验 → 截断 → 归一 → 日志
```

- 与 DSH 工具管线对照（迁移方案 §2.4）不变
- 失败语义：`retryable` → 重试或换源；否则告知用户

## 7. 执行后端（四种形态 + 外部 App 集成）

| 后端 | 形态 | 适用 | 备注 |
|------|------|------|------|
| in-process | TS 函数/服务 | 搜索、天气、股票、读文件 | 默认 |
| subprocess-bridge | Python worker（stdin/stdout JSON-RPC） | 需 Python 生态的能力 | 对齐桌面层 A1 |
| mcp | MCP server 客户端包装 | 外部信息源 | 对齐 luckin_mcp |
| remote-http | 本地/远程 HTTP 服务 | 独立部署的 agent 服务 | 预留 |

**新增：外部 App 集成（Push 重点）**
- 用户单独使用的 InfoAgent 软件（如食物拍照 App）→ 通过 **HTTP webhook**（`POST /info/records`，Bearer 鉴权）或 **MCP** 把记录推进 Orca 档案室
- 不需要 App 内嵌 Cordis；只需一个"上报通道 + 鉴权密钥"
- 这也让 Orca 的档案室成为**多设备/多 App 的统一知识汇聚点**

## 7A. 记录库存储选型（档案室实现）

| 方案 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| **JSONL（每 namespace 一文件）** | 零原生依赖、append-only、可读、可 git | 查询全量扫描 | **Phase A 默认**（记录量小，索引在内存维护） |
| SQLite（better-sqlite3） | 结构化查询/时间窗/索引 | 原生模块（沙箱安装麻烦） | 记录量上来或需要复杂查询时再迁 |

- 目录：`app-cordis/data/records/<namespace>.jsonl`
- 内存索引：`namespace + type + 日期桶` → 加速 R0 查档
- 与迁移方案"会话持久化 jsonl"方向一致

---

## 8. 主 Agent 集成（CEO 行为升级）

```
用户消息
  → Orca 决策（R0 查档案 → 命中？）
       ├── 命中 → 直接引用档案回复（省调用）
       └── 未命中 → 派活（委托 InfoAgent，可并行多源）→ 结果注入
  → 汇总/润色 → reply
  → （可选）把有价值的回复摘要写回档案（Orca 自己的"CEO 笔记"namespace）

待机时（无用户消息）
  → InfoAgent Push 记录入库 → 门控：
       urgency=0 静默（仅入库）
       urgency=1 进"待汇报队列"（下条消息时 Orca 主动带一句）
       urgency=2 立即推送（需用户开启 + 审批放行）
  → Orca 空闲时对"待汇报队列"做摘要（省 token：只汇报摘要不汇报原文）
```

**关键点：**
- **查档案优先（R0）** 是省钱核心：已识别的食物/已查的天气不重复调模型
- **门控默认静默**：Push 不等于打扰 —— 默认只入库，是否主动说话由 urgency + 用户开关决定（对齐 memory-pack 自主度：Level 1 通知 / Level 2 建议，**Level 2 以上默认关闭**）
- 串行锁沿用；Push 写入与 Pull 执行互不阻塞（写档很快，不占主循环）
- 会话历史里档案引用用结构化标记：`[record:food-agent food-log 2026-08-24T12:00 680kcal]`

---

## 9. 安全模型

| 级别 | 内容 | 策略 |
|------|------|------|
| L0 | 公开信息（天气/新闻/股票/搜索） | 直接执行/入库，仅记录 |
| L1 | 用户私有数据（**食物照片**、文件、日历） | 记录**不落明文日志**；payload 可设 ttl；用户可一键删除 namespace |
| L2 | 外部副作用（订阅/下单/推送/写文件） | **走审批**（一次性 grant）；**urgency=2 推送默认关闭，开启需用户确认** |

- AgentDeps 最小权限（不给 feishu 发送/写文件）；Push 上报通道需鉴权（Bearer token 每 App 一个）
- 记录删除是"软删 + ttl 硬清理"：append-only 文件里标记 deleted，prune 时物理清理
- 照片等 L1 payload：可存本地路径引用而非图片二进制（Orca 本地运行，无云上传）

---

## 10. 目录结构与落地计划（app-cordis）

```
src/
├── agents/                    # ★ 信息获取框架
│   ├── types.ts               # InfoAgent / InfoRequest / InfoResult / InfoRecord / RecordQuery
│   ├── registry.ts            # InfoAgentRegistry
│   ├── executor.ts            # InfoExecutor（Pull 执行）
│   ├── store.ts               # InfoRecordStore（档案室：JSONL + 内存索引 + ttl）
│   ├── router.ts              # R0 查档 + R1 关键词（R2 起 LLM 工具选择）
│   └── builtins/
│       ├── search.ts          # search_web 迁移（bing）
│       ├── weather.ts         # 天气（示例）
│       ├── food-log.ts        # 食物识别（示例：pull+push，视觉模型）
│       ├── screenshot.ts      # capture_screenshot 迁移
│       └── analyze.ts         # analyze_image 迁移（Qwen 视觉）
├── plugins/
│   ├── info-agents.ts         # 装配 registry/executor/store + 注册内置
│   └── info-receiver.ts       # 外部 App Push 通道（POST /info/records，鉴权）
└── data/records/              # 档案室 JSONL（gitignore）
```

**分阶段落地：**
| 阶段 | 内容 | 验收 |
|------|------|------|
| **A 框架骨架** | types + registry + executor + store(JSONL) + R0/R1 路由 + 2 个示例（search 迁移、weather 新写） | "今天重庆天气" → 查档/调用 → 人设回复 |
| **B Push + 档案** | food-log 示例（pull+push）+ info-receiver 外部通道 + urgency 门控 | 食物 App 推记录 → Orca 问"昨天吃了多少卡"命中档案 |
| **C LLM 路由 + MCP** | R2 function calling + 通用 MCP 包装 | 多源选择准确率 + MCP 零胶水接入 |
| **D 聚合/汇报/记忆** | R3 并行聚合、待汇报队列、档案进工作区记忆 | 主动建议（urgency=1）落地 |

每阶段走 D-VER 流程：升版本（app-cordis 内部）、dev-log、AGENT.md 同步、提交带前缀。

---

## 11. 决策记录（D-AGENT-*）

- **D-AGENT-01** 信息获取统一抽象为 InfoAgent（meta + execute），主循环不感知具体源
- **D-AGENT-02** 注册表闭集，LLM 不能发明 agent
- **D-AGENT-03** Pull 结果必须结构化 canonical
- **D-AGENT-04** 路由演进：R1 关键词 → R2 LLM 工具选择 → R3 多源聚合
- **D-AGENT-05** 执行后端可插拔（进程内/子进程桥/MCP/HTTP），MCP 自动包装
- **D-AGENT-06** 安全分级 L0/L1/L2；AgentDeps 最小权限
- **D-AGENT-07** 委托可审计（路由回执 + 会话结构化标记）
- **D-AGENT-08** **双向模式**：InfoAgent 支持 Pull（问询）与 Push（自主写档案）；`modes` 声明，可同时具备
- **D-AGENT-09** **记录库（档案室）**：每 namespace 一档案夹，统一信封 InfoRecord（append-only + supersedes 更正）；Phase A 用 JSONL，SQLite 视查询量再迁
- **D-AGENT-10** **Orca = CEO**：只做理解/查档/派活/汇总/回复；具体事项由 InfoAgent 执行；**查档案优先（R0）**，命中即用不重复调用
- **D-AGENT-11** **待机行为门控**：默认静默入库；urgency 0 静默 / 1 建议汇报（下条消息带一句）/ 2 紧急推送（默认关闭，需用户开启 + 审批）
- **D-AGENT-12** **记录生命周期与隐私**：ttl + 软删/硬清理；L1 私有数据（照片等）不落明文日志、可一键清空 namespace；外部 Push 通道需鉴权

---

## 12. 风险与开放问题

| 风险/问题 | 影响 | 缓解 |
|-----------|------|------|
| 推理型 agent 的 LLM 成本叠加 | 每次委托多次 LLM | 只给必要上下文；**R0 查档优先复用**；结果摘要化 |
| 档案膨胀 / 隐私 | 存储增长、照片等敏感数据滞留 | ttl + 一键清空 + L1 不落明文 |
| 主动打扰用户 | 推送刷屏 | urgency 门控 + Level 2 默认关闭 + 用户开关 |
| 多源结果冲突 | 同问题不同源答案不一致 | 可信度排序 + 主 agent 仲裁 |
| 记录一致性 | 同一事物重复记录（同照片两次识别） | 信封 `supersedes` 更正 + payload 内指纹（如照片 hash）去重 |
| 外部 App 鉴权 | 伪造记录灌入档案 | 每 App 独立 Bearer token + namespace 白名单 |
| 小 agent 间互相调用 | 组合爆炸 | 初期禁止（YAGNI） |
| 与 DSH subagent 关系 | 重复造轮子 | 信息获取用轻量 InfoAgent；复杂研究未来对齐 DSH subagent |

---

## 13. 走查：食物拍照（用户设想的例子）

1. **用户用食物识别 App**（= food-agent，推理型，内部 Qwen 视觉，运行在手机/PC）
   - 拍照 → 识别"红烧肉盖饭 ≈ 680 kcal" → App 通过 `POST /info/records`（Bearer 鉴权）写入：
     `{ namespace:'food-agent', type:'food-log', ts, source:'food-app', confidence:0.87, urgency:0, payload:{ photoRef:'local://...', food:'红烧肉盖饭', kcal:680 } }`
2. **门控**：urgency=0 → 静默入库（`data/records/food-agent.jsonl`），Orca 不打扰用户
3. **用户问 Orca**："我昨天中午吃了多少卡？"
   - R0 查档案：namespace=food-agent，类型 food-log，时间窗=昨天中午 → 命中
   - Orca 回复："昨天中午是红烧肉盖饭，约 680 kcal"（零模型调用，纯查档）
4. **（可选）主动建议**：若 food-agent 连续两天检测到摄入超标，写 urgency=1 记录 → Orca 下条消息时带一句："老板，这两天摄入有点超标，注意一下"
5. **隐私**：照片只存本地路径，ttl 7 天，用户可一键清空 food-agent 档案

**这个例子验证了 v0.2 三个核心价值：解耦（App 独立工作）、复用（R0 查档省钱）、可控（门控不打扰）。**

---

## 14. 与现有文档的关系

- `guide/orca-cordis-migration-plan.md` §2.4/§2.5 → 本框架落地其研读结论
- Phase 2 原计划"迁移 search_web/capture_screenshot/analyze_image/refine" → 重新组织为：前三个迁移为 InfoAgent（Pull），refine 留主 agent；food-log 作为 Push 示例
- `guide/decisions.md` → D-AGENT-01~12
- `AGENT.md` → 文档地图与 §9.3 下一步更新

---

*本设计稿基于工作区文档编写，未实现任何代码。待用户评审后按 §10 分阶段落地。*
