/**
 * Shared shapes for the `@hypaware/crush` adapter: discovery of the
 * per-project databases and the reader's error codes.
 */

/** `CrushDbError.code`, also the `error_kind` the source reports (LLP 0573#status). */
export type CrushDbErrorCode =
  | 'sqlite_unavailable'
  | 'missing'
  | 'permission_denied'
  | 'open_failed'
  | 'sqlite_busy'
  | 'schema_unsupported'

/** One project database in the discovered set (LLP 0573#discovery). */
export interface CrushDatabase {
  /** Real path of the project's `.crush` data dir. */
  dataDir: string
  /** `<dataDir>/crush.db`. */
  dbPath: string
  /** The data dir's parent: the git root Crush chose. */
  projectDir: string
}

/** What discovery remembers between ticks. */
export interface CrushDiscoveryState {
  /** `size:mtimeMs:ino` of `projects.json` at the last read, null when absent. */
  indexSig: string | null
  /** `data_dir` values from the last good read, in index order, deduplicated as text. */
  indexDataDirs: string[]
  /** Set while the index at `indexSig` could not be parsed or read. */
  indexUnreadable: boolean
}

/** Inputs to one discovery pass. */
export interface CrushDiscoveryInput {
  indexPath: string
  /** `data_dirs` from config, `~` already expanded. */
  dataDirs: string[]
}

/** One discovery pass over the index and `data_dirs`. */
export interface CrushDiscoveryResult {
  /** The databases to poll, in index order then `data_dirs` order, at most the cap. */
  databases: CrushDatabase[]
  /** Whether `projects.json` exists. */
  indexPresent: boolean
  /** Whether this pass reread `projects.json` (its signature moved). */
  indexRead: boolean
  /** The index exists but its last read failed; the last good list is in use. */
  indexUnreadable: boolean
  /** Distinct data dirs named by the index and `data_dirs`, before the existence check. */
  listed: number
  /** Listed data dirs with no `crush.db`. */
  stale: number
  /** Existing databases skipped over the cap. */
  overCap: number
}
