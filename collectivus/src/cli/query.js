import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ConfigError, loadConfigAsync as defaultLoadConfig } from '../config.js'
import { defaultConfigPath } from './common.js'
import { readJsonlRows } from '../upload/reader.js'
import { renderResult } from '../query/format.js'
import {
  QUERY_DATASETS,
  columnsForDataset,
  isQueryDataset,
  sourceSignalForDataset,
} from '../query/schema.js'
import {
  discoverGascityPartitions,
  discoverSourceFiles,
  expectedCachePartitions,
  inspectCachePartitions,
  resolveQueryPaths,
} from '../query/paths.js'
import { refreshQueryCache } from '../query/refresh.js'
import { executeLogicalSql, prepareReadOnlySql, resolveQueryTableInfo, resolveQueryTables } from '../query/sql.js'
import {
  collectionTablesForQuery,
  expectedCollectionPartitions,
  inspectCollectionCachePartitions,
  listCollections,
  readAnyCollectionMeta,
  refreshCollectionCache,
} from '../query/collections.js'

/**
 * @import { CollectivusConfig } from '../types.js'
 * @import {
 *   QueryDataset,
 *   QueryFormat,
 *   QueryPaths,
 *   QueryRefreshMode,
 *   QueryScope,
 * } from '../query/types.js'
 */

const USAGE = `Usage:
  ctvs query <command> [options]

Commands:
  status                         Inspect JSONL sources and query-cache freshness
  catalog                        List logical datasets and cached row counts
  schema <dataset>               Print the static logical schema
  refresh <file.jsonl>...        Materialize selected JSONL source files into the query cache
  refresh --all [dataset]        Materialize all matching JSONL into the query cache
  sql <select-sql>               Run read-only SELECT SQL over logical datasets
  sample <dataset>               Show sample rows
  doctor                         Check query prerequisites

  logs [count|tail]
  traces [slow|errors]
  trace <trace-id>
  metrics <list|series|latest|summary> [metric-name]
  proxy [get|events|stats|tail] [exchange-id]
  activity
  service <service-name>
  errors

Shared options:
  --config <path|url>            Config path or URL (default: ~/.hyp/collectivus.json)
  --cache-dir <dir>              Query-cache directory
  --from <timestamp>             Inclusive timestamp lower bound
  --to <timestamp>               Inclusive timestamp upper bound
  --since <duration>             Relative lower bound, e.g. 15m, 2h, 7d
  --date <YYYY-MM-DD>            Restrict to one UTC date partition; repeat for multiple days
  --gateway-id <id>              Restrict to one gateway id
  --service <name>               Restrict serviceName for OTLP datasets
  --limit <n>                    Max rows to return (default/max: 100)
  --format <fmt>                 table, json, jsonl, markdown
  --refresh <mode>               never or always (default: never).
                                 Stale partitions query with a stderr warning;
                                 missing partitions always error.
  --all                          Refresh all matching source files (refresh command only)
  --force                        Rebuild fresh cache partitions too (refresh command only)
  --strict-freshness             Treat stale partitions as errors (pre-1.7 behavior)
  --help, -h                     Show this help`

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 100
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * @param {string[]} argv
 * @param {{
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   loadConfig?: typeof defaultLoadConfig,
 * }} [hooks]
 * @returns {Promise<number>}
 */
export async function runQuery(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const parsed = parseQueryArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }
  const command = parsed.positionals[0]
  if (!command) {
    stdout.write(USAGE + '\n')
    return 0
  }

  if (command === 'schema' && isQueryDataset(parsed.positionals[1])) {
    return handleSchema(undefined, parsed, stdout, stderr)
  }

  /** @type {CollectivusConfig} */
  let config
  try {
    config = await (hooks.loadConfig ?? defaultLoadConfig)(parsed.configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`config error: ${err.message}\n`)
      return 1
    }
    throw err
  }

  /** @type {QueryPaths} */
  let paths
  try {
    paths = resolveQueryPaths(config, parsed.configPath, parsed.cacheDir)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }

  try {
    switch (command) {
    case 'status':
      return handleStatus(paths, parsed, stdout)
    case 'catalog':
      return handleCatalog(paths, parsed, stdout)
    case 'schema':
      return handleSchema(paths, parsed, stdout, stderr)
    case 'doctor':
      return handleDoctor(paths, parsed, stdout)
    case 'refresh':
      return handleRefresh(paths, parsed, stdout, stderr)
    case 'sql':
      return handleSql(paths, parsed, stdout, stderr)
    case 'sample':
      return handleSample(paths, parsed, stdout, stderr)
    case 'logs':
      return handleLogs(paths, parsed, stdout, stderr)
    case 'traces':
      return handleTraces(paths, parsed, stdout, stderr)
    case 'trace':
      return handleTrace(paths, parsed, stdout, stderr)
    case 'metrics':
      return handleMetrics(paths, parsed, stdout, stderr)
    case 'proxy':
      return handleProxy(paths, parsed, stdout, stderr)
    case 'activity':
      return executeGeneratedSql(paths, parsed, stdout, stderr, ['logs', 'traces', 'metrics', 'proxy_messages'], activitySql(parsed.limit))
    case 'service':
      return handleService(paths, parsed, stdout, stderr)
    case 'errors':
      return executeGeneratedSql(paths, parsed, stdout, stderr, ['logs', 'traces', 'proxy_messages'], errorsSql(parsed.limit))
    default:
      stderr.write(`error: unknown query command: ${command}\n\n${USAGE}\n`)
      return 2
    }
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
}

/**
 * @param {string[]} argv
 * @returns {{
 *   help: boolean,
 *   positionals: string[],
 *   configPath: string,
 *   cacheDir?: string,
 *   from?: string,
 *   to?: string,
 *   date?: string,
 *   dates?: string[],
 *   gatewayId?: string,
 *   service?: string,
 *   limit: number,
 *   format: QueryFormat,
 *   refresh: QueryRefreshMode,
 *   all: boolean,
 *   force: boolean,
 *   strictFreshness: boolean,
 *   error?: string,
 * }}
 */
export function parseQueryArgs(argv) {
  /** @type {ReturnType<typeof parseQueryArgs>} */
  const out = {
    help: false,
    positionals: [],
    configPath: defaultConfigPath(),
    limit: DEFAULT_LIMIT,
    format: 'table',
    refresh: 'never',
    all: false,
    force: false,
    strictFreshness: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { out.help = true; return out }
    if (arg === '--all') { out.all = true; continue }
    if (arg === '--force') { out.force = true; continue }
    if (arg === '--strict-freshness') { out.strictFreshness = true; continue }
    /**
     * @param {string} name
     * @returns {string | undefined}
     */
    function readValue(name) {
      const eq = `${name}=`
      if (arg.startsWith(eq)) return arg.slice(eq.length)
      if (arg === name) return argv[++i]
    }
    const configPath = readValue('--config')
    if (configPath !== undefined) {
      if (!configPath) { out.error = '--config requires a path or URL'; return out }
      out.configPath = configPath
      continue
    }
    const cacheDir = readValue('--cache-dir')
    if (cacheDir !== undefined) {
      if (!cacheDir) { out.error = '--cache-dir requires a directory'; return out }
      out.cacheDir = cacheDir
      continue
    }
    const from = readValue('--from')
    if (from !== undefined) {
      if (!from || Number.isNaN(Date.parse(from))) { out.error = '--from requires a parseable timestamp'; return out }
      out.from = new Date(from).toISOString()
      continue
    }
    const to = readValue('--to')
    if (to !== undefined) {
      if (!to || Number.isNaN(Date.parse(to))) { out.error = '--to requires a parseable timestamp'; return out }
      out.to = new Date(to).toISOString()
      continue
    }
    const since = readValue('--since')
    if (since !== undefined) {
      const ms = parseDurationMs(since)
      if (ms === undefined) { out.error = '--since requires a duration like 15m, 2h, or 7d'; return out }
      out.from = new Date(Date.now() - ms).toISOString()
      continue
    }
    const date = readValue('--date')
    if (date !== undefined) {
      const dates = parseDateValues(date)
      if (!dates) { out.error = `--date must be YYYY-MM-DD, got ${date}`; return out }
      addDateFilters(out, dates)
      continue
    }
    const gatewayId = readValue('--gateway-id')
    if (gatewayId !== undefined) {
      if (!gatewayId) { out.error = '--gateway-id requires an id'; return out }
      out.gatewayId = gatewayId
      continue
    }
    const service = readValue('--service')
    if (service !== undefined) {
      if (!service) { out.error = '--service requires a name'; return out }
      out.service = service
      continue
    }
    const limit = readValue('--limit')
    if (limit !== undefined) {
      const n = Number.parseInt(limit, 10)
      if (!Number.isInteger(n) || String(n) !== limit || n < 1 || n > MAX_LIMIT) {
        out.error = `--limit must be an integer between 1 and ${MAX_LIMIT}`
        return out
      }
      out.limit = n
      continue
    }
    const format = readValue('--format')
    if (format !== undefined) {
      if (!isQueryFormat(format)) { out.error = '--format must be table, json, jsonl, or markdown'; return out }
      out.format = format
      continue
    }
    const refresh = readValue('--refresh')
    if (refresh !== undefined) {
      if (refresh !== 'never' && refresh !== 'always') { out.error = '--refresh must be never or always'; return out }
      out.refresh = refresh
      continue
    }
    if (arg.startsWith('--')) {
      out.error = `unknown argument: ${arg}`
      return out
    }
    out.positionals.push(arg)
  }
  if (out.from && out.to && Date.parse(out.from) > Date.parse(out.to)) {
    out.error = '--from must be before --to'
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {value is QueryFormat}
 */
function isQueryFormat(value) {
  return value === 'table' || value === 'json' || value === 'jsonl' || value === 'markdown'
}

/**
 * @param {string} value
 * @returns {string[] | undefined}
 */
function parseDateValues(value) {
  const dates = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (dates.length === 0 || dates.some((date) => !DATE_PATTERN.test(date))) return undefined
  return dates
}

/**
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {string[]} dates
 * @returns {void}
 */
function addDateFilters(parsed, dates) {
  const existing = parsed.dates ?? (parsed.date ? [parsed.date] : [])
  const merged = [...new Set([...existing, ...dates])]
  if (merged.length === 1) {
    parsed.date = merged[0]
    delete parsed.dates
  } else {
    delete parsed.date
    parsed.dates = merged
  }
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @returns {number}
 */
function handleStatus(paths, parsed, stdout) {
  const rows = statusRows(paths, baseScope(parsed))
  stdout.write(renderResult({ columns: ['dataset', 'sources', 'fresh', 'stale', 'missing', 'rows'], rows }, parsed.format))
  return 0
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @returns {number}
 */
function handleCatalog(paths, parsed, stdout) {
  const scope = baseScope(parsed)
  const sourceRows = statusRows(paths, scope)
  /** @type {Record<string, unknown>[]} */
  const rows = QUERY_DATASETS.map((dataset) => {
    const status = sourceRows.find((row) => row.dataset === dataset)
    return {
      dataset,
      source_signal: sourceSignalForDataset(dataset),
      columns: columnsForDataset(dataset).length,
      source_partitions: status?.sources ?? 0,
      cached_rows: status?.rows ?? 0,
    }
  })
  for (const collection of listCollections(paths.recordingRoot)) {
    const status = sourceRows.find((row) => row.dataset === collection.table)
    const meta = paths.cacheDir ? readAnyCollectionMeta(paths.cacheDir, collection) : undefined
    rows.push({
      dataset: collection.table,
      source_signal: 'collection',
      columns: meta?.columns.length ?? 0,
      source_partitions: status?.sources ?? 0,
      cached_rows: status?.rows ?? 0,
    })
  }
  stdout.write(renderResult({ columns: ['dataset', 'source_signal', 'columns', 'source_partitions', 'cached_rows'], rows }, parsed.format))
  return 0
}

/**
 * @param {QueryPaths | undefined} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {number}
 */
function handleSchema(paths, parsed, stdout, stderr) {
  const raw = parsed.positionals[1]
  if (!raw) {
    stderr.write('error: schema requires a dataset\n')
    return 2
  }
  if (!paths) {
    if (!isQueryDataset(raw)) {
      stderr.write(`error: unknown dataset "${raw}"\n`)
      return 2
    }
    const rows = columnsForDataset(raw).map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
    }))
    stdout.write(renderResult({ columns: ['name', 'type', 'nullable'], rows }, parsed.format))
    return 0
  }

  /** @type {import('../query/types.js').ResolvedQueryTableInfo} */
  let info
  try {
    info = resolveQueryTableInfo(paths, raw)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 2
  }
  if (info.kind === 'builtin') {
    const rows = columnsForDataset(info.dataset).map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
    }))
    stdout.write(renderResult({ columns: ['name', 'type', 'nullable'], rows }, parsed.format))
    return 0
  }
  if (!paths.cacheDir) {
    stderr.write('error: query cache is disabled; pass --cache-dir or set query.cache.enabled: true\n')
    return 1
  }
  const { collection } = info
  const meta = readAnyCollectionMeta(paths.cacheDir, collection)
  if (!meta) {
    stderr.write(`error: query cache is missing for ${collection.table}. Run: ${refreshCommand(parsed, undefined, { ...baseScope(parsed), datasets: [collection.table] })}\n`)
    return 1
  }
  const rows = meta.columns.map((column) => ({
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    source_field: column.source_field ?? '',
  }))
  stdout.write(renderResult({ columns: ['name', 'type', 'nullable', 'source_field'], rows }, parsed.format))
  return 0
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleRefresh(paths, parsed, stdout, stderr) {
  if (!paths.cacheEnabled || !paths.cacheDir) {
    stderr.write('error: query cache is disabled; pass --cache-dir to refresh explicitly\n')
    return 1
  }
  const targets = parsed.positionals.slice(1)
  /** @type {QueryScope} */
  let scope
  if (parsed.all) {
    if (targets.length > 1) {
      stderr.write('error: refresh --all accepts at most one dataset\n')
      return 2
    }
    scope = scopeWithOptionalDataset(paths, parsed, targets[0])
  } else {
    if (targets.length === 0) {
      stderr.write('error: refresh requires one or more JSONL files; pass --all to refresh all matching sources\n')
      return 2
    }
    const datasetTarget = targets.length === 1 ? resolveQueryTable(paths, targets[0]) : undefined
    if (datasetTarget) {
      stderr.write(`error: refresh ${targets[0]} targets a dataset; pass --all to refresh all ${datasetTarget} sources\n`)
      return 2
    }
    scope = refreshScopeForSourceFiles(paths, parsed, targets)
  }
  const result = await refreshAllCaches({ paths, scope, force: parsed.force, stdout })
  if (result.written === 0 && result.skipped === 0 && result.failures === 0) {
    stdout.write(`No JSONL files matched in ${paths.recordingRoot}.\n`)
  }
  stdout.write(`Done. ${result.written} file(s) written, ${result.skipped} fresh, ${result.rows} row(s)${result.failures ? `, ${result.failures} failure(s)` : ''}.\n`)
  return result.failures === 0 ? 0 : 1
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleSql(paths, parsed, stdout, stderr) {
  const sql = parsed.positionals.slice(1).join(' ')
  let prepared
  let datasets
  try {
    prepared = prepareReadOnlySql(sql, parsed.limit)
    datasets = resolveQueryDatasets(paths, prepared.tableNames)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 2
  }
  return executePrepared(paths, parsed, stdout, stderr, datasets, prepared.tableNames, prepared.statement)
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleSample(paths, parsed, stdout, stderr) {
  const raw = parsed.positionals[1]
  if (!raw) {
    stderr.write('error: sample requires a dataset\n')
    return 2
  }
  const dataset = resolveQueryTable(paths, raw)
  if (!dataset) {
    stderr.write(`error: unknown dataset "${raw}"\n`)
    return 2
  }
  return executeGeneratedSql(paths, parsed, stdout, stderr, [dataset], `select * from ${dataset} limit ${parsed.limit}`)
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @returns {number}
 */
function handleDoctor(paths, parsed, stdout) {
  const rootExists = fs.existsSync(paths.recordingRoot)
  const scope = baseScope(parsed)
  const sources = allSourceCount(paths, scope)
  const states = paths.cacheEnabled && paths.cacheDir
    ? inspectAllCachePartitions(paths, scope)
    : []
  const unfresh = states.filter((state) => state.status !== 'fresh')
  const rows = [
    { check: 'config', status: 'ok', detail: paths.configPath },
    { check: 'recording_root', status: rootExists ? 'ok' : 'warn', detail: paths.recordingRoot },
    { check: 'query_cache', status: paths.cacheEnabled ? 'ok' : 'warn', detail: paths.cacheDir ?? 'disabled' },
    { check: 'source_partitions', status: 'ok', detail: String(sources) },
    { check: 'cache_freshness', status: unfresh.length === 0 ? 'ok' : 'warn', detail: `${unfresh.length} missing/stale partition(s)` },
  ]
  stdout.write(renderResult({ columns: ['check', 'status', 'detail'], rows }, parsed.format))
  return 0
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleLogs(paths, parsed, stdout, stderr) {
  const sub = parsed.positionals[1]
  if (sub === 'tail') {
    return renderLiveTail(paths, parsed, stdout, 'logs')
  }
  if (sub === 'count') {
    return executeGeneratedSql(paths, parsed, stdout, stderr, ['logs'], 'select count(*) as count from logs')
  }
  if (sub) {
    stderr.write(`error: unknown logs command: ${sub}\n`)
    return 2
  }
  return executeGeneratedSql(
    paths,
    parsed,
    stdout,
    stderr,
    ['logs'],
    `select gateway_id, date, timestamp, severityText, serviceName, body, traceId, spanId from logs order by timestamp desc limit ${parsed.limit}`
  )
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleTraces(paths, parsed, stdout, stderr) {
  const sub = parsed.positionals[1]
  if (sub === 'slow') {
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['traces'],
      `select gateway_id, date, startTimestamp, durationMs, serviceName, name, traceId, spanId from traces order by durationMs desc limit ${parsed.limit}`
    )
  }
  if (sub === 'errors') {
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['traces'],
      `select gateway_id, date, startTimestamp, serviceName, name, traceId, spanId, status from traces where JSON_VALUE(status, '$.code') = 2 order by startTimestamp desc limit ${parsed.limit}`
    )
  }
  if (sub) {
    stderr.write(`error: unknown traces command: ${sub}\n`)
    return 2
  }
  return executeGeneratedSql(
    paths,
    parsed,
    stdout,
    stderr,
    ['traces'],
    `select gateway_id, date, startTimestamp, durationMs, serviceName, name, traceId, spanId, status from traces order by startTimestamp desc limit ${parsed.limit}`
  )
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleTrace(paths, parsed, stdout, stderr) {
  const traceId = parsed.positionals[1]
  if (!traceId) {
    stderr.write('error: trace requires a trace id\n')
    return 2
  }
  return executeGeneratedSql(
    paths,
    parsed,
    stdout,
    stderr,
    ['traces'],
    `select * from traces where traceId = ${sqlString(traceId)} order by startTimestamp asc limit ${parsed.limit}`
  )
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleMetrics(paths, parsed, stdout, stderr) {
  const sub = parsed.positionals[1]
  const metricName = parsed.positionals[2]
  if (sub === 'list') {
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['metrics'],
      `select metricName, count(*) as points from metrics group by metricName order by metricName limit ${parsed.limit}`
    )
  }
  if (sub === 'series') {
    if (!metricName) {
      stderr.write('error: metrics series requires a metric name\n')
      return 2
    }
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['metrics'],
      `select gateway_id, date, timestamp, serviceName, metricName, value, valueInt, count, sum from metrics where metricName = ${sqlString(metricName)} order by timestamp asc limit ${parsed.limit}`
    )
  }
  if (sub === 'latest') {
    const where = metricName ? ` where metricName = ${sqlString(metricName)}` : ''
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['metrics'],
      `select gateway_id, date, timestamp, serviceName, metricName, value, valueInt, count, sum from metrics${where} order by timestamp desc limit ${metricName ? parsed.limit : 1}`
    )
  }
  if (sub === 'summary') {
    if (!metricName) {
      stderr.write('error: metrics summary requires a metric name\n')
      return 2
    }
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['metrics'],
      `select metricName, count(*) as points, min(value) as min_value, max(value) as max_value, avg(value) as avg_value, min(timestamp) as first_timestamp, max(timestamp) as last_timestamp from metrics where metricName = ${sqlString(metricName)} group by metricName`
    )
  }
  stderr.write('error: metrics requires list, series, latest, or summary\n')
  return 2
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleProxy(paths, parsed, stdout, stderr) {
  const sub = parsed.positionals[1]
  const conversationId = parsed.positionals[2]
  if (sub === 'tail') {
    return renderLiveTail(paths, parsed, stdout, 'proxy_messages')
  }
  if (sub === 'get') {
    if (!conversationId) {
      stderr.write('error: proxy get requires a conversation id\n')
      return 2
    }
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['proxy_messages'],
      `select gateway_id, date, cwd, git_branch, message_created_at, conversation_id, message_index, message_id, role, part_index, part_type, content_text, tool_name, tool_call_id, model from proxy_messages where conversation_id = ${sqlString(conversationId)} order by message_index asc, part_index asc limit ${parsed.limit}`
    )
  }
  if (sub === 'events') {
    stderr.write('error: proxy events was removed; query proxy_messages directly for streamed assistant content\n')
    return 2
  }
  if (sub === 'stats') {
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['proxy_messages'],
      `select provider, model, count(*) as parts, count(distinct conversation_id) as conversations, count(distinct message_id) as messages from proxy_messages group by provider, model order by parts desc limit ${parsed.limit}`
    )
  }
  if (sub) {
    stderr.write(`error: unknown proxy command: ${sub}\n`)
    return 2
  }
  return executeGeneratedSql(
    paths,
    parsed,
    stdout,
    stderr,
    ['proxy_messages'],
    `select gateway_id, date, cwd, git_branch, message_created_at, conversation_id, role, part_type, model, content_text from proxy_messages order by message_created_at desc limit ${parsed.limit}`
  )
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleService(paths, parsed, stdout, stderr) {
  const service = parsed.positionals[1]
  if (!service) {
    stderr.write('error: service requires a service name\n')
    return 2
  }
  const scoped = { ...parsed, service }
  return executeGeneratedSql(paths, scoped, stdout, stderr, ['logs', 'traces', 'metrics'], serviceSql(parsed.limit))
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @param {string[]} datasets
 * @param {string} sql
 * @returns {Promise<number>}
 */
async function executeGeneratedSql(paths, parsed, stdout, stderr, datasets, sql) {
  const prepared = prepareReadOnlySql(sql, parsed.limit)
  const tableNames = prepared.tableNames.length > 0 ? prepared.tableNames : datasets
  const resolvedDatasets = resolveQueryDatasets(paths, tableNames)
  return executePrepared(paths, parsed, stdout, stderr, resolvedDatasets, tableNames, prepared.statement)
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @param {string[]} datasets
 * @param {string[]} tableNames
 * @param {import('squirreling').Statement} statement
 * @returns {Promise<number>}
 */
async function executePrepared(paths, parsed, stdout, stderr, datasets, tableNames, statement) {
  const scope = { ...baseScope(parsed), datasets }
  const ready = await ensureCacheReady(paths, scope, parsed)
  if (ready.ok === false) {
    stderr.write(ready.message + '\n')
    return 1
  }
  if (ready.warnings) {
    for (const warning of ready.warnings) stderr.write(warning + '\n')
  }
  const resolvedTables = await resolveQueryTables(paths, scope, tableNames)
  const result = await executeLogicalSql({ paths, scope, statement, resolvedTables })
  stdout.write(renderResult(result, parsed.format))
  return 0
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @returns {Promise<{ ok: true, warnings?: string[] } | { ok: false, message: string }>}
 */
async function ensureCacheReady(paths, scope, parsed) {
  // The gascity sink is the source of truth — the query cache is irrelevant
  // for `gascity_messages`-only queries. Only block on the cache-disabled
  // setting when the query touches a dataset that actually needs it.
  const requestedDatasets = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  const cacheBackedDatasets = requestedDatasets
    ? requestedDatasets.filter((dataset) => dataset !== 'gascity_messages')
    : QUERY_DATASETS.filter((dataset) => dataset !== 'gascity_messages')
  const needsCache = cacheBackedDatasets.length > 0
  if (needsCache && (!paths.cacheEnabled || !paths.cacheDir)) {
    return { ok: false, message: 'error: query cache is disabled; pass --cache-dir or set query.cache.enabled: true' }
  }
  if (parsed.refresh === 'always') {
    const result = await refreshAllCaches({ paths, scope, force: false })
    if (result.failures > 0) {
      return { ok: false, message: `error: refresh failed for ${result.failures} partition(s)` }
    }
  }
  const states = inspectAllCachePartitions(paths, scope)
  const missing = states.filter((state) => state.status === 'missing')
  const stale = states.filter((state) => state.status === 'stale')

  if (missing.length > 0) {
    const first = missing[0]
    const detail = `${partitionLabel(first)}: missing${first.reason ? ` (${first.reason})` : ''}`
    return {
      ok: false,
      message: `error: query cache is missing for ${detail}. Run: ${refreshCommand(parsed, missing, scope)}`,
    }
  }

  if (stale.length > 0) {
    if (parsed.strictFreshness) {
      const first = stale[0]
      const detail = `${partitionLabel(first)}: stale${first.reason ? ` (${first.reason})` : ''}`
      return {
        ok: false,
        message: `error: query cache is stale for ${detail} (--strict-freshness set). Run: ${refreshCommand(parsed, stale, scope)}`,
      }
    }
    const summary = stale.slice(0, 3).map((state) => `${partitionLabel(state)}${state.reason ? ` (${state.reason})` : ''}`).join(', ')
    const more = stale.length > 3 ? `, +${stale.length - 3} more` : ''
    return {
      ok: true,
      warnings: [`warning: query cache ${refreshTimeSummary(stale)}; ${stale.length} partition(s) differ from source [${summary}${more}] — run '${refreshCommand(parsed, stale, scope)}' to refresh`],
    }
  }

  return { ok: true }
}

/**
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {Array<{ partition: unknown }>} [states]
 * @param {QueryScope} [scope]
 * @returns {string}
 */
function refreshCommand(parsed, states, scope) {
  const parts = ['ctvs', 'query', 'refresh']
  const sourcePaths = states ? refreshableSourcePaths(states) : []
  if (sourcePaths.length > 0 && sourcePaths.length <= 5) {
    parts.push(...sourcePaths.map(shellQuote))
  } else {
    parts.push('--all')
    const datasets = scope?.datasets ?? (scope?.dataset ? [scope.dataset] : undefined)
    if (datasets?.length === 1) parts.push(datasets[0])
  }
  if (parsed.configPath) parts.push('--config', shellQuote(parsed.configPath))
  if (parsed.cacheDir) parts.push('--cache-dir', shellQuote(parsed.cacheDir))
  if (parsed.gatewayId) parts.push('--gateway-id', shellQuote(parsed.gatewayId))
  for (const date of parsed.dates ?? (parsed.date ? [parsed.date] : [])) {
    parts.push('--date', date)
  }
  return parts.join(' ')
}

/**
 * @param {Array<{ partition: unknown }>} states
 * @returns {string[]}
 */
function refreshableSourcePaths(states) {
  const seen = new Set()
  /** @type {string[]} */
  const out = []
  for (const state of states) {
    const { partition: rawPartition } = state
    const partition = /** @type {Record<string, unknown>} */ (rawPartition)
    const sourcePath = partition.jsonlPath
    if (typeof sourcePath !== 'string') continue
    if (!sourcePath.endsWith('.jsonl')) continue
    if (!fs.existsSync(sourcePath)) continue
    const abs = path.resolve(sourcePath)
    if (seen.has(abs)) continue
    seen.add(abs)
    out.push(abs)
  }
  return out
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {QueryDataset} dataset
 * @returns {Promise<number>}
 */
async function renderLiveTail(paths, parsed, stdout, dataset) {
  const rows = await readLiveRows(paths, { ...baseScope(parsed), dataset })
  const selected = rows.slice(-parsed.limit)
  const columns = dataset === 'proxy_messages'
    ? ['gateway_id', 'date', 'ts_start', 'duration_ms', 'upstream', 'response_status', 'request_path', 'exchange_id', 'error']
    : ['gateway_id', 'date', 'timestamp', 'severityText', 'serviceName', 'body', 'traceId', 'spanId']
  stdout.write(renderResult({ columns, rows: selected }, parsed.format))
  return 0
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readLiveRows(paths, scope) {
  const sources = discoverSourceFiles(paths.recordingRoot, scope)
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (const source of sources) {
    for await (const raw of readJsonlRows(source.jsonlPath)) {
      if (scope.dataset === 'proxy_messages') {
        if (raw.kind !== 'exchange') continue
        rows.push(liveProxyExchangeRow(raw, source.gatewayId, source.date))
      } else {
        rows.push({ ...raw, gateway_id: source.gatewayId, date: source.date })
      }
    }
  }
  return rows.filter((row) => liveRowMatchesScope(row, scope))
}

/**
 * @param {{
 *   paths: QueryPaths,
 *   scope: QueryScope,
 *   force?: boolean,
 *   stdout?: { write: (s: string) => void },
 * }} args
 * @returns {Promise<import('../query/types.js').RefreshResult>}
 */
async function refreshAllCaches(args) {
  const { paths, scope, force = false, stdout } = args
  /** @type {import('../query/types.js').RefreshResult} */
  const result = { written: 0, skipped: 0, rows: 0, failures: 0, files: [] }
  const builtinScope = scopeForBuiltins(scope)
  if (builtinScope) {
    mergeRefreshResult(result, await refreshQueryCache({ paths, scope: builtinScope, force, stdout }))
  }
  const collectionScope = scopeForCollections(scope)
  if (collectionScope) {
    mergeRefreshResult(result, await refreshCollectionCache({ paths, scope: collectionScope, force, stdout }))
  }
  return result
}

/**
 * @param {import('../query/types.js').RefreshResult} target
 * @param {import('../query/types.js').RefreshResult} source
 * @returns {void}
 */
function mergeRefreshResult(target, source) {
  target.written += source.written
  target.skipped += source.skipped
  target.rows += source.rows
  target.failures += source.failures
  target.files.push(...source.files)
}

/**
 * @param {QueryScope} scope
 * @returns {QueryScope | undefined}
 */
function scopeForBuiltins(scope) {
  const requested = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  if (!requested) return scope
  const datasets = requested.filter(isQueryDataset)
  if (datasets.length === 0) return undefined
  return { ...scope, datasets }
}

/**
 * @param {QueryScope} scope
 * @returns {QueryScope | undefined}
 */
function scopeForCollections(scope) {
  const requested = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  if (!requested) return scope
  const datasets = requested.filter((dataset) => !isQueryDataset(dataset))
  if (datasets.length === 0) return undefined
  return { ...scope, datasets }
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {Array<ReturnType<typeof inspectCachePartitions>[number] | ReturnType<typeof inspectCollectionCachePartitions>[number]>}
 */
function inspectAllCachePartitions(paths, scope) {
  return [
    ...inspectCachePartitions(expectedCachePartitions(paths, scopeForBuiltins(scope) ?? { ...scope, datasets: [] })),
    ...inspectCollectionCachePartitions(expectedCollectionPartitions(paths, scopeForCollections(scope) ?? { ...scope, datasets: [] })),
  ]
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {number}
 */
function allSourceCount(paths, scope) {
  const builtinSources = discoverSourceFiles(paths.recordingRoot, scopeForBuiltins(scope) ?? { ...scope, datasets: [] }).length
  const requested = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  const wantsGascity = !requested || requested.includes('gascity_messages')
  const gascitySources = wantsGascity ? discoverGascityPartitions(scope).length : 0
  const collectionSources = expectedCollectionPartitions(paths, scopeForCollections(scope) ?? { ...scope, datasets: [] })
    .filter((partition) => partition.sourceExists)
    .length
  return builtinSources + gascitySources + collectionSources
}

/**
 * Live-tail view of one raw `exchange` JSONL row. The `proxy_messages`
 * Parquet schema is conversation-grain; for tail we still want the
 * wire-level "what just flew through" columns, so this projection lifts the
 * common fields out of the JSONL exchange directly without going through
 * the conversation walker.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} gatewayId
 * @param {string} date
 * @returns {Record<string, unknown>}
 */
function liveProxyExchangeRow(raw, gatewayId, date) {
  return {
    gateway_id: gatewayId,
    date,
    exchange_id: raw.exchange_id,
    ts_start: raw.ts_start,
    ts_end: raw.ts_end,
    duration_ms: raw.duration_ms,
    upstream: raw.upstream,
    request_method: readPath(raw, ['request', 'method']),
    request_path: readPath(raw, ['request', 'path']),
    response_status: readPath(raw, ['response', 'status']),
    stream_event_count: raw.stream_event_count,
    error: raw.error,
  }
}

/**
 * @param {Record<string, unknown>} row
 * @param {QueryScope} scope
 * @returns {boolean}
 */
function liveRowMatchesScope(row, scope) {
  if (scope.gatewayId && row.gateway_id !== scope.gatewayId) return false
  if (!dateMatchesScope(row.date, scope)) return false
  if (scope.service && row.serviceName !== scope.service) return false
  if (!scope.from && !scope.to) return true
  const raw = row.timestamp ?? row.observedTimestamp ?? row.ts_start
  if (raw === undefined || raw === null) return true
  const ms = Date.parse(String(raw))
  if (!Number.isFinite(ms)) return true
  if (scope.from && ms < Date.parse(scope.from)) return false
  if (scope.to && ms > Date.parse(scope.to)) return false
  return true
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {Record<string, unknown>[]}
 */
function statusRows(paths, scope) {
  const requested = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  const datasets = requested ? requested.filter(isQueryDataset) : QUERY_DATASETS
  const rows = []
  for (const dataset of datasets) {
    const datasetScope = { ...scope, datasets: [dataset] }
    if (dataset === 'gascity_messages') {
      // The gascity sink IS the cache (no JSONL stage, no `.meta.json`).
      // Each part-file counts as both a "source partition" and a fresh
      // cache partition. `cached_rows` stays 0 unless we want to peek at
      // every Parquet footer — leave that off the hot path of `status` /
      // `catalog` and let users run `select count(*)` for the real number.
      const partitions = expectedCachePartitions(paths, datasetScope)
      const states = inspectCachePartitions(partitions)
      rows.push({
        dataset,
        sources: partitions.length,
        fresh: states.filter((state) => state.status === 'fresh').length,
        stale: 0,
        missing: states.filter((state) => state.status === 'missing').length,
        rows: 0,
      })
      continue
    }
    const sources = discoverSourceFiles(paths.recordingRoot, datasetScope)
    const states = paths.cacheEnabled && paths.cacheDir
      ? inspectCachePartitions(expectedCachePartitions(paths, datasetScope))
      : []
    rows.push({
      dataset,
      sources: sources.length,
      fresh: states.filter((state) => state.status === 'fresh').length,
      stale: states.filter((state) => state.status === 'stale').length,
      missing: states.filter((state) => state.status === 'missing').length,
      rows: states.reduce((sum, state) => sum + (state.meta?.row_count ?? 0), 0),
    })
  }
  for (const collection of collectionTablesForQuery(paths, scope)) {
    const datasetScope = { ...scope, datasets: [collection.table] }
    const partitions = expectedCollectionPartitions(paths, datasetScope)
    const states = paths.cacheEnabled && paths.cacheDir
      ? inspectCollectionCachePartitions(partitions)
      : []
    rows.push({
      dataset: collection.table,
      sources: partitions.filter((partition) => partition.sourceExists).length,
      fresh: states.filter((state) => state.status === 'fresh').length,
      stale: states.filter((state) => state.status === 'stale').length,
      missing: states.filter((state) => state.status === 'missing').length,
      rows: states.reduce((sum, state) => sum + (state.meta?.row_count ?? 0), 0),
    })
  }
  return rows
}

/**
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @returns {QueryScope}
 */
function baseScope(parsed) {
  return {
    gatewayId: parsed.gatewayId,
    date: parsed.date,
    dates: parsed.dates,
    from: parsed.from,
    to: parsed.to,
    service: parsed.service,
    limit: parsed.limit,
  }
}

/**
 * @param {unknown} date
 * @param {QueryScope} scope
 * @returns {boolean}
 */
function dateMatchesScope(date, scope) {
  if (scope.date && date !== scope.date) return false
  if (scope.dates && !scope.dates.includes(String(date))) return false
  return true
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {string | undefined} rawDataset
 * @returns {QueryScope}
 */
function scopeWithOptionalDataset(paths, parsed, rawDataset) {
  const scope = baseScope(parsed)
  if (rawDataset) {
    const table = resolveQueryTable(paths, rawDataset)
    if (!table) throw new Error(`unknown dataset "${rawDataset}"`)
    scope.dataset = table
  }
  return scope
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {string[]} targets
 * @returns {QueryScope}
 */
function refreshScopeForSourceFiles(paths, parsed, targets) {
  /** @type {string[]} */
  const sourcePaths = []
  const seenTargets = new Set()
  for (const target of targets) {
    const abs = path.resolve(target)
    if (seenTargets.has(abs)) continue
    seenTargets.add(abs)
    sourcePaths.push(abs)
  }

  const scope = { ...baseScope(parsed), sourcePaths }
  const matched = new Set()
  const datasets = new Set()
  for (const source of discoverSourceFiles(paths.recordingRoot, scope)) {
    matched.add(path.resolve(source.jsonlPath))
    datasets.add(datasetForSourceSignal(source.signal))
  }
  for (const partition of expectedCollectionPartitions(paths, scope)) {
    matched.add(path.resolve(partition.jsonlPath))
    datasets.add(partition.table)
  }

  const unknown = sourcePaths.filter((sourcePath) => !matched.has(sourcePath))
  if (unknown.length > 0) {
    throw new Error(`refresh source file is not a known recording or collection source: ${unknown[0]}`)
  }
  if (datasets.size === 0) {
    throw new Error('no refreshable source files matched')
  }
  return { ...scope, datasets: [...datasets] }
}

/**
 * @param {import('../query/types.js').SourceFile['signal']} signal
 * @returns {string}
 */
function datasetForSourceSignal(signal) {
  return signal === 'proxy' ? 'proxy_messages' : signal
}

/**
 * @param {QueryPaths} paths
 * @param {string} raw
 * @returns {string | undefined}
 */
function resolveQueryTable(paths, raw) {
  try {
    return resolveQueryTableInfo(paths, raw).dataset
  } catch {
    return undefined
  }
}

/**
 * @param {QueryPaths} paths
 * @param {string[]} tableNames
 * @returns {string[]}
 */
function resolveQueryDatasets(paths, tableNames) {
  /** @type {string[]} */
  const datasets = []
  for (const tableName of tableNames) {
    const { dataset } = resolveQueryTableInfo(paths, tableName)
    if (!datasets.includes(dataset)) datasets.push(dataset)
  }
  return datasets
}

/**
 * @param {{ partition: unknown }} state
 * @returns {string}
 */
function partitionLabel(state) {
  const partition = /** @type {Record<string, unknown>} */ (state.partition)
  if (partition.kind === 'collection') return String(partition.table)
  return `${String(partition.dataset)}/${String(partition.gatewayId)}/${String(partition.date)}`
}

/**
 * @param {Array<{ meta?: unknown }>} states
 * @returns {string}
 */
function refreshTimeSummary(states) {
  const times = [...new Set(states.map(refreshedAtForState).filter((time) => time !== undefined))].sort()
  if (times.length === 0) return 'refresh time unavailable'
  if (times.length === 1) return `last refreshed at ${times[0]}`
  return `last refreshed between ${times[0]} and ${times[times.length - 1]}`
}

/**
 * @param {{ meta?: unknown }} state
 * @returns {string | undefined}
 */
function refreshedAtForState(state) {
  const meta = /** @type {{ refreshed_at?: unknown } | undefined} */ (state.meta)
  return typeof meta?.refreshed_at === 'string' && meta.refreshed_at.length > 0
    ? meta.refreshed_at
    : undefined
}

/**
 * @param {number} limit
 * @returns {string}
 */
function activitySql(limit) {
  return `
select 'log' as signal, timestamp as timestamp, gateway_id, serviceName, severityText as detail from logs
union all
select 'trace' as signal, startTimestamp as timestamp, gateway_id, serviceName, name as detail from traces
union all
select 'metric' as signal, timestamp as timestamp, gateway_id, serviceName, metricName as detail from metrics
union all
select 'proxy' as signal, message_created_at as timestamp, gateway_id, provider as serviceName, role as detail from proxy_messages
order by timestamp desc
limit ${limit}`
}

/**
 * @param {number} limit
 * @returns {string}
 */
function serviceSql(limit) {
  return `
select 'log' as signal, timestamp as timestamp, gateway_id, serviceName, body as detail from logs
union all
select 'trace' as signal, startTimestamp as timestamp, gateway_id, serviceName, name as detail from traces
union all
select 'metric' as signal, timestamp as timestamp, gateway_id, serviceName, metricName as detail from metrics
order by timestamp desc
limit ${limit}`
}

/**
 * @param {number} limit
 * @returns {string}
 */
function errorsSql(limit) {
  return `
select 'log' as signal, timestamp as timestamp, gateway_id, serviceName, severityText as detail from logs where severityNumber >= 17
union all
select 'trace' as signal, startTimestamp as timestamp, gateway_id, serviceName, name as detail from traces where JSON_VALUE(status, '$.code') = 2
union all
select 'proxy' as signal, message_created_at as timestamp, gateway_id, provider as serviceName, content_text as detail from proxy_messages where part_type = 'error' or JSON_VALUE(status, '$.tool_status') = 'error'
order by timestamp desc
limit ${limit}`
}

/**
 * @param {string} value
 * @returns {string}
 */
function sqlString(value) {
  const quote = '\''
  return quote + value.replace(/'/g, quote + quote) + quote
}

/**
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  const quote = '\''
  return quote + value.replace(/'/g, quote + '\\' + quote + quote) + quote
}

/**
 * @param {string} input
 * @returns {number | undefined}
 */
function parseDurationMs(input) {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(input)
  if (!match) return
  const value = Number.parseInt(match[1], 10)
  const unit = match[2]
  const factor = unit === 'ms' ? 1
    : unit === 's' ? 1000
      : unit === 'm' ? 60 * 1000
        : unit === 'h' ? 60 * 60 * 1000
          : unit === 'd' ? 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000
  return value * factor
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} keys
 * @returns {unknown}
 */
function readPath(row, keys) {
  /** @type {unknown} */
  let cur = row
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = Reflect.get(cur, key)
  }
  return cur
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
