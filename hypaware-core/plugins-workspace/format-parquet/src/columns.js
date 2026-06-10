// @ts-check

/**
 * @import { ColumnSpec } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ColumnSource } from 'hyparquet-writer'
 */

/**
 * Convert a row stream + `ColumnSpec[]` schema into the
 * `ColumnSource[]` shape `hyparquet-writer` expects. The kernel's
 * basic types (`STRING`, `INT32`, `INT64`, `DOUBLE`, `BOOLEAN`,
 * `TIMESTAMP`, `JSON`) map straight onto `hyparquet-writer`'s
 * `BasicType` supertype, so the encoder leaves the type strings
 * unchanged and only normalizes the values.
 *
 * Behavior mirrors `collectivus/src/upload/schema.js` (the Phase 8.3
 * donor): missing values surface as `undefined` (OPTIONAL parquet
 * null), required columns reject null values, and numeric strings are
 * accepted because OTLP often hands large counts back as strings.
 *
 * @param {readonly ColumnSpec[]} columns
 * @param {readonly Record<string, unknown>[]} rows
 * @returns {ColumnSource[]}
 */
export function rowsToColumnSources(columns, rows) {
  return columns.map((spec) => {
    const data = rows.map((row) => coerce(spec, row[spec.name]))
    // JSON columns arrive from the cache (Iceberg `variant`) as parsed
    // objects/arrays. hyparquet-writer keys its dictionary by reference, so
    // structurally-identical objects are otherwise distinct entries and the
    // column collapses to PLAIN — re-storing the (denormalized) blob on every
    // row. Interning by canonical content makes identical values share one
    // reference so they dictionary-encode (stored once), while the JSON
    // logical type still round-trips the original object to readers.
    if (spec.type === 'JSON') internJsonValues(data)
    return { name: spec.name, type: spec.type, nullable: spec.nullable, data }
  })
}

/**
 * Replace structurally-identical object/array values in `data` with a single
 * shared reference, in place. Primitive values (already-stringified JSON,
 * numbers, null) are left untouched — they dedupe by value already.
 *
 * The interning key is a plain `JSON.stringify` of the value, which is a
 * faithful, injective rendering of what the JSON writer will emit (numbers
 * vs strings stay distinct, no sentinel that real data could forge). Values
 * that cannot be serialized — a nested BigInt is the only realistic case —
 * throw and are simply left un-interned: keeping their own reference means a
 * distinct value is never merged into another, at the cost of not deduping
 * that one value. Such values do not occur in these columns in practice
 * (they originate from `JSON.parse`, which never yields BigInt), so this
 * costs no real dedup while staying correct if one ever does.
 *
 * @param {unknown[]} data
 */
function internJsonValues(data) {
  /** @type {Map<string, unknown>} */
  const seen = new Map()
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (v === null || v === undefined || typeof v !== 'object') continue
    let key
    try {
      key = JSON.stringify(v)
    } catch {
      continue // non-serializable (e.g. nested BigInt) — do not intern
    }
    const existing = seen.get(key)
    if (existing !== undefined) data[i] = existing
    else seen.set(key, v)
  }
}

/**
 * @param {ColumnSpec} spec
 * @param {unknown} value
 * @returns {unknown}
 */
function coerce(spec, value) {
  if (value === undefined || value === null) {
    if (!spec.nullable) {
      throw new Error(`format-parquet: required column "${spec.name}" got null`)
    }
    return undefined
  }
  switch (spec.type) {
    case 'STRING':
      return typeof value === 'string' ? value : String(value)
    case 'INT32':
      return toInt32(value, spec.name)
    case 'INT64':
      return toInt64(value, spec.name)
    case 'DOUBLE':
      return toDouble(value, spec.name)
    case 'BOOLEAN':
      return Boolean(value)
    case 'TIMESTAMP':
      return toTimestamp(value, spec.name)
    case 'JSON':
      // Pass JSON objects/arrays through unchanged so the writer's JSON
      // logical type round-trips them back to readers as objects. Dedup is
      // handled by interning identical values (see internJsonValues) rather
      // than by stringifying, which would double-encode (object -> JSON text).
      return value
    default:
      return value
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function toInt32(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  throw new Error(`format-parquet: column "${name}" expected INT32, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
function toInt64(value, name) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') {
    try {
      return BigInt(value)
    } catch {
      // fall through
    }
  }
  throw new Error(`format-parquet: column "${name}" expected INT64, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function toDouble(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  throw new Error(`format-parquet: column "${name}" expected DOUBLE, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {Date}
 */
function toTimestamp(value, name) {
  if (value instanceof Date) return value
  if (typeof value === 'string') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'bigint') return new Date(Number(value))
  throw new Error(`format-parquet: column "${name}" expected TIMESTAMP, got ${typeof value}`)
}
