// @ts-check

/**
 * The body half of the Claude telemetry listener: reading spooled body
 * files, refusing refs that point outside the spool, and joining a
 * body's gap blocks (untruncated tool args, thinking signatures, tool
 * results) into the projection the events alone cannot complete.
 *
 * @ref LLP 0257#testing [tests]: event-plus-body projection identity is unit
 *   tested in the root suite; the end-to-end seam is the hermetic smoke
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BODY_EVENT_NAMES,
  deleteSpooledBodies,
  loadSpooledBodies,
  requestBodyFacts,
  spooledBodyGapMessages,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/bodies.js'
import {
  SESSION_BODY_FACTS_LIMIT,
  projectClaudeTelemetryEvents,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/projection.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'

const SESSION = 'e53c128d-9f45-470f-86f1-d5b5f3766708'
const REQUEST_ID = 'req_011Ce8sjpb8Uzvot2JMvFkKe'
const LONG_ARG = 'x'.repeat(600)

/**
 * @param {string} name
 * @param {Record<string, unknown>} attrs
 * @param {string} [timestamp]
 */
function evt(name, attrs, timestamp = '2026-08-17T19:30:24.450Z') {
  return { name, attributes: { 'session.id': SESSION, ...attrs }, timestamp }
}

function requestBody() {
  return {
    model: 'claude-haiku-4-5-20251001',
    system: [{ type: 'text', text: 'You are a coding agent.' }],
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'Run ls, then read notes.txt.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading it now.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/notes.txt', pad: LONG_ARG } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'notes: spike findings' }],
      },
    ],
  }
}

/** @param {boolean} withText */
function responseBody(withText) {
  return {
    id: 'msg_smoke',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [
      { type: 'thinking', thinking: 'It is a spike repo.', signature: 'sig-abc' },
      ...(withText ? [{ type: 'text', text: 'This is a spike repo.' }] : []),
    ],
    stop_reason: withText ? 'end_turn' : 'tool_use',
    usage: { input_tokens: 73, output_tokens: 113 },
  }
}

async function tmpSpool() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-bodies-'))
  return path.join(root, 'spool', 'claude-bodies')
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {unknown} body
 */
async function writeBody(dir, name, body) {
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fsp.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}

test('loadSpooledBodies reads the request and response files a batch references', async () => {
  const dir = await tmpSpool()
  const reqFile = await writeBody(dir, 'a.request.json', requestBody())
  const respFile = await writeBody(dir, 'a.response.json', responseBody(true))
  const events = [
    evt('api_request_body', { body_ref: reqFile, request_id: REQUEST_ID }),
    evt('api_response_body', { body_ref: respFile, request_id: REQUEST_ID }),
  ]
  const spooled = await loadSpooledBodies(events, { spoolDir: dir })
  assert.equal(spooled.bodies.size, 2)
  assert.equal(spooled.bodies.get(reqFile)?.kind, 'request')
  assert.equal(spooled.bodies.get(respFile)?.kind, 'response')
  assert.deepEqual(spooled.consumedFiles.sort(), [reqFile, respFile].sort())
  assert.ok(spooled.consumedBytes > 0)
  assert.equal(spooled.missing, 0)
  assert.equal(spooled.unparseable, 0)
  assert.deepEqual(spooled.refused, [])
})

test('a body_ref outside the spool is refused and its file is left alone', async () => {
  const dir = await tmpSpool()
  await fsp.mkdir(dir, { recursive: true })
  // A sibling of the spool: contained refs must be under the spool root,
  // not merely share its prefix.
  const outside = await writeBody(path.dirname(dir), 'secret.json', { private: true })
  const traversal = path.join(dir, '..', 'secret.json')
  const spooled = await loadSpooledBodies(
    [
      evt('api_request_body', { body_ref: outside }),
      evt('api_request_body', { body_ref: traversal }),
    ],
    { spoolDir: dir }
  )
  assert.equal(spooled.bodies.size, 0)
  assert.equal(spooled.refused.length, 2)
  // Refused means untouched: never read, never deleted.
  assert.deepEqual(JSON.parse(await fsp.readFile(outside, 'utf8')), { private: true })
})

test('a missing body file counts as missing, not as an error', async () => {
  const dir = await tmpSpool()
  await fsp.mkdir(dir, { recursive: true })
  const spooled = await loadSpooledBodies(
    [evt('api_request_body', { body_ref: path.join(dir, 'evicted.json') })],
    { spoolDir: dir }
  )
  assert.equal(spooled.bodies.size, 0)
  assert.equal(spooled.missing, 1)
})

test('an unparseable body is deleted immediately and counted', async () => {
  const dir = await tmpSpool()
  const file = await writeBody(dir, 'broken.json', 'not json {')
  const spooled = await loadSpooledBodies(
    [evt('api_request_body', { body_ref: file })],
    { spoolDir: dir }
  )
  assert.equal(spooled.bodies.size, 0)
  assert.equal(spooled.unparseable, 1)
  await assert.rejects(fsp.stat(file))
})

test('deleteSpooledBodies removes projected files and tolerates absence', async () => {
  const dir = await tmpSpool()
  const file = await writeBody(dir, 'done.json', {})
  const deleted = await deleteSpooledBodies([file, path.join(dir, 'never-existed.json')])
  assert.equal(deleted, 2)
  await assert.rejects(fsp.stat(file))
})

test('requestBodyFacts pulls system, tools, and model from a request body only', () => {
  const facts = requestBodyFacts({ kind: 'request', file: '/s/a.json', body: requestBody() })
  assert.equal(facts.system_text, 'You are a coding agent.')
  assert.equal(facts.model, 'claude-haiku-4-5-20251001')
  assert.equal(/** @type {any} */ (facts.tools)?.[0]?.name, 'Read')
  assert.deepEqual(
    requestBodyFacts({ kind: 'response', file: '/s/b.json', body: responseBody(true) }),
    {}
  )
})

test('body gap blocks join the projection in body order, untruncated', () => {
  const reqFile = '/spool/a.request.json'
  const respFile = '/spool/a.response.json'
  const events = [
    evt('user_prompt', { prompt: 'Run ls, then read notes.txt.', 'message.uuid': 'u-user' }),
    evt('api_request_body', { body_ref: reqFile, request_id: REQUEST_ID }, '2026-08-17T19:30:26.000Z'),
    evt('api_request', { request_id: REQUEST_ID, output_tokens: 113 }, '2026-08-17T19:30:31.009Z'),
    evt('api_response_body', { body_ref: respFile, request_id: REQUEST_ID }, '2026-08-17T19:30:31.009Z'),
    evt('assistant_response', { response: 'This is a spike repo.', request_id: REQUEST_ID, 'message.uuid': 'u-asst' }, '2026-08-17T19:30:31.009Z'),
  ]
  const spooledBodies = new Map([
    [reqFile, /** @type {any} */ ({ kind: 'request', file: reqFile, body: requestBody() })],
    [respFile, /** @type {any} */ ({ kind: 'response', file: respFile, body: responseBody(true) })],
  ])
  const [projection] = projectClaudeTelemetryEvents(events, {
    clientName: 'claude',
    usageByRequestId: new Map(),
    spooledBodies,
  })

  // Exchange-level: the fields only the request body carries.
  assert.equal(projection.system_text, 'You are a coding agent.')
  assert.equal(/** @type {any} */ (projection.tools)?.[0]?.name, 'Read')
  assert.equal(projection.model, 'claude-haiku-4-5-20251001')

  // Message order follows the stream, with each body's gap blocks at the
  // body event's position: prompt, tool_use, tool_result, thinking, text.
  // The bodies' plain text blocks are NOT re-projected.
  const kinds = projection.messages.map((m) =>
    typeof m.content === 'string' ? 'text' : /** @type {any} */ (m.content[0]).type
  )
  assert.deepEqual(kinds, ['text', 'tool_use', 'tool_result', 'thinking', 'text'])

  const toolUse = /** @type {any} */ (projection.messages[1])
  assert.equal(toolUse.role, 'assistant')
  assert.equal(toolUse.content[0].input.pad, LONG_ARG)
  assert.equal(toolUse.raw_frame?.type, 'api_request_body')
  assert.equal(toolUse.raw_frame?.body_file, 'a.request.json')

  const toolResult = /** @type {any} */ (projection.messages[2])
  assert.equal(toolResult.role, 'user')
  assert.equal(toolResult.content[0].tool_use_id, 'toolu_1')

  const thinking = /** @type {any} */ (projection.messages[3])
  assert.equal(thinking.content[0].signature, 'sig-abc')
  assert.equal(thinking.raw_frame?.type, 'api_response_body')
  assert.equal(thinking.raw_frame?.message_id, 'msg_smoke')

  // The minimized frame carries pointers, never content.
  for (const message of [toolUse, toolResult, thinking]) {
    const frame = JSON.stringify(message.raw_frame)
    assert.ok(!frame.includes(LONG_ARG.slice(0, 32)))
    assert.ok(!frame.includes('spike'))
  }
})

test('a response body with no text block claims the usage its event row never gets', () => {
  const respFile = '/spool/b.response.json'
  const events = [
    evt('api_request', { request_id: REQUEST_ID, output_tokens: 113 }),
    evt('api_response_body', { body_ref: respFile, request_id: REQUEST_ID }),
  ]
  const usage = new Map()
  const [projection] = projectClaudeTelemetryEvents(events, {
    clientName: 'claude',
    usageByRequestId: usage,
    spooledBodies: new Map([
      [respFile, /** @type {any} */ ({ kind: 'response', file: respFile, body: responseBody(false) })],
    ]),
  })
  const [thinking] = /** @type {any[]} */ (projection.messages)
  assert.equal(thinking.stop_reason, 'tool_use')
  assert.equal(thinking.attributes?.usage?.output_tokens, 113)
  // Claimed once, so a later batch cannot double-count it.
  assert.equal(usage.size, 0)
})

test('a response body with a text block leaves usage to the assistant_response event', () => {
  const respFile = '/spool/c.response.json'
  const events = [
    evt('api_request', { request_id: REQUEST_ID, output_tokens: 113 }),
    evt('api_response_body', { body_ref: respFile, request_id: REQUEST_ID }),
    evt('assistant_response', { response: 'This is a spike repo.', request_id: REQUEST_ID, 'message.uuid': 'u-asst' }),
  ]
  const [projection] = projectClaudeTelemetryEvents(events, {
    clientName: 'claude',
    usageByRequestId: new Map(),
    spooledBodies: new Map([
      [respFile, /** @type {any} */ ({ kind: 'response', file: respFile, body: responseBody(true) })],
    ]),
  })
  const thinking = /** @type {any} */ (projection.messages[0])
  const text = /** @type {any} */ (projection.messages[1])
  assert.equal(thinking.attributes?.usage, undefined)
  assert.equal(text.attributes?.usage?.output_tokens, 113)
})

test('body-derived rows expand to the same part ids on replay', () => {
  const reqFile = '/spool/a.request.json'
  const project = () => projectClaudeTelemetryEvents(
    [evt('api_request_body', { body_ref: reqFile, request_id: REQUEST_ID })],
    {
      clientName: 'claude',
      usageByRequestId: new Map(),
      spooledBodies: new Map([
        [reqFile, /** @type {any} */ ({ kind: 'request', file: reqFile, body: requestBody() })],
      ]),
    }
  )
  const first = aiGatewayRowsFromProjectedExchange(project()[0])
  const second = aiGatewayRowsFromProjectedExchange(project()[0])
  assert.ok(first.length > 0)
  assert.deepEqual(first.map((r) => r.part_id), second.map((r) => r.part_id))
})

test('session body facts carry to a later batch of the same session, bounded', () => {
  const reqFile = '/spool/a.request.json'
  const sessionBodyFacts = new Map()
  const spooledBodies = new Map([
    [reqFile, /** @type {any} */ ({ kind: 'request', file: reqFile, body: requestBody() })],
  ])
  projectClaudeTelemetryEvents(
    [evt('api_request_body', { body_ref: reqFile, request_id: REQUEST_ID })],
    { clientName: 'claude', usageByRequestId: new Map(), spooledBodies, sessionBodyFacts }
  )
  // A later batch: same session, no body event at all (the exporter split
  // the turn), still stamps the remembered system prompt and tools.
  const [later] = projectClaudeTelemetryEvents(
    [evt('assistant_response', { response: 'Later turn.', 'message.uuid': 'u-later' })],
    { clientName: 'claude', usageByRequestId: new Map(), sessionBodyFacts }
  )
  assert.equal(later.system_text, 'You are a coding agent.')
  assert.equal(/** @type {any} */ (later.tools)?.[0]?.name, 'Read')

  // The carry-over map is bounded, oldest session evicted first: flood it
  // with fresh sessions and the original session's facts fall out.
  const floodEvents = []
  const floodBodies = new Map()
  for (let i = 0; i < SESSION_BODY_FACTS_LIMIT + 3; i++) {
    const file = `/spool/flood-${i}.request.json`
    floodBodies.set(file, { kind: 'request', file, body: requestBody() })
    floodEvents.push({
      name: 'api_request_body',
      attributes: { 'session.id': `flood-${i}`, body_ref: file },
      timestamp: '2026-08-17T19:31:00.000Z',
    })
  }
  projectClaudeTelemetryEvents(floodEvents, {
    clientName: 'claude',
    usageByRequestId: new Map(),
    spooledBodies: floodBodies,
    sessionBodyFacts,
  })
  assert.equal(sessionBodyFacts.size, SESSION_BODY_FACTS_LIMIT)
  assert.equal(sessionBodyFacts.has(SESSION), false)
  assert.equal(sessionBodyFacts.has(`flood-${SESSION_BODY_FACTS_LIMIT + 2}`), true)
})

test('BODY_EVENT_NAMES names exactly the two body events', () => {
  assert.deepEqual([...BODY_EVENT_NAMES], ['api_request_body', 'api_response_body'])
})
