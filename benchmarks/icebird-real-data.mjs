// @ts-check

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { createQueryStorageService } from '../src/core/cache/storage.js'
import { executeQuerySql } from '../src/core/query/sql.js'

const TABLE_NAME = 'real_logs'
const SCENARIOS = {
  count_all: 'SELECT COUNT(*) AS value FROM real_logs',
  two_column_sum: `
    SELECT SUM(COALESCE(message_index, 0) + COALESCE(schema_version, 0)) AS value
    FROM real_logs
  `,
  filtered_sum: `
    SELECT SUM(COALESCE(message_index, 0)) AS value
    FROM real_logs
    WHERE role = 'assistant'
  `,
  projection: `
    SELECT schema_version, message_index, is_error
    FROM real_logs
    WHERE message_index IS NOT NULL
  `,
}

const args = parseArgs(process.argv.slice(2))
// Validate before the table walk below: sizing candidate tables reads every
// parquet file's stat, which is a long wait for a mistyped scenario name.
if (!SCENARIOS[args.scenario]) {
  throw new Error(`unknown scenario "${args.scenario}", expected one of: ${Object.keys(SCENARIOS).join(', ')}`)
}

const tablePath = path.resolve(args.table ?? defaultTablePath())
const metadata = tableMetadata(tablePath)
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const dataStats = directoryStats(path.join(tablePath, 'data'))

const storage = createQueryStorageService({ cacheRoot: path.dirname(tablePath) })
const dataset = {
  name: TABLE_NAME,
  schema: {
    columns: metadata.schema.fields.map((field) => ({
      name: field.name,
      type: icebergTypeToColumnType(field.type),
      nullable: !field.required,
    })),
  },
  discoverPartitions: async () => [{
    dataset: TABLE_NAME,
    partition: { benchmark: path.basename(tablePath) },
    tablePath,
  }],
  createDataSource: async () => {
    const source = await storage.dataSourceForTable(tablePath)
    if (!source) throw new Error(`no readable Iceberg snapshot under ${tablePath}`)
    return source
  },
}
const registry = {
  getDataset(name) {
    return name === TABLE_NAME ? dataset : undefined
  },
  listDatasets() {
    return [dataset]
  },
}

const preflight = await dataset.createDataSource()
if (!preflight.columns.includes('message_index') || !preflight.columns.includes('schema_version')) {
  throw new Error('benchmark table is not an ai_gateway_messages Iceberg table')
}

for (let iteration = 0; iteration < args.warmup; iteration++) {
  await measureOnce(args.scenario)
  globalThis.gc?.()
}

const samples = []
let expectedChecksum
for (let iteration = 0; iteration < args.iterations; iteration++) {
  globalThis.gc?.()
  const beforeHeap = process.memoryUsage().heapUsed
  const started = performance.now()
  const checksum = await runScenario(args.scenario)
  const elapsedMs = performance.now() - started
  globalThis.gc?.()
  const heapDeltaBytes = process.memoryUsage().heapUsed - beforeHeap
  if (expectedChecksum === undefined) expectedChecksum = checksum
  if (checksum !== expectedChecksum) {
    throw new Error(`benchmark result changed between iterations: ${expectedChecksum} != ${checksum}`)
  }
  samples.push({ elapsedMs, heapDeltaBytes })
}

const timings = samples.map((sample) => sample.elapsedMs)
const heapDeltas = samples.map((sample) => sample.heapDeltaBytes)
const output = {
  benchmark: 'icebird_real_hypaware_logs',
  scenario: args.scenario,
  query: normalizeSql(SCENARIOS[args.scenario]),
  versions: {
    hypaware: packageJson.version,
    icebird: packageJson.dependencies.icebird,
    squirreling: packageJson.dependencies.squirreling,
  },
  dataset: {
    table: path.basename(tablePath),
    snapshot_id: String(metadata.snapshotId),
    rows: preflight.numRows,
    data_files: dataStats.files,
    compressed_mib: round(dataStats.bytes / 1048576, 1),
  },
  run: {
    warmup_iterations: args.warmup,
    measured_iterations: args.iterations,
    max_heap_mb: args.maxHeapMb,
    heap_budget_wrapper: args.maxHeapMb > 0,
    exposed_gc: typeof globalThis.gc === 'function',
    checksum: expectedChecksum,
  },
  timing_ms: summary(timings),
  retained_heap_delta_mib: summary(heapDeltas.map((value) => value / 1048576)),
  process_peak_rss_mib: round(process.resourceUsage().maxRSS / 1024, 1),
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)

/**
 * @param {keyof typeof SCENARIOS} scenario
 */
async function measureOnce(scenario) {
  const started = performance.now()
  const checksum = await runScenario(scenario)
  return { checksum, elapsedMs: performance.now() - started }
}

/**
 * @param {keyof typeof SCENARIOS} scenario
 * @returns {Promise<string>}
 */
async function runScenario(scenario) {
  // A zero budget makes `executeQuerySql` skip `withHeapBudget` outright, so
  // the default run measures the bare source stack and the projection scenario
  // can materialize every row without refusing. That is NOT what a real query
  // does: production wraps each source, sampling `process.memoryUsage()` once
  // per native batch and once per deferred column read. Pass `--max-heap-mb`
  // to measure the same workload with the wrapper in place and see what the
  // sampling costs on the path this benchmark exists to defend.
  const result = await executeQuerySql({
    query: SCENARIOS[scenario],
    registry: /** @type {any} */ (registry),
    storage,
    refresh: 'never',
    includeLocalOnly: true,
    maxHeapBytes: args.maxHeapMb * 1024 * 1024,
  })
  if (scenario !== 'projection') {
    return `${result.rows.length}:${scalarChecksum(result.rows[0]?.value)}`
  }

  let indexSum = 0n
  let versionSum = 0n
  let errorRows = 0
  for (const row of result.rows) {
    indexSum += integerValue(row.message_index)
    versionSum += integerValue(row.schema_version)
    if (row.is_error === true) errorRows++
  }
  return `${result.rows.length}:${indexSum}:${versionSum}:${errorRows}`
}

/**
 * @param {unknown} value
 */
function scalarChecksum(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new Error(`unexpected aggregate result type: ${typeof value}`)
}

/**
 * @param {unknown} value
 */
function integerValue(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  if (value === null || value === undefined) return 0n
  throw new Error(`unexpected integer result type: ${typeof value}`)
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let table
  let scenario = /** @type {keyof typeof SCENARIOS} */ ('two_column_sum')
  let iterations = 5
  let warmup = 1
  let maxHeapMb = 0
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--table') table = requiredValue(argv, ++index, arg)
    else if (arg === '--scenario') scenario = /** @type {keyof typeof SCENARIOS} */ (requiredValue(argv, ++index, arg))
    else if (arg === '--iterations') iterations = positiveInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--warmup') warmup = nonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--max-heap-mb') maxHeapMb = nonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--help') {
      process.stdout.write(usage())
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`)
    }
  }
  return { table, scenario, iterations, warmup, maxHeapMb }
}

/**
 * Choose an immutable retired table generation when one is available. This
 * keeps baseline and candidate runs on the exact same snapshot even if the
 * HypAware daemon is actively appending to the current generation.
 */
function defaultTablePath() {
  const hypHome = process.env.HYP_HOME
    ? path.resolve(process.env.HYP_HOME)
    : path.join(os.homedir(), '.hyp')
  const sourceDir = path.join(
    hypHome,
    'hypaware',
    'cache',
    'datasets',
    'ai_gateway_messages',
    'source=claude'
  )
  const tables = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('table-'))
    .map((entry) => path.join(sourceDir, entry.name))
  const retired = tables.filter((table) => fs.existsSync(path.join(table, '.retired')))
  const candidates = retired.length > 0 ? retired : tables
  if (candidates.length === 0) {
    throw new Error(`no real ai_gateway_messages Iceberg tables found under ${sourceDir}`)
  }
  // Size each candidate once: `directoryStats` walks the whole data tree, and
  // a comparator calls it O(n log n) times over tables holding thousands of
  // parquet files.
  const sized = candidates.map((table) => ({ table, bytes: directoryStats(path.join(table, 'data')).bytes }))
  sized.sort((left, right) => right.bytes - left.bytes)
  return sized[0].table
}

/**
 * @param {string} table
 */
function tableMetadata(table) {
  const metadataDir = path.join(table, 'metadata')
  const version = fs.readFileSync(path.join(metadataDir, 'version-hint.text'), 'utf8').trim()
  const value = JSON.parse(fs.readFileSync(path.join(metadataDir, `v${version}.metadata.json`), 'utf8'))
  const schemaId = value['current-schema-id']
  const schema = value.schemas?.find((candidate) => candidate['schema-id'] === schemaId)
  if (!schema) throw new Error(`current schema ${schemaId} is missing from benchmark table metadata`)
  return {
    schema,
    snapshotId: value['current-snapshot-id'],
  }
}

/**
 * @param {string} dir
 */
function directoryStats(dir) {
  let files = 0
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = directoryStats(file)
      files += nested.files
      bytes += nested.bytes
    } else if (entry.isFile()) {
      files++
      bytes += fs.statSync(file).size
    }
  }
  return { files, bytes }
}

/**
 * The benchmark queries only primitive ai_gateway_messages fields. The
 * declared schema exists to satisfy the kernel registry contract and does not
 * participate in Icebird's physical schema planning.
 *
 * @param {unknown} type
 */
function icebergTypeToColumnType(type) {
  if (type === 'boolean') return 'BOOLEAN'
  if (type === 'int') return 'INT32'
  if (type === 'long') return 'INT64'
  if (type === 'float') return 'FLOAT'
  if (type === 'double') return 'DOUBLE'
  if (type === 'date') return 'DATE'
  if (type === 'timestamp' || type === 'timestamptz') return 'TIMESTAMP'
  return 'STRING'
}

/**
 * @param {string[]} argv
 * @param {number} index
 * @param {string} option
 */
function requiredValue(argv, index, option) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

/**
 * @param {string} value
 * @param {string} option
 */
function positiveInteger(value, option) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`)
  return parsed
}

/**
 * @param {string} value
 * @param {string} option
 */
function nonNegativeInteger(value, option) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${option} must be a non-negative integer`)
  return parsed
}

/**
 * @param {number[]} values
 */
function summary(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    min: round(sorted[0], 2),
    median: round(percentile(sorted, 0.5), 2),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length, 2),
    p95: round(percentile(sorted, 0.95), 2),
    max: round(sorted.at(-1), 2),
  }
}

/**
 * @param {number[]} sorted
 * @param {number} fraction
 */
function percentile(sorted, fraction) {
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/**
 * @param {number | undefined} value
 * @param {number} digits
 */
function round(value, digits) {
  if (value === undefined) return undefined
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * @param {string} sql
 */
function normalizeSql(sql) {
  return sql.trim().replace(/\s+/g, ' ')
}

function usage() {
  return `Usage: node --expose-gc benchmarks/icebird-real-data.mjs [options]\n\n` +
    `  --table PATH          Iceberg table directory (defaults to largest retired Claude table)\n` +
    `  --scenario NAME       ${Object.keys(SCENARIOS).join(', ')}\n` +
    `  --iterations NUMBER   measured iterations (default: 5)\n` +
    `  --warmup NUMBER       warmup iterations (default: 1)\n` +
    `  --max-heap-mb NUMBER  per-query heap budget in MiB; 0 (default) skips the budget wrapper entirely\n`
}
