// @ts-check

/**
 * The Claude telemetry listener's deterministic halves: decoding the
 * OTLP/JSON envelope Claude Code sends, and turning the decoded events
 * into the same projected exchange the proxy and backfill producers
 * yield.
 *
 * The event fixtures below are trimmed from a real capture (Claude Code
 * 2.1.233, the LLP 0245 spike): same attribute names, same value
 * wrappers, same string-typed numerics.
 *
 * @ref LLP 0257#testing [tests]: the deterministic parts (projection identity,
 *   config) are unit tested; the end-to-end seam is the hermetic smoke
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  flattenClaudeTelemetryEvents,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/events.js'
import {
  projectClaudeTelemetryEvents,
  USAGE_INDEX_LIMIT,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/projection.js'
import {
  DEFAULT_TELEMETRY_PORT,
  partitionIgnoredSessionEvents,
  readListenConfig,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/source.js'
import { validateClaudeConfig } from '../../hypaware-core/plugins-workspace/claude/src/config.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'

const SESSION = 'e53c128d-9f45-470f-86f1-d5b5f3766708'
const PROMPT = '65cf592b-4153-482e-99a8-c22f1832b060'
const USER_UUID = '4bd39765-f83f-4a6f-bfc4-81b88f6ac446'
const ASSISTANT_UUID = '1e54d1be-9919-4b2a-97e2-3292ba55ce0e'
const REQUEST_ID = 'req_011Ce8sjpb8Uzvot2JMvFkKe'

/** @param {Record<string, unknown>} attrs */
function kvAttributes(attrs) {
  return Object.entries(attrs).map(([key, value]) => {
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { key, value: { intValue: value } }
        : { key, value: { doubleValue: value } }
    }
    if (typeof value === 'boolean') return { key, value: { boolValue: value } }
    return { key, value: { stringValue: String(value) } }
  })
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} attrs
 * @param {string} timestamp
 */
function record(name, attrs, timestamp) {
  return {
    timeUnixNano: String(BigInt(Date.parse(timestamp)) * 1_000_000n),
    body: { stringValue: `claude_code.${name}` },
    attributes: kvAttributes({
      'session.id': SESSION,
      'app.version': '2.1.233',
      'app.entrypoint': 'sdk-cli',
      'organization.id': '2efcd21e-aea6-42c6-9eda-a6e997ddcde4',
      'user.account_uuid': 'c9f39145-595f-4b31-9c66-c5c658a80aed',
      'terminal.type': 'ghostty',
      'event.name': name,
      'event.timestamp': timestamp,
      'prompt.id': PROMPT,
      ...attrs,
    }),
  }
}

/** @param {Array<ReturnType<typeof record>>} records */
function envelope(records, resourceAttrs = { 'service.name': 'claude-code' }) {
  return {
    resourceLogs: [
      {
        resource: { attributes: kvAttributes(resourceAttrs) },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.233' },
            logRecords: records,
          },
        ],
      },
    ],
  }
}

function turnRecords() {
  return [
    record('user_prompt', {
      prompt_length: '86',
      prompt: 'Run ls, then read notes.txt.',
      'message.uuid': USER_UUID,
    }, '2026-08-17T19:30:24.450Z'),
    record('api_request', {
      model: 'claude-haiku-4-5-20251001',
      input_tokens: 73,
      output_tokens: 113,
      cache_read_tokens: 35212,
      cache_creation_tokens: 307,
      cost_usd: 0.0047732,
      duration_ms: 1842,
      request_id: REQUEST_ID,
      speed: 'normal',
      query_source: 'sdk',
    }, '2026-08-17T19:30:31.009Z'),
    record('assistant_response', {
      response_length: 93,
      response: 'This is a spike repo.',
      request_id: REQUEST_ID,
      'message.uuid': ASSISTANT_UUID,
      model: 'claude-haiku-4-5-20251001',
      query_source: 'sdk',
    }, '2026-08-17T19:30:31.009Z'),
  ]
}

/**
 * @param {Array<ReturnType<typeof record>>} records
 * @param {Map<string, Record<string, unknown>>} [usage]
 */
function projectAll(records, usage = new Map()) {
  return projectClaudeTelemetryEvents(flattenClaudeTelemetryEvents(envelope(records)), {
    clientName: 'claude',
    usageByRequestId: usage,
  })
}

test('the OTLP envelope decodes to flat events keyed by event.name', () => {
  const events = flattenClaudeTelemetryEvents(envelope(turnRecords()))
  assert.deepEqual(events.map((e) => e.name), ['user_prompt', 'api_request', 'assistant_response'])
  assert.equal(events[0].attributes['session.id'], SESSION)
  assert.equal(events[0].timestamp, '2026-08-17T19:30:24.450Z')
  // The AnyValue wrappers are gone: consumers see plain values.
  assert.equal(events[1].attributes.input_tokens, 73)
  assert.equal(events[1].attributes.cost_usd, 0.0047732)
})

test('a record with no event.name attribute contributes nothing', () => {
  const bare = { timeUnixNano: '1786995009202000000', body: { stringValue: 'hello' }, attributes: [] }
  assert.deepEqual(flattenClaudeTelemetryEvents(envelope([/** @type {any} */ (bare)])), [])
})

test('the timestamp falls back to timeUnixNano when event.timestamp is absent', () => {
  const one = record('user_prompt', { prompt: 'hi', 'message.uuid': USER_UUID }, '2026-08-17T19:30:24.450Z')
  one.attributes = one.attributes.filter((a) => a.key !== 'event.timestamp')
  const [event] = flattenClaudeTelemetryEvents(envelope([one]))
  assert.equal(event.timestamp, '2026-08-17T19:30:24.450Z')
})

test('a malformed envelope yields no events instead of throwing', () => {
  assert.deepEqual(flattenClaudeTelemetryEvents(undefined), [])
  assert.deepEqual(flattenClaudeTelemetryEvents({ resourceLogs: 'nope' }), [])
  assert.deepEqual(flattenClaudeTelemetryEvents({ resourceLogs: [null, { scopeLogs: [{}] }] }), [])
})

test('the daemon\'s own telemetry is dropped, not ingested', () => {
  const payload = envelope(turnRecords(), { 'service.name': 'hypaware-dev', 'hypaware.self': true })
  assert.deepEqual(flattenClaudeTelemetryEvents(payload), [])
})

test('another exporter\'s scope is ignored', () => {
  const payload = envelope(turnRecords())
  payload.resourceLogs[0].scopeLogs[0].scope = { name: 'my.app', version: '1.0.0' }
  assert.deepEqual(flattenClaudeTelemetryEvents(payload), [])
})

test('one turn projects to a user row and an assistant row with native uuids', () => {
  const [projection] = projectAll(turnRecords())
  assert.equal(projection.provider, 'anthropic')
  assert.equal(projection.session_id, SESSION)
  assert.equal(projection.conversation_id, undefined)
  assert.equal(projection.client_name, 'claude')
  assert.equal(projection.conversation_source, 'claude_code')
  assert.equal(projection.client_version, '2.1.233')
  assert.equal(projection.entrypoint, 'sdk-cli')
  assert.equal(projection.user_id, 'c9f39145-595f-4b31-9c66-c5c658a80aed')

  assert.equal(projection.messages.length, 2)
  const [user, assistant] = projection.messages
  assert.equal(user.role, 'user')
  assert.equal(user.message_id, USER_UUID)
  assert.equal(user.provider_uuid, USER_UUID)
  assert.equal(user.content, 'Run ls, then read notes.txt.')
  assert.equal(user.prompt_id, PROMPT)

  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.message_id, ASSISTANT_UUID)
  assert.equal(assistant.request_id, REQUEST_ID)
  assert.equal(assistant.model, 'claude-haiku-4-5-20251001')
})

test('api_request usage lands on the assistant message it names', () => {
  const [projection] = projectAll(turnRecords())
  const assistant = projection.messages[1]
  assert.deepEqual(assistant.attributes?.usage, {
    input_tokens: 73,
    output_tokens: 113,
    cache_read_tokens: 35212,
    cache_write_tokens: 307,
  })
  assert.equal(/** @type {any} */ (assistant.attributes)?.claude?.cost_usd, 0.0047732)
})

test('usage carries across batches, because the exporter flushes on a timer', () => {
  const usage = new Map()
  const [request, response] = [turnRecords()[1], turnRecords()[2]]
  assert.deepEqual(projectAll([request], usage), [])
  const [projection] = projectAll([response], usage)
  assert.equal(/** @type {any} */ (projection.messages[0].attributes)?.usage?.output_tokens, 113)
  // Claimed once: a later duplicate response does not re-read it.
  assert.equal(usage.size, 0)
})

test('the usage index evicts oldest-first at its cap', () => {
  const usage = new Map()
  const records = []
  for (let i = 0; i < USAGE_INDEX_LIMIT + 5; i++) {
    records.push(record('api_request', { request_id: `req-${i}`, output_tokens: i }, '2026-08-17T19:30:31.009Z'))
  }
  projectAll(records, usage)
  assert.equal(usage.size, USAGE_INDEX_LIMIT)
  assert.equal(usage.has('req-0'), false)
  assert.equal(usage.has(`req-${USAGE_INDEX_LIMIT + 4}`), true)
})

test('a prompt event with content logging off produces no row', () => {
  const noPrompt = record('user_prompt', { prompt_length: '86', 'message.uuid': USER_UUID }, '2026-08-17T19:30:24.450Z')
  assert.deepEqual(projectAll([noPrompt]), [])
})

test('events for two sessions project to two exchanges', () => {
  const other = record('user_prompt', { prompt: 'second', 'message.uuid': 'other-uuid' }, '2026-08-17T19:31:00.000Z')
  other.attributes = other.attributes.map((a) =>
    a.key === 'session.id' ? { key: 'session.id', value: { stringValue: 'session-two' } } : a
  )
  const projections = projectAll([...turnRecords(), other])
  assert.equal(projections.length, 2)
  assert.deepEqual(projections.map((p) => p.session_id).sort(), [SESSION, 'session-two'])
})

test('cwd and git identity come from the SessionStart hook record', () => {
  const events = flattenClaudeTelemetryEvents(envelope(turnRecords()))
  const [projection] = projectClaudeTelemetryEvents(events, {
    clientName: 'claude',
    usageByRequestId: new Map(),
    sessionContext: (id) => id === SESSION
      ? {
        session_id: id,
        transcript_path: undefined,
        cwd: '/repo',
        git_branch: 'main',
        git_remote: 'git@github.com:o/r.git',
        head_sha: 'a'.repeat(40),
        repo_root: '/repo',
        ts: undefined,
      }
      : undefined,
  })
  assert.equal(projection.cwd, '/repo')
  assert.equal(projection.git_branch, 'main')
  assert.equal(projection.repo_root, '/repo')
})

test('the expanded rows carry native part identity and null parent-chain columns', () => {
  const [projection] = projectAll(turnRecords())
  const rows = aiGatewayRowsFromProjectedExchange(projection)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].part_id, `${USER_UUID}#0`)
  assert.equal(rows[1].part_id, `${ASSISTANT_UUID}#0`)
  // Native identity: nothing here is a gateway fallback, so no settlement
  // enricher has anything to repair. @ref LLP 0254#identity-at-ingest
  for (const row of rows) {
    assert.equal(/** @type {any} */ (row.attributes)?.gateway?.identity_source, undefined)
    // @ref LLP 0252#consequences: these read null on the OTEL path by design.
    assert.equal(row.parent_uuid, undefined)
    assert.equal(row.logical_parent_uuid, undefined)
    assert.equal(row.user_type, undefined)
    assert.equal(row.permission_mode, undefined)
    assert.equal(row.session_id, SESSION)
    assert.equal(row.client_name, 'claude')
    assert.equal(row.provider, 'anthropic')
  }
  assert.equal(rows[1].model, 'claude-haiku-4-5-20251001')
  assert.deepEqual(rows[0].previous_message_id, [])
  assert.deepEqual(rows[1].previous_message_id, [USER_UUID])
})

test('replaying the same events re-expands to the same part ids', () => {
  const first = aiGatewayRowsFromProjectedExchange(projectAll(turnRecords())[0])
  const second = aiGatewayRowsFromProjectedExchange(projectAll(turnRecords())[0])
  assert.deepEqual(first.map((r) => r.part_id), second.map((r) => r.part_id))
})

// @ref LLP 0256#control-route-on-listener [tests]: ingest drops by session
// id against the listener's own in-memory set, on the same verbatim-token
// match the gateway applies (LLP 0066 R5).
test('an ignored session\'s events are partitioned out, keyed verbatim on session.id', () => {
  const events = flattenClaudeTelemetryEvents(envelope(turnRecords()))
  const { kept, droppedBySession } = partitionIgnoredSessionEvents(events, new Set([SESSION]))
  assert.deepEqual(kept, [])
  assert.equal(droppedBySession.size, 1)
  assert.equal(droppedBySession.get(SESSION)?.length, 3)

  // The token is opaque and never normalized: a trimmed or case-shifted
  // variant of the id matches nothing, so those events are recorded.
  const nearMiss = partitionIgnoredSessionEvents(events, new Set([` ${SESSION} `, SESSION.toUpperCase()]))
  assert.equal(nearMiss.kept.length, 3)
  assert.equal(nearMiss.droppedBySession.size, 0)
})

test('only the ignored session drops; other sessions and unattributed events are kept', () => {
  const other = record('user_prompt', { prompt: 'second', 'message.uuid': 'other-uuid' }, '2026-08-17T19:31:00.000Z')
  other.attributes = other.attributes.map((a) =>
    a.key === 'session.id' ? { key: 'session.id', value: { stringValue: 'session-two' } } : a
  )
  // An event naming NO session cannot match an exact key, so it is kept:
  // dropping it would suppress rows nobody opted out.
  const anonymous = record('user_prompt', { prompt: 'third', 'message.uuid': 'anon-uuid' }, '2026-08-17T19:32:00.000Z')
  anonymous.attributes = anonymous.attributes.filter((a) => a.key !== 'session.id')

  const events = flattenClaudeTelemetryEvents(envelope([...turnRecords(), other, anonymous]))
  const { kept, droppedBySession } = partitionIgnoredSessionEvents(events, new Set(['session-two']))
  assert.equal(kept.length, 4)
  assert.deepEqual([...droppedBySession.keys()], ['session-two'])
  assert.equal(droppedBySession.get('session-two')?.length, 1)
})

test('an empty ignore set keeps every event and allocates no buckets', () => {
  const events = flattenClaudeTelemetryEvents(envelope(turnRecords()))
  const { kept, droppedBySession } = partitionIgnoredSessionEvents(events, new Set())
  assert.equal(kept.length, events.length)
  assert.equal(droppedBySession.size, 0)
})

test('the listener config defaults to loopback on its own port', () => {
  const warnings = []
  const ctx = /** @type {any} */ ({ config: {}, log: { warn: (/** @type {any} */ m) => warnings.push(m) } })
  assert.deepEqual(readListenConfig(ctx), {
    host: '127.0.0.1',
    port: DEFAULT_TELEMETRY_PORT,
    portConfigured: false,
  })
  assert.equal(warnings.length, 0)
})

test('a configured port is marked configured, so it never silently falls back', () => {
  const ctx = /** @type {any} */ ({
    config: { telemetry: { listen_host: '127.0.0.2', listen_port: 0 } },
    log: { warn: () => {} },
  })
  assert.deepEqual(readListenConfig(ctx), { host: '127.0.0.2', port: 0, portConfigured: true })
})

test('a mistyped listener port warns and falls back to the default', () => {
  const warnings = []
  const ctx = /** @type {any} */ ({
    config: { telemetry: { listen_port: '4319' } },
    log: { warn: (/** @type {any} */ m) => warnings.push(m) },
  })
  assert.equal(readListenConfig(ctx).port, DEFAULT_TELEMETRY_PORT)
  assert.equal(warnings.length, 1)
})

test('the telemetry config block is validated', () => {
  assert.equal(validateClaudeConfig({ telemetry: { listen_host: '127.0.0.1', listen_port: 4319 } }).ok, true)
  const badPort = validateClaudeConfig({ telemetry: { listen_port: 70000 } })
  assert.equal(badPort.ok, false)
  assert.equal(badPort.errors?.[0].pointer, '/telemetry/listen_port')
  const typo = validateClaudeConfig({ telemetry: { listen_ports: 4319 } })
  assert.equal(typo.ok, false)
  assert.equal(typo.errors?.[0].pointer, '/telemetry/listen_ports')
})
