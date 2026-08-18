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
