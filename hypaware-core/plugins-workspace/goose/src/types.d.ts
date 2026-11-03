/**
 * Shared shapes for the `@hypaware/goose` adapter. The watermark shapes
 * arrive with their task (LLP 0571 T4).
 */

import type { JsonObject } from '../../../../hypaware-plugin-kernel-types.js'

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
