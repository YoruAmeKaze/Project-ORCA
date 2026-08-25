import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { InfoRecord, InfoRecordStore, RecordQuery } from './types.js'

const DAY_MS = 86_400_000
const TOMBSTONE_TYPE = '__tombstone__'
const CLEAR_TYPE = '__clear__'

/**
 * 档案室（InfoRecordStore，D-AGENT-09/12）：
 * 每 namespace 一个 JSONL 档案夹，append-only + supersedes 更正 + 软删/ttl 硬清理。
 * 信封字段（namespace/type/ts/source/urgency）框架强制，检索与门控只依赖信封字段。
 */
export class JsonlInfoRecordStore implements InfoRecordStore {
  private records = new Map<string, InfoRecord[]>()
  private loaded = new Set<string>()
  /** 本次运行已汇报过的 urgency=1 记录 id（待汇报队列 ack） */
  private acked = new Set<string>()

  constructor(private dataDir: string) {}

  private fileOf(namespace: string): string {
    return `${this.dataDir}/${namespace}.jsonl`
  }

  private async ensureLoaded(namespace: string): Promise<void> {
    if (this.loaded.has(namespace)) return
    const list: InfoRecord[] = []
    try {
      const text = await readFile(this.fileOf(namespace), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          list.push(JSON.parse(line) as InfoRecord)
        } catch {
          // 跳过损坏行（append-only 文件，容忍单行坏数据）
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    this.records.set(namespace, list)
    this.loaded.add(namespace)
  }

  /** 判定软删：单条 tombstone 或整夹 clear */
  private deletedSet(namespace: string, list: InfoRecord[]): Set<string> {
    const deleted = new Set<string>()
    let cleared = false
    for (const rec of list) {
      if (rec.type === CLEAR_TYPE && rec.payload && typeof rec.payload === 'object' && (rec.payload as { target?: string }).target === namespace) {
        cleared = true
      }
      if (rec.type === TOMBSTONE_TYPE) {
        const target = (rec.payload as { target?: string } | undefined)?.target
        if (target) deleted.add(target)
      }
    }
    if (cleared) {
      for (const rec of list) {
        if (rec.type !== TOMBSTONE_TYPE && rec.type !== CLEAR_TYPE) deleted.add(rec.id)
      }
    }
    return deleted
  }

  async append(record: InfoRecord): Promise<void> {
    // 信封字段强制（D-AGENT-09）：检索与门控只依赖它们
    if (!record.namespace || !record.type) throw new Error('InfoRecord 缺少信封字段 namespace/type')
    if (!record.source) throw new Error('InfoRecord 缺少信封字段 source')
    if (record.ts !== undefined && !Number.isFinite(record.ts)) throw new Error('InfoRecord.ts 必须为时间戳数值')
    const urgency = record.urgency ?? 0
    if (![0, 1, 2].includes(urgency)) throw new Error(`InfoRecord.urgency 必须为 0/1/2，收到 ${urgency}`)
    const rec: InfoRecord = {
      id: record.id || randomUUID(),
      namespace: record.namespace,
      type: record.type,
      ts: record.ts ?? Date.now(),
      source: record.source,
      confidence: record.confidence,
      urgency,
      payload: record.payload ?? {},
      ttlDays: record.ttlDays,
      supersedes: record.supersedes,
    }
    await this.ensureLoaded(rec.namespace)
    this.records.get(rec.namespace)!.push(rec)
    await mkdir(this.dataDir, { recursive: true })
    await appendFile(this.fileOf(rec.namespace), JSON.stringify(rec) + '\n', 'utf8')
  }

  /** 已存在的档案夹（dataDir 下 *.jsonl） */
  private async listNamespaces(): Promise<string[]> {
    try {
      const files = await readdir(this.dataDir)
      return files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length))
    } catch {
      return []
    }
  }

  async query(q: RecordQuery): Promise<InfoRecord[]> {
    // 显式 namespaces ∪ 已加载内存 ∪ dataDir 实际档案夹（去重）
    const nsSet = new Set<string>()
    for (const ns of q.namespaces ?? []) nsSet.add(ns)
    for (const ns of this.records.keys()) nsSet.add(ns)
    for (const ns of await this.listNamespaces()) nsSet.add(ns)
    const namespaces = [...nsSet]
    // 未加载过的 namespace 也尝试读取（R0 查档时可能还没有内存记录）
    for (const ns of namespaces) await this.ensureLoaded(ns)
    const out: InfoRecord[] = []
    for (const ns of namespaces) {
      const list = this.records.get(ns) ?? []
      const deleted = this.deletedSet(ns, list)
      const superseded = new Set<string>()
      for (const rec of list) {
        if (rec.supersedes) superseded.add(rec.supersedes)
      }
      for (const rec of list) {
        if (rec.type === TOMBSTONE_TYPE || rec.type === CLEAR_TYPE) continue
        if (deleted.has(rec.id)) continue
        if (superseded.has(rec.id)) continue // 已被更新的记录更正，默认隐藏
        if (q.types?.length && !q.types.includes(rec.type)) continue
        if (q.urgency !== undefined && (rec.urgency ?? 0) !== q.urgency) continue
        if (q.from !== undefined && rec.ts < q.from) continue
        if (q.to !== undefined && rec.ts > q.to) continue
        if (q.keyword) {
          const hay = JSON.stringify(rec.payload).toLowerCase()
          const k = q.keyword.toLowerCase()
          // 全文子串命中，或 query 分词（长度>=2）任一分词命中 payload（中文整句问询如"昨天中午吃了多少卡"）
          const tokens = k.split(/[\s,，。.;；!！?？:：、"'（）()【】\[\]{}]+/).filter((t) => t.length >= 2)
          if (!(hay.includes(k) || tokens.some((t) => hay.includes(t)))) continue
        }
        out.push(rec)
      }
    }
    out.sort((a, b) => b.ts - a.ts)
    return q.limit !== undefined ? out.slice(0, q.limit) : out
  }

  async delete(namespace: string, ids?: string[]): Promise<number> {
    await this.ensureLoaded(namespace)
    const list = this.records.get(namespace) ?? []
    const deleted = this.deletedSet(namespace, list)
    const targets = ids?.length ? ids : list.filter((r) => r.type !== TOMBSTONE_TYPE && r.type !== CLEAR_TYPE).map((r) => r.id)
    const fresh = targets.filter((id) => !deleted.has(id))
    if (!fresh.length) return 0
    // 软删：追加 tombstone（整夹删除追加 clear 标记），物理清理交给 pruneExpired
    if (!ids?.length) {
      await this.append({
        id: randomUUID(),
        namespace,
        type: CLEAR_TYPE,
        ts: Date.now(),
        source: 'store.delete',
        payload: { target: namespace },
      })
    } else {
      for (const id of fresh) {
        await this.append({
          id: randomUUID(),
          namespace,
          type: TOMBSTONE_TYPE,
          ts: Date.now(),
          source: 'store.delete',
          payload: { target: id },
        })
      }
    }
    return fresh.length
  }

  async pruneExpired(): Promise<number> {
    const now = Date.now()
    let removed = 0
    for (const [ns, list] of [...this.records]) {
      const deleted = this.deletedSet(ns, list)
      const keep = list.filter((rec) => {
        if (rec.type === TOMBSTONE_TYPE || rec.type === CLEAR_TYPE) return false // 标记本身随物理清理移除
        if (deleted.has(rec.id)) return false
        if (rec.ttlDays !== undefined && now - rec.ts > rec.ttlDays * DAY_MS) return false
        return true
      })
      const dropped = list.length - keep.length
      if (dropped > 0) {
        removed += dropped
        this.records.set(ns, keep)
        const dir = dirname(this.fileOf(ns))
        await mkdir(dir, { recursive: true })
        await writeFile(this.fileOf(ns), keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), 'utf8')
      }
    }
    return removed
  }

  async getRecentByNamespace(namespace: string, n: number): Promise<InfoRecord[]> {
    return this.query({ namespaces: [namespace], limit: n })
  }

  /** 待汇报队列（urgency=1）：peek 不消费，回复成功后 ack 移出（D-AGENT-11） */
  async peekPending(): Promise<InfoRecord[]> {
    for (const ns of await this.listNamespaces()) await this.ensureLoaded(ns)
    const out: InfoRecord[] = []
    for (const [ns, list] of this.records) {
      const deleted = this.deletedSet(ns, list)
      for (const rec of list) {
        if (rec.type === TOMBSTONE_TYPE || rec.type === CLEAR_TYPE) continue
        if (deleted.has(rec.id)) continue
        if ((rec.urgency ?? 0) !== 1) continue
        if (this.acked.has(rec.id)) continue
        out.push(rec)
      }
    }
    out.sort((a, b) => a.ts - b.ts)
    return out
  }

  ackPending(ids: string[]): void {
    for (const id of ids) this.acked.add(id)
  }
}
