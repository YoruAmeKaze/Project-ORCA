import type { SkillCatalog, SkillDescriptor } from '../types/skill.js'

const DESCRIPTORS: SkillDescriptor[] = [
  {
    name: 'filesystem.read',
    action: 'filesystem.read',
    description: 'Read a UTF-8 text file within the workspace.',
    permission: 'read-only',
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' }, maxBytes: { type: 'integer' } },
    },
  },
  {
    name: 'filesystem.edit',
    action: 'filesystem.edit',
    description: 'Apply an approved line-based patch to a previously observed text file.',
    permission: 'workspace-write',
    requiresApproval: true,
    inputSchema: {
      type: 'object',
      required: ['path', 'expectedSha256', 'edits'],
      properties: { path: { type: 'string' }, expectedSha256: { type: 'string' }, edits: { type: 'array' }, reason: { type: 'string' } },
    },
  },
  {
    name: 'web.search',
    action: 'web.search',
    description: 'Search the public web and return provider results with source URLs.',
    permission: 'network-read',
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, maxResults: { type: 'integer' }, recency: { type: 'string' }, domains: { type: 'array' }, language: { type: 'string' } },
    },
  },
]

class StaticSkillCatalog implements SkillCatalog {
  list(): SkillDescriptor[] { return DESCRIPTORS.map((item) => ({ ...item, inputSchema: { ...item.inputSchema } })) }
  get(name: string): SkillDescriptor | undefined { return this.list().find((item) => item.name === name) }
}

export const skillCatalog: SkillCatalog = new StaticSkillCatalog()
