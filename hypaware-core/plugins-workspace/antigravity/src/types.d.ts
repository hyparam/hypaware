/**
 * Shared types for the `@hypaware/antigravity` and `@hypaware/antigravity-desktop`
 * collectors.
 */

/**
 * One row of Antigravity's `conversation_summaries` SQLite table in
 * `<appDataDir>/conversation_summaries.db`, or a synthesized summary when
 * discovered via directory scan of `<appDataDir>/brain/<conversation-id>`.
 */
export interface AntigravitySummaryRow {
  /** Conversation UUID (`<conversation-id>`). */
  conversation_id: string
  /** Human-readable conversation title, when recorded. */
  title: string | null
  /** Number of steps recorded in the summary row. */
  step_count: number
  /** Last modified timestamp (ISO-8601 string) from the summary row, if present. */
  last_modified_time: string | null
  /** Serialized JSON array of `file://` workspace URIs (e.g. `["file:///path/to/repo"]`). */
  workspace_uris: string | null
  /** Conversation status (e.g. `CASCADE_RUN_STATUS_IDLE`, `CASCADE_RUN_STATUS_RUNNING`). */
  status: string | null
  /** Trajectory source (e.g. `CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT`, `CORTEX_TRAJECTORY_SOURCE_CLI`). */
  source: string | null
  /** Subagent role/name when spawned as a subagent. */
  agent_name: string | null
  /** Parent conversation UUID when spawned as a subagent. */
  parent_conversation_id: string | null
  /** Nesting depth (0 for top-level conversations, > 0 for subagents). */
  nesting_depth: number
  /** Last user input timestamp (ISO-8601 string), if present. */
  last_user_input_time: string | null
  /** App data directory recorded on the summary row, if present. */
  app_data_dir: string | null
}

/**
 * One tool call entry on a `PLANNER_RESPONSE` transcript step.
 */
export interface AntigravityTranscriptToolCall {
  name?: string
  args?: Record<string, unknown> | string
}

/**
 * One JSONL line from `<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl`
 * (or `transcript.jsonl`).
 */
export interface AntigravityTranscriptStep {
  step_index?: number
  type?: string
  source?: string
  status?: string
  created_at?: string
  completed_at?: string
  content?: string
  thinking?: string
  error?: string
  input_tokens?: number
  cache_read_tokens?: number
  output_tokens?: number
  tool_calls?: AntigravityTranscriptToolCall[]
}

/**
 * Per-conversation watermark stored by the poll source in `watermark.json`.
 */
export interface AntigravityConversationWatermark {
  /** Transcript file size in bytes as of the last projection. */
  size: number
  /** Transcript file mtimeMs as of the last projection. */
  mtime_ms: number
  /** `step_count` from `conversation_summaries.db` as of the last projection. */
  step_count: number
}

/**
 * Full persisted watermark state (`conversation_id -> watermark`) for one
 * Antigravity appDataDir.
 */
export type AntigravityWatermarkState = Record<string, AntigravityConversationWatermark>

/**
 * File-level stat fingerprint cached in-memory by the backfill provider so
 * scheduled sweeps skip unchanged transcript files without re-reading JSONL.
 */
export interface AntigravityTranscriptFingerprint {
  ino: number
  size: number
  mtimeMs: number
  stepCount: number
}

/**
 * Options for bounded SQLITE_BUSY retry in `summaries_db.js`.
 */
export interface AntigravityBusyRetryOptions {
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Options for `readAntigravitySummaries`.
 */
export interface AntigravitySummariesOptions extends AntigravityBusyRetryOptions {
  requireFn?: (id: string) => unknown
  excludeCliSyncedSummaries?: boolean
}

/**
 * Variant descriptor parameterizing `@hypaware/antigravity` (CLI) and
 * `@hypaware/antigravity-desktop` (Desktop).
 */
export interface AntigravityVariantOptions {
  /** Plugin name (`@hypaware/antigravity` or `@hypaware/antigravity-desktop`). */
  pluginName: '@hypaware/antigravity' | '@hypaware/antigravity-desktop'
  /** Client / source / backfill provider name (`antigravity` or `antigravity-desktop`). */
  clientName: 'antigravity' | 'antigravity-desktop'
  /** Config section name (`antigravity` or `antigravity_desktop`). */
  configSectionName: 'antigravity' | 'antigravity_desktop'
  /** Default home-relative appDataDir (`.gemini/antigravity-cli` or `.gemini/antigravity`). */
  defaultAppDataSubdir: string
  /** Default entrypoint stamped on projected rows (`cli` or `desktop`). */
  entrypoint: 'cli' | 'desktop'
  /** Whether to exclude `CORTEX_TRAJECTORY_SOURCE_CLI` rows synced into Desktop's summary DB. */
  excludeCliSyncedSummaries: boolean
}
