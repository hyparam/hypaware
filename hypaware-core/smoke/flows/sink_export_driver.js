// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { createSinkDriver } from '../../../src/core/sinks/driver.js'

/**
 * @import { ActivePlugin, SinkEncoder } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Phase 5 smoke. Stands up:
 *
 *   - `@hypaware/test-encoder`: provides `hypaware.encoder@1` with a
 *     trivial CSV-ish encoder.
 *   - `@hypaware/test-fs`: provides `hypaware.blob-store@1` and
 *     registers a sink contribution `local-fs` that writes encoded
 *     partition bytes to `<config.dir>/<filename>`.
 *   - `@hypaware/test-fixture`: registers the `dummy_rows` dataset and
 *     materializes 50 rows into the cache so the driver has something to
 *     hand to the sink.
 *
 * Then instantiates a sink instance `test` (blob shape: writer=test-encoder
 * + destination=test-fs, schedule="* * * * *"), fires
 * `driver.tick({ now })` once, and verifies:
 *
 *   - bytes landed in `<config.dir>` (files exist, non-empty)
 *   - one `sink.export_batch` trace with `hyp_sink_instance=test`,
 *     `status=ok`, `bytes_written>0`, `partitions_count>=1`
 *   - the metrics table records
 *     `hyp_sink_exports_total{sink_instance=test, status=ok} >= 1`
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'sink_export_driver: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }
  if (!obs.meter.provider) {
    throw new Error(
      'sink_export_driver: meter provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const destinationDir = path.join(harness.tmpDir, 'sink-out')
  await fs.mkdir(destinationDir, { recursive: true })

  const encoderDir = path.join(harness.tmpDir, 'plugins', 'test-encoder')
  const fsDir = path.join(harness.tmpDir, 'plugins', 'test-fs')
  const fixtureDir = path.join(harness.tmpDir, 'plugins', 'test-fixture')
  await writeEncoderPlugin(encoderDir)
  await writeFsSinkPlugin(fsDir)
  await writeFixturePlugin(fixtureDir)

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
      // Activation order matters: encoder first (provides capability),
      // then fs (provides destination + sink contribution), then the
      // fixture (writes rows into the cache).
      const { loaded } = await loadManifests([encoderDir, fsDir, fixtureDir])
      const entries = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir }))
      return activatePlugins({
        plugins: entries,
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
    }
  )

  // Resolve the encoder via the global capability registry, then
  // instantiate the blob sink with it.
  const encoder = /** @type {SinkEncoder} */ (
    kernel.capabilities.require('@hypaware/test-fs', 'hypaware.encoder', '^1.0.0')
  )
  const contribution = kernel.sinks.getContribution('@hypaware/test-fs', 'local-fs')
  expect.that(
    'sinks: test-fs contributed a local-fs sink',
    contribution,
    (v) => v !== undefined
  )
  if (!contribution) return

  /** @type {ActivePlugin} */
  const destinationPlugin = {
    name: '@hypaware/test-fs',
    version: '1.0.0',
    manifest: { schema_version: 1, name: '@hypaware/test-fs', version: '1.0.0', hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './index.js' },
    rootDir: fsDir,
  }
  await kernel.sinks.instantiate({
    kind: 'blob',
    instanceName: 'test',
    destination: contribution,
    writerPlugin: '@hypaware/test-encoder',
    encoder,
    config: {
      schedule: '* * * * *',
      dir: destinationDir,
    },
    plugin: destinationPlugin,
    paths: {
      rootDir: fsDir,
      stateDir: path.join(harness.stateDir, 'plugins', '@hypaware/test-fs'),
      cacheDir: path.join(harness.stateDir, 'cache', 'plugins', '@hypaware/test-fs'),
      tempDir: path.join(tmpRoot, 'test-fs'),
    },
    log: makeNoopLogger(),
  })

  const driver = createSinkDriver({
    sinkRegistry: kernel.sinks,
    queryRegistry: kernel.query,
    storage: kernel.storage,
    stateRoot: harness.stateDir,
  })

  // Fire the tick at a minute boundary so `"* * * * *"` matches in
  // every field (the cron evaluator otherwise needs no help here).
  const report = await driver.tick({ now: new Date('2026-02-15T10:00:00Z') })

  expect.that(
    'driver: tick reported exactly one sink fired',
    report.sinks,
    (v) => Array.isArray(v) && v.length === 1
  )
  const sinkReport = report.sinks[0]
  expect.that(
    'driver: test sink status was exported',
    sinkReport?.status,
    (v) => v === 'exported'
  )
  expect.that(
    'driver: test sink bytesWritten > 0',
    sinkReport?.bytesWritten,
    (v) => typeof v === 'number' && v > 0
  )

  // Files should have landed in the destination dir.
  const written = await fs.readdir(destinationDir)
  expect.that(
    'destination: at least one file written',
    written,
    (v) => Array.isArray(v) && v.length >= 1
  )
  const sizes = await Promise.all(
    written.map(async (name) => (await fs.stat(path.join(destinationDir, name))).size)
  )
  expect.that(
    'destination: every written file is non-empty',
    sizes,
    (rows) => rows.length > 0 && rows.every((n) => n > 0)
  )

  await obs.shutdown()

  const traces = await expect.traces()
  const exportSpans = traces.filter((t) => t.name === 'sink.export_batch')
  expect.that(
    'traces: exactly one sink.export_batch span',
    exportSpans,
    (rows) => rows.length === 1
  )
  const exportSpan = exportSpans[0]
  expect.that(
    'traces: sink.export_batch hyp_sink_instance=test',
    exportSpan?.attributes?.hyp_sink_instance,
    (v) => v === 'test'
  )
  expect.that(
    'traces: sink.export_batch status=ok',
    exportSpan?.attributes?.status,
    (v) => v === 'ok'
  )
  expect.that(
    'traces: sink.export_batch span.status=ok',
    exportSpan?.status,
    (v) => v === 'ok'
  )
  expect.that(
    'traces: sink.export_batch bytes_written > 0',
    exportSpan?.attributes?.bytes_written,
    (v) => typeof v === 'number' && v > 0
  )
  expect.that(
    'traces: sink.export_batch partitions_count >= 1',
    exportSpan?.attributes?.partitions_count,
    (v) => typeof v === 'number' && v >= 1
  )

  // sink.register log was emitted with sink_kind/writer/destination/supports.
  const logs = await expect.logs()
  const registerLog = logs.find(
    (l) => l.body === 'sink.register' && l.attributes?.hyp_sink_instance === 'test'
  )
  expect.that(
    'logs: sink.register emitted for instance test',
    registerLog,
    (v) => v !== undefined
  )
  expect.that(
    'logs: sink.register has sink_kind=blob',
    registerLog?.attributes?.hyp_sink_kind,
    (v) => v === 'blob'
  )
  expect.that(
    'logs: sink.register has writer=@hypaware/test-encoder',
    registerLog?.attributes?.hyp_sink_writer,
    (v) => v === '@hypaware/test-encoder'
  )
  expect.that(
    'logs: sink.register has destination=@hypaware/test-fs',
    registerLog?.attributes?.hyp_sink_destination,
    (v) => v === '@hypaware/test-fs'
  )

  // sink.encode_partition span shows the encoder ran via the helper.
  const encodeSpans = traces.filter((t) => t.name === 'sink.encode_partition')
  expect.that(
    'traces: at least one sink.encode_partition span',
    encodeSpans,
    (rows) => rows.length >= 1
  )
  expect.that(
    'traces: sink.encode_partition has hyp_sink_format=csvish',
    encodeSpans[0]?.attributes?.hyp_sink_format,
    (v) => v === 'csvish'
  )

  // Metrics: hyp_sink_exports_total{sink_instance=test, status=ok} >= 1
  const metrics = await expect.metrics()
  const exportMetric = metrics.find(
    (m) => m.name === 'hyp_sink_exports_total'
      && m.attributes?.hyp_sink_instance === 'test'
      && m.attributes?.status === 'ok'
  )
  expect.that(
    'metrics: hyp_sink_exports_total{sink_instance=test,status=ok} exists',
    exportMetric,
    (v) => v !== undefined
  )
  expect.that(
    'metrics: hyp_sink_exports_total{sink_instance=test,status=ok} >= 1',
    Number(exportMetric?.value ?? 0),
    (v) => v >= 1
  )

  // Metrics: hyp_sinks_registered{sink_instance=test, sink_kind=blob} >= 1
  const registeredMetric = metrics.find(
    (m) => m.name === 'hyp_sinks_registered'
      && m.attributes?.hyp_sink_instance === 'test'
      && m.attributes?.hyp_sink_kind === 'blob'
  )
  expect.that(
    'metrics: hyp_sinks_registered{sink_instance=test,sink_kind=blob} exists',
    registeredMetric,
    (v) => v !== undefined
  )

  // No outbox file should exist for the green path.
  let outboxEntries = []
  try {
    outboxEntries = await fs.readdir(path.join(harness.stateDir, 'sinks', 'test', 'outbox'))
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
  }
  expect.that(
    'state: outbox is empty after a green tick',
    outboxEntries,
    (rows) => Array.isArray(rows) && rows.length === 0
  )
}

/**
 * @param {string} dir
 */
async function writeEncoderPlugin(dir) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: '@hypaware/test-encoder',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    provides: { capabilities: { 'hypaware.encoder': '1.0.0' } },
  }
  await fs.writeFile(path.join(dir, 'hypaware.plugin.json'), JSON.stringify(manifest, null, 2))
  await fs.writeFile(path.join(dir, 'index.js'), encoderPluginSource())
}

function encoderPluginSource() {
  return `// auto-generated by sink_export_driver smoke; fixture: @hypaware/test-encoder
const encoder = {
  format: 'csvish',
  extension: 'csv',
  supports: ['queryable'],
  async encodePartition(partition, ctx) {
    const datasetTag = partition.dataset || 'unknown'
    const partitionTag = Object.entries(partition.partition || {}).map(([k, v]) => k + '=' + v).join(',') || 'all'
    // Trivial fixed payload (the smoke is testing the driver, not the
    // encoder's row fidelity). 50 lines so bytes_written > 0 unambiguously.
    const lines = []
    for (let i = 0; i < 50; i++) {
      lines.push(datasetTag + ',' + partitionTag + ',' + i + ',v' + i)
    }
    const bytes = new TextEncoder().encode(lines.join('\\n') + '\\n')
    return {
      filename: datasetTag + '__' + partitionTag.replace(/[^A-Za-z0-9._=,-]/g, '_') + '.csv',
      bytes,
      bytesWritten: bytes.byteLength,
      rowCount: 50,
    }
  },
}

export async function activate(ctx) {
  ctx.provideCapability('hypaware.encoder', '1.0.0', encoder)
}
`
}

/**
 * @param {string} dir
 */
async function writeFsSinkPlugin(dir) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: '@hypaware/test-fs',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    provides: { capabilities: { 'hypaware.blob-store': '1.0.0' } },
    contributes: { sinks: [{ name: 'local-fs', supports: ['queryable'] }] },
  }
  await fs.writeFile(path.join(dir, 'hypaware.plugin.json'), JSON.stringify(manifest, null, 2))
  await fs.writeFile(path.join(dir, 'index.js'), fsSinkPluginSource())
}

function fsSinkPluginSource() {
  return `// auto-generated by sink_export_driver smoke; fixture: @hypaware/test-fs
import fs from 'node:fs/promises'
import path from 'node:path'

import { encodePartition } from '${pathToCoreEncoderHelper()}'

export async function activate(ctx) {
  const log = ctx.log
  // Provide the blob-store capability as a marker; the kernel uses
  // capability presence to validate writer/destination pairs even when
  // the destination's exportBatch does the byte-write inline.
  ctx.provideCapability('hypaware.blob-store', '1.0.0', { kind: 'local-fs' })

  ctx.sinks.register({
    name: 'local-fs',
    plugin: '@hypaware/test-fs',
    supports: ['queryable'],
    async create(sinkCtx) {
      const dir = String(sinkCtx.config.dir || '')
      if (!dir) throw new Error('test-fs: sinks.<name>.config.dir is required')
      await fs.mkdir(dir, { recursive: true })
      const encoder = sinkCtx.encoder
      if (!encoder) throw new Error('test-fs: blob sink requires an encoder via SinkCreateContext.encoder')

      return {
        async exportBatch(batch, opts) {
          let bytesWritten = 0
          let exported = 0
          /** @type {any[]} */
          const failures = []
          for (const partition of batch.partitions) {
            try {
              const blob = await encodePartition(encoder, partition, {
                log: sinkCtx.log,
                tempDir: sinkCtx.paths.tempDir,
                sinkInstance: sinkCtx.name,
                plugin: '@hypaware/test-fs',
              })
              const out = path.join(dir, blob.filename)
              if (blob.bytes instanceof Uint8Array) {
                await fs.writeFile(out, blob.bytes)
                bytesWritten += blob.bytes.byteLength
              } else {
                // Streaming case: assemble into a single write for the
                // smoke; production blob stores would pipe instead.
                const chunks = []
                for await (const chunk of blob.bytes) {
                  chunks.push(chunk)
                  bytesWritten += chunk.byteLength
                }
                await fs.writeFile(out, Buffer.concat(chunks))
              }
              exported += 1
            } catch (err) {
              failures.push(partition)
              log.warn('test-fs export partition failed', { message: String(err) })
            }
          }
          return {
            status: failures.length === 0 ? 'exported' : 'partial',
            partitionsExported: exported,
            bytesWritten,
            retryPartitions: failures.length > 0 ? failures : undefined,
          }
        },
        async close() {},
      }
    },
  })
}
`
}

/**
 * Resolve a file:// URL the spawned fixture plugin can import the
 * kernel's encoder helper from. Plugins are loaded by absolute path,
 * so an absolute file URL gives us a stable import target without
 * depending on Node's relative-path resolution from a tmp dir.
 */
function pathToCoreEncoderHelper() {
  const here = path.dirname(import.meta.filename ?? new URL(import.meta.url).pathname)
  const target = path.resolve(here, '../../../src/core/sinks/encoder.js')
  return new URL('file://' + target).href
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
  return `// auto-generated by sink_export_driver smoke; fixture: @hypaware/test-fixture
import path from 'node:path'

/**
 * @import { ActivePlugin, SinkEncoder } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

const DATASET = 'dummy_rows'
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
  for (let i = 0; i < 50; i++) {
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
