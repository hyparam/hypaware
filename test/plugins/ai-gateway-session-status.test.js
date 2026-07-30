// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createControlHandler } from '../../hypaware-core/plugins-workspace/ai-gateway/src/control.js'
import { createCodexExchangeProjector } from '../../hypaware-core/plugins-workspace/codex/src/exchange-projector.js'
import { USAGE_POLICY_DROP } from '../../src/core/usage-policy/index.js'
import {
  resolveSessionIdForCli,
  runSessionIgnore,
  runSessionStatus,
  runSessionUnignore,
  SESSION_EXIT_NOT_IGNORED,
  SESSION_EXIT_UNKNOWN,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/session_command.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 */

// Regression suite for issue #432: the ephemeral session opt-out fails open
// and cannot be checked.
//
// @ref LLP 0066#readable [tests]: the ignored-session set MUST have a reader,
//   and a read that cannot be completed MUST report `unknown`, never
//   `ignored: false`.
// @ref LLP 0067#status-endpoint [tests]
// @ref LLP 0067#cli [tests]

/* ------------------------------------------------------------------ */
/* 1. The set has a reader, and a gateway restart is DETECTABLE        */
/* ------------------------------------------------------------------ */

test('the ignored-session set is readable: GET reports current membership', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    assert.equal((await postSession(base, 'sess-a')).status, 200)
    const read = await getSession(base, 'sess-a')
    assert.equal(read.status, 200, 'GET on the control route must be served, not 405')
    assert.deepEqual(read.body, { session_id: 'sess-a', ignored: true, total: 1 })
  })
})

test('a gateway restart no longer fails open SILENTLY: the reader reports the resumed recording', async () => {
  // The exact defect in issue #432. LLP 0066 accepts that a gateway restart
  // drops the set (non-goal 2: no persistence), but before this reader existed
  // there was no way for the user, or the privacy skill, to find out. The
  // opt-out silently stopped applying.
  const live = /** @type {Set<string>} */ (new Set())
  await withControlServer(live, async (base) => {
    await postSession(base, 'sess-restart')
    const before = await getSession(base, 'sess-restart')
    assert.equal(before.body.ignored, true)
  })

  // A daemon restart builds a fresh GatewayState, hence a fresh empty set.
  const afterRestart = /** @type {Set<string>} */ (new Set())
  await withControlServer(afterRestart, async (base) => {
    const read = await getSession(base, 'sess-restart')
    assert.equal(read.status, 200)
    assert.equal(read.body.ignored, false, 'recording resumed - and it is now observable')
    assert.equal(read.body.total, 0)
  })
})

test('GET without a session_id is a 400, and an unrelated /_hypaware path is still a 404', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const noId = await rawRequest(base, 'GET', '/_hypaware/ignore/session')
    assert.equal(noId.status, 400)
    const unknown = await rawRequest(base, 'GET', '/_hypaware/nope')
    assert.equal(unknown.status, 404)
  })
})

test('GET round-trips a session id verbatim (R5): no trimming, no normalization', async () => {
  const raw = ' sess pad+plus '
  const set = new Set([raw])
  await withControlServer(set, async (base) => {
    const read = await getSession(base, raw)
    assert.equal(read.status, 200)
    assert.equal(read.body.session_id, raw)
    assert.equal(read.body.ignored, true, 'the reader must look up the RAW token the adapter would resolve')
  })
})

/* ------------------------------------------------------------------ */
/* 2. `hyp session status` fails CLOSED                                */
/* ------------------------------------------------------------------ */

test('hyp session status reports `ignored` against a live gateway', async () => {
  const set = new Set(['sess-live'])
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-live' } })
    const code = await runSessionStatus(['--json'], ctx.ctx)
    assert.equal(code, 0, 'a confirmed opt-out exits 0')
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.status, 'ignored')
    assert.equal(out.ignored, true)
    assert.equal(out.session_id, 'sess-live')
  })
})

test('hyp session status reports `not_ignored` distinctly, with a nonzero exit', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-open' } })
    const code = await runSessionStatus(['--json'], ctx.ctx)
    assert.equal(code, SESSION_EXIT_NOT_IGNORED)
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.status, 'not_ignored')
    assert.equal(out.ignored, false)
  })
})

test('hyp session status FAILS CLOSED when the gateway is unreachable: unknown, never ignored:false', async () => {
  // The specific defect named in issue #432: an unreachable gateway must not
  // be reported as "not ignored". `ignored` is null (cannot confirm), the
  // status word is `unknown`, and the exit code is its own nonzero value so a
  // caller can tell "confirmed recording" from "could not confirm anything".
  const deadPort = await closedPort()
  const ctx = fakeCtx({
    endpoint: `http://127.0.0.1:${deadPort}`,
    env: { CLAUDE_CODE_SESSION_ID: 'sess-unreachable' },
  })
  const code = await runSessionStatus(['--json'], ctx.ctx)
  assert.equal(code, SESSION_EXIT_UNKNOWN, 'an unconfirmable read exits nonzero')
  assert.notEqual(SESSION_EXIT_UNKNOWN, 0)
  assert.notEqual(SESSION_EXIT_UNKNOWN, SESSION_EXIT_NOT_IGNORED)
  const out = JSON.parse(ctx.stdout())
  assert.equal(out.status, 'unknown')
  assert.equal(out.ignored, null, 'MUST NOT be false: the gateway was never reached')
  assert.ok(typeof out.reason === 'string' && out.reason.length > 0)
})

test('hyp session status fails closed when no gateway endpoint can be resolved at all', async () => {
  const ctx = fakeCtx({ endpoint: undefined, env: { CLAUDE_CODE_SESSION_ID: 'sess-nowhere' } })
  const code = await runSessionStatus(['--json'], ctx.ctx)
  assert.equal(code, SESSION_EXIT_UNKNOWN)
  const out = JSON.parse(ctx.stdout())
  assert.equal(out.status, 'unknown')
  assert.equal(out.ignored, null)
})

test('hyp session status names the folder governor rather than omitting it (R7)', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-open' } })
    await runSessionStatus([], ctx.ctx)
    const text = ctx.stdout()
    assert.match(text, /not ignored/)
    assert.match(text, /hyp policy show/, 'the session verb must point at the other, independent governor')
  })
})

/* ------------------------------------------------------------------ */
/* 2b. A 200 is not evidence: the ANSWER has to be about this session  */
/* ------------------------------------------------------------------ */

// The endpoint is resolved from disk (a live daemon's status.json, else a
// pinned `listen`). Both can point at a port some other local process now
// owns: a `listen` pinned for a gateway that is gone, or a recycled ephemeral
// port. Whatever answers there is not the gateway, so its reply establishes
// nothing - LLP 0066 R10 says that is `unknown`, not a membership answer.

/**
 * @param {(req: IncomingMessage, res: ServerResponse) => void} respond
 * @param {(base: string) => Promise<void>} fn
 */
async function withRogueServer(respond, fn) {
  const server = http.createServer(respond)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }
}

/** @param {number} status @param {string} payload */
function respondWith(status, payload) {
  return (/** @type {IncomingMessage} */ req, /** @type {ServerResponse} */ res) => {
    req.resume()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(payload)
  }
}

for (const scenario of [
  { name: 'a 200 with no `ignored` field', payload: JSON.stringify({ ok: true }) },
  { name: 'a 200 whose `ignored` is a string, not a boolean', payload: JSON.stringify({ session_id: 'sess-real', ignored: 'true', total: 1 }) },
  { name: 'a 200 with no numeric `total`', payload: JSON.stringify({ session_id: 'sess-real', ignored: false }) },
  { name: 'a 200 JSON array', payload: '[]' },
  { name: 'a 200 that is not JSON at all', payload: 'not json' },
]) {
  test(`hyp session status fails closed on ${scenario.name}`, async () => {
    await withRogueServer(respondWith(200, scenario.payload), async (base) => {
      const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-real' } })
      const code = await runSessionStatus(['--json'], ctx.ctx)
      assert.equal(code, SESSION_EXIT_UNKNOWN)
      const out = JSON.parse(ctx.stdout())
      assert.equal(out.status, 'unknown')
      assert.equal(out.ignored, null, 'a malformed answer MUST NOT become a confident membership answer')
    })
  })
}

test('hyp session status fails closed when the answer is about a DIFFERENT session', async () => {
  // The worst direction: a foreign responder claiming `ignored: true` would
  // otherwise tell the user they are covered when nothing confirmed it.
  const payload = JSON.stringify({ session_id: 'someone-else', ignored: true, total: 9 })
  await withRogueServer(respondWith(200, payload), async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-real' } })
    const code = await runSessionStatus(['--json'], ctx.ctx)
    assert.equal(code, SESSION_EXIT_UNKNOWN, 'an answer about another session confirms nothing')
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.status, 'unknown')
    assert.equal(out.ignored, null)
    assert.match(out.reason, /someone-else/)
  })
})

test('hyp session status fails closed on a non-200 from the endpoint', async () => {
  await withRogueServer(respondWith(500, '{}'), async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-real' } })
    assert.equal(await runSessionStatus(['--json'], ctx.ctx), SESSION_EXIT_UNKNOWN)
    assert.equal(JSON.parse(ctx.stdout()).ignored, null)
  })
})

test('hyp session ignore does not report a quiet success against a non-gateway responder', async () => {
  // The mutation verbs share the same discipline: `ignore` printing "ignored"
  // off an unvalidated 200 is the same false assurance in a louder place.
  await withRogueServer(respondWith(200, JSON.stringify({ ok: true })), async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-real' } })
    const code = await runSessionIgnore(['--json'], ctx.ctx)
    assert.equal(code, SESSION_EXIT_UNKNOWN)
    assert.equal(ctx.stdout(), '', 'nothing may be reported as opted out')
    assert.match(ctx.stderr(), /hyp session:/)
  })
})

/* ------------------------------------------------------------------ */
/* 3. `hyp session ignore` / `unignore` are the single front door      */
/* ------------------------------------------------------------------ */

test('hyp session ignore / unignore round-trip through the control route', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-roundtrip' }
    const on = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionIgnore(['--json'], on.ctx), 0)
    assert.equal(JSON.parse(on.stdout()).ignored, true)
    assert.ok(set.has('sess-roundtrip'))

    const check = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionStatus(['--json'], check.ctx), 0)

    const off = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionUnignore(['--json'], off.ctx), 0)
    assert.equal(JSON.parse(off.stdout()).ignored, false)
    assert.equal(set.has('sess-roundtrip'), false)
  })
})

test('the ephemerality caveat names the fork that mints a new session id, not only a restart', async () => {
  // Issue #455. LLP 0066 §readable lists TWO ways an opt-out stops applying
  // while the user still believes it holds: the gateway restart that drops the
  // set, and the client minting a new `session_id` for what the user
  // experiences as one conversation (`claude --fork-session`, `codex fork`;
  // a plain resume reuses the id). The caveat named only the restart, which
  // reads as the exhaustive list and teaches the user the other cannot happen.
  //
  // @ref LLP 0066#readable [tests]: R9 - the caveat next to a confirmed
  //   `ignored` names both ways, in the writer and the reader alike.
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-fork' }

    const mut = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionIgnore([], mut.ctx), 0)
    assert.match(mut.stdout(), /a gateway restart drops it/, 'the restart half must survive')
    assert.match(mut.stdout(), /fork/)
    assert.match(mut.stdout(), /mints a new session id it no longer covers/)

    // `status` prints the same caveat off the same constant, so the writer's
    // wording and the reader's cannot drift apart.
    const read = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionStatus([], read.ctx), 0)
    assert.match(read.stdout(), /a gateway restart drops it/)
    assert.match(read.stdout(), /mints a new session id it no longer covers/)

    // `unignore` has no opt-out to qualify, so it stays silent about both.
    const off = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionUnignore([], off.ctx), 0)
    assert.doesNotMatch(off.stdout(), /in-memory only/)
  })
})

test('an explicit session id argument beats the environment', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'from-env' } })
    assert.equal(await runSessionIgnore(['explicit-id', '--json'], ctx.ctx), 0)
    assert.ok(set.has('explicit-id'))
    assert.equal(set.has('from-env'), false)
  })
})

/* ------------------------------------------------------------------ */
/* 4. Session-id resolution: Codex rollouts, refusing on ambiguity     */
/* ------------------------------------------------------------------ */

test('resolves a Codex session id from the rollout whose payload.cwd matches the invocation cwd', () => {
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-aaa', cwd: '/repo/other' },
    { file: 'rollout-2026-01-02-bbb.jsonl', id: 'codex-bbb', cwd: '/repo/here' },
  ])
  const out = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(out.ok, true)
  assert.equal(out.ok && out.sessionId, 'codex-bbb')
  assert.equal(out.ok && out.source, 'codex_rollout')
})

test('a first line that is not a session_meta record resolves nothing, however much it looks like one', () => {
  // Issue #465. The envelope-type guard is one of the three rules the shared
  // reader states: another rollout record can carry `payload.id` and
  // `payload.cwd` (a `turn_context` does), and reading it as the header hands
  // `hyp session ignore` an id that is not the session's. The privacy verb then
  // reports success for a drop that drops nothing.
  //
  // #458 added the same guard as a local predicate here while #465 was open;
  // this pins it at the seam that now delegates, so collapsing the two readers
  // into one cannot quietly drop it again.
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'not-the-session-id', cwd: '/repo/here', type: 'turn_context' },
  ])
  const out = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(out.ok, false, 'a non-session_meta first line is not evidence of a session id')
  assert.equal(
    (out.ok ? '' : out.error).includes('not-the-session-id'),
    false,
    'the id off the wrong envelope must not be resolved, nor offered as a candidate'
  )
})

test('refuses (never guesses newest) when several Codex rollouts match the cwd', () => {
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-aaa', cwd: '/repo/here' },
    { file: 'rollout-2026-01-02-bbb.jsonl', id: 'codex-bbb', cwd: '/repo/here' },
  ])
  const out = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(out.ok, false)
  assert.match(out.ok ? '' : out.error, /codex-aaa/)
  assert.match(out.ok ? '' : out.error, /codex-bbb/)
})

test('refuses when no Codex rollout matches the cwd', () => {
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-aaa', cwd: '/repo/elsewhere' },
  ])
  const out = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(out.ok, false)
})

test('CLAUDE_CODE_SESSION_ID wins over any Codex rollout scan', () => {
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-aaa', cwd: '/repo/here' },
  ])
  const out = resolveSessionIdForCli({
    env: { CODEX_HOME: home, CLAUDE_CODE_SESSION_ID: 'claude-1' },
    cwd: '/repo/here',
  })
  assert.equal(out.ok && out.sessionId, 'claude-1')
  assert.equal(out.ok && out.source, 'claude_env')
})

test('a truncated rollout scan refuses rather than claiming a unique cwd match', () => {
  // With the scan bounded, "exactly one match" can be an artefact of the bound
  // rather than a fact: the rollout that would have made it ambiguous may be
  // one of the files never looked at. Resolving there would act on the wrong
  // session while reporting the user covered.
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-aaa', cwd: '/repo/here' },
    { file: 'rollout-2026-01-02-bbb.jsonl', id: 'codex-bbb', cwd: '/repo/elsewhere' },
  ])
  const out = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here', maxScan: 1 })
  assert.equal(out.ok, false, 'a partial listing cannot support a uniqueness claim')
  assert.match(out.ok ? '' : out.error, /bound/)

  // Unbounded, the same tree resolves: the refusal is about truncation only.
  const full = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(full.ok && full.sessionId, 'codex-aaa')
})

test('a SINGLE STALE rollout refuses: one cwd match is not evidence the session is live', () => {
  // The ambiguity refusal only fires at >=2 matches, so a cwd where Codex ran
  // exactly once, days ago, used to resolve confidently to a DEAD session id.
  // `hyp session ignore` would then opt out that dead id and report the user
  // covered while the session they are actually in keeps being recorded: the
  // same confident-answer-about-the-wrong-session defect as believing an
  // unvalidated control reply.
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-dead', cwd: '/repo/here', ageMs: 3 * 24 * 60 * 60 * 1000 },
  ])
  const out = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(out.ok, false, 'a rollout nothing has written to for days is a finished session')
  assert.match(out.ok ? '' : out.error, /rollout-2026-01-01-aaa\.jsonl/, 'name the file the refusal is about')
  assert.match(out.ok ? '' : out.error, /3d ago/, 'show the age so the user can see why')
  assert.match(out.ok ? '' : out.error, /explicitly/, 'point at the escape hatch')
})

test('a fresh rollout still resolves, and reports that the id was inferred from disk', () => {
  const home = tempCodexHome([
    { file: 'rollout-2026-01-02-bbb.jsonl', id: 'codex-live', cwd: '/repo/here', ageMs: 30 * 1000 },
  ])
  const out = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(out.ok && out.sessionId, 'codex-live')
  assert.equal(out.ok && out.source, 'codex_rollout')
  assert.equal(out.ok && out.evidence, 'rollout-2026-01-02-bbb.jsonl', 'the inference must name its evidence')
})

test('the staleness bound is what refuses, not the cwd match: the same rollout resolves under a wider bound', () => {
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-old', cwd: '/repo/here', ageMs: 2 * 60 * 60 * 1000 },
  ])
  assert.equal(resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' }).ok, false)
  const wide = resolveSessionIdForCli({
    env: { CODEX_HOME: home },
    cwd: '/repo/here',
    maxAgeMs: 24 * 60 * 60 * 1000,
  })
  assert.equal(wide.ok && wide.sessionId, 'codex-old')
})

test('a disk-inferred id is never presented as if the client had stated it', async () => {
  // The residual risk the staleness bound narrows but cannot close: a session
  // that ended minutes ago still resolves. The verb must therefore SAY the id
  // was inferred, so a wrong answer is visible rather than silent - which is
  // the whole thesis of this change applied to its own weakest input.
  const home = tempCodexHome([
    { file: 'rollout-2026-01-02-bbb.jsonl', id: 'codex-live', cwd: '/repo/here', ageMs: 30 * 1000 },
  ])
  const set = /** @type {Set<string>} */ (new Set(['codex-live']))
  await withControlServer(set, async (base) => {
    const human = fakeCtx({ endpoint: base, env: { CODEX_HOME: home } })
    assert.equal(await runSessionStatus([], human.ctx), 0)
    assert.match(human.stdout(), /INFERRED from rollout-2026-01-02-bbb\.jsonl/)

    const json = fakeCtx({ endpoint: base, env: { CODEX_HOME: home } })
    assert.equal(await runSessionStatus(['--json'], json.ctx), 0)
    const out = JSON.parse(json.stdout())
    assert.equal(out.session_id_source, 'codex_rollout')
    assert.equal(out.session_id_evidence, 'rollout-2026-01-02-bbb.jsonl')

    // `ignore` says it too: "ignored" off an inferred id reads as done.
    const mut = fakeCtx({ endpoint: base, env: { CODEX_HOME: home } })
    assert.equal(await runSessionIgnore([], mut.ctx), 0)
    assert.match(mut.stdout(), /INFERRED from rollout-2026-01-02-bbb\.jsonl/)
  })
})

/* ------------------------------------------------------------------ */
/* 5. The id the verb states is the id the gateway drops (issue #453)   */
/* ------------------------------------------------------------------ */

// @ref LLP 0067#cli-session-id [tests]: the resolved id MUST be the session
//   container the adapter drop matches, never a Codex thread id, and a rollout
//   with no container on disk MUST refuse rather than substitute the thread.

test('a Codex SUBAGENT thread resolves the session container, and that is the id the gateway actually drops', () => {
  // Issue #453. A root Codex thread takes `session_id = SessionId::from(thread_id)`,
  // so the two ids are the same uuid and nothing is visibly wrong. A SUBAGENT
  // thread inherits the root's session_id and mints its own thread_id, and its
  // shell tool calls set CODEX_THREAD_ID to the subagent thread. The drop keys
  // on session_id (exchange-projector.js), so a verb that states the thread id
  // reported an opt-out the gateway could never match: success printed over
  // continued recording.
  const home = tempCodexHome([
    {
      file: 'rollout-2026-01-05-sub.jsonl',
      id: 'thread-subagent',
      sessionId: 'session-root',
      cwd: '/repo/here',
      ageMs: 30 * 1000,
    },
  ])

  // Both resolution paths must agree on the key: the stated-thread path (a
  // `hyp` run from inside a subagent tool call) and the cwd fallback.
  const stated = resolveSessionIdForCli({
    env: { CODEX_HOME: home, CODEX_THREAD_ID: 'thread-subagent' },
    cwd: '/repo/here',
  })
  assert.equal(stated.ok && stated.sessionId, 'session-root', 'the drop key, not the thread id')
  assert.equal(stated.ok && stated.source, 'codex_env_rollout')
  assert.equal(stated.ok && stated.threadId, 'thread-subagent', 'the thread is kept for provenance')

  const viaCwd = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(viaCwd.ok && viaCwd.sessionId, 'session-root')
  assert.equal(viaCwd.ok && viaCwd.threadId, 'thread-subagent')

  // Now prove it against the code that performs the drop, rather than asserting
  // a string: the resolved id suppresses the subagent's traffic, and the thread
  // id the verb used to state suppresses nothing at all.
  const projector = createCodexExchangeProjector()
  const subagentTurn = () => codexExchange({ sessionId: 'session-root', threadId: 'thread-subagent' })

  const resolvedKey = new Set([stated.ok ? stated.sessionId : ''])
  assert.equal(
    projector.project(subagentTurn(), dropContext(resolvedKey)),
    USAGE_POLICY_DROP,
    'the id the verb states must be the id the projector drops on'
  )

  const threadKey = new Set(['thread-subagent'])
  const notDropped = /** @type {any} */ (projector.project(subagentTurn(), dropContext(threadKey)))
  assert.ok(
    notDropped && notDropped !== USAGE_POLICY_DROP,
    'the silent no-op being fixed: an opt-out on the thread id records anyway'
  )
  assert.equal(notDropped.session_id, 'session-root', 'because the row is stamped with the container')
})

test('a legacy rollout with no session_id field REFUSES: the back-filled thread id is not the key', () => {
  // The implementation trap. Codex's `SessionMetaLine` has a hand-written
  // Deserialize that BACK-FILLS `session_id` from `id` when the field is
  // absent, so a resolver reading a deserialized session_meta gets the thread
  // id back under the name `session_id` on every pre-upgrade rollout - the
  // exact defect of #453, reintroduced invisibly through its own fix. Reading
  // the raw JSONL line makes the absence visible, and an absent container is
  // unresolvable, NOT an excuse to fall back to the thread.
  const legacy = tempCodexHome([
    { file: 'rollout-2026-01-06-old.jsonl', id: 'thread-legacy', legacy: true, cwd: '/repo/here', ageMs: 30 * 1000 },
  ])

  for (const env of [
    { CODEX_HOME: legacy, CODEX_THREAD_ID: 'thread-legacy' },
    { CODEX_HOME: legacy },
  ]) {
    const out = resolveSessionIdForCli({ env, cwd: '/repo/here' })
    assert.equal(out.ok, false, 'an absent session_id is unresolvable on both paths')
    assert.match(out.ok ? '' : out.error, /no session_id field/, 'name what is missing')
    assert.match(out.ok ? '' : out.error, /thread id is NOT that container/, 'say why the thread will not do')
    assert.match(out.ok ? '' : out.error, /explicitly/, 'point at the escape hatch')
  }

  // The refusal is provably about the absent field: the same thread, in a
  // rollout that records its container, resolves.
  const modern = tempCodexHome([
    {
      file: 'rollout-2026-01-06-old.jsonl',
      id: 'thread-legacy',
      sessionId: 'session-root',
      cwd: '/repo/here',
      ageMs: 30 * 1000,
    },
  ])
  const ok = resolveSessionIdForCli({ env: { CODEX_HOME: modern, CODEX_THREAD_ID: 'thread-legacy' }, cwd: '/repo/here' })
  assert.equal(ok.ok && ok.sessionId, 'session-root')
})

test('`hyp session ignore` on a legacy rollout reports no success and exits unknown', async () => {
  // Fail-closed at the verb, not just in the resolver (R10): a privacy control
  // that cannot name the right key must say so, never print "ignored".
  const legacy = tempCodexHome([
    { file: 'rollout-2026-01-06-old.jsonl', id: 'thread-legacy', legacy: true, cwd: '/repo/here', ageMs: 30 * 1000 },
  ])
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const mut = fakeCtx({ endpoint: base, env: { CODEX_HOME: legacy, CODEX_THREAD_ID: 'thread-legacy' } })
    assert.equal(await runSessionIgnore([], mut.ctx), SESSION_EXIT_UNKNOWN)
    assert.equal(mut.stdout(), '', 'nothing that reads as a completed opt-out')
    assert.match(mut.stderr(), /no session_id field/)
    assert.equal(set.size, 0, 'and nothing was added to the ignored set')

    const status = fakeCtx({ endpoint: base, env: { CODEX_HOME: legacy, CODEX_THREAD_ID: 'thread-legacy' } })
    assert.equal(await runSessionStatus(['--json'], status.ctx), SESSION_EXIT_UNKNOWN)
    const out = JSON.parse(status.stdout())
    assert.equal(out.status, 'unknown')
    assert.equal(out.ignored, null)
    assert.equal(out.session_id, null, 'no id is reported, because none could be established')
  })
})

test('CODEX_THREAD_ID selects the live rollout without the mtime proxy, then the container is read from it', () => {
  // The liveness half of the trade-off. A Codex session that ended moments ago
  // is still inside the 30-minute staleness bound, so the cwd path resolves it
  // confidently and `hyp session ignore` would opt out a DEAD session. The
  // stated thread id is not a proxy: Codex sets it on the process it spawns for
  // a tool call, so it names the thread running now. It is a SELECTOR though -
  // the answer is still the container read out of that thread's rollout.
  const home = tempCodexHome([
    { file: 'rollout-dead.jsonl', id: 'thread-dead', sessionId: 'session-dead', cwd: '/repo/here', ageMs: 60 * 1000 },
    { file: 'rollout-live.jsonl', id: 'thread-live', sessionId: 'session-live', cwd: '/repo/other', ageMs: 5 * 1000 },
  ])
  const stated = resolveSessionIdForCli({
    env: { CODEX_HOME: home, CODEX_THREAD_ID: 'thread-live' },
    cwd: '/repo/here',
  })
  assert.equal(stated.ok && stated.sessionId, 'session-live', 'the stated thread wins over the cwd match')
  assert.equal(stated.ok && stated.evidence, 'rollout-live.jsonl')

  // A stated thread with no rollout refuses rather than falling back to the cwd
  // scan: the scan would answer about a thread nothing tied to this invocation.
  const orphan = resolveSessionIdForCli({
    env: { CODEX_HOME: home, CODEX_THREAD_ID: 'thread-unknown' },
    cwd: '/repo/here',
  })
  assert.equal(orphan.ok, false)
  assert.match(orphan.ok ? '' : orphan.error, /no rollout under .* records that thread/)

  // A blank variable is not a statement: it falls through to the cwd path.
  const blank = resolveSessionIdForCli({ env: { CODEX_HOME: home, CODEX_THREAD_ID: '  ' }, cwd: '/repo/here' })
  assert.equal(blank.ok && blank.sessionId, 'session-dead')

  // Nor is a blank Claude variable beside a real Codex thread AMBIGUITY: the
  // two-stated-clients refusal must key on what was actually stated, or an
  // exported-but-empty variable would refuse every Codex invocation.
  const oneStated = resolveSessionIdForCli({
    env: { CODEX_HOME: home, CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: 'thread-live' },
    cwd: '/repo/here',
  })
  assert.equal(oneStated.ok && oneStated.sessionId, 'session-live')
  assert.equal(oneStated.ok && oneStated.source, 'codex_env_rollout')
})

test('a BLANK session_id is as unusable as an absent one, and refuses the same way', () => {
  // A present field is not the same as a readable key. `statedEnv` already
  // treats a blank environment value as unstated; a blank `session_id` on disk
  // is the same situation one layer down, and resolving it would hand the verb a
  // key the adapter can never stamp - "ignored" printed over a drop that matches
  // nothing, which is the defect class of #453 rather than a cosmetic nit.
  const blank = tempCodexHome([
    { file: 'rollout-2026-01-09-blank.jsonl', id: 'thread-blank', sessionId: '   ', cwd: '/repo/here', ageMs: 30 * 1000 },
  ])
  for (const env of [
    { CODEX_HOME: blank, CODEX_THREAD_ID: 'thread-blank' },
    { CODEX_HOME: blank },
  ]) {
    const out = resolveSessionIdForCli({ env, cwd: '/repo/here' })
    assert.equal(out.ok, false, 'a blank container is unresolvable on both paths')
    assert.match(out.ok ? '' : out.error, /no session_id field \(or a blank one\)/)
    assert.match(out.ok ? '' : out.error, /thread id is NOT that container/, 'and never the thread id instead')
  }

  // Non-string shapes are the same story: nothing usable, so nothing claimed.
  for (const sessionId of [/** @type {any} */ (12345), /** @type {any} */ (null), /** @type {any} */ ({})]) {
    const odd = tempCodexHome([
      { file: 'rollout-2026-01-09-odd.jsonl', id: 'thread-odd', sessionId, cwd: '/repo/here', ageMs: 30 * 1000 },
    ])
    const out = resolveSessionIdForCli({ env: { CODEX_HOME: odd, CODEX_THREAD_ID: 'thread-odd' }, cwd: '/repo/here' })
    assert.equal(out.ok, false, `a ${typeof sessionId} session_id is not a session id`)
  }
})

test('the container is read from the session_meta header, not from any first line that carries the fields', () => {
  // The raw-line read is what makes an absent `session_id` visible, but reading
  // the line must not become trusting whatever the line says: only the
  // `session_meta` header states the container, so a differently-typed first
  // record is not evidence about it. `codex/src/rollout-cwd.js` type-checks the
  // same line for the same reason.
  const wrongType = tempCodexHome([
    {
      file: 'rollout-2026-01-10-ctx.jsonl',
      id: 'thread-ctx',
      sessionId: 'session-ctx',
      cwd: '/repo/here',
      type: 'turn_context',
      ageMs: 30 * 1000,
    },
  ])
  for (const env of [
    { CODEX_HOME: wrongType, CODEX_THREAD_ID: 'thread-ctx' },
    { CODEX_HOME: wrongType },
  ]) {
    assert.equal(resolveSessionIdForCli({ env, cwd: '/repo/here' }).ok, false)
  }

  // And the header itself still resolves, so the guard is about the record type.
  const header = tempCodexHome([
    { file: 'rollout-2026-01-10-ctx.jsonl', id: 'thread-ctx', sessionId: 'session-ctx', cwd: '/repo/here', ageMs: 30 * 1000 },
  ])
  const ok = resolveSessionIdForCli({ env: { CODEX_HOME: header, CODEX_THREAD_ID: 'thread-ctx' }, cwd: '/repo/here' })
  assert.equal(ok.ok && ok.sessionId, 'session-ctx')
})

test('rollouts that disagree about which session contains a thread refuse, naming both', () => {
  // The stated-thread match is an identity test, so it can hit more than one
  // file (a resumed thread, a copied history). Agreeing files are one answer;
  // disagreeing ones are two candidate keys, and picking either would opt out a
  // session the user may not be in while reporting success.
  const disagree = tempCodexHome([
    { file: 'rollout-2026-01-11-a.jsonl', id: 'thread-dup', sessionId: 'session-a', cwd: '/repo/a', ageMs: 30 * 1000 },
    { file: 'rollout-2026-01-11-b.jsonl', id: 'thread-dup', sessionId: 'session-b', cwd: '/repo/b', ageMs: 30 * 1000 },
  ])
  const out = resolveSessionIdForCli({ env: { CODEX_HOME: disagree, CODEX_THREAD_ID: 'thread-dup' }, cwd: '/repo/a' })
  assert.equal(out.ok, false)
  assert.match(out.ok ? '' : out.error, /disagree about which session contains it/)
  assert.match(out.ok ? '' : out.error, /session-a/)
  assert.match(out.ok ? '' : out.error, /session-b/)

  // Agreement is not ambiguity: two files recording the same container resolve.
  const agree = tempCodexHome([
    { file: 'rollout-2026-01-11-a.jsonl', id: 'thread-dup', sessionId: 'session-same', cwd: '/repo/a', ageMs: 30 * 1000 },
    { file: 'rollout-2026-01-11-b.jsonl', id: 'thread-dup', sessionId: 'session-same', cwd: '/repo/b', ageMs: 30 * 1000 },
  ])
  const ok = resolveSessionIdForCli({ env: { CODEX_HOME: agree, CODEX_THREAD_ID: 'thread-dup' }, cwd: '/repo/a' })
  assert.equal(ok.ok && ok.sessionId, 'session-same')
})

test('a stated thread still resolves from a rollout whose cwd is unusable: that path never reads cwd', () => {
  // #465's merge with #458. The shared reader refuses a blank or relative `cwd`
  // (LLP 0150 #usable-cwd), and the cwd-matching path wants that: a relative
  // value would be resolved against the daemon's process cwd. The stated-thread
  // path asks a different question, and answers it out of `session_id`, so an
  // unusable `cwd` must not cost it the rollout. Refusing here would turn a
  // field-level predicate into a file-level one and lose the container that IS
  // on disk.
  for (const cwd of ['   ', '../elsewhere', '']) {
    const home = tempCodexHome([
      { file: 'rollout-2026-01-12-a.jsonl', id: 'thread-nocwd', sessionId: 'session-nocwd', cwd, ageMs: 30 * 1000 },
    ])
    const out = resolveSessionIdForCli({
      env: { CODEX_HOME: home, CODEX_THREAD_ID: 'thread-nocwd' },
      cwd: '/repo/here',
    })
    assert.equal(out.ok, true, `an unusable cwd (${JSON.stringify(cwd)}) must not hide the session container`)
    assert.equal(out.ok && out.sessionId, 'session-nocwd')
    assert.equal(out.ok && out.source, 'codex_env_rollout')

    // The cwd path is the one the predicate governs: with nothing stated, that
    // same rollout matches no invocation cwd and the verb refuses.
    const noEnv = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
    assert.equal(noEnv.ok, false, 'an unusable cwd matches no invocation cwd')
  }
})

test('two clients each stating a session refuse rather than picking one', () => {
  // Environments nest (Codex runs `claude`, or the reverse) and the child
  // inherits the parent's variable while setting its own, so both can be set
  // and only one names the session this invocation is in.
  const home = tempCodexHome([
    { file: 'rollout-2026-01-07-x.jsonl', id: 'thread-x', sessionId: 'session-x', cwd: '/repo/here', ageMs: 30 * 1000 },
  ])
  const out = resolveSessionIdForCli({
    env: { CODEX_HOME: home, CLAUDE_CODE_SESSION_ID: 'claude-1', CODEX_THREAD_ID: 'thread-x' },
    cwd: '/repo/here',
  })
  assert.equal(out.ok, false)
  assert.match(out.ok ? '' : out.error, /claude-1/)
  assert.match(out.ok ? '' : out.error, /thread-x/)
})

test('a Codex answer discloses the grain it acts at, and names the thread beside the container', async () => {
  // R12 turned on the key itself rather than on its evidence: the user asked to
  // stop recording "this conversation" and the drop covers the whole session,
  // sibling subagent threads included. That is the documented over-drop
  // (LLP 0066 §scope), and it must be visible in the output rather than
  // inferred later from a gap in the cache.
  const home = tempCodexHome([
    {
      file: 'rollout-2026-01-08-sub.jsonl',
      id: 'thread-subagent',
      sessionId: 'session-root',
      cwd: '/repo/here',
      ageMs: 30 * 1000,
    },
  ])
  const set = /** @type {Set<string>} */ (new Set(['session-root']))
  await withControlServer(set, async (base) => {
    const env = { CODEX_HOME: home, CODEX_THREAD_ID: 'thread-subagent' }
    const human = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionStatus([], human.ctx), 0)
    assert.match(human.stdout(), /session session-root: ignored/)
    assert.match(human.stdout(), /every Codex thread in this session is covered/)
    assert.match(human.stdout(), /thread thread-subagent/)

    const json = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionStatus(['--json'], json.ctx), 0)
    const out = JSON.parse(json.stdout())
    assert.equal(out.session_id, 'session-root')
    assert.equal(out.thread_id, 'thread-subagent')
    assert.equal(out.session_id_source, 'codex_env_rollout')
    assert.equal(out.session_id_evidence, 'rollout-2026-01-08-sub.jsonl')

    // `ignore` carries it too, where "ignored" reads as done.
    const mut = fakeCtx({ endpoint: base, env })
    assert.equal(await runSessionIgnore(['--json'], mut.ctx), 0)
    assert.equal(JSON.parse(mut.stdout()).thread_id, 'thread-subagent')
  })
})

test('an endpoint nothing proved is the gateway is reported as such', async () => {
  // `validateControlResponse` proves the responder saw our token, not that it
  // is the gateway. When the port came from a pinned `listen` rather than a
  // live daemon's status.json, that gap is named next to the answer.
  const set = /** @type {Set<string>} */ (new Set(['sess-pinned']))
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-pinned' } })
    assert.equal(await runSessionStatus([], ctx.ctx), 0)
    assert.match(ctx.stdout(), /pinned `listen`, not a live daemon/)

    const json = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-pinned' } })
    await runSessionStatus(['--json'], json.ctx)
    assert.equal(JSON.parse(json.stdout()).endpoint_source, 'config_listen')
  })
})

test('`--` ends flag parsing so a session id beginning with `-` is reachable', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: {} })
    assert.equal(await runSessionIgnore(['--', '-dash-id'], ctx.ctx), 0)
    assert.ok(set.has('-dash-id'), 'without a terminator this id could never be named at all')

    // `--json` after the terminator is a literal id, not a flag, so it is a
    // second positional and must be a usage error rather than silently eaten.
    const two = fakeCtx({ endpoint: base, env: {} })
    assert.equal(await runSessionStatus(['--', '-dash-id', '--json'], two.ctx), 2)
  })
})

test('an oversized control response is refused rather than buffered', async () => {
  await withRogueServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 8; i++) res.write(chunk)
    res.end()
  }, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-real' } })
    assert.equal(await runSessionStatus(['--json'], ctx.ctx), SESSION_EXIT_UNKNOWN)
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.ignored, null)
    // Cut off AT the bound, not swallowed whole and only then found
    // unparseable: whatever owns the port must not be able to grow this
    // process at will.
    assert.match(out.reason, /more than \d+ bytes/)
  })
})

test('an unresolvable session id fails closed, it does not report not-ignored', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CODEX_HOME: tempCodexHome([]) } })
    const code = await runSessionStatus(['--json'], ctx.ctx)
    assert.equal(code, SESSION_EXIT_UNKNOWN)
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.status, 'unknown')
    assert.equal(out.ignored, null)
  })
})

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {Set<string>} set
 * @param {(base: string) => Promise<void>} fn
 */
async function withControlServer(set, fn) {
  const handler = createControlHandler({ ignoredSessions: set })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    handler(/** @type {IncomingMessage} */ (req), /** @type {ServerResponse} */ (res), url)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }
}

/** @param {string} base @param {string} sessionId */
function postSession(base, sessionId) {
  return rawRequest(base, 'POST', '/_hypaware/ignore/session', JSON.stringify({ session_id: sessionId }))
}

/** @param {string} base @param {string} sessionId */
function getSession(base, sessionId) {
  const qs = new URLSearchParams({ session_id: sessionId }).toString()
  return rawRequest(base, 'GET', `/_hypaware/ignore/session?${qs}`)
}

/**
 * @param {string} base
 * @param {string} method
 * @param {string} pathname
 * @param {string} [body]
 * @returns {Promise<{ status: number, body: any }>}
 */
function rawRequest(base, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base)
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { 'content-type': 'application/json' } },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          let parsed
          try { parsed = JSON.parse(raw) } catch { parsed = raw }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Bind then release a port so nothing is listening on it. */
async function closedPort() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise((resolve) => server.close(() => resolve(undefined)))
  return port
}

/**
 * Minimal `CommandRunContext` stand-in. `endpoint` is threaded through the
 * gateway plugin's configured `listen`, which is exactly how the CLI resolves
 * it when no live daemon status file is present.
 *
 * @param {{ endpoint?: string, env?: Record<string, string>, cwd?: string }} args
 */
function fakeCtx(args) {
  let out = ''
  let err = ''
  const listen = args.endpoint ? args.endpoint.replace(/^https?:\/\//, '') : undefined
  const hypHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-session-home-'))
  const ctx = {
    stdout: { write: (/** @type {string} */ s) => { out += s; return true } },
    stderr: { write: (/** @type {string} */ s) => { err += s; return true } },
    env: { HYP_HOME: hypHome, ...(args.env ?? {}) },
    cwd: args.cwd ?? '/repo/here',
    config: {
      version: 2,
      plugins: listen
        ? [{ name: '@hypaware/ai-gateway', config: { listen } }]
        : [{ name: '@hypaware/ai-gateway' }],
    },
  }
  return { ctx: /** @type {any} */ (ctx), stdout: () => out, stderr: () => err }
}

/**
 * One live Codex ChatGPT-route exchange, tagged with the turn metadata a
 * subagent turn carries: its own `thread_id`, and the `session_id` of the
 * session containing it. This is the input the drop actually sees, so the tests
 * above can assert the CLI's key against the real projector rather than against
 * a restatement of it.
 *
 * @param {{ sessionId: string, threadId: string }} ids
 */
function codexExchange(ids) {
  return /** @type {any} */ ({
    exchange_id: 'ex-subagent',
    ts_start: '2026-05-20T10:00:00.000Z',
    ts_end: '2026-05-20T10:00:00.250Z',
    provider: 'chatgpt',
    method: 'POST',
    path: '/backend-api/codex/responses',
    status_code: 200,
    is_sse: false,
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({ session_id: ids.sessionId, thread_id: ids.threadId }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go' }),
    response_headers: JSON.stringify({}),
    response_body: JSON.stringify({ output_text: 'done' }),
    stream_events: [],
  })
}

/**
 * The projector context the gateway dispatcher supplies, with the ignored-session
 * predicate backed by `ignored`.
 *
 * @param {Set<string>} ignored
 */
function dropContext(ignored) {
  return {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    isSessionIgnored: (/** @type {string} */ id) => ignored.has(id),
  }
}

/**
 * Build a throwaway `CODEX_HOME` holding `sessions/**\/rollout-*.jsonl` files
 * whose first line is a `session_meta` record.
 *
 * `id` is the **thread** id (`payload.id`, the value the filename embeds).
 * `sessionId` is the session CONTAINER (`payload.session_id`), which is what
 * the gateway drops on; it defaults to `id`, the root-thread shape Codex writes
 * via `SessionId::from(thread_id)`. Pass a different value for a subagent
 * rollout, or `legacy: true` for a rollout written before Codex recorded the
 * container at all.
 *
 * `ageMs` backdates the file's mtime, which is how the resolver tells a running
 * session (appended to on every turn) from a finished one.
 *
 * `type` overrides the first line's envelope type, so a test can present a
 * record that carries `id`/`session_id`/`cwd` but is not the session header.
 *
 * @param {{ file: string, id: string, sessionId?: unknown, legacy?: boolean, cwd: string, ageMs?: number, type?: string }[]} rollouts
 */
function tempCodexHome(rollouts) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-codex-home-'))
  const dir = path.join(home, 'sessions', '2026', '01')
  fs.mkdirSync(dir, { recursive: true })
  for (const r of rollouts) {
    /** @type {Record<string, unknown>} */
    const payload = { id: r.id, cwd: r.cwd }
    // `in` rather than `??` so an explicit null survives as a null: a field
    // present with an unusable value is a distinct case from an absent one.
    if (!r.legacy) payload.session_id = 'sessionId' in r ? r.sessionId : r.id
    const meta = JSON.stringify({ type: r.type ?? 'session_meta', payload })
    const full = path.join(dir, r.file)
    fs.writeFileSync(full, `${meta}\n{"type":"event"}\n`)
    if (r.ageMs) {
      const when = new Date(Date.now() - r.ageMs)
      fs.utimesSync(full, when, when)
    }
  }
  return home
}
