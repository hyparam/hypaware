import { columnsForSignal } from '../upload/schema.js'
import { columnsForMessages } from '../cli/messages-parquet.js'
import { GASCITY_MESSAGES_COLUMNS } from '../gascity/schema.js'

/**
 * @import { ColumnSpec } from '../upload/upload.d.ts'
 * @import { QueryDataset, DatasetSchema } from './types.js'
 */

/**
 * Bumped to 2 when the proxy dataset was replaced by `proxy_messages` so any
 * cache partition written under the old schema is treated as stale by the
 * freshness check (and refresh skips it rather than regenerating the retired
 * `proxy_exchanges` / `proxy_stream_events` layout).
 * Bumped to 3 when Claude local context (`cwd`, `git_branch`) was added to
 * `proxy_messages`.
 * Bumped to 4 when local Claude transcript fields were added to
 * `proxy_messages`.
 */
export const QUERY_CACHE_SCHEMA_VERSION = 4

/** @type {readonly QueryDataset[]} */
export const QUERY_DATASETS = [
  'logs',
  'traces',
  'metrics',
  'proxy_messages',
  'gascity_messages',
]

/** @type {ColumnSpec} */
const DATE_COLUMN = { name: 'date', type: 'STRING', nullable: false }

/**
 * @param {readonly ColumnSpec[]} columns
 * @returns {readonly ColumnSpec[]}
 */
function withDateColumn(columns) {
  return [...columns, DATE_COLUMN]
}

/** @type {Record<QueryDataset, DatasetSchema>} */
const SCHEMAS = {
  logs: {
    dataset: 'logs',
    sourceSignal: 'logs',
    columns: withDateColumn(columnsForSignal('logs', ['gateway_id'])),
  },
  traces: {
    dataset: 'traces',
    sourceSignal: 'traces',
    columns: withDateColumn(columnsForSignal('traces', ['gateway_id'])),
  },
  metrics: {
    dataset: 'metrics',
    sourceSignal: 'metrics',
    columns: withDateColumn(columnsForSignal('metrics', ['gateway_id'])),
  },
  proxy_messages: {
    dataset: 'proxy_messages',
    sourceSignal: 'proxy',
    columns: withDateColumn(columnsForMessages(['gateway_id'])),
  },
  // The gascity source writes Parquet directly to
  // `~/.collectivus/sink/gascity_messages/date=<date>/city=<city>/part-*.parquet`
  // (no JSONL stage). `GASCITY_MESSAGES_COLUMNS` already includes `date`,
  // `gateway_id`, and `city` as data columns, so the column list passes
  // through unwrapped.
  gascity_messages: {
    dataset: 'gascity_messages',
    sourceSignal: 'gascity',
    columns: GASCITY_MESSAGES_COLUMNS,
  },
}

/**
 * @param {unknown} value
 * @returns {value is QueryDataset}
 */
export function isQueryDataset(value) {
  return typeof value === 'string' && QUERY_DATASETS.includes(/** @type {QueryDataset} */ (value))
}

/**
 * @param {string} value
 * @returns {QueryDataset}
 */
export function assertQueryDataset(value) {
  if (isQueryDataset(value)) return value
  throw new Error(`unknown dataset "${value}"`)
}

/**
 * @param {QueryDataset} dataset
 * @returns {DatasetSchema}
 */
export function schemaForDataset(dataset) {
  return SCHEMAS[dataset]
}

/**
 * @param {QueryDataset} dataset
 * @returns {readonly ColumnSpec[]}
 */
export function columnsForDataset(dataset) {
  return SCHEMAS[dataset].columns
}

/**
 * @param {QueryDataset} dataset
 * @returns {'logs' | 'traces' | 'metrics' | 'proxy' | 'gascity'}
 */
export function sourceSignalForDataset(dataset) {
  return SCHEMAS[dataset].sourceSignal
}

/**
 * @param {QueryDataset} dataset
 * @returns {string | undefined}
 */
export function primaryTimestampColumn(dataset) {
  switch (dataset) {
  case 'logs': return 'timestamp'
  case 'traces': return 'startTimestamp'
  case 'metrics': return 'timestamp'
  case 'proxy_messages': return 'message_created_at'
  case 'gascity_messages': return 'message_created_at'
  default: return undefined
  }
}

/**
 * @param {QueryDataset} dataset
 * @returns {string[]}
 */
export function fallbackTimestampColumns(dataset) {
  switch (dataset) {
  case 'logs': return ['timestamp', 'observedTimestamp']
  case 'traces': return ['startTimestamp', 'endTimestamp']
  case 'metrics': return ['timestamp', 'startTimestamp']
  case 'proxy_messages': return ['message_created_at', 'conversation_started_at']
  case 'gascity_messages': return ['message_created_at', 'conversation_started_at']
  default: return []
  }
}
