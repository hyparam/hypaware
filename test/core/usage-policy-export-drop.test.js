// @ts-check

// Export-seam enforcement for `local-only` (LLP 0070/0080, task T3): the shared
// export read (`storage.readRowsSince`) withholds a row whose `cwd` resolves to
// a non-`full` class, but still surfaces its `after` so the cursor advances
// across it (drop-but-advance). Rows stay in the cache (local query untouched).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { openIncrementalRows } from '../../src/core/sinks/incremental.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.d.ts'
 * @import { ResolveResult, UsagePolicyResolver } from '../../src/core/usage-policy/types.js'
 */

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-export-drop-'))
}

/** @type {ColumnSpec[]} */
const COLS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'cwd', type: 'STRING', nullable: true },
]

/**
 * A stub resolver mirroring the real one's shape: a `cwd` equal-or-descendant of
 * a listed dir is `local-only`; everything else is `full`. `corrupt` makes every
 * resolve throw, standing in for an unreadable list (LLP 0080 #fail-safe).
 *
 * @param {{ localOnly?: string[], corrupt?: boolean }} [opts]
 * @returns {UsagePolicyResolver}
 */
function makeResolver({ localOnly = [], corrupt = false } = {}) {
  /** @type {(cwd: string) => ResolveResult} */
  const resolve = (cwd) => {
    if (corrupt) throw new Error("local-only list at '/state/usage-policy/local-only.json' is unreadable or malformed")
    const excluded = localOnly.some((d) => cwd === d || cwd.startsWith(d.endsWith('/') ? d : `${d}/`))
    return excluded
      ? { class: 'local-only', governedBy: '/list', declared: 'local-only' }
      : { class: 'full', governedBy: null, declared: null }
  }
  return { resolve, isIgnored: (cwd) => resolve(cwd).class === 'ignore' }
}

test('readRowsSince: local-only cwd rows are dropped from the payload but the cursor advances across them; full and cwd-less rows pass', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    usagePolicyResolver: makeResolver({ localOnly: ['/work/secret'] }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, cwd: '/work/public' }, // full -> shipped
    { id: 2, cwd: '/work/secret' }, // local-only -> dropped (exact)
    { id: 3, cwd: '/work/secret/app' }, // local-only -> dropped (descendant)
    { id: 4, cwd: '' }, // empty cwd -> passes (directory exclusion is a no-op)
    { id: 5, cwd: null }, // no cwd -> passes
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const shippedIds = []
  let droppedCount = 0
  let prev = -1n
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      const cur = BigInt(entry.after.seq)
      assert.ok(cur >= prev, 'the `after` cursor never regresses, even across a drop')
      prev = cur
      if (entry.dropped) {
        droppedCount += 1
        assert.equal(entry.row, undefined, 'a drop-only entry carries no row payload')
      } else {
        shippedIds.push(Number(entry.row.id))
      }
    }
  }

  assert.deepEqual(shippedIds.sort((a, b) => a - b), [1, 4, 5], 'only full + cwd-less rows reach the payload')
  assert.equal(droppedCount, 2, 'both local-only rows are dropped, not just the exact match')

  // The local-only rows are still in the cache (local query is a different read
  // path): the unfiltered full-scan `readRows` returns every row, including the
  // withheld ones — cache-but-never-forward, not capture-time drop.
  /** @type {number[]} */
  const cachedIds = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const row of svc.readRows(part.path)) cachedIds.push(Number(row.id))
  }
  assert.deepEqual(cachedIds.sort((a, b) => a - b), [1, 2, 3, 4, 5], 'all rows remain locally queryable in the cache')

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

// A `columns` projection that omits `cwd` must not be able to blind the export
// filter: the filter reads each row's own `cwd`, so `readRowsSince` forces `cwd`
// into the scan whenever a resolver is configured and strips it back out of any
// yielded row the caller didn't request it in (LLP 0070 #enforce).
test('readRowsSince: a `columns` projection omitting cwd still withholds local-only rows, and full rows come back without a cwd field', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    usagePolicyResolver: makeResolver({ localOnly: ['/work/secret'] }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, cwd: '/work/public' }, // full -> shipped, but projected without cwd
    { id: 2, cwd: '/work/secret' }, // local-only -> dropped even though the caller omitted cwd
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {Record<string, unknown>[]} */
  const shipped = []
  let droppedCount = 0
  for (const part of await svc.discoverCachePartitions()) {
    // Caller asks for `id` only — NO `cwd`. Withholding must not depend on it.
    for await (const entry of svc.readRowsSince(part.path, { columns: ['id'] })) {
      if (entry.dropped) {
        droppedCount += 1
        assert.equal(entry.row, undefined, 'a drop-only entry carries no row payload')
      } else {
        shipped.push(entry.row)
      }
    }
  }

  assert.equal(droppedCount, 1, 'the local-only row is still withheld despite the cwd-less projection')
  assert.deepEqual(shipped, [{ id: 1n }], 'the full row is shipped as the projected columns only (INT64 reads back as a bigint)')
  assert.ok(!('cwd' in shipped[0]), "cwd is stripped back off — the caller's projection contract is honored")

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: a corrupt list (resolver throws) fails the partition read rather than silently skipping', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({ cacheRoot, usagePolicyResolver: makeResolver({ corrupt: true }) })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [{ id: 1, cwd: '/work/anything' }])
  await svc.flushTable(spoolPath, { reason: 'manual' })
  const parts = await svc.discoverCachePartitions()

  await assert.rejects(async () => {
    for await (const _ of svc.readRowsSince(parts[0].path, {})) { /* drain */ }
  }, /unreadable or malformed/)

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: with no resolver configured, nothing is ever dropped (cwd is ignored)', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({ cacheRoot }) // no usagePolicyResolver
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, cwd: '/work/secret' },
    { id: 2, cwd: '/work/public' },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const ids = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      assert.ok(!entry.dropped && entry.row, 'no resolver ⇒ every entry is a payload row')
      ids.push(Number(entry.row.id))
    }
  }
  assert.deepEqual(ids.sort((a, b) => a - b), [1, 2])

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

// ---- openIncrementalRows: drop-skip / advance / droppedRowCount (blob sinks) ----

/**
 * Storage stub whose `readRowsSince` yields a described entry sequence: a
 * payload row `{ seq, id }` or a drop `{ seq, drop: true }`. Mirrors storage.js:
 * `after` is the running high-water seq; a drop carries it forward with no row.
 *
 * @param {string} tablePath
 * @param {Array<{ seq: number, id?: string, drop?: boolean }>} entries
 */
function makeDropStorage(tablePath, entries) {
  return {
    cacheRoot: '/cache',
    /** @param {string} tp */
    tableExists: (tp) => tp === tablePath,
    /** @param {string} tp @param {{ since?: { seq: string } }} [opts] */
    readRowsSince(tp, opts) {
      const list = tp === tablePath ? entries : []
      const since = opts?.since ? BigInt(opts.since.seq) : 0n
      return {
        async *[Symbol.asyncIterator]() {
          let high = since
          for (const e of list) {
            const seq = BigInt(e.seq)
            if (seq <= since) continue
            if (seq > high) high = seq
            const after = { v: 1, seq: high.toString() }
            if (e.drop) yield { after, dropped: true }
            else yield { row: { id: e.id }, after }
          }
        },
      }
    },
  }
}

const TABLE = '/cache/datasets/d/source=x'

/** @param {any} storage @param {any} since */
async function open(storage, since) {
  return openIncrementalRows(storage, /** @type {any} */ ({ dataset: 'd', partition: {}, tablePath: TABLE }), since)
}

/** @param {AsyncIterable<Record<string, unknown>>} rows */
async function drain(rows) {
  /** @type {Record<string, unknown>[]} */
  const out = []
  for await (const r of rows) out.push(r)
  return out
}

test('openIncrementalRows: leading drops are skipped from the encoder stream but advance lastAfter', async () => {
  const storage = makeDropStorage(TABLE, [
    { seq: 1, drop: true },
    { seq: 2, drop: true },
    { seq: 3, id: 'a' },
    { seq: 4, id: 'b' },
  ])
  const reader = await open(storage, undefined)
  assert.equal(reader.empty, false, 'a partition with any payload row is not empty')
  const rows = await drain(reader.rows)
  assert.deepEqual(rows, [{ id: 'a' }, { id: 'b' }], 'only payload rows reach the encoder')
  assert.equal(reader.rowCount, 2)
  assert.equal(reader.droppedRowCount, 2)
  assert.equal(reader.lastAfter.seq, '4', 'the high-water covers the trailing payload')
})

test('openIncrementalRows: trailing drops still advance lastAfter past the last real row', async () => {
  const storage = makeDropStorage(TABLE, [
    { seq: 1, id: 'a' },
    { seq: 2, drop: true },
    { seq: 3, drop: true },
  ])
  const reader = await open(storage, undefined)
  assert.equal(reader.empty, false)
  const rows = await drain(reader.rows)
  assert.deepEqual(rows, [{ id: 'a' }])
  assert.equal(reader.rowCount, 1)
  assert.equal(reader.droppedRowCount, 2)
  assert.equal(reader.lastAfter.seq, '3', 'the watermark passes the trailing local-only tail')
})

test('openIncrementalRows: an all-drops partition is empty yet exposes droppedRowCount and an advanced lastAfter', async () => {
  const storage = makeDropStorage(TABLE, [
    { seq: 1, drop: true },
    { seq: 2, drop: true },
  ])
  const reader = await open(storage, undefined)
  assert.equal(reader.empty, true, 'no payload row ⇒ empty (the sink writes no blob)')
  assert.equal(await drain(reader.rows).then((r) => r.length), 0)
  assert.equal(reader.rowCount, 0)
  assert.equal(reader.droppedRowCount, 2, 'drops are counted during the leading-drop peek')
  assert.equal(reader.lastAfter.seq, '2', 'lastAfter advanced so the caller can still checkpoint')
})

test('openIncrementalRows: interleaved drops are skipped, real rows kept in order', async () => {
  const storage = makeDropStorage(TABLE, [
    { seq: 1, id: 'a' },
    { seq: 2, drop: true },
    { seq: 3, id: 'c' },
  ])
  const reader = await open(storage, undefined)
  const rows = await drain(reader.rows)
  assert.deepEqual(rows, [{ id: 'a' }, { id: 'c' }])
  assert.equal(reader.rowCount, 2)
  assert.equal(reader.droppedRowCount, 1)
  assert.equal(reader.lastAfter.seq, '3')
})
