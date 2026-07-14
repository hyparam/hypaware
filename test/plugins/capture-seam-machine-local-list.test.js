// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createClaudeExchangeProjector } from '../../hypaware-core/plugins-workspace/claude/src/projector.js'
import { createCodexExchangeProjector } from '../../hypaware-core/plugins-workspace/codex/src/exchange-projector.js'
import { appendSessionContext } from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'
import {
  USAGE_POLICY_DROP,
  localOnlyListPath,
  writeLocalOnlyEntries,
} from '../../src/core/usage-policy/index.js'

/**
 * @ref LLP 0103 [tests]: the capture-seam resolvers honor the machine-local
 * usage-policy list, not just `.hypignore` dotfiles. Constructing the real
 * Claude and Codex projectors with `localOnlyListPath` (and NO injected
 * resolver) proves the production wiring: a directory marked `ignore` in the
 * machine-local list (`hyp ignore --private`) DROPS at the capture seam so
 * nothing is recorded, while a directory marked `local-only` (`hyp ignore
 * --local-only`) is STILL recorded here - it is queryable locally and withheld
 * only later at the export seam (LLP 0070/0105). Before this wiring the
 * factories fell back to a dotfile-only resolver blind to the list, so a
 * `--private` dir kept recording and `hyp backfill` re-imported it after a
 * purge.
 *
 * @import { BackfillEvent, BackfillItem, BackfillRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

const IGNORED_ROOT = '/work/private-repo'
const LOCAL_ONLY_ROOT = '/work/local-only-repo'

// ---------------------------------------------------------------------------
// Claude live projector, wired through the real machine-local list.
// ---------------------------------------------------------------------------

test('claude projector drops a session whose cwd is marked `ignore` in the machine-local list', async () => {
  const env = await stageEnv()
  try {
    await writeList(env.stateDir)
    await writeTranscript(env, 'sess-ign', transcriptPair('sess-ign'))
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-ign',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(IGNORED_ROOT, 'src'),
      ts: '2026-07-13T09:59:00.000Z',
    })

    const rows = await projectClaudeViaGateway(env, 'sess-ign')
    assert.equal(rows.length, 0, 'a machine-local `ignore` dir must drop every row at capture')
  } finally {
    await env.cleanup()
  }
})

test('claude projector still records a session whose cwd is marked `local-only` in the machine-local list', async () => {
  const env = await stageEnv()
  try {
    await writeList(env.stateDir)
    await writeTranscript(env, 'sess-lo', transcriptPair('sess-lo'))
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-lo',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(LOCAL_ONLY_ROOT, 'src'),
      ts: '2026-07-13T09:59:00.000Z',
    })

    const rows = await projectClaudeViaGateway(env, 'sess-lo')
    assert.equal(rows.length, 2, 'a `local-only` dir is recorded at capture (withheld later at export), not dropped')
    assert.deepEqual(rows.map((r) => r.role).sort(), ['assistant', 'user'])
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Codex live projector, same list, in-band cwd.
// ---------------------------------------------------------------------------

test('codex projector drops an exchange whose cwd is marked `ignore` in the machine-local list', async () => {
  const env = await stageEnv()
  try {
    await writeList(env.stateDir)
    const projector = createCodexExchangeProjector({
      localOnlyListPath: localOnlyListPath(env.stateDir),
    })
    const projection = projector.project(
      codexExchange(path.join(IGNORED_ROOT, 'sub')),
      { log: { debug() {}, info() {}, warn() {}, error() {} } }
    )
    assert.equal(projection, USAGE_POLICY_DROP, 'a machine-local `ignore` dir must drop the codex exchange at capture')
  } finally {
    await env.cleanup()
  }
})

test('codex projector still records an exchange whose cwd is marked `local-only` in the machine-local list', async () => {
  const env = await stageEnv()
  try {
    await writeList(env.stateDir)
    const projector = createCodexExchangeProjector({
      localOnlyListPath: localOnlyListPath(env.stateDir),
    })
    const projection = /** @type {any} */ (projector.project(
      codexExchange(LOCAL_ONLY_ROOT),
      { log: { debug() {}, info() {}, warn() {}, error() {} } }
    ))
    assert.notEqual(projection, USAGE_POLICY_DROP, 'a `local-only` dir is recorded at capture, not dropped')
    assert.ok(projection && Array.isArray(projection.messages), 'the exchange projects to real rows')
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write the machine-local usage-policy list (LLP 0103) for `stateDir`: one
 * `ignore` entry and one `local-only` entry, via the same writer the CLI
 * marking verbs use.
 *
 * @param {string} stateDir
 */
async function writeList(stateDir) {
  await writeLocalOnlyEntries({
    stateDir,
    entries: [
      { dir: IGNORED_ROOT, class: 'ignore' },
      { dir: LOCAL_ONLY_ROOT, class: 'local-only' },
    ],
  })
}

/**
 * @returns {Promise<{ homeDir: string, stateDir: string, stateFile: string, cleanup: () => Promise<void> }>}
 */
async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-seam-list-'))
  const stateDir = path.join(homeDir, 'state')
  await fs.mkdir(stateDir, { recursive: true })
  return {
    homeDir,
    stateDir,
    stateFile: path.join(stateDir, 'session-context.jsonl'),
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  }
}

/**
 * Build the Claude projector with the real machine-local list path (NO
 * injected resolver: the point is the production wiring), wrap it in the
 * gateway dispatcher, and project one synthetic exchange.
 *
 * @param {{ homeDir: string, stateDir: string, stateFile: string }} env
 * @param {string} sessionId
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function projectClaudeViaGateway(env, sessionId) {
  const projector = createClaudeExchangeProjector({
    homeDir: env.homeDir,
    stateFile: env.stateFile,
    localOnlyListPath: localOnlyListPath(env.stateDir),
  })
  const dispatcher = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [{ ...projector, _seq: 0 }],
  })
  return dispatcher.projectExchange(claudeExchange(sessionId))
}

/**
 * @param {string} sessionId
 * @returns {Record<string, unknown>[]}
 */
function transcriptPair(sessionId) {
  return [
    { sessionId, uuid: 'u-1', parentUuid: null, type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-07-13T10:00:00.000Z' },
    { sessionId, uuid: 'a-1', parentUuid: 'u-1', type: 'assistant', message: { role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: 'hi' }] }, timestamp: '2026-07-13T10:00:01.000Z' },
  ]
}

/**
 * @param {{ homeDir: string }} env
 * @param {string} sessionId
 * @param {Record<string, unknown>[]} rows
 */
async function writeTranscript(env, sessionId, rows) {
  const dir = path.join(env.homeDir, '.claude', 'projects', 'some-repo')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  )
}

/**
 * One synthetic Anthropic `/v1/messages` exchange stamped with `sessionId`.
 *
 * @param {string} sessionId
 */
function claudeExchange(sessionId) {
  return {
    exchange_id: 'ex-1',
    ts_start: '2026-07-13T10:00:05.000Z',
    ts_end: '2026-07-13T10:00:05.250Z',
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
    request_body: JSON.stringify({
      model: 'claude-3-opus',
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
      messages: [{ role: 'user', content: 'hello' }],
    }),
    response_headers: JSON.stringify({ 'content-type': 'application/json' }),
    response_body: JSON.stringify({ id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }),
    error: null,
    metadata: JSON.stringify({ dev_run_id: 'run-1' }),
    stream_events: [],
  }
}

/**
 * One synthetic Codex `/v1/chat/completions` exchange carrying an in-band cwd.
 *
 * @param {string} cwd
 */
function codexExchange(cwd) {
  return /** @type {any} */ ({
    exchange_id: 'ex-1',
    ts_start: '2026-07-13T10:00:00.000Z',
    ts_end: '2026-07-13T10:00:00.250Z',
    duration_ms: 250,
    upstream: 'local',
    provider: null,
    method: 'POST',
    path: '/v1/chat/completions',
    status_code: 200,
    request_bytes: 50,
    response_bytes: 100,
    is_sse: false,
    stream_event_count: 0,
    request_headers: JSON.stringify({}),
    request_body: JSON.stringify({
      cwd,
      messages: [{ role: 'user', content: 'secret' }],
    }),
    response_headers: JSON.stringify({}),
    response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    error: null,
    metadata: '',
    stream_events: [],
  })
}
