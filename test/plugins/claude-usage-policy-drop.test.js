// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createClaudeExchangeProjector } from '../../hypaware-core/plugins-workspace/claude/src/projector.js'
import { createClaudeBackfillProvider } from '../../hypaware-core/plugins-workspace/claude/src/backfill.js'
import { appendSessionContext } from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/index.js'

/**
 * @ref LLP 0050 [tests]: the `.hypignore` capture-seam drop lives in the
 * Claude adapter. These tests prove both Claude drop-sites consult the shared
 * resolver and suppress an ignored `cwd` BEFORE any row is written: the live
 * projector returns no rows, and backfill skips the session. A clean `cwd` is
 * unaffected (LLP 0049#requirements R1/R2).
 *
 * @import { BackfillEvent, BackfillItem, BackfillRunContext } from '../../collectivus-plugin-kernel-types.js'
 */

const IGNORED_ROOT = '/work/ignored-repo'
const CLEAN_ROOT = '/work/clean-repo'

// ---------------------------------------------------------------------------
// Live projector
// ---------------------------------------------------------------------------

test('live projector returns no rows when the exchange cwd is governed by .hypignore', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'sess-ign', transcriptPair('sess-ign'))
    // The hook-written record stamps the ignored cwd onto the session.
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-ign',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(IGNORED_ROOT, 'src'),
      ts: '2026-05-22T09:59:00.000Z',
    })

    const rows = await projectViaGateway(env, {
      sessionId: 'sess-ign',
      resolver: resolverIgnoring(IGNORED_ROOT),
    })

    assert.equal(rows.length, 0, 'an ignored cwd must drop every row at the capture seam')
  } finally {
    await env.cleanup()
  }
})

test('live projector records normally when the exchange cwd is not ignored', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'sess-clean', transcriptPair('sess-clean'))
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-clean',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(CLEAN_ROOT, 'src'),
      ts: '2026-05-22T09:59:00.000Z',
    })

    // Same resolver as the drop case: only IGNORED_ROOT is governed, so a
    // clean cwd resolves to `full` and the exchange is recorded.
    const rows = await projectViaGateway(env, {
      sessionId: 'sess-clean',
      resolver: resolverIgnoring(IGNORED_ROOT),
    })

    assert.equal(rows.length, 2, 'a clean cwd must be unaffected: user + assistant rows land')
    assert.deepEqual(rows.map((r) => r.role).sort(), ['assistant', 'user'])
  } finally {
    await env.cleanup()
  }
})

test('live projector with no resolved cwd records normally (no folder to match)', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'sess-nocwd', transcriptPair('sess-nocwd'))
    // No session-context record => no cwd => the ignore check is skipped even
    // with a resolver that would ignore everything it is asked about.
    const rows = await projectViaGateway(env, {
      sessionId: 'sess-nocwd',
      resolver: { resolve: () => ({ class: 'ignore', governedBy: '/x/.hypignore', declared: 'ignore' }), isIgnored: () => true },
    })

    assert.equal(rows.length, 2, 'with no cwd there is nothing to match, so capture proceeds')
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

test('backfill skips an ignored session and yields only the clean one', async () => {
  const env = await stageEnv()
  try {
    // cwd rides each transcript line; one session is under the ignored root,
    // the other under a clean root.
    await writeTranscript(env, 'sess-bf-ign', transcriptPair('sess-bf-ign', path.join(IGNORED_ROOT, 'pkg')))
    await writeTranscript(env, 'sess-bf-clean', transcriptPair('sess-bf-clean', path.join(CLEAN_ROOT, 'pkg')))

    const provider = createClaudeBackfillProvider({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
      // Hermetic: never shell git for the clean session's repo derivation.
      deriveRepo: async () => ({}),
    })
    const { ctx, entries: logs } = runContext()
    const items = await collectItems(provider.run(ctx))

    assert.equal(items.length, 1, 'only the clean session is imported')
    assert.equal(items[0].provenance?.native_id, 'sess-bf-clean')

    // The drop is observable, and the scan summary counts only the kept session.
    assert.ok(
      logs.some((e) => e.message === 'claude.backfill.usage_policy_drop' && e.fields?.session_id === 'sess-bf-ign'),
      'an ignored session emits a usage_policy_drop event'
    )
    const scanDone = logs.find((e) => e.message === 'claude.backfill.scan_complete')
    assert.equal(scanDone?.fields?.sessions_projected, 1)
  } finally {
    await env.cleanup()
  }
})

test('backfill imports every session when none are ignored', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'sess-bf-a', transcriptPair('sess-bf-a', path.join(CLEAN_ROOT, 'a')))
    await writeTranscript(env, 'sess-bf-b', transcriptPair('sess-bf-b', path.join(CLEAN_ROOT, 'b')))

    const provider = createClaudeBackfillProvider({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
      deriveRepo: async () => ({}),
    })
    const { ctx } = runContext()
    const items = await collectItems(provider.run(ctx))

    assert.equal(items.length, 2, 'no ignored session means no drop')
    assert.deepEqual(
      items.map((i) => i.provenance?.native_id).sort(),
      ['sess-bf-a', 'sess-bf-b']
    )
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A resolver whose only governing `.hypignore` lives at `<ignoredRoot>/.hypignore`
 * and resolves to `ignore`. Built on the REAL core matcher with an injected fs,
 * so these tests exercise the production ancestor-walk path, not a stub.
 *
 * @param {string} ignoredRoot
 */
function resolverIgnoring(ignoredRoot) {
  const marker = path.join(ignoredRoot, '.hypignore')
  return createUsagePolicyResolver({
    existsSync: (p) => p === marker,
    readFileSync: () => 'ignore\n',
  })
}

/**
 * @returns {Promise<{ homeDir: string, stateFile: string, cleanup: () => Promise<void> }>}
 */
async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-usage-policy-'))
  const stateDir = path.join(homeDir, 'state')
  await fs.mkdir(stateDir, { recursive: true })
  return {
    homeDir,
    stateFile: path.join(stateDir, 'session-context.jsonl'),
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  }
}

/**
 * A user turn + an assistant turn, native-DAG wired. `cwd`, when given, rides
 * every transcript line (the only repo signal a backfill session carries).
 *
 * @param {string} sessionId
 * @param {string} [cwd]
 * @returns {Record<string, unknown>[]}
 */
function transcriptPair(sessionId, cwd) {
  const base = cwd ? { cwd } : {}
  return [
    { ...base, sessionId, uuid: 'u-1', parentUuid: null, type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-05-22T10:00:00.000Z' },
    { ...base, sessionId, uuid: 'a-1', parentUuid: 'u-1', type: 'assistant', message: { role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: 'hi' }] }, timestamp: '2026-05-22T10:00:01.000Z' },
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
 * Build the projector with the injected resolver, wrap it in the gateway
 * dispatcher (the production path), and project one synthetic exchange.
 *
 * @param {{ homeDir: string, stateFile: string }} env
 * @param {{ sessionId: string, resolver: import('../../src/core/usage-policy/types.js').UsagePolicyResolver }} call
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function projectViaGateway(env, call) {
  const projector = createClaudeExchangeProjector({
    homeDir: env.homeDir,
    stateFile: env.stateFile,
    resolver: call.resolver,
  })
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
    request_body: JSON.stringify({
      model: 'claude-3-opus',
      metadata: { user_id: JSON.stringify({ session_id: call.sessionId }) },
      messages: [{ role: 'user', content: 'hello' }],
    }),
    response_headers: JSON.stringify({ 'content-type': 'application/json' }),
    response_body: JSON.stringify({ id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }),
    error: null,
    metadata: JSON.stringify({ dev_run_id: 'run-1' }),
    stream_events: [],
  })
}

function captureLog() {
  /** @type {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} */
  const entries = []
  /** @param {string} level */
  const at = (level) => (/** @type {string} */ message, /** @type {Record<string, unknown>=} */ fields) => {
    entries.push({ level, message, fields })
  }
  return { entries, log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } }
}

/**
 * @returns {{ ctx: BackfillRunContext, entries: any[] }}
 */
function runContext() {
  const { entries, log } = captureLog()
  /** @type {BackfillRunContext} */
  const ctx = {
    env: {},
    cacheRoot: path.join(os.tmpdir(), 'claude-usage-policy-cache-unused'),
    dryRun: false,
    log,
    storage: /** @type {any} */ ({}),
  }
  return { ctx, entries }
}

/**
 * @param {AsyncIterable<BackfillItem | BackfillEvent>} iterable
 * @returns {Promise<BackfillItem[]>}
 */
async function collectItems(iterable) {
  /** @type {BackfillItem[]} */
  const items = []
  for await (const yielded of iterable) {
    if (yielded.type !== 'event') items.push(/** @type {BackfillItem} */ (yielded))
  }
  return items
}
