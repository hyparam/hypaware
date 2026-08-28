// @ts-check

/**
 * The bound on the usage index the Claude telemetry listener carries between
 * OTLP batches, across the one path that puts entries back into it: a dataset
 * write that failed, whose batch the exporter will retry.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  USAGE_INDEX_LIMIT,
  projectClaudeTelemetryEvents,
  restoreUnclaimedUsage,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/projection.js'

/**
 * @param {string} requestId
 * @param {number} tokens
 */
function apiRequest(requestId, tokens) {
  return {
    name: 'api_request',
    timestamp: '2026-08-17T19:30:31.009Z',
    attributes: {
      'session.id': 'b0ad4f6a-49a3-4d64-9b48-2b0b6c0f3f11',
      request_id: requestId,
      model: 'claude-haiku-4-5-20251001',
      input_tokens: tokens,
      output_tokens: tokens,
      cost_usd: 0.001,
      duration_ms: 12,
    },
  }
}

test('the restore puts back what a failed batch claimed', () => {
  const index = new Map([['req_a', { input_tokens: 7 }], ['req_b', { input_tokens: 9 }]])
  const snapshot = new Map(index)
  // Projection claimed one and the write failed, so nothing carried it.
  index.delete('req_a')
  // The same batch also remembered a request whose response has not arrived.
  index.set('req_c', { input_tokens: 11 })

  restoreUnclaimedUsage(index, snapshot)

  assert.deepEqual(index.get('req_a'), { input_tokens: 7 }, 'the claimed entry comes back')
  assert.deepEqual(index.get('req_b'), { input_tokens: 9 }, 'an unclaimed entry is untouched')
  assert.deepEqual(index.get('req_c'), { input_tokens: 11 }, 'a newly remembered entry survives')
})

// A snapshot taken before projection holds the entries the cap evicted DURING
// projection, and those keys are absent from the live index for the same
// reason a claimed one is. Restoring them unchecked reopens the cap: during a
// sustained dataset outage nothing is ever claimed, so nothing ever shrinks
// the index, and every failed batch would add its `api_request` entries on top
// of a map that can no longer trim itself.
test('a sustained write outage cannot grow the usage index past its cap', () => {
  const index = new Map()
  const batch = 64
  for (let round = 0; round < 40; round += 1) {
    const events = []
    for (let i = 0; i < batch; i += 1) {
      events.push(apiRequest(`req_${round}_${i}`, i))
    }
    const snapshot = new Map(index)
    projectClaudeTelemetryEvents(/** @type {any} */ (events), {
      clientName: 'claude',
      usageByRequestId: index,
    })
    // Every write in this window throws, so every batch takes the restore arm.
    restoreUnclaimedUsage(index, snapshot)
    assert.ok(
      index.size <= USAGE_INDEX_LIMIT,
      `round ${round} left the index at ${index.size}, over the ${USAGE_INDEX_LIMIT} cap`
    )
  }
  assert.equal(index.size, USAGE_INDEX_LIMIT, 'the outage settles at the cap, not above it')
})
