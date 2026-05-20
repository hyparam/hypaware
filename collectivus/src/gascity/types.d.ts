// ---------- Gascity source: configuration ----------

/**
 * One configured gascity supervisor. The daemon opens a lifecycle SSE per
 * city and a per-session frame SSE per active session.
 */
export interface GascityCityConfig {
  /** City name (matches the `{city}` path segment in the supervisor REST API). */
  name: string
  /** Base URL of the supervisor (e.g. `http://127.0.0.1:8372`). */
  api_url: string
  /**
   * Glob patterns matched against `session.template`. A session is captured
   * when ANY include pattern matches. Default `['**']` (capture all). The
   * patterns support `*` (any segment characters) and `**` (any sequence).
   */
  include_templates?: string[]
  /**
   * Glob patterns that suppress capture even when an include pattern matches.
   * Default `[]`. Same syntax as `include_templates`.
   */
  exclude_templates?: string[]
}

// ---------- Gascity source: SSE / frame plumbing ----------

/**
 * Per-session metadata stamped on each normalized row. Bead 1 carries this
 * through the dispatcher; beads 2/4 read it inside the normalizers.
 */
export interface SessionContext {
  /** Configured gascity name (e.g. `hyptown`). */
  city: string
  /** Provider-side session id (`hy-jw8sm`). */
  sessionId: string
  /** Session template path (e.g. `desktop/hypcity-overrides.refinery`). */
  template: string | undefined
  /** Optional rig the session belongs to. */
  rig: string | undefined
  /** Optional alias the session was started under. */
  alias: string | undefined
  /**
   * Timestamp of the first frame seen for this session (ISO 8601). Bead 3 owns
   * tracking — it's set once and reused across every subsequent row. Bead 2's
   * normalizer reads it as-is and falls back to `null` (the column is
   * nullable) when bead 3 hasn't populated it yet.
   */
  conversationStartedAt?: string | undefined
}

/**
 * Lifecycle event surfaced to a SupervisorSubscriber. The supervisor SSE
 * dispatches `session.created`, `session.woke`, `session.draining`,
 * `session.stopped`, and other `session.*` types — only the four listed are
 * actioned in bead 1; unknown types are logged at debug level and ignored.
 */
export interface LifecycleEvent {
  /** SSE `event:` field (e.g. `session.woke`). */
  type: string
  /** SSE `id:` field, if present. Used for `Last-Event-ID` resume. */
  id?: string
  /** Parsed `data:` payload. */
  payload: LifecyclePayload
}

export interface LifecyclePayload {
  /** Provider-side session id. */
  session_id?: string
  /** Session template path. */
  template?: string
  /** Optional rig label. */
  rig?: string
  /** Optional alias label. */
  alias?: string
  /** Anything else the supervisor included. */
  [k: string]: unknown
}

/**
 * Session entry returned by the supervisor session-list endpoint. The daemon
 * uses the same shape for active-session seeding and explicit historical
 * backfill discovery.
 */
export interface SupervisorSessionInfo {
  /** Provider-side session id, or the supervisor alias when present. */
  sessionId: string
  /** Session template path. */
  template?: string
  /** Optional rig label. */
  rig?: string
  /** Optional alias label. */
  alias?: string
  /** Supervisor session state (e.g. active, stopped). */
  state?: string
  /** Best available timestamp for --since filtering during discovery. */
  lastTimestamp?: string
}

/**
 * Type a normalizer function takes when registered on the dispatcher. Each
 * invocation produces zero or more rows ready for the parquet writer (bead 3).
 * Returning an empty array is valid and signals "skip this frame" — used by
 * stubs and by lifecycle/heartbeat frames that don't translate to rows.
 */
export type NormalizerFn = (
  frame: unknown,
  ctx: SessionContext,
) => Array<import('./normalizers/types.d.ts').NormalizedRow>

/**
 * Persistent cursor state for a lifecycle stream — bead 1 only writes the
 * supervisor's last `id:`. The schema is intentionally flat / forward-
 * compatible so beads 3/5 can extend it without a migration.
 */
export interface LifecycleCursor {
  last_event_id?: string
}

/**
 * Persistent cursor state for a single session stream.
 *
 * Bead 1 wrote `last_uuid` per dispatched frame so SSE reconnects could resume
 * via `?after=<uuid>`. Bead 3 moves cursor ownership to the parquet writer:
 * the cursor only advances after a successful flush + rename, so a daemon
 * killed mid-flush re-reads the last *flushed* uuid and replays the SSE tail
 * from there (idempotent via the writer's dedup set).
 *
 * Forward-compatible: future beads adding fields (`schema_version` bumps,
 * compaction state) must not require existing fields to change.
 */
export interface SessionCursor {
  /** Last `provider_uuid` from the most recent flushed row. Used for resume. */
  last_uuid?: string
  /**
   * Monotonic per-session frame counter, incremented by the writer for every
   * accepted (non-duplicate) row. Survives across daemon restarts.
   */
  last_seq?: number
  /** ISO timestamp of the last flushed row's `message_created_at`. */
  last_timestamp?: string
  /**
   * True when the supervisor has emitted `session.draining` / `session.stopped`
   * for this session. Backfill skips retired cursors so the daemon doesn't
   * re-request transcripts for already-finished sessions.
   */
  retired?: boolean
  /** Cumulative count of rows the writer has flushed for this session. */
  flushed_count?: number
  /** ISO timestamp the cursor was first created (writer's first append). */
  started_at?: string
  /**
   * `GASCITY_MESSAGES_SCHEMA_VERSION` the cursor was written with. Lets the
   * writer detect a schema bump and start a fresh part-file rather than
   * appending mismatched columns.
   */
  schema_version?: number
}

// ---------- Gascity source: runtime state snapshot ----------

/**
 * One session entry in the runtime-state snapshot the daemon writes for
 * `ctvs gascity list / status`. Mirrors fields the supervisor surfaces
 * plus the writer's frame counter.
 */
export interface GascityRuntimeSession {
  /** Provider-side session id (`hy-jw8sm`). */
  sessionId: string
  /** Optional template path captured from the lifecycle event. */
  template?: string
  /** Optional rig label. */
  rig?: string
  /** Optional alias label. */
  alias?: string
  /** Worker state. `active` for live capture; `retired` for one waiting on cleanup. */
  state: 'active' | 'retired'
  /** Total frames the session worker has dispatched into the writer. */
  frames: number
  /** ISO timestamp of the most recent frame, when one has been seen. */
  last_frame_at?: string
  /** ISO timestamp the worker spawned. */
  started_at: string
  /** ISO timestamp the worker entered the `retired` state, when applicable. */
  retired_at?: string
}

/**
 * One city entry in the runtime-state snapshot.
 */
export interface GascityRuntimeCity {
  /** Configured city name (matches the `name` field in `[[gascity]]`). */
  name: string
  /** Configured supervisor base URL. */
  api_url: string
  /** Whether the lifecycle SSE has an open socket. */
  lifecycle_connected: boolean
  /** ISO timestamp of the most recent lifecycle event observed. */
  lifecycle_last_event_at?: string
  /** Active and recently-retired sessions. */
  sessions: GascityRuntimeSession[]
  /** Cumulative frames the writer has accepted across all sessions for this city. */
  frames_total: number
}

/**
 * Top-level shape the gascity source flushes to
 * `~/.collectivus/runtime/gascity-state.json`. Versioned so a future
 * schema migration can fail fast if a new CLI reads an older snapshot.
 */
export interface GascityRuntimeState {
  /** Schema version; bumped on incompatible changes. */
  schema_version: number
  /** ISO timestamp the snapshot was rendered. */
  updated_at: string
  /** Configured cities and their per-session state. */
  cities: GascityRuntimeCity[]
}
