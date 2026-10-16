// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { aiGatewayDatasetRegistration, DATASET_NAME, dedupeStoredPartIds } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'

/**
 * The telemetry dedupe's committed scan and the `readRowsWhere` lookup it
 * rides on. The dedupe question "is this `part_id` already committed?" is
 * answered by reading only the batch's own `session_id`s, which the cache
 * sorts on (LLP 0311#context), instead of re-reading the whole table per
 * telemetry POST.
 *
 * A pruned dedupe fails SILENTLY: a scan that does not look where the
 * committed twin lives reports it as fresh and the caller appends a second
 * copy. So these tests pin the two halves separately: that the scope is real
 * (an unrelated session's rows are never materialized) and that everything it
 * must still reach is reached (any date, and every degraded shape).
 *
 * @import { ColumnSpec, QueryStorageService } from '../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration } from '../../src/core/cache/types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'role', type: 'STRING', nullable: false },
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'part_index', type: 'INT32', nullable: false },
  { name: 'content_text', type: 'STRING', nullable: true },
]

/** Same shape minus `session_id`: the pre-LLP-0030 (`proxy_messages_v4`) table. */
const LEGACY_COLUMNS = COLUMNS.filter((c) => c.name !== 'session_id')

/**
 * @param {string} sessionId
 * @param {string} date
 * @param {string} messageId
 */
function row(sessionId, date, messageId) {
  return {
    session_id: sessionId,
    date,
    client_name: 'claude',
    role: 'assistant',
    message_id: messageId,
    part_id: `${messageId}#0`,
    part_index: 0,
    content_text: `content of ${messageId}`,
  }
}

/**
 * @param {{ legacy?: boolean }} [opts]
 * @returns {Promise<{ storage: ReturnType<typeof createQueryStorageService>, tablePath: string, cleanup: () => Promise<void> }>}
 */
async function stageStorage(opts = {}) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sess-dedupe-'))
  const registration = aiGatewayDatasetRegistration(createGatewayState())
  /** @type {CachePartitioningDeclaration | undefined} */
  const declaration = opts.legacy
    ? {
      source: { columns: ['client_name'], fallback: 'unknown' },
      iceberg: { fields: [{ column: 'date', transform: 'identity', required: true }] },
    }
    : registration.cachePartitioning
  const storage = createQueryStorageService({
    cacheRoot,
    getDeclaration: (dataset) => dataset === DATASET_NAME ? declaration : undefined,
  })
  const tablePath = storage.cacheTablePath(DATASET_NAME, [opts.legacy ? 'proxy_messages_v4' : 'proxy_messages_v5'])
  return {
    storage,
    tablePath,
    cleanup: async () => { await fs.rm(cacheRoot, { recursive: true, force: true }) },
  }
}

test('the telemetry dedupe catches a same-session duplicate committed on any date', async () => {
  const env = await stageStorage()
  try {
    await env.storage.appendRows(env.tablePath, COLUMNS, [
      row('sess-1', '2026-05-01', 'm-ancient'),
      row('sess-1', '2026-07-14', 'm-old'),
      row('sess-1', '2026-08-27', 'm-recent'),
    ])
    await env.storage.flushTable(env.tablePath, { force: true })

    const batch = [
      row('sess-1', '2026-08-27', 'm-ancient'), // months earlier: no date window can reach it
      row('sess-1', '2026-08-27', 'm-old'),
      row('sess-1', '2026-08-27', 'm-recent'),
      row('sess-1', '2026-08-27', 'm-fresh'),
    ]
    const fresh = await dedupeStoredPartIds(batch, env.storage)
    assert.deepEqual(fresh.map((r) => r.message_id), ['m-fresh'],
      'every committed copy of this session is found regardless of its date; only the new row survives')
  } finally {
    await env.cleanup()
  }
})

/**
 * The assertion that can tell the scoped scan apart from the unscoped one:
 * an unrelated session's committed rows are never materialized. Without it
 * every test here would also pass against a full-table scan.
 */
test('the committed scan is scoped to the batch\'s sessions', async () => {
  const env = await stageStorage()
  try {
    await env.storage.appendRows(env.tablePath, COLUMNS, [
      row('sess-mine', '2026-08-27', 'm-mine'),
      row('sess-theirs', '2026-08-27', 'm-theirs'),
    ])
    await env.storage.flushTable(env.tablePath, { force: true })

    /** @type {Record<string, string[]>[]} */
    const wheres = []
    /** @type {unknown[]} */
    const materialized = []
    let unscopedReads = 0
    const spy = /** @type {QueryStorageService} */ (/** @type {unknown} */ ({
      ...env.storage,
      discoverCachePartitions: (scope) => env.storage.discoverCachePartitions(scope),
      async *readRows(tablePath, columns, readOpts) {
        unscopedReads++
        yield* env.storage.readRows(tablePath, columns, readOpts)
      },
      async *readRowsWhere(tablePath, columns, whereIn) {
        wheres.push(whereIn)
        for await (const r of /** @type {NonNullable<typeof env.storage.readRowsWhere>} */ (env.storage.readRowsWhere)(tablePath, columns, whereIn)) {
          materialized.push(r)
          yield r
        }
      },
    }))

    const fresh = await dedupeStoredPartIds([row('sess-mine', '2026-08-27', 'm-mine')], spy)
    assert.deepEqual(fresh, [], 'the committed copy in this session is found')
    assert.equal(unscopedReads, 0, 'the hot path never falls back to the full scan when it does not have to')
    assert.deepEqual(wheres, [{ session_id: ['sess-mine'] }])
    assert.deepEqual(materialized.map((r) => /** @type {Record<string, unknown>} */ (r).part_id), ['m-mine#0'],
      'the other session\'s rows are pruned, not read and discarded')
  } finally {
    await env.cleanup()
  }
})

test('a batch row without a session id disables scoping rather than guessing', async () => {
  const env = await stageStorage()
  try {
    await env.storage.appendRows(env.tablePath, COLUMNS, [row('sess-1', '2026-05-01', 'm-old')])
    await env.storage.flushTable(env.tablePath, { force: true })

    const sessionless = { ...row('sess-1', '2026-08-27', 'm-old'), session_id: undefined }
    const fresh = await dedupeStoredPartIds([sessionless], env.storage)
    assert.equal(fresh.length, 0, 'the unscoped fallback scan still finds the committed part_id')
  } finally {
    await env.cleanup()
  }
})

/**
 * A committed table whose schema predates `session_id` (LLP 0030 bumped the
 * label, but a cache upgraded rather than recreated still carries the older
 * one) rejects the scoped predicate outright. Skipping such a partition would
 * report a committed row as fresh, so the scan degrades to the full read.
 */
test('a committed partition with no session_id column degrades to a full read', async () => {
  const env = await stageStorage({ legacy: true })
  try {
    const legacyRow = { ...row('sess-1', '2026-05-01', 'm-legacy') }
    delete (/** @type {Record<string, unknown>} */ (legacyRow)).session_id
    await env.storage.appendRows(env.tablePath, LEGACY_COLUMNS, [legacyRow])
    await env.storage.flushTable(env.tablePath, { force: true })

    const fresh = await dedupeStoredPartIds([row('sess-1', '2026-08-27', 'm-legacy')], env.storage)
    assert.equal(fresh.length, 0, 'the legacy partition is still scanned, so the duplicate is caught')
  } finally {
    await env.cleanup()
  }
})

/**
 * The scoped read is only cheaper than the full read while the list stays
 * narrow. Iceberg prunes on an `IN` list only when EVERY listed value falls
 * outside a chunk bound, so pruning decays toward nothing as the list widens,
 * and hyparquet then matches each surviving row by walking the whole list:
 * the scoped read becomes O(rows x sessions) against the full read O(rows).
 * Measured on a 200k-row committed partition it crosses over near 220
 * sessions and reaches 13.8x the full read at 4,000, so an uncapped list is
 * not a weaker optimization, it is slower than the scan it replaced without
 * bound.
 *
 * Timing cannot be asserted, so this pins the decision instead: past the cap
 * the scan issues the unrestricted read. It also pins the half that makes the
 * fallback safe rather than merely cheap, and the half a `[]`-vs-`[]` check
 * cannot see: both shapes must DROP the committed twins and KEEP the fresh
 * rows. A fallback that read the wrong thing and dropped everything is data
 * loss, not a slow dedupe, so the batch carries survivors on purpose.
 */
test('a batch too wide to prune reverts to the unrestricted read', async () => {
  const env = await stageStorage()
  const sess = (/** @type {number} */ i) => `sess-${String(i).padStart(4, '0')}`
  const WIDEST = 201
  try {
    // One committed row per session, on a date no batch row carries, so the
    // twin is only reachable by a read that spans dates (either shape).
    await env.storage.appendRows(env.tablePath, COLUMNS,
      Array.from({ length: WIDEST }, (_, i) => row(sess(i), '2026-05-01', `m-old-${i}`)))
    await env.storage.flushTable(env.tablePath, { force: true })

    /** @param {number} count */
    const batchOf = (count) => {
      /** @type {Record<string, unknown>[]} */
      const rows = []
      for (let i = 0; i < count; i++) {
        rows.push(row(sess(i), '2026-08-27', `m-old-${i}`)) // committed: must drop
        rows.push(row(sess(i), '2026-08-27', `m-new-${i}`)) // never written: must survive
      }
      return rows
    }
    /** @param {number} count */
    const expectedSurvivors = (count) => Array.from({ length: count }, (_, i) => `m-new-${i}#0`)

    /** @param {Record<string, unknown>[]} batch */
    const dedupeWithSpy = async (batch) => {
      /** @type {(Record<string, string[]> | undefined)[]} */
      const wheres = []
      let unscopedReads = 0
      const spy = /** @type {QueryStorageService} */ (/** @type {unknown} */ ({
        ...env.storage,
        discoverCachePartitions: (scope) => env.storage.discoverCachePartitions(scope),
        async *readRows(tablePath, columns, readOpts) {
          unscopedReads++
          yield* env.storage.readRows(tablePath, columns, readOpts)
        },
        async *readRowsWhere(tablePath, columns, whereIn) {
          wheres.push(whereIn)
          yield* /** @type {NonNullable<typeof env.storage.readRowsWhere>} */ (env.storage.readRowsWhere)(tablePath, columns, whereIn)
        },
      }))
      const fresh = await dedupeStoredPartIds(batch, spy)
      return { fresh, wheres, unscopedReads }
    }

    const narrow = await dedupeWithSpy(batchOf(200))
    assert.equal(narrow.unscopedReads, 0, 'a list the cache can prune on still takes the scoped read')
    assert.equal(narrow.wheres.length, 1)
    assert.equal(narrow.wheres[0]?.session_id?.length, 200, 'the whole batch is pushed down, not a prefix of it')

    const wide = await dedupeWithSpy(batchOf(WIDEST))
    assert.equal(wide.wheres.length, 0, 'a list too wide to prune on is never pushed down')
    assert.ok(wide.unscopedReads > 0, 'it reads the partition unrestricted instead')

    // The equivalence the fallback rests on: the full read answers the same
    // membership question over a superset of the rows, so neither shape may
    // miss a committed twin (a silent duplicate) or drop a fresh row.
    assert.deepEqual(narrow.fresh.map((r) => r.part_id), expectedSurvivors(200))
    assert.deepEqual(wide.fresh.map((r) => r.part_id), expectedSurvivors(WIDEST))
  } finally {
    await env.cleanup()
  }
})
