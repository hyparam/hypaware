// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  createInstanceWatermarkStore,
  openIncrementalRows,
  watermarkKeyFor,
  withSeqRangeFilename,
} from '../../src/core/sinks/incremental.js'

/** @returns {Promise<string>} */
async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sink-incr-'))
}

/**
 * Storage stub: `readRowsSince` yields the registered rows honouring `seq > since`
 * and emitting the monotonic high-water `after` token (null-seq rows carry it).
 *
 * @param {Record<string, Array<{ _seq: number | null } & Record<string, unknown>>>} rowsByTable
 */
function makeStorage(rowsByTable) {
  return {
    cacheRoot: '/cache',
    /** @param {string} tp */
    tableExists: (tp) => tp in rowsByTable,
    /** @param {string} tablePath @param {{ since?: { seq: string } }} [opts] */
    readRowsSince(tablePath, opts) {
      const rows = rowsByTable[tablePath] ?? []
      const sinceSeq = opts?.since ? BigInt(opts.since.seq) : 0n
      return {
        async *[Symbol.asyncIterator]() {
          let high = sinceSeq
          for (const r of rows) {
            const { _seq, ...row } = r
            if (_seq !== null) {
              const seq = BigInt(_seq)
              if (seq <= sinceSeq) continue
              if (seq > high) high = seq
            }
            yield { row, after: { v: 1, seq: high.toString() } }
          }
        },
      }
    },
  }
}

test('withSeqRangeFilename inserts the range before the final extension', () => {
  assert.equal(withSeqRangeFilename('all.parquet', '0', '50'), 'all.0-50.parquet')
  assert.equal(withSeqRangeFilename('source=claude.jsonl', '7', '12'), 'source=claude.7-12.jsonl')
})

test('withSeqRangeFilename is deterministic and preserves dots in the base name', () => {
  // A partition value with a dot must keep its extension at the very end.
  assert.equal(withSeqRangeFilename('date=2026.06.parquet', '1', '2'), 'date=2026.06.1-2.parquet')
  // No extension ⇒ append the range.
  assert.equal(withSeqRangeFilename('blob', '1', '9'), 'blob.1-9')
})

test('openIncrementalRows reports empty for a missing table (no blob written)', async () => {
  const storage = makeStorage({})
  const reader = await openIncrementalRows(/** @type {any} */ (storage), { dataset: 'd', partition: {}, tablePath: '/cache/datasets/d/source=x' }, undefined)
  assert.equal(reader.empty, true)
  assert.equal(reader.rowCount, 0)
  // Draining the empty stream yields nothing.
  const seen = []
  for await (const r of reader.rows) seen.push(r)
  assert.equal(seen.length, 0)
})

test('openIncrementalRows reports empty for a partition with no tablePath', async () => {
  const storage = makeStorage({})
  const reader = await openIncrementalRows(/** @type {any} */ (storage), { dataset: 'd', partition: {} }, undefined)
  assert.equal(reader.empty, true)
  assert.equal(reader.sinceSeq, '0')
})

test('openIncrementalRows tracks rowCount and the high-water lastAfter as the encoder drains', async () => {
  const tablePath = '/cache/datasets/d/source=x'
  const storage = makeStorage({ [tablePath]: [{ _seq: 5, id: 'a' }, { _seq: 9, id: 'b' }] })
  const reader = await openIncrementalRows(/** @type {any} */ (storage), { dataset: 'd', partition: {}, tablePath }, undefined)
  assert.equal(reader.empty, false)
  assert.equal(reader.sinceSeq, '0')
  // Before draining, the counters reflect only the peeked state.
  const rows = []
  for await (const r of reader.rows) rows.push(r)
  assert.deepEqual(rows, [{ id: 'a' }, { id: 'b' }], 'rows are clean (no _seq)')
  assert.equal(reader.rowCount, 2)
  assert.equal(reader.lastAfter.seq, '9', 'lastAfter is the max seq seen')
})

test('openIncrementalRows honours the since filter (only seq > since)', async () => {
  const tablePath = '/cache/datasets/d/source=x'
  const storage = makeStorage({ [tablePath]: [{ _seq: 5, id: 'a' }, { _seq: 9, id: 'b' }] })
  const reader = await openIncrementalRows(/** @type {any} */ (storage), { dataset: 'd', partition: {}, tablePath }, { v: 1, seq: '5' })
  assert.equal(reader.empty, false)
  assert.equal(reader.sinceSeq, '5')
  const rows = []
  for await (const r of reader.rows) rows.push(r)
  assert.deepEqual(rows, [{ id: 'b' }])
  assert.equal(reader.lastAfter.seq, '9')
})

test('openIncrementalRows reports empty when since already covers every row', async () => {
  const tablePath = '/cache/datasets/d/source=x'
  const storage = makeStorage({ [tablePath]: [{ _seq: 5, id: 'a' }] })
  const reader = await openIncrementalRows(/** @type {any} */ (storage), { dataset: 'd', partition: {}, tablePath }, { v: 1, seq: '5' })
  assert.equal(reader.empty, true, 'no rows newer than the watermark ⇒ empty')
})

test('openIncrementalRows: null-seq legacy rows are emitted but never advance lastAfter', async () => {
  // Null-seq (pre-upgrade) rows are always yielded but carry the watermark
  // forward unchanged — the one-time migration is a re-export, never a skip.
  const tablePath = '/cache/datasets/d/source=x'
  const storage = makeStorage({ [tablePath]: [{ _seq: null, id: 'legacy' }] })
  const reader = await openIncrementalRows(/** @type {any} */ (storage), { dataset: 'd', partition: {}, tablePath }, { v: 1, seq: '4' })
  assert.equal(reader.empty, false)
  const rows = []
  for await (const r of reader.rows) rows.push(r)
  assert.deepEqual(rows, [{ id: 'legacy' }])
  assert.equal(reader.lastAfter.seq, '4', 'a null-seq row keeps the prior watermark')
})

test('watermarkKeyFor returns null without a tablePath and the logical key otherwise', () => {
  const store = createSinkWatermarkStub()
  assert.equal(watermarkKeyFor(/** @type {any} */ (store), /** @type {any} */ ({ cacheRoot: '/cache' }), { dataset: 'd', partition: {} }), null)
  const key = watermarkKeyFor(/** @type {any} */ (store), /** @type {any} */ ({ cacheRoot: '/cache' }), { dataset: 'd', partition: {}, tablePath: '/cache/datasets/d/source=x' })
  assert.deepEqual(key, { dataset: 'd', partitionKey: 'source=x' })
})

test('createInstanceWatermarkStore isolates instances under one plugin stateDir', async (t) => {
  // PluginPaths.stateDir is per-plugin; two sink instances of the same
  // destination must not share (and clobber) one watermark file.
  const stateDir = await tmpDir()
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const paths = { rootDir: stateDir, stateDir, cacheDir: stateDir, tempDir: stateDir }
  const a = createInstanceWatermarkStore({ paths, instanceName: 'alpha' })
  const b = createInstanceWatermarkStore({ paths, instanceName: 'beta' })

  const key = a.keyFor('/cache', '/cache/datasets/d/source=x')
  await a.write(key, { continuation: { v: 1, seq: '10' } })
  await b.write(key, { continuation: { v: 1, seq: '20' } })

  const ra = await a.read(key)
  const rb = await b.read(key)
  assert.equal(ra?.continuation.seq, '10', "alpha's watermark is independent")
  assert.equal(rb?.continuation.seq, '20', "beta's watermark is independent")
  assert.ok(a.filePath(key).includes(path.join('sink-instances', 'alpha')))
  assert.ok(b.filePath(key).includes(path.join('sink-instances', 'beta')))
})

test('createInstanceWatermarkStore requires stateDir and instanceName', () => {
  assert.throws(() => createInstanceWatermarkStore({ paths: /** @type {any} */ ({}), instanceName: 'x' }), /stateDir is required/)
  assert.throws(() => createInstanceWatermarkStore({ paths: /** @type {any} */ ({ stateDir: '/s' }), instanceName: '' }), /instanceName is required/)
})

/** Minimal store stub exposing only keyFor for watermarkKeyFor tests. */
function createSinkWatermarkStub() {
  return {
    keyFor(/** @type {string} */ cacheRoot, /** @type {string} */ tablePath) {
      const rel = path.relative(path.join(cacheRoot, 'datasets'), tablePath)
      const [dataset, ...rest] = rel.split(path.sep)
      return { dataset, partitionKey: rest.join('/') }
    },
    filePath: () => '',
    read: async () => null,
    write: async () => ({ v: 1, continuation: { v: 1, seq: '0' }, exportedRowCount: 0, updatedAt: '' }),
  }
}
