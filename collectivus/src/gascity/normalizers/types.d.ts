/**
 * A single normalized row destined for the `gascity_messages` parquet table.
 *
 * Grain: one row per content part within a frame. A multi-part assistant
 * message (e.g. thinking + tool_use) produces multiple rows that share
 * `(provider_session_id, provider_uuid, message_id)` but carry distinct
 * `part_index` values. Frames that carry no `content[]` (e.g. `last-prompt`,
 * `ai-title`, `attachment`, lifecycle-style frames) produce exactly one row
 * with `part_index = 0` and `part_type` describing the frame.
 *
 * Bead 3 owns the on-disk schema; this type is the wire contract between the
 * normalizer (bead 2 / bead 4) and the parquet writer (bead 3). Column types
 * are documented inline; nullable fields use `T | null` (we surface JSON
 * `null` rather than omitting keys so parquet writes are dense and
 * order-stable across rows).
 */
export interface NormalizedRow {
  // ---------- session identity (stamped from SessionContext) ----------
  /** Increments when the wire format changes. Bead 2/3 ship v1. */
  schema_version: number
  /** Configured gascity name (e.g. `hyptown`). */
  city: string
  /** Provider-side session id (mirrors `provider_session_id`). */
  gascity_session_id: string
  /** Session template path (`desktop/<rig>.<alias>`), if known. */
  gascity_template: string | null
  /** Rig the session belongs to, if known. */
  gascity_rig: string | null
  /** Alias the session is registered under, if known. */
  gascity_alias: string | null
  /** Constant `gascity-scribe` so cross-source queries can filter by source. */
  gateway_id: string
  /** Provider tag (`claude`, `codex`, ...). */
  provider: string
  /** Provider-side session id (mirrors `gascity_session_id`). */
  provider_session_id: string
  /** Date partition key (`YYYY-MM-DD` from `message_created_at`). */
  date: string

  // ---------- frame identity ----------
  /** Per-frame UUID (Claude `uuid` field). */
  provider_uuid: string
  /** Anthropic API message id (`msg_*`) — present on assistant frames only. */
  message_id: string | null
  /** Zero-based block index inside `message.content[]`; 0 for single-row frames. */
  part_index: number
  /**
   * Block-or-frame type. The vocabulary is the union of values emitted by
   * every registered provider normalizer; new providers extend it without a
   * schema bump because the column is plain string.
   *
   * Claude-shared (cross-provider, queries can target uniformly):
   *   - `text` — assistant/user content text block
   *   - `thinking` — assistant reasoning text + signature
   *   - `tool_use` — outgoing tool call (Claude tool_use / Codex
   *     function_call / Codex custom_tool_call)
   *   - `tool_result` — incoming tool response (Claude tool_result / Codex
   *     function_call_output / Codex custom_tool_call_output)
   *
   * Claude-only (proxy/native Claude shapes):
   *   - `attachment` — hook output, skill listing, task reminder, etc.
   *   - `last-prompt`, `permission-mode`, `file-history-snapshot`,
   *     `queue-operation`, `ai-title`, `system`
   *
   * Codex-only (Codex CLI session-log shapes):
   *   - `session_meta` — one-per-session header (cwd, cli_version, git)
   *   - `turn_context` — per-turn model/sandbox/approval-policy header
   *   - `agent_message`, `user_message` — eventized stream copies of the
   *     `response_item.message` rows, kept for rate/timing queries
   *   - `task_started`, `task_complete` — per-turn lifecycle (duration_ms,
   *     time_to_first_token_ms in attributes)
   *   - `token_count` — periodic usage snapshot with rate_limits
   *   - `patch_apply_end` — `apply_patch` tool result with unified diff
   *   - `context_compacted`, `item_completed`, `compacted` — lifecycle
   *
   * Passthrough (unknown provider):
   *   - `raw_frame` — bead-3 passthrough one-row-per-frame fallback
   *   - `unknown` — never emitted by production normalizers (any unmapped
   *     frame surfaces its native `type` string instead)
   */
  part_type: string

  // ---------- outer-frame hoist ----------
  /** Working directory when the frame was emitted. */
  cwd: string | null
  /** Git branch resolved at frame time. */
  git_branch: string | null
  /** Permission mode in effect (`default` / `bypassPermissions` / ...). */
  permission_mode: string | null
  /** True for sidechain (subagent) frames. */
  is_sidechain: boolean | null
  /** CLI entrypoint (`cli`, `sdk`, ...). */
  entrypoint: string | null
  /** Claude client version string. */
  client_version: string | null
  /** Prompt id grouping user/assistant turns. */
  prompt_id: string | null
  /** Anthropic API request id. */
  request_id: string | null
  /** Parent frame UUID. */
  parent_uuid: string | null
  /** UUID of the originating tool_use frame (for tool_result rows). */
  source_tool_assistant_uuid: string | null
  /** Frame timestamp (ISO 8601 string). */
  message_created_at: string
  /** First frame timestamp seen for this session (carried via SessionContext). */
  conversation_started_at: string | null

  // ---------- assistant `message.*` hoist ----------
  /** Anthropic model id (e.g. `claude-opus-4-7`). */
  model: string | null
  /** Stop reason on assistant turns. */
  stop_reason: string | null
  /** Detailed stop info as JSON (when the model returns one). */
  stop_details: unknown
  /** Token usage breakdown. */
  input_tokens: number | null
  output_tokens: number | null
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
  ephemeral_1h_input_tokens: number | null
  ephemeral_5m_input_tokens: number | null
  /** API service tier. */
  service_tier: string | null
  /** Inference region label. */
  inference_geo: string | null
  /** API speed mode (`standard` / `priority`). */
  speed: string | null

  // ---------- content-block specific ----------
  /** Plain text (`text`, `thinking`, flattened `tool_result`, `attachment` content,
   * `permission-mode` new mode, `ai-title` title, `user` string-content). */
  content_text: string | null
  /** Cryptographic signature accompanying `thinking` blocks. */
  thinking_signature: string | null
  /** Tool name for `tool_use` rows. */
  tool_name: string | null
  /** Tool call id (matches `tool_result.tool_use_id`). */
  tool_call_id: string | null
  /** Tool arguments JSON for `tool_use` rows. */
  tool_args: unknown
  /** Caller type for tool_use (e.g. `direct`, `subagent`). */
  caller_type: string | null
  /** Tool call id this `tool_result` belongs to. */
  tool_result_for: string | null
  /** True when the tool result represents an error. */
  is_error: boolean | null
  /** Attachment kind (`hook_success`, `skill_listing`, ...). */
  attachment_type: string | null
  /** Hook event name (e.g. `SessionStart`, `Stop`). */
  hook_event: string | null

  // ---------- overflow + safety net ----------
  /** Unmapped fields land here as JSON so future analyses can mine them. */
  attributes: unknown
  /** The complete original frame, verbatim. */
  raw_frame: unknown
}

/** Functions registered on the dispatcher implement this signature. */
export type NormalizerFn = (
  frame: unknown,
  ctx: import('../types.d.ts').SessionContext,
) => NormalizedRow[]
