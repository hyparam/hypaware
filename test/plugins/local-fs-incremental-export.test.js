// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { activate } from '../../hypaware-core/plugins-workspace/local-fs/src/index.js'

const CACHE_ROOT = '/cache'
const DATASET = 'd'
const TABLE = `${CACHE_ROOT}/datasets/${DATASET}/source=x`

/** @returns {Promise<string>} */
async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-localfs-incr-'))
}

/**
 * Storage stub whose row set for the one table is mutable across ticks, so a
 * test can append rows and re-export. `readRowsSince` honours `seq > since`.
 *
 * @param {Array<{ _seq: number } & Record<string, unknown>>} rows
 */
function makeStorage(rows) {
  return {
    cacheRoot: CACHE_ROOT,
    /** @param {string} tp */
    tableExists: (tp) => tp === TABLE,
    /** @param {string} tablePath @param {{ since?: { seq: string } }} [opts] */
    readRowsSince(tablePath, opts) {
      const list = tablePath === TABLE ? rows : []
      const sinceSeq = opts?.since ? BigInt(opts.since.seq) : 0n
      return {
        async *[Symbol.asyncIterator]() {
          let high = sinceSeq
          for (const r of list) {
            const seq = BigInt(r._seq)
            if (seq <= sinceSeq) continue
            if (seq > high) high = seq
            const { _seq, ...row } = r
            yield { row, after: { v: 1, seq: high.toString() } }
          }
        },
      }
    },
    readRows() {
      return { async *[Symbol.asyncIterator]() {} }
    },
  }
}

/** A jsonl-ish fake encoder that drains rows (as a real encoder must). */
function makeEncoder() {
  return {
    format: 'jsonl',
    extension: 'jsonl',
    supports: ['queryable'],
    /** @param {any} partition @param {any} ctx */
    async encodePartition(partition, ctx) {
      const lines = []
      for await (const row of ctx.rows ?? []) lines.push(JSON.stringify(row))
      const bytes = new TextEncoder().encode(lines.join('\n') + (lines.length ? '\n' : ''))
      return { filename: 'all.jsonl', bytes, bytesWritten: bytes.byteLength, rowCount: lines.length }
    },
  }
}

/**
 * @param {{ rows: Array<{ _seq: number } & Record<string, unknown>>, exportsDir: string, stateDir: string }} args
 */
async function buildSink({ rows, exportsDir, stateDir }) {
  /** @type {any} */
  let registered
  /** @type {any} */
  const ctx = {
    config: { exports_dir: exportsDir },
    env: {},
    provideCapability() {},
    sinks: { register(/** @type {any} */ d) { registered = d } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    query: { getDataset: () => undefined, listDatasets: () => [] },
    storage: makeStorage(rows),
  }
  await activate(ctx)
  const dir = path.join(exportsDir, 'out')
  return registered.create({
    name: 'local',
    config: { dir },
    encoder: makeEncoder(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    paths: { tempDir: exportsDir, stateDir },
  })
}

/**
 * Storage stub yielding a described entry sequence: a payload `{ seq, id }` or a
 * drop `{ seq, drop: true }` — a `local-only` row the export seam withheld
 * (LLP 0070), carrying only the advancing `after`, no row.
 *
 * @param {Array<{ seq: number, id?: string, drop?: boolean }>} entries
 */
function makeDropStorage(entries) {
  return {
    cacheRoot: CACHE_ROOT,
    /** @param {string} tp */
    tableExists: (tp) => tp === TABLE,
    /** @param {string} tablePath @param {{ since?: { seq: string } }} [opts] */
    readRowsSince(tablePath, opts) {
      const list = tablePath === TABLE ? entries : []
      const sinceSeq = opts?.since ? BigInt(opts.since.seq) : 0n
      return {
        async *[Symbol.asyncIterator]() {
          let high = sinceSeq
          for (const e of list) {
            const seq = BigInt(e.seq)
            if (seq <= sinceSeq) continue
            if (seq > high) high = seq
            const after = { v: 1, seq: high.toString() }
            if (e.drop) yield { after, dropped: true }
            else yield { row: { id: e.id }, after }
          }
        },
      }
    },
    readRows() {
      return { async *[Symbol.asyncIterator]() {} }
    },
  }
}

/** @param {{ storage: any, exportsDir: string, stateDir: string }} args */
async function buildSinkWith({ storage, exportsDir, stateDir }) {
  /** @type {any} */
  let registered
  /** @type {any} */
  const ctx = {
    config: { exports_dir: exportsDir },
    env: {},
    provideCapability() {},
    sinks: { register(/** @type {any} */ d) { registered = d } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    query: { getDataset: () => undefined, listDatasets: () => [] },
    storage,
  }
  await activate(ctx)
  const dir = path.join(exportsDir, 'out')
  return registered.create({
    name: 'local',
    config: { dir },
    encoder: makeEncoder(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    paths: { tempDir: exportsDir, stateDir },
  })
}

function partition() {
  return { dataset: DATASET, partition: {}, tablePath: TABLE }
}

/** @param {string} dir */
async function listBlobs(dir) {
  const partDir = path.join(dir, DATASET, 'all')
  try {
    return (await fs.readdir(partDir)).sort()
  } catch {
    return []
  }
}

test('local-fs incremental export: ranged filename, watermark advance, skip-empty, then a new range', async (t) => {
  const exportsDir = await tmpDir()
  const stateDir = await tmpDir()
  t.after(() => fs.rm(exportsDir, { recursive: true, force: true }))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))

  const rows = [{ _seq: 1, id: 'a' }, { _seq: 2, id: 'b' }]
  const sink = await buildSink({ rows, exportsDir, stateDir })
  const dir = path.join(exportsDir, 'out')

  // Tick 1: two new rows ⇒ one blob named with [0,2].
  const r1 = await sink.exportBatch({ batchId: 'b1', partitions: [partition()] }, {})
  assert.equal(r1.status, 'exported')
  assert.equal(r1.partitionsExported, 1)
  let blobs = await listBlobs(dir)
  assert.deepEqual(blobs, ['all.0-2.jsonl'], 'first blob embeds [sinceSeq=0, lastSeq=2]')

  const wmFile = path.join(stateDir, 'sink-instances', 'local', 'watermarks', DATASET, 'source=x.json')
  const wm = JSON.parse(await fs.readFile(wmFile, 'utf8'))
  assert.equal(wm.continuation.seq, '2')
  assert.equal(wm.exportedRowCount, 2)

  // Tick 2: no new rows ⇒ no new blob (skip-empty), watermark unchanged.
  const r2 = await sink.exportBatch({ batchId: 'b2', partitions: [partition()] }, {})
  assert.equal(r2.partitionsExported, 0, 'no new rows ⇒ nothing exported')
  blobs = await listBlobs(dir)
  assert.deepEqual(blobs, ['all.0-2.jsonl'], 'no second blob written')

  // Tick 3: append a row ⇒ a new blob covering only (2, 5].
  rows.push({ _seq: 5, id: 'c' })
  const r3 = await sink.exportBatch({ batchId: 'b3', partitions: [partition()] }, {})
  assert.equal(r3.partitionsExported, 1)
  blobs = await listBlobs(dir)
  assert.deepEqual(blobs, ['all.0-2.jsonl', 'all.2-5.jsonl'], 'second blob embeds [sinceSeq=2, lastSeq=5]')
  const wm3 = JSON.parse(await fs.readFile(wmFile, 'utf8'))
  assert.equal(wm3.continuation.seq, '5')
  assert.equal(wm3.exportedRowCount, 3, 'exportedRowCount accumulates across ticks')

  // The third blob contains exactly the one new row.
  const newBlob = await fs.readFile(path.join(dir, DATASET, 'all', 'all.2-5.jsonl'), 'utf8')
  assert.equal(newBlob.trim(), JSON.stringify({ id: 'c' }))

  await sink.close()
})

test('local-fs drop-only tick: no blob is written, but the watermark advances past the withheld rows (LLP 0070)', async (t) => {
  const exportsDir = await tmpDir()
  const stateDir = await tmpDir()
  t.after(() => fs.rm(exportsDir, { recursive: true, force: true }))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))

  // A partition of only `local-only` rows: nothing to encode, but the tail must
  // still checkpoint or it re-scans (and would re-send on un-exclusion) forever.
  const storage = makeDropStorage([{ seq: 1, drop: true }, { seq: 2, drop: true }])
  const sink = await buildSinkWith({ storage, exportsDir, stateDir })
  const dir = path.join(exportsDir, 'out')

  const r = await sink.exportBatch({ batchId: 'b1', partitions: [partition()] }, {})
  assert.equal(r.partitionsExported, 0, 'an all-dropped partition writes no blob')
  assert.deepEqual(await listBlobs(dir), [], 'no blob on disk')

  const wmFile = path.join(stateDir, 'sink-instances', 'local', 'watermarks', DATASET, 'source=x.json')
  const wm = JSON.parse(await fs.readFile(wmFile, 'utf8'))
  assert.equal(wm.continuation.seq, '2', 'the watermark advanced past the withheld tail')
  assert.equal(wm.exportedRowCount, 0, 'a withheld row is never counted as exported')

  await sink.close()
})
