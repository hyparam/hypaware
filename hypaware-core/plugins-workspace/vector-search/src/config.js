// @ts-check

/**
 * Config validation for `@hypaware/vector-search`. Pure and
 * dependency-free so tests exercise it directly.
 */

/**
 * @import { VectorConfigError, VectorConfigResult, VectorIndexDeclaration } from './types.d.ts'
 */

// Deliberately longer than cache maintenance's 60-minute default: index
// freshness is a background nicety, and every tick can spend embedding
// API tokens.
// @ref LLP 0024#freshness-rides-the-cache-maintenance-pattern [implements] — own interval + max_tick_ms budget, modeled on the maintenance tick
export const REFRESH_DEFAULTS = Object.freeze({
  enabled: true,
  interval_minutes: 240,
  max_tick_ms: 30_000,
  // Per-tick embedding spend bound (rows). Soft: checked before each
  // shard build so one oversized partition can overshoot once rather
  // than starve forever.
  // @ref LLP 0024#open-questions [implements] — per-tick row budget resolves the cost-visibility question for the daemon timer
  max_rows_per_tick: 5_000,
})

const INDEX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Validate the plugin's config slice. `indexes` defaults to empty (the
 * plugin activates but has nothing to refresh or search); refresh
 * budgets default per {@link REFRESH_DEFAULTS}.
 *
 * @param {unknown} value
 * @returns {VectorConfigResult}
 * @ref LLP 0024#indexes-are-declared-in-config-sharded-per-partition [implements] — index definitions are portable config, not per-host state
 */
export function validateVectorSearchConfig(value) {
  /** @type {VectorConfigError[]} */
  const errors = []

  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    errors.push(invalid('', 'vector-search config must be an object'))
    return { ok: false, errors }
  }
  const raw = /** @type {Record<string, unknown>} */ (value ?? {})

  /** @type {VectorIndexDeclaration[]} */
  const indexes = []
  if (raw.indexes !== undefined) {
    if (!Array.isArray(raw.indexes)) {
      errors.push(invalid('/indexes', 'indexes must be an array'))
    } else {
      raw.indexes.forEach((entry, i) => {
        const decl = readIndexDeclaration(entry, `/indexes/${i}`, errors)
        if (decl) indexes.push(decl)
      })
    }
  }

  const seen = new Set()
  for (const decl of indexes) {
    if (seen.has(decl.name)) {
      errors.push(invalid('/indexes', `duplicate index name '${decl.name}'`))
    }
    seen.add(decl.name)
  }

  const refreshRaw = raw.refresh
  if (refreshRaw !== undefined && (refreshRaw === null || typeof refreshRaw !== 'object' || Array.isArray(refreshRaw))) {
    errors.push(invalid('/refresh', 'refresh must be an object'))
  }
  const refresh = /** @type {Record<string, unknown>} */ (
    refreshRaw && typeof refreshRaw === 'object' && !Array.isArray(refreshRaw) ? refreshRaw : {}
  )
  const enabled = readBoolean(refresh, 'enabled', '/refresh', errors) ?? REFRESH_DEFAULTS.enabled
  // Positive number (not integer): smokes drive sub-minute ticks.
  const intervalMinutes = readPositiveNumber(refresh, 'interval_minutes', '/refresh', errors)
    ?? REFRESH_DEFAULTS.interval_minutes
  const maxTickMs = readPositiveNumber(refresh, 'max_tick_ms', '/refresh', errors) ?? REFRESH_DEFAULTS.max_tick_ms
  const maxRowsPerTick = readPositiveNumber(refresh, 'max_rows_per_tick', '/refresh', errors)
    ?? REFRESH_DEFAULTS.max_rows_per_tick

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    config: {
      indexes,
      refresh: {
        enabled,
        interval_minutes: intervalMinutes,
        max_tick_ms: maxTickMs,
        max_rows_per_tick: maxRowsPerTick,
      },
    },
  }
}

/**
 * @param {unknown} entry
 * @param {string} pointer
 * @param {VectorConfigError[]} errors
 * @returns {VectorIndexDeclaration | null}
 */
function readIndexDeclaration(entry, pointer, errors) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(invalid(pointer, 'index declaration must be an object'))
    return null
  }
  const raw = /** @type {Record<string, unknown>} */ (entry)
  const dataset = readRequiredString(raw, 'dataset', pointer, errors)
  const column = readRequiredString(raw, 'column', pointer, errors)
  if (!dataset || !column) return null

  let name = `${dataset}.${column}`
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.length === 0) {
      errors.push(invalid(`${pointer}/name`, 'name must be a non-empty string'))
      return null
    }
    name = raw.name
  }
  // The name becomes a state-dir path segment; reject traversal.
  if (!INDEX_NAME_RE.test(name)) {
    errors.push(invalid(`${pointer}/name`, `index name '${name}' must match ${INDEX_NAME_RE}`))
    return null
  }

  /** @type {string | undefined} */
  let idColumn
  if (raw.id_column !== undefined) {
    if (typeof raw.id_column !== 'string' || raw.id_column.length === 0) {
      errors.push(invalid(`${pointer}/id_column`, 'id_column must be a non-empty string'))
      return null
    }
    idColumn = raw.id_column
  }

  return { dataset, column, name, ...(idColumn !== undefined ? { id_column: idColumn } : {}) }
}

/**
 * @param {string} pointer
 * @param {string} message
 * @returns {VectorConfigError}
 */
function invalid(pointer, message) {
  return { pointer, message, errorKind: 'vector_config_invalid' }
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} pointer
 * @param {VectorConfigError[]} errors
 * @returns {string | undefined}
 */
function readRequiredString(raw, key, pointer, errors) {
  const v = raw[key]
  if (typeof v !== 'string' || v.length === 0) {
    errors.push(invalid(`${pointer}/${key}`, `${key} must be a non-empty string`))
    return undefined
  }
  return v
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} pointer
 * @param {VectorConfigError[]} errors
 * @returns {boolean | undefined}
 */
function readBoolean(raw, key, pointer, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') {
    errors.push(invalid(`${pointer}/${key}`, `${key} must be a boolean`))
    return undefined
  }
  return v
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} pointer
 * @param {VectorConfigError[]} errors
 * @returns {number | undefined}
 */
function readPositiveNumber(raw, key, pointer, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    errors.push(invalid(`${pointer}/${key}`, `${key} must be a positive number`))
    return undefined
  }
  return v
}
