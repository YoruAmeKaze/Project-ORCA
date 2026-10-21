---
name: order-food
description: 在 Orca 中查询瑞幸与麦当劳中国门店、菜单、商品、订单状态和只读价格预览；下单等写操作仅在确认闭环完成后开放。
---

# 瑞幸 / 麦当劳中国 MCP 接入 Skill（ORCA）

> 当前状态：门店、菜单、商品、价格预览和订单状态查询已接入 Cordis 现有 `ActionExecutor → ActionHandler → ActionResult`。不新增 MCP Manager、Capability 层或新的 Agent 框架。建单确认闭环未实现，所有写操作仍关闭。瑞幸附近门店查询依赖独立的 `location.current` Action。

## 边界与隔离

- 瑞幸和麦当劳是两个独立 MCP 外部服务：分别配置 endpoint、secret 和允许调用的供应商工具。禁止共享凭证、工具映射或业务 schema。
- Token 只从本机私密配置读取，不从飞书消息收集，不进入 skill、ActionResult、日志或仓库。日志不得包含认证头、完整配送地址或不必要的账户标识。
- 每个 ActionHandler 只处理一个明确的业务动作；不允许 Planner 传入任意 server 名、任意工具名或原始 MCP JSON-RPC。Handler 绑定固定服务与已核验工具，并按实时 schema 校验输入、响应和业务状态。
- MCP 工具清单和 schema 必须运行时从官方 endpoint 读取。草案/第三方仓库中的工具名仅是检索线索，不是稳定 API。清单缺失、schema 变化、未知状态或校验失败时，停止相应操作，不猜参数、不降级模拟。
- MCP 结果翻译为简明中文 `ActionResult`；不把原始 MCP 报文透传给用户。
- `ActionResult` 只是执行结果，不代表审批。下单前必须另有待确认订单记录和确认入口；在它们通过验证前，建单 handler 不得注册。

## 当前只读 MVP Actions

运行时通过固定 Action 名映射到供应商工具；以下工具名来自 2026-10-08 官方 `tools/list` 实查快照。每次 handler 调用前都会重新取清单，并对照已核验的 schema；官方变更时 fail closed。参数仍以当次实时 schema 为准。

| ORCA Action | 服务 | 当前官方工具 | 范围 |
|---|---|---|---|
| `order.luckin.stores` | 瑞幸 | `queryShopList` | 只读门店查询；位置只从 `location.current` 的短期内存缓存读取 |
| `order.luckin.products` | 瑞幸 | `searchProductForMcp` | 只读商品搜索 |
| `order.luckin.product_detail` | 瑞幸 | `queryProductDetailInfo` | 只读商品详情 |
| `order.luckin.preview` | 瑞幸 | `previewOrder` | 只读订单预览，不提交 |
| `order.luckin.order_status` | 瑞幸 | `queryOrderDetailInfo` | 只读订单查询 |
| `order.mcd.stores` | 麦当劳 | `query-nearby-stores` | 按用户给出的城市和地标查询门店 |
| `order.mcd.menu` / `order.mcd.meal_detail` | 麦当劳 | `query-meals` / `query-meal-detail` | 只读菜单和餐品详情 |
| `order.mcd.price` | 麦当劳 | `calculate-price` | 只读价格试算，不提交 |
| `order.mcd.order_status` | 麦当劳 | `query-order` | 只读订单查询 |
| `order.mcd.store_coupons` | 麦当劳 | `query-store-coupons` | 只读门店优惠，不领取 |
| `order.mcd.server_time` | 麦当劳 | `now-time-info` | 只读服务端时间 |

具体输入结构在启动时从 `tools/list` 发现并在调用时验证。模型只选择上表中的固定 ORCA Action，不接触 MCP server/tool 字符串。

## 操作分级

| 动作 | 处理方式 | MVP |
|---|---|---|
| 查门店、菜单、商品详情、营业状态、订单状态 | 只读 ActionHandler | 目标范围 |
| 试算价格、查看可用优惠 | 只读预览 ActionHandler；绝不自动领取/兑换 | 目标范围（仅服务实际支持时） |
| 建单、取消订单、领取优惠、修改地址 | 每次确认后才允许；固定工具和已确认参数 | 禁用 |
| 支付、验证码、密码、银行卡信息 | ORCA 不处理，交由官方支付流程 | 禁止 |

## 当前 Action 链路适配

当前 `ActionExecutor` 从 `orca/decision` 接收 `Decision`，按 `decision.action` 查找 handler，再发出 `orca/action-result`。不要把订单写入 `InfoAgent`，也不要把完整点餐流程注册成单个 Action。

MVP 应分别注册两个服务适配器及少量具体只读 ActionHandler；每个 handler 的 action 标识和服务绑定固定。Action 参数只能来自已校验的结构化意图，不能把自由文本 `reason` 当供应商请求体。调用 MCP 的 transport 代码应限制在服务适配器内，不改变 ActionExecutor 的职责。

注意：当前普通飞书对话的 legacy Agent 直接调用 LLM，不经过 ActionExecutor；Runtime 的认知 action 意图也尚无可复用的订单确认状态。只读 handler 的运行时接入不等于端到端对话可用。实现 MVP 时必须明确调用入口和 ActionResult 如何关联回原会话；不能仅因 handler smoke 通过就宣称自然语言点餐已经打通。

## 订单确认闭环（MVP 之后）

```text
查询门店 / 菜单 → 试算 → 展示订单摘要 → 写入待确认记录
    → 验证同一会话用户确认 + 预览未过期未变更
    → 提交与预览一致的参数 → 查询订单状态 → 回报
```

确认摘要至少包括品牌、门店、商品及规格、数量、总价、取餐/配送方式及配送地址（如适用）。确认需绑定预览内容和有效期；任一字段变化都必须重新试算并再次确认。“帮我点一杯”不是最终确认。MVP 不注册任何建单、取消、领券、兑换或地址修改 handler。

建单开放前必须有最小待确认订单记录及确认入口，并验证：原会话用户身份、预览有效期、内容不可变、确认只能消费一次。提交超时/连接中断时先查状态或按供应商幂等能力核对，禁止直接重试建单；结果不明时反馈“状态待核实”。

## MCP 服务身份

| 服务 | 官方入口 | Endpoint / 认证 |
|---|---|---|
| 瑞幸中国（my-coffee） | [瑞幸 AI 开放平台](https://open.lkcoffee.com/mcp) | `https://gwmcp.lkcoffee.com/order/user/mcp`；Streamable HTTP + Bearer Token |
| 麦当劳中国 | [麦当劳 MCP 平台](https://open.mcd.cn/mcp) / [官方文档](https://open.mcd.cn/mcp/doc) | `https://mcp.mcd.cn`；Streamable HTTP + `Authorization: Bearer <token>` |

官方认证与当前清单已在本机凭证下实查成功（瑞幸返回 8 个工具，麦当劳返回 35 个工具）；只读门店查询已分别真实调用成功。之后仍以每次运行时的官方 `tools/list` 和 schema 为准。

启用需同时显式设置 `ORCA_RUNTIME_ENABLED=1`、`ORCA_ACTION_ENABLED=1`，以及对应的 `ORCA_LUCKIN_MCP_ENABLED=1` / `ORCA_MCD_MCP_ENABLED=1`。凭证键沿用 `LUCKIN_COFFEE_TOKEN`、`MCDONALD_TOKEN`。瑞幸门店搜索另需本机 `ORCA_LUCKIN_LONGITUDE`、`ORCA_LUCKIN_LATITUDE`；未配置时该 Action 不注册。未启用的服务不连接、不影响 ORCA 启动。

## 验收

- 两个服务配置和凭证互相隔离；缺少配置时只禁用对应服务，不阻断 ORCA 启动。
- 只读 handler 对空参数、非法参数、未知工具、schema 变化、错误响应和超时 fail closed；不记录密钥或敏感地址。
- 未确认时没有建单 handler 可执行；MVP 中写工具完全不可达。
- 构建及 Action smoke 通过；之后须在用户本机凭证下分别核验两家官方工具清单和只读查询结果，才能宣称服务级 MVP 验证成功。

## 来源

- [瑞幸 AI 开放平台](https://open.lkcoffee.com/mcp)
- [麦当劳 MCP 平台](https://open.mcd.cn/mcp) / [官方文档](https://open.mcd.cn/mcp/doc)
- [LuckinCoffeeAutoOrder](https://github.com/james-23-6/LuckinCoffeeAutoOrder)（第三方项目，仅作检索线索）
- [TimCheung-jx/mcdonalds-mcp](https://github.com/TimCheung-jx/mcdonalds-mcp)（第三方项目，仅作检索线索）
