import { Context, Logger, type Exporter } from '@deepseek-ai/cordis'
import './context.js'
import { getConfig, loadOrcaEnv } from './config.js'
import { FeishuClient } from './services/feishu.js'
import { LlmClient } from './services/llm.js'
import { VisionClient } from './services/vision.js'
import { JsonlSessionStore } from './services/sessionStore.js'
import { feishuChannel } from './plugins/feishu-channel.js'
import { agent } from './plugins/agent.js'
import { infoAgents } from './plugins/info-agents.js'
import { infoReceiver } from './plugins/info-receiver.js'
import { imageRouter } from './plugins/image-router.js'
import { dashboard } from './plugins/dashboard.js'
import { orcaRuntime } from './plugins/orca-runtime.js'
import { worldStateUpdater } from './plugins/world-state-updater.js'
import { attentionEngine } from './plugins/attention-engine.js'
import { decisionEngine } from './plugins/decision-engine.js'
import { cognitiveSchedulerPlugin } from './plugins/cognitive-scheduler-plugin.js'
import { cognitionCorePlugin } from './plugins/cognition-core-plugin.js'
import { cognitionOutputPlugin } from './plugins/cognition-output-plugin.js'
import { actionExecutor } from './plugins/action-executor.js'
import { deferredScheduler } from './plugins/deferred-scheduler.js'
import { pcAdapter } from './plugins/input-adapters/pc-adapter.js'
import { calendarAdapter } from './plugins/input-adapters/calendar-adapter.js'
import { phoneAdapter } from './plugins/input-adapters/phone-adapter.js'
import { schedulerAdapter } from './plugins/input-adapters/scheduler-adapter.js'
import { imAdapter } from './plugins/input-adapters/im-adapter.js'
import { imObservationAdapter } from './plugins/im-observation-adapter.js'
import { scheduledRuleRegistry } from './plugins/scheduled-rule-registry.js'
import { createScheduledRulesFromConfig } from './rules/scheduled/factory.js'
import { createMemoryStore } from './services/memoryStore.js'
import { episodeEnginePlugin } from './plugins/episode-engine.js'
import { memoryAttentionAdapter } from './plugins/memory-attention-adapter.js'
import { reflectionEnginePlugin } from './plugins/reflection-engine.js'
import { contextAssemblerProvider } from './plugins/context-assembler-provider.js'

loadOrcaEnv()
const config = getConfig()

// 仅 dashscope/backend 模式强制要求 apiKey；ollama 模式免 key
if (config.llm.backend === 'dashscope' && !config.llm.apiKey) {
  console.error('[orca-cordis] 缺少 DEEPSEEK_API_KEY：请在仓库根 .env 或 app-cordis/.env 配置（dashscope 模式必需；ollama 模式请设 ORCA_LLM_BACKEND=ollama）')
  process.exit(1)
}

console.log(
  '[orca-cordis] LLM backend=%s model=%s baseUrl=%s%s%s',
  config.llm.backend,
  config.llm.model,
  config.llm.baseUrl,
  config.llm.backend === 'ollama' ? '（本地，Ollama OpenAI 兼容）' : '',
  config.llm.fallback && config.llm.fallback.apiKey
    ? ` [fallback: dashscope model=${config.llm.fallback.model}]`
    : '',
)

const ctx = new Context()

// 控制台日志 exporter（fork 版 LoggerService 默认只装内存缓冲 exporter，不打印到终端）
// 注意 fork 语义：exporter.levels 是导出阈值上限，level ≤ 阈值才导出（ERROR=0/INFO=1/WARN=2/DEBUG=3）。
// 用 default:2 放行 ERROR/INFO/WARN，隐藏 DEBUG；default:1 会把所有 WARN 静默丢弃（曾致 food-image 失败日志不可见）。
const logExporter: Exporter = {
  colors: 2,
  levels: { default: 2 },
  export(message) {
    console.log(`[${new Date(message.ts).toISOString()}] ${Logger.format(logExporter, message)}`)
  },
}
ctx.logger.exporter(logExporter)

// 服务层（Cordis Service 注册）
ctx.provide('feishu', new FeishuClient(config.feishu))
ctx.provide('llm', new LlmClient(config.llm))
ctx.provide('vision', new VisionClient(config.qwen))
ctx.provide('sessions', new JsonlSessionStore(config.historyTurns, config.sessionsDir))
// Phase 5.0：MemoryStore（LongMemory mutation authority；所有写必须经过此接口）
if (config.memory.enabled) {
  // Phase 5.4.B: 将 ctx.emit 绑定为 memory_changed 事件发射器
  ctx.provide('memory', createMemoryStore({
    ...config.memory,
    eventEmitter: (event) => ctx.emit('memory_changed', event),
  }))
  ctx.logger.info('[orca-cordis] MemoryStore 已启用（dataDir=%s）', config.memory.dataDir)
} else {
  ctx.logger.info('[orca-cordis] MemoryStore 未启用（ORCA_MEMORY_ENABLED=0 关闭）')
}

// 插件装配
ctx.plugin(feishuChannel, config)
ctx.plugin(infoAgents, config) // 信息获取框架（InfoAgent 注册表 + 档案室；内部 provide infoAgents/infoExecutor/infoStore）
ctx.plugin(infoReceiver, config) // 外部 App Push 通道（POST /info/records）

// Phase 6.A：ContextAssembler（CEO Context Assembly）
// 通过独立 plugin + inject[memory, infoStore] 依赖 Cordis DI 同步解析，
// 避免顶层 ctx.get('infoStore') 抢时机的异步问题（cordis v4 ctx.plugin() 是异步 Fiber 激活）
ctx.plugin(contextAssemblerProvider, config)

// Phase 7.1A：RuntimeAdapters 统一生命周期管理（GPT Review Phase 7.0）
// 在 if (runtime.enabled) 外部声明，以便在 shutdown handler 中引用
const runtimeAdapters: { stop(): void | Promise<void> }[] = []

ctx.plugin(imageRouter, config) // 图片事件路由层（D-AGENT-15：chat_id → agent 工位分配；food 管线由路由接收）
ctx.plugin(dashboard, config)    // Orca 仪表盘（状态监控 UI）
// Orca Persistent Context Runtime（默认关闭；ORCA_RUNTIME_ENABLED=1 启用，挂载在 agent 之前以便订阅 feishu 事件）
if (config.runtime.enabled) {
  ctx.plugin(orcaRuntime, config)
  ctx.logger.info('[orca-cordis] Persistent Context Runtime 已启用（Phase 0+1）')
  // Phase 2.A：WorldStateUpdater 必须在 orcaRuntime 之后（依赖 eventBus Service）
  if (config.runtime.worldState.enabled) {
    ctx.plugin(worldStateUpdater, config)
    ctx.logger.info('[orca-cordis] WorldState 已启用（Phase 2.A）')
  } else {
    ctx.logger.info('[orca-cordis] WorldState 未启用（ORCA_WORLD_STATE_ENABLED=0 关闭）')
  }
  // Phase 3：Attention Engine 必须在 WorldState 之后（依赖 worldState service）
  if (config.runtime.attention.enabled) {
    ctx.plugin(attentionEngine, config)
    ctx.logger.info('[orca-cordis] Attention Engine 已启用（Phase 3）')
    // Phase A：Cognitive Scheduler 在 Attention 之后（订阅 orca/attention，维护 pending 队列）
    ctx.plugin(cognitiveSchedulerPlugin, config)
    ctx.logger.info('[orca-cordis] Cognitive Scheduler 已启用（Phase A）')
    // Phase B：CognitionCore 在 Scheduler 之后（消费 orca/cognition-request）
    ctx.plugin(cognitionCorePlugin, config)
    ctx.logger.info('[orca-cordis] CognitionCore 已启用（Phase B）')
    // Phase C：Cognition Output 在 CognitionCore 之后（消费 orca/cognition-output，路由 text/reply → Feishu）
    ctx.plugin(cognitionOutputPlugin, config)
    ctx.logger.info('[orca-cordis] Cognition Output Handler 已启用（Phase C）')
    // Phase 4.A：Decision Engine 必须在 Attention 之后（订阅 orca/attention emit）
    if (config.runtime.decision.enabled) {
      ctx.plugin(decisionEngine, config)
      ctx.logger.info('[orca-cordis] Decision Engine 已启用（Phase 4.A）')
      // Phase 4.B：Action Executor 必须在 Decision 之后（订阅 orca/decision emit）
      if (config.runtime.action.enabled) {
        ctx.plugin(actionExecutor, config)
        ctx.logger.info('[orca-cordis] Action Executor 已启用（Phase 4.B）')
        // Phase 4.D：Deferred Scheduler 必须在 Action Executor 之后（依赖 ctx.actionExecutor.deferredStore）
        ctx.plugin(deferredScheduler, config)
        ctx.logger.info('[orca-cordis] Deferred Scheduler 已启用（Phase 4.D）')
      } else {
        ctx.logger.info('[orca-cordis] Action Executor 未启用（ORCA_ACTION_ENABLED=0 关闭；默认安全）')
      }
    } else {
      ctx.logger.info('[orca-cordis] Decision Engine 未启用（ORCA_DECISION_ENABLED=0 关闭）')
    }
  } else {
    ctx.logger.info('[orca-cordis] Attention Engine 未启用（ORCA_ATTENTION_ENABLED=0 关闭）')
  }

  // Phase 7.1A：RuntimeAdapters（GPT Review Phase 7.0）
  // 统一 { start(), stop() } 接口，统一生命周期管理
  // 所有事件通过 EventBus → WorldStateUpdater 路径

  // Scheduler adapter（emit scheduler:tick/briefing:due/reflection:due/reminder:due）
  const schedulerRuntimeAdapter = schedulerAdapter(ctx, config)
  if (config.runtime.scheduler.enabled) {
    runtimeAdapters.push(schedulerRuntimeAdapter)
    ctx.logger.info('[orca-cordis] Scheduler adapter 已启用（Phase 7.1A）')
  }

  // Phase 2.D：mock 输入 adapter（pc/calendar/phone），全部默认 disabled
  if (config.runtime.pc.enabled) {
    const pcRuntimeAdapter = pcAdapter(ctx, config)
    runtimeAdapters.push(pcRuntimeAdapter)
    ctx.logger.info('[orca-cordis] PC adapter 已启用（mock）')
  }
  if (config.runtime.calendar.enabled) {
    const calendarRuntimeAdapter = calendarAdapter(ctx, config)
    runtimeAdapters.push(calendarRuntimeAdapter)
    ctx.logger.info('[orca-cordis] Calendar adapter 已启用（mock）')
  }
  if (config.runtime.phone.enabled) {
    const phoneRuntimeAdapter = phoneAdapter(ctx, config)
    runtimeAdapters.push(phoneRuntimeAdapter)
    ctx.logger.info('[orca-cordis] Phone adapter 已启用（mock）')
  }

  // IM Bridge（IM-1.0 Phase；mock 模式）
  if (config.runtime.im.enabled) {
    const imRuntimeAdapter = imAdapter(ctx, config)
    runtimeAdapters.push(imRuntimeAdapter)
    ctx.logger.info('[orca-cordis] IM adapter 已启用（IM-1.0，platform=%s）', config.runtime.im.platform)
  } else {
    ctx.logger.info('[orca-cordis] IM adapter 未启用（ORCA_IM_ENABLED=0 或未配置；IM-1.0 仅 mock）')
  }

  // IM Observation（IM-1.5A Phase；订阅 EventBus im.* 事件，生成 CommunicationSignal）
  ctx.plugin(imObservationAdapter, config)

  // Phase 7.1B：ScheduledRuleRegistry（订阅 scheduler:tick，评估 rules，发射 business events）
  ctx.plugin(scheduledRuleRegistry)
  // Phase 7.2：Rule Factory——根据配置注册 enabled 的规则
  const scheduledRules = createScheduledRulesFromConfig(config.runtime.scheduler?.scheduledRules)
  if (scheduledRules.length > 0) {
    const registry = ctx.get('scheduledRuleRegistry')
    if (registry) {
      for (const rule of scheduledRules) {
        registry.register(rule)
      }
      ctx.logger.info('[orca-cordis] ScheduledRules 已注册（Phase 7.2：%d 条）', scheduledRules.length)
    }
  }

  // Phase 5.1：EpisodeEngine（依赖 EventBus + WorldState，仅在 Runtime 启用时挂载）
  if (config.memory.enabled) {
    ctx.plugin(episodeEnginePlugin, config)
    ctx.logger.info('[orca-cordis] EpisodeEngine 已启用（Phase 5.1：message.burst + state.transition）')
    // Phase 5.3：ReflectionEngine（依赖 ctx.memory）
    ctx.plugin(reflectionEnginePlugin, config)
    ctx.logger.info('[orca-cordis] ReflectionEngine 已启用（Phase 5.3：deterministic rule only）')
    // Phase 5.4.A：MemoryAttentionAdapter（依赖 ctx.memory；通过 ctx.emit 注入 AttentionItems）
    ctx.plugin(memoryAttentionAdapter, config)
    ctx.logger.info('[orca-cordis] MemoryAttentionAdapter 已挂载（Phase 5.4.A：Memory → Attention）')
  }
} else {
  ctx.logger.info('[orca-cordis] Persistent Context Runtime 未启用（ORCA_RUNTIME_ENABLED=1 启用）')
}
ctx.plugin(agent, config)

ctx.logger.info(
  '[orca-cordis] Phase 5.4.A 骨架已启动 host=%s port=%d model=%s dryRun=%s',
  config.host,
  config.port,
  config.llm.model,
  config.dryRun,
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    ctx.logger.info('收到 %s，正在退出…', signal)
    // 停止所有 RuntimeAdapters
    for (const adapter of runtimeAdapters) {
      try {
        adapter.stop()
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        ctx.logger.warn('[orca-cordis] RuntimeAdapter.stop() 异常: %s', detail)
      }
    }
    // 级联清理：root context 的 fiber.dispose()（fork 类型未声明，运行时存在则调用）
    const fiber = (ctx as unknown as { fiber?: { dispose?: () => Promise<void> } }).fiber
    const done = fiber?.dispose ? fiber.dispose() : Promise.resolve()
    void done.finally(() => process.exit(0))
  })
}
