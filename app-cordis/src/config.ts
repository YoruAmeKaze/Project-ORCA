import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export interface FeishuConfig {
  appId: string
  appSecret: string
  baseUrl: string
}

export interface LlmConfig {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
}

export interface OrcaConfig {
  host: string
  port: number
  feishu: FeishuConfig
  llm: LlmConfig
  dryRun: boolean
  historyTurns: number
}

const here = dirname(fileURLToPath(import.meta.url)) // app-cordis/src
export const appRoot = resolve(here, '..')

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw)
    if (!m) continue
    const key = m[1]
    const value = m[2]
    if (key === undefined || value === undefined) continue
    if (process.env[key] === undefined) {
      process.env[key] = value.replace(/^["']|["']$/g, '')
    }
  }
}

/** 加载仓库根 .env（与 Python 版共用），再叠加 app-cordis/.env 覆盖层 */
export function loadOrcaEnv(): void {
  loadEnvFile(resolve(appRoot, '..', '.env'))
  loadEnvFile(resolve(appRoot, '.env'))
}

export function getConfig(): OrcaConfig {
  // DEEPSEEK_API_URL 可能是基础地址（https://api.deepseek.com）或完整端点（.../v1/chat/completions），统一归一为基础地址
  const rawApiUrl = (process.env.DEEPSEEK_API_URL ?? 'https://api.deepseek.com').replace(/\/$/, '')
  return {
    host: process.env.CORDIS_HOST ?? '0.0.0.0',
    port: Number(process.env.CORDIS_PORT ?? 8100),
    feishu: {
      appId: process.env.FEISHU_APP_ID ?? '',
      appSecret: process.env.FEISHU_APP_SECRET ?? '',
      baseUrl: (process.env.FEISHU_API_URL ?? 'https://open.feishu.cn').replace(/\/$/, ''),
    },
    llm: {
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
      baseUrl: rawApiUrl.replace(/\/chat\/completions$/, ''),
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      temperature: Number(process.env.ORCA_TEMPERATURE ?? 0.3),
      maxTokens: Number(process.env.ORCA_MAX_TOKENS ?? 2000),
    },
    dryRun: process.env.ORCA_DRY_RUN === '1',
    historyTurns: Number(process.env.ORCA_HISTORY_TURNS ?? 10),
  }
}
