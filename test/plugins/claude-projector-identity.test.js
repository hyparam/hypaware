// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createClaudeExchangeProjector } from '../../hypaware-core/plugins-workspace/claude/src/projector.js'

/**
 * End-to-end identity tests for the Claude exchange projector. Each
 * test wires the Claude projector through the gateway core's
 * dispatcher (with no other projector registered) so the assertions
 * cover the same path that runs in production — including the
 * gateway's fallback hash identity stamp.
 */

test('native DAG identity: uuid from JSONL transcript becomes message_id and provider_uuid', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-1', [
      jsonlRow({
        sessionId: 'sess-1',
        uuid: 'u-user-1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'hello' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-1',
        uuid: 'u-assistant-1',
        parentUuid: 'u-user-1',
        type: 'assistant',
        message: { role: 'assistant', id: 'msg_abc', content: [{ type: 'text', text: 'hi' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-1' }) },
        messages: [{ role: 'user', content: 'hello' }],
      },
      responseBody: { id: 'msg_abc', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' },
    })

    assert.equal(rows.length, 2)
    const userRows = rows.filter((r) => r.role === 'user')
    const assistantRows = rows.filter((r) => r.role === 'assistant')
    assert.equal(userRows.length, 1)
    assert.equal(assistantRows.length, 1)

    // Native identity: message_id == provider_uuid == transcript uuid.
    assert.equal(userRows[0].message_id, 'u-user-1')
    assert.equal(userRows[0].provider_uuid, 'u-user-1')
    assert.equal(assistantRows[0].message_id, 'u-assistant-1')
    assert.equal(assistantRows[0].provider_uuid, 'u-assistant-1')

    // Native DAG: assistant.previous_message_id is the parent's uuid.
    assert.deepEqual(assistantRows[0].previous_message_id, ['u-user-1'])

    // Gateway must NOT stamp identity_source when the projector
    // supplied message_id — the assertion guards the projector against
    // a regression that drops `message_id` and silently falls back.
    for (const row of rows) {
      const claude = readAttrPath(row, ['attributes', 'claude'])
      const gateway = readAttrPath(row, ['attributes', 'gateway'])
      assert.notEqual(claude?.identity_source, 'gateway_fallback', 'transcript-matched row must not be marked as fallback')
      assert.notEqual(gateway?.identity_source, 'gateway_fallback', 'gateway must not stamp fallback when projector supplies message_id')
    }
  } finally {
    await env.cleanup()
  }
})

test('root message gets previous_message_id = [] when parentUuid is null', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-root', [
      jsonlRow({
        sessionId: 'sess-root',
        uuid: 'u-root',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'first' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-root' }) },
        messages: [{ role: 'user', content: 'first' }],
      },
      responseBody: undefined,
    })

    assert.equal(rows.length, 1)
    assert.equal(rows[0].message_id, 'u-root')
    assert.deepEqual(rows[0].previous_message_id, [], 'root message must carry an empty previous_message_id array')
  } finally {
    await env.cleanup()
  }
})

test('missing transcript → gateway fallback identity + claude.identity_source marker', async () => {
  const env = await stageClaudeEnv()
  try {
    // No transcript file is written for this session.
    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-missing' }) },
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
        ],
      },
      responseBody: undefined,
    })

    assert.equal(rows.length, 2)
    // Gateway computed a hash message_id (deterministic but not a uuid).
    for (const row of rows) {
      assert.equal(typeof row.message_id, 'string')
      assert.equal(row.provider_uuid, undefined, 'no transcript means no provider_uuid')
    }
    // The gateway stamps its own fallback marker AND the Claude
    // projector stamps its own — both must be present so the row is
    // unambiguous to operators querying by either marker.
    for (const row of rows) {
      const claude = readAttrPath(row, ['attributes', 'claude'])
      const gateway = readAttrPath(row, ['attributes', 'gateway'])
      assert.equal(claude?.identity_source, 'gateway_fallback')
      assert.equal(gateway?.identity_source, 'gateway_fallback')
    }
  } finally {
    await env.cleanup()
  }
})

test('session-context state file supplies cwd and git_branch on the row', async () => {
  const env = await stageClaudeEnv()
  try {
    await fs.writeFile(
      env.stateFile,
      JSON.stringify({
        session_id: 'sess-ctx',
        cwd: '/Users/me/proj',
        git_branch: 'feature/abc',
        ts: '2026-05-22T09:59:00.000Z',
      }) + '\n',
      'utf8'
    )

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-ctx' }) },
        messages: [{ role: 'user', content: 'hello' }],
      },
      responseBody: undefined,
    })

    assert.ok(rows.length >= 1)
    for (const row of rows) {
      assert.equal(row.cwd, '/Users/me/proj')
      assert.equal(row.git_branch, 'feature/abc')
    }
  } finally {
    await env.cleanup()
  }
})

test('exchange without anthropic signature is skipped by match()', async () => {
  const env = await stageClaudeEnv()
  try {
    const projector = createClaudeExchangeProjector({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
    })
    assert.equal(projector.match({
      exchange_id: 'ex-1',
      ts_start: '2026-05-22T10:00:00.000Z',
      ts_end: null,
      duration_ms: null,
      upstream: 'openai',
      provider: null,
      method: 'POST',
      path: '/v1/chat/completions',
      status_code: null,
      request_bytes: null,
      response_bytes: null,
      is_sse: null,
      stream_event_count: null,
      request_headers: JSON.stringify({ 'user-agent': 'curl/8.0' }),
      request_body: null,
      response_headers: null,
      response_body: null,
      error: null,
      metadata: null,
      stream_events: [],
    }), false)
  } finally {
    await env.cleanup()
  }
})

test('match() accepts /v1/messages path even without anthropic headers', async () => {
  const env = await stageClaudeEnv()
  try {
    const projector = createClaudeExchangeProjector({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
    })
    assert.equal(projector.match({
      exchange_id: 'ex-1',
      ts_start: '2026-05-22T10:00:00.000Z',
      ts_end: null,
      duration_ms: null,
      upstream: 'anthropic',
      provider: null,
      method: 'POST',
      path: '/v1/messages',
      status_code: null,
      request_bytes: null,
      response_bytes: null,
      is_sse: null,
      stream_event_count: null,
      request_headers: null,
      request_body: null,
      response_headers: null,
      response_body: null,
      error: null,
      metadata: null,
      stream_events: [],
    }), true)
  } finally {
    await env.cleanup()
  }
})

test('match() accepts requests with anthropic-version header on non-canonical paths', async () => {
  const env = await stageClaudeEnv()
  try {
    const projector = createClaudeExchangeProjector({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
    })
    assert.equal(projector.match({
      exchange_id: 'ex-1',
      ts_start: '2026-05-22T10:00:00.000Z',
      ts_end: null,
      duration_ms: null,
      upstream: 'anthropic',
      provider: null,
      method: 'POST',
      path: '/proxy/messages',
      status_code: null,
      request_bytes: null,
      response_bytes: null,
      is_sse: null,
      stream_event_count: null,
      request_headers: JSON.stringify({ 'anthropic-version': '2023-06-01' }),
      request_body: null,
      response_headers: null,
      response_body: null,
      error: null,
      metadata: null,
      stream_events: [],
    }), true)
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * @returns {Promise<{ homeDir: string, stateDir: string, stateFile: string, cleanup: () => Promise<void> }>}
 */
async function stageClaudeEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-projector-'))
  const stateDir = path.join(homeDir, 'state')
  await fs.mkdir(stateDir, { recursive: true })
  const stateFile = path.join(stateDir, 'session-context.jsonl')
  return {
    homeDir,
    stateDir,
    stateFile,
    cleanup: async () => {
      await fs.rm(homeDir, { recursive: true, force: true })
    },
  }
}

/**
 * @param {{ homeDir: string }} env
 * @param {string} sessionId
 * @param {string[]} lines
 */
async function writeTranscript(env, sessionId, lines) {
  const projectsDir = path.join(env.homeDir, '.claude', 'projects', 'some-repo')
  await fs.mkdir(projectsDir, { recursive: true })
  await fs.writeFile(
    path.join(projectsDir, `${sessionId}.jsonl`),
    lines.join('\n') + '\n',
    'utf8'
  )
}

/**
 * @param {Record<string, unknown>} obj
 */
function jsonlRow(obj) {
  return JSON.stringify(obj)
}

/**
 * Build the projector, wrap it in the gateway's dispatcher (so the
 * fallback identity path and `attributes.gateway.*` stamping run),
 * and project one synthetic exchange.
 *
 * @param {{ homeDir: string, stateFile: string }} env
 * @param {{ reqBody: Record<string, unknown>, responseBody: unknown, streamEvents?: Array<{ data: string, event?: string }> }} call
 */
async function projectViaGateway(env, call) {
  const projector = createClaudeExchangeProjector({
    homeDir: env.homeDir,
    stateFile: env.stateFile,
  })
  // Wrap as the gateway's `RegisteredProjector` shape.
  const dispatcher = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [{ ...projector, _seq: 0 }],
  })
  return dispatcher.projectExchange({
    exchange_id: 'ex-1',
    ts_start: '2026-05-22T10:00:05.000Z',
    ts_end: '2026-05-22T10:00:05.250Z',
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
    request_headers: JSON.stringify({ 'anthropic-version': '2023-06-01', 'user-agent': 'claude-cli/1.0' }),
    request_body: JSON.stringify(call.reqBody),
    response_headers: JSON.stringify({ 'content-type': 'application/json' }),
    response_body: call.responseBody === undefined ? null : JSON.stringify(call.responseBody),
    error: null,
    metadata: JSON.stringify({ dev_run_id: 'run-1' }),
    stream_events: call.streamEvents ?? [],
  })
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} path
 */
function readAttrPath(row, path) {
  /** @type {unknown} */
  let cur = row
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = /** @type {Record<string, unknown>} */ (cur)[key]
  }
  return /** @type {Record<string, unknown> | undefined} */ (
    cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : undefined
  )
}
