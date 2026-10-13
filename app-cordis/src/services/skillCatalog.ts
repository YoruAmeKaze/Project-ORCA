import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve } from 'node:path'
import type { ActionHandler } from '../types/action.js'
import type { SkillCatalogService, SkillLoaderService, SkillMetadata } from '../types/skill.js'
import { normalizeCategory } from '../types/category.js'

const MAX_SKILL_BYTES = 64 * 1024
const MAX_SKILL_LOADS = 4
const UNSAFE_DOCUMENT_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions?/iu,
  /忽略(?:之前|上面|以上).*指令/u,
  /system\s+prompt/iu,
  /系统提示(?:词|指令)/u,
  /<\|(?:system|assistant|tool)\|>/iu,
  /override\s+(?:the\s+)?(?:system|security|runtime)/iu,
]

const ACTION_METADATA: Array<Omit<SkillMetadata, 'available'> & { actionPrefixes?: string[] }> = [
  {
    id: 'system-info', category: normalizeCategory({ domain: 'basic-control', subdomain: 'system', function: 'system-info' }),
    summary: '读取受限的本机系统快照。', docPath: 'system-info/SKILL.md', actions: ['system.info'],
    risk: 'read_only', confirmation: 'none', keywords: ['系统', '电脑', '主机', '环境'],
  },
  {
    id: 'filesystem-read', category: normalizeCategory({ domain: 'basic-control', subdomain: 'filesystem', function: 'read-file' }),
    summary: '读取配置的允许目录中的文本文件。', docPath: 'filesystem-read/SKILL.md', actions: ['filesystem.read'],
    risk: 'read_only', confirmation: 'none', keywords: ['文件', '读取', '内容', '目录'],
  },
  {
    id: 'order-luckin', category: normalizeCategory({ domain: 'ordering', subdomain: 'luckin', function: 'stores' }),
    summary: '查询瑞幸中国的只读门店、商品、价格和订单信息。', docPath: 'order-food/SKILL.md',
    documentId: 'order-food', actions: [], actionPrefixes: ['order.luckin.'], risk: 'read_only', confirmation: 'none',
    keywords: ['点单', '瑞幸', '咖啡', '菜单', '门店', '价格', '订单'],
  },
  {
    id: 'location-current', category: normalizeCategory({ domain: 'basic-control', subdomain: 'location', function: 'current' }),
    summary: '读取已授权的本机当前位置，用于附近门店查询。', docPath: 'location-current/SKILL.md',
    actions: ['location.current'], risk: 'read_only', confirmation: 'none', keywords: ['位置', '定位', '附近', '最近', '距离'],
  },
  {
    id: 'order-mcdonalds', category: normalizeCategory({ domain: 'ordering', subdomain: 'mcdonalds', function: 'stores' }),
    summary: '查询麦当劳中国的只读门店、菜单、价格和订单信息。', docPath: 'order-food/SKILL.md', documentId: 'order-food',
    actions: [], actionPrefixes: ['order.mcd.'], risk: 'read_only', confirmation: 'none', keywords: ['点单', '麦当劳', '菜单', '门店', '价格', '订单'],
  },
  {
    id: 'windows-screenshot', category: normalizeCategory({ domain: 'basic-control', subdomain: 'screen', function: 'screenshot' }),
    summary: '受控读取 Windows 桌面截图，不保存图片。', docPath: 'windows-mcp/SKILL.md', documentId: 'windows-desktop',
    actions: ['windows.desktop.screenshot'], risk: 'read_only', confirmation: 'none', keywords: ['Windows', '桌面', '屏幕', '截图'],
  },
  {
    id: 'windows-snapshot', category: normalizeCategory({ domain: 'basic-control', subdomain: 'screen', function: 'snapshot' }),
    summary: '受控读取 Windows UI Automation 界面快照。', docPath: 'windows-mcp/SKILL.md', documentId: 'windows-desktop',
    actions: ['windows.desktop.snapshot'], risk: 'read_only', confirmation: 'none', keywords: ['Windows', '桌面', '屏幕', '界面'],
  },
  {
    id: 'windows-display-inventory', category: normalizeCategory({ domain: 'basic-control', subdomain: 'screen', function: 'display-inventory' }),
    summary: '查询 Windows 显示器数量、布局和 DPI。', docPath: 'windows-mcp/SKILL.md', documentId: 'windows-desktop',
    actions: ['windows.desktop.display_inventory'], risk: 'read_only', confirmation: 'none', keywords: ['Windows', '显示器', '屏幕', 'DPI'],
  },
  {
    id: 'windows-control-status', category: normalizeCategory({ domain: 'basic-control', subdomain: 'screen', function: 'control-status' }),
    summary: '查询 Windows-MCP 控制状态，不执行控制。', docPath: 'windows-mcp/SKILL.md', documentId: 'windows-desktop',
    actions: ['windows.desktop.control_status'], risk: 'read_only', confirmation: 'none', keywords: ['Windows', '控制状态', '桌面'],
  },
]

function availableActions(handlers: readonly ActionHandler[]): Set<string> {
  return new Set(handlers.map((handler) => handler.action))
}

export function createSkillCatalog(handlers: readonly ActionHandler[] | (() => readonly ActionHandler[])): SkillCatalogService {
  const list = (): SkillMetadata[] => {
    const actions = availableActions(typeof handlers === 'function' ? handlers() : handlers)
    return ACTION_METADATA.map(({ actionPrefixes, ...entry }) => ({
      ...entry,
      actions: [...entry.actions, ...[...actions].filter((action) => actionPrefixes?.some((prefix) => action.startsWith(prefix)))],
      available: entry.actions.some((action) => actions.has(action)) || [...actions].some((action) => actionPrefixes?.some((prefix) => action.startsWith(prefix))),
    }))
  }
  return {
    list,
    get: (id) => list().find((entry) => entry.id === id),
    validateAction: (skillId, action) => {
      if (!action || !/^[a-z][a-z0-9_.-]{1,96}$/u.test(action)) return { ok: false, error: 'invalid action id' }
      const allSkills = list()
      // Legacy `/act` intents may omit skillId; the ActionHandler registry is
      // still the authority for those intents. Skill mapping is enforced when
      // the model explicitly supplies a skillId.
      if (!skillId) return { ok: true }
      const skill = skillId ? allSkills.find((entry) => entry.id === skillId) : undefined
      if (skillId && !skill) return { ok: false, error: `unknown skill: ${skillId}` }
      if (skillId && skill && !skill.available) return { ok: false, error: `skill ${skillId} is unavailable` }
      if (skill && !skill.actions.includes(action)) return { ok: false, error: `action ${action} is not allowed by skill ${skillId}` }
      if (!allSkills.some((entry) => entry.available && entry.actions.includes(action))) return { ok: false, error: `action ${action} is not registered in skill catalog` }
      return { ok: true }
    },
    search: (query, limit = 5) => {
      const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
      return list()
        .filter((entry) => entry.available)
        .map((entry) => ({ entry, score: terms.reduce((score, term) => score + (entry.id.includes(term) || entry.summary.toLocaleLowerCase().includes(term) || entry.keywords.some((keyword) => keyword.toLocaleLowerCase().includes(term)) ? 1 : 0), 0) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
        .slice(0, limit)
        .map(({ entry }) => entry)
    },
  }
}

function parseDocFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith('---\n')) return {}
  const end = content.indexOf('\n---', 4)
  if (end < 0) return {}
  const fields: { name?: string; description?: string } = {}
  for (const line of content.slice(4, end).split('\n')) {
    const match = line.match(/^(name|description):\s*(.+)$/u)
    const value = match?.[2]?.trim()
    if (!value) continue
    if (match?.[1] === 'name') fields.name = value
    if (match?.[1] === 'description') fields.description = value
  }
  return fields
}

export function createSkillLoader(rootDir: string, catalog: SkillCatalogService): SkillLoaderService {
  const root = resolve(rootDir)
  let loads = 0
  return {
    loadedCount: () => loads,
    load(id) {
      const metadata = catalog.get(id)
      if (!metadata) throw new Error(`unknown skill: ${id}`)
      if (!metadata.available) throw new Error(`skill unavailable: ${id}`)
      if (loads >= MAX_SKILL_LOADS) throw new Error('skill load budget exceeded')
      const path = resolve(root, metadata.docPath)
      const rel = relative(root, path)
      if (isAbsolute(rel) || rel.startsWith(`..${normalize('/')}`) || rel === '..') throw new Error('skill path escapes root')
      const stat = statSync(path)
      if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error('skill document unavailable or too large')
      const content = readFileSync(path, 'utf8')
      validateSkillDocument(content)
      const frontmatter = parseDocFrontmatter(content)
      if (frontmatter.name !== (metadata.documentId ?? id)) throw new Error('skill document identity mismatch')
      loads++
      return content
    },
  }
}

export function validateSkillDocument(content: string): void {
  if (UNSAFE_DOCUMENT_PATTERNS.some((pattern) => pattern.test(content))) throw new Error('skill document contains unsafe instruction text')
  if (content.includes('javascript:') || content.includes('data:text/html')) throw new Error('skill document contains unsafe link')
}

export function defaultSkillsRoot(): string {
  const configured = process.env.ORCA_SKILLS_ROOT?.trim()
  return configured ? resolve(configured) : resolve(process.cwd(), '..', 'skills')
}
