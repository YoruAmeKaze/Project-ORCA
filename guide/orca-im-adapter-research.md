# Orca IM Bridge — Real IM Adapter Research Report

> 日期：2026-09-09
> 阶段：IM-1.5B（调研，不实现）
> 调研范围：QQ / 微信 / 其他可行方案

---

## 0. 背景与约束

**当前 IM-1.5A 已完成**：
- `CommunicationSignal` 类型（不含消息内容）
- `IMObservationAdapter`（订阅 EventBus im.*，生成 signal）
- `im.burst` Episode 扩展
- Observation-only：signal 在内存，不写 MemoryStore

**IM-1.5B 目标**：评估真实 IM 平台接入可行性，保持 Observation-only。

**硬性约束**（不可突破）：
1. 不实现自动回复
2. 不调用 LLM
3. 不访问 MemoryStore
4. 不产生 Decision / Action
5. Adapter 职责：**只接收消息 → 转换 MessageEnvelope → publish EventBus**

---

## 1. 平台可行性比较

### 1.1 QQ 平台

#### 方案 A：NapCatQQ（OneBot v11 HTTP）

**现状**：
- 活跃开发（2024-2025 持续更新）
- 基于 NTQQ（新版 QQ）协议，实现 OneBot v11 / v12 标准
- HTTP / WebSocket 两种接入方式
- 社区成熟，AstrBot 等项目已在生产使用

**优势**：
- OneBot 协议抽象良好，adapter 实现相对简单
- 社区文档丰富
- 支持 HTTP Long Polling，Orca 可做 HTTP Server 被动接收

**风险**：
- **封号风险中-高**：NTQQ 协议不定期更新，NapCatQQ 需要跟随协议迭代；长期稳定运行有掉线风险
- 依赖 NTQQ 版本，Windows 环境需保持 QQ 在线
- OneBot v11 与 v12 存在差异，v11 更成熟

**登录方式**：扫码登录（NTQQ 账号），长期挂机

**隐私**：消息内容经 NapCatQQ 中转，但 Orca 只接收 Envelope（不含 text），风险可控

**维护成本**：中等（协议更新时需跟进 NapCatQQ 版本）

---

#### 方案 B：Lagrange.OneBot

**现状**：
- 基于 Lagrange.Core（QQ 协议纯实现），OneBot 封装
- 社区半活跃，更新频率低于 NapCatQQ
- 协议覆盖较全

**优势**：
- 纯协议实现，不依赖官方 QQ 客户端
- 支持 Linux / Mac / Windows

**风险**：
- Lagrange.Core 更新节奏不稳定
- OneBot 兼容性与 NapCatQQ 相近但部分细节不同

**封号风险**：同 NapCatQQ

**维护成本**：中等

---

#### 方案 C：go-cqhttp（已停止维护）

**结论**：不推荐，停止更新。

---

### 1.2 微信平台

#### 方案 D：wechatferry（WCF，PC 微信_HOOK）

**现状**：
- 活跃维护（2024-2025 持续更新）
- 基于 PC 微信 HOOK 方案（注入 DLL，拦截微信内部消息）
- 提供 HTTP API 接口

**优势**：
- 消息类型覆盖全（文本/图片/语音/文件/位置/名片/撤回等）
- HTTP Server 模式，Orca 可被动接收
- 支持发送消息（IM-1.5B 不使用）

**风险**：
- **封号风险高**：PC 微信 HOOK 方案违反微信 TOS；腾讯持续加强检测
- 需要在 Windows 宿主机运行（HOOK 依赖 Windows API）
- HOOK 技术脆弱：微信版本更新可能失效
- 消息加密/解密处理复杂

**登录方式**：扫码登录 PC 微信，长期挂机

**维护成本**：高（WCF 版本 + 微信版本双重跟进）

---

#### 方案 E：openclaw-weixin / ClawBot API（腾讯准官方）

**现状**：
- 利用腾讯官方开放接口或第三方逆向接口
- ClawBot API 提供相对合规的微信消息接收接口
- 成熟度较低，社区规模小

**优势**：
- **合规风险最低**（如果走腾讯官方 API 路径）
- 消息格式标准化

**风险**：
- 接口稳定性不确定（第三方接口随时可能失效）
- 腾讯官方对个人用途的 API 限制严格
- 社区不够成熟，长期维护风险大

**登录方式**：依赖具体方案，可能是扫码或 token

**维护成本**：不确定（接口稳定性差）

---

#### 方案 F：ntchat

**现状**：类似 WCF，PC 微信 HOOK 方案，活跃度低于 WCF。

**结论**：不优先推荐，维护成本同 WCF。

---

### 1.3 其他平台

#### Telegram

- **官方 Bot API**：完全合规，稳定，零封号风险
- 但 Telegram 不是中国用户主流 IM，优先级低
- 如果要接，BOT API 是最佳选择（完全合规 + 官方支持）

#### 钉钉 / 飞书

- 企业 IM，有官方 Bot SDK
- Orca 已有飞书通道（D-AGENT-13），不重复建设

#### Discord

- 不在中国用户场景

---

## 2. 平台比较矩阵

| 平台 | 方案 | 协议 | 合规性 | 封号风险 | 稳定性 | 维护成本 | 个人长期运行 | 推荐度 |
|---|---|---|---|---|---|---|---|---|
| **QQ** | NapCatQQ | OneBot v11 HTTP | ⚠️ 灰（协议逆向）| 中-高 | 高（社区活跃）| 中 | ⚠️ 需备用小号 | ⭐⭐⭐⭐ |
| **QQ** | Lagrange.OneBot | OneBot HTTP | ⚠️ 灰 | 中-高 | 中 | 中 | ⚠️ 需备用小号 | ⭐⭐ |
| **微信** | wechatferry | PC HOOK | ❌ 违规 | 高 | 中（HOOK 脆弱）| 高 | ❌ 风险高 | ⭐⭐ |
| **微信** | openclaw/ClawBot | 第三方 API | ⚠️ 待定 | 低-中 | 低（不成熟）| 不确定 | ⚠️ 接口不稳定 | ⭐ |
| **微信** | 微信网页版 | 第三方逆向 | ❌ 违规 | 高 | 低 | 高 | ❌ 已失效 | — |
| **Telegram** | Bot API | 官方 HTTP Bot API | ✅ 完全合规 | 零 | 高 | 低 | ✅ | ⭐⭐⭐（非中国主流）|

---

## 3. 推荐 MVP 平台

### 第一优先：NapCatQQ（QQ）

**理由**：
1. **社区成熟度最高**：OneBot 协议是 Bot 开发标准，NapCatQQ 是其中最活跃的实现
2. **Adapter 实现成本最低**：HTTP Server 模式，Orca 做 HTTP Server 被动接收，不需要轮询
3. **协议抽象层良好**：Adapter 只做 MessageEnvelope 转换，OneBot 事件格式清晰
4. **Observation-only 完美匹配**：只接收消息（NapCatQQ → EventBus），完全不涉及发送

**适合场景**：
- 备用小号（非主号）
- 晚上/周末偶尔用的群聊
- QQ 工作群消息监控

**配置**：
```
ORCA_IM_QQ_ENABLED=1（默认0）
ORCA_IM_QQ_HTTP=http://127.0.0.1:3000（NapCatQQ OneBot HTTP）
ORCA_IM_PLATFORM=im.qq
```

### 备选：Telegram Bot API

**理由**：
- 完全合规，零封号风险
- 官方支持，长期稳定
- 适合有 Telegram 使用习惯的用户

**局限**：Telegram 在中国不是主流 IM，覆盖面有限。

### 不推荐：微信（当前）

**理由**：
- WCF 的 PC HOOK 方案封号风险高，不适合"个人长期稳定运行"
- openclaw/ClawBot 接口不成熟，维护成本不可预估
- 微信比 QQ 更敏感，封号后果更严重

**建议**：微信接入作为**远期 Phase**，等 openclaw 或腾讯官方 API 稳定后再评估。

---

## 4. NapCatQQ Adapter Interface 设计

### 4.1 当前 IM Adapter Interface 是否需要调整

**结论：不需要调整**。

当前 `IMAdapterFactory` 接口：

```ts
export type IMAdapterFactory = (
  bus: EventBus,
  config: OrcaIMConfig,
  logger: Logger,
) => RuntimeAdapter  // { start(), stop() }
```

NapCatQQ 是 HTTP Server 模式，Adapter 实现：

```
NapCatQQ（NTQQ 客户端）
  │
  ▼ OneBot v11 HTTP POST（推送事件）
Orca HTTP Server（im-adapter 内部）
  │
  ▼ normalize(rawEvent) → MessageEnvelope
  │
  ▼ EventBus.publish({ source:'im.qq', type:'im.message.received', data:{envelope} })
```

**关键区别**：
- MockIMAdapter：主动 tick 生成消息（timer 驱动）
- NapCatQQ Adapter：被动接收 OneBot HTTP POST（EventBus 是 output；NapCatQQ 是 input source）

接口不变，但在 `config.ts` 需要新增：
```
ORCA_IM_QQ_HTTP=http://127.0.0.1:3000
ORCA_IM_QQ_MODE=http | ws   # HTTP Server 或 WebSocket
```

### 4.2 最小实现方案（IM-1.5B，仅观察）

**文件结构**：
```
src/plugins/input-adapters/
  qq-adapter.ts      ← 新增：NapCatQQ HTTP Server adapter
```

**职责**：
- 实现 HTTP Server（监听 NapCatQQ 推送）
- 解析 OneBot v11 事件帧
- 转换为 MessageEnvelope
- 发布到 EventBus
- `start()` = 启动 HTTP Server
- `stop()` = 关闭 HTTP Server

**禁止**：
- 不调用 send API（NapCatQQ 的发消息接口）
- 不处理 voice / video 消息（只处理 text + basic metadata）
- 不存储任何消息内容

**OneBot → MessageEnvelope 映射**（仅观察，不需要全部字段）：

| OneBot 字段 | MessageEnvelope |
|---|---|
| `message_id` | `messageId` |
| `user_id` | `senderId` |
| `group_id` | `conversationId`（群聊）|
| `user_id`（私聊）| `conversationId`（私聊会话 ID）|
| `message`（原始段式）| `content: string`（纯文本提取）|
| `raw_message` | 丢弃（完整消息字符串）|
| `sub_type` | 映射 `isGroup` |
| `self_id` | 丢弃 |
| `time` | `timestamp` |

---

## 5. 最小实现方案（NapCatQQ HTTP Server）

### 5.1 架构

```
NapCatQQ（运行在 Windows 宿主机）
  │
  ▼ HTTP POST /ws（OneBot v11 事件推送）
NapCatQQAdapter（运行在 Orca Runtime 内）
  ├─ HTTP Server（接收事件）
  ├─ OneBotEvent → MessageEnvelope 转换
  └─ EventBus.publish({ source:'im.qq', type:'im.message.received', data:{envelope} })
```

**NapCatQQ 配置**（在 Windows 端 NapCatQQ 配置文件中）：
```json
{
  "httpServers": [
    {
      "enabled": true,
      "url": "http://<ORCA_HOST>:3000/callback"
    }
  ]
}
```

### 5.2 Orca Adapter 实现要点

```ts
// 伪代码（不实现，仅设计）
async function start() {
  const server = createHTTPServer()
  server.post('/callback', async (req, res) => {
    const event = parseOneBotEvent(req.body)
    const envelope = normalize(event)
    bus.publish({
      source: 'im.qq',
      type: 'im.message.received',
      data: { envelope },
      priority: 1,
    })
    res.json({ status: 'ok' })
  })
  await server.listen(3000)
}
```

### 5.3 配置扩展

```ts
// OrcaIMConfig 扩展
interface OrcaIMConfig {
  enabled: boolean
  platform: 'im.qq' | 'im.wechat'
  mockIntervalMs: number
  // NapCatQQ 新增
  mode: 'mock' | 'http' | 'ws'
  qq?: {
    httpHost: string    // 默认 '0.0.0.0'
    httpPort: number    // 默认 3000
    accessToken?: string // NapCatQQ 的 accessToken
  }
}
```

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| NapCatQQ 协议更新导致 Adapter 失效 | 中 | Adapter 与 Orca 通过 MessageEnvelope 解耦；NapCatQQ 更新只需修改 adapter 的 normalize 逻辑 |
| QQ 账号被封 | 中-高 | 使用**备用小号**，非主号；Orca 设计已明确此约束 |
| HTTP Server 安全（端口暴露）| 低 | 默认绑定 `127.0.0.1:3000`，不暴露公网 |
| NapCatQQ 掉线/崩溃 | 中 | Adapter 提供心跳检测；掉线后记录警告日志，不影响 Runtime |
| 微信封号（远期方案）| 高 | 暂不接入微信；等合规方案稳定后再评估 |
| OneBot 事件顺序/重复 | 低 | Orca EventBus 的 sliding window + MessageEnvelope.messageId 去重 |

---

## 7. IM-1.5B 实现范围（设计）

**新增文件**：
- `src/plugins/input-adapters/qq-adapter.ts` — NapCatQQ HTTP Server adapter

**修改文件**：
- `src/config.ts` — 新增 `OrcaIMConfig.qq` 字段 + `ORCA_IM_QQ_HTTP_HOST` / `ORCA_IM_QQ_HTTP_PORT` / `ORCA_IM_QQ_ACCESS_TOKEN` 环境变量

**不修改**：
- `EventBus` / `WorldState` / `AttentionEngine` / `DecisionEngine` / `ActionExecutor` / `MemoryStore`
- `IMObservationAdapter`（已独立，不受影响）
- EpisodeEngine（im.burst 由 ObservationAdapter 生成）

**不实现**：
- QQ 发送消息（send API）
- 微信任何方案
- 自动回复
- Attention / Decision 接入

---

## 8. 结论

### 推荐 MVP：NapCatQQ（QQ）

**理由总结**：
1. 社区最成熟，文档最完善
2. OneBot 协议抽象良好，Adapter 实现成本低
3. HTTP Server 模式天然适合 Orca 的"被动观察"
4. 备用小号约束下，封号影响可控
5. 观察模式（不发送）降低封号风险

### 微信：暂缓

WCF 封号风险 + HOOK 脆弱性，不适合个人长期稳定运行。openclaw/ClawBot 不成熟，维护成本不可预估。

### 下一步

IM-1.5B 实现 NapCatQQ HTTP Server adapter，Observation-only，不涉及发送。

---

## 附录 A：NapCatQQ 快速参考

| 项目 | 地址 |
|---|---|
| NapCatQQ | https://github.com/NapNeko/NapCatQQ |
| OneBot v11 协议 | https://github.com/botuniverse/onebot-11 |
| AstrBot（参考实现）| https://github.com/Soulter/AstrBot |

## 附录 B：工作区已有调研

详见：
- `guide/orca-im-bridge-report.md`（平台详细调研，包含 AstrBot / NapCatQQ / WCF / openclaw-weixin）
- `guide/orca-im-bridge.md`（§§5.3 执行后端对比）
