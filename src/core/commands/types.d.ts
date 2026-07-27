import type { UsageClass } from '../usage-policy/types.d.ts'

// How the shared machine-local marking writers (`runMarkMachineLocal`,
// `runUnmarkMachineLocal`, `runIgnoreCheck`) render internal values for a
// human reader (LLP 0111 #tokens). The `hyp policy` verb passes the public
// CLI vocabulary, so a `sync` mark confirms as `sync` and the backing store
// is named rather than pathed; the deprecated `hyp ignore` / `hyp unignore`
// flag aliases pass nothing and keep their byte-identical legacy output
// (LLP 0111 #aliases). Machine-readable output (`--json`) never routes
// through this: it keeps emitting the resolver vocabulary.
export interface PolicyHumanVocabulary {
  // Render a stored usage class for a human reader.
  className(cls: UsageClass): string
  // Name the source governing a path. `governedBy` equal to `listPath` is the
  // machine-local store; any other value is a `.hypignore` dotfile, always
  // named by its real path.
  governor(governedBy: string, listPath: string): string
  // Trailing parenthetical naming where a fresh marking landed; the empty
  // string omits it.
  storeSuffix(listPath: string): string
}

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
