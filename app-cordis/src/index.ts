import { Context, Logger, type Exporter } from '@deepseek-ai/cordis'
import './context.js'
import { getConfig, loadOrcaEnv } from './config.js'
import { FeishuClient } from './services/feishu.js'
import { LlmClient } from './services/llm.js'
import { SessionStore } from './session.js'
import { feishuChannel } from './plugins/feishu-channel.js'
import { agent } from './plugins/agent.js'

loadOrcaEnv()
const config = getConfig()

if (!config.llm.apiKey) {
  console.error('[orca-cordis] 缺少 DEEPSEEK_API_KEY：请在仓库根 .env 或 app-cordis/.env 配置')
  process.exit(1)
}

const ctx = new Context()

// 控制台日志 exporter（fork 版 LoggerService 默认只装内存缓冲 exporter，不打印到终端）
const logExporter: Exporter = {
  colors: 2,
  levels: { default: 1 },
  export(message) {
    console.log(`[${new Date(message.ts).toISOString()}] ${Logger.format(logExporter, message)}`)
  },
}
ctx.logger.exporter(logExporter)

// 服务层（Cordis Service 注册）
ctx.provide('feishu', new FeishuClient(config.feishu))
ctx.provide('llm', new LlmClient(config.llm))
ctx.provide('sessions', new SessionStore(config.historyTurns))

// 插件装配
ctx.plugin(feishuChannel, config)
ctx.plugin(agent, config)

ctx.logger.info(
  '[orca-cordis] Phase 1 骨架已启动 host=%s port=%d model=%s dryRun=%s',
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
