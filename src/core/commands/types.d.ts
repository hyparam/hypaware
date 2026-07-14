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
