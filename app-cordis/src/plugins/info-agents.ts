import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from '../config.js'
import { InfoAgentRegistry } from '../agents/registry.js'
import { InfoExecutor } from '../agents/executor.js'
import { JsonlInfoRecordStore } from '../agents/store.js'
import { foodLogAgent } from '../agents/builtins/food-log.js'

/**
 * 信息获取框架装配插件（§4，D-AGENT-01/02/09）：
 * provide infoAgents（闭集注册表）/ infoExecutor（Pull 执行）/ infoStore（档案室），
 * 注册内置 InfoAgent，订阅 'info/record' 事件把 Push 记录写入档案室。
 * 档案夹自动创建：register 时声明 recordTypes 的 agent，首次写入时自动建 JSONL 文件。
 */
export function infoAgents(ctx: Context, config: OrcaConfig) {
  const store = new JsonlInfoRecordStore(config.infoRecordsDir)
  const registry = new InfoAgentRegistry()
  const executor = new InfoExecutor(ctx.logger)

  ctx.provide('infoAgents', registry)
  ctx.provide('infoExecutor', executor)
  ctx.provide('infoStore', store)

  // 内置信息源注册（闭集：LLM 只能从 registry.list() 选，不能发明 agent）
  registry.register(foodLogAgent)

  // Push 入口：InfoAgent 或外部通道通过事件写档
  ctx.on('info/record', (record) => {
    void store.append(record).catch((err: unknown) => {
      ctx.logger.warn('[info-store] 写档失败: %s', err instanceof Error ? err.message : String(err))
    })
  })

  // 启动时物理清理过期记录（ttl）
  void store.pruneExpired().then((n) => {
    if (n > 0) ctx.logger.info('[info-store] pruneExpired 清理 %d 条过期记录', n)
  })

  ctx.logger.info('[info-agents] 已注册 InfoAgent: %s（档案目录 %s）', registry.metas().map((m) => m.name).join(','), config.infoRecordsDir)
}
