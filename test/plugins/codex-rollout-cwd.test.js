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
 * A fake rollout cwd resolver: maps a thread id to the cwd its rollout would
 * carry. Used for the projector-wiring tests (no fs needed); the file-reading
 * behaviour of the real resolver is covered separately below.
 *
 * @param {Record<string, string>} byThread
 * @returns {{ resolve(threadId: string): string | undefined }}
 */
function fakeRolloutCwd(byThread) {
  return { resolve: (threadId) => byThread[threadId] }
}

// A subscription-route session that states BOTH ids, and states them
// differently: the container and the thread are distinct uuids, so a lookup
// keyed on the wrong one resolves nothing rather than accidentally working. The
// rollout the fallback must find is the THREAD's (LLP 0083), which is why the
// fake resolvers below are keyed on `SUBSCRIPTION_THREAD_ID`. The case where the
// two ids coincide (a root thread) is the `ROOT_*` block in the #459 section.
const SUBSCRIPTION_SESSION_ID = '019e60b5-1111-4222-8333-444455556666'
const SUBSCRIPTION_THREAD_ID = '019e60b5-9999-4aaa-8bbb-ccccddddeeee'

/**
 * The body's flat `client_metadata` map as Codex writes it on a turn that states
 * its identity but no workspace: session and thread present, no cwd anywhere.
 * That is the shape these tests need, because the rollout fallback only runs
 * when the request states an id and no in-band cwd.
 * @ref LLP 0151#body-is-authority [tests]: keyed on the surface Codex really
 *   fills, not on a `session-id` header Codex never emits.
 */
function subscriptionClientMetadata() {
  return {
    'x-codex-installation-id': 'install-sub',
    session_id: SUBSCRIPTION_SESSION_ID,
    thread_id: SUBSCRIPTION_THREAD_ID,
  }
}

/**
 * A Codex-owned `client_metadata` map stating exactly the lineage a test means
 * to state, and nothing more. The `x-codex-` key is what makes the map Codex's
 * own (`readCodexClientMetadata`), so a test can state a container WITHOUT a
 * thread id and still have the map read: the flat `session_id`/`thread_id` pair
 * alone is not Codex-exclusive and is only honoured as a pair.
 *
 * The #459 cases below all go through here rather than through bare `session-id`
 * / `thread-id` / `parent-thread-id` headers. Those three names are not ones any
 * Codex version emits and are no longer read
 * (@ref LLP 0151 [tests]), so a fixture that states identity through them states
 * nothing at all, and every assertion about a REFUSED fallback would pass
 * vacuously for want of an id rather than because the refusal fired.
 *
 * @param {Record<string, string>} lineage
 */
function codexLineageBody(lineage) {
  return JSON.stringify({
    model: 'gpt-5-codex',
    input: 'secret subagent work',
    client_metadata: { 'x-codex-installation-id': 'install-sub', ...lineage },
  })
}

// ---------------------------------------------------------------------
// Regression (#257): the ChatGPT-subscription route carries no in-band cwd, so
// the live projector must fall back to the session rollout's session_meta.cwd,
// otherwise `.hypignore` fails open for the whole traffic class and the row
// records cwd = NULL (diverging from backfill, which DOES read the rollout).
// ---------------------------------------------------------------------

test('subscription-route Codex with no in-band cwd is .hypignore-dropped via the rollout cwd', () => {
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: fakeRolloutCwd({ [SUBSCRIPTION_THREAD_ID]: '/work/ignored/proj' }),
  })
  const projection = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    // A turn that states its session but no workspace: the flat body
    // `client_metadata` map carries the session id, nothing carries a cwd.
    request_headers: JSON.stringify({}),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: 'secret work',
      client_metadata: subscriptionClientMetadata(),
    }),
    response_body: JSON.stringify({ output_text: 'ok' }),
  }), context())
  // The rollout cwd (`/work/ignored/proj`) is covered by `/work/ignored/.hypignore`,
  // so the exchange must be dropped at the capture seam (LLP 0049 R1).
  assert.equal(projection, USAGE_POLICY_DROP)
})

test('subscription-route Codex records the rollout cwd on the row (live/backfill parity)', () => {
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: fakeRolloutCwd({ [SUBSCRIPTION_THREAD_ID]: '/work/clean/proj' }),
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({}),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: 'hello',
      client_metadata: subscriptionClientMetadata(),
    }),
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
// A `workspaces` key must not preempt the rollout (#480)
//
// @ref LLP 0083#workspace-key-ranks-last [tests]: the order is in-band, rollout,
// workspace key.
// The key is a GUESS whenever it did not match a stated cwd (`selectCodexWorkspace`
// substitutes the first key), and `session_meta.cwd` is what Codex itself wrote
// at session start, so the guess must rank below it. Ranking it above turned a
// correct `.hypignore` drop into a record on the subscription route, the exact
// route the rollout fallback exists for.
// ---------------------------------------------------------------------

test('a workspaces key does not preempt the rollout session_meta.cwd (#480)', () => {
  let lookups = 0
  const rolloutCwd = {
    /** @param {string} _threadId */
    resolve(_threadId) { lookups += 1; return '/work/ignored/real' },
  }
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd,
  })
  // The request states NO cwd, so the workspace key is a substitution, not a
  // match. The session really ran in `/work/ignored/real` (the rollout says so
  // and Codex wrote that line), and `/work/ignored/.hypignore` covers it.
  const projection = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: SUBSCRIPTION_THREAD_ID,
        workspaces: { '/work/clean/proj': {} },
      }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'secret' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context())
  assert.equal(projection, USAGE_POLICY_DROP, 'the opted-out tree the session actually ran in decides the verdict')
  assert.equal(lookups, 1, 'a declared workspaces map must not skip the rollout lookup')
})

test('the rollout cwd is stamped on the row while the workspace key still enriches it (#480)', () => {
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: fakeRolloutCwd({ [SUBSCRIPTION_THREAD_ID]: '/work/clean/real' }),
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: SUBSCRIPTION_THREAD_ID,
        workspaces: {
          '/work/clean/proj': {
            associated_remote_urls: { origin: 'git@github.com:acme/clean.git' },
            latest_git_commit_hash: 'deadbeef',
          },
        },
      }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))
  assert.ok(projection && projection !== USAGE_POLICY_DROP)
  // Demoting the key costs it the cwd, not its enrichment role (LLP 0032#capture).
  assert.equal(projection.cwd, '/work/clean/real', 'the row records where the session actually ran')
  assert.equal(projection.attributes.codex.workspace, '/work/clean/proj')
  assert.equal(projection.git_remote, 'git@github.com:acme/clean.git')
  assert.equal(projection.head_sha, 'deadbeef')
})

test('the workspace key still gates when there is no rollout to outrank it (#480)', () => {
  // The floor under the demotion: with no rollout configured the key is once
  // more the only cwd there is, so the subscription route keeps its `.hypignore`
  // coverage rather than failing open.
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: fakeRolloutCwd({}),
  })
  const projection = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: SUBSCRIPTION_THREAD_ID,
        workspaces: { '/work/ignored/proj': {} },
      }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'secret' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context())
  assert.equal(projection, USAGE_POLICY_DROP, 'the key is the last resort, not a discarded value')
})

// ---------------------------------------------------------------------
// createRolloutCwdResolver: reads session_meta.cwd from the thread's rollout
// file (the same source backfill reads), keyed by the thread id embedded in
// the rollout filename, cached per thread id (LLP 0049 R6).
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
// Issue #465: this resolver and `hyp session`'s id resolution read the same
// `session_meta` line under the same rules, from one shared reader
// (`src/core/codex/rollout_session_meta.js`). These pin the rules AT THIS
// CALLER, so a future change cannot satisfy the other one and quietly loosen
// this one; the reader's own union suite is
// `test/core/codex-rollout-session-meta.test.js`.
// ---------------------------------------------------------------------

test('a rollout whose first line is a different envelope type yields no cwd, even carrying one', () => {
  const sessionsDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-cwd-'))
  fsSync.writeFileSync(
    path.join(sessionsDir, `rollout-2026-07-07T10-00-00-${SUBSCRIPTION_SESSION_ID}.jsonl`),
    JSON.stringify({ type: 'turn_context', payload: { id: SUBSCRIPTION_SESSION_ID, cwd: '/work/not-the-header' } }) + '\n',
    'utf8'
  )
  const resolver = createRolloutCwdResolver({ sessionsDir })
  // Taking it would evaluate `.hypignore` against a directory the session
  // header never claimed. No cwd is the honest answer.
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), undefined)
})

test('a blank session_meta.cwd is no cwd, not a blank path handed to the policy matcher', () => {
  const sessionsDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-cwd-'))
  fsSync.writeFileSync(
    path.join(sessionsDir, `rollout-2026-07-07T10-00-00-${SUBSCRIPTION_SESSION_ID}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: SUBSCRIPTION_SESSION_ID, cwd: '   ' } }) + '\n',
    'utf8'
  )
  const resolver = createRolloutCwdResolver({ sessionsDir })
  assert.equal(resolver.resolve(SUBSCRIPTION_SESSION_ID), undefined)
})

test('a relative session_meta.cwd is no cwd: the matcher would resolve it against the daemon', () => {
  // Passed on, the matcher's `path.resolve` supplies the DAEMON's process cwd as
  // the base, so this session's `.hypignore` verdict would be governed by a file
  // under wherever the daemon was started. Proven here by making the process cwd
  // the thing the relative path would land in.
  // @ref LLP 0150#usable-cwd [tests]: refuse rather than guess a base
  const sessionsDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-cwd-'))
  fsSync.writeFileSync(
    path.join(sessionsDir, `rollout-2026-07-07T10-00-00-${SUBSCRIPTION_SESSION_ID}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: SUBSCRIPTION_SESSION_ID, cwd: '../elsewhere' } }) + '\n',
    'utf8'
  )
  const resolver = createRolloutCwdResolver({ sessionsDir })
  const cwd = resolver.resolve(SUBSCRIPTION_SESSION_ID)
  assert.equal(cwd, undefined)

  // And the fail-open it falls back to is the documented "no cwd" one (LLP 0083,
  // LLP 0049 R1 as extended by LLP 0085), not a verdict about another directory:
  // had the value been passed on, this resolver would have named a governor.
  const wouldHaveBeen = createUsagePolicyResolver({
    existsSync: (p) => p === path.resolve('../elsewhere', '.hypignore'),
    readFileSync: () => 'ignore\n',
  })
  assert.equal(wouldHaveBeen.resolve('../elsewhere').class, 'ignore', 'the wrong-directory verdict is real, not hypothetical')
})

// ---------------------------------------------------------------------
// Review round 1, Major 1: a miss (not-yet-written rollout on a session's
// first exchange, or a transient read error) must NOT be cached as a permanent
// NULL cwd: that would silently fail `.hypignore` open for the session's whole
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
  assert.equal(scan.calls.length, scansAfterMiss, 'a miss is cached within its TTL, no re-scan')

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
  assert.equal(scan.calls.length, scansAfterResolve, 'a resolved cwd is cached for the session life, never re-scanned')
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
// found without walking the whole history, while an older/dormant session's
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
  // branch: the older-date branch (…/2026/01) is never even scanned.
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
// Regression (#459): a rollout file is one THREAD's file - its name embeds
// `session_meta.payload.id`, not the session container `payload.session_id`. A
// subagent thread inherits its root's container but mints its own thread id, so
// keying the lookup on the container resolved the ROOT thread's rollout and the
// root's cwd decided the subagent turn's `.hypignore` outcome (LLP 0083 /
// LLP 0050). Both directions are exercised: the leak (recorded when it should
// have been dropped) is the one that matters.
// ---------------------------------------------------------------------

// Codex mints a session container from its root thread's id, so for the ROOT
// thread the two are the same uuid. That coincidence is what hid the defect.
const ROOT_THREAD_ID = '019e60b5-aaaa-4222-8333-444455556666'
const ROOT_SESSION_ID = ROOT_THREAD_ID
// A subagent thread: inherits the container above, mints its own thread id, and
// (the point of the bug) can be running somewhere else entirely.
const SUBAGENT_THREAD_ID = '019e60b5-bbbb-4222-8333-444455556666'

test('a subagent turn is .hypignore-dropped by ITS OWN rollout cwd, not the root thread\'s', async () => {
  // The root ran in a recorded directory; the subagent ran in an ignored one.
  const sessionsDir = await writeSubagentPair({
    rootCwd: '/work/clean/root',
    subagentCwd: '/work/ignored/sub',
  })
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: createRolloutCwdResolver({ sessionsDir }),
  })
  const projection = projector.project(subagentTurn(), context())
  // Keyed on the container, this resolved `/work/clean/root` and RECORDED a turn
  // the user's `.hypignore` said to drop: a directory-scoped privacy control
  // silently not applying (LLP 0049 R1).
  assert.equal(projection, USAGE_POLICY_DROP)
})

test('a subagent turn outside an ignored root is recorded, with its own cwd on the row', async () => {
  // The reverse pair: the ROOT is the ignored one, the subagent is not.
  const sessionsDir = await writeSubagentPair({
    rootCwd: '/work/ignored/root',
    subagentCwd: '/work/clean/sub',
  })
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: createRolloutCwdResolver({ sessionsDir }),
  })
  const projection = /** @type {any} */ (projector.project(subagentTurn(), context()))
  // Keyed on the container this over-dropped (loses data, leaks nothing) AND
  // would have stamped the root's directory on the row.
  assert.ok(projection && projection !== USAGE_POLICY_DROP)
  assert.equal(projection.cwd, '/work/clean/sub')
})

test('the root thread of the same session still resolves its own cwd', async () => {
  // The fix must not trade the subagent for the root: a root turn states its
  // thread id too (equal to the container here), and resolves the root rollout.
  const sessionsDir = await writeSubagentPair({
    rootCwd: '/work/ignored/root',
    subagentCwd: '/work/clean/sub',
  })
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: createRolloutCwdResolver({ sessionsDir }),
  })
  const projection = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({}),
    request_body: codexLineageBody({
      session_id: ROOT_SESSION_ID,
      thread_id: ROOT_THREAD_ID,
    }),
    response_body: JSON.stringify({ output_text: 'ok' }),
  }), context())
  assert.equal(projection, USAGE_POLICY_DROP)
})

test('a legacy rollout pair with no session_id still resolves each thread\'s own cwd', async () => {
  // A Codex old enough to predate `session_meta.session_id` records no container
  // at all. The container is not what selects a rollout, so its absence must not
  // make the cwd unresolvable - the thread id is on the filename and in
  // `payload.id`, which is all this lookup needs.
  const sessionsDir = await writeSubagentPair({
    rootCwd: '/work/clean/root',
    subagentCwd: '/work/ignored/sub',
    legacy: true,
  })
  const resolver = createRolloutCwdResolver({ sessionsDir })
  assert.equal(resolver.resolve(ROOT_THREAD_ID), '/work/clean/root')
  assert.equal(resolver.resolve(SUBAGENT_THREAD_ID), '/work/ignored/sub')

  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: createRolloutCwdResolver({ sessionsDir }),
  })
  assert.equal(projector.project(subagentTurn(), context()), USAGE_POLICY_DROP)
})

test('a rollout whose body disagrees with its filename is refused, not silently used', async () => {
  // The filename convention is Codex's, not ours, so the name is only a
  // prefilter. A copied, renamed, or convention-changed file must yield "cwd
  // unknown" rather than let some OTHER thread's cwd decide this turn.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-cwd-'))
  await fs.writeFile(
    path.join(sessionsDir, `rollout-2026-07-07T10-00-00-${SUBAGENT_THREAD_ID}.jsonl`),
    metaLine({ id: ROOT_THREAD_ID, session_id: ROOT_SESSION_ID, cwd: '/work/some/other/thread' }),
    'utf8'
  )
  const log = recordingLog()
  const resolver = createRolloutCwdResolver({ sessionsDir, log })
  assert.equal(resolver.resolve(SUBAGENT_THREAD_ID), undefined)
  // The refusal's only other trace would be a row with cwd = NULL, which looks
  // exactly like the ordinary not-yet-written rollout, so it is logged.
  assert.deepEqual(
    log.warns.map((w) => w.message),
    ['plugin.codex.rollout_cwd_thread_mismatch']
  )
  assert.equal(log.warns[0].fields?.wanted_thread_id, SUBAGENT_THREAD_ID)
  assert.equal(log.warns[0].fields?.rollout_thread_id, ROOT_THREAD_ID)
  // A name that lies is a different diagnosis from a rollout that states no id,
  // so the two refusals are distinguishable without re-reading the fields.
  assert.equal(log.warns[0].fields?.error_kind, 'thread_id_mismatch')
})

test('a subagent turn that states lineage but not its own thread id resolves no cwd', async () => {
  // The turn's own rollout is not identifiable from the wire, and the container
  // would resolve the ROOT's rollout - the exact defect. Refusing (cwd unknown,
  // which LLP 0049 fails open on, row records NULL) follows the same
  // refuse-rather-than-guess direction PR #458 set for the `hyp session`
  // resolver: do not act on an identifier whose provenance does not check out.
  const sessionsDir = await writeSubagentPair({
    rootCwd: '/work/ignored/root',
    subagentCwd: '/work/clean/sub',
  })
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: createRolloutCwdResolver({ sessionsDir }),
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({}),
    request_body: codexLineageBody({
      session_id: ROOT_SESSION_ID,
      'x-codex-parent-thread-id': ROOT_THREAD_ID,
    }),
    response_body: JSON.stringify({ output_text: 'ok' }),
  }), context()))
  assert.ok(projection && projection !== USAGE_POLICY_DROP)
  assert.equal(projection.cwd, undefined, 'an unknown cwd is recorded as unknown, not as the root\'s')
})

test('a turn whose metadata states thread_source=subagent but no thread id resolves no cwd', async () => {
  // The other half of the lineage refusal. `thread_source` is readable only out
  // of `x-codex-turn-metadata`, so without this case the `thread_source` disjunct
  // could be deleted with the suite still green.
  const sessionsDir = await writeSubagentPair({
    rootCwd: '/work/ignored/root',
    subagentCwd: '/work/clean/sub',
  })
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: createRolloutCwdResolver({ sessionsDir }),
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({ session_id: ROOT_SESSION_ID, thread_source: 'subagent' }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'hi' }),
    response_body: JSON.stringify({ output_text: 'ok' }),
  }), context()))
  assert.ok(projection && projection !== USAGE_POLICY_DROP)
  assert.equal(projection.cwd, undefined, 'stated lineage without a thread id must not fall back to the container')
})

for (const header of ['x-codex-parent-thread-id', 'x-openai-subagent']) {
  test(`a turn stating lineage only via ${header} resolves no cwd`, async () => {
    // The lineage names `codex-rs` actually emits as DIRECT headers
    // (`CodexResponsesMetadata::compatibility_headers`), gated on their own value
    // and NOT on `x-codex-turn-metadata`. That independence is the whole point:
    // every field the refusal previously keyed on travels inside the metadata
    // blob, which also carries `thread_id`, so a refusal keyed only on those can
    // never fire before the thread-id path has returned. These two are what make
    // it reachable, so a subagent turn that names no thread of its own resolves
    // no cwd instead of the root's.
    const sessionsDir = await writeSubagentPair({
      rootCwd: '/work/ignored/root',
      subagentCwd: '/work/clean/sub',
    })
    const projector = createCodexExchangeProjector({
      resolver: ignoringResolver('/work/ignored'),
      rolloutCwd: createRolloutCwdResolver({ sessionsDir }),
    })
    const projection = /** @type {any} */ (projector.project(exchange({
      path: '/backend-api/codex/responses',
      provider: 'chatgpt',
      request_headers: JSON.stringify({
        [header]: header === 'x-openai-subagent' ? 'collab_spawn' : ROOT_THREAD_ID,
      }),
      // The container, and deliberately no thread id: without the refusal this
      // resolves the ROOT rollout (`/work/ignored/root`) and drops, so the
      // assertion below fails for the right reason rather than for want of an id.
      request_body: codexLineageBody({ session_id: ROOT_SESSION_ID }),
      response_body: JSON.stringify({ output_text: 'ok' }),
    }), context()))
    assert.ok(projection && projection !== USAGE_POLICY_DROP)
    assert.equal(projection.cwd, undefined, `${header} must abandon the container fallback`)
  })
}

// `x-openai-subagent`'s real values are `review`, `compact`, `collab_spawn` and
// `memory_consolidation`. Three of the four are sub-threads of the ROOT's own
// workspace, so the root's cwd is the CORRECT answer for them, and the guard
// refuses anyway because it is value-blind. These two loops pin both halves of
// that trade, because only the pair of them says how far it reaches.
for (const value of ['review', 'compact', 'memory_consolidation']) {
  test(`DOCUMENTED MIRROR: x-openai-subagent=${value} with no thread id refuses a container the root would have resolved`, async () => {
    // @ref LLP 0083#container-fallback-gap [tests]: the cost of the value-blind
    // grain, asserted rather than left to be rediscovered. The root ran in an
    // IGNORED directory and this is a sub-thread of the root's own workspace, so
    // the container fallback would have dropped the turn. The refusal makes the
    // cwd unknown instead, LLP 0049 fails OPEN, and the turn is RECORDED. That is
    // the same leak direction #459 closes, in the guard that bounds the fix.
    const sessionsDir = await writeSubagentPair({
      rootCwd: '/work/ignored/root',
      subagentCwd: '/work/clean/sub',
    })
    const projector = createCodexExchangeProjector({
      resolver: ignoringResolver('/work/ignored'),
      rolloutCwd: createRolloutCwdResolver({ sessionsDir }),
    })
    const projection = /** @type {any} */ (projector.project(exchange({
      path: '/backend-api/codex/responses',
      provider: 'chatgpt',
      request_headers: JSON.stringify({ 'x-openai-subagent': value }),
      request_body: codexLineageBody({ session_id: ROOT_SESSION_ID }),
      response_body: JSON.stringify({ output_text: 'ok' }),
    }), context()))
    assert.ok(projection && projection !== USAGE_POLICY_DROP, 'recorded, not dropped: the cost this asserts')
    assert.equal(projection.cwd, undefined)
  })

  test(`x-openai-subagent=${value} does NOT cost anything once the turn states its thread`, async () => {
    // The bound on the loop above. Codex fills the body's `client_metadata` map
    // with `thread_id` on every request (@ref LLP 0151#body-is-authority), so a
    // real turn carrying this header carries a thread id too, the thread-id key
    // answers first, and the value-blind refusal is never consulted. Same header,
    // same ignored root, opposite outcome: the drop is restored.
    const sessionsDir = await writeSubagentPair({
      rootCwd: '/work/ignored/root',
      subagentCwd: '/work/clean/sub',
    })
    const projector = createCodexExchangeProjector({
      resolver: ignoringResolver('/work/ignored'),
      rolloutCwd: createRolloutCwdResolver({ sessionsDir }),
    })
    const projection = projector.project(exchange({
      path: '/backend-api/codex/responses',
      provider: 'chatgpt',
      request_headers: JSON.stringify({ 'x-openai-subagent': value }),
      request_body: codexLineageBody({
        session_id: ROOT_SESSION_ID,
        thread_id: ROOT_THREAD_ID,
      }),
      response_body: JSON.stringify({ output_text: 'ok' }),
    }), context())
    assert.equal(projection, USAGE_POLICY_DROP, 'a turn that states its thread is judged by its own rollout')
  })
}

test('a memory-consolidation turn is answered by the body map, whose id pair the blob withholds', async () => {
  // @ref LLP 0083#container-fallback-gap [tests]: which surface actually keeps
  // the real subagent-flavoured request kind out of the value-blind refusal.
  //
  // `CodexResponsesRequestKind::Memory` is the one kind `codex-rs` marks
  // `has_turn_identity() == false`, so `turn_metadata_payload` omits BOTH
  // `session_id` and `thread_id` from the blob while still emitting the lineage
  // that trips the refusal (`thread_source`, `parent_thread_id`, and the
  // `x-openai-subagent: memory_consolidation` compatibility header). So this is
  // the closest real Codex shape to the refusal's trigger, and what keeps it out
  // is the FLAT BODY MAP: `client_metadata()` inserts the id pair
  // unconditionally, ungated by `has_turn_identity`.
  //
  // Stated as a test because the reasoning is easy to get backwards: the blob is
  // NOT what answers this turn, so a future change that stopped reading the body
  // map would send precisely this shape into the refusal and fail `.hypignore`
  // OPEN on it. The assertion below is what would catch that.
  const sessionsDir = await writeSubagentPair({
    rootCwd: '/work/ignored/root',
    subagentCwd: '/work/clean/sub',
  })
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: createRolloutCwdResolver({ sessionsDir }),
  })
  const projection = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-openai-subagent': 'memory_consolidation',
      // The blob as the Memory kind serialises it: lineage, no id pair.
      'x-codex-turn-metadata': JSON.stringify({
        request_kind: 'memory',
        thread_source: 'subagent',
        parent_thread_id: ROOT_THREAD_ID,
      }),
    }),
    // The body map, which states both ids regardless of the request kind.
    request_body: codexLineageBody({
      session_id: ROOT_SESSION_ID,
      thread_id: ROOT_THREAD_ID,
    }),
    response_body: JSON.stringify({ output_text: 'ok' }),
  }), context())
  assert.equal(projection, USAGE_POLICY_DROP, 'the body map names the thread, so the refusal is never consulted')
})

test('a session_meta line with a cwd but no payload.id is refused, not matched by its filename', async () => {
  // The identity guard reads the RAW line, so an absent `payload.id` is visible
  // as absent and refuses. Pinned because it is a real divergence from the
  // backfill, which falls back to the id on the filename (`buildSession`), and
  // because refusing here means cwd unknown, which LLP 0049 fails OPEN on: the
  // turn is recorded. Codex always writes `id`, so this pins the rule, not a
  // shape in the field.
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-cwd-'))
  await fs.writeFile(
    path.join(sessionsDir, `rollout-2026-07-07T10-00-00-${ROOT_THREAD_ID}.jsonl`),
    metaLine({ cwd: '/work/idless', originator: 'codex-tui' }),
    'utf8'
  )
  const log = recordingLog()
  const resolver = createRolloutCwdResolver({ sessionsDir, log })
  assert.equal(resolver.resolve(ROOT_THREAD_ID), undefined)
  assert.deepEqual(log.warns.map((w) => w.message), ['plugin.codex.rollout_cwd_thread_mismatch'])
  assert.equal(log.warns[0].fields?.rollout_thread_id, null, 'an absent id is reported as absent, not as the wanted id')
  // The one shape the backfill still accepts, so the log has to say which
  // refusal this is: it is the live/backfill divergence, not a renamed file.
  assert.equal(log.warns[0].fields?.error_kind, 'thread_id_absent')
})

test('DOCUMENTED GAP: a turn stating a container and NO lineage at all is taken as its root thread', async () => {
  // @ref LLP 0083#container-fallback-gap [tests]: what the container fallback
  // still accepts, asserted rather than left to be rediscovered.
  //
  // Every refusal above needs the turn to state SOMETHING - a thread id, a
  // metadata `thread_source`, or one of the two lineage headers. A turn that
  // states a container and nothing else is indistinguishable on the wire from the
  // root thread it claims to be, so it resolves the container's rollout: correct
  // for a root, the #459 defect for a subagent. It is bounded (it needs a client
  // that withholds its thread id AND every lineage signal on a subagent turn, and
  // Codex withholds neither together) and deleting the fallback is worse, since
  // it returns every container-only turn, root threads included, to `cwd = NULL`
  // and fails `.hypignore` open for that traffic class.
  //
  // The durable fix, the body's `client_metadata.thread_id`, has since landed
  // (LLP 0151), which is why this fixture has to work to reach the gap at all:
  // it states a Codex-owned map carrying the container and NO thread id. A turn
  // that states its thread, which is now every ordinary Codex turn, is answered
  // by the thread-id key and never gets here. The gap is narrower than it was;
  // it is asserted because it is not closed.
  const sessionsDir = await writeSubagentPair({
    rootCwd: '/work/clean/root',
    subagentCwd: '/work/ignored/sub',
  })
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
    rolloutCwd: createRolloutCwdResolver({ sessionsDir }),
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({}),
    request_body: codexLineageBody({ session_id: ROOT_SESSION_ID }),
    response_body: JSON.stringify({ output_text: 'ok' }),
  }), context()))
  assert.ok(projection && projection !== USAGE_POLICY_DROP, 'still recorded: the gap this asserts')
  assert.equal(projection.cwd, '/work/clean/root', 'still the ROOT thread\'s cwd, not the subagent\'s')
})

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

/**
 * A `session_meta` first line (plus trailing newline) carrying a `cwd`.
 * @param {string} threadId
 * @param {string} cwd
 */
function sessionMeta(threadId, cwd) {
  return JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd } }) + '\n'
}

/**
 * A `session_meta` first line (plus trailing newline) from an explicit payload,
 * so a test can state the thread id, the container, and the lineage separately.
 *
 * @param {Record<string, unknown>} payload
 */
function metaLine(payload) {
  return JSON.stringify({
    timestamp: '2026-07-07T10:00:00.000Z',
    type: 'session_meta',
    payload,
  }) + '\n'
}

/**
 * A fresh sessions tree holding a subagent-shaped rollout PAIR: a root thread
 * (whose id is also the session container) and a subagent thread that inherits
 * that container, mints its own thread id, and records its own `cwd`. With
 * `legacy: true` neither rollout carries a `session_id` field at all, the shape
 * a pre-container Codex writes.
 *
 * @param {{ rootCwd: string, subagentCwd: string, legacy?: boolean }} opts
 * @returns {Promise<string>} the sessions root
 */
async function writeSubagentPair(opts) {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-cwd-'))
  const day = path.join(sessionsDir, '2026', '07', '07')
  await fs.mkdir(day, { recursive: true })
  const container = opts.legacy ? {} : { session_id: ROOT_SESSION_ID }
  await fs.writeFile(
    path.join(day, `rollout-2026-07-07T10-00-00-${ROOT_THREAD_ID}.jsonl`),
    metaLine({ id: ROOT_THREAD_ID, ...container, cwd: opts.rootCwd, originator: 'codex-tui' }),
    'utf8'
  )
  await fs.writeFile(
    path.join(day, `rollout-2026-07-07T10-05-00-${SUBAGENT_THREAD_ID}.jsonl`),
    metaLine({
      id: SUBAGENT_THREAD_ID,
      ...container,
      parent_thread_id: ROOT_THREAD_ID,
      thread_source: 'subagent',
      cwd: opts.subagentCwd,
      originator: 'codex-tui',
    }),
    'utf8'
  )
  return sessionsDir
}

/**
 * A subscription-route turn from the SUBAGENT thread of `ROOT_SESSION_ID`. Shaped
 * as Codex sends it on a turn kind that carries no turn metadata: no
 * `x-codex-turn-metadata` (so no in-band cwd), just the body's flat
 * `client_metadata` map, which names the thread and the container separately.
 */
function subagentTurn() {
  return exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({}),
    request_body: codexLineageBody({
      session_id: ROOT_SESSION_ID,
      thread_id: SUBAGENT_THREAD_ID,
      'x-codex-parent-thread-id': ROOT_THREAD_ID,
    }),
    response_body: JSON.stringify({ output_text: 'ok' }),
  })
}

/** A logger that records the `warn` calls a test wants to assert on. */
function recordingLog() {
  /** @type {{ message: string, fields?: Record<string, unknown> }[]} */
  const warns = []
  return {
    warns,
    /** @param {string} message @param {Record<string, unknown>} [fields] */
    warn(message, fields) { warns.push({ message, fields }) },
  }
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
