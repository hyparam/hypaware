// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { TracerProvider } from '../../src/core/observability/runtime.js'
import { withSpan } from '../../src/core/observability/index.js'
import { settlePendingCacheForQuery } from '../../src/core/query/sql.js'

const PARTITION_ERROR =
  'cache-iceberg: partition field "session_id" is new - adding a partition field is spec evolution and requires an explicit migration'

function failingStorage() {
  let flushes = 0
  return {
    get flushes() { return flushes },
    cacheRoot: '/tmp/hypaware-query-refresh-test',
    pendingInfo: async () => ({ pending: true, pendingBytes: 1, lastFlushAtMs: null }),
    flushTable: async () => {
      flushes++
      throw new Error(PARTITION_ERROR)
    },
  }
}

test('automatic refresh serves confirmed data once and marks the query degraded', async () => {
  const storage = failingStorage()
  const messages = []
  const captured = []
  const provider = new TracerProvider({
    resource: { attributes: {} },
    exporters: [{ exportBatch(spans) { captured.push(...spans) } }],
  })
  provider.register()
  try {
    await withSpan('test.query', {}, async () => {
      await settlePendingCacheForQuery({
        partitions: [{ tablePath: '/cache/a' }, { tablePath: '/cache/b' }],
        storage: /** @type {any} */ (storage),
        refresh: 'auto',
        messages,
      })
    })

    assert.equal(storage.flushes, 2, 'one failed stream does not stop the remaining refresh attempts')
    // One warning and one reason, not two of each: both failing partitions
    // dedupe into the same pair, and the reason line says what the attempt
    // failed with so the user is not sent to the spool internals to learn it.
    // @ref LLP 0330#query-quotes-the-reason [tests]:
    assert.deepEqual(messages, [
      'cache: refresh failed; using previously saved data; newer waiting rows may be missing',
      `cache: last refresh attempt failed: ${PARTITION_ERROR}`,
    ])
    const span = captured.find((candidate) => candidate.name === 'test.query')
    assert.equal(span?.attributes.status, 'degraded')
    assert.equal(span?.attributes.cache_refresh_failed, true)
    assert.equal(
      span?.events.filter((event) => event.name === 'query.cache_refresh_failed').length,
      2,
      'each failed refresh remains diagnosable even though the user sees one warning'
    )
  } finally {
    await provider.shutdown()
  }
})

test('forced refresh preserves the spool-to-cache error', async () => {
  const storage = failingStorage()
  await assert.rejects(
    () => settlePendingCacheForQuery({
      partitions: [{ tablePath: '/cache/a' }],
      storage: /** @type {any} */ (storage),
      refresh: 'always',
      messages: [],
    }),
    new RegExp(PARTITION_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  )
})

test('a storage service missing the spool methods fails instead of degrading forever', async () => {
  /** @type {string[]} */
  const messages = []
  await assert.rejects(
    () => settlePendingCacheForQuery({
      partitions: [{ tablePath: '/cache/a' }],
      storage: /** @type {any} */ ({
        cacheRoot: '/tmp/hypaware-query-refresh-test',
        pendingInfo: async () => ({ pending: true, pendingBytes: 1, lastFlushAtMs: null }),
      }),
      refresh: 'auto',
      messages,
    }),
    TypeError
  )
  assert.deepEqual(messages, [], 'a miswired storage service never reads as a stale cache')
})
