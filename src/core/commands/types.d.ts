export interface BackfillProviderResult {
  provider: string
  plugin: string
  datasets: string[]
  items_seen: number
  rows_written: number
  rows_skipped: number
  sessions_seen: number
  status: 'ok' | 'failed'
  error?: string
}

// A distinct working directory the user has captured Claude/Codex exchanges
// in, read from the local cache (LLP 0069 #enumerate). `repoRoot` is `null`
// for Codex directories (no repo-root stamping) or plain non-repo cwds.
export interface CapturedDirectory {
  cwd: string
  repoRoot: string | null
  rows: number
  lastSeen: string | null
}

// How `runLocalOnlyPicker` settled (LLP 0072, LLP 0080 #picker). Mirrors the
// `local_only.picker_result` telemetry `outcome` vocabulary exactly.
export type LocalOnlyPickerOutcome =
  | 'selected'
  | 'none'
  | 'cancelled'
  | 'non_tty'
  | 'no_candidates'
  | 'enumeration_failed'

export interface LocalOnlyPickerResult {
  outcome: LocalOnlyPickerOutcome
  candidateCount: number
  selectedCount: number
  /** The machine-local `local-only` list's contents after this run (unchanged from disk when nothing was persisted). */
  excludedDirs: string[]
}
