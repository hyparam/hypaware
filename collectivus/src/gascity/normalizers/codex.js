/**
 * Codex provider normalizer. Transforms Codex CLI session log frames (as
 * forwarded by the gascity supervisor's `format=raw` stream) into rows that
 * match the `gascity_messages` schema declared in `./types.d.ts`.
 *
 * Codex stores one JSONL per session under `~/.codex/sessions/YYYY/MM/DD/`.
 * Each line is `{ timestamp, type, payload }` where `type` is one of
 * `session_meta`, `turn_context`, `response_item`, `event_msg`, `compacted`.
 * The provider-native shape diverges from Claude in several ways:
 *
 *   1. Frames carry no per-frame UUID — the schema requires `provider_uuid`,
 *      so we synthesize a deterministic content-hash uuid (sha1 of the frame
 *      JSON, 16-hex prefix). Re-reading the same line yields the same hash,
 *      keeping the writer's dedup idempotent across restarts and backfills.
 *   2. Multi-block messages share one frame; per the bead-2 Claude
 *      precedent, sibling rows share `provider_uuid` and differ in
 *      `part_index`. The writer's dedup is keyed only on `provider_uuid`
 *      today (latent bug — see closing notes), so multi-block frames lose
 *      siblings until that's fixed; the on-disk grain matches Claude.
 *   3. Tool calls live in `response_item.function_call` /
 *      `custom_tool_call` (and matching `*_output` frames). The `call_id`
 *      is preserved on tool_use rows and used as `tool_result_for` on the
 *      matching tool_result row, mirroring Claude's `tool_use_id` linkage.
 *   4. Reasoning content is usually encrypted (`encrypted_content`) — we
 *      surface that blob in `attributes` so a future bead with decrypt
 *      access can recover it; readable `content` / `summary` fields drop
 *      into `content_text` when present.
 *   5. Token usage uses Codex's vocabulary (`input_tokens`,
 *      `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`,
 *      `total_tokens`) — we hoist the overlapping columns onto Claude-
 *      shaped slots and keep the full block under `attributes.info` so the
 *      Codex-only counters (reasoning, total) survive round-trip.
 *   6. Permission state lives in `turn_context.approval_policy` /
 *      `sandbox_policy`; these don't map cleanly to Claude's
 *      `permission_mode` so we leave that column NULL and stash the policy
 *      blocks in `attributes`. Per bead spec: "Codex lacks a field present
 *      in Claude (...): leave NULL. Do not invent placeholders."
 *
 * Pure function: no I/O, no shared state, no exceptions for malformed input
 * — anything we don't understand is preserved verbatim in `raw_frame` and
 * surfaced through `attributes` overflow so a follow-up bead's query can
 * still find it.
 *
 */

import { createHash } from 'node:crypto'

/**
 * @import { SessionContext } from '../types.d.ts'
 * @import { NormalizedRow } from './types.d.ts'
 */

export const CODEX_SCHEMA_VERSION = 1
export const CODEX_GATEWAY_ID = 'gascity-scribe'
export const CODEX_PROVIDER = 'codex'

/** Outer-frame keys hoisted onto typed columns or used by the dispatcher. */
const KNOWN_OUTER_KEYS = new Set(['type', 'timestamp', 'payload'])

/**
 * Normalize a Codex session frame into one or more rows.
 *
 * @param {unknown} frame Raw Codex frame as parsed from the supervisor's
 *   `format=raw` SSE `data:` payload.
 * @param {SessionContext} ctx Per-session metadata (city, alias, ...).
 * @returns {NormalizedRow[]}
 */
export function codexNormalize(frame, ctx) {
  if (!isObject(frame)) return []
  const type = typeof frame.type === 'string' ? frame.type : 'unknown'
  switch (type) {
  case 'session_meta':
    return normalizeSessionMeta(frame, ctx)
  case 'turn_context':
    return normalizeTurnContext(frame, ctx)
  case 'response_item':
    return normalizeResponseItem(frame, ctx)
  case 'event_msg':
    return normalizeEventMsg(frame, ctx)
  case 'compacted':
    return normalizeCompacted(frame, ctx)
  default:
    return [makeBaseRow(frame, ctx, 0, {
      part_type: type,
      attributes: { unhandled_type: type, frame: clone(frame) },
    })]
  }
}

/**
 * `session_meta` frame → one row. Hoists `cwd`, `cli_version`, `source` (as
 * entrypoint) and `git.branch` onto typed columns; the rest of the payload
 * (base instructions text, git commit/url, originator, ...) lands in
 * `attributes` so cross-session analyses can recover it.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeSessionMeta(frame, ctx) {
  const payload = isObject(frame.payload) ? frame.payload : {}
  const git = isObject(payload.git) ? payload.git : null
  return [makeBaseRow(frame, ctx, 0, {
    part_type: 'session_meta',
    cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
    git_branch: git && typeof git.branch === 'string' ? git.branch : null,
    entrypoint: typeof payload.source === 'string' ? payload.source : null,
    client_version: typeof payload.cli_version === 'string' ? payload.cli_version : null,
    attributes: {
      session_payload_id: typeof payload.id === 'string' ? payload.id : null,
      payload_timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : null,
      originator: typeof payload.originator === 'string' ? payload.originator : null,
      thread_source: typeof payload.thread_source === 'string' ? payload.thread_source : null,
      model_provider: typeof payload.model_provider === 'string' ? payload.model_provider : null,
      base_instructions: clone(payload.base_instructions ?? null),
      git: clone(git),
    },
  })]
}

/**
 * `turn_context` frame → one row. Codex emits one per turn carrying the
 * current model + reasoning effort + sandbox/approval policy. We hoist
 * `model` and `cwd` onto typed columns. The policy blocks have no Claude
 * analog so they stay in `attributes`.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeTurnContext(frame, ctx) {
  const payload = isObject(frame.payload) ? frame.payload : {}
  return [makeBaseRow(frame, ctx, 0, {
    part_type: 'turn_context',
    model: typeof payload.model === 'string' ? payload.model : null,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
    attributes: {
      turn_id: typeof payload.turn_id === 'string' ? payload.turn_id : null,
      current_date: typeof payload.current_date === 'string' ? payload.current_date : null,
      timezone: typeof payload.timezone === 'string' ? payload.timezone : null,
      approval_policy: payload.approval_policy ?? null,
      sandbox_policy: clone(payload.sandbox_policy ?? null),
      file_system_sandbox_policy: clone(payload.file_system_sandbox_policy ?? null),
      permission_profile: clone(payload.permission_profile ?? null),
      collaboration_mode: payload.collaboration_mode ?? null,
      effort: payload.effort ?? null,
      personality: clone(payload.personality ?? null),
      realtime_active: payload.realtime_active ?? null,
      summary: payload.summary ?? null,
      truncation_policy: clone(payload.truncation_policy ?? null),
      user_instructions: clone(payload.user_instructions ?? null),
      model_family: payload.model_family ?? null,
      reasoning_summary: payload.reasoning_summary ?? null,
      base_instructions: clone(payload.base_instructions ?? null),
    },
  })]
}

/**
 * `response_item` frame → 1+ rows depending on the wrapped item type. The
 * envelope is `{ type: 'response_item', payload: { type: '<item>', ... } }`
 * so we lookup on `payload.type`.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeResponseItem(frame, ctx) {
  const payload = isObject(frame.payload) ? frame.payload : {}
  const itemType = typeof payload.type === 'string' ? payload.type : 'unknown'
  switch (itemType) {
  case 'message':
    return normalizeMessage(frame, payload, ctx)
  case 'function_call':
  case 'custom_tool_call':
    return normalizeToolCall(frame, payload, ctx, itemType)
  case 'function_call_output':
  case 'custom_tool_call_output':
    return normalizeToolCallOutput(frame, payload, ctx, itemType)
  case 'reasoning':
    return normalizeReasoning(frame, payload, ctx)
  default:
    return [makeBaseRow(frame, ctx, 0, {
      part_type: itemType,
      attributes: { unhandled_item_type: itemType, payload: clone(payload) },
    })]
  }
}

/**
 * `response_item.message` → one row per `content[]` block, mirroring
 * Claude's assistant/user grain. `role` and `phase` (commentary /
 * final_answer for assistants) drop into `attributes` so queries can filter
 * by role without inspecting `raw_frame`.
 *
 * @param {Record<string, unknown>} frame
 * @param {Record<string, unknown>} payload
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeMessage(frame, payload, ctx) {
  const role = typeof payload.role === 'string' ? payload.role : null
  const phase = typeof payload.phase === 'string' ? payload.phase : null
  const content = Array.isArray(payload.content) ? payload.content : []
  if (content.length === 0) {
    return [makeBaseRow(frame, ctx, 0, {
      part_type: 'text',
      attributes: { role, phase, message: clone(payload) },
    })]
  }
  return content.map((block, index) =>
    makeBaseRow(frame, ctx, index, projectMessageBlock(block, role, phase))
  )
}

/**
 * Codex message content blocks: `input_text` (user / developer) and
 * `output_text` (assistant). Other shapes round-trip through `attributes`.
 *
 * @param {unknown} block
 * @param {string | null} role
 * @param {string | null} phase
 * @returns {Partial<NormalizedRow> & { attributes?: unknown }}
 */
function projectMessageBlock(block, role, phase) {
  if (typeof block === 'string') {
    return { part_type: 'text', content_text: block, attributes: { role, phase } }
  }
  if (!isObject(block)) {
    return {
      part_type: 'text',
      content_text: null,
      attributes: { role, phase, malformed_block: clone(block) },
    }
  }
  const t = typeof block.type === 'string' ? block.type : 'unknown'
  switch (t) {
  case 'input_text':
  case 'output_text':
    return {
      part_type: 'text',
      content_text: typeof block.text === 'string' ? block.text : null,
      attributes: { role, phase, block_type: t },
    }
  default:
    return {
      part_type: t,
      attributes: { role, phase, unhandled_block_type: t, block: clone(block) },
    }
  }
}

/**
 * Tool call frame → one `tool_use` row. Codex serialises tool arguments as
 * a JSON string (`function_call.arguments`) or a free-form string
 * (`custom_tool_call.input` — e.g. apply_patch's diff text); we attempt a
 * `JSON.parse` for the function_call shape and fall back to the raw string
 * so the column stays queryable.
 *
 * @param {Record<string, unknown>} frame
 * @param {Record<string, unknown>} payload
 * @param {SessionContext} ctx
 * @param {string} variant `function_call` or `custom_tool_call`
 * @returns {NormalizedRow[]}
 */
function normalizeToolCall(frame, payload, ctx, variant) {
  const callId = typeof payload.call_id === 'string' ? payload.call_id : null
  const name = typeof payload.name === 'string' ? payload.name : null
  /** @type {unknown} */
  const argsRaw = variant === 'custom_tool_call' ? payload.input : payload.arguments
  const toolArgs = parseToolArgs(argsRaw)
  return [makeBaseRow(frame, ctx, 0, {
    part_type: 'tool_use',
    tool_name: name,
    tool_call_id: callId,
    tool_args: toolArgs,
    attributes: {
      tool_call_variant: variant,
      status: typeof payload.status === 'string' ? payload.status : null,
      original_args_form: typeof argsRaw,
      // Preserve the raw text form when JSON parsing succeeded so callers
      // who need the exact byte-stream (e.g. apply_patch diffs) can recover
      // it without re-stringifying.
      raw_args: typeof argsRaw === 'string' ? argsRaw : null,
    },
  })]
}

/**
 * Tool call output frame → one `tool_result` row. The `output` field is
 * either a string (custom_tool_call_output, function_call_output for
 * simple text returns) or a structured JSON object — we keep the original
 * shape via `raw_frame` and surface a string representation in
 * `content_text`.
 *
 * @param {Record<string, unknown>} frame
 * @param {Record<string, unknown>} payload
 * @param {SessionContext} ctx
 * @param {string} variant `function_call_output` or `custom_tool_call_output`
 * @returns {NormalizedRow[]}
 */
function normalizeToolCallOutput(frame, payload, ctx, variant) {
  const callId = typeof payload.call_id === 'string' ? payload.call_id : null
  return [makeBaseRow(frame, ctx, 0, {
    part_type: 'tool_result',
    tool_result_for: callId,
    content_text: flattenOutput(payload.output),
    is_error: detectToolError(payload),
    attributes: {
      tool_call_variant: variant,
      output_form: typeof payload.output,
    },
  })]
}

/**
 * Codex tool outputs don't carry an explicit `is_error` flag; for the
 * function_call_output flavour we can sometimes infer it by parsing the
 * JSON `output` for a non-zero `metadata.exit_code`. Conservatively returns
 * null when we can't tell — analysts can grep `content_text` for the rare
 * cases that matter.
 *
 * @param {Record<string, unknown>} payload
 * @returns {boolean | null}
 */
function detectToolError(payload) {
  const out = payload.output
  if (typeof out !== 'string') return null
  // Cheap path: function_call_output wraps in a JSON envelope when invoked
  // via exec_command — `{"output":"...","metadata":{"exit_code":N,...}}`.
  if (!out.startsWith('{')) return null
  try {
    const parsed = JSON.parse(out)
    if (!isObject(parsed)) return null
    const meta = isObject(parsed.metadata) ? parsed.metadata : null
    if (meta && typeof meta.exit_code === 'number') {
      return meta.exit_code !== 0
    }
  } catch { /* not JSON — leave as null */ }
  return null
}

/**
 * Reasoning frame → one `thinking` row. Codex returns reasoning encrypted
 * by default (`encrypted_content` blob) and only surfaces a readable
 * `summary` / `content` when the API is configured to. We preserve all
 * three so a future decrypt step can populate `content_text` post-hoc.
 *
 * @param {Record<string, unknown>} frame
 * @param {Record<string, unknown>} payload
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeReasoning(frame, payload, ctx) {
  const summary = Array.isArray(payload.summary) ? payload.summary : []
  const content = typeof payload.content === 'string' ? payload.content : null
  const contentText = content ?? renderReasoningSummary(summary)
  return [makeBaseRow(frame, ctx, 0, {
    part_type: 'thinking',
    content_text: contentText,
    attributes: {
      encrypted_content: typeof payload.encrypted_content === 'string' ? payload.encrypted_content : null,
      summary: clone(summary),
      raw_content: content,
    },
  })]
}

/**
 * Flatten Codex's `summary` array (each entry usually `{type:'summary_text', text}`)
 * into a single string for `content_text`. Returns null when the summary is
 * empty so the column stays sparse for the (common) encrypted-only case.
 *
 * @param {unknown[]} summary
 * @returns {string | null}
 */
function renderReasoningSummary(summary) {
  if (summary.length === 0) return null
  /** @type {string[]} */
  const parts = []
  for (const item of summary) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    if (!isObject(item)) continue
    if (typeof item.text === 'string') {
      parts.push(item.text)
      continue
    }
    try { parts.push(JSON.stringify(item)) } catch { /* skip */ }
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/**
 * `event_msg` frame → one row tagged with a Codex-specific `part_type`
 * derived from `payload.type`. The events are mostly lifecycle/telemetry
 * (token counts, task_started/complete, patch_apply, ...) so most of the
 * payload lands in `attributes`. Where a column maps naturally
 * (`token_count.info.last_token_usage` → token columns) we hoist; otherwise
 * we preserve the payload under `attributes`.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeEventMsg(frame, ctx) {
  const payload = isObject(frame.payload) ? frame.payload : {}
  const eventType = typeof payload.type === 'string' ? payload.type : 'unknown'
  switch (eventType) {
  case 'agent_message':
    return [makeBaseRow(frame, ctx, 0, {
      part_type: 'agent_message',
      content_text: typeof payload.message === 'string' ? payload.message : null,
      attributes: {
        phase: typeof payload.phase === 'string' ? payload.phase : null,
        memory_citation: clone(payload.memory_citation ?? null),
      },
    })]
  case 'user_message':
    return [makeBaseRow(frame, ctx, 0, {
      part_type: 'user_message',
      content_text: typeof payload.message === 'string' ? payload.message : null,
      attributes: {
        images: clone(payload.images ?? null),
        local_images: clone(payload.local_images ?? null),
        text_elements: clone(payload.text_elements ?? null),
      },
    })]
  case 'task_started':
    return [makeBaseRow(frame, ctx, 0, {
      part_type: 'task_started',
      attributes: {
        turn_id: typeof payload.turn_id === 'string' ? payload.turn_id : null,
        started_at: payload.started_at ?? null,
        model_context_window: payload.model_context_window ?? null,
        collaboration_mode_kind: typeof payload.collaboration_mode_kind === 'string' ? payload.collaboration_mode_kind : null,
      },
    })]
  case 'task_complete':
    return [makeBaseRow(frame, ctx, 0, {
      part_type: 'task_complete',
      content_text: typeof payload.last_agent_message === 'string' ? payload.last_agent_message : null,
      attributes: {
        turn_id: typeof payload.turn_id === 'string' ? payload.turn_id : null,
        completed_at: payload.completed_at ?? null,
        duration_ms: payload.duration_ms ?? null,
        time_to_first_token_ms: payload.time_to_first_token_ms ?? null,
      },
    })]
  case 'token_count':
    return normalizeTokenCount(frame, payload, ctx)
  case 'patch_apply_end':
    return normalizePatchApplyEnd(frame, payload, ctx)
  case 'context_compacted':
    return [makeBaseRow(frame, ctx, 0, { part_type: 'context_compacted' })]
  case 'item_completed':
    return [makeBaseRow(frame, ctx, 0, {
      part_type: 'item_completed',
      attributes: {
        thread_id: typeof payload.thread_id === 'string' ? payload.thread_id : null,
        turn_id: typeof payload.turn_id === 'string' ? payload.turn_id : null,
        completed_at_ms: payload.completed_at_ms ?? null,
        item: clone(payload.item ?? null),
      },
    })]
  default:
    return [makeBaseRow(frame, ctx, 0, {
      part_type: eventType,
      attributes: { unhandled_event_type: eventType, payload: clone(payload) },
    })]
  }
}

/**
 * `token_count` → one row with the `last_token_usage` block hoisted onto
 * the schema's token columns. `cached_input_tokens` maps to
 * `cache_read_input_tokens` (Claude vocabulary); reasoning + total counters
 * are Codex-only and survive via `attributes.info`.
 *
 * @param {Record<string, unknown>} frame
 * @param {Record<string, unknown>} payload
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeTokenCount(frame, payload, ctx) {
  const info = isObject(payload.info) ? payload.info : null
  const last = info && isObject(info.last_token_usage) ? info.last_token_usage : null
  /** @type {Partial<NormalizedRow>} */
  const hoist = {
    input_tokens: last ? numOrNull(last.input_tokens) : null,
    output_tokens: last ? numOrNull(last.output_tokens) : null,
    cache_read_input_tokens: last ? numOrNull(last.cached_input_tokens) : null,
  }
  return [makeBaseRow(frame, ctx, 0, {
    part_type: 'token_count',
    ...hoist,
    attributes: {
      info: clone(info),
      rate_limits: clone(payload.rate_limits ?? null),
    },
  })]
}

/**
 * `patch_apply_end` → one row. `success=true` maps to `is_error=false` and
 * vice-versa so cross-source queries can filter `WHERE is_error=true` across
 * Claude tool_results and Codex patch applications uniformly. The unified
 * diff lives in `attributes.changes` for tooling that wants to walk it.
 *
 * @param {Record<string, unknown>} frame
 * @param {Record<string, unknown>} payload
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizePatchApplyEnd(frame, payload, ctx) {
  const success = typeof payload.success === 'boolean' ? payload.success : null
  return [makeBaseRow(frame, ctx, 0, {
    part_type: 'patch_apply_end',
    content_text: typeof payload.stdout === 'string' ? payload.stdout : null,
    is_error: success === null ? null : !success,
    tool_result_for: typeof payload.call_id === 'string' ? payload.call_id : null,
    attributes: {
      turn_id: typeof payload.turn_id === 'string' ? payload.turn_id : null,
      stderr: typeof payload.stderr === 'string' ? payload.stderr : null,
      changes: clone(payload.changes ?? null),
      status: typeof payload.status === 'string' ? payload.status : null,
    },
  })]
}

/**
 * `compacted` frame → one row. Codex emits this when the running thread
 * is compacted; we preserve the replacement history under `attributes` so
 * downstream analyses can replay the post-compaction conversation.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeCompacted(frame, ctx) {
  const payload = isObject(frame.payload) ? frame.payload : {}
  return [makeBaseRow(frame, ctx, 0, {
    part_type: 'compacted',
    content_text: typeof payload.message === 'string' ? payload.message : null,
    attributes: {
      replacement_history: clone(payload.replacement_history ?? null),
    },
  })]
}

/**
 * Flatten the `output` field of a tool result into `content_text`. Strings
 * pass through; objects/arrays are JSON-stringified so the column stays
 * queryable (the structured form is still available via `raw_frame`).
 *
 * @param {unknown} output
 * @returns {string | null}
 */
function flattenOutput(output) {
  if (typeof output === 'string') return output
  if (output === null || output === undefined) return null
  try { return JSON.stringify(output) } catch { return String(output) }
}

/**
 * Attempt to parse Codex's tool-arg JSON string into a structured value so
 * `tool_args` queries can use `json_value(...)` instead of regex. Non-JSON
 * input (e.g. `apply_patch`'s diff string) round-trips as-is.
 *
 * @param {unknown} raw
 * @returns {unknown}
 */
function parseToolArgs(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return raw
  if (raw.length === 0) return raw
  const first = raw.charAt(0)
  if (first !== '{' && first !== '[') return raw
  try { return JSON.parse(raw) } catch { return raw }
}

/**
 * Build the shared base row from outer-frame fields, then merge the supplied
 * overrides. All keys land deterministically — column order in the writer
 * (bead 3) can rely on this object key set.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @param {number} partIndex
 * @param {Partial<NormalizedRow> & { attributes?: unknown }} overrides
 * @returns {NormalizedRow}
 */
function makeBaseRow(frame, ctx, partIndex, overrides) {
  const timestamp = pickIso(frame.timestamp) ?? syntheticTimestamp()
  const uuid = frameUuid(frame)
  /** @type {NormalizedRow} */
  const base = {
    schema_version: CODEX_SCHEMA_VERSION,
    city: ctx.city,
    gascity_session_id: ctx.sessionId,
    gascity_template: ctx.template ?? null,
    gascity_rig: ctx.rig ?? null,
    gascity_alias: ctx.alias ?? null,
    gateway_id: CODEX_GATEWAY_ID,
    provider: CODEX_PROVIDER,
    provider_session_id: ctx.sessionId,
    date: timestamp.slice(0, 10),

    provider_uuid: uuid,
    message_id: null,
    part_index: partIndex,
    part_type: 'unknown',

    cwd: null,
    git_branch: null,
    permission_mode: null,
    is_sidechain: null,
    entrypoint: null,
    client_version: null,
    prompt_id: null,
    request_id: null,
    parent_uuid: null,
    source_tool_assistant_uuid: null,
    message_created_at: timestamp,
    conversation_started_at: ctx.conversationStartedAt ?? null,

    model: null,
    stop_reason: null,
    stop_details: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    ephemeral_1h_input_tokens: null,
    ephemeral_5m_input_tokens: null,
    service_tier: null,
    inference_geo: null,
    speed: null,

    content_text: null,
    thinking_signature: null,
    tool_name: null,
    tool_call_id: null,
    tool_args: null,
    caller_type: null,
    tool_result_for: null,
    is_error: null,
    attachment_type: null,
    hook_event: null,

    attributes: null,
    raw_frame: clone(frame),
  }
  const merged = { ...base, ...overrides }
  // Always include outer-frame overflow alongside overrides — Codex's outer
  // envelope is sparse (`type`/`timestamp`/`payload`) but a future schema
  // tweak that adds top-level fields should not silently disappear.
  merged.attributes = mergeAttributes(frameAttributes(frame), overrides.attributes)
  return merged
}

/**
 * Synthesize a stable per-frame uuid from a sha-1 hash of the JSON-
 * serialised frame. Same input bytes → same hash, so re-reading the same
 * JSONL line after a daemon restart produces the same uuid and the
 * writer's dedup collapses the overlap (mirrors how Claude's `uuid` field
 * is used).
 *
 * We hash the truncated hex (40 chars) — collision probability for a
 * single 1M-frame session is ~10^-18 (birthday bound). Returns the
 * empty string when serialisation fails (extremely defensive — JSON
 * frames are always serialisable).
 *
 * @param {Record<string, unknown>} frame
 * @returns {string}
 */
function frameUuid(frame) {
  let serialised
  try { serialised = JSON.stringify(frame) } catch { return '' }
  if (typeof serialised !== 'string') return ''
  return createHash('sha1').update(serialised).digest('hex')
}

/**
 * Build the `attributes` JSON payload from outer-frame overflow. Codex's
 * outer envelope is tight (`type`, `timestamp`, `payload`) so overflow is
 * usually empty, but a forward-compatible field would land here without
 * silently disappearing.
 *
 * @param {Record<string, unknown>} frame
 * @returns {Record<string, unknown>}
 */
function frameAttributes(frame) {
  /** @type {Record<string, unknown>} */
  const overflow = {}
  for (const [k, v] of Object.entries(frame)) {
    if (KNOWN_OUTER_KEYS.has(k)) continue
    overflow[k] = clone(v)
  }
  return overflow
}

/**
 * Merge two attribute payloads. Returns null if both are empty so the
 * column stores null rather than `{}` (writer-side compression benefits
 * from sparse nullable columns).
 *
 * @param {Record<string, unknown> | null | undefined} a
 * @param {unknown} b
 * @returns {Record<string, unknown> | null}
 */
function mergeAttributes(a, b) {
  const merged = { ...(a ?? {}), ...(isObject(b) ? b : b == null ? {} : { _override: b }) }
  return Object.keys(merged).length === 0 ? null : merged
}

/**
 * Coerce `timestamp` to an ISO 8601 string. Returns undefined if the value
 * isn't parseable; callers use a synthetic value so the column stays
 * non-null.
 *
 * @param {unknown} v
 * @returns {string | undefined}
 */
function pickIso(v) {
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString()
  return undefined
}

/**
 * Synthetic timestamp for frames without one. Matches Claude's choice so
 * cross-source date-partitioning queries treat the two providers
 * identically.
 *
 * @returns {string}
 */
function syntheticTimestamp() {
  return '1970-01-01T00:00:00.000Z'
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function numOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Defensive clone. JSON round-trip is enough — frames are pure JSON.
 *
 * @template T
 * @param {T} v
 * @returns {T}
 */
function clone(v) {
  if (v === null || v === undefined) return v
  return JSON.parse(JSON.stringify(v))
}
