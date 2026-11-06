/**
 * Shared shapes for the `@hypaware/mastracode` adapter.
 */

import type { ColumnSpec } from '../../../../hypaware-plugin-kernel-types.js'
import type { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'

/** `MastraDbError.code`, also the `error_kind` the source reports (LLP 0586#status). */
export type MastraDbErrorCode =
  | 'sqlite_unavailable'
  | 'sqlite_unsupported'
  | 'missing'
  | 'permission_denied'
  | 'open_failed'
  | 'sqlite_busy'
  | 'schema_unsupported'
  | 'remote_store_unsupported'

/**
 * Where the source reads Mastra Code from (LLP 0586#config): a local
 * `mastra.db` path, or a remote store named by `MASTRA_DB_URL`, which is not
 * read.
 */
export type MastraDbLocation =
  | { kind: 'local', path: string }
  | { kind: 'remote' }

/** One `mastra_threads` row, the columns the reader names (LLP 0586#sqlite). */
export interface MastraThreadRow {
  id: string
  /** Content (D8): reaches only `captureSessionTitle`, never logs, spans or status. May be empty. */
  title: string | null
  /** `json(metadata)`: the JSONB column decoded to JSON text. */
  metadata: string | null
  /** ISO 8601. */
  createdAt: string
  /** ISO 8601. */
  updatedAt: string
}

/** One `mastra_messages` row, the columns the reader names. `resourceId` is never read. */
export interface MastraMessageRow {
  row_id: number
  id: string
  thread_id: string
  /** JSON text: `{ format, parts, metadata?, content? }`. */
  content: string | null
  role: string
  type: string
  /** ISO 8601. */
  createdAt: string
}

/** What one thread's reconcile settles in the watermark (LLP 0586#reconciliation). */
export interface MastraThreadMark {
  updated_at: string
  message_count: number
  max_rowid: number
  /** sha256 over the thread row and every message row read. */
  digest: string
}

/** One thread read inside one read transaction. */
export interface MastraThreadSnapshot {
  thread: MastraThreadRow
  /** In `(createdAt, rowid)` order. */
  messages: MastraMessageRow[]
  mark: MastraThreadMark
}

/** The threads with messages above a rowid cursor. */
export interface MastraNewRows {
  threadIds: string[]
  /** The largest rowid read, or the cursor when none. */
  maxRowid: number
}

/** One thread's `COUNT(*)` and `MAX(rowid)`. */
export interface MastraThreadCounts {
  message_count: number
  max_rowid: number
}

export interface MastraBusyRetryOptions {
  /** Maximum attempts (including the first) before giving up; defaults to `DEFAULT_BUSY_RETRY_ATTEMPTS`. */
  attempts?: number
  /** Delay between attempts in ms; defaults to `DEFAULT_BUSY_RETRY_DELAY_MS`. */
  delayMs?: number
  /** Injectable delay function, defaulting to a real `setTimeout` wait. */
  sleep?: (ms: number) => Promise<void>
}

export interface MastraDbOptions extends MastraBusyRetryOptions {
  /** Injectable `require`-style loader for `node:sqlite`; tests substitute one that throws or stubs the version. */
  requireFn?: (id: string) => unknown
}

/**
 * Parts the projector saw and did not project, by kind (LLP 0586#projection).
 * Keys are a fixed set, so the map stays bounded whatever upstream writes.
 */
export interface MastraSkipCounts {
  signal_other?: number
  'data-sandbox-exit'?: number
  reasoning?: number
  unknown?: number
}

/** The database's poll watermark (LLP 0586#reconciliation). */
export interface MastraDbWatermark {
  /** The `mastra.db` path the entries describe; a different resolved path is a first start. */
  path: string
  /** `size:mtimeNs:ino` of `mastra.db` and `mastra.db-wal`, null before the first record. */
  stat_sig: string | null
  /** Message rowid cursor: rows above it are new. */
  max_rowid: number
  /** An `updatedAt`; a thread with no entry at or below it is history. Null for an empty store. */
  floor: string | null
}

/** One thread's poll watermark entry. */
export interface MastraThreadWatermark {
  updated_at: string
  message_count: number
  max_rowid: number
  /** The digest changed on the thread's last reconcile, so it is hashed again on the next changed tick. */
  open: boolean
  digest?: string
}

export interface MastraWatermarkState {
  db: MastraDbWatermark | null
  /** Keyed by Mastra Code thread id. */
  threads: Record<string, MastraThreadWatermark>
}

/** One thread admitted to a tick's batch. */
export interface MastraBatchEntry {
  thread_id: string
  /** The entry to record once committed, null to drop it. */
  mark: MastraThreadWatermark | null
  /** Absent when the thread's rows are unchanged (digest equal). */
  snapshot?: {
    rows: Record<string, unknown>[]
    scope: { where: Record<string, string>, key: string }
    columns: ColumnSpec[]
  }
}

/** The poll's state between ticks. */
export interface MastraPollRunner {
  location: MastraDbLocation
  pollIntervalMs: number
  homeDir: string
  stateDir: string
  resolver: UsagePolicyResolver
  localOnlyListPath: string
  devRunId?: string
  watermark: MastraWatermarkState | null
  /** Whether `mastra.db` existed at the last tick. */
  dbPresent: boolean
  rowsWritten: number
  threadsTracked: number
  threadsPending: number
  lastPollAt?: string
  lastError?: string
  lastErrorKind?: string
  /** `SessionIgnoreSet` shared with the control plane; unset in tests that do not exercise it. */
  ignoredSessions?: Set<string>
  /** Directory-signature of the exclusion markers at the last refresh. */
  exclusionsSignature?: string
}

/** Shares the running poll's runner with the backfill sweep (LLP 0586#backfill). */
export interface MastraRunnerHolder {
  runner?: MastraPollRunner
}
