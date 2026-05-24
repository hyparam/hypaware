// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parquetReadObjects } from 'hyparquet'

import {
  Attr,
  getLogger,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createSinkDriver } from '../../../src/core/sinks/driver.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'

/**
 * @import { ActivePlugin, SinkEncoder } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS_WORKSPACE = path.resolve(SMOKE_DIR, '../../plugins-workspace')
const DATASET = 'dummy_rows'
const SINK_INSTANCE = 'archive_s3'
const ROW_COUNT = 50
const BUCKET = 'acme-test-bucket'
const PREFIX = 'hypaware'

/**
 * Hermetic acceptance smoke for `@hypaware/s3`. Stands up the real
 * `@hypaware/format-parquet` and `@hypaware/s3` plugin trees (from
 * `hypaware-core/plugins-workspace/`) plus an inline
 * `@hypaware/test-fixture` dataset that lands 50 rows into the cache,
 * then fires one sink-driver tick against an injected fake S3 client
 * and asserts:
 *
 *   - The fake S3 client received exactly one PutObject call carrying
 *     the expected `Bucket`, `Key` (under `<prefix>/<dataset>/...`),
 *     and non-empty `Body`.
 *   - The encoded body is decodable Parquet matching the fixture rows.
 *   - The kernel emitted `sink.resolved`, `sink.encode_partition`, and
 *     `s3.put_object` log/span events with expected attributes.
 *   - No credential material (AKIA... access key ids, secret strings)
 *     appears in any captured log, span, or metric attribute.
 *
 * The injection seam is `sinkCtx.config.__clientFactory`. Production
 * configs never carry this key — it lives outside the validated config
 * shape so it cannot be set via JSON config files.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('s3_sink_export_fixture: tracer provider not installed — expected HYP_DEV_TELEMETRY=1')
  }
  if (!obs.meter.provider) {
    throw new Error('s3_sink_export_fixture: meter provider not installed — expected HYP_DEV_TELEMETRY=1')
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const fixtureDir = path.join(harness.tmpDir, 'plugins', 'test-fixture')
  await writeFixturePlugin(fixtureDir)

  const parquetDir = path.join(PLUGINS_WORKSPACE, 'format-parquet')
  const s3Dir = path.join(PLUGINS_WORKSPACE, 's3')

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
      const { loaded, failed } = await loadManifests([parquetDir, s3Dir, fixtureDir])
      if (failed.length > 0) {
        throw new Error(
          `s3_sink_export_fixture: manifest failures — ${failed
            .map((f) => `${f.manifestPath}: ${f.message}`)
            .join('; ')}`
        )
      }
      const entries = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir }))
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

  const encoder = /** @type {SinkEncoder} */ (
    kernel.capabilities.require('@hypaware/s3', 'hypaware.encoder', '^1.0.0')
  )
  expect.that(
    'capability: parquet encoder resolved with supports=queryable',
    encoder.supports,
    (v) => Array.isArray(v) && v.includes('queryable')
  )

  const contribution = kernel.sinks.getContribution('@hypaware/s3', 's3')
  expect.that(
    'sinks: @hypaware/s3 contributed an s3 sink',
    contribution,
    (v) => v !== undefined
  )
  if (!contribution) return

  // Build the fake S3 client. The factory records every PutObject input
  // so we can assert on bucket/key/body content downstream, and returns
  // a synthetic `ETag` to mimic AWS SDK behavior. The factory itself
  // is the injection seam — production never carries `__clientFactory`.
  /** @type {Array<{ Bucket: string, Key: string, Body: Uint8Array, ContentType?: string, StorageClass?: string }>} */
  const recordedPuts = []
  const fakeClientFactory = async (opts) => {
    return {
      credential_source_kind: 'injected',
      client: {
        async putObject(input) {
          /** @type {Uint8Array} */
          let bytes
          if (input.Body instanceof Uint8Array) {
            bytes = input.Body
          } else if (typeof input.Body === 'string') {
            bytes = new TextEncoder().encode(input.Body)
          } else {
            bytes = new Uint8Array(0)
          }
          recordedPuts.push({
            Bucket: input.Bucket,
            Key: input.Key,
            Body: bytes,
            ContentType: input.ContentType,
            StorageClass: input.StorageClass,
          })
          return { ETag: '"fake-etag"', VersionId: undefined }
        },
        destroy() {},
      },
    }
  }

  /** @type {ActivePlugin} */
  const destinationPlugin = {
    name: '@hypaware/s3',
    version: '1.0.0',
    manifest: {
      schema_version: 1,
      name: '@hypaware/s3',
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './src/index.js',
    },
    rootDir: s3Dir,
  }
  await kernel.sinks.instantiate({
    kind: 'blob',
    instanceName: SINK_INSTANCE,
    destination: contribution,
    writerPlugin: '@hypaware/format-parquet',
    encoder,
    config: {
      schedule: '* * * * *',
      bucket: BUCKET,
      prefix: PREFIX,
      region: 'us-east-1',
      storage_class: 'STANDARD',
      __clientFactory: fakeClientFactory,
    },
    plugin: destinationPlugin,
    paths: {
      rootDir: s3Dir,
      stateDir: path.join(harness.stateDir, 'plugins', '@hypaware/s3'),
      cacheDir: path.join(harness.stateDir, 'cache', 'plugins', '@hypaware/s3'),
      tempDir: path.join(tmpRoot, 's3'),
    },
    log: makePluginLogger('@hypaware/s3'),
  })

  const driver = createSinkDriver({
    sinkRegistry: kernel.sinks,
    queryRegistry: kernel.query,
    storage: kernel.storage,
    stateRoot: harness.stateDir,
  })

  const report = await driver.tick({ now: new Date('2026-02-15T10:00:00Z') })

  expect.that(
    'driver: tick reported exactly one sink fired',
    report.sinks,
    (v) => Array.isArray(v) && v.length === 1
  )
  const sinkReport = report.sinks[0]
  expect.that(
    'driver: archive_s3 sink status=exported',
    sinkReport?.status,
    (v) => v === 'exported'
  )
  expect.that(
    'driver: archive_s3 sink wrote bytes',
    sinkReport?.bytesWritten,
    (v) => typeof v === 'number' && v > 0
  )

  // Fake S3 received exactly one PutObject under the expected bucket/key.
  expect.that(
    's3: fake client received exactly one PutObject',
    recordedPuts.length,
    (v) => v === 1
  )
  const put = recordedPuts[0]
  expect.that(
    's3: PutObject bucket matches sink config',
    put?.Bucket,
    (v) => v === BUCKET
  )
  expect.that(
    `s3: PutObject key under ${PREFIX}/${DATASET}/`,
    put?.Key,
    (v) => typeof v === 'string' && v.startsWith(`${PREFIX}/${DATASET}/`)
  )
  expect.that(
    's3: PutObject key ends with the encoder filename',
    put?.Key,
    (v) => typeof v === 'string' && v.endsWith('.parquet')
  )
  expect.that(
    's3: PutObject body is non-empty',
    put?.Body?.byteLength,
    (v) => typeof v === 'number' && v > 0
  )
  expect.that(
    's3: PutObject body parses as Parquet matching the fixture rows',
    put?.Body,
    async (bytes) => {
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      const decoded = await parquetReadObjects({ file: asyncBufferFromArrayBuffer(arrayBuffer) })
      return Array.isArray(decoded) && decoded.length === ROW_COUNT
    }
  )
  expect.that(
    's3: PutObject ContentType is application/vnd.apache.parquet',
    put?.ContentType,
    (v) => v === 'application/vnd.apache.parquet'
  )
  expect.that(
    's3: PutObject StorageClass matches config',
    put?.StorageClass,
    (v) => v === 'STANDARD'
  )

  await obs.shutdown()

  // Telemetry assertions.
  const logs = await expect.logs()
  const initLog = logs.find(
    (l) => l.body === 's3.client.init' && l.attributes?.hyp_sink_instance === SINK_INSTANCE
  )
  expect.that(
    'logs: s3.client.init emitted for archive_s3',
    initLog,
    (v) => v !== undefined
  )
  expect.that(
    'logs: s3.client.init credential_source_kind=injected',
    initLog?.attributes?.credential_source_kind,
    (v) => v === 'injected'
  )
  expect.that(
    'logs: s3.client.init carries bucket',
    initLog?.attributes?.bucket,
    (v) => v === BUCKET
  )

  const putLog = logs.find(
    (l) => l.body === 's3.put_object' && l.attributes?.hyp_sink_instance === SINK_INSTANCE
  )
  expect.that(
    'logs: s3.put_object emitted for archive_s3',
    putLog,
    (v) => v !== undefined
  )
  expect.that(
    'logs: s3.put_object hyp_dataset=dummy_rows',
    putLog?.attributes?.hyp_dataset,
    (v) => v === DATASET
  )
  expect.that(
    'logs: s3.put_object object_key starts with the configured prefix',
    putLog?.attributes?.object_key,
    (v) => typeof v === 'string' && v.startsWith(`${PREFIX}/${DATASET}/`)
  )
  expect.that(
    'logs: s3.put_object row_count=50',
    putLog?.attributes?.row_count,
    (v) => v === ROW_COUNT
  )
  expect.that(
    'logs: s3.put_object bytes_written > 0',
    putLog?.attributes?.bytes_written,
    (v) => typeof v === 'number' && v > 0
  )
  expect.that(
    'logs: s3.put_object status=ok',
    putLog?.attributes?.status,
    (v) => v === 'ok'
  )

  // Resolved-sink log carries supports=queryable.
  const resolvedLog = logs.find(
    (l) => l.body === 'sink.resolved' && l.attributes?.hyp_sink_instance === SINK_INSTANCE
  )
  expect.that(
    'logs: sink.resolved emitted for archive_s3',
    resolvedLog,
    (v) => v !== undefined
  )
  expect.that(
    'logs: sink.resolved hyp_sink_destination=@hypaware/s3',
    resolvedLog?.attributes?.hyp_sink_destination,
    (v) => v === '@hypaware/s3'
  )
  expect.that(
    'logs: sink.resolved hyp_sink_supports=queryable',
    resolvedLog?.attributes?.hyp_sink_supports,
    (v) => v === 'queryable'
  )

  // sink.encode_partition span was emitted by the encoder helper.
  const traces = await expect.traces()
  const encodeSpan = traces.find(
    (t) => t.name === 'sink.encode_partition' && t.attributes?.hyp_sink_instance === SINK_INSTANCE
  )
  expect.that(
    'traces: sink.encode_partition span exists for archive_s3',
    encodeSpan,
    (v) => v !== undefined
  )
  expect.that(
    'traces: sink.encode_partition hyp_plugin=@hypaware/s3',
    encodeSpan?.attributes?.hyp_plugin,
    (v) => v === '@hypaware/s3'
  )
  expect.that(
    'traces: sink.encode_partition row_count=50',
    encodeSpan?.attributes?.row_count,
    (v) => v === ROW_COUNT
  )

  // sink.export_batch landed status=ok for the archive_s3 instance.
  const exportSpan = traces.find(
    (t) => t.name === 'sink.export_batch' && t.attributes?.hyp_sink_instance === SINK_INSTANCE
  )
  expect.that(
    'traces: sink.export_batch span exists for archive_s3',
    exportSpan,
    (v) => v !== undefined
  )
  expect.that(
    'traces: sink.export_batch status=ok',
    exportSpan?.attributes?.status,
    (v) => v === 'ok'
  )

  // Credential redaction: walk every captured log / span attribute and
  // assert nothing matches the access-key-id / secret-shaped fingerprint.
  // The fake client factory never receives credentials in the first
  // place, but this assertion pins the contract for future refactors.
  const dangerous = /AKIA[A-Z0-9]{12,}|aws_secret_access_key|aws_session_token/i
  for (const log of logs) {
    const payload = JSON.stringify(log)
    if (dangerous.test(payload)) {
      throw new Error(`s3_sink_export_fixture: credential-shaped substring found in log: ${log.body}`)
    }
  }
  for (const trace of traces) {
    const payload = JSON.stringify(trace)
    if (dangerous.test(payload)) {
      throw new Error(`s3_sink_export_fixture: credential-shaped substring found in span: ${trace.name}`)
    }
  }
}

/**
 * @param {ArrayBufferLike} buffer
 * @returns {{ byteLength: number, slice(start: number, end?: number): ArrayBuffer }}
 */
function asyncBufferFromArrayBuffer(buffer) {
  return {
    byteLength: buffer.byteLength,
    slice(start, end) {
      return buffer.slice(start, end ?? buffer.byteLength)
    },
  }
}

/**
 * Same fixture pattern as `blob_sink_parquet_local_fs.js`: register a
 * `dummy_rows` dataset and materialize 50 rows into the cache so the
 * driver discovers a ready partition.
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
  return `// auto-generated by s3_sink_export_fixture smoke; fixture: @hypaware/test-fixture
import path from 'node:path'

/**
 * @import { ActivePlugin, SinkEncoder } from '../../../collectivus-plugin-kernel-types.d.ts'
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

/**
 * Build the per-instance logger the smoke hands to
 * `kernel.sinks.instantiate`. Routes every emission through OTEL so
 * `expect.logs()` can read them off the JSONL exporter, exactly as
 * the real activation-context plugin logger does in production.
 *
 * @param {string} pluginName
 */
function makePluginLogger(pluginName) {
  const base = getLogger('plugin')
  /**
   * @param {Record<string, unknown> | undefined} fields
   */
  function withPlugin(fields) {
    return { ...(fields ?? {}), [Attr.PLUGIN]: pluginName }
  }
  return {
    debug(message, fields) { base.debug(message, withPlugin(fields)) },
    info(message, fields)  { base.info(message,  withPlugin(fields)) },
    warn(message, fields)  { base.warn(message,  withPlugin(fields)) },
    error(message, fields) { base.error(message, withPlugin(fields)) },
  }
}
