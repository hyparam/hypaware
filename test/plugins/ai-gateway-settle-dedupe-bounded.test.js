// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { aiGatewayDatasetRegistration } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'

// The flush-time settle dedupe used to materialize EVERY committed
// part_id into one Set on each fallback-carrying flush (millions of
// entries per tick on a mature cache, a main driver of daemon GC
// thrash). The scan is now restricted to the part_ids in the batch and
// stops as soon as they are all resolved. These tests pin both halves:
// the early exit, and the unchanged drop/keep correctness.

/** @param {{ part_id: string, message_id: string, part_index: number }} ids */
function fallbackRow(ids) {
  return {
    ...ids,
    role: 'assistant',
    session_id: 'sess-bounded',
    conversation_id: null,
    client_name: 'claude',
    content_text: 'body',
    attributes: { gateway: { identity_source: 'gateway_fallback' } },
  }
}

/**
 * Storage stub whose committed stream counts how many rows the settle
 * pass actually consumes.
 *
 * @param {Array<{ part_id: string, message_id: string, part_index: number }>} committed
 */
function countingStorage(committed) {
  const counter = { consumed: 0 }
  const storage = {
    async discoverCachePartitions() {
      return [{ dataset: 'ai_gateway_messages', partition: {}, path: '/p', epoch: 0, rowCount: committed.length }]
    },
    async *readRows() {
      for (const row of committed) {
        counter.consumed++
        yield row
      }
    },
  }
  return { storage, counter }
}

test('settle dedupe stops reading once every batch part_id is resolved', async () => {
  const committed = [{ part_id: 'dup#0', message_id: 'dup', part_index: 0 }]
  for (let i = 0; i < 10_000; i++) {
    committed.push({ part_id: `other-${i}#0`, message_id: `other-${i}`, part_index: 0 })
  }
  const { storage, counter } = countingStorage(committed)
  const registration = /** @type {any} */ (aiGatewayDatasetRegistration(createGatewayState()))

  const out = await registration.settleBatch(
    [fallbackRow({ part_id: 'dup#0', message_id: 'dup', part_index: 0 })],
    /** @type {any} */ ({ storage })
  )

  assert.equal(out.length, 0, 'the committed twin still drops the in-flight duplicate')
  assert.equal(counter.consumed, 1, 'the scan stops at the first (and only) batch key, not the whole table')
})

test('settle dedupe still keeps a row whose part_id is nowhere committed', async () => {
  const committed = []
  for (let i = 0; i < 100; i++) {
    committed.push({ part_id: `other-${i}#0`, message_id: `other-${i}`, part_index: 0 })
  }
  const { storage, counter } = countingStorage(committed)
  const registration = /** @type {any} */ (aiGatewayDatasetRegistration(createGatewayState()))

  const out = await registration.settleBatch(
    [fallbackRow({ part_id: 'fresh#0', message_id: 'fresh', part_index: 0 })],
    /** @type {any} */ ({ storage })
  )

  assert.equal(out.length, 1, 'an uncommitted row passes through')
  assert.equal(out[0].part_id, 'fresh#0')
  assert.equal(counter.consumed, 100, 'an unresolved key scans the full stream (correctness over early exit)')
})
