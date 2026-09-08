// @ts-check

/**
 * The OTEL listener and the transcript backfill sweep are both live on an
 * OTEL-attached machine (LLP 0262 #migration keeps transcript backfill as the
 * recovery path), so a session is routinely captured by both. That overlap is
 * only harmless if the two producers give the same content the same
 * `part_id`, which is what the dataset's dedupe collapses on.
 *
 * Content EVENTS carry `message.uuid`, so their rows already agree
 * (claude-otel-proxy-overlap.test.js pins that half). The blocks events do
 * NOT carry - tool_use, tool_result, thinking - reach the OTEL lane only
 * through a spooled request/response body, which carries no uuid. These tests
 * pin that half: a body-derived block settles onto the same transcript uuid
 * the backfill lane writes, so one tool call is one row (issue #1464).
 *
 * Agreeing on `part_id` is only half of it: once the twin rows collapse, the
 * two lanes must also have put the turn's `usage` on the SAME one of them, or
 * a collapse can keep two rows that both lack it (issue #1470).
 *
 * @ref LLP 0262#migration [tests]: a session captured by both producers dedupes to one row set
 * @ref LLP 0027#decision [tests]: a fallback row carries its content match-key so flush-time settlement can upgrade it
 * @ref LLP 0390#carrier-is-the-last-block [tests]: both lanes name the response's last block as the usage carrier
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { aiGatewayDatasetRegistration } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createClaudeBackfillProvider } from '../../hypaware-core/plugins-workspace/claude/src/backfill.js'
import { createClaudeSettlementEnricher } from '../../hypaware-core/plugins-workspace/claude/src/settle.js'
import { loadSpooledBodies } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/bodies.js'
import { flattenClaudeTelemetryEvents } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/events.js'
import { projectClaudeTelemetryEvents } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/projection.js'

/**
 * @import { BackfillItem, BackfillRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

const SESSION = '3f0d708d-1c2a-4b0e-9f77-2b1a5c9f0d31'
const PROMPT_UUID = '11111111-1111-4111-8111-111111111111'
const TOOL_UUID = '5233b3fa-fd52-4c1e-9a44-6c0e8c0f1a2b'
const RESULT_UUID = '77ea6f90-90c5-47ab-9d20-1c4e6f9b3a55'
const API_MESSAGE_ID = 'msg_tooluse_1'
const REQUEST_ID = 'req_tooluse_1'

const TOOL_BLOCK = Object.freeze({
  type: 'tool_use',
  id: 'toolu_01BashOverlap',
  name: 'Bash',
  input: { command: 'ls -la', description: 'list the tree' },
})
const RESULT_BLOCK = Object.freeze({
  type: 'tool_result',
  tool_use_id: 'toolu_01BashOverlap',
  content: 'AGENTS.md\nREADME.md\n',
})

// The second session is the ordinary tool-calling shape: one API message whose
// content is `[text, tool_use]`, which Claude Code writes as two transcript
// lines under one `message.id` and exports as an `assistant_response` event
// (the text) plus a response body (the tool_use). The two lanes have to name
// the same row of it as the turn's usage carrier (issue #1470).
const TEXT_SESSION = '8a41c6b2-77d3-4e51-b0aa-9c2f3d6e1b04'
const TEXT_PROMPT_UUID = '33333333-3333-4333-8333-333333333333'
const TEXT_UUID = '22222222-2222-4222-8222-222222222222'
const TEXT_TOOL_UUID = 'c0ffee11-2b3c-4d5e-8f60-7a8b9c0d1e2f'
const TEXT_API_MESSAGE_ID = 'msg_texttool_1'
const TEXT_REQUEST_ID = 'req_texttool_1'
const ANSWER = 'Listing the tree now.'
const TEXT_USAGE = Object.freeze({ input_tokens: 12, output_tokens: 34 })

const TEXT_TOOL_BLOCK = Object.freeze({
  type: 'tool_use',
  id: 'toolu_01BashCarrier',
  name: 'Bash',
  input: { command: 'ls -la', description: 'list the tree' },
})

// ---------------------------------------------------------------------
// The transcript backfill lane: the on-disk JSONL Claude Code writes,
// read by the real provider and expanded by the real row expansion.
// ---------------------------------------------------------------------

/** @param {string} homeDir */
async function writeTranscript(homeDir) {
  const dir = path.join(homeDir, '.claude', 'projects', 'some-repo')
  await fs.mkdir(dir, { recursive: true })
  const rows = [
    {
      sessionId: SESSION,
      uuid: PROMPT_UUID,
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'list the tree' },
      timestamp: '2026-09-05T22:36:50.000Z',
    },
    {
      sessionId: SESSION,
      uuid: TOOL_UUID,
      parentUuid: PROMPT_UUID,
      type: 'assistant',
      requestId: REQUEST_ID,
      message: {
        id: API_MESSAGE_ID,
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [TOOL_BLOCK],
        usage: { input_tokens: 12, output_tokens: 34 },
      },
      timestamp: '2026-09-05T22:36:52.405Z',
    },
    {
      sessionId: SESSION,
      uuid: RESULT_UUID,
      parentUuid: TOOL_UUID,
      type: 'user',
      message: { role: 'user', content: [RESULT_BLOCK] },
      timestamp: '2026-09-05T22:36:52.900Z',
    },
  ]
  await fs.writeFile(
    path.join(dir, `${SESSION}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  )
}

/**
 * The `[text, tool_use]` turn as Claude Code records it: two lines under one
 * `message.id`, each carrying the response's usage (the client duplicates it
 * onto every block line, which is why the sweep keeps only the last).
 *
 * @param {string} homeDir
 */
async function writeTextToolTranscript(homeDir) {
  const dir = path.join(homeDir, '.claude', 'projects', 'some-repo')
  await fs.mkdir(dir, { recursive: true })
  const assistant = {
    id: TEXT_API_MESSAGE_ID,
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    usage: TEXT_USAGE,
  }
  const rows = [
    {
      sessionId: TEXT_SESSION,
      uuid: TEXT_PROMPT_UUID,
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'list the tree' },
      timestamp: '2026-09-06T10:00:00.000Z',
    },
    {
      sessionId: TEXT_SESSION,
      uuid: TEXT_UUID,
      parentUuid: TEXT_PROMPT_UUID,
      type: 'assistant',
      requestId: TEXT_REQUEST_ID,
      message: { ...assistant, content: [{ type: 'text', text: ANSWER }] },
      timestamp: '2026-09-06T10:00:02.100Z',
    },
    {
      sessionId: TEXT_SESSION,
      uuid: TEXT_TOOL_UUID,
      parentUuid: TEXT_UUID,
      type: 'assistant',
      requestId: TEXT_REQUEST_ID,
      message: { ...assistant, content: [TEXT_TOOL_BLOCK], stop_reason: 'tool_use' },
      timestamp: '2026-09-06T10:00:02.405Z',
    },
  ]
  await fs.writeFile(
    path.join(dir, `${TEXT_SESSION}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  )
}

/** @param {{ homeDir: string, stateFile: string }} env */
async function backfillRows(env) {
  const provider = createClaudeBackfillProvider({
    homeDir: env.homeDir,
    stateFile: env.stateFile,
    deriveRepo: async () => ({}),
  })
  /** @type {BackfillRunContext} */
  const ctx = /** @type {any} */ ({
    env: {},
    cacheRoot: path.join(env.homeDir, 'cache'),
    dryRun: false,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    storage: {},
  })
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for await (const yielded of provider.run(ctx)) {
    if (yielded.type === 'event') continue
    rows.push(...aiGatewayRowsFromProjectedExchange(
      /** @type {any} */ (/** @type {BackfillItem} */ (yielded).value)
    ))
  }
  return rows
}

// ---------------------------------------------------------------------
// The OTEL lane: the event stream plus the raw body files Claude Code
// drops in the spool, read and projected exactly as the listener does.
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

/**
 * Spool one body file and return the `body_ref` the event carries.
 *
 * @param {string} spoolDir
 * @param {string} name
 * @param {Record<string, unknown>} body
 */
async function spoolBody(spoolDir, name, body) {
  const file = path.join(spoolDir, name)
  await fs.writeFile(file, JSON.stringify(body), 'utf8')
  return file
}

/** @param {{ spoolDir: string }} env */
async function otelRows(env) {
  const responseRef = await spoolBody(env.spoolDir, 'response-1.json', {
    id: API_MESSAGE_ID,
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [TOOL_BLOCK],
    stop_reason: 'tool_use',
    usage: { input_tokens: 12, output_tokens: 34 },
  })
  const requestRef = await spoolBody(env.spoolDir, 'request-2.json', {
    model: 'claude-sonnet-4-5',
    system: 'you are claude code',
    messages: [
      { role: 'user', content: 'list the tree' },
      { role: 'assistant', content: [TOOL_BLOCK] },
      { role: 'user', content: [RESULT_BLOCK] },
    ],
  })

  const envelope = {
    resourceLogs: [
      {
        resource: { attributes: kvAttributes({ 'service.name': 'claude-code' }) },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.233' },
            logRecords: [
              record('user_prompt', {
                prompt: 'list the tree',
                'message.uuid': PROMPT_UUID,
              }, '2026-09-05T22:36:50.100Z'),
              record('api_response_body', {
                body_ref: responseRef,
                request_id: REQUEST_ID,
              }, '2026-09-05T22:36:52.417Z'),
              record('api_request_body', {
                body_ref: requestRef,
              }, '2026-09-05T22:36:53.100Z'),
            ],
          },
        ],
      },
    ],
  }

  const events = flattenClaudeTelemetryEvents(envelope)
  const { bodies } = await loadSpooledBodies(events, { spoolDir: env.spoolDir })
  const projections = projectClaudeTelemetryEvents(events, {
    clientName: 'claude',
    usageByRequestId: new Map(),
    spooledBodies: bodies,
  })
  assert.equal(projections.length, 1)
  return aiGatewayRowsFromProjectedExchange(projections[0])
}

/**
 * The same `[text, tool_use]` turn on the OTEL lane, in the order Claude Code
 * exports it: the `api_request` usage record, then the response body it was
 * spooled from, then the `assistant_response` carrying the text.
 *
 * @param {{ spoolDir: string }} env
 */
async function textToolOtelRows(env) {
  const responseRef = await spoolBody(env.spoolDir, 'response-texttool.json', {
    id: TEXT_API_MESSAGE_ID,
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: ANSWER }, TEXT_TOOL_BLOCK],
    stop_reason: 'tool_use',
    usage: TEXT_USAGE,
  })

  const envelope = {
    resourceLogs: [
      {
        resource: { attributes: kvAttributes({ 'service.name': 'claude-code' }) },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.233' },
            logRecords: [
              record('user_prompt', {
                'session.id': TEXT_SESSION,
                prompt: 'list the tree',
                'message.uuid': TEXT_PROMPT_UUID,
              }, '2026-09-06T10:00:00.100Z'),
              record('api_request', {
                'session.id': TEXT_SESSION,
                request_id: TEXT_REQUEST_ID,
                model: 'claude-sonnet-4-5',
                input_tokens: TEXT_USAGE.input_tokens,
                output_tokens: TEXT_USAGE.output_tokens,
              }, '2026-09-06T10:00:02.400Z'),
              record('api_response_body', {
                'session.id': TEXT_SESSION,
                body_ref: responseRef,
                request_id: TEXT_REQUEST_ID,
              }, '2026-09-06T10:00:02.417Z'),
              record('assistant_response', {
                'session.id': TEXT_SESSION,
                response: ANSWER,
                request_id: TEXT_REQUEST_ID,
                'message.uuid': TEXT_UUID,
                model: 'claude-sonnet-4-5',
              }, '2026-09-06T10:00:02.500Z'),
            ],
          },
        ],
      },
    ],
  }

  const events = flattenClaudeTelemetryEvents(envelope)
  const { bodies } = await loadSpooledBodies(events, { spoolDir: env.spoolDir })
  const projections = projectClaudeTelemetryEvents(events, {
    clientName: 'claude',
    usageByRequestId: new Map(),
    spooledBodies: bodies,
  })
  assert.equal(projections.length, 1)
  return aiGatewayRowsFromProjectedExchange(projections[0])
}

// ---------------------------------------------------------------------

/** @returns {Promise<{ homeDir: string, stateFile: string, spoolDir: string, cleanup: () => Promise<void> }>} */
async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-body-overlap-'))
  const stateDir = path.join(homeDir, 'state')
  const spoolDir = path.join(homeDir, 'spool')
  await fs.mkdir(stateDir, { recursive: true })
  await fs.mkdir(spoolDir, { recursive: true })
  await writeTranscript(homeDir)
  return {
    homeDir,
    stateFile: path.join(stateDir, 'session-context.jsonl'),
    spoolDir,
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  }
}

/**
 * The flush pass the daemon runs over the spool, with the claude enricher
 * registered and the backfill lane's rows already committed.
 *
 * @param {{ homeDir: string, stateFile: string }} env
 * @param {Record<string, unknown>[]} rows
 * @param {string[]} committed
 */
async function settleBatch(env, rows, committed) {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  api.registerSettlementEnricher(createClaudeSettlementEnricher({
    homeDir: env.homeDir,
    stateFile: env.stateFile,
  }))
  const registration = aiGatewayDatasetRegistration(state)
  const ctx = /** @type {any} */ ({
    storage: {
      discoverCachePartitions: async () => [{ path: '/p', rowCount: committed.length }],
      async *readRows() {
        for (const partId of committed) yield { part_id: partId }
      },
    },
  })
  return /** @type {Record<string, unknown>[]} */ (
    await /** @type {any} */ (registration).settleBatch(rows, ctx)
  )
}

/** @param {Record<string, unknown>[]} rows @param {string} partType */
function partIds(rows, partType) {
  return rows.filter((r) => r.part_type === partType).map((r) => String(r.part_id)).sort()
}

/** @param {Record<string, unknown>} row */
function usageOf(row) {
  const usage = /** @type {any} */ (row.attributes)?.usage
  return usage && typeof usage === 'object' ? usage : undefined
}

/**
 * The `part_id`s a lane put the response's `usage` on.
 *
 * @param {Record<string, unknown>[]} rows
 */
function usageCarriers(rows) {
  return rows.filter(usageOf).map((r) => String(r.part_id)).sort()
}

/** @param {Record<string, unknown>[]} rows */
function outputTokens(rows) {
  let total = 0
  for (const row of rows) {
    const value = usageOf(row)?.output_tokens
    if (typeof value === 'number') total += value
  }
  return total
}

/** @param {Record<string, unknown>[]} rows @param {string} sessionId */
function forSession(rows, sessionId) {
  return rows.filter((r) => r.session_id === sessionId)
}

test('a body-derived tool call settles onto the transcript uuid the backfill lane writes', async () => {
  const env = await stageEnv()
  try {
    const fromBackfill = await backfillRows(env)
    const fromOtel = await otelRows(env)

    assert.deepEqual(partIds(fromBackfill, 'tool_call'), [`${TOOL_UUID}#0`])
    assert.deepEqual(partIds(fromBackfill, 'tool_result'), [`${RESULT_UUID}#0`])

    const settled = await settleBatch(env, fromOtel, [])
    assert.deepEqual(
      partIds(settled, 'tool_call'),
      partIds(fromBackfill, 'tool_call'),
      'the OTEL lane must give the same tool call the same part identity'
    )
    assert.deepEqual(
      partIds(settled, 'tool_result'),
      partIds(fromBackfill, 'tool_result'),
      'the OTEL lane must give the same tool result the same part identity'
    )
  } finally {
    await env.cleanup()
  }
})

test('a session the backfill sweep already stored lands once: the OTEL lane adds no tool-call row', async () => {
  const env = await stageEnv()
  try {
    const fromBackfill = await backfillRows(env)
    const fromOtel = await otelRows(env)
    const committed = fromBackfill.map((r) => String(r.part_id))

    const settled = await settleBatch(env, fromOtel, committed)
    assert.deepEqual(
      settled.filter((r) => r.part_type === 'tool_call' || r.part_type === 'tool_result'),
      [],
      'every body-derived block collapses onto the committed transcript row'
    )
  } finally {
    await env.cleanup()
  }
})

test('a [text, tool_use] turn: both lanes stamp the response usage on the same row', async () => {
  const env = await stageEnv()
  try {
    await writeTextToolTranscript(env.homeDir)
    const fromBackfill = forSession(await backfillRows(env), TEXT_SESSION)
    // @ref LLP 0035#one-carrier [tests]: the sweep's carrier is the turn's last
    // block, the tool_use, not the text that precedes it.
    assert.deepEqual(usageCarriers(fromBackfill), [`${TEXT_TOOL_UUID}#0`])

    const settled = await settleBatch(env, await textToolOtelRows(env), [])
    assert.deepEqual(
      usageCarriers(settled),
      usageCarriers(fromBackfill),
      'the OTEL lane must stamp usage on the row the sweep stamps it on'
    )
  } finally {
    await env.cleanup()
  }
})

test('a [text, tool_use] turn split across the two lanes still totals its tokens once', async () => {
  const env = await stageEnv()
  try {
    await writeTextToolTranscript(env.homeDir)
    const fromBackfill = forSession(await backfillRows(env), TEXT_SESSION)
    // The mixed commit order issue #1470 names: a sweep that ran while the
    // transcript held the text line but not yet the tool_use line committed
    // the text rows, so the OTEL lane is the one that lands the tool row.
    const sweepCommitted = fromBackfill.filter((r) => r.part_type === 'text')
    const committed = sweepCommitted.map((r) => String(r.part_id))

    const settled = await settleBatch(env, await textToolOtelRows(env), committed)
    assert.equal(
      outputTokens([...sweepCommitted, ...settled]),
      TEXT_USAGE.output_tokens,
      'the collapsed turn must keep exactly one copy of its tokens'
    )
  } finally {
    await env.cleanup()
  }
})
