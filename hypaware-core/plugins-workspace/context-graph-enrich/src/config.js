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
  text_column: 'content',
  timestamp_column: 'message_created_at',
  id_column: 'message_id',
  anchor_type: 'Session',
  anchor_key_column: 'conversation_id',
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

  const source_dataset = readString(raw, 'source_dataset', errors) ?? SOURCE_DEFAULTS.source_dataset
  const text_column = readString(raw, 'text_column', errors) ?? SOURCE_DEFAULTS.text_column
  const timestamp_column = readString(raw, 'timestamp_column', errors) ?? SOURCE_DEFAULTS.timestamp_column
  const id_column = readString(raw, 'id_column', errors) ?? SOURCE_DEFAULTS.id_column
  const anchor_type = readString(raw, 'anchor_type', errors) ?? SOURCE_DEFAULTS.anchor_type
  const anchor_key_column = readString(raw, 'anchor_key_column', errors) ?? SOURCE_DEFAULTS.anchor_key_column
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
      anchor_type,
      anchor_key_column,
      ...(recall_index !== undefined ? { recall_index } : {}),
      propose,
      curate,
    },
  }
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
