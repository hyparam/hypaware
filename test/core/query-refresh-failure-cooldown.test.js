// @ts-check

/**
 * LLP 0321 let an `auto` query survive a spool-to-cache write the cache
 * rejects. LLP 0322 bounds the repetition that creates: the failure is
 * stamped, the stamp holds the query gate closed for a window, a retry
 * under a standing stamp stops minting one more `flush-*` file, and the
 * degrade reaches the span status code and the run metric rather than
 * only an attribute nobody alerts on.
 *
 * These tests pin all four, plus the two edges the bound must not cross:
 * a forced flush still rotates, so it never resolves having quietly left
 * the newest rows in the spool (LLP 0321's strict `always`), and a
 * declared status reaches the code on `runRoot` spans as well as
 * `withSpan` ones.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { metrics, MeterProvider, TracerProvider } from '../../src/core/observability/runtime.js'
import { markSpanStatus, runRoot, withSpan } from '../../src/core/observability/index.js'
import { parquetSourceFromRows } from '../helpers/parquet_source_fixture.js'
import { createCacheSpool, SPOOL_DIR } from '../../src/core/cache/spool.js'
import {
  AUTO_REFRESH_FAILURE_MESSAGE,
  executeQuerySql,
  settlePendingCacheForQuery,
} from '../../src/core/query/sql.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

const PARTITION_ERROR =
  'cache-iceberg: partition field "session_id" is new - adding a partition field is spec evolution and requires an explicit migration'

/** @type {ColumnSpec[]} */
const COLUMNS = [{ name: 'id', type: 'INT32', nullable: false }]

async function makeCacheRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refresh-cooldown-'))
}

/** @param {string} tablePath */
function flushFileCount(tablePath) {
  try {
    return fsSync
      .readdirSync(path.join(tablePath, SPOOL_DIR))
      .filter((name) => name.startsWith('flush-') && name.endsWith('.jsonl')).length
  } catch {
    return 0
  }
}

/**
 * A spool whose commit step can be switched between rejecting (the 1.27
 * partition error) and accepting, so one test can span the failure and the
 * repair.
 *
 * @param {string} cacheRoot
 */
function spoolWithSwitchableCommit(cacheRoot) {
  const state = { rejecting: true, commits: 0 }
  const spool = createCacheSpool({
    cacheRoot,
    async appendChunk(_tablePath, _columns, rows) {
      if (state.rejecting) throw new Error(PARTITION_ERROR)
      state.commits += 1
      return { bytesWritten: rows.length }
    },
  })
  return { spool, state }
}

/**
 * The storage face `settlePendingCacheForQuery` consumes, backed by a real
 * spool so the stamp is real durable state rather than a stub's opinion.
 *
 * @param {ReturnType<typeof createCacheSpool>} spool
 */
function storageOver(spool) {
  const calls = { flushes: 0 }
  return {
    calls,
    cacheRoot: '/unused',
    /** @param {string} tablePath */
    pendingInfo: (tablePath) => spool.pendingInfo(tablePath),
    /**
     * @param {string} tablePath
     * @param {{ reason?: string, force?: boolean }} [opts]
     */
    flushTable: (tablePath, opts) => {
      calls.flushes += 1
      return spool.flushTable(tablePath, opts)
    },
  }
}

test('a failed automatic refresh holds the gate closed instead of retrying on every query', async () => {
  const cacheRoot = await makeCacheRoot()
  const tablePath = path.join(cacheRoot, 'ai_gateway_messages')
  const { spool, state } = spoolWithSwitchableCommit(cacheRoot)
  const storage = storageOver(spool)

  await spool.append(tablePath, COLUMNS, [{ id: 1 }])

  // First query: the gate is open, the flush is attempted, the cache
  // rejects it, and LLP 0321's degrade serves the confirmed cache.
  const first = await settlePendingCacheForQuery({
    partitions: [{ tablePath }],
    storage: /** @type {any} */ (storage),
    refresh: 'auto',
    messages: [],
  })
  assert.equal(storage.calls.flushes, 1)

  // Every later query inside the window: the gate stays closed. Before LLP
  // 0322 each of these called `flushTable` again, because `lastFlushAtMs`
  // only advances on success and so the debounce never closed.
  /** @type {string[][]} */
  const rounds = []
  /** @type {unknown[]} */
  const results = []
  for (let i = 0; i < 20; i++) {
    /** @type {string[]} */
    const messages = []
    results.push(await settlePendingCacheForQuery({
      partitions: [{ tablePath }],
      storage: /** @type {any} */ (storage),
      refresh: 'auto',
      messages,
    }))
    rounds.push(messages)
  }
  assert.equal(
    storage.calls.flushes,
    1,
    'twenty queries inside the cooldown cost one flush attempt, not twenty'
  )

  // The failure is durable state, not a fact this process happens to hold.
  const info = await spool.pendingInfo(tablePath)
  assert.equal(typeof info.flushFailedAtMs, 'number', 'the failed flush leaves a readable stamp')

  // The cooled queries are still degraded, and still say so exactly once.
  assert.equal(/** @type {any} */ (first).degraded, true)
  for (const messages of rounds) {
    assert.deepEqual(
      messages,
      [AUTO_REFRESH_FAILURE_MESSAGE],
      'the user warning does not flicker on and off with the window'
    )
  }
  for (const result of results) {
    assert.equal(/** @type {any} */ (result).degraded, true, 'a cooled query is still degraded')
  }

  // Forced refresh is unaffected: it never consults the stamp.
  await assert.rejects(
    () => settlePendingCacheForQuery({
      partitions: [{ tablePath }],
      storage: /** @type {any} */ (storage),
      refresh: 'always',
      messages: [],
    }),
    new RegExp(PARTITION_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  )
  assert.equal(storage.calls.flushes, 2)

  // Once the cache is repaired and a flush completes, the stamp is gone.
  state.rejecting = false
  await spool.flushTable(tablePath, { reason: 'daemon' })
  const repaired = await spool.pendingInfo(tablePath)
  assert.equal(repaired.flushFailedAtMs ?? null, null, 'a completed flush retires the stamp')
  assert.equal(state.commits > 0, true, 'the waiting rows were committed, not dropped')

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('a stamp dated in the future or unreadable is no stamp', async () => {
  const cacheRoot = await makeCacheRoot()
  const tablePath = path.join(cacheRoot, 'ai_gateway_messages')
  const { spool } = spoolWithSwitchableCommit(cacheRoot)
  const storage = storageOver(spool)
  const stampPath = path.join(tablePath, SPOOL_DIR, 'last-flush-failure.json')

  await spool.append(tablePath, COLUMNS, [{ id: 1 }])
  await settlePendingCacheForQuery({
    partitions: [{ tablePath }],
    storage: /** @type {any} */ (storage),
    refresh: 'auto',
    messages: [],
  })
  assert.equal(storage.calls.flushes, 1)

  // A clock that moved backwards leaves a stamp in the future. Suppressing
  // work on state this build cannot interpret is the direction that hides
  // rows, so it reads as "not cooling down" and the flush is attempted.
  await fs.writeFile(
    stampPath,
    JSON.stringify({ failedAt: new Date(Date.now() + 86_400_000).toISOString() }),
    'utf8'
  )
  await settlePendingCacheForQuery({
    partitions: [{ tablePath }],
    storage: /** @type {any} */ (storage),
    refresh: 'auto',
    messages: [],
  })
  assert.equal(storage.calls.flushes, 2, 'a future-dated stamp does not hold the gate closed')

  await fs.writeFile(stampPath, 'not json at all', 'utf8')
  await settlePendingCacheForQuery({
    partitions: [{ tablePath }],
    storage: /** @type {any} */ (storage),
    refresh: 'auto',
    messages: [],
  })
  assert.equal(storage.calls.flushes, 3, 'an unparseable stamp does not hold the gate closed')

  // And a stamp older than the window releases it.
  await fs.writeFile(
    stampPath,
    JSON.stringify({
      failedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    }),
    'utf8'
  )
  await settlePendingCacheForQuery({
    partitions: [{ tablePath }],
    storage: /** @type {any} */ (storage),
    refresh: 'auto',
    messages: [],
  })
  assert.equal(storage.calls.flushes, 4, 'the retry resumes once the window is past')

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('a retry under a standing failure stops minting one more flush file each time', async () => {
  const cacheRoot = await makeCacheRoot()
  const tablePath = path.join(cacheRoot, 'ai_gateway_messages')
  const { spool, state } = spoolWithSwitchableCommit(cacheRoot)

  // The daemon's own scheduled flush does not consult the query gate, so the
  // cooldown alone cannot bound this. Live capture between attempts is what
  // makes each rotation non-empty and therefore permanent.
  await spool.append(tablePath, COLUMNS, [{ id: 0 }])
  await assert.rejects(() => spool.flushTable(tablePath, { reason: 'daemon' }))
  const afterFirst = flushFileCount(tablePath)
  assert.equal(afterFirst, 1, 'the first attempt rotates the active file and strands it')

  for (let i = 1; i <= 10; i++) {
    await spool.append(tablePath, COLUMNS, [{ id: i }])
    await assert.rejects(() => spool.flushTable(tablePath, { reason: 'daemon' }))
  }
  assert.equal(
    flushFileCount(tablePath),
    afterFirst,
    'ten more failing flushes under live capture leave the stranded set fixed'
  )

  // Nothing was lost by not rotating: the repair commits every row.
  state.rejecting = false
  await spool.flushTable(tablePath, { reason: 'daemon' })
  await spool.flushTable(tablePath, { reason: 'daemon' })
  const committed = await spool.pendingInfo(tablePath)
  assert.equal(committed.pending, false, 'the repaired flush drains the whole spool')
  assert.equal(committed.flushFailedAtMs ?? null, null)

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('a forced flush still rotates, so it never reports success having left rows behind', async () => {
  const cacheRoot = await makeCacheRoot()
  const tablePath = path.join(cacheRoot, 'ai_gateway_messages')
  const state = { rejecting: true }
  /** @type {number[]} */
  const committed = []
  const spool = createCacheSpool({
    cacheRoot,
    async appendChunk(_tablePath, _columns, rows) {
      if (state.rejecting) throw new Error(PARTITION_ERROR)
      for (const row of rows) committed.push(Number(row.id))
      return { bytesWritten: rows.length }
    },
  })

  // A failure strands one file and leaves a stamp.
  await spool.append(tablePath, COLUMNS, [{ id: 1 }])
  await assert.rejects(() => spool.flushTable(tablePath, { reason: 'daemon' }))
  assert.equal(flushFileCount(tablePath), 1)

  // Live capture keeps arriving in `active.jsonl` while the failure stands.
  await spool.append(tablePath, COLUMNS, [{ id: 2 }])
  state.rejecting = false

  // `force` is what `--refresh always`, `hyp query refresh`, the post-backfill
  // commit, and the sink export paths pass. Coalescing must not apply to them:
  // returning `flushed: true` with row 2 still in the spool is the silent drop
  // those callers flush to prevent, and breaks LLP 0321's strict `always`.
  const forced = await spool.flushTable(tablePath, { force: true, reason: 'query_always' })
  assert.equal(forced.flushed, true)
  assert.deepEqual(
    committed.sort((a, b) => a - b),
    [1, 2],
    'a forced flush commits the rows captured while the failure stood, not only the stranded ones'
  )
  const after = await spool.pendingInfo(tablePath)
  assert.equal(after.pending, false, 'a forced flush that resolves leaves nothing waiting')
  assert.equal(after.flushFailedAtMs ?? null, null)

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('the degrade reaches the span status code, and an ordinary late attribute does not', async () => {
  /** @type {any[]} */
  const captured = []
  const provider = new TracerProvider({
    resource: { attributes: {} },
    exporters: [{ exportBatch(spans) { captured.push(...spans) } }],
  })
  provider.register()
  try {
    await withSpan('test.degraded', { status: 'ok' }, async (span) => {
      markSpanStatus(span, 'degraded')
    })
    await withSpan('test.skipped', { status: 'ok' }, async (span) => {
      span.setAttribute('status', 'skipped')
    })
    // `markSpanStatus` takes a span, not a frame, so a caller cannot tell
    // which helper opened the one it holds. Honoring the declaration in only
    // one of the two would make it silently inert on every root span.
    await runRoot('test.root_degraded', { status: 'ok' }, async (span) => {
      markSpanStatus(span, 'degraded')
    })
  } finally {
    await provider.shutdown()
  }

  const degraded = captured.find((s) => s.name === 'test.degraded')
  assert.equal(degraded?.attributes.status, 'degraded')
  assert.equal(degraded?.status.code, 2, 'a declared degraded status ends the span as ERROR')
  assert.equal(degraded?.status.message, 'degraded')

  const rootDegraded = captured.find((s) => s.name === 'test.root_degraded')
  assert.equal(rootDegraded?.attributes.status, 'degraded')
  assert.equal(rootDegraded?.status.code, 2, 'runRoot honors a declared status too')

  // The narrowness is the point: reclassifying every span that writes
  // `status` late would sweep up unrelated `skipped` and `partial` spans.
  const skipped = captured.find((s) => s.name === 'test.skipped')
  assert.equal(skipped?.attributes.status, 'skipped')
  assert.equal(skipped?.status.code, 1, 'a bare late attribute write is left alone')
})

test('a degraded run is not counted as an ok run on the query metric', async () => {
  /** @type {any[]} */
  const records = []
  const provider = new MeterProvider({
    resource: { attributes: {} },
    exporters: [{ exportBatch(batch) { records.push(...batch) } }],
  })
  metrics.setGlobalMeterProvider(provider)
  try {
    const dataset = {
      name: 'ai_gateway_messages',
      schema: { columns: COLUMNS },
      discoverPartitions: async () => [{ tablePath: '/cache/ai_gateway_messages' }],
      createDataSource: async () => parquetSourceFromRows(COLUMNS, [{ id: 1 }]),
    }
    const registry = /** @type {any} */ ({
      getDataset: (/** @type {string} */ asked) => (asked === dataset.name ? dataset : undefined),
      listDatasets: () => [dataset],
    })
    // Pending rows the cache refuses: the run answers from the confirmed
    // cache (LLP 0321) and must say on the metric that it did.
    const storage = /** @type {any} */ ({
      cacheRoot: '/cache',
      pendingInfo: async () => ({ pending: true, pendingBytes: 1, lastFlushAtMs: null }),
      flushTable: async () => { throw new Error(PARTITION_ERROR) },
    })

    const out = await executeQuerySql({
      query: 'select id from ai_gateway_messages',
      registry,
      storage,
    })
    assert.equal(out.rows.length, 1, 'the confirmed cache is still served')

    const runs = records.filter((record) => record.name === 'hyp_query_runs_total')
    assert.equal(runs.length, 1)
    assert.equal(
      runs[0].attributes.status,
      'degraded',
      'an operator alerting on the status dimension sees the broken cache'
    )
    const durations = records.filter((record) => record.name === 'hyp_query_duration_ms')
    assert.equal(durations[0]?.attributes.status, 'degraded')
  } finally {
    await provider.shutdown()
  }
})
