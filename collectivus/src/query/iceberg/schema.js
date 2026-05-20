/**
 * @import { Schema, IcebergType } from 'icebird/src/types.js'
 * @import { ColumnSpec } from '../../upload/upload.d.ts'
 * @import { CollectionColumnMeta } from './types.d.ts'
 */

export const INTERNAL_COLUMNS = /** @type {const} */ ([
  { name: '_ctvs_row_id', type: 'STRING', nullable: false },
  { name: '_ctvs_source_id', type: 'STRING', nullable: false },
  { name: '_ctvs_source_epoch', type: 'INT64', nullable: false },
  { name: '_ctvs_byte_offset', type: 'INT64', nullable: false },
  { name: '_ctvs_line_number', type: 'INT64', nullable: false },
])

/**
 * @param {readonly ColumnSpec[]} columns
 * @returns {Schema}
 */
export function icebergSchemaForColumns(columns) {
  const used = new Set(columns.map((column) => column.name))
  const internal = INTERNAL_COLUMNS.filter((column) => !used.has(column.name))
  /** @type {Schema['fields']} */
  const fields = []
  let id = 1
  for (const column of [...columns, ...internal]) {
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
 * @param {ColumnSpec[]} columns
 * @param {Record<string, unknown>[]} rows
 * @returns {Record<string, unknown>[]}
 */
export function rowsToIcebergRecords(columns, rows) {
  const used = new Set(columns.map((column) => column.name))
  const internal = INTERNAL_COLUMNS.filter((column) => !used.has(column.name))
  return rows.map((row) => {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const column of columns) {
      out[column.name] = coerceForIceberg(column, extractCell(column.name, row))
    }
    for (const column of internal) {
      out[column.name] = coerceForIceberg(column, row[column.name])
    }
    return out
  })
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} row
 * @returns {unknown}
 */
function extractCell(name, row) {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name]
  const partition = row._partition
  if (partition && typeof partition === 'object') {
    const value = /** @type {Record<string, unknown>} */ (partition)[name]
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * @param {CollectionColumnMeta[]} columns
 * @returns {ColumnSpec[]}
 */
export function collectionColumnsToSpecs(columns) {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    nullable: column.nullable,
  }))
}

/**
 * @param {ColumnSpec['type']} type
 * @returns {IcebergType}
 */
function icebergTypeForBasicType(type) {
  switch (type) {
  case 'STRING': return 'string'
  case 'INT32': return 'int'
  case 'INT64': return 'long'
  case 'DOUBLE': return 'double'
  case 'BOOLEAN': return 'boolean'
  case 'TIMESTAMP': return 'timestamptz'
  case 'JSON': return 'variant'
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
    if (spec.nullable === false) throw new Error(`required column "${spec.name}" got null`)
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

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function coerceInt(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  throw new Error(`column "${name}" expected int, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
function coerceLong(value, name) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') return BigInt(value)
  throw new Error(`column "${name}" expected long, got ${typeof value}`)
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
  throw new Error(`column "${name}" expected double, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {Date}
 */
function coerceTimestamp(value, name) {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    const date = new Date(typeof value === 'bigint' ? Number(value) : value)
    if (!Number.isNaN(date.getTime())) return date
  }
  throw new Error(`column "${name}" expected timestamptz, got ${typeof value}`)
}
