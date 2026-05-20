/**
 * Parquet schemas and row coercion for the upload subsystem.
 *
 * One column list per signal. Open-ended attribute bags (resource,
 * attributes, scope.attributes, metadata, log body) and OTLP closed-shape
 * arrays/structs (events, links, status, exemplars, quantileValues,
 * bucketCounts, explicitBounds, positive, negative) are stored as JSON
 * columns (parquet BYTE_ARRAY + JSON converted_type). Scalars are typed.
 * Metric number datapoints split doubles into `value` and 64-bit integers
 * into `valueInt` so OTLP integer values remain exact.
 *
 * ## Schema versions
 *
 * - **v1**: original layout — service-partitioned standalone deployments.
 *   Columns are exactly the per-signal lists below.
 * - **v2**: multi-tenant — adds a non-null `gateway_id` STRING column
 *   prepended to every signal when the writer is given a
 *   `partitionDimensions` list that includes `'gateway_id'`. The value is
 *   sourced from the row's `_partition.gateway_id` tag set by
 *   `readPartitionRows` (so the directory walker is the single source of
 *   truth — never a body field). Server-mode parquet always emits v2;
 *   standalone parquet stays at v1 (column omitted entirely so historical
 *   readers see exactly the layout they always saw).
 *
 * TODO: when hyparquet-writer ships variant-encoder support, swap the
 * open-ended JSON columns to `variant`. Closed-shape arrays can move to
 * typed list<struct> via explicit schemas. Both are mechanical — only
 * column type strings here change; the row coercer can keep passing
 * structured values, since hyparquet-writer's JSON path stringifies and
 * the variant path will accept the same shape.
 */

/**
 * @import { ColumnSource } from 'hyparquet-writer'
 * @import { Signal, ColumnSpec } from './upload.js'
 */

/** @type {ReadonlyArray<ColumnSpec>} */
const LOGS_COLUMNS = [
  { name: 'serviceName', type: 'STRING', nullable: false },
  { name: 'timestamp', type: 'TIMESTAMP', nullable: true },
  { name: 'observedTimestamp', type: 'TIMESTAMP', nullable: true },
  { name: 'severityNumber', type: 'INT32', nullable: true },
  { name: 'severityText', type: 'STRING', nullable: true },
  { name: 'body', type: 'JSON', nullable: true },
  { name: 'traceId', type: 'STRING', nullable: true },
  { name: 'spanId', type: 'STRING', nullable: true },
  { name: 'flags', type: 'INT32', nullable: true },
  { name: 'droppedAttributesCount', type: 'INT32', nullable: true },
  { name: 'resource', type: 'JSON', nullable: true },
  { name: 'scope_name', type: 'STRING', nullable: true },
  { name: 'scope_version', type: 'STRING', nullable: true },
  { name: 'scope_attributes', type: 'JSON', nullable: true },
  { name: 'attributes', type: 'JSON', nullable: true },
]

/** @type {ReadonlyArray<ColumnSpec>} */
const TRACES_COLUMNS = [
  { name: 'serviceName', type: 'STRING', nullable: false },
  { name: 'traceId', type: 'STRING', nullable: true },
  { name: 'spanId', type: 'STRING', nullable: true },
  { name: 'parentSpanId', type: 'STRING', nullable: true },
  { name: 'name', type: 'STRING', nullable: true },
  { name: 'kind', type: 'INT32', nullable: true },
  { name: 'traceState', type: 'STRING', nullable: true },
  { name: 'startTimestamp', type: 'TIMESTAMP', nullable: true },
  { name: 'endTimestamp', type: 'TIMESTAMP', nullable: true },
  { name: 'durationMs', type: 'DOUBLE', nullable: true },
  { name: 'flags', type: 'INT32', nullable: true },
  { name: 'droppedAttributesCount', type: 'INT32', nullable: true },
  { name: 'droppedEventsCount', type: 'INT32', nullable: true },
  { name: 'droppedLinksCount', type: 'INT32', nullable: true },
  { name: 'status', type: 'JSON', nullable: true },
  { name: 'resource', type: 'JSON', nullable: true },
  { name: 'scope_name', type: 'STRING', nullable: true },
  { name: 'scope_version', type: 'STRING', nullable: true },
  { name: 'scope_attributes', type: 'JSON', nullable: true },
  { name: 'attributes', type: 'JSON', nullable: true },
  { name: 'events', type: 'JSON', nullable: true },
  { name: 'links', type: 'JSON', nullable: true },
]

/** @type {ReadonlyArray<ColumnSpec>} */
const METRICS_COLUMNS = [
  { name: 'serviceName', type: 'STRING', nullable: false },
  { name: 'metricName', type: 'STRING', nullable: true },
  { name: 'description', type: 'STRING', nullable: true },
  { name: 'unit', type: 'STRING', nullable: true },
  { name: 'metricType', type: 'STRING', nullable: true },
  { name: 'aggregationTemporality', type: 'INT32', nullable: true },
  { name: 'isMonotonic', type: 'BOOLEAN', nullable: true },
  { name: 'startTimestamp', type: 'TIMESTAMP', nullable: true },
  { name: 'timestamp', type: 'TIMESTAMP', nullable: true },
  { name: 'flags', type: 'INT32', nullable: true },
  { name: 'value', type: 'DOUBLE', nullable: true },
  { name: 'valueInt', type: 'INT64', nullable: true },
  { name: 'valueType', type: 'STRING', nullable: true },
  { name: 'count', type: 'INT64', nullable: true },
  { name: 'sum', type: 'DOUBLE', nullable: true },
  { name: 'min', type: 'DOUBLE', nullable: true },
  { name: 'max', type: 'DOUBLE', nullable: true },
  { name: 'bucketCounts', type: 'JSON', nullable: true },
  { name: 'explicitBounds', type: 'JSON', nullable: true },
  { name: 'scale', type: 'INT32', nullable: true },
  { name: 'zeroCount', type: 'INT64', nullable: true },
  { name: 'zeroThreshold', type: 'DOUBLE', nullable: true },
  { name: 'positive', type: 'JSON', nullable: true },
  { name: 'negative', type: 'JSON', nullable: true },
  { name: 'quantileValues', type: 'JSON', nullable: true },
  { name: 'exemplars', type: 'JSON', nullable: true },
  { name: 'resource', type: 'JSON', nullable: true },
  { name: 'scope_name', type: 'STRING', nullable: true },
  { name: 'scope_version', type: 'STRING', nullable: true },
  { name: 'scope_attributes', type: 'JSON', nullable: true },
  { name: 'metadata', type: 'JSON', nullable: true },
  { name: 'attributes', type: 'JSON', nullable: true },
]

/** @type {Record<Signal, ReadonlyArray<ColumnSpec>>} */
const COLUMNS_BY_SIGNAL = {
  logs: LOGS_COLUMNS,
  traces: TRACES_COLUMNS,
  metrics: METRICS_COLUMNS,
}

/**
 * `gateway_id` partition column. Prepended to every signal's column list
 * when the writer is told partition data should land as columns (i.e.
 * `partitionDimensions` contains `'gateway_id'`). Required (non-null) so
 * downstream queries can rely on it always being present in v2 parquet.
 *
 * @type {ColumnSpec}
 */
const GATEWAY_ID_COLUMN = { name: 'gateway_id', type: 'STRING', nullable: false }

/**
 * @param {ReadonlyArray<string>} [partitionDimensions]
 * @returns {boolean}
 */
function hasGatewayIdColumn(partitionDimensions) {
  return Array.isArray(partitionDimensions) && partitionDimensions.includes('gateway_id')
}

/**
 * Get the column specs for a signal. When `partitionDimensions` is supplied
 * and includes `'gateway_id'`, the v2 schema is returned with `gateway_id`
 * prepended; otherwise v1 (the original column list) is returned unchanged.
 *
 * @param {Signal} signal
 * @param {ReadonlyArray<string>} [partitionDimensions]
 * @returns {ReadonlyArray<ColumnSpec>}
 */
export function columnsForSignal(signal, partitionDimensions) {
  const base = COLUMNS_BY_SIGNAL[signal]
  if (hasGatewayIdColumn(partitionDimensions)) {
    return [GATEWAY_ID_COLUMN, ...base]
  }
  return base
}

/**
 * Coerce an array of normalized JSONL rows into hyparquet-writer ColumnSource[].
 * `partitionDimensions` controls the v1/v2 schema selection — see
 * {@link columnsForSignal}.
 *
 * @param {Signal} signal
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {ReadonlyArray<string>} [partitionDimensions]
 * @returns {ColumnSource[]}
 */
export function rowsToColumns(signal, rows, partitionDimensions) {
  const columns = columnsForSignal(signal, partitionDimensions)
  return columns.map((spec) => ({
    name: spec.name,
    type: spec.type,
    nullable: spec.nullable,
    data: rows.map((row) => coerceCell(spec, extractCell(spec.name, row))),
  }))
}

/**
 * Pull a column value out of a row. Handles the flattened scope_*
 * columns by looking inside the row's `scope` object, and the
 * partition-derived `gateway_id` by reaching into `row._partition`
 * (set by `readPartitionRows` in the directory walker — never read
 * from the row body, so a row trying to spoof `gateway_id` in its
 * payload is ignored).
 *
 * @param {string} name
 * @param {Record<string, unknown>} row
 * @returns {unknown}
 */
function extractCell(name, row) {
  if (name === 'gateway_id') {
    const partition = row._partition
    if (!partition || typeof partition !== 'object') return undefined
    return /** @type {Record<string, unknown>} */ (partition).gateway_id
  }
  if (name === 'value') {
    return row.valueType === 'int' ? undefined : row.value
  }
  if (name === 'valueInt') {
    return row.valueType === 'int' ? row.value : undefined
  }
  if (name === 'scope_name' || name === 'scope_version' || name === 'scope_attributes') {
    const { scope } = row
    if (!scope || typeof scope !== 'object') return undefined
    const key = name === 'scope_attributes' ? 'attributes' : name === 'scope_name' ? 'name' : 'version'
    return /** @type {Record<string, unknown>} */ (scope)[key]
  }
  return row[name]
}

/**
 * Coerce a raw cell value to the parquet type the column expects.
 * Returns `undefined` for null/missing — hyparquet-writer encodes
 * `undefined` as a null in OPTIONAL columns.
 *
 * @param {ColumnSpec} spec
 * @param {unknown} value
 * @returns {unknown}
 */
function coerceCell(spec, value) {
  if (value === undefined || value === null) {
    if (!spec.nullable) {
      throw new Error(`required column "${spec.name}" got null`)
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
  throw new Error(`column "${name}" expected INT32, got ${typeof value}`)
}

/**
 * Returns a bigint for INT64 storage. Accepts number, bigint, and
 * numeric strings (OTLP encodes large counts as strings).
 *
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
function coerceInt64(value, name) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') {
    try {
      return BigInt(value)
    } catch {
      // fall through
    }
  }
  throw new Error(`column "${name}" expected INT64, got ${typeof value}`)
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
  throw new Error(`column "${name}" expected DOUBLE, got ${typeof value}`)
}

/**
 * Convert ISO timestamps (the format the collector writes) into a JS
 * Date. hyparquet-writer's TIMESTAMP basic type encodes Date as
 * INT64 + TIMESTAMP_MILLIS.
 *
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
  throw new Error(`column "${name}" expected TIMESTAMP, got ${typeof value}`)
}
