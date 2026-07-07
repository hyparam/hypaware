// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
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
// Review round 1, Major 1: a miss (not-yet-written rollout on a session's
// first exchange, or a transient read error) must NOT be cached as a permanent
// NULL cwd — that would silently fail `.hypignore` open for the session's whole
// life once the rollout became readable. A resolved cwd stays cached for life.
// ---------------------------------------------------------------------

test('a missing-then-present rollout is re-resolved after the negative TTL, but a miss is cached within it', async () => {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-cwd-'))
  let clock = 1_000
  const scan = countingReaddir()
  const resolver = createRolloutCwdResolver({
    sessionsDir, now: () => clock, ttlMs: 5_000, readdirSync: scan.readdirSync,
  })

  // First exchange: the rollout is not written yet -> a miss.
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), undefined)
  const scansAfterMiss = scan.calls.length
  assert.ok(scansAfterMiss > 0, 'the first miss actually scanned the tree')

  // A repeat within the TTL window is served from the negative cache: no rescan.
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), undefined)
  assert.equal(scan.calls.length, scansAfterMiss, 'a miss is cached within its TTL — no re-scan')

  // The rollout appears (the session-start race resolves) and the TTL lapses.
  const rolloutPath = path.join(sessionsDir, `rollout-2026-07-07T10-00-00-${SUBSCRIPTION_SESSION_ID}.jsonl`)
  await fs.writeFile(rolloutPath, sessionMeta(SUBSCRIPTION_SESSION_ID, '/work/late'), 'utf8')
  clock += 5_001

  // Re-checked, not stuck at undefined for the session's life.
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), '/work/late')
  assert.ok(scan.calls.length > scansAfterMiss, 'the miss is re-scanned once its TTL lapses')

  // And the resolved cwd is now cached permanently (no TTL), even far in future.
  const scansAfterResolve = scan.calls.length
  clock += 1_000_000
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), '/work/late')
  assert.equal(scan.calls.length, scansAfterResolve, 'a resolved cwd is cached for the session life — never re-scanned')
})

test('a transient read error is retried rather than cached as a permanent miss', async () => {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-cwd-'))
  const rolloutPath = path.join(sessionsDir, `rollout-2026-07-07T10-00-00-${SUBSCRIPTION_SESSION_ID}.jsonl`)
  await fs.writeFile(rolloutPath, sessionMeta(SUBSCRIPTION_SESSION_ID, '/work/ok'), 'utf8')

  let clock = 0
  let failNext = true
  const resolver = createRolloutCwdResolver({
    sessionsDir,
    now: () => clock,
    ttlMs: 100,
    readdirSync: (dirPath, options) => {
      if (failNext) {
        failNext = false
        throw Object.assign(new Error('too many open files'), { code: 'EMFILE' })
      }
      return fsSync.readdirSync(dirPath, options)
    },
  })

  // The rollout exists, but a transient EMFILE makes the scan yield nothing.
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), undefined)
  // Once the transient error clears and the TTL lapses, it resolves.
  clock += 101
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), '/work/ok')
})

// ---------------------------------------------------------------------
// Review round 1, Major 2: the first lookup walks newest-date dirs first and
// returns on first match, so the active session's rollout (newest date dir) is
// found without walking the whole history — while an older/dormant session's
// rollout (older date dir) still resolves.
// ---------------------------------------------------------------------

const OLD_SESSION_ID = '019e0000-2222-4333-8444-555566667777'

test('a newest-dir rollout is found without descending the older-date branch; an older-dir rollout still resolves', async () => {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-cwd-'))
  // A date-partitioned tree (…/YYYY/MM/DD) with an old day and a new day.
  const oldDay = path.join(sessionsDir, '2026', '01', '01')
  const newDay = path.join(sessionsDir, '2026', '07', '07')
  await fs.mkdir(oldDay, { recursive: true })
  await fs.mkdir(newDay, { recursive: true })
  await fs.writeFile(
    path.join(oldDay, `rollout-2026-01-01T00-00-00-${OLD_SESSION_ID}.jsonl`),
    sessionMeta(OLD_SESSION_ID, '/work/old'), 'utf8'
  )
  await fs.writeFile(
    path.join(newDay, `rollout-2026-07-07T10-00-00-${SUBSCRIPTION_SESSION_ID}.jsonl`),
    sessionMeta(SUBSCRIPTION_SESSION_ID, '/work/new'), 'utf8'
  )

  // The active (newest-date) session resolves after touching only the newest
  // branch — the older-date branch (…/2026/01) is never even scanned.
  const scan = countingReaddir()
  const resolver = createRolloutCwdResolver({ sessionsDir, readdirSync: scan.readdirSync })
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), '/work/new')
  assert.ok(
    !scan.calls.some((d) => d.includes(path.join('2026', '01'))),
    'the newest-date rollout is found without descending the older-date branch'
  )

  // An older/dormant session whose rollout lives in an older date dir still
  // resolves (the walk is bounded/ordered, not truncated).
  const scan2 = countingReaddir()
  const resolver2 = createRolloutCwdResolver({ sessionsDir, readdirSync: scan2.readdirSync })
  assert.equal(resolver2.resolve(OLD_SESSION_ID), '/work/old')
})

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

/**
 * A `session_meta` first line (plus trailing newline) carrying a `cwd`.
 * @param {string} sessionId
 * @param {string} cwd
 */
function sessionMeta(sessionId, cwd) {
  return JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }) + '\n'
}

/**
 * A `withFileTypes` directory reader that delegates to the real fs but records
 * every directory it scans, so a test can assert the walk stays bounded and
 * ordered (newest-first) without touching the whole tree.
 */
function countingReaddir() {
  /** @type {string[]} */
  const calls = []
  return {
    calls,
    /**
     * @param {string} dirPath
     * @param {{ withFileTypes: true }} options
     */
    readdirSync: (dirPath, options) => {
      calls.push(dirPath)
      return fsSync.readdirSync(dirPath, options)
    },
  }
}

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
