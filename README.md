# Project Orca

通过飞书聊天的本地 AI 桌面助手。发消息给 Orca，它帮你操作电脑。

## 功能

- **桌面控制** — "帮我点一下浏览器"、"输入 hello"
- **截图查看** — "发一下截图"、"看看桌面"、"找到浏览器地址栏"
- **联网搜索** — "查一下今天天气"
- **闲聊** — 室友感，话不多但不冷漠

## 架构

### 当前（ReAct 循环）

```
用户消息 → DeepSeek 分析意图
            ├── 需要看图 → 截图 → Qwen3.7-Plus 视觉分析 → 执行操作
            ├── 打字指令 → 直接执行
            └── 闲聊/问题 → 直接回复
```

### 开发中（Plan-then-Execute）

```
用户消息 → Planner(LLM) → DSL → Validator → Runtime → Skill 执行 → 回复
```

详情见 `guide/` 目录下的架构设计文档。

## 快速开始

### 1. 配置

复制 `.env.example` 为 `.env`，填写：

```env
DEEPSEEK_API_KEY=sk-xxx           # DeepSeek API Key（意图分析、聊天）
QWEN_API_KEY=sk-xxx               # 阿里云百炼 Qwen API Key（视觉分析）
FEISHU_APP_ID=cli_xxx              # 飞书应用 App ID
FEISHU_APP_SECRET=xxx              # 飞书应用 Secret
```

### 2. 安装依赖

```bash
pip install -r requirements.txt
```

### 3. 启动

```bash
python -m src.main
```

服务运行在 `http://127.0.0.1:8000`

Windows 下也可以用 `start.bat` 一键启动（含 SSH 隧道）。

### 4. 配置飞书

在[飞书开放平台](https://open.feishu.cn)创建应用 → 开启机器人能力 → 配置事件订阅请求 URL 为 `http://你的公网地址:8000/feishu/webhook` → 订阅 `im.message.receive_v1` 事件 → 发布。

## 切换新架构

本地测试新架构（DSL + Skill Registry + Runtime）：

```bash
USE_NEW_ARCH=true python -m src.main
```

线上稳定运行走旧 ReAct 流程（默认）。

## 项目结构

```
src/
├── main.py              # FastAPI 入口
├── config.py            # 配置管理
├── router/
│   └── feishu.py        # 飞书 webhook 路由
├── core/
│   ├── orchestrator.py  # 核心调度器（新旧架构路由）
│   ├── planner.py       # ★ 新：LLM 出 DSL 计划
│   ├── agent.py         # 旧：ReAct 循环
│   ├── chat.py          # 旧：闲聊回复
│   ├── search.py        # 联网搜索
│   ├── history.py       # 对话上下文管理
│   └── persona.py       # Orca 人设 prompt
├── dsl/                 # ★ 新：DSL 数据模型 + 校验
│   ├── schema.py
│   └── validator.py
├── skill/               # ★ 新：Skill Registry
│   ├── registry.py
│   ├── builtins.py
│   └── handlers/
├── runtime/             # ★ 新：DSL 执行引擎
│   ├── context.py
│   └── engine.py
├── feishu/
│   └── client.py        # 飞书 API 客户端
├── vision/
│   ├── screenshot.py    # 桌面截图
│   └── interpreter.py   # Qwen 视觉分析
├── tasks/
│   └── luckin.py        # 瑞幸 CLI 封装（WIP）
└── action/
    ├── executor.py      # 桌面操作执行
    └── validator.py     # 操作校验
```

## 技术栈

| 模块 | 选型 |
|------|------|
| Web 框架 | FastAPI + Uvicorn |
| IM 平台 | 飞书开放平台 |
| 意图分析 | DeepSeek Flash |
| 视觉分析 | Qwen3.7-Plus |
| 截图 | pyautogui |
| 联网搜索 | cn.bing.com |
| 架构模式 | ReAct（当前）/ Plan-then-Execute（开发中） |

## License

MIT
