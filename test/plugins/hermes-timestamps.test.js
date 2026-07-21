// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { projectHermesSession } from '../../hypaware-core/plugins-workspace/hermes/src/projector.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'

/**
 * @import { HermesMessageRow, HermesSessionRow } from '../../hypaware-core/plugins-workspace/hermes/src/types.js'
 */

/**
 * Regression for issue #349: hermes rows carried projection-time timestamps
 * instead of hermes's own stored message times.
 *
 * Hermes persists `messages.timestamp` and `sessions.started_at`/`ended_at`
 * as epoch-seconds REAL (a float with fractional milliseconds), which
 * `node:sqlite` surfaces as a JS number. The projector used to pass those
 * numbers through raw, and the shared materializer keeps only STRING
 * `message_created_at` / `conversation_started_at` values
 * (`stringValue(...) ?? tsStart`), so every numeric hermes time was silently
 * dropped and each row fell back to `tsStart` (the projection's wall clock).
 *
 * This test drives the real seam end to end: project a session whose stored
 * times are KNOWN epoch-second floats, materialize with a `tsStart` distinct
 * from every stored time, and assert the cached rows carry hermes's converted
 * ISO-8601 times, NOT the projection wall clock.
 *
 * @ref LLP 0122#projection [tests]: the timestamp column mapping.
 */

// The projection's wall-clock start: distinct from every stored hermes time.
// This is exactly the value the buggy fallback stamped onto every row.
const PROJECTION_TS_START = '2026-07-21T13:19:05.452Z'

// Ground-truth hermes stored times (ISO). Hermes persists these as
// epoch-seconds REAL; `epochSeconds` simulates that storage exactly.
const USER_MSG_ISO = '2026-01-21T20:19:02.441Z'
const ASSISTANT_MSG_ISO = '2026-01-21T20:19:07.952Z'
const SESSION_STARTED_ISO = '2026-01-21T20:19:02.424Z'
const SESSION_ENDED_ISO = '2026-01-21T20:20:05.000Z'

/**
 * Simulate hermes's on-disk storage: an ISO instant as an epoch-seconds float
 * (fractional millis preserved), the exact shape `node:sqlite` yields for a
 * REAL column.
 *
 * @param {string} iso
 * @returns {number}
 */
function epochSeconds(iso) {
  return Date.parse(iso) / 1000
}

/** @returns {HermesSessionRow} */
function fixtureSession() {
  return /** @type {any} */ ({
    id: 1,
    source: 'cli',
    model: 'gpt-4o',
    // NULL cwd: no usage-policy scope to resolve and no repo enrichment, so the
    // default resolver/deriveRepo are never consulted and the test needs no
    // filesystem doubles.
    cwd: null,
    parent_session_id: null,
    started_at: epochSeconds(SESSION_STARTED_ISO),
    ended_at: epochSeconds(SESSION_ENDED_ISO),
    end_reason: 'completed',
    billing_provider: 'openai',
    billing_base_url: 'https://api.openai.com/v1',
    system_prompt: null,
    input_tokens: 120,
    output_tokens: 80,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    api_call_count: 2,
  })
}

/** @returns {HermesMessageRow[]} */
function fixtureMessages() {
  return /** @type {any} */ ([
    {
      id: 1, session_id: 1, role: 'user', content: 'why is the sky blue',
      tool_calls: null, tool_name: null, tool_call_id: null, reasoning: null,
      timestamp: epochSeconds(USER_MSG_ISO), token_count: null, finish_reason: null,
    },
    {
      id: 2, session_id: 1, role: 'assistant', content: 'Rayleigh scattering.',
      tool_calls: null, tool_name: null, tool_call_id: null, reasoning: null,
      timestamp: epochSeconds(ASSISTANT_MSG_ISO), token_count: 200, finish_reason: 'stop',
    },
  ])
}

/**
 * Project the fixture session and materialize it into cache rows with a
 * wall-clock `tsStart` distinct from every stored hermes time.
 *
 * @returns {Promise<{ rows: Record<string, unknown>[] }>}
 */
async function projectAndMaterialize() {
  const item = await projectHermesSession({
    session: fixtureSession(),
    messages: fixtureMessages(),
  })
  assert.ok(item, 'session with messages must project')
  const exchange = /** @type {any} */ (item).value
  const rows = aiGatewayRowsFromProjectedExchange(exchange, { tsStart: PROJECTION_TS_START })
  return { rows }
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} messageId
 * @returns {Record<string, unknown>}
 */
function rowById(rows, messageId) {
  const row = rows.find((r) => r.message_id === messageId)
  assert.ok(row, `expected a cached row with message_id ${messageId}`)
  return row
}

test('cached hermes rows carry stored message times, not the projection wall clock', async () => {
  const { rows } = await projectAndMaterialize()

  const userRow = rowById(rows, 'hermes-1-1-0')
  const assistantRow = rowById(rows, 'hermes-1-2-0')
  const endRow = rowById(rows, 'hermes-1-session_end')

  // message_created_at is hermes's stored per-message time, converted to ISO.
  assert.equal(userRow.message_created_at, USER_MSG_ISO)
  assert.equal(assistantRow.message_created_at, ASSISTANT_MSG_ISO)
  // The synthetic session-end part's time is `sessions.ended_at`, converted.
  assert.equal(endRow.message_created_at, SESSION_ENDED_ISO)

  // conversation_started_at is `sessions.started_at`, converted, on every row.
  for (const row of rows) {
    assert.equal(row.conversation_started_at, SESSION_STARTED_ISO)
  }

  // None of the timestamps may be the projection wall clock (the old bug).
  for (const row of rows) {
    assert.notEqual(row.message_created_at, PROJECTION_TS_START)
    assert.notEqual(row.conversation_started_at, PROJECTION_TS_START)
  }
})

test('re-projecting the same session yields byte-identical timestamps (dedupe-safe)', async () => {
  const first = await projectAndMaterialize()
  const second = await projectAndMaterialize()

  const stamp = (/** @type {Record<string, unknown>[]} */ rows) =>
    rows.map((r) => ({
      message_id: r.message_id,
      message_created_at: r.message_created_at,
      conversation_started_at: r.conversation_started_at,
    }))

  assert.deepEqual(stamp(first.rows), stamp(second.rows))
})
