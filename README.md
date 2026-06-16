# Project Orca

通过飞书聊天的本地 AI 桌面助手。发消息给 Orca，它帮你操作电脑。

## 功能

- **桌面控制** — "帮我点一下浏览器"、"打开记事本"、"输入 hello"
- **截图查看** — "发一下截图"、"看看桌面"
- **闲聊** — 室友感，话不多但不冷漠

## 快速开始

### 1. 配置

复制 `.env.example` 为 `.env`，填写：

```env
DEEPSEEK_API_KEY=sk-xxx           # DeepSeek API Key（必填）
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

### 4. 配置飞书

在[飞书开放平台](https://open.feishu.cn)创建应用 → 开启机器人能力 → 配置事件订阅请求 URL 为 `http://你的公网地址:8000/feishu/webhook` → 订阅 `im.message.receive_v1` 事件 → 发布。

### 5. 公网访问（可选）

仓库里的 `start.bat.example` 是启动脚本模板，复制为 `start.bat` 后填入服务器 IP 和 SSH 密钥路径，双击即可自动建立隧道并启动服务。

## 项目结构

```
src/
├── main.py              # FastAPI 入口
├── config.py            # 环境变量配置
├── router/feishu.py     # 飞书 webhook 路由
├── core/
│   ├── orchestrator.py  # 核心调度器
│   ├── chat.py          # 闲聊回复生成
│   ├── history.py       # 对话上下文
│   └── persona.py       # Orca 人设
├── feishu/client.py     # 飞书 API 客户端
├── vision/
│   ├── screenshot.py    # 桌面截图
│   └── interpreter.py   # 视觉理解 + 指令解析
└── action/
    ├── executor.py      # 桌面操作执行
    └── validator.py     # 操作校验
```

## 技术栈

FastAPI / 飞书开放平台 / DeepSeek Flash / Ollama / pyautogui

## License

MIT
