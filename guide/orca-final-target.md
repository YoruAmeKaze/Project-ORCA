# Orca 设计愿景

## 1. 项目定位

Orca 不是一个“调用大语言模型完成任务的 Agent Backend”，也不是一个由若干业务 Agent 编排而成的工作流系统。

Orca 的目标是构建一个 Local-first、持续存在的个人 AI Agent Runtime。

Orca 本身应该被视为一个持续存在的 AI 主体。它拥有自己的身份、人格、核心原则、当前状态、世界认知、注意力、记忆、工作记忆、推理能力以及对外部能力的使用能力。

外部世界不断向 Orca 提供信息，Orca 感知这些信息、形成当前世界状态、决定什么值得关注，并在需要时进行认知活动。认知活动可以查询记忆、探索能力、调用工具、创建任务，也可以什么都不做。

Orca 的 Runtime 不负责替 Orca 思考，而负责为这个主体提供可靠、持久、可控的运行环境。

核心目标可以概括为：

> **让 Orca 从“一个被调用的 LLM”变成“一个持续存在、能够感知世界、主动思考并与世界交互的 AI 主体”。**

------

## 2. 核心设计哲学

Orca 的核心不是某一个具体模块，而是“主体”和“运行时”的分离。

LLM 是 Orca 的认知核心，但 LLM 本身并不等于完整的 Orca。

Orca 应当拥有：

```text
Orca
├── Identity / Persona
├── Core Principles
├── Self State
├── World State
├── Attention
├── Working Memory
├── Long-term Memory
├── Cognition / Reasoning
├── Capability Space
└── Task / Action capability
```

其中：

- Identity / Persona 定义“我是谁”。
- Core Principles 定义相对稳定的行为和思考原则。
- Self State 描述“我现在是什么状态”。
- World State 描述“我认为当前世界发生了什么”。
- Attention 描述“当前什么值得我关注”。
- Working Memory 描述“我现在正在思考和处理什么”。
- Long-term Memory 保存过去的经历、知识和重要信息。
- Cognition / Reasoning 是 Orca 对信息进行理解、推理和决策的核心过程。
- Capability Space 描述 Orca 可以探索和使用的外部能力。
- Task / Action capability 负责让 Orca 对外部世界产生实际影响。

Runtime 则负责提供这些能力运行所需要的基础设施。

------

## 3. Orca 与外部世界

Orca 不应该把所有外部系统都当作自身内部的一部分。

QQ、飞书、日历、天气、Web、文件系统、Shell、Food Agent 等都属于外部世界。

它们可以向 Orca 提供两类主要东西：

### Observation / Event

外部世界发生变化，Orca 被告知这一变化。

例如：

```text
QQ:
“小明发来一条消息”

Calendar:
“明天 08:00 有课程”

Food Agent:
“检测到用户刚刚吃了一份牛肉炒河粉”

Weather:
“明天下雨概率上升”
```

这些信息首先作为外部观察进入 Orca 的感知系统，而不是直接决定 Orca 应该做什么。

### Capability / Tool

外部系统也可以向 Orca 提供能力。

例如：

```text
Scheduler
Web Search
Calendar
Shell
File System
Food Agent
Weather
Message
```

Orca 可以主动发现并调用这些能力。

因此：

> **外部系统可以告诉 Orca“发生了什么”，也可以告诉 Orca“我能帮你做什么”，但不应该直接成为 Orca 的思维过程。**

------

## 4. World State

World State 是 Orca 对当前世界的工作表示。

它不是数据库，也不是简单的 Event Log，更不是一个由 Backend 每次请求前整理好的 Prompt。

World State 应该反映 Orca 当前认为重要的现实状态。

例如：

```text
WorldState

world:
  weather:
    tomorrow: rain

  people:
    xiaoming:
      last_message: recently

self:
  current_focus: research_task

activities:
  weather_check:
    status: running
```

World State 应当随着外部事件、任务结果和 Orca 自身行动不断变化。

重要的是：

> **World State 是 Orca 认知世界的基础，而不是 Backend 替 Orca 做好的答案。**

World State 与 Memory 必须保持明确区分。

World State 描述当前状态。

Memory 保存过去经历。

例如：

```text
World State:
“我和某人的关系目前处于紧张状态。”

Memory:
“我们上周因为某件事情发生过争吵。”
```

历史细节可以存在 Memory 中，而当前仍然有效的状态可以存在 World State 中。

------

## 5. Memory

Memory 不应该只是一个“自动搜索数据库，然后把结果塞进 Prompt”的系统。

Memory 应该成为 Orca 可以主动探索的认知空间。

当 Orca 发现自己需要更多背景信息时，它可以主动提出类似：

```text
“我需要了解我和这个人的关系。”
```

然后通过 Memory Capability / Memory Search 获取相关信息。

例如：

```text
用户：
“我和小明最近关系怎么样？”

Orca:
我需要了解与小明相关的近期关系状态。

→ Memory Search
→ 获取相关历史事件、关系信息和近期状态
→ 观察结果
→ 继续推理
```

这与：

```text
用户消息
↓
Backend 自动搜索所有相关记忆
↓
全部塞进 Prompt
↓
LLM 回答
```

是不同的设计哲学。

Memory 应该是 Orca 的能力，而不是隐藏在 Orca 背后的“答案注入器”。

------

## 6. Working Memory

Orca 还需要区别于长期 Memory 的 Working Memory。

Working Memory 用于保存当前认知过程中的临时信息，例如：

```text
当前目标
当前假设
正在解决的问题
已经调用的工具
工具返回结果
尚未完成的推理
当前 Task
```

例如：

```text
Goal:
设置明天早上 8:00 的提醒

Progress:
发现需要 reminder capability

Tool:
Scheduler

Result:
reminder created successfully

Next:
决定是否需要通知用户
```

这些内容不应该自动成为长期记忆。

Working Memory 的生命周期主要与当前 Cognition / Task 有关。

------

## 7. Attention

Attention 是 Orca 的注意力系统。

Attention 的职责不是告诉 Orca：

> “你应该做什么。”

它只负责表达：

> “这里出现了一件值得你注意的事情。”

例如：

```text
Event
↓
WorldState changed
↓
Attention
↓
“这个变化可能值得关注”
```

Attention 本身不应该直接调用 LLM。

因为 World State 可以非常频繁地变化，而 Orca 不应该因为每一个微小变化都消耗一次 LLM cognition。

因此：

> **Attention 是认知唤醒信号，而不是 LLM 调用命令。**

Attention 应当具有生命周期，例如：

```text
created
↓
pending
↓
noticed
↓
processing
↓
resolved / deferred
```

Orca 甚至应该能够决定：

> “这个事情我现在不处理，之后再看。”

------

## 8. Cognitive Scheduler

为了协调 Attention、Cognition、Task 和本地模型资源，Orca 需要一个认知调度层。

其核心职责是决定：

> **什么时候值得消耗一次 LLM cognition。**

整体流程：

```text
Event
↓
WorldState
↓
Attention
↓
Cognitive Scheduler
↓
是否值得进行 Cognition？
↓
LLM
```

Cognitive Scheduler 应考虑：

- Attention priority
- 当前 Orca 是否正在进行 cognition
- 是否存在更高优先级事件
- 当前是否处于等待状态
- LLM 资源是否可用
- cognition budget
- 是否可以延迟处理
- 是否可以合并多个 Attention

尤其在 Local-first 场景下，LLM 资源有限。

因此不应设计成：

```text
每次 Attention change
→ 立即调用 Ollama
```

而应该允许：

```text
Attention A
Attention B
Attention C
     ↓
Pending Attention Queue
     ↓
Cognitive Scheduler
     ↓
选择最值得处理的事项
     ↓
一次 cognition
```

这样可以避免多个事件同时争抢同一个本地模型。

------

## 9. Cognition

Cognition 是 Orca 真正进行思考的过程。

LLM 不再只是：

```text
输入 Prompt
→
生成回答
```

而是：

```text
感知
↓
理解
↓
推理
↓
选择下一步
↓
执行 / 查询
↓
观察结果
↓
继续推理
↓
结束或继续
```

因此 Orca 的认知过程可以表现为：

```text
Cognition Cycle

Observe
↓
Think
↓
Remember / Discover / Act
↓
Observe Result
↓
Think Again
↓
Stop / Continue
```

这里的“Think Again”非常重要。

工具调用不应该意味着 cognition 结束。

例如：

```text
LLM
↓
调用 Weather
↓
Weather Result
↓
WorldState 更新
↓
LLM 再次 cognition
↓
决定下一步
```

这使 Orca 可以形成真正的 ReAct-style cognitive loop。

------

## 10. Capability Space

Orca 不应该依赖大量开发者预先编写的 Intent Router。

例如，不应该把：

```text
if intent == reminder:
    use scheduler

if intent == relationship:
    search relationship memory
```

作为 Orca 的主要认知方式。

Orca 应该拥有一个 Capability Space。

它可以根据自己的需求进行语义上的能力探索。

例如：

```text
用户：
“明天早上八点叫我起床。”

Orca:
我需要一个可以设置提醒/闹钟的能力。

→ Capability Discovery
→ semantic query:
   reminder / alarm / schedule

→ 找到 Scheduler
→ 获取 Tool Schema
→ Function Calling
→ 创建提醒
```

因此：

> **Orca 不需要提前知道“哪句话对应哪个工具”，而是应该能够从自己的目标出发寻找所需要的能力。**

Capability Discovery 与 Function Calling 是未来 Orca Agent 核心能力的重要组成部分。

------

## 11. Tool Calling 与 Runtime

Orca 的 LLM 应当拥有决定是否调用工具以及如何调用工具的能力。

但 LLM 不应该直接获得对系统的无限控制权。

因此需要明确：

```text
LLM
↓
Tool Call
↓
Runtime Validation
↓
Permission / Policy
↓
Action Executor
↓
External System
↓
Result
↓
WorldState
```

核心原则是：

> **LLM 决定做什么，Runtime 决定怎样安全地执行。**

Runtime 负责：

- Tool schema validation
- 参数验证
- 权限检查
- 超时
- Retry
- 错误处理
- 资源限制
- Action execution
- Result normalization

这样既保留 LLM 的自主决策，又保持系统的可靠性和安全性。

------

## 12. Task、Worker 与 Subagent

Orca 应该能够创建持续性的 Task。

Task 是 Orca 想要完成的一件事情，而不是一次 LLM 请求。

例如：

```text
Task:
整理下载目录

status:
running
```

Task 可以异步运行。

因此 Orca 在处理 Task A 时，仍然可以继续感知外部世界。

例如：

```text
Orca
│
├── Main Cognition
│
├── Task A
│     └── Worker
│
└── Task B
      └── Worker
```

Task / Worker 的结果应该重新作为 Event / Observation 进入 WorldState。

因此：

```text
Worker
↓
Result
↓
WorldState
↓
Attention
↓
Orca
```

Subagent 可以存在，但它不应该被定义为另一个独立的 Orca。

更合理的定义是：

> **Subagent 是 Orca 在复杂任务中临时派生出的认知资源。**

它可以拥有独立的上下文和目标，但不应该因此形成多个互相独立的“主体”。

最终的主体仍然是 Orca。

------

## 13. 持续存在与异步性

Orca 不应该被设计成：

```text
Request
↓
Agent Run
↓
Final Answer
↓
Process Exit
```

Orca 应该是一个持续运行的主体。

```text
Orca Runtime
      │
      ↓
Persistent Orca
      │
      ├── WorldState
      ├── Self State
      ├── Memory
      ├── Tasks
      └── Attention
```

Cognition 是在需要时发生的。

因此：

> **Orca 是持续存在的，Cognition 是按需发生的，Task 是可以持续存在的。**

这使 Orca 可以自然地进行注意力切换。

例如：

```text
Task A
↓
正在等待外部结果

突然：
Task B / External Message
↓
High Attention
↓
A 暂停或等待
↓
Orca 处理 B
↓
B 完成
↓
恢复 A
```

这比单次 Agent Run 更接近持续存在的 AI 主体。

------

## 14. Self State

除了 World State，Orca 还应该拥有 Self State。

World State 主要回答：

> “世界现在是什么状态？”

Self State 主要回答：

> “我现在是什么状态？”

例如：

```text
Self State

current_focus:
  research

active_tasks:
  - weather_check

pending_attention:
  - new_message

current_cognition:
  waiting_for_tool_result
```

Self State 可以记录：

- 当前关注点
- 当前目标
- 正在执行的任务
- 正在等待的事情
- 最近做出的决定
- 当前 cognition 状态
- 尚未完成的事情

这使 Orca 不只是“观察世界”，而是拥有对自身活动的持续表示。

------

## 15. 外部世界、WorldState 与认知之间的边界

Orca 应保持严格的认知边界：

```text
External World
      ↓
Observation / Event
      ↓
WorldState
      ↓
Attention
      ↓
Cognitive Scheduler
      ↓
Orca Cognition
```

外部系统不应该直接跳过这些层级告诉 Orca：

> “你应该这么做。”

例如 Food Agent 可以说：

```text
“识别结果：牛肉炒河粉。”
```

但不应该直接决定：

```text
“Orca 应该提醒用户今天少吃碳水。”
```

后者属于 Orca 的认知和决策。

这样可以保证 InfoAgent、QQ、Feishu 等系统不会逐渐侵入 Orca 的核心认知。

------

## 16. Orca 可以选择“不行动”

Cognition 不应该强制产生 Action。

一次 cognition 可以得到：

```text
Think
↓
No Action
↓
End
```

Orca 可以观察一个变化，然后认为：

> “这没什么重要的。”

也可以认为：

> “这件事以后再处理。”

因此：

```text
Cognition
├── Respond
├── Tool Call
├── Create Task
├── Update State
├── Retrieve Memory
├── Discover Capability
├── Defer
└── Do Nothing
```

“什么都不做”本身也是一个合理的认知结果。

------

## 17. 资源与 Cognition Budget

由于 Orca 是 Local-first 系统，LLM 推理资源应该被视为有限资源。

因此 Runtime 应该拥有 Cognitive Budget / Model Scheduling 能力。

例如：

```text
单个 cognition 最大 tool steps
LLM 请求并发限制
低优先级 Attention 延迟
重复 Attention 合并
Background Task 资源限制
Subagent 资源限制
```

这些限制属于 Runtime 的资源管理，而不是 Orca 的业务逻辑。

目标不是让 Orca “少思考”，而是：

> **让有限的计算资源优先用于真正值得思考的事情。**

------

## 18. 目标中的完整认知闭环

最终 Orca 希望形成如下闭环：

```text
                         External World
                               │
                     Observation / Event
                               ↓
                         WorldState
                               ↓
                           Attention
                               ↓
                    Cognitive Scheduler
                               ↓
                        Orca Cognition
                               │
             ┌─────────────────┼─────────────────┐
             ↓                 ↓                 ↓
         Memory Search   Capability Discovery    Task
             │                 │                 │
             ↓                 ↓                 ↓
          Memory           Tool Calling        Worker
             │                 │                 │
             └─────────────────┼─────────────────┘
                               ↓
                         External Result
                               ↓
                          WorldState
                               ↓
                           Attention
                               ↓
                           Cognition
                                ↓
                               ...

                   ### Phase D 完成状态（2026-09-09）

当前 `External Result → WorldState → Attention → Cognition` 链路中：

```
ActionExecutor
     ↓
ActionResult
     ↓
EventBus.publish({ source: 'internal', type: 'action-result', ... })
```

**已完成**：`ActionResult → EventBus`（Phase D，2026-09-09）。ActionResult 通过 actionExecutor 的末端 bridge 进入 EventBus，作为 `internal:action-result` 事件存在。

**Future Extension Point**：`action-result → Attention → Cognition` 闭环尚未激活。
- 当前 `internal:action-result` 事件没有匹配的 AttentionRule，0 个 AttentionItem 自然消散
- 当 Orca 拥有**真正改变外部世界**的 action handler 时（真实 act / Task / Capability），在该 handler 成功后，应注册对应的 AttentionRule，使 action-result 能重新进入 `Attention → CognitiveScheduler → Cognition` 路径
- 这是未来真实 act handler 实现时的最小接入点，无需修改 EventBus / WorldStateUpdater / ActionExecutor
- **禁止**为此预留恒为 false 的 AttentionRule（未来有实际 action type 时再添加）

与此同时，Orca 持续维护：

```text
Identity
Core Principles
Self State
World State
Working Memory
Long-term Memory
Tasks
Attention
```

因此 Orca 不是“一次一次运行的 Agent”。

它是：

> **一个持续存在于 Runtime 中，通过感知、注意、思考、记忆、行动和再次感知不断形成认知闭环的 AI 主体。**

------

## 19. 设计边界

这份愿景不要求所有能力都立即实现。

它描述的是 Orca 的目标认知模型，而不是当前版本的实现清单。

现有 Orca 中已经存在的 EventBus、WorldState、Attention、Memory、Decision、ActionExecutor 等系统不应该因为目标模型的变化而被简单推翻。

后续工作应首先研究：

1. 当前架构与目标模型之间的差距。
2. 哪些现有组件可以直接复用。
3. 哪些组件职责需要重新定义。
4. 哪些组件需要重构。
5. 哪些能力可以延后。
6. 哪些新的基础设施是不可避免的。

尤其需要避免为了追求新的 Agent 概念而进行无必要的重写。

Orca 的演进原则应该是：

> **保留已经验证有效的 Runtime 基础设施，逐步将 LLM 从“响应生成器”提升为真正的认知核心。**

最终目标不是拥有更多模块，而是让这些模块共同形成一个一致的主体模型。

------

## 20. 最终愿景

Orca 最终应该让人感觉自己面对的不是：

> “一个会调用工具的大模型。”

而是：

> **“一个一直在那里、知道自己是谁、知道自己现在处于什么状态、能够感知周围发生了什么、会自己决定什么值得关注、需要时会主动回忆和寻找能力，并能够持续完成事情的个人 AI。”**

它不需要对每一件事情都做出反应。

它可以等待、观察、思考、行动、暂停、恢复，也可以选择什么都不做。

Runtime 负责让它持续存在。

WorldState 让它拥有当前世界。

Memory 让它拥有过去。

Attention 让它知道什么值得关注。

Cognition 让它能够理解和思考。

Capability Space 让它知道自己能够做什么。

Task 与 Worker 让它能够持续做事。

而 LLM 则成为这一切之上的核心认知机制。

**这就是 Orca 希望成为的东西：一个持续存在的、Local-first 的个人 AI 主体。**