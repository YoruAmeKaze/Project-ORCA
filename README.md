# Project Orca

通过飞书聊天的本地 AI 桌面助手。发消息给 Orca，它帮你操作电脑。

## 功能

- **桌面控制** — "帮我点一下浏览器"、"输入 hello"
- **截图查看** — "发一下截图"、"看看桌面"
- **联网搜索** — "查一下今天天气"
- **闲聊** — 室友感，话不多但不冷漠

## 工作流程

```
用户消息 → DeepSeek 分析意图
            ├── 需要看图（点击/截图/滚动）
            │       ↓
            │   截图 → Qwen3.7-Plus 视觉分析 → 执行操作
            ├── 打字指令 → 直接执行
            └── 闲聊/问题 → 直接回复
```

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

### 4. 配置飞书

在[飞书开放平台](https://open.feishu.cn)创建应用 → 开启机器人能力 → 配置事件订阅请求 URL 为 `http://你的公网地址:8000/feishu/webhook` → 订阅 `im.message.receive_v1` 事件 → 发布。

## 技术栈

| 模块 | 选型 |
|------|------|
| Web 框架 | FastAPI + Uvicorn |
| IM 平台 | 飞书开放平台 |
| 意图分析 | DeepSeek Flash |
| 视觉分析 | Qwen3.7-Plus |
| 截图 | pyautogui |
| 联网搜索 | cn.bing.com |

## License

MIT
