// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parquetReadObjects } from 'hyparquet'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createSinkDriver } from '../../../src/core/sinks/driver.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS_WORKSPACE = path.resolve(SMOKE_DIR, '../../plugins-workspace')
const DATASET = 'dummy_rows'
const SINK_INSTANCE = 'archive'
const ROW_COUNT = 50

/**
 * Phase 8.3 smoke. Stands up the real `@hypaware/format-parquet` and
 * `@hypaware/local-fs` plugin trees (from
 * `hypaware-core/plugins-workspace/`) plus an inline `@hypaware/test-fixture`
 * dataset that lands 50 rows into the cache, then fires one sink-driver
 * tick and asserts:
 *
 *   - a Parquet file landed at
 *     `<config.dir>/<dataset>/partition=all/all.parquet`
 *   - the file is decodable by `parquetReadObjects` and matches the
 *     fixture rows
 *   - the kernel emitted a `sink.resolved` log carrying
 *     `hyp_sink_supports='queryable'` for the parquet+local-fs pair
 *   - the encoder emitted an `encoder.encode_parquet` span carrying
 *     `row_count=50`, `bytes_written>0`, and `compression='SNAPPY'`
 *
 * The smoke is a real plugin integration — the dataset rows are written
 * into the kernel's Iceberg cache, then exported through the production
 * sink driver, encoder, and destination paths.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'blob_sink_parquet_local_fs: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }
  if (!obs.meter.provider) {
    throw new Error(
      'blob_sink_parquet_local_fs: meter provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const destinationDir = path.join(harness.tmpDir, 'sink-out')
  await fs.mkdir(destinationDir, { recursive: true })

  const fixtureDir = path.join(harness.tmpDir, 'plugins', 'test-fixture')
  await writeFixturePlugin(fixtureDir)

  const parquetDir = path.join(PLUGINS_WORKSPACE, 'format-parquet')
  const localFsDir = path.join(PLUGINS_WORKSPACE, 'local-fs')

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
      // Activation order matters: encoder first (provides
      // hypaware.encoder), then destination (registers the sink
      // contribution), then the dataset fixture (writes cache rows).
      const { loaded, failed } = await loadManifests([parquetDir, localFsDir, fixtureDir])
      if (failed.length > 0) {
        throw new Error(
          `blob_sink_parquet_local_fs: manifest failures — ${failed
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

  // Resolve the encoder + destination pair the kernel just registered.
  // `@hypaware/local-fs` is identified as the requester for the
  // require() because that's the plugin whose capability dependency the
  // encoder satisfies; the resolved encoder is what the kernel hands to
  // the destination through `SinkCreateContext.encoder`.
  const encoder = /** @type {import('../../../collectivus-plugin-kernel-types').SinkEncoder} */ (
    kernel.capabilities.require('@hypaware/local-fs', 'hypaware.encoder', '^1.0.0')
  )
  expect.that(
    'capability: parquet encoder resolved with supports=queryable',
    encoder.supports,
    (v) => Array.isArray(v) && v.includes('queryable')
  )
  expect.that(
    'capability: encoder format=parquet, extension=parquet',
    [encoder.format, encoder.extension],
    ([f, e]) => f === 'parquet' && e === 'parquet'
  )

  const contribution = kernel.sinks.getContribution('@hypaware/local-fs', 'local-fs')
  expect.that(
    'sinks: local-fs contributed a local-fs sink',
    contribution,
    (v) => v !== undefined
  )
  if (!contribution) return

  /** @type {import('../../../collectivus-plugin-kernel-types').ActivePlugin} */
  const destinationPlugin = {
    name: '@hypaware/local-fs',
    version: '1.0.0',
    manifest: {
      schema_version: 1,
      name: '@hypaware/local-fs',
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './src/index.js',
    },
    rootDir: localFsDir,
  }
  await kernel.sinks.instantiate({
    kind: 'blob',
    instanceName: SINK_INSTANCE,
    destination: contribution,
    writerPlugin: '@hypaware/format-parquet',
    encoder,
    config: {
      schedule: '* * * * *',
      dir: destinationDir,
    },
    plugin: destinationPlugin,
    paths: {
      rootDir: localFsDir,
      stateDir: path.join(harness.stateDir, 'plugins', '@hypaware/local-fs'),
      cacheDir: path.join(harness.stateDir, 'cache', 'plugins', '@hypaware/local-fs'),
      tempDir: path.join(tmpRoot, 'local-fs'),
    },
    log: makeNoopLogger(),
  })

  const driver = createSinkDriver({
    sinkRegistry: kernel.sinks,
    queryRegistry: kernel.query,
    storage: kernel.storage,
    stateRoot: harness.stateDir,
  })

  // Fire at a minute boundary so "* * * * *" matches in every field.
  const report = await driver.tick({ now: new Date('2026-02-15T10:00:00Z') })

  expect.that(
    'driver: tick reported exactly one sink fired',
    report.sinks,
    (v) => Array.isArray(v) && v.length === 1
  )
  const sinkReport = report.sinks[0]
  expect.that(
    'driver: archive sink status=exported',
    sinkReport?.status,
    (v) => v === 'exported'
  )
  expect.that(
    'driver: archive sink wrote bytes',
    sinkReport?.bytesWritten,
    (v) => typeof v === 'number' && v > 0
  )

  // Path: <destinationDir>/<dataset>/<partition-segment>/<filename>.
  // The fixture's only partition is `{partition: 'all'}`, so both the
  // directory and the file render as `partition=all` (different encoders
  // can short-circuit to `all.parquet` for partition-less datasets via
  // the empty-entries branch).
  const expectedDir = path.join(destinationDir, DATASET, 'partition=all')
  const expectedFile = path.join(expectedDir, 'partition=all.parquet')
  const stat = await fs.stat(expectedFile)
  expect.that(
    `destination: ${expectedFile} is a non-empty regular file`,
    stat,
    (s) => s.isFile() && s.size > 0
  )

  // The Parquet file should round-trip 50 dummy_rows back through
  // `parquetReadObjects`.
  const parquetBytes = await fs.readFile(expectedFile)
  const arrayBuffer = parquetBytes.buffer.slice(
    parquetBytes.byteOffset,
    parquetBytes.byteOffset + parquetBytes.byteLength
  )
  const decoded = await parquetReadObjects({ file: asyncBufferFromArrayBuffer(arrayBuffer) })
  expect.that(
    'parquet: decoded row count matches fixture',
    decoded,
    (rows) => Array.isArray(rows) && rows.length === ROW_COUNT
  )
  expect.that(
    'parquet: rows carry id+value columns',
    decoded[0],
    (row) => row !== undefined && 'id' in row && 'value' in row
  )
  expect.that(
    'parquet: first row id=0, value=v0',
    [decoded[0]?.id, decoded[0]?.value],
    ([id, value]) => (id === 0n || id === 0) && value === 'v0'
  )

  await obs.shutdown()

  // sink.resolved log was emitted by the kernel with the resolved
  // writer+destination pair and the intersected supports set.
  const logs = await expect.logs()
  const resolvedLog = logs.find(
    (l) => l.body === 'sink.resolved' && l.attributes?.hyp_sink_instance === SINK_INSTANCE
  )
  expect.that(
    'logs: sink.resolved emitted for archive instance',
    resolvedLog,
    (v) => v !== undefined
  )
  expect.that(
    'logs: sink.resolved hyp_sink_supports=queryable',
    resolvedLog?.attributes?.hyp_sink_supports,
    (v) => v === 'queryable'
  )
  expect.that(
    'logs: sink.resolved hyp_sink_writer=@hypaware/format-parquet',
    resolvedLog?.attributes?.hyp_sink_writer,
    (v) => v === '@hypaware/format-parquet'
  )
  expect.that(
    'logs: sink.resolved hyp_sink_destination=@hypaware/local-fs',
    resolvedLog?.attributes?.hyp_sink_destination,
    (v) => v === '@hypaware/local-fs'
  )

  // encoder.encode_parquet span with row_count, bytes_written, compression.
  const traces = await expect.traces()
  const encodeSpans = traces.filter((t) => t.name === 'encoder.encode_parquet')
  expect.that(
    'traces: exactly one encoder.encode_parquet span',
    encodeSpans,
    (rows) => rows.length === 1
  )
  const encodeSpan = encodeSpans[0]
  expect.that(
    'traces: encoder.encode_parquet hyp_plugin=@hypaware/format-parquet',
    encodeSpan?.attributes?.hyp_plugin,
    (v) => v === '@hypaware/format-parquet'
  )
  expect.that(
    'traces: encoder.encode_parquet status=ok',
    encodeSpan?.status,
    (v) => v === 'ok'
  )
  expect.that(
    'traces: encoder.encode_parquet row_count=50',
    encodeSpan?.attributes?.row_count,
    (v) => v === ROW_COUNT
  )
  expect.that(
    'traces: encoder.encode_parquet bytes_written > 0',
    encodeSpan?.attributes?.bytes_written,
    (v) => typeof v === 'number' && v > 0
  )
  expect.that(
    'traces: encoder.encode_parquet compression=SNAPPY',
    encodeSpan?.attributes?.compression,
    (v) => v === 'SNAPPY'
  )
  // The bead's SQL assertion filters by `dev_run_id`; the JSONL
  // exporter projects resource attributes onto each span, so the
  // future `hyp query` SQL layer will see the run id either way.
  expect.that(
    'traces: encoder.encode_parquet carries dev_run_id (resource)',
    encodeSpan?.resource?.dev_run_id,
    (v) => v === harness.devRunId
  )

  // sink.export_batch landed status=ok and recorded the same byte total.
  const exportSpan = traces.find(
    (t) => t.name === 'sink.export_batch' && t.attributes?.hyp_sink_instance === SINK_INSTANCE
  )
  expect.that(
    'traces: sink.export_batch span exists for archive',
    exportSpan,
    (v) => v !== undefined
  )
  expect.that(
    'traces: sink.export_batch status=ok',
    exportSpan?.attributes?.status,
    (v) => v === 'ok'
  )
}

/**
 * Wrap an ArrayBuffer in the `AsyncBuffer` shape `hyparquet` expects.
 *
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
 * Reuse the Phase 5 fixture: register the `dummy_rows` dataset and
 * materialize 50 rows into the cache so the driver discovers a ready
 * partition.
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
  return `// auto-generated by blob_sink_parquet_local_fs smoke; fixture: @hypaware/test-fixture
import path from 'node:path'

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
