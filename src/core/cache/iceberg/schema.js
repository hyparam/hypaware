// @ts-check

/**
 * @import { ColumnSpec } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { Field, IcebergType, Schema } from 'icebird/src/types.js'
 */

/**
 * Translate the kernel's `ColumnSpec` schema (the type the plugin
 * registry exposes to users) into the Iceberg field shape `icebird`
 * needs to create a table.
 *
 * Field ids start at 1 and are assigned in declaration order. The
 * cache does not (yet) maintain id stability across schema evolution:
 * V1 tables are append-only and re-created on schema change.
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
 * Reconcile a `ColumnSpec[]` with an existing Iceberg table schema so
 * subsequent appends keep field IDs stable. The result is the schema to
 * use for writes: same fields as `icebergSchemaForColumns` but with IDs
 * re-bound to the existing table.
 *
 * Rules:
 * - Existing columns keep their ID; nullability may widen
 *   (required → optional) but not tighten.
 * - Type changes are rejected.
 * - New nullable columns are appended with fresh IDs beyond the current
 *   max.
 * - New required columns are rejected (Iceberg cannot back-fill).
 * - Column removals are rejected (V1 is append-only).
 *
 * When `partitionColumns` is supplied, removals and type changes on
 * those columns produce a more specific error identifying the partition
 * constraint.
 *
 * @param {readonly ColumnSpec[]} columns
 * @param {Schema} existing
 * @param {Set<string>} [partitionColumns]
 * @returns {Schema}
 */
export function mergeFieldIdsFromTable(columns, existing, partitionColumns) {
  /** @type {Map<string, Field>} */
  const existingByName = new Map()
  /** @type {Set<string>} */
  const seen = new Set()
  let maxId = 0
  for (const f of existing.fields) {
    existingByName.set(f.name, f)
    if (typeof f.id === 'number' && f.id > maxId) maxId = f.id
  }
  /** @type {Field[]} */
  const fields = []
  for (const column of columns) {
    const prior = existingByName.get(column.name)
    const want = icebergTypeForBasicType(column.type)
    if (prior) {
      if (prior.type !== want) {
        const prefix = partitionColumns?.has(column.name)
          ? 'cache-iceberg: partition column'
          : 'cache-iceberg: column'
        throw new Error(
          `${prefix} "${column.name}" type changed from ${prior.type} to ${want}`
        )
      }
      const required = column.nullable === false
      if (required && prior.required === false) {
        throw new Error(
          `cache-iceberg: column "${column.name}" cannot tighten nullable → required`
        )
      }
      fields.push({ id: prior.id, name: prior.name, required, type: prior.type })
    } else {
      if (column.nullable === false) {
        throw new Error(
          `cache-iceberg: new column "${column.name}" must be nullable (Iceberg cannot back-fill required columns)`
        )
      }
      maxId += 1
      fields.push({ id: maxId, name: column.name, required: false, type: want })
    }
    seen.add(column.name)
  }
  for (const prior of existing.fields) {
    if (!seen.has(prior.name)) {
      const prefix = partitionColumns?.has(prior.name)
        ? 'cache-iceberg: partition column'
        : 'cache-iceberg: column'
      throw new Error(
        `${prefix} "${prior.name}" cannot be dropped`
      )
    }
  }
  const schemaId = typeof existing['schema-id'] === 'number' ? existing['schema-id'] : 0
  return { type: 'struct', 'schema-id': schemaId, fields }
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
 * @param {IcebergType} type
 * @returns {ColumnSpec['type']}
 */
export function basicTypeForIcebergType(type) {
  switch (type) {
    case 'string':
      return 'STRING'
    case 'int':
      return 'INT32'
    case 'long':
      return 'INT64'
    case 'double':
      return 'DOUBLE'
    case 'boolean':
      return 'BOOLEAN'
    case 'timestamptz':
    case 'timestamp':
      return 'TIMESTAMP'
    case 'variant':
      return 'JSON'
    default:
      return 'STRING'
  }
}

/**
 * Build a `ColumnSpec[]` from an existing Iceberg schema, preserving
 * field types and nullability instead of inferring from row data.
 *
 * @param {Schema} schema
 * @returns {ColumnSpec[]}
 */
export function columnsFromIcebergSchema(schema) {
  return schema.fields.map(f => ({
    name: f.name,
    type: basicTypeForIcebergType(/** @type {IcebergType} */ (f.type)),
    nullable: !f.required,
  }))
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
