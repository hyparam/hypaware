// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  icebergRead,
  loadLatestFileCatalogMetadata,
} from 'icebird'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import {
  createBlobStoreIO,
  tableUrlForBlobPrefix,
} from '../../plugins-workspace/format-iceberg/src/blob-io.js'

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS_WORKSPACE = path.resolve(SMOKE_DIR, '../../plugins-workspace')
const DATASET = 'iceberg_smoke_rows'
const SINK_INSTANCE = 'iceberg_lake'
const ROW_COUNT = 5

/**
 * Hermetic smoke for `@hypaware/format-iceberg` (bead hy-ib-1). Brings
 * up the real `@hypaware/local-fs`, `@hypaware/format-parquet`, and
 * `@hypaware/format-iceberg` plugin trees plus an inline test-fixture
 * dataset that lands 5 rows into the kernel cache, then drives the
 * table-format sink directly through `kernel.sinks.instantiate` and
 * asserts:
 *
 *  - the sink's `exportBatch` returns `status='exported'` with
 *    `bytesWritten > 0` and `partitionsExported === 1`.
 *  - an Iceberg metadata file appeared at the expected BlobStore key
 *    (`<destinationDir>/iceberg/datasets/<dataset>/metadata/v1.metadata.json`).
 *  - `icebird`'s `icebergRead` can read the table back from disk and
 *    returns the same 5 rows the fixture wrote.
 *  - telemetry shows `iceberg.activate` (plugin load), `iceberg.export_batch`,
 *    and `iceberg.snapshot.commit` (or `iceberg.table.create`) spans
 *    carrying the dev_run_id resource attribute.
 *  - the marker is persisted under
 *    `state/exported-batches/<sink>/<dataset>/<batch>.json` so a
 *    second tick would idempotently no-op.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'iceberg_export_local_fs: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }
  if (!obs.meter.provider) {
    throw new Error(
      'iceberg_export_local_fs: meter provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const destinationDir = path.join(harness.tmpDir, 'iceberg-out')
  await fs.mkdir(destinationDir, { recursive: true })

  const fixtureDir = path.join(harness.tmpDir, 'plugins', 'test-fixture')
  await writeFixturePlugin(fixtureDir)

  const parquetDir = path.join(PLUGINS_WORKSPACE, 'format-parquet')
  const localFsDir = path.join(PLUGINS_WORKSPACE, 'local-fs')
  const icebergDir = path.join(PLUGINS_WORKSPACE, 'format-iceberg')

  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

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
      // Activation order: encoder (provides hypaware.encoder), then
      // destination (registers BlobStore + sink contribution), then
      // iceberg (provides table-format), then the dataset fixture
      // (writes cache rows).
      const { loaded, failed } = await loadManifests([parquetDir, localFsDir, icebergDir, fixtureDir])
      if (failed.length > 0) {
        throw new Error(
          `iceberg_export_local_fs: manifest failures — ${failed
            .map((f) => `${f.manifestPath}: ${f.message}`)
            .join('; ')}`
        )
      }
      const entries = loaded.map((l) => ({
        manifest: l.manifest,
        rootDir: l.rootDir,
        // @hypaware/local-fs's BlobStore root is read from
        // `pluginConfig.exports_dir` first; pinning it here keeps the
        // smoke hermetic when HYP_HOME is per-run.
        config: l.manifest.name === '@hypaware/local-fs' ? { exports_dir: destinationDir } : undefined,
      }))
      const result = await activatePlugins({
        plugins: entries,
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
      for (const r of result.results) {
        if (!r.ok) {
          throw new Error(`activate ${r.plugin.name} failed (${r.errorKind}): ${r.message}`)
        }
      }
    }
  )

  // Resolve capability values the kernel registered.
  const blobStore = /** @type {BlobStore} */ (
    kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.blob-store', '^1.0.0')
  )
  const encoder = /** @type {SinkEncoder} */ (
    kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.encoder', '^1.0.0')
  )
  const tableFormat = /** @type {TableFormatProvider} */ (
    kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.table-format', '^1.0.0')
  )
  expect.that('capability: table-format format=iceberg', tableFormat.format, (v) => v === 'iceberg')
  expect.that('capability: blob-store kind=local-fs', blobStore.kind, (v) => v === 'local-fs')
  expect.that('capability: encoder format=parquet', encoder.format, (v) => v === 'parquet')

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
    destinationPlugin: '@hypaware/local-fs',
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
  expect.that('sinks: table-format handle registered',
    handle,
    (v) => v && v.kind === 'table-format' && v.tableFormat === 'iceberg'
  )

  // Discover the dataset partition the fixture registered and
  // simulate one sink tick by calling `exportBatch` directly. (The
  // sink driver auto-tick path is still being wired up — flows in
  // this repo all hand-tick for now.)
  const dataset = kernel.query.getDataset(DATASET)
  if (!dataset) throw new Error(`fixture dataset ${DATASET} did not register`)
  const partitions = await dataset.discoverPartitions({
    config: /** @type {any} */ ({ version: 2 }),
    scope: { limit: 1024 },
    cacheDir: kernel.storage.cacheRoot,
  })
  const exportResult = await handle.sink.exportBatch(
    { batchId: 'iceberg-smoke-batch-1', partitions },
    { format: 'iceberg', schedule: '* * * * *' }
  )
  expect.that('export: status=exported', exportResult.status, (v) => v === 'exported')
  expect.that('export: partitionsExported=1', exportResult.partitionsExported, (v) => v === 1)
  expect.that('export: bytesWritten > 0', exportResult.bytesWritten, (v) => typeof v === 'number' && v > 0)

  // Iceberg landed metadata + data files under the BlobStore root.
  const tableRoot = path.join(destinationDir, 'iceberg', 'datasets', DATASET)
  const metadataDir = path.join(tableRoot, 'metadata')
  const metadataEntries = await fs.readdir(metadataDir)
  expect.that(
    'destination: metadata directory contains a v*.metadata.json file',
    metadataEntries,
    (entries) => Array.isArray(entries) && entries.some((e) => /v\d+\.metadata\.json$/.test(e))
  )

  // `icebird` can read the freshly committed table back through the
  // same BlobStore the writer used. (The manifests store `blob://`
  // URLs that the BlobStore IO adapter resolves; reading via a plain
  // `file://` resolver would not find them.)
  const tableUrl = tableUrlForBlobPrefix(`iceberg/datasets/${DATASET}`)
  const { readTableRows } = await readIcebergTable(tableUrl, blobStore)
  expect.that(
    'icebird: roundtripped row count matches fixture',
    readTableRows,
    (rows) => Array.isArray(rows) && rows.length === ROW_COUNT
  )
  expect.that(
    'icebird: rows carry id+value columns',
    readTableRows[0],
    (row) => row !== undefined && 'id' in row && 'value' in row
  )

  // The state marker proves the writer recorded idempotency state for
  // the batch — a future tick would short-circuit instead of
  // re-staging.
  const markerPath = path.join(
    destinationDir,
    'iceberg',
    'datasets',
    'state',
    'exported-batches',
    SINK_INSTANCE,
    DATASET,
    'iceberg-smoke-batch-1.json'
  )
  const markerStat = await safeStat(markerPath)
  expect.that(
    'marker: state/exported-batches/.../<batch>.json exists after commit',
    markerStat,
    (v) => v !== null && typeof v === 'object' && v.isFile()
  )

  await obs.shutdown()

  // Telemetry assertions.
  const traces = await expect.traces()
  const activateLog = (await expect.logs()).find(
    (l) => l.body === 'iceberg.activate' && l.attributes?.hyp_plugin === '@hypaware/format-iceberg'
  )
  expect.that('logs: iceberg.activate emitted on plugin activation', activateLog, (v) => v !== undefined)

  const exportSpans = traces.filter((t) => t.name === 'iceberg.export_batch')
  expect.that(
    'traces: exactly one iceberg.export_batch span',
    exportSpans,
    (rows) => rows.length === 1
  )
  const exportSpan = exportSpans[0]
  expect.that(
    'traces: iceberg.export_batch hyp_sink_instance matches',
    exportSpan?.attributes?.hyp_sink_instance,
    (v) => v === SINK_INSTANCE
  )
  expect.that(
    'traces: iceberg.export_batch hyp_batch_id recorded',
    exportSpan?.attributes?.hyp_batch_id,
    (v) => v === 'iceberg-smoke-batch-1'
  )
  expect.that(
    'traces: iceberg.export_batch status=ok',
    exportSpan?.attributes?.status,
    (v) => v === 'ok'
  )
  expect.that(
    'traces: iceberg.export_batch resource carries dev_run_id',
    exportSpan?.resource?.dev_run_id,
    (v) => v === harness.devRunId
  )

  const commitSpan = traces.find(
    (t) => (t.name === 'iceberg.snapshot.commit' || t.name === 'iceberg.table.create') &&
      t.attributes?.hyp_sink_instance === SINK_INSTANCE
  )
  expect.that(
    'traces: an iceberg.table.create or iceberg.snapshot.commit span exists',
    commitSpan,
    (v) => v !== undefined
  )
  expect.that(
    'traces: commit span carries non-empty snapshot_id',
    commitSpan?.attributes?.snapshot_id,
    (v) => typeof v === 'string' && v.length > 0
  )
  expect.that(
    'traces: commit span row_count matches fixture',
    commitSpan?.attributes?.row_count,
    (v) => v === ROW_COUNT
  )
  expect.that(
    'traces: commit span bytes_written > 0',
    commitSpan?.attributes?.bytes_written,
    (v) => typeof v === 'number' && v > 0
  )
}

/**
 * @param {string} tableUrl
 * @param {BlobStore} blobStore
 * @returns {Promise<{ readTableRows: Record<string, unknown>[] }>}
 */
async function readIcebergTable(tableUrl, blobStore) {
  const { resolver, lister } = await createBlobStoreIO(blobStore)
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  const rows = await icebergRead({ tableUrl, metadata, resolver })
  return { readTableRows: /** @type {Record<string, unknown>[]} */ (rows) }
}

/**
 * @param {string} p
 */
async function safeStat(p) {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

/**
 * Inline `@hypaware/test-fixture` plugin that registers the
 * `iceberg_smoke_rows` dataset and lands 5 rows in the kernel cache.
 *
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
  return `// auto-generated by iceberg_export_local_fs smoke; fixture: @hypaware/test-fixture
import path from 'node:path'

/**
 * @import { ActivePlugin, BlobStore, SinkEncoder, TableFormatProvider } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

const DATASET = '${DATASET}'
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
  discoverPartitions(ctx) {
    const cacheDir = ctx.cacheDir ?? activatedStorage?.cacheRoot ?? ''
    return [
      {
        dataset: DATASET,
        partition: { partition: 'all' },
        tablePath: cacheDir ? path.join(cacheDir, 'datasets', DATASET, 'all') : '',
      },
    ]
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
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {},
      }
    },
  }
}

export async function activate(ctx) {
  activatedStorage = ctx.storage
  ctx.query.registerDataset(dataset)
  const tablePath = ctx.storage.cacheTablePath(DATASET)
  const rows = []
  for (let i = 0; i < ${ROW_COUNT}; i++) {
    rows.push({ id: BigInt(i), value: 'v' + i })
  }
  await ctx.storage.appendRows(tablePath, COLUMNS, rows)
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
