// @ts-check

/**
 * @import { ColumnSpec } from '../../../../collectivus-plugin-kernel-types'
 * @import { IcebergField } from './types.d.ts'
 */

const ICEBERG_SCHEMA_ID = 0

/**
 * Map the kernel's basic-type `ColumnSpec[]` to the Iceberg field shape
 * `icebird` expects. Field ids are assigned in declaration order so the
 * very first table commit records a stable id-per-name mapping; later
 * appends MUST reuse those ids (see `mergeFieldIdsFromTable`) so the
 * snapshot history remains valid.
 *
 * Type mapping (matches the bead spec):
 *   STRING    -> string
 *   INT32     -> int
 *   INT64     -> long
 *   DOUBLE    -> double
 *   BOOLEAN   -> boolean
 *   TIMESTAMP -> timestamptz   (microsecond-precision, UTC)
 *   JSON      -> string        (canonical-JSON payload)
 *
 * @param {readonly ColumnSpec[]} columns
 * @returns {{ type: 'struct', 'schema-id': number, fields: IcebergField[] }}
 */
export function icebergSchemaForColumns(columns) {
  /** @type {IcebergField[]} */
  const fields = []
  let id = 1
  for (const column of columns) {
    fields.push({
      id: id++,
      name: column.name,
      required: column.nullable === false,
      type: icebergTypeForBasicType(column.type, column.name),
    })
  }
  return { type: 'struct', 'schema-id': ICEBERG_SCHEMA_ID, fields }
}

/**
 * Reconcile a `ColumnSpec[]` schema with an existing Iceberg table
 * schema so subsequent appends keep field ids stable. The result is
 * the schema to pass back into `icebergAppend` — same fields as
 * `icebergSchemaForColumns` but with ids re-bound to whatever the
 * existing table already carries.
 *
 * Rules:
 * - Existing columns keep their id; nullability is allowed to widen
 *   from required→optional but not the other way.
 * - Type changes are rejected with `iceberg_schema_incompatible`.
 * - New nullable columns are appended with fresh ids beyond the
 *   current max id.
 * - New required columns are rejected with
 *   `iceberg_schema_incompatible`; Iceberg cannot back-fill a
 *   required column.
 * - Column removals are rejected (V1 is append-only).
 *
 * @param {readonly ColumnSpec[]} columns
 * @param {{ fields: IcebergField[], 'schema-id'?: number }} existing
 * @returns {{ type: 'struct', 'schema-id': number, fields: IcebergField[] }}
 */
export function mergeFieldIdsFromTable(columns, existing) {
  /** @type {Map<string, IcebergField>} */
  const existingByName = new Map()
  /** @type {Set<string>} */
  const seen = new Set()
  let maxId = 0
  for (const f of existing.fields) {
    existingByName.set(f.name, f)
    if (typeof f.id === 'number' && f.id > maxId) maxId = f.id
  }
  /** @type {IcebergField[]} */
  const fields = []
  for (const column of columns) {
    const prior = existingByName.get(column.name)
    const want = icebergTypeForBasicType(column.type, column.name)
    if (prior) {
      if (prior.type !== want) {
        throw newSchemaError(
          'iceberg_schema_incompatible',
          `iceberg-format: column "${column.name}" type changed from ${prior.type} to ${want}`
        )
      }
      const required = column.nullable === false
      if (required && prior.required === false) {
        throw newSchemaError(
          'iceberg_schema_incompatible',
          `iceberg-format: column "${column.name}" cannot tighten nullable -> required`
        )
      }
      fields.push({ id: prior.id, name: prior.name, required, type: prior.type })
    } else {
      if (column.nullable === false) {
        throw newSchemaError(
          'iceberg_schema_incompatible',
          `iceberg-format: new column "${column.name}" must be nullable (Iceberg cannot back-fill required columns)`
        )
      }
      maxId += 1
      fields.push({ id: maxId, name: column.name, required: false, type: want })
    }
    seen.add(column.name)
  }
  for (const prior of existing.fields) {
    if (!seen.has(prior.name)) {
      throw newSchemaError(
        'iceberg_schema_incompatible',
        `iceberg-format: column "${prior.name}" cannot be dropped (V1 is append-only)`
      )
    }
  }
  const schemaId = typeof existing['schema-id'] === 'number' ? existing['schema-id'] : ICEBERG_SCHEMA_ID
  return { type: 'struct', 'schema-id': schemaId, fields }
}

/**
 * Coerce row values into the shapes `icebird` expects to drop into a
 * Parquet data file. Mirrors `src/core/cache/iceberg/schema.js` (the
 * intrinsic cache) but lives in the plugin tree so the writer can
 * evolve independently of the local cache.
 *
 * JSON columns are passed through unchanged; the caller decides whether
 * to canonicalize via `JSON.stringify`. Required nulls throw with
 * `iceberg_data_write_failed` so the error kind matches the surrounding
 * commit-phase span.
 *
 * @param {readonly ColumnSpec[]} columns
 * @param {readonly Record<string, unknown>[]} rows
 * @returns {Record<string, unknown>[]}
 */
export function rowsToIcebergRecords(columns, rows) {
  /** @type {Record<string, unknown>[]} */
  const out = new Array(rows.length)
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    /** @type {Record<string, unknown>} */
    const record = {}
    for (const column of columns) {
      record[column.name] = coerce(column, row[column.name])
    }
    out[i] = record
  }
  return out
}

/**
 * @param {ColumnSpec['type']} type
 * @param {string} columnName
 * @returns {string}
 */
function icebergTypeForBasicType(type, columnName) {
  switch (type) {
    case 'STRING':
      return 'string'
    case 'INT32':
      return 'int'
    case 'INT64':
      return 'long'
    case 'DOUBLE':
      return 'double'
    case 'BOOLEAN':
      return 'boolean'
    case 'TIMESTAMP':
      return 'timestamptz'
    case 'JSON':
      // V1 stores JSON columns as canonical-JSON strings so any
      // Iceberg reader can scan them. Switching to `variant` later
      // (see hyparquet v3 work) is a forward-compatible refinement.
      return 'string'
    default:
      throw newSchemaError(
        'iceberg_schema_incompatible',
        `iceberg-format: unsupported column type "${type}" on column "${columnName}"`
      )
  }
}

/**
 * @param {ColumnSpec} spec
 * @param {unknown} value
 * @returns {unknown}
 */
function coerce(spec, value) {
  if (value === undefined || value === null) {
    if (spec.nullable === false) {
      throw newDataError(
        'iceberg_data_write_failed',
        `iceberg-format: required column "${spec.name}" got null`
      )
    }
    return undefined
  }
  switch (spec.type) {
    case 'STRING':
      return typeof value === 'string' ? value : String(value)
    case 'INT32':
      return coerceInt(value, spec.name)
    case 'INT64':
      return coerceLong(value, spec.name)
    case 'DOUBLE':
      return coerceDouble(value, spec.name)
    case 'BOOLEAN':
      return Boolean(value)
    case 'TIMESTAMP':
      return coerceTimestamp(value, spec.name)
    case 'JSON':
      return typeof value === 'string' ? value : JSON.stringify(value)
    default:
      return value
  }
}

/** @param {unknown} value @param {string} name @returns {number} */
function coerceInt(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  throw newDataError(
    'iceberg_data_write_failed',
    `iceberg-format: column "${name}" expected int, got ${typeof value}`
  )
}

/** @param {unknown} value @param {string} name @returns {bigint} */
function coerceLong(value, name) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') {
    try {
      return BigInt(value)
    } catch {
      // fall through
    }
  }
  throw newDataError(
    'iceberg_data_write_failed',
    `iceberg-format: column "${name}" expected long, got ${typeof value}`
  )
}

/** @param {unknown} value @param {string} name @returns {number} */
function coerceDouble(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  throw newDataError(
    'iceberg_data_write_failed',
    `iceberg-format: column "${name}" expected double, got ${typeof value}`
  )
}

/** @param {unknown} value @param {string} name @returns {Date} */
function coerceTimestamp(value, name) {
  if (value instanceof Date) return value
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'bigint') return new Date(Number(value))
  if (typeof value === 'string') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d
  }
  throw newDataError(
    'iceberg_data_write_failed',
    `iceberg-format: column "${name}" expected timestamptz, got ${typeof value}`
  )
}

/**
 * @param {string} kind
 * @param {string} message
 */
function newSchemaError(kind, message) {
  const err = /** @type {Error & { hypErrorKind?: string }} */ (new Error(message))
  err.hypErrorKind = kind
  return err
}

/**
 * @param {string} kind
 * @param {string} message
 */
function newDataError(kind, message) {
  const err = /** @type {Error & { hypErrorKind?: string }} */ (new Error(message))
  err.hypErrorKind = kind
  return err
}

