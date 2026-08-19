// @ts-check

/**
 * Per-event attribution on the Claude telemetry path.
 *
 * A Task subagent runs under its parent's `session.id`, so one exporter
 * flush can mix the main loop's events with a subagent's. `agent.name`
 * and `query_source` ride the individual event, not the session, and the
 * projection has to leave them there: hoisted to the exchange they stamp
 * every row of the batch, which relabels main-loop rows as sidechain and
 * moves the fallback-identity scope of any body-derived block that shares
 * the batch.
 *
 * @ref LLP 0262#field-parity-r1 [tests]: `is_sidechain` / `agent_id` are read
 *   from `query_source` / `agent.name`, both per-event attributes
 * @ref LLP 0252#projection-unchanged [tests]: batch composition is an artifact
 *   of the exporter's flush timer, so it must not reach a row's identity
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { projectClaudeTelemetryEvents } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/projection.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'

const SESSION = 'e53c128d-9f45-470f-86f1-d5b5f3766708'
const REQUEST_ID = 'req_011Ce8sjpb8Uzvot2JMvFkKe'
const SUB_REQUEST_ID = 'req_011SubAgentTurnZzzz'
const USER_UUID = 'u-main-prompt'
const ASSISTANT_UUID = 'u-main-response'
const SUBAGENT_UUID = 'u-subagent-response'
const REQUEST_BODY_REF = '/spool/mixed.request.json'

/**
 * @param {string} name
 * @param {Record<string, unknown>} attrs
 * @param {string} [timestamp]
 */
function evt(name, attrs, timestamp = '2026-08-19T10:00:00.000Z') {
  return { name, attributes: { 'session.id': SESSION, 'app.version': '2.1.233', ...attrs }, timestamp }
}

/**
 * A request body whose history holds the two block kinds events never
 * carry: an untruncated `tool_use` and its `tool_result`. Neither has a
 * native uuid, so both take the gateway's content-hash identity.
 */
function requestBody() {
  return {
    model: 'claude-haiku-4-5-20251001',
    system: [{ type: 'text', text: 'You are a coding agent.' }],
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/notes.txt' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'notes: spike findings' }],
      },
    ],
  }
}

function spooledBodies() {
  return new Map([
    [REQUEST_BODY_REF, /** @type {any} */ ({ kind: 'request', file: REQUEST_BODY_REF, body: requestBody() })],
  ])
}

/** The main loop's own events: a prompt, a request body, a usage record, a response. */
function mainLoopEvents() {
  return [
    evt('user_prompt', { prompt: 'Review the projection.', 'message.uuid': USER_UUID }, '2026-08-19T10:00:00.000Z'),
    evt('api_request_body', { body_ref: REQUEST_BODY_REF, request_id: REQUEST_ID }, '2026-08-19T10:00:01.000Z'),
    evt('api_request', { request_id: REQUEST_ID, output_tokens: 11, query_source: 'user' }, '2026-08-19T10:00:02.000Z'),
    evt('assistant_response', {
      response: 'Reviewed.',
      request_id: REQUEST_ID,
      'message.uuid': ASSISTANT_UUID,
      query_source: 'user',
    }, '2026-08-19T10:00:03.000Z'),
  ]
}

/**
 * The Task subagent's response. It shares the parent's `session.id` and
 * names itself with `agent.name`.
 */
function subagentEvent() {
  return evt('assistant_response', {
    response: 'Subagent finished.',
    request_id: SUB_REQUEST_ID,
    'message.uuid': SUBAGENT_UUID,
    'agent.name': 'general-purpose',
    query_source: 'agent',
  }, '2026-08-19T10:00:02.500Z')
}

/** @param {Array<ReturnType<typeof evt>>} events */
function rowsFor(events) {
  const [projection] = projectClaudeTelemetryEvents(events, {
    clientName: 'claude',
    usageByRequestId: new Map(),
    spooledBodies: spooledBodies(),
  })
  return { projection, rows: aiGatewayRowsFromProjectedExchange(projection) }
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} messageId
 */
function rowFor(rows, messageId) {
  const row = rows.find((r) => r.message_id === messageId)
  assert.ok(row, `expected a row for ${messageId}`)
  return row
}

test('a subagent event in the batch does not relabel the main loop\'s rows', () => {
  const { projection, rows } = rowsFor([...mainLoopEvents(), subagentEvent()])

  // The subagent's identity belongs to its own message, not to the
  // exchange every row of the batch inherits.
  assert.equal(projection.agent_id, undefined)
  assert.equal(projection.is_sidechain, undefined)

  for (const messageId of [USER_UUID, ASSISTANT_UUID]) {
    const row = rowFor(rows, messageId)
    assert.equal(row.agent_id, undefined)
    assert.equal(row.is_sidechain, undefined)
  }

  const subagent = rowFor(rows, SUBAGENT_UUID)
  assert.equal(subagent.agent_id, 'general-purpose')
  assert.equal(subagent.is_sidechain, true)
})

test('a body-derived block keeps its identity whether or not a subagent shares the batch', () => {
  const alone = rowsFor(mainLoopEvents()).rows
  const mixed = rowsFor([...mainLoopEvents(), subagentEvent()]).rows

  const findToolResult = (/** @type {Record<string, unknown>[]} */ rows) => {
    const row = rows.find((r) => r.tool_result_for === 'toolu_1')
    assert.ok(row, 'expected the body-derived tool_result row')
    return row
  }
  const findToolCall = (/** @type {Record<string, unknown>[]} */ rows) => {
    const row = rows.find((r) => r.part_type === 'tool_call')
    assert.ok(row, 'expected the body-derived tool_use row')
    return row
  }

  // These blocks have no native uuid: their id is a content hash scoped by
  // `(thread, agent_id)`. Batch composition must not move that scope, or the
  // part_id dedupe misses and the same block is stored twice.
  assert.equal(findToolResult(mixed).message_id, findToolResult(alone).message_id)
  assert.equal(findToolResult(mixed).part_id, findToolResult(alone).part_id)
  assert.equal(findToolCall(mixed).message_id, findToolCall(alone).message_id)
  assert.equal(findToolCall(mixed).part_id, findToolCall(alone).part_id)

  // And the body-derived blocks are the main loop's, not the subagent's.
  assert.equal(findToolResult(mixed).agent_id, undefined)
  assert.equal(findToolResult(mixed).is_sidechain, undefined)
})

test('query_source follows the event that carries it, whatever the batch order', () => {
  const subagentFirst = rowsFor([subagentEvent(), ...mainLoopEvents()]).rows
  const subagentLast = rowsFor([...mainLoopEvents(), subagentEvent()]).rows

  for (const rows of [subagentFirst, subagentLast]) {
    const query = (/** @type {Record<string, unknown>} */ row) =>
      /** @type {any} */ (row.attributes)?.claude?.query_source
    assert.equal(query(rowFor(rows, ASSISTANT_UUID)), 'user')
    assert.equal(query(rowFor(rows, SUBAGENT_UUID)), 'agent')
    // The prompt event carries no `query_source` of its own, so it keeps the
    // session's main-loop value rather than borrowing the subagent's.
    assert.equal(query(rowFor(rows, USER_UUID)), 'user')
  }
})
