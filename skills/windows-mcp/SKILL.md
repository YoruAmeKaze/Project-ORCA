---
name: windows-desktop
description: 在用户明确请求时读取 Windows 桌面状态；首期只读截图和界面信息，不执行点击、输入或系统命令。
---

# Windows-MCP 接入规格（Orca）

> 状态：Orca 侧只读适配器已实现，默认关闭；是否在线取决于本机 Windows-MCP endpoint/token 配置。上游项目：[CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP)。

## 目的与运行边界

- Windows-MCP 是运行在 **Windows 7–11 桌面会话**中的 MCP server，依赖 Windows UI Automation / 桌面接口；它不是 Linux 系统能力。
- Orca 位于 Linux VM 时，拓扑为 `Orca (Linux VM MCP client) → 受保护网络/VPN → Windows-MCP (Windows 主机交互桌面)`。Windows 主机必须有用户登录的交互式桌面；锁屏、注销、RDP 切换、休眠等状态可能导致调用不可用或结果变化。
- 首期仅为 Orca 提供 Windows 桌面观察；不修改 WorldState，不自动触发 Attention/Cognition，不把截图或桌面内容写入 LongMemory/InfoStore。
- 如 Codex 需要直接使用，应在 Codex 自身 MCP 配置中独立连接；不经 Orca 代理，也不共享 Orca 凭证。Codex 当前是否可调用取决于客户端配置和当前会话暴露的工具。

## 连接与凭证

- 首选 Streamable HTTP；在服务所在 Windows 上运行，版本固定，不使用自动漂移的 latest 作为生产版本。上游要求 Python 3.13+。
- 若 Linux VM 远程连接，服务不得裸露公网。优先绑定专用 VPN/私网接口；若只能绑定所有接口，必须同时配置 TLS、Bearer 认证、IP allowlist 与主机防火墙，仅允许 Orca VM 来源。禁止无鉴权 HTTP。
- MCP endpoint、token、TLS 配置从 Windows 服务私密配置 / Orca 本机 secret 配置注入，不进入聊天、日志、Memory、仓库或 ActionResult。
- 上游匿名遥测默认启用；Orca 部署默认显式关闭（`ANONYMIZED_TELEMETRY=false`），是否开启由用户另行决定。
- 运行时显示连接状态、服务版本和工具 allowlist；断连或认证失败时只禁用 Windows Action，不影响 Orca 启动和其他消息处理。

## 工具 allowlist 与分类

服务器端用 Windows-MCP 的 `--tools` 显式 allowlist；Orca 客户端再维护独立静态 allowlist。两层都必须通过，禁止把 `tools/list` 结果直接全部暴露给模型，也禁止任意 MCP server/tool 转发。

首期仅允许以下观察工具（以部署版本的官方实时 schema 核验为准）：

| Orca Action | 分类 | 上游工具 | 用途 / 限制 |
|---|---|---|---|
| `windows.desktop.screenshot` | 基础操控 / 屏幕 / 获取屏幕信息 | `Screenshot` | 视觉观察；支持区域/显示器筛选；图片仅用于本次请求，不持久化 |
| `windows.desktop.snapshot` | 基础操控 / 屏幕 / 获取界面结构 | `Snapshot` | 获取 UIA / DOM 快照；限制节点数与输出长度；不得自动抓取无关页面 |
| `windows.desktop.display_inventory` | 基础操控 / 屏幕 / 查询显示器布局 | `DisplayInventory` | 屏幕数量、布局和 DPI 等元信息 |
| `windows.desktop.control_status` | 基础操控 / 桌面 / 查询控制状态 | `ControlStatus` | 检查 AI/用户控制状态；仅状态信息 |

模型只看到固定 Orca Action id、中文说明和参数 schema；不能传入任意上游工具名。工具缺失、schema 变化、工具被标记为非只读、返回结构未知时 fail closed，停止该 Action 并记录非敏感错误。

## 明确禁用项

首期不得允许：`PowerShell`、`FileSystem`（包括只读，避免无意读取隐私文件）、`Registry`、`Process`、`App`、`Notification`、`Scrape`，以及所有鼠标/键盘输入工具（`Click`、`Type`、`Scroll`、`Move`、`Shortcut`、`MultiSelect`、`MultiEdit` 等）。不得通过其他工具绕过上述禁用。

后续如真实需求要启用桌面交互，另行设计交互 Action 和任务级授权：用户明确指定目标、范围和动作；破坏性/外发/支付等最后一步再次逐次确认；超时、用户接管或焦点变化立即终止后续步骤。Windows-MCP 的 user takeover 是 best-effort 控制提示，**不是安全边界或 sandbox**。

## Orca 执行路径

```text
用户请求
  → Cognition 选择固定 windows.desktop.* Action
  → Windows-MCP ActionHandler（参数校验 + client allowlist）
  → Windows MCP adapter（固定 endpoint / 固定上游工具）
  → ActionResult 回原会话
```

- 每个注册 Action 是单一原子查询，直接复用 `ActionExecutor → ActionHandler → ActionResult`；不新增通用 MCP Manager、CapabilityManager、Windows automation framework 或任意工具桥。
- Windows MCP adapter 必须能正确处理 Streamable HTTP 会话、超时、MCP error 与图像/文本混合 content。图片不能当普通文本解析；不得写入长期存储。
- 查询只在用户请求或明确认知任务中发生，不做后台轮询/截图监控。ActionResult 是 execution metadata，不回灌 WorldState；若未来真实需求要把桌面状态作为观察事件，须另立设计。
- 对只读快照可在网络级错误时有限重试；不得重试不确定的输入/控制类副作用。首期没有任何控制类调用。

## 验收标准

- MCP server 关闭、未登录桌面、网络不可达、token 错误时 Orca 正常启动；对应 Action 明确不可用。
- server 与 client allowlist 双重生效；未列入的工具即使出现在 `tools/list` 也不能调用。
- Snapshot/Screenshot 的图片与文本响应均正确解析、限量返回、不落 Memory/InfoStore，不泄漏认证头和桌面敏感数据到日志。
- schema 改变、未知返回、超时和 MCP error 均可测试并 fail closed；零 shell、文件、注册表、进程和输入类工具调用。
- 构建、Action smoke、MCP mock 测试通过后，才在 Windows 主机用户授权下做只读 live 验证；Live 阶段仅验证截图、控制状态和显示器信息。

## 来源与核验

- [Windows-MCP README](https://github.com/CursorTouch/Windows-MCP)：平台、Python 版本、HTTP transport、工具与 `--tools` 选择、遥测和控制提示。
- [Windows-MCP Security Policy](https://github.com/CursorTouch/Windows-MCP/blob/main/SECURITY.md)：上游安全信息。
- 仓库信息核验日期：2026-10-08。上游工具 schema 可能变化，实施时须固定版本并重新核验。
