// @ts-check

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { loadLatestFileCatalogMetadata } from 'icebird'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { appendRowsToTable } from '../../../src/core/cache/iceberg/store.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { createBlobStoreIO, tableUrlForBlobPrefix } from '../../plugins-workspace/format-iceberg/src/blob-io.js'

/**
 * @import { ActivePlugin, BlobStore, ColumnSpec, DatasetRegistration, SinkEncoder, TableFormatProvider } from '../../../hypaware-plugin-kernel-types.js'
 */

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS_WORKSPACE = path.resolve(SMOKE_DIR, '../../plugins-workspace')
const DATASET = 'iceberg_partitioned_rows'
const SINK_INSTANCE = 'iceberg_lake'

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'conversation_id', type: 'STRING', nullable: false },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'value', type: 'STRING', nullable: false },
]

// Four rows over two days and two conversations, interleaved so the
// within-partition conversation sort has work to do.
const ROWS = [
  { conversation_id: 'cB', cwd: '/x', message_created_at: '2026-06-04T10:00:00Z', date: '2026-06-04', value: 'b1' },
  { conversation_id: 'cA', cwd: '/x', message_created_at: '2026-06-04T09:00:00Z', date: '2026-06-04', value: 'a1' },
  { conversation_id: 'cB', cwd: '/x', message_created_at: '2026-06-05T10:00:00Z', date: '2026-06-05', value: 'b2' },
  { conversation_id: 'cA', cwd: '/x', message_created_at: '2026-06-05T09:00:00Z', date: '2026-06-05', value: 'a2' },
]

/**
 * Hermetic smoke for `@hypaware/format-iceberg` day-grain partitioning
 * (LLP 0022). Brings up the real `@hypaware/local-fs`,
 * `@hypaware/format-parquet`, and `@hypaware/format-iceberg` plugin trees,
 * registers a timestamped + lookup-keyed dataset, lands 4 rows over 2 days
 * directly in the kernel cache, drives the table-format sink through
 * `kernel.sinks.instantiate`, and asserts the exported table is laid out
 * for an archive's job:
 *
 *  - export succeeds (`status='exported'`, `bytesWritten > 0`).
 *  - the committed metadata carries a `day(message_created_at)` partition
 *    spec and a `conversation_id`-led sort order.
 *  - the 4 rows land in exactly 2 data files: one per day partition.
 *  - each data file's rows read back ordered by `conversation_id` (the
 *    sort happened on write, not just in metadata).
 *  - the `iceberg.table.create` span carries `hyp_partition_spec` and
 *    `hyp_sort_order` so the layout is observable, not just inferred.
 *
 * Note: rows are pre-populated via the direct cache write
 * (`appendRowsToTable`) rather than `ctx.storage.appendRows`, so this flow
 * exercises the export layout without depending on the spool-flush path.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('iceberg_export_partitioned_local_fs: tracer not installed - expected HYP_DEV_TELEMETRY=1')
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const destinationDir = path.join(harness.tmpDir, 'iceberg-out')
  await fs.mkdir(destinationDir, { recursive: true })

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
      const { loaded, failed } = await loadManifests([parquetDir, localFsDir, icebergDir])
      if (failed.length > 0) {
        throw new Error(`manifest failures - ${failed.map((f) => `${f.manifestPath}: ${f.message}`).join('; ')}`)
      }
      const entries = loaded.map((l) => ({
        manifest: l.manifest,
        rootDir: l.rootDir,
        config: l.manifest.name === '@hypaware/local-fs' ? { exports_dir: destinationDir } : undefined,
      }))
      const result = await activatePlugins({
        plugins: entries, stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel, tmpRoot,
      })
      for (const r of result.results) {
        if (!r.ok) throw new Error(`activate ${r.plugin.name} failed (${r.errorKind}): ${r.message}`)
      }
    }
  )

  // Register the dataset directly on the kernel registry and pre-populate
  // the cache table the export will read. The day grain + sort are derived
  // by the writer from this registration at commit time.
  const tablePath = kernel.storage.cacheTablePath(DATASET)
  /** @type {DatasetRegistration} */
  const dataset = {
    name: DATASET,
    plugin: '@hypaware/test-fixture',
    schema: { columns: COLUMNS },
    primaryTimestampColumn: 'message_created_at',
    cachePartitioning: {
      source: { columns: ['conversation_id'], fallback: 'unknown' },
      iceberg: {
        fields: [
          { column: 'conversation_id', transform: 'identity', required: true },
          { column: 'cwd', transform: 'identity' },
          { column: 'date', transform: 'identity', required: true },
        ],
      },
    },
    discoverPartitions: () => [{ dataset: DATASET, partition: { partition: 'all' }, tablePath }],
    createDataSource: () => ({ columns: COLUMNS.map((c) => c.name), numRows: 0, scan: () => ({ appliedWhere: false, appliedLimitOffset: false, async *rows() {} }) }),
  }
  kernel.query.registerDataset(dataset)
  await appendRowsToTable(tablePath, COLUMNS, ROWS)

  const blobStore = /** @type {BlobStore} */ (kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.blob-store', '^1.0.0'))
  const encoder = /** @type {SinkEncoder} */ (kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.encoder', '^1.0.0'))
  const tableFormat = /** @type {TableFormatProvider} */ (kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.table-format', '^1.0.0'))

  /** @type {ActivePlugin} */
  const icebergPlugin = {
    name: '@hypaware/format-iceberg',
    version: '1.0.0',
    manifest: { schema_version: 1, name: '@hypaware/format-iceberg', version: '1.0.0', hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './src/index.js' },
    rootDir: icebergDir,
  }
  const handle = await kernel.sinks.instantiate({
    kind: 'table-format', instanceName: SINK_INSTANCE, tableFormat,
    writerPlugin: '@hypaware/format-iceberg', destinationPlugin: '@hypaware/local-fs',
    blobStore, encoder,
    config: { schedule: '* * * * *', encoder: '@hypaware/format-parquet' },
    plugin: icebergPlugin,
    paths: {
      rootDir: icebergDir,
      stateDir: path.join(harness.stateDir, 'plugins', '@hypaware/format-iceberg'),
      cacheDir: path.join(harness.stateDir, 'cache', 'plugins', '@hypaware/format-iceberg'),
      tempDir: path.join(tmpRoot, 'format-iceberg'),
    },
    log: makeNoopLogger(), query: kernel.query, storage: kernel.storage,
  })

  const partitions = await dataset.discoverPartitions(/** @type {any} */ ({ cacheDir: kernel.storage.cacheRoot, scope: {} }))
  const exportResult = await handle.sink.exportBatch(
    { batchId: 'partitioned-batch-1', partitions },
    { format: 'iceberg', schedule: '* * * * *' }
  )
  expect.that('export: status=exported', exportResult.status, (v) => v === 'exported')
  expect.that('export: bytesWritten > 0', exportResult.bytesWritten, (v) => typeof v === 'number' && v > 0)

  // Read the committed table metadata back and assert the archive layout.
  const tableUrl = tableUrlForBlobPrefix(`iceberg/datasets/${DATASET}`)
  const { resolver, lister } = await createBlobStoreIO(blobStore)
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })

  const spec = metadata['partition-specs'].find((s) => s['spec-id'] === metadata['default-spec-id'])
  expect.that(
    'layout: partition spec is day(message_created_at)',
    (spec?.fields ?? []).map((f) => `${f.transform}(${f.name})`).join(','),
    (v) => v === 'day(message_created_at)'
  )
  const order = (metadata['sort-orders'] ?? []).find((o) => o['order-id'] === metadata['default-sort-order-id'])
  expect.that(
    'layout: default sort order leads with conversation_id',
    order?.fields?.[0]?.['source-id'],
    (v) => v === 1
  )

  // 4 rows over 2 days ⇒ exactly 2 data files (one per day partition).
  const dataDir = path.join(destinationDir, 'iceberg', 'datasets', DATASET, 'data')
  const dataFiles = fsSync.readdirSync(dataDir).filter((f) => f.endsWith('.parquet'))
  expect.that('layout: 4 rows landed in 2 day-partition files', dataFiles.length, (v) => v === 2)

  // The sort must be real on disk, not just recorded metadata: each day
  // file holds cB-then-cA input, so sorted output reads back cA, cB.
  for (const file of dataFiles) {
    const fileRows = await parquetReadObjects({
      file: await asyncBufferFromFile(path.join(dataDir, file)),
      columns: ['conversation_id'],
    })
    expect.that(
      `layout: ${file} rows are sorted by conversation_id`,
      fileRows.map((r) => r.conversation_id).join(','),
      (v) => v === 'cA,cB'
    )
  }

  await obs.shutdown()

  // The layout is observable on the create span.
  const traces = await expect.traces()
  const createSpan = traces.find(
    (t) => t.name === 'iceberg.table.create' && t.attributes?.hyp_sink_instance === SINK_INSTANCE
  )
  expect.that('traces: iceberg.table.create span exists', createSpan, (v) => v !== undefined)
  expect.that(
    'traces: hyp_partition_spec = day(message_created_at)',
    createSpan?.attributes?.hyp_partition_spec,
    (v) => v === 'day(message_created_at)'
  )
  expect.that(
    'traces: hyp_sort_order clusters by conversation_id',
    createSpan?.attributes?.hyp_sort_order,
    (v) => typeof v === 'string' && v.startsWith('conversation_id')
  )
}

function makeNoopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} }
}
