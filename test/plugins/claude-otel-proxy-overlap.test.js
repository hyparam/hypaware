// @ts-check

/**
 * The migration overlap window (LLP 0245 #migration): sessions started
 * before the mode flip keep proxying until they restart while new events
 * arrive over OTEL, so for a while BOTH producers capture the same session.
 * That is harmless only if the two producers agree on row identity, and
 * these tests pin both halves of that promise:
 *
 * 1. the proxy projector (native transcript identity) and the telemetry
 *    projection (`message.uuid` identity) yield the SAME `part_id`s for the
 *    same session content, and
 * 2. the OTEL producer's pre-write dedupe drops every part the proxy
 *    already stored, so the overlap lands as one row set.
 *
 * The mirror direction needs no separate fixture: the proxy's flush-time
 * dedupe asks the same committed-`part_id` membership question
 * (`dedupeByPartId` in dataset.js), so identical part identity is what makes
 * either arrival order collapse.
 *
 * @ref LLP 0245#migration [tests]: a session captured by both producers dedupes to one row set
 * @ref LLP 0252#projection-unchanged [tests]: producer overlap collapses on part_id before the write
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  aiGatewayRowsFromProjectedExchange,
  createAiGatewayMessageProjector,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createClaudeExchangeProjector } from '../../hypaware-core/plugins-workspace/claude/src/projector.js'
import { flattenClaudeTelemetryEvents } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/events.js'
import { projectClaudeTelemetryEvents } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/projection.js'

const SESSION = 'e53c128d-9f45-470f-86f1-d5b5f3766708'
const USER_UUID = '4bd39765-f83f-4a6f-bfc4-81b88f6ac446'
const ASSISTANT_UUID = '1e54d1be-9919-4b2a-97e2-3292ba55ce0e'
const PROMPT_TEXT = 'hello from the overlap window'
const RESPONSE_TEXT = 'hi from both producers'

// ---------------------------------------------------------------------
// The proxy producer's half: a wire exchange projected through the claude
// projector inside the gateway dispatcher, with the transcript on disk
// supplying native DAG identity - the exact path a still-proxying session
// takes during the overlap.
// ---------------------------------------------------------------------

async function proxyRowsForSession() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-overlap-'))
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects', 'some-repo')
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.writeFile(
      path.join(projectsDir, `${SESSION}.jsonl`),
      [
        JSON.stringify({
          sessionId: SESSION,
          uuid: USER_UUID,
          parentUuid: null,
          type: 'user',
          message: { role: 'user', content: PROMPT_TEXT },
          timestamp: '2026-08-17T10:00:00.000Z',
        }),
        JSON.stringify({
          sessionId: SESSION,
          uuid: ASSISTANT_UUID,
          parentUuid: USER_UUID,
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg_overlap',
            content: [{ type: 'text', text: RESPONSE_TEXT }],
          },
          timestamp: '2026-08-17T10:00:01.000Z',
        }),
      ].join('\n') + '\n',
      'utf8'
    )

    const projector = createClaudeExchangeProjector({
      homeDir,
      stateFile: path.join(homeDir, 'session-context.jsonl'),
    })
    const dispatcher = createAiGatewayMessageProjector({
      gatewayId: 'gw-test',
      projectors: [{ ...projector, _seq: 0 }],
    })
    return await dispatcher.projectExchange({
      exchange_id: 'ex-overlap',
      ts_start: '2026-08-17T10:00:05.000Z',
      ts_end: '2026-08-17T10:00:05.250Z',
      duration_ms: 250,
      upstream: 'anthropic',
      provider: null,
      method: 'POST',
      path: '/v1/messages',
      status_code: 200,
      request_bytes: 100,
      response_bytes: 200,
      is_sse: false,
      stream_event_count: 0,
      request_headers: JSON.stringify({
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-cli/1.0',
      }),
      request_body: JSON.stringify({
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: SESSION }) },
        messages: [{ role: 'user', content: PROMPT_TEXT }],
      }),
      response_headers: JSON.stringify({ 'content-type': 'application/json' }),
      response_body: JSON.stringify({
        id: 'msg_overlap',
        role: 'assistant',
        content: [{ type: 'text', text: RESPONSE_TEXT }],
        stop_reason: 'end_turn',
      }),
      error: null,
      metadata: JSON.stringify({ dev_run_id: 'run-overlap' }),
      stream_events: [],
    })
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------
// The OTEL producer's half: the same session as Claude Code's own event
// stream, carrying the same native uuids as `message.uuid`.
// ---------------------------------------------------------------------

/** @param {Record<string, unknown>} attrs */
function kvAttributes(attrs) {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: { stringValue: String(value) },
  }))
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
      'app.entrypoint': 'cli',
      'event.name': name,
      'event.timestamp': timestamp,
      ...attrs,
    }),
  }
}

function otelProjectionForSession() {
  const envelope = {
    resourceLogs: [
      {
        resource: { attributes: kvAttributes({ 'service.name': 'claude-code' }) },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.233' },
            logRecords: [
              record('user_prompt', {
                prompt: PROMPT_TEXT,
                'message.uuid': USER_UUID,
              }, '2026-08-17T10:00:00.100Z'),
              record('assistant_response', {
                response: RESPONSE_TEXT,
                request_id: 'req_overlap',
                'message.uuid': ASSISTANT_UUID,
                model: 'claude-3-opus',
              }, '2026-08-17T10:00:01.100Z'),
            ],
          },
        ],
      },
    ],
  }
  const projections = projectClaudeTelemetryEvents(flattenClaudeTelemetryEvents(envelope), {
    clientName: 'claude',
    usageByRequestId: new Map(),
  })
  assert.equal(projections.length, 1)
  return projections[0]
}

/**
 * Storage stub with the read surface the pre-write dedupe feature-detects,
 * seeded with already-committed part_ids (the proxy producer's rows).
 *
 * @param {{ committed?: string[] }} [seed]
 */
function makeStorage(seed = {}) {
  const committed = seed.committed ?? []
  /** @type {Record<string, unknown>[]} */
  const appended = []
  return {
    appended,
    /** @param {string} dataset @param {string[]} labels */
    cacheTablePath: (dataset, labels) => `/cache/${dataset}/${labels.join('/')}`,
    /** @param {{ datasets: string[] }} _scope */
    async discoverCachePartitions(_scope) {
      return [{ path: '/cache/committed', partition: {}, rowCount: committed.length }]
    },
    async *readRows() {
      for (const partId of committed) yield { part_id: partId }
    },
    async *readSpooledRows() {},
    /** @param {string} _tablePath @param {unknown} _columns @param {Record<string, unknown>[]} rows */
    async appendRows(_tablePath, _columns, rows) {
      appended.push(...rows)
    },
  }
}

test('the proxy rows and the OTEL rows for one session share part identity', async () => {
  const proxyRows = await proxyRowsForSession()
  const otelRows = aiGatewayRowsFromProjectedExchange(otelProjectionForSession())

  assert.equal(proxyRows.length, 2)
  assert.deepEqual(
    proxyRows.map((r) => r.part_id).sort(),
    otelRows.map((r) => r.part_id).sort()
  )
  assert.deepEqual(
    proxyRows.map((r) => r.part_id).sort(),
    [`${ASSISTANT_UUID}#0`, `${USER_UUID}#0`]
  )
  for (const rows of [proxyRows, otelRows]) {
    for (const row of rows) assert.equal(row.session_id, SESSION)
  }
})

test('a session the proxy already stored lands once: the OTEL producer writes nothing new', async () => {
  const proxyRows = await proxyRowsForSession()
  const storage = makeStorage({
    committed: proxyRows.map((r) => /** @type {string} */ (r.part_id)),
  })
  const api = createAiGatewayApi(createGatewayState(), { storage: /** @type {any} */ (storage) })

  const result = await api.recordProjectedExchange(/** @type {any} */ (otelProjectionForSession()))
  assert.deepEqual(result, { rowsWritten: 0, rowsSkipped: 2 })
  assert.equal(storage.appended.length, 0)
})

test('a half-stored overlap fills only the gap', async () => {
  const proxyRows = await proxyRowsForSession()
  const userPartId = /** @type {string} */ (
    proxyRows.find((r) => r.role === 'user')?.part_id
  )
  const storage = makeStorage({ committed: [userPartId] })
  const api = createAiGatewayApi(createGatewayState(), { storage: /** @type {any} */ (storage) })

  const result = await api.recordProjectedExchange(/** @type {any} */ (otelProjectionForSession()))
  assert.deepEqual(result, { rowsWritten: 1, rowsSkipped: 1 })
  assert.deepEqual(storage.appended.map((r) => r.part_id), [`${ASSISTANT_UUID}#0`])
})
