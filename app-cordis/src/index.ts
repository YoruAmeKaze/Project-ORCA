import { Context, Logger, type Exporter } from '@deepseek-ai/cordis'
import './context.js'
import { getConfig, loadOrcaEnv } from './config.js'
import { FeishuClient } from './services/feishu.js'
import { LlmClient } from './services/llm.js'
import { VisionClient } from './services/vision.js'
import { SessionStore } from './session.js'
import { feishuChannel } from './plugins/feishu-channel.js'
import { agent } from './plugins/agent.js'
import { infoAgents } from './plugins/info-agents.js'
import { infoReceiver } from './plugins/info-receiver.js'
import { imageRouter } from './plugins/image-router.js'
import { dashboard } from './plugins/dashboard.js'
import { orcaRuntime } from './plugins/orca-runtime.js'

loadOrcaEnv()
const config = getConfig()

if (!config.llm.apiKey) {
  console.error('[orca-cordis] 缺少 DEEPSEEK_API_KEY：请在仓库根 .env 或 app-cordis/.env 配置')
  process.exit(1)
}

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
ctx.provide('sessions', new SessionStore(config.historyTurns))

// 插件装配
ctx.plugin(feishuChannel, config)
ctx.plugin(infoAgents, config) // 信息获取框架（InfoAgent 注册表 + 档案室）
ctx.plugin(infoReceiver, config) // 外部 App Push 通道（POST /info/records）
ctx.plugin(imageRouter, config) // 图片事件路由层（D-AGENT-15：chat_id → agent 工位分配；food 管线由路由接收）
ctx.plugin(dashboard, config)    // Orca 仪表盘（状态监控 UI）
// Orca Persistent Context Runtime（默认关闭；ORCA_RUNTIME_ENABLED=1 启用，挂载在 agent 之前以便订阅 feishu 事件）
if (config.runtime.enabled) {
  ctx.plugin(orcaRuntime, config)
  ctx.logger.info('[orca-cordis] Persistent Context Runtime 已启用（Phase 0+1）')
} else {
  ctx.logger.info('[orca-cordis] Persistent Context Runtime 未启用（ORCA_RUNTIME_ENABLED=1 启用）')
}
ctx.plugin(agent, config)

ctx.logger.info(
  '[orca-cordis] Phase 2 骨架已启动 host=%s port=%d model=%s dryRun=%s',
  config.host,
  config.port,
  config.llm.model,
  config.dryRun,
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    ctx.logger.info('收到 %s，正在退出…', signal)
    // 级联清理：root context 的 fiber.dispose()（fork 类型未声明，运行时存在则调用）
    const fiber = (ctx as unknown as { fiber?: { dispose?: () => Promise<void> } }).fiber
    const done = fiber?.dispose ? fiber.dispose() : Promise.resolve()
    void done.finally(() => process.exit(0))
  })
}
