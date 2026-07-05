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
import { maintainCache } from '../../../src/core/cache/maintenance.js'
import { readCursorSync } from '../../../src/core/cache/partition.js'

/**
 * @import { ActivePlugin, ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 * @import { Dirent } from 'node:fs'
 */

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS_WORKSPACE = path.resolve(SMOKE_DIR, '../../plugins-workspace')
const DATASET = 'proxy'
const SOURCE = 'claude'
const SINK_INSTANCE = 'archive'

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: false },
  { name: 'msg', type: 'STRING', nullable: false },
]

/**
 * Acceptance smoke for incremental sink reads (LLP 0040, T6) through the REAL
 * sink driver. Stands up `@hypaware/format-parquet` + `@hypaware/local-fs` plus
 * a fixture `proxy` dataset, then drives the blob sink across the cache rewrite
 * that makes incremental export hard — a compaction GENERATION SWAP — and proves:
 *
 *   - tick 1 (3 rows): one parquet blob lands carrying exactly those rows;
 *   - tick 2 (no new rows): the sink writes NO new blob and reports ≈0 bytes;
 *   - a compaction rewrites the partition into a fresh `table-<seq>` dir;
 *   - tick 3 (2 new rows): exactly one new blob lands carrying ONLY the 2 new
 *     rows — the row-resident `_hyp_ingest_seq` rode the compaction verbatim and
 *     the logical-path watermark read straight through the generation swap;
 *   - across all ticks every row is exported exactly once (no skip, no dup).
 *
 * The forward-sink and retention-prune equivalents are covered by the
 * deterministic acceptance suite in `test/core/sink-incremental-acceptance.test.js`.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0040#exactly-once-argument [tests] — blob sink reads straight through a compaction generation swap; ≈0 on no-new-rows, ≈N on N-new
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('incremental_sink_compaction: tracer provider not installed — expected HYP_DEV_TELEMETRY=1')
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const destinationDir = path.join(harness.tmpDir, 'sink-out')
  await fs.mkdir(destinationDir, { recursive: true })

  const fixtureDir = path.join(harness.tmpDir, 'plugins', 'test-proxy')
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
      const { loaded, failed } = await loadManifests([parquetDir, localFsDir, fixtureDir])
      if (failed.length > 0) {
        throw new Error(`incremental_sink_compaction: manifest failures — ${failed.map((f) => `${f.manifestPath}: ${f.message}`).join('; ')}`)
      }
      const entries = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir }))
      const result = await activatePlugins({ plugins: entries, stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel, tmpRoot })
      for (const r of result.results) {
        if (!r.ok) throw new Error(`activate ${r.plugin.name} failed (${r.errorKind}): ${r.message}`)
      }
    }
  )

  const encoder = /** @type {any} */ (kernel.capabilities.require('@hypaware/local-fs', 'hypaware.encoder', '^1.0.0'))
  const contribution = kernel.sinks.getContribution('@hypaware/local-fs', 'local-fs')
  expect.that('sinks: local-fs contributed a local-fs sink', contribution, (v) => v !== undefined)
  if (!contribution) return

  /** @type {ActivePlugin} */
  const destinationPlugin = {
    name: '@hypaware/local-fs',
    version: '1.0.0',
    manifest: { schema_version: 1, name: '@hypaware/local-fs', version: '1.0.0', hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './src/index.js' },
    rootDir: localFsDir,
  }
  await kernel.sinks.instantiate({
    kind: 'blob',
    instanceName: SINK_INSTANCE,
    destination: contribution,
    writerPlugin: '@hypaware/format-parquet',
    encoder,
    config: { schedule: '* * * * *', dir: destinationDir },
    plugin: destinationPlugin,
    paths: {
      rootDir: localFsDir,
      stateDir: path.join(harness.stateDir, 'plugins', '@hypaware/local-fs'),
      cacheDir: path.join(harness.stateDir, 'cache', 'plugins', '@hypaware/local-fs'),
      tempDir: path.join(tmpRoot, 'local-fs'),
    },
    log: makeNoopLogger(),
  })

  const driver = createSinkDriver({ sinkRegistry: kernel.sinks, queryRegistry: kernel.query, storage: kernel.storage, stateRoot: harness.stateDir })
  const now = new Date('2026-02-15T10:00:00Z')
  const spoolPath = kernel.storage.cacheTablePath(DATASET, ['all'])

  // ---- tick 1: 3 rows -> one blob carrying exactly {0,1,2} ----
  await flushRows(kernel.storage, spoolPath, [0, 1, 2])
  const t1 = await driver.tick({ now, force: true })
  expect.that('tick 1: blob sink exported', t1.sinks[0]?.status, (v) => v === 'exported')
  expect.that('tick 1: bytes written > 0', t1.sinks[0]?.bytesWritten, (v) => typeof v === 'number' && v > 0)
  let blobs = await readBlobs(destinationDir)
  expect.that('tick 1: exactly one blob written', blobs, (b) => b.length === 1)
  expect.that('tick 1: blob carries rows {0,1,2}', blobs[0]?.ids, (ids) => sameSet(ids, [0, 1, 2]))

  // ---- tick 2: no new rows -> NO new blob, ≈0 bytes ----
  const t2 = await driver.tick({ now, force: true })
  expect.that('tick 2: status exported (no-op)', t2.sinks[0]?.status, (v) => v === 'exported')
  expect.that('tick 2: ≈0 bytes on a no-new-rows tick', t2.sinks[0]?.bytesWritten, (v) => v === 0)
  blobs = await readBlobs(destinationDir)
  expect.that('tick 2: no second blob for a no-new-rows tick', blobs, (b) => b.length === 1)

  // ---- compaction generation swap ----
  const sourceDir = path.join(cacheRoot, 'datasets', DATASET, `source=${SOURCE}`)
  await flushRows(kernel.storage, spoolPath, [3, 4])
  const before = readCursorSync(sourceDir).tableDir ?? 'table'
  const maint = await maintainCache({ cacheRoot, force: true, compactOnly: true })
  expect.that('compaction: at least one partition compacted', maint.totalCompacted, (v) => typeof v === 'number' && v > 0)
  const after = readCursorSync(sourceDir).tableDir ?? 'table'
  expect.that('compaction: generation directory swapped', [before, after], ([b, a]) => b !== a)

  // ---- tick 3: 2 new rows -> exactly one new blob carrying ONLY {3,4} ----
  const t3 = await driver.tick({ now, force: true })
  expect.that('tick 3: blob sink exported', t3.sinks[0]?.status, (v) => v === 'exported')
  blobs = await readBlobs(destinationDir)
  expect.that('tick 3: exactly two blobs total', blobs, (b) => b.length === 2)
  const newest = blobs[blobs.length - 1]
  expect.that('tick 3: new blob carries ONLY {3,4} (seq survived compaction)', newest?.ids, (ids) => sameSet(ids, [3, 4]))

  // ---- exactly-once across the whole run ----
  const allIds = blobs.flatMap((b) => b.ids).sort((a, b) => a - b)
  expect.that('exactly-once: union of exported rows is {0,1,2,3,4}', allIds, (ids) => sameSet(ids, [0, 1, 2, 3, 4]))
  expect.that('exactly-once: no row exported twice', allIds, (ids) => new Set(ids).size === ids.length)

  await obs.shutdown()

  // ---- telemetry: the export path and the encoder both ran ----
  const traces = await expect.traces()
  const exportSpans = traces.filter((t) => t.name === 'sink.export_batch' && t.attributes?.hyp_sink_instance === SINK_INSTANCE)
  expect.that('traces: sink.export_batch spans for the archive instance (one per tick)', exportSpans, (rows) => rows.length >= 3)
  const encodeSpans = traces.filter((t) => t.name === 'encoder.encode_parquet')
  expect.that('traces: encoder.encode_parquet ran for the non-empty ticks', encodeSpans, (rows) => rows.length >= 2)
}

/**
 * Append a batch of rows to the live spool then flush, so the rows pass the
 * `decorateRow` chokepoint and get a monotonic `_hyp_ingest_seq` stamped.
 *
 * @param {any} storage
 * @param {string} spoolPath
 * @param {number[]} ids
 */
async function flushRows(storage, spoolPath, ids) {
  await storage.appendRows(spoolPath, COLUMNS, ids.map((id) => ({ id: BigInt(id), client_name: SOURCE, msg: `m${id}` })))
  await storage.flushTable(spoolPath, { reason: 'manual', force: true })
}

/**
 * Read every parquet blob under the destination dir, decoding each to the set
 * of `id`s it carries. Sorted by filename so the newest ranged blob is last.
 *
 * @param {string} destDir
 * @returns {Promise<Array<{ name: string, ids: number[] }>>}
 */
async function readBlobs(destDir) {
  /** @type {Array<{ name: string, ids: number[] }>} */
  const out = []
  /** @param {string} dir */
  async function walk(dir) {
    /** @type {Dirent[]} */
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.name.endsWith('.parquet')) {
        const buf = await fs.readFile(full)
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        const decoded = await parquetReadObjects({ file: ab })
        out.push({ name: e.name, ids: decoded.map((r) => Number(r.id)) })
      }
    }
  }
  await walk(destDir)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function sameSet(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false
  const sa = [...a].sort((x, y) => x - y)
  const sb = [...b].sort((x, y) => x - y)
  return sa.every((v, i) => v === sb[i])
}

/** @param {string} dir */
async function writeFixturePlugin(dir) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: '@hypaware/test-proxy',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }
  await fs.writeFile(path.join(dir, 'hypaware.plugin.json'), JSON.stringify(manifest, null, 2))
  await fs.writeFile(path.join(dir, 'index.js'), fixturePluginSource())
}

function fixturePluginSource() {
  return `// auto-generated by incremental_sink_compaction smoke; fixture: @hypaware/test-proxy
import path from 'node:path'

const DATASET = '${DATASET}'
const SOURCE = '${SOURCE}'
const COLUMNS = ${JSON.stringify(COLUMNS)}

let activatedStorage = null

const dataset = {
  name: DATASET,
  plugin: '@hypaware/test-proxy',
  sourceSignal: 'proxy',
  schema: { columns: COLUMNS },
  primaryTimestampColumn: undefined,
  discoverPartitions(ctx) {
    const cacheDir = ctx.cacheDir ?? activatedStorage?.cacheRoot ?? ''
    if (!cacheDir) return []
    return [
      {
        dataset: DATASET,
        partition: { source: SOURCE },
        tablePath: path.join(cacheDir, 'datasets', DATASET, 'source=' + SOURCE),
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
    scan() { return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} } },
  }
}

export async function activate(ctx) {
  activatedStorage = ctx.storage
  ctx.query.registerDataset(dataset)
}
`
}

function makeNoopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} }
}
