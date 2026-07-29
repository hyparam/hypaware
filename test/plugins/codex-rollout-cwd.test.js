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

// A realistic subscription-route ROOT session: the container and the root thread
// id are the same uuid, which is the id the rollout filename embeds. The tests
// below that state only a `session-id` header therefore exercise the
// root-thread fallback (LLP 0083); the subagent case, where the two ids diverge,
// is the #459 block further down.
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
    request_headers: JSON.stringify({
      'session-id': ROOT_SESSION_ID,
      'thread-id': ROOT_THREAD_ID,
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'root work' }),
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
    request_headers: JSON.stringify({
      'session-id': ROOT_SESSION_ID,
      'parent-thread-id': ROOT_THREAD_ID,
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'hi' }),
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
      'session-id': ROOT_SESSION_ID,
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
        'session-id': ROOT_SESSION_ID,
        [header]: header === 'x-openai-subagent' ? 'collab_spawn' : ROOT_THREAD_ID,
      }),
      request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'hi' }),
      response_body: JSON.stringify({ output_text: 'ok' }),
    }), context()))
    assert.ok(projection && projection !== USAGE_POLICY_DROP)
    assert.equal(projection.cwd, undefined, `${header} must abandon the container fallback`)
  })
}

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
  // and fails `.hypignore` open for that traffic class. The durable fix is the
  // body's `client_metadata.thread_id`, which the adapter does not read yet.
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
    request_headers: JSON.stringify({ 'session-id': ROOT_SESSION_ID }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'secret subagent work' }),
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
 * as codex-tui sends it: no `x-codex-turn-metadata` (so no in-band cwd), just the
 * identity headers, which name the thread and the container separately.
 */
function subagentTurn() {
  return exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'session-id': ROOT_SESSION_ID,
      'thread-id': SUBAGENT_THREAD_ID,
      'parent-thread-id': ROOT_THREAD_ID,
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'secret subagent work' }),
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
