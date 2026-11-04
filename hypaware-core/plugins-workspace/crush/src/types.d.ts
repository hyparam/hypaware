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

/** One `sessions` row, the columns the reader names (LLP 0573#sqlite). */
export interface CrushSessionRow {
  id: string
  parent_session_id: string | null
  /** Content (D7): reaches only `captureSessionTitle`, never logs, spans or status. */
  title: string | null
  message_count: number
  /** Cumulative USD, children included; carried on root sessions only (D2). */
  cost: number
  /** Epoch seconds. */
  updated_at: number
  /** Epoch seconds. */
  created_at: number
}

/** One `messages` row, the columns the reader names plus its rowid. */
export interface CrushMessageRow {
  rowid: number
  id: string
  session_id: string
  role: string
  /** JSON array of `{ type, data }` parts, unparsed. */
  parts: string
  model: string | null
  provider: string | null
  /** Epoch seconds. */
  created_at: number
  /** Epoch seconds. */
  updated_at: number
  /** Epoch seconds, null while the message streams. */
  finished_at: number | null
  is_summary_message: boolean
}

/** The per-session watermark fields one snapshot yields (LLP 0573#reconciliation). */
export interface CrushSessionMark {
  updated_at: number
  message_count: number
  max_rowid: number
  /** The latest message is an assistant message with no `finished_at`. */
  open: boolean
  /** sha256 over the session row and every message row, in read order. */
  digest: string
}

/** One session read in one read transaction. */
export interface CrushSessionSnapshot {
  session: CrushSessionRow
  messages: CrushMessageRow[]
  mark: CrushSessionMark
}

/** Bounded SQLITE_BUSY / SQLITE_LOCKED retry. */
export interface CrushBusyRetryOptions {
  /** Default 5. */
  attempts?: number
  /** Default 20. */
  delayMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

/** Options for `openCrushDb`. */
export interface CrushDbOptions extends CrushBusyRetryOptions {
  /** Injectable `require` for the `node:sqlite` load, for tests. */
  requireFn?: (id: string) => unknown
}

/** One session's metadata as the candidate selection reads it. */
export interface CrushSessionMeta {
  id: string
  updated_at: number
  message_count: number
  parent_session_id: string | null
}

/** What a changed database's two reads return. */
export interface CrushChanges {
  /** Sessions with message rows above the cursor, and their largest rowid. */
  newRows: { session_id: string, max_rowid: number }[]
  /** Every non-title session's metadata. */
  sessions: CrushSessionMeta[]
  /** The database's largest message rowid at the same snapshot, 0 when empty. */
  maxRowid: number
}
