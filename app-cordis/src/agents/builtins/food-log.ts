import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { AgentDeps, InfoAgent, InfoRecord, InfoRequest, InfoResult } from '../types.js'
import type { VisionClient } from '../../services/vision.js'

export interface FoodLogInput {
  /** 本地图片路径（优先） */
  imagePath?: string
  /** 远程图片 URL */
  imageUrl?: string
  /** 用户补充说明（可选） */
  note?: string
  /** 识别后是否写入 food-log 档案（Push 副产品），默认 true */
  record?: boolean
}

export interface FoodLogOutput {
  food: string
  kcal: number
  confidence: number
  amount?: string
  note?: string
  recordId?: string
  photoRef?: string
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

function buildPrompt(note?: string): string {
  const lines = [
    '你是食物识别助手。识别图片中的食物并估算热量。',
    '只输出一个 JSON 对象，不要输出任何其他文字、代码块或解释。格式：',
    '{"food":"食物名称","kcal":680,"amount":"一份","confidence":0.87}',
    '要求：',
    '- kcal：估算千卡数，整数',
    '- confidence：0 到 1 的置信度',
    '- amount：份量描述，可省略',
  ]
  if (note) lines.push(`用户补充信息：${note}`)
  return lines.join('\n')
}

/** 宽松解析视觉模型输出：剥代码块 → 提取首个 JSON 对象 → 字段校验 */
function parseRecognition(raw: string): { food: string; kcal: number; confidence: number; amount?: string } {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('识别输出不含 JSON 对象')
  const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  const food = typeof obj.food === 'string' ? obj.food.trim() : ''
  const kcal = Number(obj.kcal)
  const confidence = Number(obj.confidence)
  if (!food || !Number.isFinite(kcal) || !Number.isFinite(confidence)) {
    throw new Error(`识别字段缺失或非法: food=${food} kcal=${kcal} confidence=${confidence}`)
  }
  return { food, kcal, confidence, amount: typeof obj.amount === 'string' ? obj.amount : undefined }
}

/**
 * food-agent：食物识别 InfoAgent（首批 Push 源，§13 走查示例）。
 * 双向模式（D-AGENT-08）：Pull = Orca 问询即时识别；Push = 识别结果自动写 food-log 档案。
 * 推理型（kind=llm）：内部调用 Qwen 视觉（services/vision.ts）。
 * 隐私（D-AGENT-12）：payload 只存本地路径引用（photoRef: local://...），ttl 7 天，L1 不落明文日志。
 */
export const foodLogAgent: InfoAgent<FoodLogInput, FoodLogOutput> = {
  meta: {
    name: 'food-agent',
    description:
      '食物拍照识别（推理型，内部 Qwen 视觉）：输入图片路径或 URL，识别食物名称、估算热量(kcal)与置信度；' +
      '识别结果自动写入 food-log 档案（Push）并即时返回（Pull），Orca 查"吃了多少卡"时可直接命中档案复用。',
    tags: ['food', 'diet', '热量', '卡路里', '饮食', '摄入', 'kcal'],
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string' },
        imageUrl: { type: 'string' },
        note: { type: 'string' },
        record: { type: 'boolean' },
      },
      required: [],
    },
    outputSchema: { type: 'object' },
    modes: ['pull', 'push'],
    recordTypes: ['food-log'],
    kind: 'llm',
    // Qwen 视觉实测 ~18s（热）/ 首次冷调用可 >30s，留 60s 余量（2026-08-25 L1 实测）
    timeoutMs: 60_000,
    isConcurrencySafe: false,
    costHint: 'paid',
  },

  async execute(req: InfoRequest<FoodLogInput>, deps: AgentDeps): Promise<InfoResult<FoodLogOutput>> {
    const input = req.input
    const started = Date.now()
    if (!input.imagePath && !input.imageUrl) {
      return { ok: false, error: { code: 'BAD_INPUT', message: '需要 imagePath 或 imageUrl', retryable: false } }
    }
    const vision = deps.vision as VisionClient | undefined
    if (!vision) {
      return {
        ok: false,
        error: { code: 'NO_VISION', message: '未注入视觉客户端（检查 QWEN_API_KEY 配置）', retryable: false },
      }
    }
    try {
      let dataUrl: string | undefined
      let photoRef: string | undefined
      if (input.imagePath) {
        const buf = await readFile(input.imagePath)
        const mime = MIME_BY_EXT[extname(input.imagePath).toLowerCase()] ?? 'image/jpeg'
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`
        photoRef = `local://${input.imagePath}`
      }
      const raw = await vision.describe({ dataUrl, url: input.imageUrl }, buildPrompt(input.note), {
        // qwen3-vl 等 reasoning 模型：长 prompt 会输出大量 thinking，max_tokens 太小会被吃光 → content 被截断为空。
        // 实测 400 必空、3000 正常（本地 ~15-20s；executor 超时 60s 足够）
        maxTokens: 3000,
        signal: deps.signal, // 执行器超时中止时，真正取消视觉请求
      })
      const parsed = parseRecognition(raw)
      const result: FoodLogOutput = {
        food: parsed.food,
        kcal: parsed.kcal,
        confidence: parsed.confidence,
        amount: parsed.amount,
        note: input.note,
        photoRef,
      }

      // Push 副产品：默认写档案（urgency=0 静默入库，不打扰用户，D-AGENT-11）
      if (input.record !== false && deps.store) {
        const record: InfoRecord = {
          id: randomUUID(),
          namespace: 'food-agent',
          type: 'food-log',
          ts: Date.now(),
          source: 'food-agent',
          confidence: parsed.confidence,
          urgency: 0,
          payload: {
            food: parsed.food,
            kcal: parsed.kcal,
            amount: parsed.amount,
            note: input.note,
            photoRef,
            model: 'qwen-vl',
          },
          ttlDays: 7, // §13：照片类短 ttl
        }
        await deps.store.append(record)
        result.recordId = record.id
        deps.logger.info('[food-agent] 已写 food-log 档案: %s ≈ %dkcal (record=%s)', parsed.food, parsed.kcal, record.id)
      }

      return { ok: true, data: result, tookMs: Date.now() - started, source: 'food-agent' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { code: 'VISION_FAIL', message, retryable: true } }
    }
  },
}
