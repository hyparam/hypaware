// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createCodexExchangeProjector,
} from '../../hypaware-core/plugins-workspace/codex/src/exchange-projector.js'
import { createRolloutCwdResolver } from '../../hypaware-core/plugins-workspace/codex/src/rollout-cwd.js'
import { createUsagePolicyResolver, USAGE_POLICY_DROP } from '../../src/core/usage-policy/index.js'

/**
 * A real usage-policy resolver wired to an injected fs that reports exactly one
 * governing `.hypignore` (class `ignore`) at `<ignoredDir>/.hypignore`. Mirrors
 * the codex-exchange-projector tests: exercise the actual shared matcher, not a
 * hand-rolled stub.
 *
 * @param {string} ignoredDir
 */
function ignoringResolver(ignoredDir) {
  const hypignore = path.join(ignoredDir, '.hypignore')
  return createUsagePolicyResolver({
    existsSync: (p) => p === hypignore,
    readFileSync: () => 'ignore\n',
  })
}

/**
 * A fake rollout cwd resolver: maps a session id to the cwd its rollout would
 * carry. Used for the projector-wiring tests (no fs needed); the file-reading
 * behaviour of the real resolver is covered separately below.
 *
 * @param {Record<string, string>} bySession
 * @returns {{ resolve(sessionId: string): string | undefined }}
 */
function fakeRolloutCwd(bySession) {
  return { resolve: (sessionId) => bySession[sessionId] }
}

// A realistic subscription-route session id: a UUID the rollout filename embeds.
const SUBSCRIPTION_SESSION_ID = '019e60b5-1111-4222-8333-444455556666'

// ---------------------------------------------------------------------
// Regression (#257): the ChatGPT-subscription route carries no in-band cwd, so
// the live projector must fall back to the session rollout's session_meta.cwd —
// otherwise `.hypignore` fails open for the whole traffic class and the row
// records cwd = NULL (diverging from backfill, which DOES read the rollout).
// ---------------------------------------------------------------------

test('subscription-route Codex with no in-band cwd is .hypignore-dropped via the rollout cwd', () => {
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: fakeRolloutCwd({ [SUBSCRIPTION_SESSION_ID]: '/work/ignored/proj' }),
  })
  const projection = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    // codex-tui does NOT send x-codex-turn-metadata on the subscription route;
    // it does carry a session-id header, which the adapter already resolves.
    request_headers: JSON.stringify({ 'session-id': SUBSCRIPTION_SESSION_ID }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'secret work' }),
    response_body: JSON.stringify({ output_text: 'ok' }),
  }), context())
  // The rollout cwd (`/work/ignored/proj`) is covered by `/work/ignored/.hypignore`,
  // so the exchange must be dropped at the capture seam (LLP 0049 R1).
  assert.equal(projection, USAGE_POLICY_DROP)
})

test('subscription-route Codex records the rollout cwd on the row (live/backfill parity)', () => {
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: fakeRolloutCwd({ [SUBSCRIPTION_SESSION_ID]: '/work/clean/proj' }),
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({ 'session-id': SUBSCRIPTION_SESSION_ID }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'hello' }),
    response_body: JSON.stringify({ output_text: 'hi' }),
  }), context()))
  assert.ok(projection && projection !== USAGE_POLICY_DROP)
  // Without the rollout fallback the row would carry cwd = NULL; with it, live
  // rows carry the same cwd backfill reads from session_meta.
  assert.equal(projection.cwd, '/work/clean/proj')
})

test('an in-band cwd stays the fast path and short-circuits the rollout lookup', () => {
  let lookups = 0
  const rolloutCwd = {
    /** @param {string} _sessionId */
    resolve(_sessionId) { lookups += 1; return '/work/from-rollout' },
  }
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/never'),
    rolloutCwd,
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'session-id': SUBSCRIPTION_SESSION_ID,
      'x-codex-turn-metadata': JSON.stringify({
        session_id: SUBSCRIPTION_SESSION_ID,
        workspaces: { '/work/in-band': {} },
      }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'hi', cwd: '/work/in-band' }),
    response_body: JSON.stringify({ output_text: 'ok' }),
  }), context()))
  assert.ok(projection && projection !== USAGE_POLICY_DROP)
  assert.equal(projection.cwd, '/work/in-band')
  assert.equal(lookups, 0, 'the rollout is not consulted when the request already carries a cwd')
})

// ---------------------------------------------------------------------
// createRolloutCwdResolver: reads session_meta.cwd from the session's rollout
// file (the same source backfill reads), keyed by the session id embedded in
// the rollout filename, cached per session id (LLP 0049 R6).
// ---------------------------------------------------------------------

test('createRolloutCwdResolver reads session_meta.cwd from the session rollout', async () => {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-cwd-'))
  const rolloutPath = path.join(
    sessionsDir, '2026', '07', '07',
    `rollout-2026-07-07T10-00-00-${SUBSCRIPTION_SESSION_ID}.jsonl`
  )
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true })
  const lines = [
    JSON.stringify({
      timestamp: '2026-07-07T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: SUBSCRIPTION_SESSION_ID, cwd: '/work/rolled', originator: 'codex-tui' },
    }),
    JSON.stringify({
      timestamp: '2026-07-07T10:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    }),
  ]
  await fs.writeFile(rolloutPath, lines.join('\n') + '\n', 'utf8')

  const resolver = createRolloutCwdResolver({ sessionsDir })
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), '/work/rolled')
  // Unknown session ids resolve to undefined (fail open only when the rollout
  // genuinely lacks the session).
  assert.equal(resolver.resolve('no-such-session'), undefined)
})

test('createRolloutCwdResolver caches per session id (bounded fs on the hot path)', async () => {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-cwd-'))
  const rolloutPath = path.join(sessionsDir, `rollout-2026-07-07T10-00-00-${SUBSCRIPTION_SESSION_ID}.jsonl`)
  await fs.writeFile(
    rolloutPath,
    JSON.stringify({ type: 'session_meta', payload: { id: SUBSCRIPTION_SESSION_ID, cwd: '/work/rolled' } }) + '\n',
    'utf8'
  )
  const resolver = createRolloutCwdResolver({ sessionsDir })
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), '/work/rolled')

  // Delete the file: a cached session id must not re-hit the filesystem.
  await fs.rm(rolloutPath)
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), '/work/rolled')
})

test('createRolloutCwdResolver returns undefined when the sessions root is missing', () => {
  const resolver = createRolloutCwdResolver({ sessionsDir: '/no/such/sessions/root' })
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), undefined)
})

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

/** @param {Record<string, unknown>} overrides */
function exchange(overrides = {}) {
  return /** @type {any} */ ({
    exchange_id: 'ex-1',
    ts_start: '2026-07-07T10:00:00.000Z',
    ts_end: '2026-07-07T10:00:00.250Z',
    duration_ms: 250,
    upstream: 'local',
    provider: null,
    method: 'POST',
    path: '/backend-api/codex/responses',
    status_code: 200,
    request_bytes: 50,
    response_bytes: 100,
    is_sse: false,
    stream_event_count: 0,
    request_headers: JSON.stringify({}),
    request_body: '',
    response_headers: JSON.stringify({}),
    response_body: '',
    error: null,
    metadata: '',
    stream_events: [],
    ...overrides,
  })
}

function context() {
  return { log: { debug() {}, info() {}, warn() {}, error() {} } }
}
