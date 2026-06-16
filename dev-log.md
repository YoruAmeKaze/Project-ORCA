# Project Orca — 开发日志

## v1.0.0（2026-06）

### 概述

Project Orca 是一个本地部署的 AI 工作区搭档。通过飞书聊天，Orca 可以理解你的指令、操作你的电脑桌面、陪你闲聊。

```
飞书发消息 → SSH 隧道 → 本地 FastAPI
                    → 截图 → AI 理解 → 执行操作 / 聊天回复
                    → 通过飞书 API 回复
```

---

### 已实现的功能

#### 消息通道
- 飞书 Bot 接入，事件订阅接收消息（`im.message.receive_v1`）
- 飞书 API 发送文本消息和图片
- Token 自动刷新（2 小时有效期）
- 事件去重（按 event_id 滑动窗口）
- 公网接入通过 SSH 反向隧道（服务器 47.76.188.165 转发到本地）

#### 视觉理解
- 截图模块：pyautogui 截取当前桌面（支持 2560x1600）
- 双通道理解管线：
  - 优先尝试本地 Ollama qwen2.5vl:3b（视觉模型，支持截图分析）
  - 超时 15 秒后自动切换到 DeepSeek Flash（云端，纯文本）
  - 判断用户意图并输出结构化指令（click / type / scroll / screenshot / none）

#### 桌面操作
- 鼠标操作：click / double_click / right_click / move
- 键盘输入：type（带间隔防吞字）
- 滚动：scroll
- 坐标校验：防止点击到屏幕外
- FailSafe 保护：鼠标移到角落自动取消操作

#### 聊天功能
- 闲聊时用 Orca 人设生成自然回复
- 支持上下文（最近 4 轮对话）
- 人设：技术宅室友感，话不多但不冷漠

#### 运营工具
- 一键启动脚本（start.bat）：自动检查依赖、建立 SSH 隧道、启动服务
- 开发日志（本文件）
- 待办事项（TODO.md）

---

### 技术栈

| 模块 | 选型 |
|------|------|
| Web 框架 | FastAPI + Uvicorn |
| IM 平台 | 飞书开放平台（事件订阅 + API） |
| 视觉模型 | Ollama qwen2.5vl:3b |
| 云端兜底 | DeepSeek Flash API |
| 截图 | pyautogui |
| 公网隧道 | SSH 反向代理 |
| 配置管理 | python-dotenv + .env |

---

### 项目结构

```
Project_ORCA/
├── .env.example          # 配置模板
├── .gitignore            # Git 忽略规则
├── requirements.txt      # Python 依赖
├── start.bat             # 一键启动脚本（本地）
├── start.bat.example     # 启动脚本模板（开源用）
├── dev-log.md            # 本文件
├── TODO.md               # 待办事项
├── project-orca-overview.md  # 项目概览文档
└── src/
    ├── main.py           # FastAPI 入口
    ├── config.py         # 环境变量配置
    ├── router/
    │   └── feishu.py     # 飞书 webhook 路由
    ├── core/
    │   ├── orchestrator.py  # 核心调度器
    │   ├── chat.py       # 闲聊回复生成器
    │   ├── history.py    # 对话上下文管理
    │   └── persona.py    # Orca 人设 prompt
    ├── feishu/
    │   └── client.py     # 飞书 API 客户端
    ├── vision/
    │   ├── screenshot.py # 桌面截图
    │   └── interpreter.py # 视觉理解 + 指令解析
    └── action/
        ├── executor.py   # 桌面操作执行
        └── validator.py  # 操作校验
```

---

### 配置方式

复制 `.env.example` 为 `.env`，填写：

```env
DEEPSEEK_API_KEY=sk-xxx          # DeepSeek API Key
FEISHU_APP_ID=cli_xxx             # 飞书应用 App ID
FEISHU_APP_SECRET=xxx             # 飞书应用 Secret
```

如需公网访问，配置 `start.bat` 中的服务器地址和 SSH 密钥路径。

---

### 已知问题

- Ollama 视觉模型在部分笔记本上默认走集显（CPU），推理较慢；开独显模式或设置 `OLLAMA_LLM_LIBRARY=cuda_v13` 环境变量可启用 GPU
- 无长期记忆（规划中）
- 无主动提醒功能（规划中）
