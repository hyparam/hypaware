// @ts-check

// Exactly-once acceptance proof for incremental sink reads (LLP 0040, T6).
//
// The T4/T5 unit suites (`sink-incremental`, `central-forward-chunking`) wire
// each sink against a STUBBED storage that hands back fixed rows and a hand-rolled
// `readRowsSince`. They prove the wiring; they cannot prove the design's load-bearing
// claim — that a row-resident `_hyp_ingest_seq` watermark survives the two cache
// rewrites that motivate the whole design (LLP 0039 "why this is a design"):
//
//   - a retention FRONT-PRUNE (position-delete of the oldest rows), and
//   - a compaction GENERATION SWAP (rewrite into a fresh `table-<seq>` dir).
//
// This suite drives the REAL kernel cache (`createQueryStorageService`), the REAL
// retention enforcer, the REAL `maintainCache` compaction, BOTH real sinks (the
// central `forward` request sink and the core `local-fs` blob sink), and the REAL
// sink driver's outbox respool — end to end — and asserts exactly-once across both
// rewrites, ≈0 bytes on a no-new-rows tick, ≈N on an N-new tick, and that the
// per-(sink, partition) watermark composes with the driver's outbox replay.
//
// @ref LLP 0040#exactly-once-argument [tests] — proves no skip / no dup across retention + compaction for both sinks
// @ref LLP 0039 [tests] — acceptance: ≈0 bytes on no-new-rows, ≈N on N-new, exactly-once across prune + compaction

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { appendRowsToTable } from '../../src/core/cache/iceberg/store.js'
import { INGEST_SEQ_COLUMN } from '../../src/core/cache/streaming-reader.js'
import { createRetentionEnforcer } from '../../src/core/cache/retention.js'
import { maintainCache } from '../../src/core/cache/maintenance.js'
import { readCursorSync, discoverCachePartitions } from '../../src/core/cache/partition.js'
import { createInstanceWatermarkStore } from '../../src/core/sinks/incremental.js'
import { createSinkRegistry } from '../../src/core/registry/sinks.js'
import { createQueryRegistry } from '../../src/core/registry/datasets.js'
import { createSinkDriver } from '../../src/core/sinks/driver.js'
import { createForwardSink } from '../../hypaware-core/plugins-workspace/central/src/sink.js'
import { activate as activateLocalFs } from '../../hypaware-core/plugins-workspace/local-fs/src/index.js'

/**
 * @import { ColumnSpec, QueryPartition, SinkEncoder } from '../../hypaware-plugin-kernel-types.d.ts'
 * @import { Dirent } from 'node:fs'
 */

const DATASET = 'proxy'
const SOURCE = 'claude'
const SIGNAL = 'proxy' // a KNOWN_SIGNALS member for the forward sink

/** @type {ColumnSpec[]} */
const COLS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: false },
  { name: 'timestamp', type: 'STRING', nullable: true },
  { name: 'msg', type: 'STRING', nullable: false },
]

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-incr-accept-'))
}

/** @param {number} daysAgo @returns {string} */
function isoDaysAgo(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * @param {number[]} ids
 * @param {string} timestamp
 * @returns {Record<string, unknown>[]}
 */
function rows(ids, timestamp) {
  return ids.map((id) => ({ id, client_name: SOURCE, timestamp, msg: `m${id}` }))
}

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} }
}

/**
 * Append a batch to the live spool then flush it: this routes through the
 * `decorateRow` chokepoint that stamps `_hyp_ingest_seq` (T1), so the committed
 * rows carry real monotonic seqs — the precondition for incremental reads.
 *
 * @param {ReturnType<typeof createQueryStorageService>} svc
 * @param {string} spoolPath
 * @param {Record<string, unknown>[]} batch
 */
async function flushBatch(svc, spoolPath, batch) {
  await svc.appendRows(spoolPath, COLS, batch)
  await svc.flushTable(spoolPath, { reason: 'manual' })
}

/**
 * Resolve the single committed logical partition the spool flush produced.
 * `.path` is the stable `<cacheRoot>/datasets/<ds>/source=<src>` dir — the
 * watermark key the design keys on, NOT the physical `tableDir`.
 *
 * @param {string} cacheRoot
 * @returns {Promise<QueryPartition>}
 */
async function logicalPartition(cacheRoot) {
  const parts = await discoverCachePartitions(cacheRoot)
  const part = parts.find((p) => p.dataset === DATASET)
  assert.ok(part, 'expected a committed proxy partition after flush')
  return { dataset: DATASET, partition: { source: SOURCE }, tablePath: part.path }
}

/**
 * Build a committed partition table DIRECTLY at the stable logical partition
 * path (no spool, no cursor) so the seq values — including pre-upgrade nulls —
 * are controlled exactly. This reproduces a migration-era cache: some rows
 * pre-date the `_hyp_ingest_seq` column (null), some carry real seqs. `seq:null`
 * stamps a legacy row; a bigint stamps a real one.
 *
 * @param {string} cacheRoot
 * @param {{ id: number, seq: bigint | null }[]} spec
 * @returns {Promise<QueryPartition>}
 */
async function buildLegacyPartition(cacheRoot, spec) {
  const dir = path.join(cacheRoot, 'datasets', DATASET, `source=${SOURCE}`)
  /** @type {ColumnSpec[]} */
  const cols = [{ name: 'id', type: 'INT64', nullable: false }, INGEST_SEQ_COLUMN]
  await appendRowsToTable(
    dir,
    cols,
    spec.map((s) => ({ id: s.id, [INGEST_SEQ_COLUMN.name]: s.seq })),
  )
  return { dataset: DATASET, partition: { source: SOURCE }, tablePath: dir }
}

// --------------------------------------------------------------------------
// Forward sink test rig: REAL createForwardSink + REAL watermark store + REAL
// cache, with a recording fetch stub standing in for the central server.
// --------------------------------------------------------------------------

/**
 * @param {{ storage: any, watermarks: any, responder?: (c: any) => number, query?: any }} args
 */
function makeForwardSink({ storage, watermarks, responder, query }) {
  /** @type {Array<{ url: string, batchId: string, ids: number[], status: number }>} */
  const calls = []
  /** @type {typeof fetch} */
  const fetchFn = /** @type {any} */ (async (url, init) => {
    const headers = /** @type {Record<string, string>} */ (init?.headers ?? {})
    const body = String(init?.body ?? '')
    const ids = body.split('\n').filter((l) => l.length > 0).map((l) => Number(JSON.parse(l).id))
    const status = responder ? responder({ url: String(url) }) : 202
    calls.push({ url: String(url), batchId: headers['x-hyp-batch-id'], ids, status })
    return /** @type {any} */ ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      async text() { return '' },
      body: { cancel: async () => {} },
    })
  })
  const identityClient = /** @type {any} */ ({ async getCurrentJwt() { return 'jwt' }, async refresh() {} })
  const sink = createForwardSink({
    config: /** @type {any} */ ({ url: 'http://central.test', identity: {} }),
    identityClient,
    query: query ?? /** @type {any} */ ({ getDataset: () => ({ sourceSignal: SIGNAL }) }),
    storage,
    watermarks,
    log: /** @type {any} */ (noopLog()),
    fetchFn,
    sleepFn: async () => {},
  })
  return { sink, calls }
}

/** Ids that were durably ACKed (2xx) across a set of recorded POSTs. */
function ackedIds(/** @type {Array<{ ids: number[], status: number }>} */ calls) {
  return calls.filter((c) => c.status >= 200 && c.status < 300).flatMap((c) => c.ids)
}

// --------------------------------------------------------------------------
// Blob sink test rig: the REAL @hypaware/local-fs sink (its buildSink wiring,
// T5) built via the plugin's own activate()/create(), with a trivial JSON
// encoder so the written blob is decodable to the exact ids it carried.
// --------------------------------------------------------------------------

/** @returns {SinkEncoder} */
function makeJsonEncoder() {
  return {
    format: 'json', extension: 'json', supports: [],
    async encodePartition(partition, ctx) {
      /** @type {number[]} */
      const ids = []
      for await (const row of ctx.rows ?? []) ids.push(Number(row.id))
      const bytes = new TextEncoder().encode(JSON.stringify({ ids }))
      return { filename: `${partition.dataset}.json`, bytes, bytesWritten: bytes.byteLength, rowCount: ids.length }
    },
  }
}

/**
 * @param {{ storage: any, destDir: string, stateDir: string, instanceName: string }} args
 */
async function makeBlobSink({ storage, destDir, stateDir, instanceName }) {
  const sinkRegistry = createSinkRegistry()
  const query = /** @type {any} */ ({ getDataset: () => ({ schema: { columns: COLS } }) })
  const ctx = /** @type {any} */ ({
    config: { exports_dir: path.join(stateDir, 'exports') },
    env: {},
    provideCapability() {},
    sinks: sinkRegistry,
    query,
    storage,
  })
  await activateLocalFs(ctx)
  const contribution = sinkRegistry.getContribution('@hypaware/local-fs', 'local-fs')
  assert.ok(contribution, 'local-fs registered a sink contribution')
  const sink = await contribution.create(/** @type {any} */ ({
    name: instanceName,
    plugin: '@hypaware/local-fs',
    config: { dir: destDir },
    paths: { rootDir: stateDir, stateDir, cacheDir: stateDir, tempDir: path.join(stateDir, 'tmp') },
    log: noopLog(),
    encoder: makeJsonEncoder(),
  }))
  return sink
}

/**
 * Recursively collect the blob files written under a destination dir, newest
 * first by name, returning `{ name, ids }` with the decoded ids per blob.
 *
 * @param {string} destDir
 * @returns {Promise<Array<{ name: string, ids: number[] }>>}
 */
async function listBlobs(destDir) {
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
      else if (e.name.endsWith('.json')) {
        const parsed = JSON.parse(await fs.readFile(full, 'utf8'))
        out.push({ name: e.name, ids: parsed.ids.map(Number) })
      }
    }
  }
  await walk(destDir)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ==========================================================================
// Baseline: ≈0 bytes on a no-new-rows tick, ≈N on an N-new tick.
// ==========================================================================

test('forward sink: ≈0 bytes on a no-new-rows tick, ≈N on an N-new tick', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const spoolPath = svc.cacheTablePath(DATASET, ['all'])
    await flushBatch(svc, spoolPath, rows([0, 1, 2], isoDaysAgo(1)))
    const part = await logicalPartition(cacheRoot)
    const watermarks = createInstanceWatermarkStore({
      paths: /** @type {any} */ ({ stateDir: path.join(cacheRoot, 'state') }),
      instanceName: 'forward',
    })
    const { sink, calls } = makeForwardSink({ storage: svc, watermarks })

    // First tick: 3 new rows ship.
    const r1 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r1.status, 'exported')
    assert.deepEqual(ackedIds(calls).sort((a, b) => a - b), [0, 1, 2])
    assert.ok((r1.bytesWritten ?? 0) > 0)

    // Second tick: nothing new -> 0 chunks, 0 bytes (today the whole partition re-sends).
    calls.length = 0
    const r2 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r2.status, 'exported')
    assert.equal(r2.bytesWritten, 0, 'no-new-rows tick transmits ≈0 bytes')
    assert.equal(calls.length, 0, 'no-new-rows tick makes zero POSTs')

    // Add 2 rows -> exactly those 2 are read/sent, independent of the 3 already shipped.
    calls.length = 0
    await flushBatch(svc, spoolPath, rows([3, 4], isoDaysAgo(1)))
    const r3 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r3.status, 'exported')
    assert.deepEqual(ackedIds(calls).sort((a, b) => a - b), [3, 4], 'reads/sends only the N new rows')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('blob sink: no blob on a no-new-rows tick, exactly N on an N-new tick', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const spoolPath = svc.cacheTablePath(DATASET, ['all'])
    await flushBatch(svc, spoolPath, rows([0, 1, 2], isoDaysAgo(1)))
    const part = await logicalPartition(cacheRoot)
    const destDir = path.join(cacheRoot, 'blob-out')
    const sink = await makeBlobSink({ storage: svc, destDir, stateDir: path.join(cacheRoot, 'state'), instanceName: 'archive' })

    const r1 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r1.status, 'exported')
    assert.ok((r1.bytesWritten ?? 0) > 0)
    let blobs = await listBlobs(destDir)
    assert.equal(blobs.length, 1)
    assert.deepEqual(blobs[0].ids.sort((a, b) => a - b), [0, 1, 2])
    // The filename embeds the [sinceSeq, lastSeq] range for idempotent re-PUT.
    assert.match(blobs[0].name, /^proxy\.\d+-\d+\.json$/)

    // No new rows -> no blob written, 0 bytes (skip-empty).
    const r2 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r2.status, 'exported')
    assert.equal(r2.bytesWritten, 0)
    assert.equal(r2.partitionsExported, 0)
    assert.equal((await listBlobs(destDir)).length, 1, 'no second blob for a no-new-rows tick')

    // N new rows -> exactly one more blob carrying only the new ids.
    await flushBatch(svc, spoolPath, rows([3, 4], isoDaysAgo(1)))
    const r3 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r3.status, 'exported')
    blobs = await listBlobs(destDir)
    assert.equal(blobs.length, 2)
    const newest = blobs[blobs.length - 1]
    assert.deepEqual(newest.ids.sort((a, b) => a - b), [3, 4], 'second blob holds only the N new rows')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// ==========================================================================
// Exactly-once across a RETENTION FRONT-PRUNE (LLP 0040 §5 acceptance 3a).
// ==========================================================================

test('forward sink: exactly-once across a retention front-prune', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const spoolPath = svc.cacheTablePath(DATASET, ['all'])
    const watermarks = createInstanceWatermarkStore({
      paths: /** @type {any} */ ({ stateDir: path.join(cacheRoot, 'state') }),
      instanceName: 'forward',
    })
    const { sink, calls } = makeForwardSink({ storage: svc, watermarks })

    // Old rows shipped, watermark advances past them.
    await flushBatch(svc, spoolPath, rows([0, 1, 2], isoDaysAgo(45)))
    await sink.exportBatch(/** @type {any} */ ({ partitions: [await logicalPartition(cacheRoot)] }), /** @type {any} */ ({}))
    const acked1 = ackedIds(calls)

    // Newer rows arrive, then retention deletes the old front (all already < watermark).
    await flushBatch(svc, spoolPath, rows([3, 4], isoDaysAgo(1)))
    const enforcer = createRetentionEnforcer({ cacheRoot, config: { default_days: 30 } })
    const ret = await enforcer.tick()
    const pruned = ret.sourceTableResults.reduce((n, r) => n + r.rowsDeleted, 0)
    assert.equal(pruned, 3, 'retention front-pruned the 3 old rows')

    // A `> watermark` read is blind to the pruned rows: yields only the new suffix.
    calls.length = 0
    await sink.exportBatch(/** @type {any} */ ({ partitions: [await logicalPartition(cacheRoot)] }), /** @type {any} */ ({}))
    const acked2 = ackedIds(calls)
    assert.deepEqual(acked2.sort((a, b) => a - b), [3, 4], 'no re-send of pruned rows, no skip of survivors')

    // No row skipped or duplicated across the whole run.
    const all = [...acked1, ...acked2].sort((a, b) => a - b)
    assert.deepEqual(all, [0, 1, 2, 3, 4])
    assert.equal(new Set(all).size, all.length, 'exactly-once: no duplicates')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('blob sink: exactly-once across a retention front-prune', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const spoolPath = svc.cacheTablePath(DATASET, ['all'])
    const destDir = path.join(cacheRoot, 'blob-out')
    const sink = await makeBlobSink({ storage: svc, destDir, stateDir: path.join(cacheRoot, 'state'), instanceName: 'archive' })

    await flushBatch(svc, spoolPath, rows([0, 1, 2], isoDaysAgo(45)))
    await sink.exportBatch(/** @type {any} */ ({ partitions: [await logicalPartition(cacheRoot)] }), /** @type {any} */ ({}))

    await flushBatch(svc, spoolPath, rows([3, 4], isoDaysAgo(1)))
    const enforcer = createRetentionEnforcer({ cacheRoot, config: { default_days: 30 } })
    await enforcer.tick()

    await sink.exportBatch(/** @type {any} */ ({ partitions: [await logicalPartition(cacheRoot)] }), /** @type {any} */ ({}))

    const blobs = await listBlobs(destDir)
    const exported = blobs.flatMap((b) => b.ids).sort((a, b) => a - b)
    assert.deepEqual(exported, [0, 1, 2, 3, 4], 'every row exported exactly once across the prune')
    assert.equal(new Set(exported).size, exported.length, 'exactly-once: no duplicates')
    // The post-prune blob carried only the survivors, not the pruned front.
    assert.deepEqual(blobs[blobs.length - 1].ids.sort((a, b) => a - b), [3, 4])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// ==========================================================================
// Exactly-once across a COMPACTION GENERATION SWAP (LLP 0040 §5 acceptance 3b).
// The seq is row-resident, so it rides verbatim into the new `table-<seq>` dir;
// the watermark is keyed by the stable LOGICAL path, so it reads straight through.
// ==========================================================================

test('forward sink: exactly-once across a compaction generation swap', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const spoolPath = svc.cacheTablePath(DATASET, ['all'])
    const watermarks = createInstanceWatermarkStore({
      paths: /** @type {any} */ ({ stateDir: path.join(cacheRoot, 'state') }),
      instanceName: 'forward',
    })
    const { sink, calls } = makeForwardSink({ storage: svc, watermarks })

    await flushBatch(svc, spoolPath, rows([0, 1, 2], isoDaysAgo(1)))
    await sink.exportBatch(/** @type {any} */ ({ partitions: [await logicalPartition(cacheRoot)] }), /** @type {any} */ ({}))
    const acked1 = ackedIds(calls)

    await flushBatch(svc, spoolPath, rows([3, 4], isoDaysAgo(1)))

    // Compaction rewrites the whole partition into a fresh generation directory.
    const sourceDir = path.join(cacheRoot, 'datasets', DATASET, `source=${SOURCE}`)
    const tableDirBefore = readCursorSync(sourceDir).tableDir ?? 'table'
    const report = await maintainCache({ cacheRoot, force: true, compactOnly: true })
    assert.ok(report.totalCompacted > 0, 'compaction ran')
    const tableDirAfter = readCursorSync(sourceDir).tableDir ?? 'table'
    assert.notEqual(tableDirAfter, tableDirBefore, 'generation directory swapped')

    // The watermark (logical-keyed) reads straight through the swap: only the new suffix.
    calls.length = 0
    await sink.exportBatch(/** @type {any} */ ({ partitions: [await logicalPartition(cacheRoot)] }), /** @type {any} */ ({}))
    const acked2 = ackedIds(calls)
    assert.deepEqual(acked2.sort((a, b) => a - b), [3, 4], 'seq survived compaction: only the new suffix re-read')

    const all = [...acked1, ...acked2].sort((a, b) => a - b)
    assert.deepEqual(all, [0, 1, 2, 3, 4])
    assert.equal(new Set(all).size, all.length, 'exactly-once: no duplicates')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('blob sink: exactly-once across a compaction generation swap', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const spoolPath = svc.cacheTablePath(DATASET, ['all'])
    const destDir = path.join(cacheRoot, 'blob-out')
    const sink = await makeBlobSink({ storage: svc, destDir, stateDir: path.join(cacheRoot, 'state'), instanceName: 'archive' })

    await flushBatch(svc, spoolPath, rows([0, 1, 2], isoDaysAgo(1)))
    await sink.exportBatch(/** @type {any} */ ({ partitions: [await logicalPartition(cacheRoot)] }), /** @type {any} */ ({}))

    await flushBatch(svc, spoolPath, rows([3, 4], isoDaysAgo(1)))

    const sourceDir = path.join(cacheRoot, 'datasets', DATASET, `source=${SOURCE}`)
    const before = readCursorSync(sourceDir).tableDir ?? 'table'
    await maintainCache({ cacheRoot, force: true, compactOnly: true })
    const after = readCursorSync(sourceDir).tableDir ?? 'table'
    assert.notEqual(after, before, 'generation directory swapped')

    await sink.exportBatch(/** @type {any} */ ({ partitions: [await logicalPartition(cacheRoot)] }), /** @type {any} */ ({}))

    const blobs = await listBlobs(destDir)
    const exported = blobs.flatMap((b) => b.ids).sort((a, b) => a - b)
    assert.deepEqual(exported, [0, 1, 2, 3, 4], 'every row exported exactly once across the compaction')
    assert.equal(new Set(exported).size, exported.length, 'exactly-once: no duplicates')
    assert.deepEqual(blobs[blobs.length - 1].ids.sort((a, b) => a - b), [3, 4], 'post-compaction blob holds only the new suffix')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// ==========================================================================
// Watermark vs. driver-outbox respool composition (LLP 0040 risk #6).
// A failed tick lands the partition in the driver outbox; the next tick's
// respool re-hands the SAME partition, and the watermark ensures the replay
// reads only the un-acked suffix (not the whole partition), with a stable
// X-Hyp-Batch-Id so any in-flight redelivery is server-dedup safe.
// ==========================================================================

test('forward sink: watermark composes with the driver-outbox respool (suffix-only replay)', async () => {
  const cacheRoot = await makeTmpDir()
  const stateRoot = path.join(cacheRoot, 'state-root')
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const spoolPath = svc.cacheTablePath(DATASET, ['all'])
    await flushBatch(svc, spoolPath, rows([0, 1, 2], isoDaysAgo(1)))

    const watermarks = createInstanceWatermarkStore({
      paths: /** @type {any} */ ({ stateDir: path.join(cacheRoot, 'state') }),
      instanceName: 'forward',
    })

    // The query registry the driver discovers partitions from (and the sink
    // resolves its signal from): one dataset whose discoverPartitions returns
    // the committed logical partition.
    const query = createQueryRegistry()
    const partition = await logicalPartition(cacheRoot)
    query.registerDataset(/** @type {any} */ ({
      name: DATASET,
      plugin: '@hypaware/central',
      sourceSignal: SIGNAL,
      schema: { columns: COLS },
      discoverPartitions: () => [partition],
    }))

    let serverMode = /** @type {'ok' | 'fail'} */ ('ok')
    const { sink, calls } = makeForwardSink({
      storage: svc,
      watermarks,
      query,
      responder: () => (serverMode === 'fail' ? 500 : 202),
    })

    const sinkRegistry = createSinkRegistry()
    sinkRegistry.register({ name: 'forward', plugin: '@hypaware/central', supports: [], create: async () => sink })
    const contribution = sinkRegistry.getContribution('@hypaware/central', 'forward')
    assert.ok(contribution)
    await sinkRegistry.instantiate(/** @type {any} */ ({
      kind: 'request',
      instanceName: 'forward',
      contribution,
      config: { schedule: '* * * * *' },
      plugin: { name: '@hypaware/central', version: '1.0.0', manifest: {}, rootDir: '/fake' },
      paths: { rootDir: stateRoot, stateDir: stateRoot, cacheDir: stateRoot, tempDir: stateRoot },
      log: noopLog(),
    }))

    const driver = createSinkDriver({ sinkRegistry, queryRegistry: query, storage: svc, stateRoot })
    const now = new Date('2026-06-25T10:00:00Z')

    // Tick A: server OK -> the 3 rows are delivered, watermark advances.
    let mark = calls.length
    const a = await driver.tick({ now, force: true })
    assert.equal(a.sinks[0].status, 'exported')
    const ackedA = ackedIds(calls.slice(mark))
    assert.deepEqual(ackedA.sort((x, y) => x - y), [0, 1, 2])

    // New rows arrive; the next tick fails at the server.
    await flushBatch(svc, spoolPath, rows([3, 4], isoDaysAgo(1)))

    // Tick B: server FAILS. The sink read ONLY the un-acked suffix {3,4} (the
    // watermark bounds the re-read even on the failing tick), the POST 500s,
    // and the driver spools the partition to the outbox; the watermark holds.
    serverMode = 'fail'
    mark = calls.length
    const b = await driver.tick({ now, force: true })
    assert.notEqual(b.sinks[0].status, 'exported')
    const tickBCalls = calls.slice(mark)
    assert.equal(tickBCalls.length, 1, 'exactly one (failed) chunk attempted')
    assert.deepEqual(tickBCalls[0].ids.sort((x, y) => x - y), [3, 4], 'respool read is bounded to the un-acked suffix, not the whole partition')
    const outboxDir = path.join(stateRoot, 'sinks', 'forward', 'outbox')
    const outboxFiles = await fs.readdir(outboxDir)
    assert.ok(outboxFiles.length >= 1, 'the failed batch landed in the driver outbox (respool record)')

    // Tick C: server OK again -> the outbox respool re-hands the partition and
    // the watermark replays only {3,4} with the SAME batch-id as the failed
    // attempt, so an in-flight redelivery is server-dedup safe.
    serverMode = 'ok'
    mark = calls.length
    const c = await driver.tick({ now, force: true })
    assert.equal(c.sinks[0].status, 'exported')
    const tickCCalls = calls.slice(mark)
    assert.deepEqual(ackedIds(tickCCalls).sort((x, y) => x - y), [3, 4])
    assert.equal(tickCCalls[0].batchId, tickBCalls[0].batchId, 'identical batch-id across the respool (idempotent backstop)')

    // Exactly-once over the successfully-acked deliveries.
    const allAcked = ackedIds(calls).sort((x, y) => x - y)
    assert.deepEqual(allAcked, [0, 1, 2, 3, 4])
    assert.equal(new Set(allAcked).size, allAcked.length, 'no row acked twice')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('blob sink: a lost watermark after a durable PUT re-PUTs the same object key (idempotent overwrite)', async () => {
  // The blob sink's stand-in for the server ledger: the [sinceSeq,lastSeq]
  // filename. A crash between PUT and watermark-advance re-reads the same
  // suffix next tick, which re-derives the SAME filename -> idempotent
  // overwrite, never a duplicate blob. (LLP 0040 §4 / risk #6.)
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const spoolPath = svc.cacheTablePath(DATASET, ['all'])
    await flushBatch(svc, spoolPath, rows([0, 1, 2], isoDaysAgo(1)))
    const part = await logicalPartition(cacheRoot)

    const stateDir = path.join(cacheRoot, 'state')
    const destDir = path.join(cacheRoot, 'blob-out')
    const sink = await makeBlobSink({ storage: svc, destDir, stateDir, instanceName: 'archive' })

    // First export writes the blob and advances the watermark.
    await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    const after1 = await listBlobs(destDir)
    assert.equal(after1.length, 1)
    const firstName = after1[0].name

    // Simulate the watermark write being lost after the durable PUT by deleting
    // the persisted watermark file: the next tick believes nothing was exported.
    const wmStore = createInstanceWatermarkStore({ paths: /** @type {any} */ ({ stateDir }), instanceName: 'archive' })
    const wmFile = wmStore.filePath(wmStore.keyFor(svc.cacheRoot, part.tablePath ?? ''))
    await fs.rm(wmFile, { force: true })

    // Re-export: same suffix -> same [sinceSeq,lastSeq] -> same filename ->
    // overwrites the one blob rather than creating a duplicate.
    await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    const after2 = await listBlobs(destDir)
    assert.equal(after2.length, 1, 'idempotent re-PUT: still exactly one blob, not a duplicate')
    assert.equal(after2[0].name, firstName, 'same object key re-PUT')
    assert.deepEqual(after2[0].ids.sort((a, b) => a - b), [0, 1, 2])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// ==========================================================================
// One-time legacy backlog re-export (LLP 0040 §6 risk #1).
// Pre-upgrade rows carry a null `_hyp_ingest_seq`. A fresh sink (no watermark)
// exports them ONCE; once it has a durable watermark it treats them as
// already-shipped, so the backlog never re-exports on every tick (which would
// also duplicate after a compaction reorders the body).
// ==========================================================================

test('forward sink: a pure-legacy partition re-exports the null-seq backlog exactly once', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const part = await buildLegacyPartition(cacheRoot, [
      { id: 0, seq: null }, { id: 1, seq: null }, { id: 2, seq: null },
    ])
    const watermarks = createInstanceWatermarkStore({
      paths: /** @type {any} */ ({ stateDir: path.join(cacheRoot, 'state') }),
      instanceName: 'forward',
    })
    const { sink, calls } = makeForwardSink({ storage: svc, watermarks })

    // Tick 1: the legacy backlog ships once.
    const r1 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r1.status, 'exported')
    assert.deepEqual(ackedIds(calls).sort((a, b) => a - b), [0, 1, 2])
    assert.ok((r1.bytesWritten ?? 0) > 0)

    // Tick 2: the backlog does NOT re-export — zero POSTs, zero bytes.
    calls.length = 0
    const r2 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r2.status, 'exported')
    assert.equal(r2.bytesWritten, 0, 'legacy backlog re-exports once, not every tick')
    assert.equal(calls.length, 0, 'second tick makes zero POSTs')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('forward sink: a mixed legacy+real partition ships everything once, then steady-state', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const part = await buildLegacyPartition(cacheRoot, [
      { id: 0, seq: null }, { id: 1, seq: null }, // legacy
      { id: 10, seq: 5n }, { id: 11, seq: 10n }, // real
    ])
    const watermarks = createInstanceWatermarkStore({
      paths: /** @type {any} */ ({ stateDir: path.join(cacheRoot, 'state') }),
      instanceName: 'forward',
    })
    const { sink, calls } = makeForwardSink({ storage: svc, watermarks })

    const r1 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r1.status, 'exported')
    assert.deepEqual(ackedIds(calls).sort((a, b) => a - b), [0, 1, 10, 11], 'first tick ships legacy + real')

    calls.length = 0
    const r2 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r2.status, 'exported')
    assert.equal(r2.bytesWritten, 0, 'no re-export of legacy or already-shipped real rows')
    assert.equal(calls.length, 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('blob sink: a pure-legacy partition writes one blob, then no blob', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const part = await buildLegacyPartition(cacheRoot, [
      { id: 0, seq: null }, { id: 1, seq: null }, { id: 2, seq: null },
    ])
    const destDir = path.join(cacheRoot, 'blob-out')
    const sink = await makeBlobSink({ storage: svc, destDir, stateDir: path.join(cacheRoot, 'state'), instanceName: 'archive' })

    const r1 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r1.status, 'exported')
    let blobs = await listBlobs(destDir)
    assert.equal(blobs.length, 1)
    assert.deepEqual(blobs[0].ids.sort((a, b) => a - b), [0, 1, 2])

    // Second tick: the backlog is already shipped → no new blob, 0 bytes.
    const r2 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r2.status, 'exported')
    assert.equal(r2.bytesWritten, 0)
    blobs = await listBlobs(destDir)
    assert.equal(blobs.length, 1, 'no second blob for the legacy backlog')
    // No id is duplicated across artifacts.
    const all = blobs.flatMap((b) => b.ids)
    assert.equal(new Set(all).size, all.length, 'no row in two blobs')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('blob sink: a mixed legacy+real partition writes one blob, then no blob', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const part = await buildLegacyPartition(cacheRoot, [
      { id: 0, seq: null }, { id: 1, seq: null },
      { id: 10, seq: 5n }, { id: 11, seq: 10n },
    ])
    const destDir = path.join(cacheRoot, 'blob-out')
    const sink = await makeBlobSink({ storage: svc, destDir, stateDir: path.join(cacheRoot, 'state'), instanceName: 'archive' })

    const r1 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r1.status, 'exported')
    let blobs = await listBlobs(destDir)
    assert.equal(blobs.length, 1)
    assert.deepEqual(blobs[0].ids.sort((a, b) => a - b), [0, 1, 10, 11])

    const r2 = await sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(r2.status, 'exported')
    assert.equal(r2.bytesWritten, 0)
    blobs = await listBlobs(destDir)
    assert.equal(blobs.length, 1, 'no second blob')
    const all = blobs.flatMap((b) => b.ids)
    assert.equal(new Set(all).size, all.length, 'no row in two blobs')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// ==========================================================================
// Per-(sink INSTANCE, partition) watermark scoping (LLP 0040 §3).
// Two `@hypaware/central` instances of one plugin share a `stateDir`; their
// watermarks must NOT collide, or one instance's advance would make the other
// skip rows it never exported. `createInstanceWatermarkStore` namespaces by the
// instance name (the fix for the central sink using the per-PLUGIN store).
// ==========================================================================

test('forward sink: two instances on one partition keep independent watermarks (no cross-instance skip)', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const spoolPath = svc.cacheTablePath(DATASET, ['all'])
    await flushBatch(svc, spoolPath, rows([0, 1, 2], isoDaysAgo(1)))
    const part = await logicalPartition(cacheRoot)

    // SAME plugin stateDir, two instance names — the per-plugin store would
    // collapse these onto one file and let A's advance clobber B's cursor.
    const stateDir = path.join(cacheRoot, 'state')
    const wmA = createInstanceWatermarkStore({ paths: /** @type {any} */ ({ stateDir }), instanceName: 'fleet-a' })
    const wmB = createInstanceWatermarkStore({ paths: /** @type {any} */ ({ stateDir }), instanceName: 'fleet-b' })
    assert.notEqual(
      wmA.filePath(wmA.keyFor(svc.cacheRoot, part.tablePath ?? '')),
      wmB.filePath(wmB.keyFor(svc.cacheRoot, part.tablePath ?? '')),
      'each instance gets its own watermark file',
    )

    // Instance A ships all three rows and advances ITS watermark.
    const a = makeForwardSink({ storage: svc, watermarks: wmA })
    const ra = await a.sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(ra.status, 'exported')
    assert.deepEqual(ackedIds(a.calls).sort((x, y) => x - y), [0, 1, 2])

    // Instance B, fresh: must STILL see all three rows — A's advance must not
    // have clobbered B's (independent) watermark.
    const b = makeForwardSink({ storage: svc, watermarks: wmB })
    const rb = await b.sink.exportBatch(/** @type {any} */ ({ partitions: [part] }), /** @type {any} */ ({}))
    assert.equal(rb.status, 'exported')
    assert.deepEqual(ackedIds(b.calls).sort((x, y) => x - y), [0, 1, 2], 'instance B is not skipped by instance A')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
