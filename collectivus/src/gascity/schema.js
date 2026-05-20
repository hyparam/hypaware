/**
 * Parquet schema for the `gascity_messages` dataset captured by the gascity
 * source. The column set is the on-disk projection of `NormalizedRow` in
 * `./normalizers/types.d.ts` — bead 2 (Claude normalizer) committed to that
 * wire shape, and the writer lays it out here in stable column order.
 *
 * The writer is the single source of truth for column order: the Parquet
 * file lays the columns out in this exact sequence so files written across
 * daemon versions remain mergeable until a schema_version bump.
 *
 * @import { ColumnSpec } from '../upload/upload.d.ts'
 */

/**
 * Schema version stamped on every emitted row. Bumped when the column list
 * changes shape in a way readers can't auto-degrade through. Bead 3 ships
 * v1; bead 6 (catalog registration) reads from here so the on-disk Parquet
 * and the registered schema can't drift.
 */
export const GASCITY_MESSAGES_SCHEMA_VERSION = 1

/**
 * Constant stamped onto every row's `gateway_id` so cross-source queries
 * (`proxy_messages UNION ALL gascity_messages`) can tell whose dataset they
 * came from without joining on `provider`.
 */
export const GASCITY_GATEWAY_ID = 'gascity-scribe'

/**
 * Ordered column list for `gascity_messages`. Grain is one row per content
 * part within a frame. `provider_uuid` carries the supervisor's per-frame
 * uuid and is the dedup key together with `provider_session_id`.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const GASCITY_MESSAGES_COLUMNS = [
  // Session identity. `city` partitions the on-disk layout; we still keep it
  // as a typed column so readers that bypass directory-based partitioning
  // (e.g. concatenating part files manually) see the same data. `date` is the
  // YYYY-MM-DD partition key derived from `message_created_at`.
  { name: 'schema_version', type: 'INT32', nullable: false },
  { name: 'city', type: 'STRING', nullable: false },
  { name: 'gascity_session_id', type: 'STRING', nullable: false },
  { name: 'gascity_template', type: 'STRING', nullable: true },
  { name: 'gascity_rig', type: 'STRING', nullable: true },
  { name: 'gascity_alias', type: 'STRING', nullable: true },
  { name: 'gateway_id', type: 'STRING', nullable: false },
  { name: 'provider', type: 'STRING', nullable: false },
  { name: 'provider_session_id', type: 'STRING', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },

  // Frame identity.
  { name: 'provider_uuid', type: 'STRING', nullable: false },
  { name: 'message_id', type: 'STRING', nullable: true },
  { name: 'part_index', type: 'INT32', nullable: false },
  { name: 'part_type', type: 'STRING', nullable: false },

  // Outer-frame hoist. All optional per the provider's source frame shape.
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'git_branch', type: 'STRING', nullable: true },
  { name: 'permission_mode', type: 'STRING', nullable: true },
  { name: 'is_sidechain', type: 'BOOLEAN', nullable: true },
  { name: 'entrypoint', type: 'STRING', nullable: true },
  { name: 'client_version', type: 'STRING', nullable: true },
  { name: 'prompt_id', type: 'STRING', nullable: true },
  { name: 'request_id', type: 'STRING', nullable: true },
  { name: 'parent_uuid', type: 'STRING', nullable: true },
  { name: 'source_tool_assistant_uuid', type: 'STRING', nullable: true },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'conversation_started_at', type: 'TIMESTAMP', nullable: true },

  // Assistant message hoist (assistant frames only; null elsewhere).
  { name: 'model', type: 'STRING', nullable: true },
  { name: 'stop_reason', type: 'STRING', nullable: true },
  { name: 'stop_details', type: 'JSON', nullable: true },
  { name: 'input_tokens', type: 'INT64', nullable: true },
  { name: 'output_tokens', type: 'INT64', nullable: true },
  { name: 'cache_creation_input_tokens', type: 'INT64', nullable: true },
  { name: 'cache_read_input_tokens', type: 'INT64', nullable: true },
  { name: 'ephemeral_1h_input_tokens', type: 'INT64', nullable: true },
  { name: 'ephemeral_5m_input_tokens', type: 'INT64', nullable: true },
  { name: 'service_tier', type: 'STRING', nullable: true },
  { name: 'inference_geo', type: 'STRING', nullable: true },
  { name: 'speed', type: 'STRING', nullable: true },

  // Content-block specific.
  { name: 'content_text', type: 'STRING', nullable: true },
  { name: 'thinking_signature', type: 'STRING', nullable: true },
  { name: 'tool_name', type: 'STRING', nullable: true },
  { name: 'tool_call_id', type: 'STRING', nullable: true },
  { name: 'tool_args', type: 'JSON', nullable: true },
  { name: 'caller_type', type: 'STRING', nullable: true },
  { name: 'tool_result_for', type: 'STRING', nullable: true },
  { name: 'is_error', type: 'BOOLEAN', nullable: true },
  { name: 'attachment_type', type: 'STRING', nullable: true },
  { name: 'hook_event', type: 'STRING', nullable: true },

  // Overflow + safety net. `attributes` is unmapped fields the normalizer
  // didn't hoist; `raw_frame` is the verbatim original envelope.
  { name: 'attributes', type: 'JSON', nullable: true },
  { name: 'raw_frame', type: 'JSON', nullable: true },
]

/**
 * Map from column name → spec, useful when callers coerce row cells without
 * walking the array twice.
 *
 * @type {ReadonlyMap<string, ColumnSpec>}
 */
export const GASCITY_MESSAGES_COLUMNS_BY_NAME = new Map(
  GASCITY_MESSAGES_COLUMNS.map((c) => [c.name, c])
)

/**
 * Coerce one cell value to the on-disk type the column expects. Mirrors the
 * coercion done by `messageRowsToParquet` so the two datasets land with
 * identical type semantics.
 *
 * @param {ColumnSpec} spec
 * @param {unknown} value
 * @returns {unknown}
 */
export function coerceCell(spec, value) {
  if (value === undefined || value === null) {
    if (!spec.nullable) {
      throw new Error(`gascity_messages: required column "${spec.name}" got null`)
    }
    return undefined
  }
  switch (spec.type) {
  case 'STRING':
    return typeof value === 'string' ? value : String(value)
  case 'INT32':
    return coerceInt32(value, spec.name)
  case 'INT64':
    return coerceInt64(value, spec.name)
  case 'DOUBLE':
    return coerceDouble(value, spec.name)
  case 'BOOLEAN':
    return Boolean(value)
  case 'TIMESTAMP':
    return coerceTimestamp(value, spec.name)
  case 'JSON':
    return value
  default:
    return value
  }
}

/**
 * Build the `columnData` argument hyparquet-writer wants from an array of
 * normalized rows. Columns missing from a row become null (subject to the
 * column's `nullable` flag — required columns throw early so a torn frame
 * doesn't silently land as nulls).
 *
 * @param {ReadonlyArray<object>} rows
 * @returns {Array<{ name: string, type: ColumnSpec['type'], nullable: boolean, data: unknown[] }>}
 */
export function rowsToColumnData(rows) {
  return GASCITY_MESSAGES_COLUMNS.map((spec) => ({
    name: spec.name,
    type: spec.type,
    nullable: spec.nullable,
    data: rows.map((row) => coerceCell(spec, /** @type {Record<string, unknown>} */ (row)[spec.name])),
  }))
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function coerceInt32(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  throw new Error(`gascity_messages column "${name}" expected INT32, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
function coerceInt64(value, name) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') {
    try { return BigInt(value) } catch { /* fall through */ }
  }
  throw new Error(`gascity_messages column "${name}" expected INT64, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function coerceDouble(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  throw new Error(`gascity_messages column "${name}" expected DOUBLE, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {Date}
 */
function coerceTimestamp(value, name) {
  if (value instanceof Date) return value
  if (typeof value === 'string') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'bigint') return new Date(Number(value))
  throw new Error(`gascity_messages column "${name}" expected TIMESTAMP, got ${typeof value}`)
}
