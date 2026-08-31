// @ts-check

/**
 * LLP 0330 advertises `hyp query refresh` as the retry half of the
 * `cache_flush_failing` repair pair, and LLP 0321 keeps a forced refresh
 * strict: a failure never reads as success. LLP 0333 settles the piece
 * between them: strictness constrains the outcome, not the abort order,
 * so the run attempts every table, accumulates every error, reports each
 * one, and still exits non-zero. `spool.flushAll` shares the shape.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runQueryRefresh } from '../../src/core/commands/query.js'
import { createCacheSpool, readFlushFailure } from '../../src/core/cache/spool.js'

/** @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js' */

const PARTITION_ERROR =
  'cache-iceberg: partition field "session_id" is new - adding a partition field is spec evolution and requires an explicit migration'

/** @type {ColumnSpec[]} */
const COLUMNS = [{ name: 'id', type: 'INT32', nullable: false }]

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * A refresh ctx over the named datasets, where each named table's forced
 * flush throws and every other table's succeeds.
 *
 * @param {{ failingTable: string | string[], datasets?: string[] }} opts
 */
function refreshCtx(opts) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const failing = new Set(Array.isArray(opts.failingTable) ? opts.failingTable : [opts.failingTable])
  /** @type {string[]} */
  const flushed = []
  /** @param {string} name */
  const dataset = (name) => ({
    name,
    discoverPartitions: async () => [
      { dataset: name, partition: { source: 'claude' }, tablePath: `/cache/datasets/${name}/source=claude` },
    ],
    refreshPartition: async () => ({ status: 'skipped', rows: 0 }),
  })
  const names = opts.datasets ?? ['alpha', 'beta']
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    config: {},
    query: { listDatasets: () => names.map(dataset) },
    storage: {
      cacheRoot: '/cache',
      /** @param {string} tablePath */
      flushTable: async (tablePath) => {
        flushed.push(tablePath)
        if (failing.has(tablePath)) throw new Error(`${PARTITION_ERROR} [${tablePath}]`)
        return { flushed: true }
      },
    },
  })
  return { ctx, stdout, stderr, flushed }
}

test('a still-failing table does not stop the refresh: every table is attempted and the run still fails', async () => {
  // @ref LLP 0333#every-table-before-failure [tests]: the run reaches every table, reports every error, and exits non-zero
  const { ctx, stdout, stderr, flushed } = refreshCtx({
    failingTable: '/cache/datasets/alpha/source=claude',
  })

  const code = await runQueryRefresh([], ctx)

  // The table behind the failing one got its forced flush - the whole point.
  assert.deepEqual(flushed, [
    '/cache/datasets/alpha/source=claude',
    '/cache/datasets/beta/source=claude',
  ])
  // LLP 0321's strict outcome stands: the failure is not swallowed.
  assert.equal(code, 1)
  assert.match(stderr.text(), /hyp query refresh: alpha\/source=claude: cache-iceberg: partition field "session_id" is new/)
  assert.match(stdout.text(), /1 refresh failure\(s\)/)
})

test('several standing failures in one run: every one is reported, none is collapsed into the first', async () => {
  // The incident this document exists for has N tables carrying stamps, so
  // the guarantee that matters is per failure, not per run: an accumulator
  // that kept only the first error would still attempt every table, still
  // exit 1, and still print a line, while telling the operator about one
  // cause out of three. Two failures either side of a healthy table pin it.
  // @ref LLP 0333#every-table-before-failure [tests]: every error is accumulated and reported, not just the first
  const { ctx, stdout, stderr, flushed } = refreshCtx({
    datasets: ['alpha', 'beta', 'gamma'],
    failingTable: ['/cache/datasets/alpha/source=claude', '/cache/datasets/gamma/source=claude'],
  })

  const code = await runQueryRefresh([], ctx)

  assert.equal(code, 1)
  assert.equal(flushed.length, 3, 'a failure between two tables strands neither')
  const lines = stderr.text().trim().split('\n')
  assert.equal(lines.length, 2, 'one stderr line per failure')
  assert.match(lines[0], /hyp query refresh: alpha\/source=claude: .*\[\/cache\/datasets\/alpha\/source=claude\]/)
  assert.match(lines[1], /hyp query refresh: gamma\/source=claude: .*\[\/cache\/datasets\/gamma\/source=claude\]/)
  assert.match(stdout.text(), /2 refresh failure\(s\)/)
})

test('a clean refresh keeps its old summary line and exit code', async () => {
  const { ctx, stdout, stderr } = refreshCtx({ failingTable: '/nowhere' })
  const code = await runQueryRefresh([], ctx)
  assert.equal(code, 0)
  assert.equal(stdout.text(), 'refreshed 2 dataset(s), wrote 0 row(s)\n')
  assert.equal(stderr.text(), '')
})

test('spool.flushAll reaches the table behind a failing one, then rethrows the first error', async () => {
  // @ref LLP 0333#every-table-before-failure [tests]: flushAll attempts every table before failing, so callers keep the throw and the healthy tables keep their flush
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-flushall-'))
  try {
    const tableA = path.join(cacheRoot, 'datasets', 'alpha')
    const tableB = path.join(cacheRoot, 'datasets', 'beta')
    /** @type {string[]} */
    const committed = []
    const spool = createCacheSpool({
      cacheRoot,
      async appendChunk(tablePath, _columns, rows) {
        if (tablePath === tableA) throw new Error(PARTITION_ERROR)
        committed.push(tablePath)
        return { bytesWritten: rows.length }
      },
    })
    await spool.append(tableA, COLUMNS, [{ id: 1 }])
    await spool.append(tableB, COLUMNS, [{ id: 2 }])

    // The first table's commit rejects; the error still surfaces, but only
    // after the second table's rows made it into the cache.
    await assert.rejects(
      () => spool.flushAll({ force: true }),
      (err) => err instanceof Error && err.message === PARTITION_ERROR
    )
    assert.deepEqual(committed, [tableB])

    // Each table's stamp tells its own truth: the failing one is stamped,
    // the flushed one carries none (LLP 0322#clearing).
    assert.ok(await readFlushFailure(tableA), 'the failing table is stamped')
    assert.equal(await readFlushFailure(tableB), null)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('spool.flushAll keeps going past the second failing table, and still rethrows the first error', async () => {
  // One failing table only proves the loop does not break on a throw; it
  // does not prove the pass survives the failure after that. With two
  // failures either side of a healthy table, both get their stamp in one
  // pass (LLP 0322#clearing needs the attempt to happen at all) and the
  // error the caller sees is still the first one.
  // @ref LLP 0333#every-table-before-failure [tests]: every failing table is attempted and stamped in one pass, and the first error is the one rethrown
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-flushall-many-'))
  try {
    const tableA = path.join(cacheRoot, 'datasets', 'alpha')
    const tableB = path.join(cacheRoot, 'datasets', 'beta')
    const tableC = path.join(cacheRoot, 'datasets', 'gamma')
    const tableD = path.join(cacheRoot, 'datasets', 'delta')
    /** @type {string[]} */
    const committed = []
    const spool = createCacheSpool({
      cacheRoot,
      async appendChunk(tablePath, _columns, rows) {
        if (tablePath === tableA) throw new Error(PARTITION_ERROR)
        if (tablePath === tableC) throw new Error('cache-iceberg: a second, different rejection')
        committed.push(tablePath)
        return { bytesWritten: rows.length }
      },
    })
    await spool.append(tableA, COLUMNS, [{ id: 1 }])
    await spool.append(tableB, COLUMNS, [{ id: 2 }])
    await spool.append(tableC, COLUMNS, [{ id: 3 }])
    await spool.append(tableD, COLUMNS, [{ id: 4 }])

    await assert.rejects(
      () => spool.flushAll({ force: true }),
      (err) => err instanceof Error && err.message === PARTITION_ERROR
    )
    assert.deepEqual(committed, [tableB, tableD], 'neither the table between the two failures nor the one behind both is stranded')
    assert.ok(await readFlushFailure(tableA), 'the first failing table is stamped')
    assert.equal(await readFlushFailure(tableB), null)
    assert.ok(await readFlushFailure(tableC), 'the failing table after the first is stamped too')
    assert.equal(await readFlushFailure(tableD), null)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
