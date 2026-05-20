/**
 * Claude provider normalizer. Transforms Claude Code session log frames (as
 * forwarded by the gascity supervisor's `format=raw` stream) into rows that
 * match the `gascity_messages` schema declared in `./types.d.ts`.
 *
 * Pure function: no I/O, no shared state, no exceptions for malformed input
 * — anything we don't understand is preserved verbatim in `raw_frame` and
 * surfaced through `attributes` overflow so a bead-3 query can still find it.
 *
 * @import { SessionContext } from '../types.d.ts'
 * @import { NormalizedRow } from './types.d.ts'
 */

export const CLAUDE_SCHEMA_VERSION = 1
export const CLAUDE_GATEWAY_ID = 'gascity-scribe'
export const CLAUDE_PROVIDER = 'claude'

/**
 * Outer-frame keys we explicitly hoist into typed columns. Anything else
 * (e.g. `userType`, `toolUseResult`, supervisor-side annotations, future
 * additions) falls into `attributes` so we never silently drop data.
 */
const KNOWN_OUTER_KEYS = new Set([
  'type', 'sessionId', 'uuid', 'parentUuid', 'timestamp', 'cwd', 'gitBranch',
  'permissionMode', 'isSidechain', 'entrypoint', 'version', 'promptId',
  'requestId', 'sourceToolAssistantUUID', 'message', 'attachment',
  'aiTitle', 'leafUuid', 'snapshot', 'messageId', 'isSnapshotUpdate',
  'operation', 'content', 'subtype',
])

/**
 * Normalize a Claude session frame into one or more rows.
 *
 * @param {unknown} frame Raw Claude frame as parsed from the supervisor's
 *   `format=raw` SSE `data:` payload.
 * @param {SessionContext} ctx Per-session metadata (city, alias, ...).
 * @returns {NormalizedRow[]}
 */
export function claudeNormalize(frame, ctx) {
  if (!isObject(frame)) return []
  const type = typeof frame.type === 'string' ? frame.type : 'unknown'
  switch (type) {
  case 'assistant':
    return normalizeAssistant(frame, ctx)
  case 'user':
    return normalizeUser(frame, ctx)
  case 'attachment':
    return normalizeAttachment(frame, ctx)
  case 'last-prompt':
    return normalizeLastPrompt(frame, ctx)
  case 'permission-mode':
    return normalizePermissionMode(frame, ctx)
  case 'file-history-snapshot':
    return normalizeFileHistorySnapshot(frame, ctx)
  case 'queue-operation':
    return normalizeQueueOperation(frame, ctx)
  case 'ai-title':
    return normalizeAiTitle(frame, ctx)
  case 'system':
    return normalizeSystem(frame, ctx)
  default:
    return [makeBaseRow(frame, ctx, { part_type: type, attributes: { unhandled_type: type, frame: clone(frame) } })]
  }
}

/**
 * Assistant frame → one row per content block. Token usage and stop_reason
 * hoist onto every produced row (so a `SELECT sum(input_tokens) ...` over a
 * single message double-counts unless the analyst groups by message_id; this
 * is the same shape `proxy_messages` uses for multi-part assistant turns).
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeAssistant(frame, ctx) {
  const message = isObject(frame.message) ? frame.message : {}
  const messageHoist = hoistMessageFields(message)
  const blocks = Array.isArray(message.content) ? message.content : []
  if (blocks.length === 0) {
    return [makeBaseRow(frame, ctx, { part_type: 'assistant', ...messageHoist })]
  }
  return blocks.map((block, index) =>
    makeBaseRow(frame, ctx, {
      part_index: index,
      ...messageHoist,
      ...projectContentBlock(block),
    })
  )
}

/**
 * User frame → one row per content block when `content` is an array, otherwise
 * one row of `part_type='text'` carrying the string. The Claude CLI uses both
 * shapes interchangeably: bare strings for plain prompts, arrays for
 * tool-result returns that group multiple blocks.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeUser(frame, ctx) {
  const message = isObject(frame.message) ? frame.message : {}
  const content = message.content
  if (typeof content === 'string') {
    return [makeBaseRow(frame, ctx, { part_type: 'text', content_text: content })]
  }
  if (Array.isArray(content) && content.length > 0) {
    return content.map((block, index) =>
      makeBaseRow(frame, ctx, {
        part_index: index,
        ...projectContentBlock(block),
      })
    )
  }
  // Empty / unrecognised user payload: emit one row with the frame in attributes.
  return [makeBaseRow(frame, ctx, { part_type: 'user', attributes: { message: clone(message) } })]
}

/**
 * Attachment frame → one row. `attachment.type` lands on `attachment_type`;
 * `attachment.hookEvent` on `hook_event`; everything else carries through
 * `content_text` (when serialisable) or `attributes` (always).
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeAttachment(frame, ctx) {
  const attachment = isObject(frame.attachment) ? frame.attachment : {}
  const attachmentType = typeof attachment.type === 'string' ? attachment.type : null
  const hookEvent = typeof attachment.hookEvent === 'string' ? attachment.hookEvent : null
  const contentText = renderAttachmentContent(attachment)
  // Strip `content` from attributes only when we successfully rendered it into
  // content_text — otherwise a non-string `content` (e.g. structured
  // task_reminder payload) would land nowhere except raw_frame.
  const dropKeys = ['type', 'hookEvent']
  if (contentText !== null) dropKeys.push('content')
  return [makeBaseRow(frame, ctx, {
    part_type: 'attachment',
    attachment_type: attachmentType,
    hook_event: hookEvent,
    content_text: contentText,
    attributes: stripKey(clone(attachment), ...dropKeys),
  })]
}

/**
 * `last-prompt` frame → one row. The frame carries only `leafUuid` +
 * `sessionId`; the leaf uuid lands in attributes (the spec calls for
 * "content into attributes JSON").
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeLastPrompt(frame, ctx) {
  return [makeBaseRow(frame, ctx, {
    part_type: 'last-prompt',
    attributes: { leafUuid: typeof frame.leafUuid === 'string' ? frame.leafUuid : null },
  })]
}

/**
 * `permission-mode` frame → one row with the new mode in `content_text`. The
 * outer-frame `permission_mode` hoist still runs but the new mode is the
 * payload, so we surface it on `content_text` to make `WHERE part_type='permission-mode'`
 * queries trivial.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizePermissionMode(frame, ctx) {
  const newMode = typeof frame.permissionMode === 'string' ? frame.permissionMode : null
  return [makeBaseRow(frame, ctx, {
    part_type: 'permission-mode',
    content_text: newMode,
    permission_mode: newMode,
  })]
}

/**
 * `file-history-snapshot` frame → one row with the snapshot in attributes.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeFileHistorySnapshot(frame, ctx) {
  return [makeBaseRow(frame, ctx, {
    part_type: 'file-history-snapshot',
    attributes: {
      snapshot: clone(frame.snapshot),
      messageId: typeof frame.messageId === 'string' ? frame.messageId : null,
      isSnapshotUpdate: typeof frame.isSnapshotUpdate === 'boolean' ? frame.isSnapshotUpdate : null,
    },
  })]
}

/**
 * `queue-operation` frame → one row. `operation` + `content` go into
 * attributes per spec.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeQueueOperation(frame, ctx) {
  return [makeBaseRow(frame, ctx, {
    part_type: 'queue-operation',
    attributes: {
      operation: typeof frame.operation === 'string' ? frame.operation : null,
      content: clone(frame.content),
    },
  })]
}

/**
 * `ai-title` frame → one row with the title in `content_text`.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeAiTitle(frame, ctx) {
  return [makeBaseRow(frame, ctx, {
    part_type: 'ai-title',
    content_text: typeof frame.aiTitle === 'string' ? frame.aiTitle : null,
  })]
}

/**
 * `system` frame → one row. Subtype lands in `attributes.subtype`; the rest
 * of the payload (hook info, api errors, turn durations) follows alongside so
 * a `WHERE part_type='system' AND attributes->>'subtype'='api_error'` query
 * works without a schema migration when new subtypes appear.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
function normalizeSystem(frame, ctx) {
  const subtype = typeof frame.subtype === 'string' ? frame.subtype : null
  return [makeBaseRow(frame, ctx, {
    part_type: 'system',
    content_text: typeof frame.content === 'string' ? frame.content : null,
    attributes: {
      subtype,
      ...frameAttributes(frame),
    },
  })]
}

/**
 * Project a single `message.content[]` block (assistant or user-array) onto
 * the row fields that describe that block kind. Returns the partial row that
 * `makeBaseRow` will merge over the base.
 *
 * @param {unknown} block
 * @returns {Partial<NormalizedRow>}
 */
function projectContentBlock(block) {
  if (!isObject(block)) {
    return { part_type: 'unknown', attributes: { malformed_block: clone(block) } }
  }
  const t = typeof block.type === 'string' ? block.type : 'unknown'
  switch (t) {
  case 'text':
    return {
      part_type: 'text',
      content_text: typeof block.text === 'string' ? block.text : null,
    }
  case 'thinking':
    return {
      part_type: 'thinking',
      content_text: typeof block.thinking === 'string' ? block.thinking : null,
      thinking_signature: typeof block.signature === 'string' ? block.signature : null,
    }
  case 'tool_use':
    return {
      part_type: 'tool_use',
      tool_name: typeof block.name === 'string' ? block.name : null,
      tool_call_id: typeof block.id === 'string' ? block.id : null,
      tool_args: isObject(block.input) || Array.isArray(block.input) ? clone(block.input) : block.input ?? null,
      caller_type: isObject(block.caller) && typeof block.caller.type === 'string' ? block.caller.type : null,
    }
  case 'tool_result':
    return {
      part_type: 'tool_result',
      tool_result_for: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
      content_text: flattenToolResultContent(block.content),
      is_error: typeof block.is_error === 'boolean' ? block.is_error : null,
    }
  default:
    return {
      part_type: t,
      attributes: { unhandled_block_type: t, block: clone(block) },
    }
  }
}

/**
 * Tool results sometimes ship the result body as a string; sometimes as an
 * array of `{type:'text'|'tool_reference'|...}` blocks. Both are flattened
 * into a single content_text string so queries don't need to special-case the
 * shape — analysts can still recover the structured original via `raw_frame`.
 *
 * @param {unknown} content
 * @returns {string | null}
 */
function flattenToolResultContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  /** @type {string[]} */
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!isObject(block)) continue
    if (typeof block.type === 'string' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (typeof block.type === 'string' && block.type === 'tool_reference' && typeof block.tool_name === 'string') {
      parts.push(`<tool_reference>${block.tool_name}</tool_reference>`)
      continue
    }
    // Unknown sub-block: keep something queryable, JSON-encode so the column stays string.
    try { parts.push(JSON.stringify(block)) } catch { parts.push(String(block)) }
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/**
 * Pick the human-readable surface of an attachment for `content_text`.
 * Different attachment shapes carry useful content in different fields; we
 * pick the most readable one and let `attributes` hold the rest verbatim.
 *
 * @param {Record<string, unknown>} attachment
 * @returns {string | null}
 */
function renderAttachmentContent(attachment) {
  if (typeof attachment.content === 'string') return attachment.content
  if (typeof attachment.stdout === 'string' && attachment.stdout.length > 0) return attachment.stdout
  if (typeof attachment.stderr === 'string' && attachment.stderr.length > 0) return attachment.stderr
  return null
}

/**
 * Build the shared base row from outer-frame fields, then merge the supplied
 * overrides. All keys land deterministically — column order in the writer
 * (bead 3) can rely on this object key set.
 *
 * @param {Record<string, unknown>} frame
 * @param {SessionContext} ctx
 * @param {Partial<NormalizedRow> & { attributes?: unknown }} overrides
 * @returns {NormalizedRow}
 */
function makeBaseRow(frame, ctx, overrides) {
  const timestamp = pickIso(frame.timestamp) ?? syntheticTimestamp()
  const providerSessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ctx.sessionId
  /** @type {NormalizedRow} */
  const base = {
    schema_version: CLAUDE_SCHEMA_VERSION,
    city: ctx.city,
    gascity_session_id: providerSessionId,
    gascity_template: ctx.template ?? null,
    gascity_rig: ctx.rig ?? null,
    gascity_alias: ctx.alias ?? null,
    gateway_id: CLAUDE_GATEWAY_ID,
    provider: CLAUDE_PROVIDER,
    provider_session_id: providerSessionId,
    date: timestamp.slice(0, 10),

    provider_uuid: typeof frame.uuid === 'string' ? frame.uuid : '',
    message_id: null,
    part_index: 0,
    part_type: 'unknown',

    cwd: typeof frame.cwd === 'string' ? frame.cwd : null,
    git_branch: typeof frame.gitBranch === 'string' ? frame.gitBranch : null,
    permission_mode: typeof frame.permissionMode === 'string' ? frame.permissionMode : null,
    is_sidechain: typeof frame.isSidechain === 'boolean' ? frame.isSidechain : null,
    entrypoint: typeof frame.entrypoint === 'string' ? frame.entrypoint : null,
    client_version: typeof frame.version === 'string' ? frame.version : null,
    prompt_id: typeof frame.promptId === 'string' ? frame.promptId : null,
    request_id: typeof frame.requestId === 'string' ? frame.requestId : null,
    parent_uuid: typeof frame.parentUuid === 'string' ? frame.parentUuid : null,
    source_tool_assistant_uuid: typeof frame.sourceToolAssistantUUID === 'string' ? frame.sourceToolAssistantUUID : null,
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
  // Always include outer-frame overflow alongside whatever overrides supplied:
  // assistants stash their message.usage extras here, attachments stash leftover
  // attachment keys, etc. Merge order matters — overrides win for collisions.
  merged.attributes = mergeAttributes(frameAttributes(frame), overrides.attributes)
  return merged
}

/**
 * Hoist `message.*` fields off an assistant frame into a partial row. Token
 * usage lives a few levels deep (`message.usage.cache_creation.ephemeral_*`)
 * so the picks are spelled out below.
 *
 * @param {Record<string, unknown>} message
 * @returns {Partial<NormalizedRow>}
 */
function hoistMessageFields(message) {
  const usage = isObject(message.usage) ? message.usage : {}
  const cacheCreation = isObject(usage.cache_creation) ? usage.cache_creation : {}
  /** @type {Partial<NormalizedRow>} */
  const hoist = {
    message_id: typeof message.id === 'string' ? message.id : null,
    model: typeof message.model === 'string' ? message.model : null,
    stop_reason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
    stop_details: message.stop_details ?? null,
    input_tokens: numOrNull(usage.input_tokens),
    output_tokens: numOrNull(usage.output_tokens),
    cache_creation_input_tokens: numOrNull(usage.cache_creation_input_tokens),
    cache_read_input_tokens: numOrNull(usage.cache_read_input_tokens),
    ephemeral_1h_input_tokens: numOrNull(cacheCreation.ephemeral_1h_input_tokens),
    ephemeral_5m_input_tokens: numOrNull(cacheCreation.ephemeral_5m_input_tokens),
    service_tier: typeof usage.service_tier === 'string' ? usage.service_tier : null,
    inference_geo: typeof usage.inference_geo === 'string' ? usage.inference_geo : null,
    speed: typeof usage.speed === 'string' ? usage.speed : null,
  }
  return hoist
}

/**
 * Build the `attributes` JSON payload from outer-frame overflow. We skip
 * keys that already hoisted onto typed columns and keep `userType`,
 * `toolUseResult`, and any future additions. `message` usage overflow (e.g.
 * `iterations`, `server_tool_use`) is folded in when present.
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
  const message = isObject(frame.message) ? frame.message : null
  if (message) {
    const usage = isObject(message.usage) ? message.usage : null
    if (usage) {
      const usageOverflow = pickUsageOverflow(usage)
      if (Object.keys(usageOverflow).length > 0) overflow.usage_overflow = usageOverflow
    }
    const cm = message.context_management
    if (cm !== undefined) overflow.context_management = clone(cm)
    const diag = message.diagnostics
    if (diag !== undefined && diag !== null) overflow.diagnostics = clone(diag)
    if (typeof message.role === 'string' && message.role !== 'user' && message.role !== 'assistant') {
      overflow.message_role = message.role
    }
  }
  return overflow
}

/**
 * Usage block overflow: anything past the typed columns (iterations,
 * server_tool_use breakdowns, future additions). The named columns are
 * already hoisted by `hoistMessageFields` so we exclude them here.
 *
 * @param {Record<string, unknown>} usage
 * @returns {Record<string, unknown>}
 */
function pickUsageOverflow(usage) {
  const handled = new Set([
    'input_tokens', 'output_tokens', 'cache_creation_input_tokens',
    'cache_read_input_tokens', 'cache_creation', 'service_tier',
    'inference_geo', 'speed',
  ])
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [k, v] of Object.entries(usage)) {
    if (handled.has(k)) continue
    out[k] = clone(v)
  }
  return out
}

/**
 * Merge two attribute payloads. Returns null if both are empty (so the
 * column stores null rather than `{}`).
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
 * Strip a set of keys from a plain object and return the rest. Used to keep
 * already-hoisted attachment fields out of the `attributes` payload.
 *
 * @param {unknown} obj
 * @param {...string} keys
 * @returns {Record<string, unknown> | null}
 */
function stripKey(obj, ...keys) {
  if (!isObject(obj)) return null
  /** @type {Record<string, unknown>} */
  const out = {}
  const drop = new Set(keys)
  for (const [k, v] of Object.entries(obj)) {
    if (drop.has(k)) continue
    out[k] = v
  }
  return Object.keys(out).length === 0 ? null : out
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
 * Synthetic timestamp for frames that arrive without one (lifecycle-style
 * frames like `permission-mode`, `ai-title`). The writer (bead 3) prefers a
 * non-null value here so date-partitioning never fails; using the unix epoch
 * makes the synthesis self-evident in queries.
 *
 * @returns {string}
 */
function syntheticTimestamp() {
  return '1970-01-01T00:00:00.000Z'
}

/**
 * Numeric coerce — accepts `number` and finite-numeric strings, returns null
 * for everything else. Used for token counts since the API has been known to
 * ship them as strings.
 *
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
