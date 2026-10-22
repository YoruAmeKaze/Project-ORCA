import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { Decision } from '../types/decision.js'
import type { ActionHandler, ActionResult } from '../types/action.js'

interface LoggerLike { info?(msg: string, ...args: unknown[]): void; warn?(msg: string, ...args: unknown[]): void }
export interface ApprovalRequest { action: string; path: string; diff: string; reason?: string }
export interface CapabilityActionContext {
  workspaceRoot: string
  logger?: LoggerLike
  /** Must be provided by the user-facing approval channel; missing means fail closed. */
  approval?: { request(input: ApprovalRequest): Promise<boolean> }
  fetchImpl?: typeof fetch
}

interface ReadInput { path: string; startLine?: number; endLine?: number; maxBytes?: number; encoding?: 'utf8' | 'base64' }
interface EditInput { path: string; expectedSha256: string; edits: Array<{ startLine: number; endLine: number; replacement: string }>; reason?: string }
interface SearchInput { query: string; maxResults?: number; recency?: string; domains?: string[]; language?: string }

const MAX_READ_BYTES = 1_048_576
const MAX_SEARCH_RESULTS = 10

export function createCapabilityHandlers(ctx: CapabilityActionContext): ActionHandler[] {
  return [createFilesystemReadHandler(ctx), createFilesystemEditHandler(ctx), createWebSearchHandler(ctx)]
}

export function createFilesystemReadHandler(ctx: CapabilityActionContext): ActionHandler {
  return {
    name: 'filesystem.read', action: 'filesystem.read',
    llmDescription: '读取 workspaceRoot 内的文件内容。参数 schema：{"path": string, "startLine"?: integer, "endLine"?: integer, "maxBytes"?: integer, "encoding"?: "utf8"|"base64"}。path 必须是工作区相对路径；这是只读 Action，结果包含内容、sha256 和是否截断。',
    async execute(decision) {
      try {
        const input = parseReason<ReadInput>(decision)
        const path = safePath(ctx.workspaceRoot, input.path)
        const bytes = Math.min(Math.max(input.maxBytes ?? MAX_READ_BYTES, 1), MAX_READ_BYTES)
        const data = await readFile(path)
        const sha256 = hash(data)
        const truncated = data.byteLength > bytes
        const selected = truncated ? data.subarray(0, bytes) : data
        if (input.encoding === 'base64') return ok(decision, { path: input.path, encoding: 'base64', content: selected.toString('base64'), byteLength: selected.byteLength, sha256, truncated })
        const text = selected.toString('utf8')
        const lines = text.split(/\r?\n/)
        const start = Math.max(input.startLine ?? 1, 1)
        const end = Math.min(input.endLine ?? lines.length, lines.length)
        return ok(decision, { path: input.path, content: lines.slice(start - 1, end).join('\n'), startLine: start, endLine: end, byteLength: selected.byteLength, sha256, truncated })
      } catch (err) { return fail(decision, errorCode(err, 'FILE_READ_FAILED')) }
    },
  }
}

export function createFilesystemEditHandler(ctx: CapabilityActionContext): ActionHandler {
  return {
    name: 'filesystem.edit', action: 'filesystem.edit',
    llmDescription: '编辑 workspaceRoot 内的文件，必须先取得用户批准。参数 schema：{"path": string, "expectedSha256": string, "edits": [{"startLine": integer, "endLine": integer, "replacement": string}], "reason"?: string}。path 必须是工作区相对路径；expectedSha256 必须来自最近一次读取，编辑会在批准后执行。',
    async execute(decision) {
      try {
        const input = parseReason<EditInput>(decision)
        const path = safePath(ctx.workspaceRoot, input.path)
        const original = await readFile(path, 'utf8')
        const oldSha256 = hash(Buffer.from(original))
        if (oldSha256 !== input.expectedSha256) return fail(decision, 'FILE_CHANGED_SINCE_READ')
        const next = applyEdits(original, input.edits)
        const diff = makeDiff(original, next, input.path)
        if (!ctx.approval) return fail(decision, 'EDIT_APPROVAL_UNAVAILABLE')
        if (!(await ctx.approval.request({ action: 'filesystem.edit', path: input.path, diff, reason: input.reason }))) return fail(decision, 'EDIT_REJECTED')
        const tmp = `${path}.orca-tmp-${process.pid}-${Date.now()}`
        await mkdir(dirname(path), { recursive: true })
        await writeFile(tmp, next, 'utf8')
        await rename(tmp, path)
        const newSha256 = hash(Buffer.from(next))
        ctx.logger?.info?.('[action:filesystem.edit] applied path=%s', input.path)
        return ok(decision, { path: input.path, changed: original !== next, oldSha256, newSha256, diff })
      } catch (err) { return fail(decision, errorCode(err, 'FILE_EDIT_FAILED')) }
    },
  }
}

export function createWebSearchHandler(ctx: CapabilityActionContext): ActionHandler {
  return {
    name: 'web.search', action: 'web.search',
    llmDescription: '通过 Bing 公开网页搜索并返回整理后的结果。参数 schema：{"query": string, "maxResults"?: integer, "domains"?: string[], "language"?: string, "recency"?: string}。需要联网；只能依据返回的搜索结果作答，不能把搜索请求本身当成事实。',
    async execute(decision) {
      try {
        const input = parseReason<SearchInput>(decision)
        if (!input.query?.trim()) return fail(decision, 'SEARCH_QUERY_REQUIRED')
        const maxResults = Math.min(Math.max(input.maxResults ?? 5, 1), MAX_SEARCH_RESULTS)
        const url = new URL('https://www.bing.com/search')
        url.searchParams.set('q', input.domains?.length ? `${input.query} site:${input.domains.join(' OR site:')}` : input.query)
        const response = await (ctx.fetchImpl ?? fetch)(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Orca/1.0)' } })
        if (!response.ok) return fail(decision, `SEARCH_PROVIDER_HTTP_${response.status}`)
        const html = await response.text()
        const results = parseBing(html).slice(0, maxResults)
        return ok(decision, { query: input.query, provider: 'bing', results, searchedAt: new Date().toISOString(), sourceKind: 'provider result' })
      } catch (err) { return fail(decision, errorCode(err, 'SEARCH_PROVIDER_UNAVAILABLE')) }
    },
  }
}

function parseReason<T>(decision: Decision): T {
  const parsed: unknown = JSON.parse(decision.reason)
  if (!parsed || typeof parsed !== 'object') throw new Error('INVALID_ACTION_INPUT')
  return parsed as T
}

function safePath(root: string, input: string): string {
  if (!input || isAbsolute(input)) throw new Error('PATH_OUTSIDE_WORKSPACE')
  const base = resolve(root)
  const target = resolve(base, input)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('PATH_OUTSIDE_WORKSPACE')
  return target
}

function applyEdits(original: string, edits: EditInput['edits']): string {
  if (!Array.isArray(edits) || !edits.length) throw new Error('INVALID_EDIT_RANGE')
  const lines = original.split(/\r?\n/)
  const sorted = [...edits].sort((a, b) => b.startLine - a.startLine)
  for (const edit of sorted) {
    if (!Number.isInteger(edit.startLine) || !Number.isInteger(edit.endLine) || edit.startLine < 1 || edit.endLine < edit.startLine || edit.endLine > lines.length) throw new Error('INVALID_EDIT_RANGE')
    lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...String(edit.replacement).split(/\r?\n/))
  }
  return lines.join('\n')
}

function makeDiff(before: string, after: string, path: string): string {
  if (before === after) return `--- a/${path}\n+++ b/${path}\n`
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${a.length} +1,${b.length} @@`, ...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)].join('\n')
}

function parseBing(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const blockRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  for (const match of html.matchAll(blockRe)) {
    const block = match[1] ?? ''
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!link) continue
    const snippet = /class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? ''
    results.push({ title: stripHtml(link[2] ?? ''), url: decodeHtml(link[1] ?? ''), snippet: stripHtml(snippet) })
  }
  return results
}

function stripHtml(value: string): string { return decodeHtml(value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()) }
function decodeHtml(value: string): string { return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') }
function hash(data: Buffer): string { return createHash('sha256').update(data).digest('hex') }
function ok(decision: Decision, metadata: Record<string, unknown>): ActionResult { return { success: true, action: decision.action, decisionId: decision.decisionId, sourceEventId: decision.eventId, executedAt: Date.now(), metadata } }
function fail(decision: Decision, error: string): ActionResult { return { success: false, action: decision.action, decisionId: decision.decisionId, sourceEventId: decision.eventId, executedAt: Date.now(), error } }
function errorCode(err: unknown, fallback: string): string { const message = err instanceof Error ? err.message : String(err); return message && /^[A-Z][A-Z0-9_]+$/.test(message) ? message : `${fallback}: ${message}` }
