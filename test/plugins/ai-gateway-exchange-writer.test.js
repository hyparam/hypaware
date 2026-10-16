// @ts-check

/**
 * `recordProjectedExchange` is the seam a live producer that is not the
 * proxy writes `ai_gateway_messages` through. What it has to guarantee:
 * the rows are the ones the shared expansion produces, and a part some
 * other producer already stored is not written twice.
 *
 * @ref LLP 0252#projection-unchanged [tests]: OTEL is a third producer of the
 *   dataset, and producer overlap collapses on `part_id` before the write
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'

/**
 * Storage stub with the surface the dedupe feature-detects:
 * `discoverCachePartitions` + `readRows` for committed rows,
 * `readSpooledRows` for rows captured but not yet flushed.
 *
 * @param {{ committed?: string[], spooled?: string[] }} [seed]
 */
function makeStorage(seed = {}) {
  const committed = seed.committed ?? []
  const spooled = seed.spooled ?? []
  /** @type {Record<string, unknown>[]} */
  const appended = []
  /** @type {string[]} */
  const readRowsCalls = []
  return {
    appended,
    readRowsCalls,
    /** @param {string} dataset @param {string[]} labels */
    cacheTablePath: (dataset, labels) => `/cache/${dataset}/${labels.join('/')}`,
    /** @param {{ datasets: string[] }} _scope */
    async discoverCachePartitions(_scope) {
      return [{ path: '/cache/committed', partition: {}, rowCount: committed.length }]
    },
    /** @param {string} tablePath */
    async *readRows(tablePath) {
      readRowsCalls.push(tablePath)
      for (const partId of committed) yield { part_id: partId }
    },
    async *readSpooledRows() {
      for (const partId of spooled) yield { part_id: partId }
    },
    /** @param {string} _tablePath @param {unknown} _columns @param {Record<string, unknown>[]} rows */
    async appendRows(_tablePath, _columns, rows) {
      appended.push(...rows)
    },
  }
}

/** @param {string} sessionId */
function projection(sessionId) {
  return {
    provider: 'anthropic',
    session_id: sessionId,
    client_name: 'claude',
    conversation_source: 'claude_code',
    messages: [
      { role: 'user', content: 'hello', message_id: 'uuid-user', provider_uuid: 'uuid-user' },
      { role: 'assistant', content: 'hi', message_id: 'uuid-asst', provider_uuid: 'uuid-asst' },
    ],
  }
}

test('a projected exchange becomes rows on the ai_gateway_messages table', async () => {
  const storage = makeStorage()
  const api = createAiGatewayApi(createGatewayState(), { storage: /** @type {any} */ (storage) })
  const result = await api.recordProjectedExchange(/** @type {any} */ (projection('s1')))
  assert.deepEqual(result, { rowsWritten: 2, rowsSkipped: 0 })
  assert.deepEqual(storage.appended.map((r) => r.part_id), ['uuid-user#0', 'uuid-asst#0'])
  assert.equal(storage.appended[0].session_id, 's1')
})

test('producer provenance rides the rows', async () => {
  const storage = makeStorage()
  const api = createAiGatewayApi(createGatewayState(), { storage: /** @type {any} */ (storage) })
  await api.recordProjectedExchange(/** @type {any} */ (projection('s1')), {
    gatewayAttributes: { gateway: { source: 'otel' } },
  })
  assert.equal(/** @type {any} */ (storage.appended[0].attributes)?.gateway?.source, 'otel')
})

test('a part another producer already committed is skipped, not written twice', async () => {
  const storage = makeStorage({ committed: ['uuid-user#0'] })
  const api = createAiGatewayApi(createGatewayState(), { storage: /** @type {any} */ (storage) })
  const result = await api.recordProjectedExchange(/** @type {any} */ (projection('s1')))
  assert.deepEqual(result, { rowsWritten: 1, rowsSkipped: 1 })
  assert.deepEqual(storage.appended.map((r) => r.part_id), ['uuid-asst#0'])
})

test('a part still pending in the spool counts as stored', async () => {
  const storage = makeStorage({ spooled: ['uuid-asst#0'] })
  const api = createAiGatewayApi(createGatewayState(), { storage: /** @type {any} */ (storage) })
  const result = await api.recordProjectedExchange(/** @type {any} */ (projection('s1')))
  assert.deepEqual(result, { rowsWritten: 1, rowsSkipped: 1 })
  assert.deepEqual(storage.appended.map((r) => r.part_id), ['uuid-user#0'])
})

test('re-delivering the same exchange writes nothing the second time', async () => {
  const storage = makeStorage()
  const api = createAiGatewayApi(createGatewayState(), { storage: /** @type {any} */ (storage) })
  await api.recordProjectedExchange(/** @type {any} */ (projection('s1')))
  const again = await api.recordProjectedExchange(/** @type {any} */ (projection('s1')))
  assert.deepEqual(again, { rowsWritten: 0, rowsSkipped: 0 })
  assert.equal(storage.appended.length, 2)
})

test('recording without a storage service fails loudly', async () => {
  const api = createAiGatewayApi(createGatewayState())
  await assert.rejects(
    () => api.recordProjectedExchange(/** @type {any} */ (projection('s1'))),
    /storage service/
  )
})

/**
 * Row expansion mutates the writer's process-lifetime dedupe state while
 * building rows, but the write that makes those rows real happens after.
 * A producer that retries a failed delivery (the OTEL listener answers
 * HTTP 500 and Claude Code re-POSTs the batch) must find the state as it
 * was before the failed attempt, or the retry projects zero rows and the
 * batch is lost with `rowsWritten: 0` and no error. Issue #879.
 *
 * @ref LLP 0252#projection-unchanged [tests]: the dedupe belongs to the
 *   dataset owner, so it is the dataset owner that has to keep it agreeing
 *   with what actually landed
 */
test('a failed append leaves the dedupe as it was, so the retry writes the batch', async () => {
  const storage = makeStorage()
  const realAppendRows = storage.appendRows.bind(storage)
  let failNext = true
  storage.appendRows = async (tablePath, columns, rows) => {
    if (failNext) {
      failNext = false
      throw new Error('ENOSPC: no space left on device')
    }
    return realAppendRows(tablePath, columns, rows)
  }

  const api = createAiGatewayApi(createGatewayState(), { storage: /** @type {any} */ (storage) })
  await assert.rejects(
    () => api.recordProjectedExchange(/** @type {any} */ (projection('s1'))),
    /ENOSPC/
  )
  assert.equal(storage.appended.length, 0)

  const retry = await api.recordProjectedExchange(/** @type {any} */ (projection('s1')))
  assert.deepEqual(retry, { rowsWritten: 2, rowsSkipped: 0 })
  assert.deepEqual(storage.appended.map((r) => r.part_id), ['uuid-user#0', 'uuid-asst#0'])
})

test('a rolled-back exchange still dedupes normally once it has landed', async () => {
  const storage = makeStorage()
  const realAppendRows = storage.appendRows.bind(storage)
  let failNext = true
  storage.appendRows = async (tablePath, columns, rows) => {
    if (failNext) {
      failNext = false
      throw new Error('ENOSPC: no space left on device')
    }
    return realAppendRows(tablePath, columns, rows)
  }

  const api = createAiGatewayApi(createGatewayState(), { storage: /** @type {any} */ (storage) })
  await assert.rejects(() => api.recordProjectedExchange(/** @type {any} */ (projection('s1'))), /ENOSPC/)
  await api.recordProjectedExchange(/** @type {any} */ (projection('s1')))
  const third = await api.recordProjectedExchange(/** @type {any} */ (projection('s1')))
  assert.deepEqual(third, { rowsWritten: 0, rowsSkipped: 0 })
  assert.equal(storage.appended.length, 2)
})

/**
 * The same loss as #879, one step earlier: row expansion marks each message
 * seen as it walks the caller's projection content, so a throw partway
 * through leaves the earlier messages of the batch marked while nothing was
 * written. Expansion has to be inside the rollback's reach, not in front of
 * it.
 */
test('a throw during row expansion leaves the dedupe as it was', async () => {
  const storage = makeStorage()
  const api = createAiGatewayApi(createGatewayState(), { storage: /** @type {any} */ (storage) })

  const poisoned = projection('s1')
  Object.defineProperty(poisoned.messages[1], 'content', {
    enumerable: true,
    get() { throw new Error('unreadable content') },
  })
  await assert.rejects(
    () => api.recordProjectedExchange(/** @type {any} */ (poisoned)),
    /unreadable content/
  )
  assert.equal(storage.appended.length, 0)

  const retry = await api.recordProjectedExchange(/** @type {any} */ (projection('s1')))
  assert.deepEqual(retry, { rowsWritten: 2, rowsSkipped: 0 })
  assert.deepEqual(storage.appended.map((r) => r.part_id), ['uuid-user#0', 'uuid-asst#0'])
})
