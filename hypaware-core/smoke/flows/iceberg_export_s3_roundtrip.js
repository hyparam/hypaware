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

/**
 * @import { ActivePlugin, BlobStore, JsonObject, SinkEncoder, TableFormatProvider } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { PluginActivationEntry } from '../../../src/core/runtime/loader.d.ts'
 */

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS_WORKSPACE = path.resolve(SMOKE_DIR, '../../plugins-workspace')
const DATASET = 'iceberg_s3_roundtrip_rows'
const SINK_INSTANCE = 'iceberg_s3_lake_real'
const ROW_COUNT = 7

/**
 * Acceptance smoke for `@hypaware/format-iceberg` against a REAL S3
 * (or MinIO) bucket. Env-gated by `HYP_SMOKE_REAL_S3=1`. Required env:
 *
 *   HYP_SMOKE_REAL_S3=1              opt-in
 *   HYP_SMOKE_S3_BUCKET=<bucket>     destination bucket
 *   HYP_SMOKE_S3_REGION=<region>     AWS region (default us-east-1)
 *   HYP_SMOKE_S3_PREFIX=<prefix>     optional key prefix (default 'hyp-smoke-iceberg')
 *   HYP_SMOKE_S3_ENDPOINT=<url>      optional non-AWS endpoint (MinIO etc.)
 *   HYP_SMOKE_S3_FORCE_PATH_STYLE=1  optional path-style addressing (MinIO etc.)
 *   HYP_SMOKE_S3_PROFILE=<profile>   optional AWS profile name
 *
 * On every run a unique sub-prefix `<base>/<dev_run_id>/` isolates the
 * smoke's writes from concurrent runs. The smoke cleans up by listing
 * and deleting every key under that sub-prefix at the end.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  if (process.env.HYP_SMOKE_REAL_S3 !== '1') {
    process.stdout.write(
      `iceberg_export_s3_roundtrip: SKIPPED (set HYP_SMOKE_REAL_S3=1 to opt in)\n`
    )
    return
  }
  const bucket = process.env.HYP_SMOKE_S3_BUCKET
  if (!bucket) {
    throw new Error('iceberg_export_s3_roundtrip: HYP_SMOKE_S3_BUCKET is required when HYP_SMOKE_REAL_S3=1')
  }
  const region = process.env.HYP_SMOKE_S3_REGION ?? 'us-east-1'
  const basePrefix = process.env.HYP_SMOKE_S3_PREFIX ?? 'hyp-smoke-iceberg'
  const endpointUrl = process.env.HYP_SMOKE_S3_ENDPOINT
  const forcePathStyle = process.env.HYP_SMOKE_S3_FORCE_PATH_STYLE === '1'
  const profile = process.env.HYP_SMOKE_S3_PROFILE
  // Each run lands under a unique sub-prefix so two concurrent smokes
  // do not clobber each other and cleanup is a single recursive delete.
  const runPrefix = `${basePrefix.replace(/\/+$/, '')}/${harness.devRunId}`

  const obs = installObservability()
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
          `iceberg_export_s3_roundtrip: manifest failures — ${failed
            .map((f) => `${f.manifestPath}: ${f.message}`)
            .join('; ')}`
        )
      }
      /** @type {PluginActivationEntry[]} */
      const entries = loaded.map((l) => {
        if (l.manifest.name === '@hypaware/s3') {
          /** @type {JsonObject} */
          const config = {
            bucket,
            prefix: runPrefix,
            region,
          }
          if (endpointUrl) config.endpoint_url = endpointUrl
          if (forcePathStyle) config.force_path_style = true
          if (profile) config.profile = profile
          return { manifest: l.manifest, rootDir: l.rootDir, config }
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
        if (!r.ok) {
          throw new Error(`activate ${r.plugin.name} failed (${r.errorKind}): ${r.message}`)
        }
      }
    }
  )

  const blobStore = /** @type {BlobStore & { bucket?: string, prefix?: string }} */ (
    kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.blob-store', '^1.0.0')
  )
  const encoder = /** @type {SinkEncoder} */ (
    kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.encoder', '^1.0.0')
  )
  const tableFormat = /** @type {TableFormatProvider} */ (
    kernel.capabilities.require('@hypaware/format-iceberg', 'hypaware.table-format', '^1.0.0')
  )
  expect.that('capability: blob-store kind=s3', blobStore.kind, (v) => v === 's3')
  expect.that('capability: blob-store bucket surfaced', blobStore.bucket, (v) => v === bucket)
  expect.that('capability: blob-store prefix surfaced', blobStore.prefix, (v) => v === runPrefix)

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

  let exportSucceeded = false
  try {
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

    const dataset = kernel.query.getDataset(DATASET)
    if (!dataset) throw new Error(`fixture dataset ${DATASET} did not register`)
    const partitions = await dataset.discoverPartitions({
      config: /** @type {any} */ ({ version: 2 }),
      scope: { limit: 1024 },
      cacheDir: kernel.storage.cacheRoot,
    })
    const exportResult = await handle.sink.exportBatch(
      { batchId: `iceberg-s3-roundtrip-${harness.devRunId}`, partitions },
      { format: 'iceberg', schedule: '* * * * *' }
    )
    expect.that('export: status=exported', exportResult.status, (v) => v === 'exported')
    expect.that('export: partitionsExported=1', exportResult.partitionsExported, (v) => v === 1)
    expect.that('export: bytesWritten > 0', exportResult.bytesWritten, (v) => typeof v === 'number' && v > 0)

    const tableUrl = tableUrlForBlobPrefix(`iceberg/datasets/${DATASET}`)
    const { resolver, lister } = await createBlobStoreIO(blobStore)
    const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
    expect.that(
      'reader: latest metadata has current-snapshot-id',
      metadata?.['current-snapshot-id'],
      (v) => v !== undefined && String(v).length > 0,
    )
    const readRows = await icebergRead({ tableUrl, metadata, resolver })
    expect.that(
      'reader: roundtripped row count matches fixture',
      readRows,
      (rows) => Array.isArray(rows) && rows.length === ROW_COUNT,
    )
    exportSucceeded = true
  } finally {
    // Clean up the run-specific prefix even if the export itself failed,
    // so the smoke does not leak objects into the shared bucket. Cleanup
    // failures are surfaced but do not mask the original assertion.
    try {
      await cleanupPrefix(blobStore)
    } catch (err) {
      if (exportSucceeded) throw err
      process.stderr.write(
        `iceberg_export_s3_roundtrip: cleanup failed (${err instanceof Error ? err.message : String(err)})\n`
      )
    }
  }

  await obs.shutdown()
}

/**
 * Walk the BlobStore's configured prefix and delete every key found.
 * Used as teardown so each acceptance-smoke run leaves no objects
 * behind in the shared bucket.
 *
 * @param {BlobStore} blobStore
 */
async function cleanupPrefix(blobStore) {
  /** @type {string[]} */
  const toDelete = []
  for await (const entry of blobStore.listObjects({ prefix: '' })) {
    toDelete.push(entry.key)
  }
  if (!blobStore.deleteObject) return
  for (const key of toDelete) {
    await blobStore.deleteObject({ key })
  }
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
  return `// auto-generated by iceberg_export_s3_roundtrip smoke; fixture: @hypaware/test-fixture
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
