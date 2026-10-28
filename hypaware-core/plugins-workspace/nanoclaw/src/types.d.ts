export interface NanoclawGroup {
  id: string
  cwd: string
  projects: string
}

export interface NanoclawFile {
  file: string
  group: NanoclawGroup
}

export interface NanoclawHealth {
  groups: number
  files_read: number
  files_unchanged: number
  files_failed: number
  policy_drops: number
  deferred: boolean
  last_scan?: string
  error_kind?: string
}
