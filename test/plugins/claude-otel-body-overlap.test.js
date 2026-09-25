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
import { appendSessionContext } from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'
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
 * @param {boolean} [resettle]
 */
async function settleBatch(env, rows, committed, resettle = false) {
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
    await /** @type {any} */ (registration)[resettle ? 'resettleBatch' : 'settleBatch'](rows, ctx)
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

    // The other mixed order, which #1470's table lists as the pre-existing
    // OVER-count: the sweep committed the tool row, so the OTEL lane lands the
    // text row. Two carriers made that turn total 68; one carrier makes it 34.
    const sweptTool = fromBackfill.filter((r) => r.part_type === 'tool_call')
    const afterTool = await settleBatch(
      env,
      await textToolOtelRows(env),
      sweptTool.map((r) => String(r.part_id))
    )
    assert.equal(
      outputTokens([...sweptTool, ...afterTool]),
      TEXT_USAGE.output_tokens,
      'the collapsed turn must not count its tokens twice either'
    )
  } finally {
    await env.cleanup()
  }
})

for (const agentName of ['general-purpose', undefined]) {
  test(`OTEL tool ids recover distinct subagents with agent.name=${agentName}`, async () => {
    const env = await stageEnv()
    try {
      const projectDir = path.join(env.homeDir, '.claude', 'projects', 'some-repo')
      const transcriptPath = path.join(projectDir, `${SESSION}.jsonl`)
      await appendSessionContext(env.stateFile, {
        session_id: SESSION,
        transcript_path: transcriptPath,
        cwd: env.homeDir,
        git_branch: 'main',
        ts: '2026-09-05T22:36:50.000Z',
      })
      const agentsDir = path.join(projectDir, SESSION, 'subagents')
      await fs.mkdir(agentsDir, { recursive: true })
      const events = []
      const expected = []
      for (const agentId of ['a111111', 'a222222']) {
        const call = { ...TOOL_BLOCK, id: `toolu_${agentId}` }
        const result = { ...RESULT_BLOCK, tool_use_id: call.id }
        const entries = [
          { role: 'assistant', content: [call], uuid: `${agentId}-call` },
          { role: 'user', content: [result], uuid: `${agentId}-result` },
        ]
        await fs.writeFile(path.join(agentsDir, `agent-${agentId}.jsonl`), entries.map((entry) => JSON.stringify({
          sessionId: SESSION, agentId, isSidechain: true, type: entry.role,
          uuid: entry.uuid, message: { role: entry.role, content: entry.content },
          timestamp: '2026-09-05T22:36:54.000Z',
        })).join('\n') + '\n')
        await fs.writeFile(path.join(agentsDir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: `spawn_${agentId}` }))
        const bodyRef = await spoolBody(env.spoolDir, `${agentId}.json`, {
          messages: entries.map(({ role, content }) => ({ role, content })),
        })
        events.push({
          name: 'api_request_body', timestamp: '2026-09-05T22:36:55.000Z',
          attributes: { 'session.id': SESSION, body_ref: bodyRef, ...(agentName ? { 'agent.name': agentName } : {}) },
        })
        expected.push(...entries.map(({ uuid }) => ({
          partId: `${uuid}#0`, agentId, spawnedBy: `spawn_${agentId}`,
        })))
      }
      const { bodies } = await loadSpooledBodies(events, { spoolDir: env.spoolDir })
      const [projection] = projectClaudeTelemetryEvents(events, {
        clientName: 'claude', usageByRequestId: new Map(), spooledBodies: bodies,
      })
      const rows = aiGatewayRowsFromProjectedExchange(projection)
      const settled = await settleBatch(env, rows, [])
      assert.deepEqual(settled.map((row) => ({
        partId: row.part_id, agentId: row.agent_id,
        spawnedBy: /** @type {any} */ (row.attributes)?.claude?.spawned_by_tool_use_id,
      })), expected)
      assert.ok(settled.every((row) => row.is_sidechain === true))
      assert.ok(settled.every((row) => !/** @type {any} */ (row.attributes)?.claude?.match_key))
      const backfilled = await backfillRows(env)
      const agentRows = backfilled.filter((row) => row.agent_id)
      assert.deepEqual(partIds(settled, 'tool_call'), partIds(agentRows, 'tool_call'))
      assert.deepEqual(partIds(settled, 'tool_result'), partIds(agentRows, 'tool_result'))
      assert.deepEqual(await settleBatch(env, rows, agentRows.map((row) => String(row.part_id))), [])
      assert.deepEqual(await settleBatch(env, settled, []), settled)
    } finally {
      await env.cleanup()
    }
  })
}

test('a late subagent transcript repairs an unsettled tool call before its result exists', async () => {
  const env = await stageEnv()
  try {
    const agentId = 'a333333'
    const call = { ...TOOL_BLOCK, id: 'toolu_pending' }
    const bodyRef = await spoolBody(env.spoolDir, 'pending.json', {
      role: 'assistant', content: [call],
    })
    const event = {
      name: 'api_response_body', timestamp: '2026-09-05T22:36:55.000Z',
      attributes: { 'session.id': SESSION, body_ref: bodyRef, 'agent.name': 'general-purpose' },
    }
    const { bodies } = await loadSpooledBodies([event], { spoolDir: env.spoolDir })
    const [projection] = projectClaudeTelemetryEvents([event], {
      clientName: 'claude', usageByRequestId: new Map(), spooledBodies: bodies,
    })
    const rows = aiGatewayRowsFromProjectedExchange(projection)
    assert.deepEqual(await settleBatch(env, rows, []), rows, 'missing transcript keeps the retry marker')

    const dir = path.join(env.homeDir, '.claude', 'projects', 'some-repo', SESSION, 'subagents')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `agent-${agentId}.jsonl`), JSON.stringify({
      sessionId: SESSION, agentId, isSidechain: true, type: 'assistant', uuid: 'pending-call',
      message: { role: 'assistant', content: [call] }, timestamp: event.timestamp,
    }) + '\n')
    // Committed fallback rows reach the same enricher through maintenance.
    // Stored JSON attributes must work as well as the ingest-time object.
    const stored = rows.map((row) => ({ ...row, attributes: JSON.stringify(row.attributes) }))
    const [settled] = await settleBatch(env, stored, [], true)
    assert.equal(settled.agent_id, agentId)
    assert.equal(settled.part_id, 'pending-call#0')
    assert.equal(settled.is_sidechain, true)
    assert.equal(/** @type {any} */ (settled.attributes)?.claude?.match_key, undefined)
  } finally {
    await env.cleanup()
  }
})

test('a parent spawn call replayed in a subagent body retains the parent identity', async () => {
  const env = await stageEnv()
  try {
    const call = { type: 'tool_use', id: 'toolu_spawn', name: 'Agent', input: { prompt: 'inspect' } }
    const result = { type: 'tool_result', tool_use_id: call.id, content: 'agentId: a444444' }
    const messages = [{ role: 'assistant', content: [call] }, { role: 'user', content: [result] }]
    const file = path.join(env.homeDir, '.claude', 'projects', 'some-repo', `${SESSION}.jsonl`)
    await fs.appendFile(file, messages.map((message, i) => JSON.stringify({
      sessionId: SESSION, type: message.role, uuid: `spawn-${i}`, message,
      timestamp: '2026-09-05T22:36:54.000Z',
      ...(i === 1 ? { toolUseResult: { agentId: 'a444444' } } : {}),
    })).join('\n') + '\n')
    const bodyRef = await spoolBody(env.spoolDir, 'replayed-parent.json', { messages })
    const event = {
      name: 'api_request_body', timestamp: '2026-09-05T22:36:55.000Z',
      attributes: { 'session.id': SESSION, body_ref: bodyRef, 'agent.name': 'general-purpose' },
    }
    const { bodies } = await loadSpooledBodies([event], { spoolDir: env.spoolDir })
    const [projection] = projectClaudeTelemetryEvents([event], {
      clientName: 'claude', usageByRequestId: new Map(), spooledBodies: bodies,
    })
    const settled = await settleBatch(env, aiGatewayRowsFromProjectedExchange(projection), [])
    assert.deepEqual(settled.map((row) => row.part_id), ['spawn-0#0', 'spawn-1#0'])
    assert.ok(settled.every((row) => !row.agent_id && !row.is_sidechain))
    assert.equal(/** @type {any} */ (settled[1].attributes)?.claude?.tool_use_result?.agentId, 'a444444')
  } finally {
    await env.cleanup()
  }
})

test('a header-derived agent_id survives a transcript line that names no agent', async () => {
  const env = await stageEnv()
  try {
    // The proxy lane stamps `agent_id` from the authoritative
    // `x-claude-code-agent-id` request header; `agent.name` stands in for it
    // here because settle.js reads only `row.agent_id`, never the header
    // itself. This row's tool_call_id will match a transcript line, and the
    // question is what that match is allowed to do to an agent_id the row
    // already carries from a source better than the transcript.
    const agentId = 'a555555'
    const call = { ...TOOL_BLOCK, id: 'toolu_headerid' }
    const bodyRef = await spoolBody(env.spoolDir, 'header-agent.json', {
      role: 'assistant', content: [call],
    })
    const event = {
      name: 'api_response_body', timestamp: '2026-09-05T22:36:55.000Z',
      attributes: { 'session.id': SESSION, body_ref: bodyRef, 'agent.name': agentId },
    }
    const { bodies } = await loadSpooledBodies([event], { spoolDir: env.spoolDir })
    const [projection] = projectClaudeTelemetryEvents([event], {
      clientName: 'claude', usageByRequestId: new Map(), spooledBodies: bodies,
    })
    const rows = aiGatewayRowsFromProjectedExchange(projection)
    assert.equal(rows[0].agent_id, agentId)

    const projectDir = path.join(env.homeDir, '.claude', 'projects', 'some-repo')
    await appendSessionContext(env.stateFile, {
      session_id: SESSION,
      transcript_path: path.join(projectDir, `${SESSION}.jsonl`),
      cwd: env.homeDir,
      git_branch: 'main',
      ts: '2026-09-05T22:36:50.000Z',
    })

    // The matched transcript line knows this thread is a sidechain but names
    // no agent (isSidechain: true, no agentId): a real subagent line can
    // carry exactly this shape. It knows less than the row's own agent_id.
    const dir = path.join(projectDir, SESSION, 'subagents')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `agent-${agentId}.jsonl`), JSON.stringify({
      sessionId: SESSION, isSidechain: true, type: 'assistant', uuid: 'headerid-call',
      message: { role: 'assistant', content: [call] }, timestamp: event.timestamp,
    }) + '\n')
    await fs.writeFile(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: 'spawn_headerid' }))

    const settled = await settleBatch(env, rows, [])
    assert.equal(settled[0].part_id, 'headerid-call#0', 'still gains the transcript-native part_id')
    assert.equal(settled[0].agent_id, agentId, 'the header-derived agent_id must not be cleared')
    assert.equal(
      /** @type {any} */ (settled[0].attributes)?.claude?.spawned_by_tool_use_id,
      'spawn_headerid',
      'clearing agent_id would also have skipped this late-stamp (wantsSpawnedBy requires a non-empty agent_id)'
    )
  } finally {
    await env.cleanup()
  }
})

test('a tool-id match with no transcript uuid falls through to the content-key match', async () => {
  const env = await stageEnv()
  try {
    const call = { ...TOOL_BLOCK, id: 'toolu_nouuidmatch' }
    const bodyRef = await spoolBody(env.spoolDir, 'nouuid.json', {
      role: 'assistant', content: [call],
    })
    const event = {
      name: 'api_response_body', timestamp: '2026-09-05T22:36:57.000Z',
      attributes: { 'session.id': SESSION, body_ref: bodyRef, 'agent.name': 'agentB' },
    }
    const { bodies } = await loadSpooledBodies([event], { spoolDir: env.spoolDir })
    const [projection] = projectClaudeTelemetryEvents([event], {
      clientName: 'claude', usageByRequestId: new Map(), spooledBodies: bodies,
    })
    const rows = aiGatewayRowsFromProjectedExchange(projection)
    assert.equal(rows[0].agent_id, 'agentB')

    // Main-loop transcript line: same block, same tool id, but no uuid - a
    // shape indexTranscriptEntries admits (it only guards `byUuid` on
    // provider_uuid, not `byToolCallId`). The later timestamp makes it the
    // one the flat, agent-unscoped byToolCallId map holds after both lines
    // are indexed.
    const file = path.join(env.homeDir, '.claude', 'projects', 'some-repo', `${SESSION}.jsonl`)
    await fs.appendFile(file, JSON.stringify({
      sessionId: SESSION, type: 'assistant',
      message: { role: 'assistant', content: [call] },
      timestamp: '2026-09-05T22:36:56.000Z',
    }) + '\n')

    // The subagent's own transcript line: the identical block, scoped to
    // agentB and carrying a native uuid. byContentKey is agent-scoped, so
    // this survives independently of the flat byToolCallId collision above.
    const dir = path.join(env.homeDir, '.claude', 'projects', 'some-repo', SESSION, 'subagents')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'agent-agentB.jsonl'), JSON.stringify({
      sessionId: SESSION, agentId: 'agentB', isSidechain: true, type: 'assistant',
      uuid: 'nouuidmatch-call',
      message: { role: 'assistant', content: [call] },
      timestamp: '2026-09-05T22:36:54.000Z',
    }) + '\n')

    const settled = await settleBatch(env, rows, [])
    assert.equal(
      settled[0].part_id,
      'nouuidmatch-call#0',
      'a uuid-less tool match must not swallow the content-key fallback'
    )
  } finally {
    await env.cleanup()
  }
})

// Two same-name subagents project into ONE merged `general-purpose` chain
// (the OTEL event labels a row by agent TYPE), so every row's
// `previous_message_id` comes from that merged label. Settlement then hands
// each row its own per-spawn `agent_id`, and the pointers are left naming
// the other agent's turns - or, once the predecessor settled too, naming a
// fallback hash id no row carries any more. Issue #2150.
// @ref LLP 0439#relink-from-the-transcript [tests]: a settled row that changed
// agent scope links to its own agent's predecessor, the line the sweep chains it to.
test('settlement keeps each subagent thread\'s previous_message_id inside that agent', async () => {
  const env = await stageEnv()
  try {
    const projectDir = path.join(env.homeDir, '.claude', 'projects', 'some-repo')
    await appendSessionContext(env.stateFile, {
      session_id: SESSION,
      transcript_path: path.join(projectDir, `${SESSION}.jsonl`),
      cwd: env.homeDir,
      git_branch: 'main',
      ts: '2026-09-05T22:36:50.000Z',
    })
    const agentsDir = path.join(projectDir, SESSION, 'subagents')
    await fs.mkdir(agentsDir, { recursive: true })
    const events = []
    for (const agentId of ['a111111', 'a222222']) {
      const call = { ...TOOL_BLOCK, id: `toolu_${agentId}` }
      const result = { ...RESULT_BLOCK, tool_use_id: call.id }
      const entries = [
        { role: 'assistant', content: [call], uuid: `${agentId}-call` },
        { role: 'user', content: [result], uuid: `${agentId}-result` },
      ]
      await fs.writeFile(path.join(agentsDir, `agent-${agentId}.jsonl`), entries.map((entry, i) => JSON.stringify({
        sessionId: SESSION, agentId, isSidechain: true, type: entry.role,
        uuid: entry.uuid,
        message: { role: entry.role, content: entry.content },
        timestamp: `2026-09-05T22:36:5${4 + i}.000Z`,
      })).join('\n') + '\n')
      await fs.writeFile(path.join(agentsDir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: `spawn_${agentId}` }))
      const bodyRef = await spoolBody(env.spoolDir, `chain-${agentId}.json`, {
        messages: entries.map(({ role, content }) => ({ role, content })),
      })
      events.push({
        name: 'api_request_body', timestamp: '2026-09-05T22:36:56.000Z',
        attributes: { 'session.id': SESSION, body_ref: bodyRef, 'agent.name': 'general-purpose' },
      })
    }
    const { bodies } = await loadSpooledBodies(events, { spoolDir: env.spoolDir })
    const [projection] = projectClaudeTelemetryEvents(events, {
      clientName: 'claude', usageByRequestId: new Map(), spooledBodies: bodies,
    })
    const settled = await settleBatch(env, aiGatewayRowsFromProjectedExchange(projection), [])
    assert.deepEqual(
      settled.map((row) => row.agent_id),
      ['a111111', 'a111111', 'a222222', 'a222222'],
      'the tool-id path must have handed each row its own per-spawn agent_id'
    )

    // Read against the agent_ids above: every link names a message of the
    // SAME agent, which is the chain the sweep writes for these lines (each
    // agent's opening turn is its thread root, its result follows its call).
    assert.deepEqual(
      settled.map((row) => [row.message_id, row.previous_message_id]),
      [
        ['a111111-call', []],
        ['a111111-result', ['a111111-call']],
        ['a222222-call', []],
        ['a222222-result', ['a222222-call']],
      ],
      'a settled row must link to its own agent\'s predecessor, not the merged chain\'s'
    )
  } finally {
    await env.cleanup()
  }
})
