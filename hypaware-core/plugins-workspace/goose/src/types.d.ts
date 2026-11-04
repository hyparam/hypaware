/**
 * Shared shapes for the `@hypaware/goose` adapter: the reader rows, the poll
 * watermark, and the poll runner state.
 */

import type { ColumnSpec, JsonObject } from '../../../../hypaware-plugin-kernel-types.js'
import type { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
import type { GooseSessionsDb } from './sessions_db.js'

/** `GooseSessionsDbError.code`, also the `error_kind` the source reports (LLP 0570#status). */
export type GooseSessionsDbErrorCode =
  | 'sqlite_unavailable'
  | 'missing'
  | 'permission_denied'
  | 'open_failed'
  | 'sqlite_busy'
  | 'schema_unsupported'

/** The `sessions` columns the reader selects (probe schema v17). */
export interface GooseSessionRow {
  id: string
  /** Model-generated title: content under privacy policy (LLP 0570 D3). */
  name: string
  /** `user`, `scheduled`, `sub_agent`, ...; `hidden` never reaches the projector (D1). */
  session_type: string
  working_dir: string
  /** SQLite `CURRENT_TIMESTAMP` text, `YYYY-MM-DD HH:MM:SS` in UTC. */
  created_at: string | null
  updated_at: string | null
  provider_name: string | null
  model_config_json: string | null
  parent_session_id: string | null
}

/** The `messages` columns the reader selects (probe schema v17). */
export interface GooseMessageRow {
  id: number
  /** Provider message id; null on some rows, and repeatable within a session. */
  message_id: string | null
  session_id: string
  role: string
  content_json: string
  /** Epoch seconds. */
  created_timestamp: number
  metadata_json: string | null
}

/** One session's row and messages, read in a single transaction. */
export interface GooseSessionSnapshot {
  session: GooseSessionRow
  /** Messages in `id` order, from the same transaction as `session`. */
  messages: GooseMessageRow[]
  /** The watermark entry this snapshot settles, digested in the same transaction. */
  mark: GooseSessionWatermark
}

/** One session's entry in the poll watermark (LLP 0570#reconciliation). */
export interface GooseSessionWatermark {
  updated_at: string | null
  /** Largest message `id` in the session, 0 when it has none. */
  max_id: number
  /** SHA-256 over the session row and its messages; absent forces a reconcile. */
  digest?: string
}

/** The poll watermark sidecar (`watermark.json` in the plugin state dir). */
export interface GooseWatermarkState {
  /** `PRAGMA data_version` after the last successful tick on this connection. */
  data_version: number | null
  /** Messages with `id` above this are new. */
  cursor_id: number | null
  /** Sessions with `updated_at` at or above this are candidates. */
  cursor_updated_at: string | null
  sessions: Record<string, GooseSessionWatermark>
}

/** The candidate sets one detection read returns, from one read transaction. */
export interface GooseChanges {
  /** Sessions with a message above the id cursor, and their first new id. */
  newMessages: { session_id: string, first_id: number, updated_at: string | null }[]
  /** Sessions with `updated_at` at or above the time cursor, oldest first. */
  updated: { id: string, updated_at: string | null }[]
  maxId: number | null
  maxUpdatedAt: string | null
}

/** One session staged for a batched commit. */
export interface GooseBatchEntry {
  session_id: string
  /** Null when the session is gone or hidden: its entry is deleted. */
  mark: GooseSessionWatermark | null
  snapshot?: {
    rows: Record<string, unknown>[]
    scope: { where: Record<string, string>, key: string }
    columns: ColumnSpec[]
  }
}

/** Mutable state of one running goose poll source. */
export interface GoosePollRunner {
  sessionsDbPath: string
  pollIntervalMs: number
  homeDir: string
  stateDir: string
  resolver: UsagePolicyResolver
  devRunId?: string
  db: GooseSessionsDb | null
  watermark: GooseWatermarkState | null
  /** `PRAGMA data_version` seen by the last successful tick on the open connection. */
  dataVersion: number | null
  rowsWritten: number
  sessionsTracked: number
  sessionsPending: number
  lastPollAt?: string
  lastError?: string
  lastErrorKind?: string
  idleLogged: boolean
  /** Whether the database has never held a session, for the status wording. */
  noSessions: boolean
  /** `SessionIgnoreSet` shared with the control plane; unset in tests that do not exercise it. */
  ignoredSessions?: Set<string>
  /** Directory-signature of the exclusion markers at the last refresh. */
  exclusionsSignature?: string
}

/** Shares the running poll's runner with the backfill sweep (LLP 0570#backfill). */
export interface GooseRunnerHolder {
  runner?: GoosePollRunner
}

export interface GooseBusyRetryOptions {
  /** Maximum attempts (including the first) before giving up; defaults to `DEFAULT_BUSY_RETRY_ATTEMPTS`. */
  attempts?: number
  /** Delay between attempts in ms; defaults to `DEFAULT_BUSY_RETRY_DELAY_MS`. */
  delayMs?: number
  /** Injectable delay function, defaulting to a real `setTimeout` wait. */
  sleep?: (ms: number) => Promise<void>
}

export interface GooseSessionsDbOptions extends GooseBusyRetryOptions {
  /** Injectable `require`-style loader for `node:sqlite`; tests substitute one that throws. */
  requireFn?: (id: string) => unknown
}

/** One projected part before ids and timestamps are attached. */
export interface GooseMessagePart {
  role: 'user' | 'assistant' | 'tool'
  content: JsonObject[]
}
