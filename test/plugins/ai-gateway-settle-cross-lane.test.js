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
 * Issue #2876: on an otel-mode machine the Claude transcript sweep and the
 * OTEL listener write the same turn with the same `part_id`. Each lane checks
 * for the other only before its own write, so a turn both reach in one window
 * spools twice, and the flush-time dedupe used to run only for
 * fallback-carrying batches. A sweep row whose OTEL twin committed in an
 * earlier batch then committed beside it.
 *
 * @import { ColumnSpec, QueryStorageService } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'conversation_source', type: 'STRING', nullable: true },
  { name: 'provider', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'role', type: 'STRING', nullable: false },
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'part_index', type: 'INT32', nullable: false },
  { name: 'content_text', type: 'STRING', nullable: true },
]

/**
 * @param {'sweep' | 'otel'} lane
 * @param {string} messageId
 * @param {{ session?: string, cwd?: string | null, client?: string }} [opts]
 */
function row(lane, messageId, opts = {}) {
  const client = opts.client ?? 'claude'
  return {
    session_id: opts.session ?? 'sess-1',
    date: '2026-11-04',
    client_name: client,
    // The backfill materializer stamps the client name; the live lanes stamp
    // `claude_code`.
    conversation_source: lane === 'sweep' ? client : 'claude_code',
    provider: 'anthropic',
    cwd: opts.cwd === undefined ? '/work/repo' : opts.cwd,
    role: 'assistant',
    message_id: messageId,
    part_id: `${messageId}#0`,
    part_index: 0,
    content_text: `${lane} copy of ${messageId}`,
  }
}

async function stageStorage() {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cross-lane-'))
  const registration = /** @type {any} */ (aiGatewayDatasetRegistration(createGatewayState()))
  const storage = createQueryStorageService({
    cacheRoot,
    getDeclaration: (dataset) => dataset === DATASET_NAME ? registration.cachePartitioning : undefined,
  })
  const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v5'])
  /** @param {Record<string, unknown>[]} rows */
  const commit = async (rows) => {
    await storage.appendRows(tablePath, COLUMNS, rows)
    await storage.flushTable(tablePath, { force: true })
  }
  /** @param {Record<string, unknown>[]} rows @param {QueryStorageService} [via] */
  const settle = (rows, via = storage) => registration.settleBatch(rows, { storage: via })
  return {
    storage,
    commit,
    settle,
    cleanup: async () => { await fs.rm(cacheRoot, { recursive: true, force: true }) },
  }
}

/**
 * Wrap a storage so every committed read is counted.
 *
 * @param {QueryStorageService} storage
 */
function countingReads(storage) {
  const counter = { reads: 0 }
  const spy = /** @type {QueryStorageService} */ (/** @type {unknown} */ ({
    ...storage,
    discoverCachePartitions: (scope) => { counter.reads++; return storage.discoverCachePartitions(scope) },
    readRows: (p, c, o) => { counter.reads++; return storage.readRows(p, c, o) },
    readRowsWhere: (p, c, w) => {
      counter.reads++
      return /** @type {NonNullable<QueryStorageService['readRowsWhere']>} */ (storage.readRowsWhere)(p, c, w)
    },
  }))
  return { spy, counter }
}

test('a sweep row whose OTEL twin committed earlier is dropped at flush', async () => {
  const env = await stageStorage()
  try {
    await env.commit([row('otel', 'm-1')])
    const out = await env.settle([row('sweep', 'm-1'), row('sweep', 'm-2')])
    assert.deepEqual(out.map((r) => r.message_id), ['m-2'],
      'the committed OTEL copy wins; the sweep copy of m-1 never commits beside it')
  } finally {
    await env.cleanup()
  }
})

test('the same holds when the batch takes the settle plan without a fallback', async () => {
  const env = await stageStorage()
  try {
    await env.commit([row('otel', 'm-1')])
    // A null-cwd row selects the batch into the enrich plan, but nothing in it
    // is a gateway fallback, so the whole-batch dedupe stays off.
    const out = await env.settle([row('sweep', 'm-1', { cwd: null }), row('sweep', 'm-2', { cwd: null })])
    assert.deepEqual(out.map((r) => r.message_id), ['m-2'])
  } finally {
    await env.cleanup()
  }
})

test('within one batch the live copy is kept in either append order', async () => {
  const env = await stageStorage()
  try {
    for (const batch of [
      [row('otel', 'm-1'), row('sweep', 'm-1')],
      [row('sweep', 'm-1'), row('otel', 'm-1')],
    ]) {
      const out = await env.settle(batch)
      assert.equal(out.length, 1, 'one copy survives')
      assert.equal(out[0].conversation_source, 'claude_code', 'the sweep copy is the one dropped')
    }
  } finally {
    await env.cleanup()
  }
})

test('sweep first, OTEL second: the live pre-write check skips the OTEL copy', async () => {
  const env = await stageStorage()
  try {
    await env.commit([row('sweep', 'm-1')])
    const fresh = await dedupeStoredPartIds([row('otel', 'm-1'), row('otel', 'm-2')], env.storage)
    assert.deepEqual(fresh.map((r) => r.message_id), ['m-2'])
  } finally {
    await env.cleanup()
  }
})

test('a sweep row with no twin, and sweep duplicates within a batch, settle as before', async () => {
  const env = await stageStorage()
  try {
    await env.commit([row('otel', 'other', { session: 'sess-2' })])
    const out = await env.settle([row('sweep', 'm-1'), row('sweep', 'm-1'), row('sweep', 'm-3')])
    assert.deepEqual(out.map((r) => r.message_id), ['m-1', 'm-3'], 'first copy wins, fresh rows pass')
  } finally {
    await env.cleanup()
  }
})

test('a Claude Desktop sweep row is dropped against its committed twin', async () => {
  const env = await stageStorage()
  try {
    await env.commit([row('otel', 'm-1', { client: 'claude-desktop' })])
    const out = await env.settle([row('sweep', 'm-1', { client: 'claude-desktop' })])
    assert.deepEqual(out, [])
  } finally {
    await env.cleanup()
  }
})

test('a batch with no sweep row reads nothing and keeps every row', async () => {
  const env = await stageStorage()
  try {
    await env.commit([row('sweep', 'm-1')])
    const { spy, counter } = countingReads(env.storage)
    const otherClient = { ...row('sweep', 'm-1'), client_name: 'codex', conversation_source: 'codex_cli' }
    const batch = [row('otel', 'm-1'), row('otel', 'm-2'), otherClient]
    const out = await env.settle(batch, spy)
    assert.deepEqual(out, batch, 'live and other-client rows pass through untouched')
    assert.equal(counter.reads, 0, 'no committed scan on a batch without sweep rows')
  } finally {
    await env.cleanup()
  }
})

test('only the sweep rows are deduped; other rows in the batch pass untouched', async () => {
  const env = await stageStorage()
  try {
    await env.commit([row('otel', 'm-1'), row('sweep', 'm-2')])
    // m-2's OTEL copy is a live row, so this pass leaves it to the live
    // pre-write check rather than dropping it here.
    const out = await env.settle([row('otel', 'm-2'), row('sweep', 'm-1'), row('sweep', 'm-4')])
    assert.deepEqual(out.map((r) => `${r.conversation_source}:${r.message_id}`), ['claude_code:m-2', 'claude:m-4'])
  } finally {
    await env.cleanup()
  }
})
