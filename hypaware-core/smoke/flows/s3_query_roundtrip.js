// @ts-check

import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import { parquetWriteBuffer } from 'hyparquet-writer'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { executeQuerySql } from '../../../src/core/query/sql.js'
import { rowsToColumnSources } from '../../plugins-workspace/format-parquet/src/columns.js'

/**
 * @import { ActivePlugin, BlobStore, ColumnSpec, SinkEncoder, TableFormatProvider } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { PluginActivationEntry } from '../../../src/core/runtime/types.d.ts'
 */

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS_WORKSPACE = path.resolve(SMOKE_DIR, '../../plugins-workspace')

const BUCKET = 'acme-query-bucket'
const PREFIX = 'lake'
// Local cache dataset the fixture writes, then the iceberg sink exports
// to `<PREFIX>/iceberg/datasets/<LOCAL_DATASET>` in the fake bucket.
const LOCAL_DATASET = 'iceberg_query_rows'
const ICEBERG_ROW_COUNT = 5
const SINK_INSTANCE = 'iceberg_query_lake'

// query_source prefixes are relative to the plugin prefix (PREFIX), the
// same way the sink addresses what it writes. The bare parquet object is
// seeded at the resulting absolute key.
const PARQUET_REL_PREFIX = 'parquet/events'
const PARQUET_KEY = `${PREFIX}/${PARQUET_REL_PREFIX}/part-0.parquet`
/** @type {ColumnSpec[]} */
const PARQUET_COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'name', type: 'STRING', nullable: false },
]
const PARQUET_ROWS = [
  { id: 1, name: 'alice' },
  { id: 2, name: 'bob' },
  { id: 3, name: 'carol' },
]

const QUERY_SOURCES = [
  { name: 'events_parquet', format: 'parquet', prefix: PARQUET_REL_PREFIX },
  { name: 'rows_iceberg', format: 'iceberg', prefix: `iceberg/datasets/${LOCAL_DATASET}` },
]

/**
 * Hermetic smoke proving `hyp query` reads both bare parquet objects and
 * an Iceberg table back out of S3, via `@hypaware/s3` `query_sources`
 * registered during plugin activation. Runs over an in-memory fake S3
 * client so no network or credentials are involved.
 *
 * Flow:
 *  - Activate `@hypaware/s3` with two `query_sources` (one parquet, one
 *    iceberg). Activation registers a kernel query dataset for each.
 *  - Seed a parquet object directly into the fake bucket.
 *  - Export the fixture's local cache dataset to S3 as an Iceberg table
 *    through the iceberg table-format sink.
 *  - Run `executeQuerySql` against both registered datasets and assert
 *    the rows round-tripped, plus the `query.execute_sql` /
 *    `query.scan_dataset` telemetry that proves the S3 read path ran.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('s3_query_roundtrip: tracer provider not installed — expected HYP_DEV_TELEMETRY=1')
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const fixtureDir = path.join(harness.tmpDir, 'plugins', 'test-fixture')
  await writeFixturePlugin(fixtureDir)

  const parquetDir = path.join(PLUGINS_WORKSPACE, 'format-parquet')
  const s3Dir = path.join(PLUGINS_WORKSPACE, 's3')
  const icebergDir = path.join(PLUGINS_WORKSPACE, 'format-iceberg')

  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

  // In-memory S3 object store shared by the iceberg sink (writes) and the
  // query sources (reads), so the round-trip exercises a single bucket.
  /** @type {Map<string, { bytes: Uint8Array, lastModified: Date, etag: string }>} */
  const bucketObjects = new Map()
  /** @returns {string} */
  function nextEtag() { return `"etag-${bucketObjects.size + 1}"` }

  const fakeClient = {
    /** @param {any} input */
    async putObject(input) {
      if (input.IfNoneMatch === '*' && bucketObjects.has(input.Key)) {
        const err = /** @type {Error & { name: string, $metadata: { httpStatusCode: number } }} */ (
          new Error(`PreconditionFailed: object already exists at '${input.Key}'`)
        )
        err.name = 'PreconditionFailed'
        err.$metadata = { httpStatusCode: 412 }
        throw err
      }
      const bytes = input.Body instanceof Uint8Array
        ? input.Body
        : (typeof input.Body === 'string' ? new TextEncoder().encode(input.Body) : Buffer.from(input.Body))
      const etag = nextEtag()
      bucketObjects.set(input.Key, { bytes, lastModified: new Date('2026-05-22T00:00:00Z'), etag })
      return { ETag: etag, VersionId: 'v1' }
    },
    /** @param {any} input */
    async getObject(input) {
      const obj = bucketObjects.get(input.Key)
      if (!obj) {
        const err = /** @type {Error & { name: string, $metadata: { httpStatusCode: number } }} */ (
          new Error(`NoSuchKey: ${input.Key}`)
        )
        err.name = 'NoSuchKey'
        err.$metadata = { httpStatusCode: 404 }
        throw err
      }
      return { Body: Readable.from([obj.bytes]), ContentLength: obj.bytes.byteLength, ETag: obj.etag }
    },
    /** @param {any} input */
    async listObjects(input) {
      const prefix = typeof input.Prefix === 'string' ? input.Prefix : ''
      const contents = Array.from(bucketObjects.entries())
        .filter(([key]) => prefix.length === 0 || key.startsWith(prefix))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, { bytes, lastModified }]) => ({ Key: key, Size: bytes.byteLength, LastModified: lastModified }))
      return { Contents: contents }
    },
    /** @param {any} input */
    async deleteObject(input) {
      bucketObjects.delete(input.Key)
    },
  }

  // --- activate plugins (registers the S3 query datasets) --------------------
  await runRoot(
    'kernel.boot',
    {
      [Attr.COMPONENT]: 'kernel',
      [Attr.OPERATION]: 'boot',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'plugin_activate',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      const { loaded, failed } = await loadManifests([parquetDir, s3Dir, icebergDir, fixtureDir])
      if (failed.length > 0) {
        throw new Error(
          `s3_query_roundtrip: manifest failures — ${failed.map((f) => `${f.manifestPath}: ${f.message}`).join('; ')}`
        )
      }
      /** @type {PluginActivationEntry[]} */
      const entries = loaded.map((l) => {
        if (l.manifest.name === '@hypaware/s3') {
          return {
            manifest: l.manifest,
            rootDir: l.rootDir,
            config: /** @type {any} */ ({
              bucket: BUCKET,
              prefix: PREFIX,
              region: 'us-east-1',
              __blobStoreClientFactory: async () => fakeClient,
              query_sources: QUERY_SOURCES,
            }),
          }
        }
        return { manifest: l.manifest, rootDir: l.rootDir }
      })
      const result = await activatePlugins({
        plugins: entries,
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
      for (const r of result.results) {
        if (!r.ok) throw new Error(`activate ${r.plugin.name} failed (${r.errorKind}): ${r.message}`)
      }
    }
  )

  // The s3 plugin should have registered a dataset per query source.
  for (const src of QUERY_SOURCES) {
    expect.that(`registry: query dataset '${src.name}' registered`, kernel.query.getDataset(src.name), (v) => v !== undefined)
  }

  // --- seed the bare parquet object -----------------------------------------
  const columnData = rowsToColumnSources(PARQUET_COLUMNS, PARQUET_ROWS)
  const parquetBytes = new Uint8Array(parquetWriteBuffer({ columnData, codec: 'SNAPPY' }))
  bucketObjects.set(PARQUET_KEY, { bytes: parquetBytes, lastModified: new Date('2026-05-22T00:00:00Z'), etag: '"parquet-seed"' })

  // --- export the local fixture dataset to S3 as an Iceberg table -----------
  const blobStore = /** @type {BlobStore & { bucket?: string, prefix?: string }} */ (
    kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.blob-store', '^1.0.0')
  )
  const encoder = /** @type {SinkEncoder} */ (
    kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.encoder', '^1.0.0')
  )
  const tableFormat = /** @type {TableFormatProvider} */ (
    kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.table-format', '^1.0.0')
  )

  /** @type {ActivePlugin} */
  const icebergPlugin = {
    name: '@hypaware/format-iceberg',
    version: '1.0.0',
    manifest: {
      schema_version: 1,
      name: '@hypaware/format-iceberg',
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './src/index.js',
    },
    rootDir: icebergDir,
  }
  const handle = await kernel.sinks.instantiate({
    kind: 'table-format',
    instanceName: SINK_INSTANCE,
    tableFormat,
    writerPlugin: '@hypaware/format-iceberg',
    destinationPlugin: '@hypaware/s3',
    blobStore,
    encoder,
    config: { schedule: '* * * * *', encoder: '@hypaware/format-parquet' },
    plugin: icebergPlugin,
    paths: {
      rootDir: icebergDir,
      stateDir: path.join(harness.stateDir, 'plugins', '@hypaware/format-iceberg'),
      cacheDir: path.join(harness.stateDir, 'cache', 'plugins', '@hypaware/format-iceberg'),
      tempDir: path.join(tmpRoot, 'format-iceberg'),
    },
    log: makeNoopLogger(),
    query: kernel.query,
    storage: kernel.storage,
  })

  const localDataset = kernel.query.getDataset(LOCAL_DATASET)
  if (!localDataset) throw new Error(`fixture dataset ${LOCAL_DATASET} did not register`)
  const localPartitions = await localDataset.discoverPartitions({
    config: /** @type {any} */ ({ version: 2 }),
    scope: { limit: 1024 },
    cacheDir: kernel.storage.cacheRoot,
  })
  const exportResult = await handle.sink.exportBatch(
    { batchId: `s3-query-roundtrip-${harness.devRunId}`, partitions: localPartitions },
    { format: 'iceberg', schedule: '* * * * *' }
  )
  expect.that('export: iceberg status=exported', exportResult.status, (v) => v === 'exported')
  expect.that('export: iceberg bytesWritten > 0', exportResult.bytesWritten, (v) => typeof v === 'number' && v > 0)

  // --- query both sources back through executeQuerySql ----------------------
  const parquetResult = await runQuery(harness, 'query_parquet', () =>
    executeQuerySql({
      query: 'SELECT name FROM events_parquet WHERE id = 2',
      registry: kernel.query,
      storage: /** @type {any} */ (kernel.storage),
      config: /** @type {any} */ ({ version: 2 }),
    })
  )
  expect.that('parquet: WHERE id=2 returns one row', parquetResult.rows.length, (v) => v === 1)
  expect.that('parquet: returned name=bob', parquetResult.rows[0]?.name, (v) => v === 'bob')

  const parquetCount = await runQuery(harness, 'query_parquet_count', () =>
    executeQuerySql({
      query: 'SELECT COUNT(*) AS n FROM events_parquet',
      registry: kernel.query,
      storage: /** @type {any} */ (kernel.storage),
      config: /** @type {any} */ ({ version: 2 }),
    })
  )
  expect.that('parquet: row count matches seed', Number(parquetCount.rows[0]?.n), (v) => v === PARQUET_ROWS.length)

  const icebergCount = await runQuery(harness, 'query_iceberg', () =>
    executeQuerySql({
      query: 'SELECT COUNT(*) AS n FROM rows_iceberg',
      registry: kernel.query,
      storage: /** @type {any} */ (kernel.storage),
      config: /** @type {any} */ ({ version: 2 }),
    })
  )
  expect.that('iceberg: row count matches fixture', Number(icebergCount.rows[0]?.n), (v) => v === ICEBERG_ROW_COUNT)

  const icebergRow = await runQuery(harness, 'query_iceberg_filter', () =>
    executeQuerySql({
      query: 'SELECT value FROM rows_iceberg WHERE id = 1',
      registry: kernel.query,
      storage: /** @type {any} */ (kernel.storage),
      config: /** @type {any} */ ({ version: 2 }),
    })
  )
  expect.that('iceberg: WHERE id=1 returns value v1', icebergRow.rows[0]?.value, (v) => v === 'v1')

  await obs.shutdown()

  // --- telemetry: the S3 read path actually ran -----------------------------
  const traces = await expect.traces()
  const execSpans = traces.filter((t) => t.name === 'query.execute_sql')
  expect.that('traces: at least 4 query.execute_sql spans', execSpans.length, (v) => v >= 4)
  expect.that('traces: every query.execute_sql span status=ok', execSpans.every((t) => t.attributes?.status === 'ok'), (v) => v === true)

  const scanSpans = traces.filter((t) => t.name === 'query.scan_dataset')
  const scannedDatasets = new Set(scanSpans.map((t) => t.attributes?.[Attr.DATASET]))
  expect.that('traces: scanned the parquet query dataset', scannedDatasets.has('events_parquet'), (v) => v === true)
  expect.that('traces: scanned the iceberg query dataset', scannedDatasets.has('rows_iceberg'), (v) => v === true)
}

/**
 * Wrap one query in a smoke-step root span so failures localize to the
 * specific query, then return its result.
 *
 * @param {any} harness
 * @param {string} step
 * @param {() => Promise<{ columns: string[], rows: Record<string, unknown>[] }>} fn
 */
async function runQuery(harness, step, fn) {
  return runRoot(
    'smoke.query',
    {
      [Attr.COMPONENT]: 'smoke',
      [Attr.OPERATION]: 'query',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: step,
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    () => fn()
  )
}

/**
 * @param {string} dir
 */
async function writeFixturePlugin(dir) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: '@hypaware/test-fixture',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }
  await fs.writeFile(path.join(dir, 'hypaware.plugin.json'), JSON.stringify(manifest, null, 2))
  await fs.writeFile(path.join(dir, 'index.js'), fixturePluginSource())
}

function fixturePluginSource() {
  return `// auto-generated by s3_query_roundtrip smoke; fixture: @hypaware/test-fixture
import fs from 'node:fs'
import path from 'node:path'

const DATASET = '${LOCAL_DATASET}'
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'value', type: 'STRING', nullable: false },
]

let activatedStorage = null

const dataset = {
  name: DATASET,
  plugin: '@hypaware/test-fixture',
  schema: { columns: COLUMNS },
  primaryTimestampColumn: undefined,
  // appendRows re-partitions rows under datasets/<ds>/source=<client>/, so
  // discover whatever partition dirs actually landed on disk rather than
  // hardcoding a path the writer never used.
  discoverPartitions(ctx) {
    const cacheDir = ctx.cacheDir ?? activatedStorage?.cacheRoot ?? ''
    const base = cacheDir ? path.join(cacheDir, 'datasets', DATASET) : ''
    const parts = []
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '_hypaware_spool') continue
        parts.push({ dataset: DATASET, partition: { partition: entry.name }, tablePath: path.join(base, entry.name) })
      }
    } catch {}
    if (parts.length === 0) {
      parts.push({ dataset: DATASET, partition: { partition: 'all' }, tablePath: base ? path.join(base, 'all') : '' })
    }
    return parts
  },
  async createDataSource(partitions, ctx) {
    const partition = partitions[0]
    if (!partition || !partition.tablePath) return emptySource()
    const source = await ctx.storage.dataSourceForTable(partition.tablePath)
    return source ?? emptySource()
  },
}

function emptySource() {
  return {
    columns: COLUMNS.map((c) => c.name),
    numRows: 0,
    scan() {
      return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} }
    },
  }
}

export async function activate(ctx) {
  activatedStorage = ctx.storage
  ctx.query.registerDataset(dataset)
  const tablePath = ctx.storage.cacheTablePath(DATASET)
  const rows = []
  for (let i = 0; i < ${ICEBERG_ROW_COUNT}; i++) {
    rows.push({ id: BigInt(i), value: 'v' + i })
  }
  await ctx.storage.appendRows(tablePath, COLUMNS, rows)
  // Materialize the spool into the on-disk Iceberg cache table now, using
  // the same storage instance that appended, so the later export reads
  // real rows.
  await ctx.storage.flushTable(tablePath, { force: true, reason: 'fixture_seed' })
}
`
}

function makeNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
}
