export type SkillInstallClient = 'claude' | 'codex' | 'all'

export interface SkillInstallDestination {
  client: 'claude' | 'codex'
  path: string
}

export interface SkillInstallOptions {
  client: SkillInstallClient
  force?: boolean
  dryRun?: boolean
  homeDir?: string
  codexHome?: string
  skillName?: string
  sourceDir?: string
}

export interface SkillInstallResult {
  destinations: SkillInstallDestinationResult[]
}

export interface SkillInstallDestinationResult extends SkillInstallDestination {
  action: 'installed' | 'updated' | 'would-install' | 'would-update'
}
