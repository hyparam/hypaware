// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { aiGatewayBackfillMaterializer, aiGatewayDatasetRegistration } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { projectedExchangeFromEntries } from '../../hypaware-core/plugins-workspace/claude/src/backfill.js'
import { createClaudeSettlementEnricher } from '../../hypaware-core/plugins-workspace/claude/src/settle.js'
import { projectClaudeTelemetryEvents } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/projection.js'
import { findTranscriptMatch, indexTranscriptEntries, transcriptEntryFromRow } from '../../hypaware-core/plugins-workspace/claude/src/transcripts.js'

const SESSION = '11111111-2222-4333-8444-555555555555'
const TEXT_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const TOOL_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const ANSWER = 'Listing the tree now.'
const TOOL = { type: 'tool_use', id: 'toolu_repro', name: 'Bash', input: { command: 'ls' } }

/** @param {string} uuid @param {unknown} block */
function native(uuid, block) {
  return {
    type: 'assistant', sessionId: SESSION, uuid, requestId: 'req_repro',
    timestamp: '2026-10-25T10:00:00.000Z', cwd: '/tmp', agentId: 'native-agent', isSidechain: true,
    message: { id: 'msg_repro', role: 'assistant', content: [block], usage: { input_tokens: 12, output_tokens: 34 } },
  }
}

const TEXT = native(TEXT_UUID, { type: 'text', text: ANSWER })
const CALL = native(TOOL_UUID, TOOL)
/** @param {unknown[]} rows */
const parse = rows => rows.map(transcriptEntryFromRow).filter(entry => entry !== undefined)

/** @param {ReturnType<typeof parse>} entries */
function stage(entries) {
  /** @type {Record<string, any>[]} */
  const committed = []
  const storage = {
    async discoverCachePartitions() { return [{ path: '/fixture', rowCount: committed.length }] },
    async *readRows() { yield* committed },
    /** @param {string} _path @param {string[]} _columns @param {Record<string, unknown[]>} where */
    async *readRowsWhere(_path, _columns, where) {
      for (const row of committed) {
        if (Object.entries(where).every(([key, values]) => values.includes(row[key]))) yield row
      }
    },
  }
  const state = createGatewayState()
  createAiGatewayApi(state).registerSettlementEnricher(createClaudeSettlementEnricher({
    homeDir: '/tmp/claude-duplication-unused', stateFile: '/tmp/claude-duplication-unused/context.jsonl',
    transcriptLoader: /** @type {any} */ ({ load: async () => entries }),
  }))
  const registration = aiGatewayDatasetRegistration(state)
  return {
    committed,
    storage,
    /** @param {Record<string, unknown>[]} rows */
    async flush(rows) {
      const settled = await registration.settleBatch?.(rows, /** @type {any} */ ({ storage }))
      committed.push(.../** @type {Record<string, any>[]} */ (settled ?? rows))
    },
    /** @param {ReturnType<typeof parse>} current */
    async backfill(current) {
      const value = await projectedExchangeFromEntries({
        sessionId: SESSION, entries: current, clientName: 'claude', record: undefined,
        agentMeta: new Map(), deriveRepo: async () => ({}),
      })
      assert.ok(value)
      return aiGatewayBackfillMaterializer().materialize(
        { kind: 'ai_gateway.projected_exchange', dataset: 'ai_gateway_messages', value: /** @type {any} */ (value) }, /** @type {any} */ ({ storage, runToken: {} }),
      )
    },
  }
}

/** @param {Record<string, any>[]} rows */
const outputTokens = rows => rows.reduce((n, row) => n + (row.attributes?.usage?.output_tokens ?? 0), 0)

test('request-history snapshots neither project nor replace native identity lookups', async () => {
  const entries = parse([CALL, {
    type: 'api-request-blob', sessionId: SESSION, agentId: 'native-agent',
    message: { role: 'assistant', content: [TOOL] },
  }])
  const index = indexTranscriptEntries(entries)
  const match = findTranscriptMatch(index, { role: 'assistant', content: [TOOL], agentId: 'native-agent' })
  assert.equal(match?.provider_uuid, TOOL_UUID)
  assert.equal(index.byToolCallId.get(TOOL.id)?.provider_uuid, TOOL_UUID)
  const env = stage(entries)
  const rows = await env.backfill(entries)
  assert.equal(rows.length, 1)
})

for (const liveFirst of [true, false]) {
  test(`an assistant event naming the tool UUID preserves text and tool, liveFirst=${liveFirst}`, async () => {
    const entries = parse([TEXT, CALL])
    const env = stage(entries)
    const projection = projectClaudeTelemetryEvents([{
      name: 'api_request', attributes: { 'session.id': SESSION, request_id: 'req_repro', output_tokens: 34, input_tokens: 12, cost_usd: 0.1 },
    }, {
      name: 'assistant_response', timestamp: '2026-10-25T10:00:00.000Z',
      attributes: { 'session.id': SESSION, 'message.uuid': TOOL_UUID, request_id: 'req_repro', response: ANSWER, 'agent.name': 'general-purpose' },
    }], { clientName: 'claude', usageByRequestId: new Map() })[0]
    const live = aiGatewayRowsFromProjectedExchange(projection)
    if (liveFirst) await env.flush(live)
    await env.flush(await env.backfill(entries))
    if (!liveFirst) await env.flush(live)
    assert.deepEqual(env.committed.map(row => [row.part_type, row.part_id]).sort(), [
      ['text', `${TEXT_UUID}#0`], ['tool_call', `${TOOL_UUID}#0`],
    ])
    assert.equal(env.committed[0].agent_id, 'native-agent')
    assert.equal(outputTokens(env.committed), 34)
  })
}

test('two committed partial transcript reads retain one response usage carrier', async () => {
  const entries = parse([TEXT, CALL])
  const env = stage(entries)
  await env.flush(await env.backfill(entries.slice(0, 1)))
  await env.flush(await env.backfill(entries))
  assert.equal(env.committed.length, 2)
  assert.equal(new Set(env.committed.map(row => row.part_id)).size, 2)
  assert.equal(outputTokens(env.committed), 34)
})

test('partial transcript rows in one flush retain one response usage carrier', async () => {
  const entries = parse([TEXT, CALL])
  const env = stage(entries)
  const partial = await env.backfill(entries.slice(0, 1))
  const full = await env.backfill(entries)
  await env.flush([...partial, ...full])
  assert.equal(outputTokens(env.committed), 34)
})

test('late transcript arrival resolves provisional text before commit', async () => {
  const entries = parse([])
  const env = stage(entries)
  const [projection] = projectClaudeTelemetryEvents([{
    name: 'assistant_response', attributes: { 'session.id': SESSION, 'message.uuid': TOOL_UUID, request_id: 'req_repro', response: ANSWER },
  }], { clientName: 'claude', usageByRequestId: new Map() })
  const rows = aiGatewayRowsFromProjectedExchange(projection)
  assert.notEqual(rows[0].part_id, `${TOOL_UUID}#0`)
  entries.push(...parse([TEXT, CALL]))
  await env.flush(rows)
  assert.equal(env.committed[0].part_id, `${TEXT_UUID}#0`)
})

test('a mismatched request or ambiguous text never adopts an unrelated native uuid', async () => {
  for (const entries of [
    parse([{ ...TEXT, requestId: 'other-request' }, { ...CALL, requestId: 'other-request' }]),
    parse([TEXT, native('second-text', { type: 'text', text: ANSWER }), CALL]),
  ]) {
    const env = stage(entries)
    const [projection] = projectClaudeTelemetryEvents([{
      name: 'assistant_response', attributes: { 'session.id': SESSION, 'message.uuid': TOOL_UUID, request_id: 'req_repro', response: ANSWER },
    }], { clientName: 'claude', usageByRequestId: new Map() })
    await env.flush(aiGatewayRowsFromProjectedExchange(projection))
    assert.notEqual(env.committed[0].part_id, `${TEXT_UUID}#0`)
    assert.equal(env.committed[0].attributes.gateway.identity_source, 'gateway_fallback')
  }
})

test('equal response text in different requests has distinct provisional identity', () => {
  const [projection] = projectClaudeTelemetryEvents(['request-a', 'request-b'].map(request_id => ({
    name: 'assistant_response', attributes: { 'session.id': SESSION, 'message.uuid': TOOL_UUID, request_id, response: ANSWER },
  })), { clientName: 'claude', usageByRequestId: new Map() })
  const rows = aiGatewayRowsFromProjectedExchange(projection)
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].part_id, rows[1].part_id)
})

test('usage ownership is isolated by response and session, including JSON-encoded columns', async () => {
  const entries = parse([TEXT, CALL])
  const env = stage(entries)
  await env.flush(await env.backfill(entries.slice(0, 1)))
  env.committed[0].attributes = JSON.stringify(env.committed[0].attributes)
  env.committed[0].raw_frame = JSON.stringify(env.committed[0].raw_frame)
  const other = native('other-response', { type: 'text', text: ANSWER })
  other.requestId = 'other-request'
  other.message.id = 'other-api-message'
  await env.flush(await env.backfill(parse([other])))
  const [tail] = await env.backfill(entries)
  tail.attributes = { .../** @type {any} */ (tail.attributes), claude: { cost_usd: 0.1 } }
  await env.flush([tail])
  assert.equal(/** @type {any} */ (tail.attributes).usage.output_tokens, 34, 'settlement does not mutate its input')
  const { usage: _usage, ...expected } = /** @type {any} */ (tail.attributes)
  assert.deepEqual(env.committed[2].attributes, expected)
  env.committed[0].attributes = JSON.parse(env.committed[0].attributes)
  assert.equal(outputTokens(env.committed), 68)
  await env.flush([{ ...env.committed[1], session_id: 'another-session' }])
  assert.equal(outputTokens(env.committed), 102)
})

test('an unreadable committed usage scan refuses the flush rather than counting again', async () => {
  const entries = parse([TEXT, CALL])
  const env = stage(entries)
  const first = await env.backfill(entries.slice(0, 1))
  env.storage.readRowsWhere = async function* () { throw new Error('scoped scan unavailable') }
  env.storage.readRows = async function* () { throw new Error('usage scan unavailable') }
  env.storage.discoverCachePartitions = async () => [{ path: '/fixture', rowCount: 1 }]
  await assert.rejects(env.flush(first), /usage scan unavailable/)
  assert.equal(env.committed.length, 0)
})

test('a partition that rejects the scoped usage scan is read in full, not skipped', async () => {
  const entries = parse([TEXT, CALL])
  const env = stage(entries)
  await env.flush(await env.backfill(entries.slice(0, 1)))
  env.storage.readRowsWhere = async function* () { throw new Error('no session_id column') }
  await env.flush(await env.backfill(entries))
  assert.equal(outputTokens(env.committed), 34)
})

test('a request ID resolves assistant text when the event uuid is absent from the transcript', async () => {
  const env = stage(parse([TEXT, CALL]))
  const [projection] = projectClaudeTelemetryEvents([{
    name: 'assistant_response', attributes: { 'session.id': SESSION, 'message.uuid': 'unavailable-anchor', request_id: 'req_repro', response: ANSWER },
  }], { clientName: 'claude', usageByRequestId: new Map() })
  await env.flush(aiGatewayRowsFromProjectedExchange(projection))
  assert.equal(env.committed[0].part_id, `${TEXT_UUID}#0`)
})

test('unrelated clients and usage-free batches perform no accounting storage reads', async () => {
  const env = stage([])
  env.storage.discoverCachePartitions = async () => { throw new Error('unexpected storage read') }
  const base = { cwd: '/tmp', role: 'assistant', provider: 'anthropic', session_id: SESSION, request_id: 'req', attributes: { usage: { output_tokens: 34 } } }
  await env.flush([{ ...base, client_name: 'hermes' }, { ...base, client_name: 'claude', attributes: {} }])
  assert.equal(env.committed.length, 2)
})

test('maintenance does not rewrite historical usage counters', async () => {
  const rows = [{ role: 'assistant', client_name: 'claude', provider: 'anthropic', attributes: { usage: { output_tokens: 34 } } }]
  const registration = aiGatewayDatasetRegistration(createGatewayState())
  assert.equal(await registration.resettleBatch?.(rows, /** @type {any} */ ({})), rows)
})
