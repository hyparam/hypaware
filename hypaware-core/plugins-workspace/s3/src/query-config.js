// @ts-check

/**
 * Validation for the `query_sources` block under the `@hypaware/s3`
 * plugin config. Each entry declares one queryable S3-backed dataset
 * (`format: 'parquet' | 'iceberg'`) that the plugin registers with the
 * kernel query registry during activation, making it readable via
 * `hyp query sql`.
 *
 * Deliberately dependency-free (no observability import) so it stays
 * callable from unit tests and the smoke harness.
 */

import { normalizePrefix } from './config.js'

/**
 * @import { ColumnSpec } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { S3QuerySourceConfig, S3QuerySourceValidationError, S3QuerySourcesValidationResult } from './types.d.ts'
 */

const VALID_FORMATS = new Set(['parquet', 'iceberg'])
const VALID_COLUMN_TYPES = new Set(['STRING', 'INT32', 'INT64', 'DOUBLE', 'BOOLEAN', 'TIMESTAMP', 'JSON'])

/**
 * Validate the raw `query_sources` value. Returns the normalized list on
 * success or a list of `s3_query_source_invalid` errors on failure.
 *
 * @param {unknown} value
 * @returns {S3QuerySourcesValidationResult}
 */
export function validateS3QuerySources(value) {
  /** @type {S3QuerySourceValidationError[]} */
  const errors = []

  if (!Array.isArray(value)) {
    errors.push({ pointer: '', message: 'query_sources must be an array', errorKind: 's3_query_source_invalid' })
    return { ok: false, errors }
  }

  /** @type {S3QuerySourceConfig[]} */
  const sources = []
  const seenNames = new Set()

  for (let i = 0; i < value.length; i += 1) {
    const pointer = `/${i}`
    const source = parseEntry(value[i], pointer, errors)
    if (!source) continue
    if (seenNames.has(source.name)) {
      errors.push({
        pointer: `${pointer}/name`,
        message: `duplicate query_source name '${source.name}'`,
        errorKind: 's3_query_source_invalid',
      })
      continue
    }
    seenNames.add(source.name)
    sources.push(source)
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, sources }
}

/**
 * @param {unknown} entry
 * @param {string} pointer
 * @param {S3QuerySourceValidationError[]} errors
 * @returns {S3QuerySourceConfig | undefined}
 */
function parseEntry(entry, pointer, errors) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push({ pointer, message: 'query_source entry must be an object', errorKind: 's3_query_source_invalid' })
    return undefined
  }
  const raw = /** @type {Record<string, unknown>} */ (entry)

  const name = readString(raw, 'name', pointer, errors, { required: true })
  const prefix = readString(raw, 'prefix', pointer, errors, { required: true })
  const format = readString(raw, 'format', pointer, errors, { required: true })
  if (format !== undefined && !VALID_FORMATS.has(format)) {
    errors.push({
      pointer: `${pointer}/format`,
      message: `format must be one of ${Array.from(VALID_FORMATS).sort().join(', ')} (got '${format}')`,
      errorKind: 's3_query_source_invalid',
    })
  }

  const bucket = readString(raw, 'bucket', pointer, errors)
  const region = readString(raw, 'region', pointer, errors)
  const profile = readString(raw, 'profile', pointer, errors)
  const endpointUrl = readString(raw, 'endpoint_url', pointer, errors)
  const forcePathStyle = readBoolean(raw, 'force_path_style', pointer, errors)
  const schema = readSchema(raw.schema, `${pointer}/schema`, errors)

  if (name === undefined || prefix === undefined || format === undefined || !VALID_FORMATS.has(format)) {
    return undefined
  }

  /** @type {S3QuerySourceConfig} */
  const source = {
    name,
    format: /** @type {'parquet' | 'iceberg'} */ (format),
    prefix: normalizePrefix(prefix),
  }
  if (bucket !== undefined) source.bucket = bucket
  if (region !== undefined) source.region = region
  if (profile !== undefined) source.profile = profile
  if (endpointUrl !== undefined) source.endpoint_url = endpointUrl
  if (forcePathStyle !== undefined) source.force_path_style = forcePathStyle
  if (schema !== undefined) source.schema = schema

  return source
}

/**
 * @param {unknown} value
 * @param {string} pointer
 * @param {S3QuerySourceValidationError[]} errors
 * @returns {ColumnSpec[] | undefined}
 */
function readSchema(value, pointer, errors) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    errors.push({ pointer, message: 'schema must be an array of column specs', errorKind: 's3_query_source_invalid' })
    return undefined
  }
  /** @type {ColumnSpec[]} */
  const columns = []
  for (let i = 0; i < value.length; i += 1) {
    const colPointer = `${pointer}/${i}`
    const col = value[i]
    if (col === null || typeof col !== 'object' || Array.isArray(col)) {
      errors.push({ pointer: colPointer, message: 'column spec must be an object', errorKind: 's3_query_source_invalid' })
      continue
    }
    const rawCol = /** @type {Record<string, unknown>} */ (col)
    const colName = readString(rawCol, 'name', colPointer, errors, { required: true })
    const type = readString(rawCol, 'type', colPointer, errors, { required: true })
    if (type !== undefined && !VALID_COLUMN_TYPES.has(type)) {
      errors.push({
        pointer: `${colPointer}/type`,
        message: `type must be one of ${Array.from(VALID_COLUMN_TYPES).sort().join(', ')} (got '${type}')`,
        errorKind: 's3_query_source_invalid',
      })
    }
    const nullable = readBoolean(rawCol, 'nullable', colPointer, errors)
    if (colName === undefined || type === undefined || !VALID_COLUMN_TYPES.has(type)) continue
    columns.push({
      name: colName,
      type: /** @type {ColumnSpec['type']} */ (type),
      nullable: nullable ?? true,
    })
  }
  return columns
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} pointer
 * @param {S3QuerySourceValidationError[]} errors
 * @param {{ required?: boolean }} [opts]
 * @returns {string | undefined}
 */
function readString(raw, key, pointer, errors, opts = {}) {
  const v = raw[key]
  if (v === undefined) {
    if (opts.required) {
      errors.push({ pointer: `${pointer}/${key}`, message: `${key} is required`, errorKind: 's3_query_source_invalid' })
    }
    return undefined
  }
  if (typeof v !== 'string' || v.length === 0) {
    errors.push({ pointer: `${pointer}/${key}`, message: `${key} must be a non-empty string`, errorKind: 's3_query_source_invalid' })
    return undefined
  }
  return v
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} pointer
 * @param {S3QuerySourceValidationError[]} errors
 * @returns {boolean | undefined}
 */
function readBoolean(raw, key, pointer, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') {
    errors.push({ pointer: `${pointer}/${key}`, message: `${key} must be a boolean`, errorKind: 's3_query_source_invalid' })
    return undefined
  }
  return v
}
