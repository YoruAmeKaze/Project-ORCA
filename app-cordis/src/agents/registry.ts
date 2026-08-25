import type { InfoAgent, InfoAgentMeta } from './types.js'

/**
 * InfoAgent 闭集注册表（D-AGENT-02）：
 * LLM 只能从 list() 中选择，不能发明 agent。注册时若声明 recordTypes，
 * 框架会在装配插件里自动为该 namespace 建档案夹（JSONL 文件）。
 */
export class InfoAgentRegistry {
  private agents = new Map<string, InfoAgent>()

  register(agent: InfoAgent): void {
    if (this.agents.has(agent.meta.name)) {
      throw new Error(`InfoAgent 重复注册: ${agent.meta.name}`)
    }
    this.agents.set(agent.meta.name, agent)
  }

  get(name: string): InfoAgent | undefined {
    return this.agents.get(name)
  }

  list(): InfoAgent[] {
    return [...this.agents.values()]
  }

  metas(): InfoAgentMeta[] {
    return this.list().map((a) => a.meta)
  }
}
