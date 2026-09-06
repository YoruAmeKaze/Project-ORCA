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

export interface QwenConfig {
  apiKey: string
  /** 可能是完整端点（含 /chat/completions），归一化处理 */
  baseUrl: string
  model: string
}

export interface InfoReceiverConfig {
  port: number
  /** token → 允许写入的 namespaces 白名单（D-AGENT-12） */
  tokens: Record<string, string[]>
}

/**
 * Orca Persistent Context Runtime 配置（Phase 0+1 最小版）。
 * ORCA_RUNTIME_ENABLED=1 才会挂载 orcaRuntime plugin（默认 0 关闭，零侵入）。
 */
export interface OrcaRuntimeConfig {
  /** 是否启用（默认 false） */
  enabled: boolean
  /** EventBus 滑动窗口大小（默认 200） */
  eventWindowSize: number
  /** Phase 2.A WorldState 子配置 */
  worldState: OrcaWorldStateConfig
  /** Phase 2.D PC adapter 配置（默认 enabled=false） */
  pc: OrcaInputAdapterConfig
  /** Phase 2.D Calendar adapter 配置（默认 enabled=false） */
  calendar: OrcaInputAdapterConfig
  /** Phase 2.D Phone adapter 配置（默认 enabled=false） */
  phone: OrcaInputAdapterConfig
  /** Phase 3 Attention Engine 子配置 */
  attention: OrcaAttentionConfig
  /** Phase 4.A Decision Engine 子配置 */
  decision: OrcaDecisionConfig
  /** Phase 4.B Action Executor 子配置 */
  action: OrcaActionConfig
}

/**
 * Attention Engine 配置（Phase 3 第一版，纯规则，不引入 LLM）。
 */
export interface OrcaAttentionConfig {
  /** 是否启用 Attention Engine（默认 true；仅当 OrcaRuntime enabled 时才生效） */
  enabled: boolean
}

/**
 * Decision Engine 配置（Phase 4.A 第一版，纯决策层，不执行 action）。
 *
 * 默认启用：纯决策层无副作用（不发飞书 / 不写 infoStore / 不调 LLM），安全默认。
 */
export interface OrcaDecisionConfig {
  /** 是否启用 Decision Engine（默认 true；仅当 OrcaRuntime + Attention enabled 时才生效） */
  enabled: boolean
}

/**
 * Action Executor 配置（Phase 4.B 第一版，执行层）。
 *
 * **默认禁用**（false）：用户决策——act handler 暂无显式注册时不应执行任何 shell / 任意 JS。
 * 启用后挂载 actionExecutor plugin；默认注册的安全 handler 是：
 * - noop（no_action）：成功无副作用
 * - defer：入队 in-memory pending store（不消费）
 * - notify-stub：success=false + "notification handler not configured"
 * - act-stub：success=false + "action handler not configured"（**严禁任意 shell**）
 * - remember：当 infoStore 已 provide 时挂载，否则跳过（success=false）
 */
export interface OrcaActionConfig {
  /** 是否启用 Action Executor（默认 false；仅当 OrcaRuntime + Attention + Decision enabled 时才生效） */
  enabled: boolean
}

/**
 * WorldState 子配置（Phase 2.A 最小版 + Phase 2.C time tick）。
 * timeRefreshMs 仅 Phase 2.C 用；不传时由 world-state-updater 默认 60000。
 */
export interface OrcaWorldStateConfig {
  /** 是否启用 WorldState 派生（默认 true；仅当 OrcaRuntime enabled 时才生效） */
  enabled: boolean
  /** Time tick 间隔（毫秒，默认 60000）；Phase 2.C 时 tick 用 */
  timeRefreshMs?: number
}

/**
 * 输入 adapter 子配置（Phase 2.D，pc/calendar/phone 共用）。
 */
export interface OrcaInputAdapterConfig {
  /** 是否启用（默认 false） */
  enabled: boolean
  /** 周期性 publish 间隔（毫秒）；adapter 默认值不同 */
  refreshMs?: number
}

export interface OrcaMemoryConfig {
  /** 是否启用 MemoryStore（默认 true） */
  enabled: boolean
  /** Memory 数据目录（默认 appRoot/data/memory） */
  dataDir: string
  /**
   * ForgetMarker fingerprint salt（必须稳定，重启后不变才能跨进程抑制）。
   * 建议使用随机字符串并永久保存到 .env。
   */
  fingerprintSalt: string
  /** LongMemoryFact.active 检索结果上限（默认 100） */
  maxActiveFacts: number
  /** Candidate confidence 晋升阈值（默认 0.7） */
  promoteThreshold: number
  /** Phase 5.4.A：是否启用 MemoryAttentionAdapter（默认 true） */
  attentionEnabled: boolean
  /** Phase 5.4.A：MemoryAttentionAdapter 轮询间隔（毫秒，默认 60000） */
  attentionPollIntervalMs: number
  /** Phase 5.4.A：MemoryAttentionAdapter 每次最多生成的 AttentionItems 数（默认 5） */
  attentionTopK: number
}

export interface OrcaConfig {
  host: string
  port: number
  feishu: FeishuConfig
  llm: LlmConfig
  qwen: QwenConfig
  dryRun: boolean
  historyTurns: number
  infoRecordsDir: string
  imagesDir: string
  infoReceiver: InfoReceiverConfig
  /** 会话绑定路由（D-AGENT-15）：chat_id → agent 名，未绑定会话 → 默认 Orca 主管线 */
  chatBindings: Record<string, string>
  /** Orca Persistent Context Runtime（Phase 0+1，默认关闭） */
  runtime: OrcaRuntimeConfig
  /** Phase 5.0 LongMemory MemoryStore */
  memory: OrcaMemoryConfig
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
  // INFO_RECEIVER_TOKENS：JSON 对象 {"<token>": ["namespace", ...]}；解析失败/未配置 → 空（通道不启动）
  let receiverTokens: Record<string, string[]> = {}
  const rawTokens = process.env.INFO_RECEIVER_TOKENS
  if (rawTokens) {
    try {
      const parsed = JSON.parse(rawTokens) as Record<string, unknown>
      receiverTokens = Object.fromEntries(
        Object.entries(parsed).map(([token, v]) => [
          token,
          Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [],
        ]),
      )
    } catch {
      console.warn('[orca-cordis] INFO_RECEIVER_TOKENS 不是合法 JSON，外部 Push 通道不启用')
    }
  }
  // ORCA_CHAT_BINDINGS：会话绑定路由（D-AGENT-15）JSON 对象 {"<chat_id>": "<agent>"}；未绑定会话 → 默认 Orca 主管线
  let chatBindings: Record<string, string> = {}
  const rawBindings = process.env.ORCA_CHAT_BINDINGS
  if (rawBindings) {
    try {
      const parsed = JSON.parse(rawBindings) as Record<string, unknown>
      chatBindings = Object.fromEntries(
        Object.entries(parsed).filter(([, v]) => typeof v === 'string').map(([chatId, v]) => [chatId, v as string]),
      )
    } catch {
      console.warn('[orca-cordis] ORCA_CHAT_BINDINGS 不是合法 JSON，会话绑定路由不启用（全部走默认主管线）')
    }
  }
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
    qwen: buildVisionConfig(),
    dryRun: process.env.ORCA_DRY_RUN === '1',
    historyTurns: Number(process.env.ORCA_HISTORY_TURNS ?? 10),
    infoRecordsDir: process.env.INFO_RECORDS_DIR || resolve(appRoot, 'data', 'records'),
    imagesDir: process.env.IMAGES_DIR || resolve(appRoot, 'data', 'images'),
    infoReceiver: {
      port: Number(process.env.INFO_RECEIVER_PORT ?? 8101),
      tokens: receiverTokens,
    },
    chatBindings,
    runtime: {
      enabled: process.env.ORCA_RUNTIME_ENABLED === '1',
      eventWindowSize: Number(process.env.ORCA_RUNTIME_WINDOW ?? 200),
      worldState: {
        // 默认启用（按用户要求）；ORCA_WORLD_STATE_ENABLED=0 可单独关闭
        enabled: process.env.ORCA_WORLD_STATE_ENABLED !== '0',
        // Phase 2.C：time tick 间隔（默认 60000ms）
        timeRefreshMs: Number(process.env.ORCA_WORLD_STATE_REFRESH_MS ?? 60_000),
      },
      pc: {
        // 默认 disabled（Phase 2.D 第一版 mock，需要显式启用）
        enabled: process.env.ORCA_PC_ENABLED === '1',
        refreshMs: Number(process.env.ORCA_PC_REFRESH_MS ?? 60_000),
      },
      calendar: {
        enabled: process.env.ORCA_CALENDAR_ENABLED === '1',
        refreshMs: Number(process.env.ORCA_CALENDAR_REFRESH_MS ?? 120_000),
      },
      phone: {
        enabled: process.env.ORCA_PHONE_ENABLED === '1',
        refreshMs: Number(process.env.ORCA_PHONE_REFRESH_MS ?? 300_000),
      },
      attention: {
        // 默认启用（Phase 3 第一版：纯评估不执行任何 action，安全默认）
        enabled: process.env.ORCA_ATTENTION_ENABLED !== '0',
      },
      decision: {
        // 默认启用（Phase 4.A 第一版：纯决策层不执行 action，安全默认）
        enabled: process.env.ORCA_DECISION_ENABLED !== '0',
      },
      action: {
        // 默认禁用（Phase 4.B 用户决策：act/notify 默认是 stub，启用前应明确注册 handler）
        enabled: process.env.ORCA_ACTION_ENABLED === '1',
      },
    },
    memory: {
      // 默认启用（Phase 5.0）
      enabled: process.env.ORCA_MEMORY_ENABLED !== '0',
      dataDir: process.env.ORCA_MEMORY_DIR || resolve(appRoot, 'data', 'memory'),
      /**
       * ForgetMarker fingerprint salt。
       * 重要：必须稳定（跨进程重启不随机），才能保证 restart 后 ForgetMarker 仍能 suppress。
       * 建议：在 .env 中设置随机字符串，如 `openssl rand -hex 32`
       */
      fingerprintSalt: process.env.ORCA_MEMORY_SALT || 'CHANGE-ME-USE-RANDOM-SALT-IN-PROD',
      maxActiveFacts: Number(process.env.ORCA_MEMORY_MAX_ACTIVE_FACTS ?? 100),
      promoteThreshold: Number(process.env.ORCA_MEMORY_PROMOTE_THRESHOLD ?? 0.7),
      // Phase 5.4.A
      attentionEnabled: process.env.ORCA_MEMORY_ATTENTION_ENABLED !== '0',
      attentionPollIntervalMs: Number(process.env.ORCA_MEMORY_ATTENTION_POLL_INTERVAL_MS ?? 60_000),
      attentionTopK: Number(process.env.ORCA_MEMORY_ATTENTION_TOP_K ?? 5),
    },
  }
}

/**
 * 视觉识别配置：ORCA_VISION_BACKEND=ollama 走本地 Ollama（OLLAMA_HOST + OLLAMA_VL_MODEL，免 apiKey）；
 * 默认 dashscope（阿里百炼，QWEN_API_*）。本地视觉模型需支持图片输入（如 qwen2.5vl，纯文本 qwen2.5 不行）。
 */
function buildVisionConfig(): QwenConfig {
  const backend = process.env.ORCA_VISION_BACKEND ?? 'dashscope'
  if (backend === 'ollama') {
    const ollamaBase = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '')
    return {
      apiKey: '',
      baseUrl: `${ollamaBase}/v1/chat/completions`,
      model: process.env.OLLAMA_VL_MODEL ?? 'qwen2.5vl:3b',
    }
  }
  return {
    apiKey: process.env.QWEN_API_KEY ?? '',
    baseUrl: (process.env.QWEN_API_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions').replace(/\/$/, ''),
    model: process.env.QWEN_VL_MODEL ?? 'qwen3.7-plus',
  }
}
