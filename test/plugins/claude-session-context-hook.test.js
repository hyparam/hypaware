// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createClaudeExchangeProjector } from '../../hypaware-core/plugins-workspace/claude/src/projector.js'
import { appendSessionContext, defaultSessionContextFile, pickLatestMatching, readSessionContext } from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'

/**
 * Roundtrip test for the phase-2 session-context channel — the path
 * that used to be `POST /_hypaware/session-context` on the gateway
 * and now lives entirely on disk:
 *
 *  1. `hyp claude-hook session-context --state-file <path>` appends a
 *     record (driven directly via `dispatch()` to exercise the same
 *     code path Claude Code would).
 *  2. `readSessionContext()` reads it back and `pickLatestMatching()`
 *     picks the newest matching entry.
 *  3. The Claude exchange projector, wrapped in the gateway
 *     dispatcher, uses that record to stamp `cwd` and `git_branch`
 *     on the projected row.
 *
 * Replaces `test/plugins/ai-gateway-session-context.test.js` (deleted
 * in phase 1 along with the HTTP endpoint).
 */
test('hook → state file → projector roundtrip writes cwd onto the row', async () => {
  const env = await stageEnv()
  try {
    // Stage 1: hook writes a record into the state file.
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(
      ['claude-hook', 'session-context', '--state-file', env.stateFile],
      {
        stdout,
        stderr,
        stdin: stdinFor({
          session_id: 'sess-roundtrip',
          cwd: '/Users/me/code/some-repo',
          transcript_path: '/Users/me/.claude/projects/some-repo/sess-roundtrip.jsonl',
          hook_event_name: 'SessionStart',
        }),
        env: { ...process.env, HYP_HOME: env.hypHome },
      }
    )
    assert.equal(code, 0)
    assert.equal(stderr.text(), '')

    // Stage 2: read it back and pick the latest matching record.
    const records = await readSessionContext(env.stateFile)
    assert.equal(records.length, 1)
    const latest = pickLatestMatching(records, { sessionId: 'sess-roundtrip' })
    assert.ok(latest)
    assert.equal(latest.cwd, '/Users/me/code/some-repo')
    assert.equal(latest.transcript_path, '/Users/me/.claude/projects/some-repo/sess-roundtrip.jsonl')

    // Stage 3: the projector dispatches an Anthropic exchange and
    // returns rows carrying the state-file cwd. No transcript on disk
    // for this session, so identity falls back to the gateway hash
    // path — that's expected and exactly what the smoke for missing
    // transcripts asserts as well.
    const projector = createClaudeExchangeProjector({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
    })
    const dispatcher = createAiGatewayMessageProjector({
      gatewayId: 'gw-test',
      projectors: [{ ...projector, _seq: 0 }],
    })
    const rows = await dispatcher.projectExchange(syntheticExchange({
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-roundtrip' }) },
        messages: [{ role: 'user', content: 'hello' }],
      },
    }))
    assert.ok(rows.length >= 1)
    for (const row of rows) {
      assert.equal(row.cwd, '/Users/me/code/some-repo')
    }
  } finally {
    await env.cleanup()
  }
})

test('pickLatestMatching prefers newer records when multiple share a session_id', async () => {
  const env = await stageEnv()
  try {
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-a',
      cwd: '/first',
      transcript_path: undefined,
      git_branch: undefined,
      ts: '2026-05-22T10:00:00.000Z',
    })
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-a',
      cwd: '/second',
      transcript_path: undefined,
      git_branch: undefined,
      ts: '2026-05-22T11:00:00.000Z',
    })
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-b',
      cwd: '/other',
      transcript_path: undefined,
      git_branch: undefined,
      ts: '2026-05-22T11:30:00.000Z',
    })
    const records = await readSessionContext(env.stateFile)
    assert.equal(records.length, 3)
    const latestA = pickLatestMatching(records, { sessionId: 'sess-a' })
    assert.equal(latestA?.cwd, '/second')
    const latestB = pickLatestMatching(records, { sessionId: 'sess-b' })
    assert.equal(latestB?.cwd, '/other')
    const missing = pickLatestMatching(records, { sessionId: 'sess-missing' })
    assert.equal(missing, undefined)
  } finally {
    await env.cleanup()
  }
})

test('pickLatestMatching prefers transcript_path over session_id when both keys hit', async () => {
  const env = await stageEnv()
  try {
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-x',
      cwd: '/from-sessionid',
      transcript_path: undefined,
      git_branch: undefined,
      ts: '2026-05-22T10:00:00.000Z',
    })
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-y',
      cwd: '/from-transcript',
      transcript_path: '/tmp/abc.jsonl',
      git_branch: undefined,
      ts: '2026-05-22T11:00:00.000Z',
    })
    const records = await readSessionContext(env.stateFile)
    const picked = pickLatestMatching(records, {
      sessionId: 'sess-x',
      transcriptPath: '/tmp/abc.jsonl',
    })
    assert.equal(picked?.cwd, '/from-transcript', 'transcript_path match wins over session_id match')
  } finally {
    await env.cleanup()
  }
})

test('defaultSessionContextFile resolves under the plugin state dir', () => {
  const stateDir = path.join(os.tmpdir(), 'state-dir')
  const expected = path.join(stateDir, 'session-context.jsonl')
  assert.equal(defaultSessionContextFile(stateDir), expected)
})

/**
 * @returns {Promise<{ homeDir: string, hypHome: string, stateFile: string, cleanup: () => Promise<void> }>}
 */
async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-hook-roundtrip-'))
  const hypHome = path.join(homeDir, '.hyp')
  await fs.mkdir(hypHome, { recursive: true })
  const stateDir = path.join(hypHome, 'state', '@hypaware-claude')
  await fs.mkdir(stateDir, { recursive: true })
  const stateFile = path.join(stateDir, 'session-context.jsonl')
  return {
    homeDir,
    hypHome,
    stateFile,
    cleanup: async () => {
      await fs.rm(homeDir, { recursive: true, force: true })
    },
  }
}

/**
 * @param {{ reqBody: Record<string, unknown> }} call
 */
function syntheticExchange(call) {
  return {
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
    response_headers: null,
    response_body: null,
    error: null,
    metadata: JSON.stringify({ dev_run_id: 'run-1' }),
    stream_events: [],
  }
}

/**
 * @param {string | Record<string, unknown>} value
 */
function stdinFor(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return /** @type {NodeJS.ReadStream} */ (Readable.from([body]))
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() { return chunks.join('') },
  }
}

// `registerCoreCommands` is referenced through the dispatch path; the
// import keeps tree-shakers from dropping it when this test runs in
// isolation. (No-op assertion, but compiles the symbol.)
assert.equal(typeof registerCoreCommands, 'function')
