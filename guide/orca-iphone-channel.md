# Project Orca — iPhone 数据通道调研（手机 = 共享数据源）

> 状态：v1.0 调研结论（2026-08-25）
> 关联：`guide/orca-info-agent-framework.md`（v0.2，外部源 / Push 通道 / namespace / L1 隐私）、`guide/decisions.md`（D-AGENT-13）
> 背景：Orca 在 Windows 上。手机不是 InfoAgent，而是**多个 agent 共用的数据源**；需要一个稳定、便宜、覆盖面广（照片/健康/文件…）的统一获取通道。

---

## 0. 结论（TL;DR）

**iPhone = 数据源（传感器群），三条传输通道进 Orca，各 InfoAgent 按 namespace 消费：**

```
iPhone（主力 = 快捷指令，零开发者账号）
  ├─ 通道① 飞书（图片/文件/文本）──→ Orca 飞书通道（扩展收 image/file 消息）──→ 路由到对应 agent
  ├─ 通道② HTTP webhook ──→ POST /info/records（Bearer 鉴权）──→ 结构化数据（健康/位置/任意 JSON）
  └─ 通道③ 本地文件同步（iCloud for Windows / Phone Link）──→ 文件夹监听 InfoAgent（批量/大文件）
```

**为什么这套稳定且便宜：**
- 飞书是异步消息平台：手机离线时消息缓冲在飞书服务器，PC 上线照样能收 → 天然抗断连（比直连 USB/WiFi 稳）
- 全部免费或一次性低价，**不需要 Apple 开发者账号（$99/年）**
- 手机端统一用**快捷指令**一个工具：能读照片/健康/文件/剪贴板/位置，能定时自动化，能 POST HTTP，能分享到飞书

---

## 1. 关键事实

- Apple **没有**给 Windows 提供"远程控制 iPhone"的官方 API（iPhone Mirroring 是 macOS 专属；[iphone-use](https://github.com/leeguooooo/iphone-use) 这类 WebRTC+MCP 强方案只能跑在 Mac 上）
- 稳定获取 iPhone 数据 = **手机主动"推"出来**（快捷指令/自动化/自建 App），而不是 Orca 去"拉"
- 第三方 UI 级控制（[WDA MCP](https://lobehub.com/zh/mcp/qizhan7-wda-mcp)、[Lakr233/iphone-mcp](https://github.com/Lakr233/iphone-mcp)）初始安装需要一台 Mac 签 Xcode，属于深水区，当前不采用

---

## 2. 通道① 飞书（主通道，用户已定食物走此路）

**原理**：手机快捷指令把数据（图片/文件/文本）通过飞书 App 的分享扩展发给某个飞书账号/群/机器人 → Orca 的飞书通道（已实现 `im.message.receive_v1` 接收）扩展支持 **image/file 消息** → 下载媒体 → 路由给对应 InfoAgent。

**飞书侧接口**：
- 收图：`im.message.receive_v1`，`message_type=image`，content 含 `image_key` → 调[飞书图片下载接口](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/create.md) 拿二进制
- 收文件：`message_type=file`，content 含 `file_key` → 下载接口同理
- 机器人上传图片：`im/v1/images`（快捷指令"获取 URL 内容"多步也可发，但走分享面板更简单）

**食物流程（用户已定）**：
1. iPhone 拍照 → 快捷指令 → 分享到飞书（发给食物 agent 的账号/群）
2. Orca 收到 image 消息 → 下载 → Qwen 视觉识别（`qwen3.7-plus`，DashScope）→ 写 `food-log` 档案
3. 回复确认 + R0 查档复用（"我昨天吃了多少卡"直接查档案，零模型调用）

**多账号路由**：若给食物 agent 单独开一个飞书应用（bot），其事件订阅 URL 指向 Orca 同一端点；飞书事件 header 含 `app_id`，可按 app_id 路由到不同 agent（本轮先统一走 food 管线，加 app_id 路由是后续小改）。

参考实现：[nanobot 的多媒体下载支持](https://github.com/HKUDS/nanobot/commit/98ef57e3704860c54b86f6e8ae0d742c646883aa)。

---

## 3. 通道② HTTP webhook（结构化数据）

**原理**：任何快捷指令用"获取 URL 内容"→ `POST /info/records`（Bearer token + namespace 白名单）→ Orca 的 Push 通道（框架 §7 外部 App 集成）→ InfoRecordStore。

- 适合：健康快照、位置、剪贴板、任意 JSON 化数据
- 与框架 D-AGENT-08/09 完全对齐（Push 模式 + 记录信封）
- Orca 侧实现排期在健康通道（见 §6）

---

## 4. 通道③ 本地文件同步（批量/大文件）

**原理**：快捷指令"存储到文件"写 iCloud Drive → **iCloud for Windows** 自动同步到 PC 文件夹；或 **Phone Link** 文件互传（[pocket-lint](https://www.pocket-lint.com/share-files-between-iphone-and-pc-via-phone-link/)）→ 文件夹监听 InfoAgent（in-process watcher）→ 消费。

- 适合：文档、导出 CSV、相册全量（iCloud 相册同步）
- 零开发、零账号成本；照片走此路也能做，但飞书通道交互性更好（能即时回复）

---

## 5. 按数据类型落法

### 照片 📷
- 首选：快捷指令 → 飞书（通道①，用户已定）——即时、可回复、可带上下文
- 备选：iCloud for Windows 相册同步 → 文件夹监听（批量回溯）

### 健康 ❤️（最全最稳）
- **Health Auto Export**（[App Store](https://apps.apple.com/ba/app/health-auto-export-json-csv/id1115567069)，免费+一次性低价 IAP，[API 导出文档](https://github.com/Lybron/health-auto-export)）：全量 HealthKit（步数/心率/睡眠/体重/活动能量…）自动导出 JSON/CSV，支持 API/云同步 → Orca 定时拉或 webhook 推
- 免费替代：快捷指令定时"查找健康样本"（[HealthKit 快捷指令参考](https://matthewcassinelli.com/shortcuts/export-heart-rate-data/)）→ POST 到 Orca（覆盖常见类别，够用但类别有限）
- 折腾向：[Heartbridge](https://github.com/mm/heartbridge)（快捷指令 + Python 导出 CSV）

### 文件 📁
- 快捷指令"存储到文件"→ iCloud Drive → iCloud for Windows 同步 → 文件夹监听（通道③）

### 任意数据 🔌
- 任何快捷指令"获取 URL 内容"→ `POST /info/records`（通道②）

---

## 6. Orca 侧待办（排期）

| # | 事项 | 归属 | 状态 |
|---|------|------|------|
| 1 | 飞书插件扩展：收 image/file 消息并下载媒体 | 食物闭环 | **本轮（2026-08-25）** |
| 2 | Qwen 视觉客户端（vision.ts）+ food agent（识别→food-log 档案） | 食物闭环 | **本轮** |
| 3 | `/info/records` Push 端点 + Bearer 鉴权 | 健康/通用 | 下一轮 |
| 4 | 健康数据接收（Health Auto Export 拉取器 或 /info/records） | 健康 | 待排 |
| 5 | 第二个飞书 bot 的 app_id 路由（食物 agent 独立账号） | 食物 | 待用户开账号后 |

---

## 7. 与框架的关系

- 手机 = 框架里的"外部源"（D-AGENT-05 执行后端 / D-AGENT-08 Push 模式），不是一个 InfoAgent
- 每个数据类别一个 namespace（food-agent / health-agent / files-agent），Orca 跨 namespace 检索（R0）
- 照片/健康 = L1 私有数据：不落明文日志、可 ttl/一键清空（D-AGENT-12）
- 快捷指令上报通道与 /info/records 共用同一鉴权与信封模型

---

## 8. 来源索引

- 飞书图片接口：[open.feishu.cn 文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/create.md)
- 文件互传/Phone Link：[pocket-lint](https://www.pocket-lint.com/share-files-between-iphone-and-pc-via-phone-link/)
- Health Auto Export：[App Store](https://apps.apple.com/ba/app/health-auto-export-json-csv/id1115567069) / [导出文档](https://github.com/Lybron/health-auto-export)
- 快捷指令健康数据：[matthewcassinelli](https://matthewcassinelli.com/shortcuts/export-heart-rate-data/) / [Heartbridge](https://github.com/mm/heartbridge)
- WDA MCP（远期）：[LobeHub](https://lobehub.com/zh/mcp/qizhan7-wda-mcp) / [Lakr233/iphone-mcp](https://github.com/Lakr233/iphone-mcp)
- iPhone 镜像 MCP（macOS 专属）：[iphone-use](https://github.com/leeguooooo/iphone-use)
- 多媒体下载参考：[nanobot](https://github.com/HKUDS/nanobot/commit/98ef57e3704860c54b86f6e8ae0d742c646883aa)

---

*调研基于公开资料（2026-08-25），未实测。落地以 app-cordis 实现为准。*
