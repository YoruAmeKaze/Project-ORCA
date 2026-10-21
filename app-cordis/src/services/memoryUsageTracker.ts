/**
 * Phase 6.C.3 MemoryUsageTracker
 *
 * In-memory ring buffer，记录每次 ContextAssembler.assemble() 的 memory usage。
 *
 * 设计依据：D-AGENT-21 §21-03
 *
 * 约束：
 * - 不写 JSONL / 不持久化
 * - 不进入 MemoryStore
 * - 不产生 mutation
 * - 有明确容量上限（ring buffer）
 * - query 只记录长度（隐私保护），不记录内容
 */

export interface MemoryUsageRecord {
  /** 记录时间戳 */
  timestamp: number
  /** query 原始字符串长度（不记录内容） */
  queryLength: number
  /** 最终进入 context 的 fact ids */
  returnedFactIds: string[]
  /** L2 source conflict 过滤掉的 fact ids */
  conflictFilteredIds: string[]
  /** 检测到的 semantic conflict 数量 */
  semanticConflictCount: number
  /** 格式化后总字符数 */
  charsUsed: number
  /** 是否达到 budget 上限 */
  budgetHit: boolean
  /** 使用的 scoring preset */
  scoringPreset: 'confidence' | 'source-confidence'
  /** 是否启用了 semantic detection */
  semanticDetectionEnabled: boolean
}

/** MemoryUsageTracker 配置 */
export interface MemoryUsageTrackerConfig {
  /** 是否启用（默认 false） */
  enabled: boolean
  /** ring buffer 最大记录数（默认 100） */
  maxRecords: number
}

const DEFAULT_CONFIG: Required<MemoryUsageTrackerConfig> = {
  enabled: false,
  maxRecords: 100,
}

export interface MemoryUsageTracker {
  /**
   * 记录一次 memory assembly usage。
   * 只在 enabled=true 时记录。
   */
  record(record: MemoryUsageRecord): void

  /**
   * 获取当前所有记录（从旧到新）。
   */
  getRecords(): MemoryUsageRecord[]

  /**
   * 获取记录数。
   */
  size(): number
}

export function createMemoryUsageTracker(
  config: Partial<MemoryUsageTrackerConfig> = {},
): MemoryUsageTracker {
  const cfg: Required<MemoryUsageTrackerConfig> = { ...DEFAULT_CONFIG, ...config }

  // Ring buffer
  const buffer: MemoryUsageRecord[] = []
  let head = 0 // 下一条写入位置

  function wrapIndex(index: number): number {
    return index % cfg.maxRecords
  }

  return {
    record(record: MemoryUsageRecord): void {
      if (!cfg.enabled) return

      buffer[head] = record
      head = wrapIndex(head + 1)
    },

    getRecords(): MemoryUsageRecord[] {
      if (buffer.length === 0) return []

      if (buffer.length < cfg.maxRecords) {
        // 尚未填满，按顺序返回所有有效记录
        return buffer.slice()
      }

      // 已填满：head 是最早记录的位置
      const result: MemoryUsageRecord[] = []
      for (let i = 0; i < cfg.maxRecords; i++) {
        const idx = wrapIndex(head + i)
        const rec = buffer[idx]
        if (rec !== undefined) result.push(rec)
      }
      return result
    },

    size(): number {
      return Math.min(buffer.length, cfg.maxRecords)
    },
  }
}
