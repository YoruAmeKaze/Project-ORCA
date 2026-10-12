/** Controlled, model-visible skill metadata. Skills never grant execution rights. */
export type SkillRisk = 'read_only' | 'write' | 'external_side_effect'
export type { CategoryPath as SkillCategory } from './category.js'
import type { CategoryPath } from './category.js'

export interface SkillMetadata {
  id: string
  category: CategoryPath
  summary: string
  docPath: string
  documentId?: string
  actions: string[]
  risk: SkillRisk
  confirmation: 'none' | 'required'
  available: boolean
  keywords: string[]
}

export interface SkillCatalogService {
  list(): SkillMetadata[]
  search(query: string, limit?: number): SkillMetadata[]
  get(id: string): SkillMetadata | undefined
  validateAction(skillId: string | undefined, action: string): { ok: true } | { ok: false; error: string }
}

export interface SkillLoaderService {
  load(id: string): string
  loadedCount(): number
}
