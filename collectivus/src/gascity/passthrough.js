import { GASCITY_GATEWAY_ID, GASCITY_MESSAGES_SCHEMA_VERSION } from './schema.js'

/**
 * @import { SessionContext } from './types.d.ts'
 * @import { NormalizedRow } from './normalizers/types.d.ts'
 */

/**
 * Default passthrough used when the dispatcher has no provider-specific
 * normalizer registered. Emits a single `raw_frame` row carrying the entire
 * envelope as a JSON column, so an unknown provider's traffic still appears
 * in `gascity_messages` (the analyst can inspect `raw_frame` and decide
 * whether it's worth adding a real normalizer).
 *
 * The row uses minimal information: `provider_uuid` is the supervisor's
 * frame uuid (required for dedup) and `message_created_at` falls back to
 * `Date.now()` when the frame has no timestamp the passthrough recognises.
 *
 * Returns an empty array — never undefined — so the dispatcher can rely on
 * the array shape and tests can assert "no rows" by length. Without a uuid
 * we drop the frame entirely; minting one would defeat the dedup window on
 * a backfill that overlaps with the live tail.
 *
 * @param {unknown} envelope
 * @param {SessionContext} ctx
 * @returns {NormalizedRow[]}
 */
export function passthroughNormalize(envelope, ctx) {
  const uuid = extractFrameUuid(envelope)
  if (uuid === undefined) {
    return []
  }
  const provider = resolveProvider(envelope) ?? 'unknown'
  const timestampIso = extractFrameTimestamp(envelope) ?? new Date().toISOString()
  /** @type {NormalizedRow} */
  const row = {
    schema_version: GASCITY_MESSAGES_SCHEMA_VERSION,
    city: ctx.city,
    gascity_session_id: ctx.sessionId,
    gascity_template: ctx.template ?? null,
    gascity_rig: ctx.rig ?? null,
    gascity_alias: ctx.alias ?? null,
    gateway_id: GASCITY_GATEWAY_ID,
    provider,
    provider_session_id: ctx.sessionId,
    date: timestampIso.slice(0, 10),

    provider_uuid: uuid,
    message_id: null,
    part_index: 0,
    part_type: 'raw_frame',

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
    message_created_at: timestampIso,
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
    raw_frame: envelope,
  }
  return [row]
}

/**
 * Pull the supervisor-stamped per-frame uuid off an envelope. Mirrors the
 * positions `session_worker.extractUuid` looks at — kept local to avoid a
 * cycle through that module.
 *
 * @param {unknown} envelope
 * @returns {string | undefined}
 */
function extractFrameUuid(envelope) {
  if (envelope === null || typeof envelope !== 'object') return undefined
  const obj = /** @type {Record<string, unknown>} */ (envelope)
  if (typeof obj.uuid === 'string') return obj.uuid
  if (obj.frame && typeof obj.frame === 'object') {
    const frame = /** @type {Record<string, unknown>} */ (obj.frame)
    if (typeof frame.uuid === 'string') return frame.uuid
  }
  return undefined
}

/**
 * @param {unknown} envelope
 * @returns {string | undefined}
 */
function resolveProvider(envelope) {
  if (envelope === null || typeof envelope !== 'object') return undefined
  const obj = /** @type {Record<string, unknown>} */ (envelope)
  if (typeof obj.provider === 'string') return obj.provider
  if (obj.response && typeof obj.response === 'object') {
    const resp = /** @type {Record<string, unknown>} */ (obj.response)
    if (typeof resp.provider === 'string') return resp.provider
  }
  if (obj.frame && typeof obj.frame === 'object') {
    const frame = /** @type {Record<string, unknown>} */ (obj.frame)
    if (typeof frame.provider === 'string') return frame.provider
  }
  return undefined
}

/**
 * Returns the timestamp as ISO-8601 so the passthrough never lets a numeric
 * epoch through — the column is TIMESTAMP and the `date` partition key needs
 * a string slice.
 *
 * @param {unknown} envelope
 * @returns {string | undefined}
 */
function extractFrameTimestamp(envelope) {
  if (envelope === null || typeof envelope !== 'object') return undefined
  const obj = /** @type {Record<string, unknown>} */ (envelope)
  const ts = pickTimestamp(obj.timestamp)
  if (ts !== undefined) return ts
  if (obj.frame && typeof obj.frame === 'object') {
    const frame = /** @type {Record<string, unknown>} */ (obj.frame)
    const inner = pickTimestamp(frame.timestamp)
    if (inner !== undefined) return inner
  }
  return undefined
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function pickTimestamp(value) {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  return undefined
}
