import type { UsageClass } from '../usage-policy/types.d.ts'
import type {
  BackfillMaterializerRegistry,
  BackfillRegistry,
  HypAwareV2Config,
  QueryRegistry,
  QueryStorageService,
} from '../../../hypaware-plugin-kernel-types.js'

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
  // Trailing note appended to the class label when nothing governs the
  // directory (LLP 0111 #show): the implicit default must not read like an
  // explicit, user-chosen class. Optional; a vocabulary that omits it (the
  // aliases' internal wording) gets the empty string, so it stays correct
  // by omission rather than by remembering to opt in.
  implicitSuffix?(): string
}

// A structural subset of `CommandRunContext`: exactly the fields
// `runBackfillProvider`, `runProvider`, `resolveOwnersForRun`, and the
// materialize/write/flush helpers they call
// (`src/core/commands/backfill.js`) read off `ctx`. Every existing
// `CommandRunContext` already satisfies it, so `hyp backfill`'s CLI path
// and the onboarding finale's call keep typechecking unchanged; the
// daemon sweep driver (LLP 0173 T9) can build one directly out of
// `boot.runtime` fields without assembling a full, mostly-unused
// `CommandRunContext`. `query` was missing from this list until LLP 0173
// T12's smoke (the first caller to drive a real, non-mocked write through
// the sweep driver) found `writeRows`/`flushDataset` crash on
// `ctx.query.getDataset` when a sweep-built `ctx` reached them.
// @ref LLP 0172#lane-b-sweep [implements]: the narrowed context type `runBackfillProvider`, `runProvider`, `resolveOwnersForRun`, and the materialize/write/flush helpers declare, so the daemon sweep driver can build one without a full `CommandRunContext`
export interface BackfillRunnerContext {
  env: NodeJS.ProcessEnv
  config: HypAwareV2Config
  storage: QueryStorageService
  query: QueryRegistry
  backfills: BackfillRegistry
  backfillMaterializers: BackfillMaterializerRegistry
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
