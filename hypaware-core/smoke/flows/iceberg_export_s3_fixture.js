// @ts-check

import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

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
 * @import { ActivePlugin, BlobStore, SinkEncoder, TableFormatProvider } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS_WORKSPACE = path.resolve(SMOKE_DIR, '../../plugins-workspace')
const DATASET = 'iceberg_s3_smoke_rows'
const SINK_INSTANCE = 'iceberg_s3_lake'
const ROW_COUNT = 5
const BUCKET = 'acme-iceberg-bucket'
const PREFIX = 'lake/iceberg'

/**
 * Hermetic acceptance smoke for `@hypaware/format-iceberg` running over a
 * fake `@hypaware/s3` BlobStore. Asserts:
 *
 *  - The iceberg writer routes every metadata.json commit through the s3
 *    BlobStore with `IfNoneMatch: '*'`.
 *  - A simulated concurrent collision on the FIRST metadata commit
 *    surfaces `iceberg_commit_conflict` end-to-end, then icebird retries
 *    transparently and the second attempt succeeds.
 *  - The committed table is readable through `icebird` from the same
 *    fake bucket the writer used.
 *  - The `iceberg.snapshot.commit` (or `iceberg.table.create`) span
 *    carries `bucket`, `prefix`, `hyp_blob_store_kind='s3'`, and an
 *    `etag` attribute from the synthetic S3 response.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('iceberg_export_s3_fixture: tracer provider not installed — expected HYP_DEV_TELEMETRY=1')
  }
  if (!obs.meter.provider) {
    throw new Error('iceberg_export_s3_fixture: meter provider not installed — expected HYP_DEV_TELEMETRY=1')
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

  // In-memory S3 object store the fake client persists to. Each
  // PutObject/GetObject/ListObjects records the request shape so the
  // assertions can pin ifNoneMatch and key layout.
  /** @type {Map<string, { bytes: Uint8Array, lastModified: Date, etag: string }>} */
  const bucketObjects = new Map()
  /** @type {Array<{ command: string, input: any }>} */
  const calls = []
  // Used to force the first conditional metadata commit to fail with a
  // PreconditionFailed so we exercise icebird's append retry loop end-to-end.
  let firstConditionalMetadataFailed = false

  /** @returns {string} */
  function nextEtag() { return `"etag-${bucketObjects.size + 1}"` }

  const fakeClient = {
    async putObject(input) {
      calls.push({ command: 'putObject', input })
      const isConditional = input.IfNoneMatch === '*'
      const isMetadataFile = typeof input.Key === 'string' && /metadata\/v\d+\.metadata\.json$/.test(input.Key)
      // Only force the simulated concurrent-writer collision on APPEND
      // commits (v2+). icebergCreateTable does not retry, so colliding
      // on the initial v1 write would surface an unrecoverable conflict
      // and is the wrong shape to model "another writer just committed
      // a snapshot ahead of us".
      const isAppendCommit = isMetadataFile && !input.Key.endsWith('v1.metadata.json')
      if (isConditional && isAppendCommit && !firstConditionalMetadataFailed) {
        firstConditionalMetadataFailed = true
        const err = /** @type {Error & { name: string, $metadata: { httpStatusCode: number } }} */ (
          new Error(`PreconditionFailed: object already exists at '${input.Key}'`)
        )
        err.name = 'PreconditionFailed'
        err.$metadata = { httpStatusCode: 412 }
        throw err
      }
      if (isConditional && bucketObjects.has(input.Key)) {
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
      bucketObjects.set(input.Key, {
        bytes,
        lastModified: new Date('2026-05-22T00:00:00Z'),
        etag,
      })
      return { ETag: etag, VersionId: 'v1' }
    },
    async getObject(input) {
      calls.push({ command: 'getObject', input })
      const obj = bucketObjects.get(input.Key)
      if (!obj) {
        const err = /** @type {Error & { name: string, $metadata: { httpStatusCode: number } }} */ (
          new Error(`NoSuchKey: ${input.Key}`)
        )
        err.name = 'NoSuchKey'
        err.$metadata = { httpStatusCode: 404 }
        throw err
      }
      return {
        Body: Readable.from([obj.bytes]),
        ContentLength: obj.bytes.byteLength,
        ETag: obj.etag,
      }
    },
    async listObjects(input) {
      calls.push({ command: 'listObjects', input })
      const prefix = typeof input.Prefix === 'string' ? input.Prefix : ''
      const contents = Array.from(bucketObjects.entries())
        .filter(([key]) => prefix.length === 0 || key.startsWith(prefix))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, { bytes, lastModified }]) => ({
          Key: key,
          Size: bytes.byteLength,
          LastModified: lastModified,
        }))
      return { Contents: contents }
    },
    async deleteObject(input) {
      calls.push({ command: 'deleteObject', input })
      bucketObjects.delete(input.Key)
    },
  }

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
          `iceberg_export_s3_fixture: manifest failures — ${failed
            .map((f) => `${f.manifestPath}: ${f.message}`)
            .join('; ')}`
        )
      }
      const entries = loaded.map((l) => {
        // Pin the @hypaware/s3 plugin config so its BlobStore boots over
        // the fake client factory pointed at our in-memory bucket.
        if (l.manifest.name === '@hypaware/s3') {
          return {
            manifest: l.manifest,
            rootDir: l.rootDir,
            config: {
              bucket: BUCKET,
              prefix: PREFIX,
              region: 'us-east-1',
              __blobStoreClientFactory: async () => fakeClient,
            },
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
  expect.that('capability: blob-store bucket surfaced', blobStore.bucket, (v) => v === BUCKET)
  expect.that('capability: blob-store prefix surfaced', blobStore.prefix, (v) => v === PREFIX)
  expect.that('capability: encoder format=parquet', encoder.format, (v) => v === 'parquet')
  expect.that('capability: table-format format=iceberg', tableFormat.format, (v) => v === 'iceberg')

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

  const dataset = kernel.query.getDataset(DATASET)
  if (!dataset) throw new Error(`fixture dataset ${DATASET} did not register`)
  const partitions = await dataset.discoverPartitions({
    config: /** @type {any} */ ({ version: 2 }),
    scope: { limit: 1024 },
    cacheDir: kernel.storage.cacheRoot,
  })
  const exportResult = await handle.sink.exportBatch(
    { batchId: 'iceberg-s3-smoke-batch-1', partitions },
    { format: 'iceberg', schedule: '* * * * *' }
  )
  expect.that('export: status=exported', exportResult.status, (v) => v === 'exported')
  expect.that('export: partitionsExported=1', exportResult.partitionsExported, (v) => v === 1)
  expect.that('export: bytesWritten > 0', exportResult.bytesWritten, (v) => typeof v === 'number' && v > 0)

  // Conditional commit path was actually exercised: the simulated 412
  // fired AND at least one ifNoneMatch=* metadata write succeeded.
  expect.that(
    'concurrency: first metadata commit was forced to PreconditionFailed',
    firstConditionalMetadataFailed,
    (v) => v === true,
  )
  const conditionalMetadataPuts = calls.filter(
    (c) => c.command === 'putObject' &&
      typeof c.input.Key === 'string' && /metadata\/v\d+\.metadata\.json$/.test(c.input.Key) &&
      c.input.IfNoneMatch === '*'
  )
  expect.that(
    's3: at least 2 conditional metadata puts observed (one collision + one success)',
    conditionalMetadataPuts.length,
    (v) => typeof v === 'number' && v >= 2,
  )
  expect.that(
    's3: every conditional metadata put landed under the configured prefix',
    conditionalMetadataPuts.every((c) => c.input.Key.startsWith(`${PREFIX}/`)),
    (v) => v === true,
  )

  // icebird could read the freshly committed table back from the fake
  // bucket. We hit the same BlobStore the writer used so the listing
  // walk + getObject path is exercised end-to-end.
  const tableUrl = tableUrlForBlobPrefix(`iceberg/datasets/${DATASET}`)
  const { resolver, lister } = await createBlobStoreIO(blobStore)
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  expect.that(
    'reader: latest metadata has a current-snapshot-id',
    metadata?.['current-snapshot-id'],
    (v) => v !== undefined && String(v).length > 0,
  )
  const readRows = await icebergRead({ tableUrl, metadata, resolver })
  expect.that(
    'reader: roundtripped row count matches fixture',
    readRows,
    (rows) => Array.isArray(rows) && rows.length === ROW_COUNT,
  )

  await obs.shutdown()

  // Telemetry assertions: commit span carries s3-specific attributes.
  const traces = await expect.traces()
  const commitSpan = traces.find(
    (t) => (t.name === 'iceberg.snapshot.commit' || t.name === 'iceberg.table.create') &&
      t.attributes?.hyp_sink_instance === SINK_INSTANCE
  )
  expect.that(
    'traces: iceberg.snapshot.commit (or table.create) span exists',
    commitSpan,
    (v) => v !== undefined,
  )
  expect.that(
    'traces: commit span hyp_blob_store_kind=s3',
    commitSpan?.attributes?.hyp_blob_store_kind,
    (v) => v === 's3',
  )
  expect.that(
    'traces: commit span bucket attribute matches sink config',
    commitSpan?.attributes?.bucket,
    (v) => v === BUCKET,
  )
  expect.that(
    'traces: commit span prefix attribute matches sink config',
    commitSpan?.attributes?.prefix,
    (v) => v === PREFIX,
  )
  expect.that(
    'traces: commit span etag attribute populated from synthetic S3 response',
    commitSpan?.attributes?.etag,
    (v) => typeof v === 'string' && v.startsWith('"etag-'),
  )

  // No AWS-shaped credential material reached telemetry.
  const dangerous = /AKIA[A-Z0-9]{12,}|aws_secret_access_key|aws_session_token/i
  for (const trace of traces) {
    const payload = JSON.stringify(trace)
    if (dangerous.test(payload)) {
      throw new Error(`iceberg_export_s3_fixture: credential-shaped substring found in span: ${trace.name}`)
    }
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
  return `// auto-generated by iceberg_export_s3_fixture smoke; fixture: @hypaware/test-fixture
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
