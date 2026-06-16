// @ts-check

/**
 * Config validation for `@hypaware/context-graph-enrich`. Pure and
 * dependency-free (mirrors the embedder/vector-search validators): returns a
 * normalized config or a list of `enrich_config_invalid` errors.
 */

/**
 * @import { EnrichConfigError, EnrichConfigResult } from './types.d.ts'
 */

export const SOURCE_DEFAULTS = Object.freeze({
  source_dataset: 'ai_gateway_messages',
  // schema v6 exposes the per-part text as `content_text`; there is no bare
  // `content` column (see ai-gateway/src/message_projector.js).
  text_column: 'content_text',
  timestamp_column: 'message_created_at',
  id_column: 'message_id',
  // Row-unique tiebreak for the propose watermark. `ai_gateway_messages` is
  // part-level (many parts share one `message_created_at`), so the cursor is
  // the tuple (timestamp_column, tiebreak_column); `part_id` is the per-row id.
  tiebreak_column: 'part_id',
  anchor_type: 'Session',
  // @ref LLP 0030#decision — the Session anchor keys on session_id (the
  // session container, always present), matching the ai-gateway-graph
  // Session node; conversation_id is null for Claude.
  anchor_key_column: 'session_id',
  // @ref LLP 0028#row-selection — the enrichment scans *signal*, not plumbing.
  // `part_type` distinguishes content kinds (text / reasoning / tool_call /
  // tool_result …); `exclude_part_types` drops whole kinds before the model
  // sees them. Default excludes `tool_result` — raw tool/file/command output is
  // ~60% of the corpus by volume but not durable knowledge worth extracting.
  part_type_column: 'part_type',
  exclude_part_types: ['tool_result'],
  // Drop rows whose text column is null/empty (tool_call parts, and the
  // signature-only thinking parts a proxy doesn't persist): they contribute
  // nothing to the model yet consume the per-tick row budget.
  require_text: true,
})

export const PROPOSE_DEFAULTS = Object.freeze({
  enabled: true,
  interval_minutes: 5,
  max_tick_ms: 60_000,
  max_rows_per_tick: 200,
  // Cheap, high-recall tier. Anthropic Haiku is a good default; override per
  // provider (e.g. an Ollama model when using completion-openai).
  t1_model: 'claude-haiku-4-5',
  max_candidates: 12,
  confidence_floor: 0.1,
})

export const CURATE_DEFAULTS = Object.freeze({
  enabled: true,
  interval_minutes: 60,
  max_tick_ms: 120_000,
  max_prospects_per_tick: 20,
  // Frontier tier. Anthropic Opus is the default curator.
  t2_model: 'claude-opus-4-8',
  salience_threshold: 0.0,
  recall_top_k: 8,
  expand_depth: 1,
})

/**
 * @param {unknown} value
 * @returns {EnrichConfigResult}
 */
export function validateEnrichConfig(value) {
  /** @type {EnrichConfigError[]} */
  const errors = []

  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    errors.push(invalid('', 'context-graph-enrich config must be an object'))
    return { ok: false, errors }
  }
  const raw = /** @type {Record<string, unknown>} */ (value ?? {})

  // Dataset/column fields are interpolated as SQL identifiers in the
  // propose/curate queries, so they must be strict identifiers — a typo
  // becomes a runtime SQL failure, and an unvalidated string would let
  // crafted config alter the generated query. (`anchor_type` and
  // `recall_index` are used as values / index names, not SQL identifiers.)
  const source_dataset = readIdentifier(raw, 'source_dataset', errors) ?? SOURCE_DEFAULTS.source_dataset
  const text_column = readIdentifier(raw, 'text_column', errors) ?? SOURCE_DEFAULTS.text_column
  const timestamp_column = readIdentifier(raw, 'timestamp_column', errors) ?? SOURCE_DEFAULTS.timestamp_column
  const id_column = readIdentifier(raw, 'id_column', errors) ?? SOURCE_DEFAULTS.id_column
  const tiebreak_column = readIdentifier(raw, 'tiebreak_column', errors) ?? SOURCE_DEFAULTS.tiebreak_column
  const anchor_type = readString(raw, 'anchor_type', errors) ?? SOURCE_DEFAULTS.anchor_type
  const anchor_key_column = readIdentifier(raw, 'anchor_key_column', errors) ?? SOURCE_DEFAULTS.anchor_key_column
  const part_type_column = readIdentifier(raw, 'part_type_column', errors) ?? SOURCE_DEFAULTS.part_type_column
  // `exclude_part_types` values are interpolated as SQL string *literals*
  // (sqlQuote'd), not identifiers, so any non-empty string is accepted. An
  // explicit `[]` disables the part-type filter (it is not undefined, so it
  // is honored rather than falling back to the default).
  //
  // @ref LLP 0028#row-selection — the default `['tool_result']` only fits the
  // default `ai_gateway_messages` schema, which has a `part_type` column. A
  // custom `source_dataset` may not, so it defaults to *no* part-type filter
  // (`[]`) rather than emitting `part_type NOT IN (…)` against a column the
  // source lacks; the user opts in explicitly. (`require_text` only reads
  // `text_column`, which every source already configures, so it keeps its
  // default for any source.)
  const part_type_filter_default =
    source_dataset === SOURCE_DEFAULTS.source_dataset ? [...SOURCE_DEFAULTS.exclude_part_types] : []
  const exclude_part_types = readStringArray(raw, 'exclude_part_types', errors) ?? part_type_filter_default
  const require_text = readBool(raw, 'require_text', '', errors) ?? SOURCE_DEFAULTS.require_text
  const recall_index = readString(raw, 'recall_index', errors)

  const propose = readPropose(raw.propose, errors)
  const curate = readCurate(raw.curate, errors)

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    config: {
      source_dataset,
      text_column,
      timestamp_column,
      id_column,
      tiebreak_column,
      anchor_type,
      anchor_key_column,
      part_type_column,
      exclude_part_types,
      require_text,
      ...(recall_index !== undefined ? { recall_index } : {}),
      propose,
      curate,
    },
  }
}

/** A strict SQL identifier: a letter/underscore start, then word chars. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Like {@link readString}, but additionally requires a strict SQL identifier
 * so the value is safe to interpolate as a dataset/column name.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {EnrichConfigError[]} errors
 * @returns {string | undefined}
 */
function readIdentifier(raw, key, errors) {
  const v = readString(raw, key, errors)
  if (v === undefined) return undefined
  if (!IDENTIFIER.test(v)) {
    errors.push(invalid(`/${key}`, `${key} must be a valid SQL identifier (letters, digits, underscore)`))
    return undefined
  }
  return v
}

/**
 * @param {unknown} value
 * @param {EnrichConfigError[]} errors
 */
function readPropose(value, errors) {
  const raw = section(value, '/propose', errors)
  return {
    enabled: readBool(raw, 'enabled', '/propose', errors) ?? PROPOSE_DEFAULTS.enabled,
    interval_minutes: readPositiveNumber(raw, 'interval_minutes', '/propose', errors) ?? PROPOSE_DEFAULTS.interval_minutes,
    max_tick_ms: readPositiveInt(raw, 'max_tick_ms', '/propose', errors) ?? PROPOSE_DEFAULTS.max_tick_ms,
    max_rows_per_tick: readPositiveInt(raw, 'max_rows_per_tick', '/propose', errors) ?? PROPOSE_DEFAULTS.max_rows_per_tick,
    t1_model: readString(raw, 't1_model', errors, '/propose') ?? PROPOSE_DEFAULTS.t1_model,
    max_candidates: readPositiveInt(raw, 'max_candidates', '/propose', errors) ?? PROPOSE_DEFAULTS.max_candidates,
    confidence_floor: readUnitInterval(raw, 'confidence_floor', '/propose', errors) ?? PROPOSE_DEFAULTS.confidence_floor,
  }
}

/**
 * @param {unknown} value
 * @param {EnrichConfigError[]} errors
 */
function readCurate(value, errors) {
  const raw = section(value, '/curate', errors)
  return {
    enabled: readBool(raw, 'enabled', '/curate', errors) ?? CURATE_DEFAULTS.enabled,
    interval_minutes: readPositiveNumber(raw, 'interval_minutes', '/curate', errors) ?? CURATE_DEFAULTS.interval_minutes,
    max_tick_ms: readPositiveInt(raw, 'max_tick_ms', '/curate', errors) ?? CURATE_DEFAULTS.max_tick_ms,
    max_prospects_per_tick: readPositiveInt(raw, 'max_prospects_per_tick', '/curate', errors) ?? CURATE_DEFAULTS.max_prospects_per_tick,
    t2_model: readString(raw, 't2_model', errors, '/curate') ?? CURATE_DEFAULTS.t2_model,
    salience_threshold: readUnitInterval(raw, 'salience_threshold', '/curate', errors) ?? CURATE_DEFAULTS.salience_threshold,
    recall_top_k: readPositiveInt(raw, 'recall_top_k', '/curate', errors) ?? CURATE_DEFAULTS.recall_top_k,
    expand_depth: readPositiveInt(raw, 'expand_depth', '/curate', errors) ?? CURATE_DEFAULTS.expand_depth,
  }
}

/**
 * @param {unknown} value
 * @param {string} pointer
 * @param {EnrichConfigError[]} errors
 * @returns {Record<string, unknown>}
 */
function section(value, pointer, errors) {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    errors.push(invalid(pointer, `${pointer} must be an object`))
    return {}
  }
  return /** @type {Record<string, unknown>} */ (value ?? {})
}

/** @param {string} pointer @param {string} message @returns {EnrichConfigError} */
function invalid(pointer, message) {
  return { pointer, message, errorKind: 'enrich_config_invalid' }
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {EnrichConfigError[]} errors
 * @param {string} [prefix]
 * @returns {string | undefined}
 */
function readString(raw, key, errors, prefix = '') {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.length === 0) {
    errors.push(invalid(`${prefix}/${key}`, `${key} must be a non-empty string`))
    return undefined
  }
  return v
}

/**
 * Read an array of non-empty strings. Returns `undefined` when the key is
 * absent (caller falls back to the default), but an explicit empty array is
 * returned as-is — `[]` is a meaningful "filter nothing" value, distinct from
 * "not configured".
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {EnrichConfigError[]} errors
 * @returns {string[] | undefined}
 */
function readStringArray(raw, key, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) {
    errors.push(invalid(`/${key}`, `${key} must be an array of non-empty strings`))
    return undefined
  }
  return /** @type {string[]} */ (v)
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} prefix
 * @param {EnrichConfigError[]} errors
 * @returns {boolean | undefined}
 */
function readBool(raw, key, prefix, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') {
    errors.push(invalid(`${prefix}/${key}`, `${key} must be a boolean`))
    return undefined
  }
  return v
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} prefix
 * @param {EnrichConfigError[]} errors
 * @returns {number | undefined}
 */
function readPositiveInt(raw, key, prefix, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    errors.push(invalid(`${prefix}/${key}`, `${key} must be a positive integer`))
    return undefined
  }
  return v
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} prefix
 * @param {EnrichConfigError[]} errors
 * @returns {number | undefined}
 */
function readPositiveNumber(raw, key, prefix, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    errors.push(invalid(`${prefix}/${key}`, `${key} must be a positive number`))
    return undefined
  }
  return v
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} prefix
 * @param {EnrichConfigError[]} errors
 * @returns {number | undefined}
 */
function readUnitInterval(raw, key, prefix, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    errors.push(invalid(`${prefix}/${key}`, `${key} must be a number in [0, 1]`))
    return undefined
  }
  return v
}
