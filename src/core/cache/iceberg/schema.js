// @ts-check

/**
 * @import { Schema, IcebergType } from 'icebird/src/types.js'
 * @typedef {import('../../../../collectivus-plugin-kernel-types').ColumnSpec} ColumnSpec
 */

/**
 * Translate the kernel's `ColumnSpec` schema (the type the plugin
 * registry exposes to users) into the Iceberg field shape `icebird`
 * needs to create a table.
 *
 * Field ids start at 1 and are assigned in declaration order. The
 * cache does not (yet) maintain id stability across schema evolution
 * — V1 tables are append-only and re-created on schema change.
 *
 * @param {readonly ColumnSpec[]} columns
 * @returns {Schema}
 */
export function icebergSchemaForColumns(columns) {
  /** @type {Schema['fields']} */
  const fields = []
  let id = 1
  for (const column of columns) {
    fields.push({
      id: id++,
      name: column.name,
      required: column.nullable === false,
      type: icebergTypeForBasicType(column.type),
    })
  }
  return { type: 'struct', 'schema-id': 0, fields }
}

/**
 * Coerce each row into the Iceberg type system. The intrinsic cache
 * is strict: a `null` for a non-nullable column is a programmer
 * error and throws rather than silently inserting a default.
 *
 * @param {readonly ColumnSpec[]} columns
 * @param {Record<string, unknown>[]} rows
 * @returns {Record<string, unknown>[]}
 */
export function rowsToIcebergRecords(columns, rows) {
  return rows.map((row) => {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const column of columns) {
      out[column.name] = coerceForIceberg(column, row[column.name])
    }
    return out
  })
}

/**
 * @param {ColumnSpec['type']} type
 * @returns {IcebergType}
 */
function icebergTypeForBasicType(type) {
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
      return 'variant'
    default:
      throw new Error(`unsupported query cache type for iceberg: ${type}`)
  }
}

/**
 * @param {ColumnSpec} spec
 * @param {unknown} value
 * @returns {unknown}
 */
function coerceForIceberg(spec, value) {
  if (value === undefined || value === null) {
    if (spec.nullable === false) {
      throw new Error(`required column "${spec.name}" got null`)
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
      return value
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
  throw new Error(`column "${name}" expected int, got ${typeof value}`)
}

/** @param {unknown} value @param {string} name @returns {bigint} */
function coerceLong(value, name) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') return BigInt(value)
  throw new Error(`column "${name}" expected long, got ${typeof value}`)
}

/** @param {unknown} value @param {string} name @returns {number} */
function coerceDouble(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  throw new Error(`column "${name}" expected double, got ${typeof value}`)
}

/** @param {unknown} value @param {string} name @returns {Date} */
function coerceTimestamp(value, name) {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    const date = new Date(typeof value === 'bigint' ? Number(value) : value)
    if (!Number.isNaN(date.getTime())) return date
  }
  throw new Error(`column "${name}" expected timestamptz, got ${typeof value}`)
}
