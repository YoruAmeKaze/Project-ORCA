/** Model-visible capability metadata. Execution remains owned by ActionHandlerRegistry. */
export interface SkillDescriptor {
  name: string
  action: string
  description: string
  inputSchema: Record<string, unknown>
  permission: 'read-only' | 'network-read' | 'workspace-write'
  requiresApproval: boolean
}

export interface SkillCatalog {
  list(): SkillDescriptor[]
  get(name: string): SkillDescriptor | undefined
}
