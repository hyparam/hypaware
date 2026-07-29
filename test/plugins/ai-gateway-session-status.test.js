// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createControlHandler } from '../../hypaware-core/plugins-workspace/ai-gateway/src/control.js'
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

test('CODEX_THREAD_ID beats the disk scan: a stated id is not an inference', () => {
  // Issue #442 item A. The rollout scan resolves `session_meta.payload.id`,
  // which is the Codex thread id - the same value Codex now states directly in
  // `CODEX_THREAD_ID` for every tool subprocess it spawns. Same identifier,
  // but stated by the running client instead of inferred from a file's mtime.
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-from-disk', cwd: '/repo/here', ageMs: 30 * 1000 },
  ])
  const out = resolveSessionIdForCli({
    env: { CODEX_HOME: home, CODEX_THREAD_ID: 'codex-stated' },
    cwd: '/repo/here',
  })
  assert.equal(out.ok && out.sessionId, 'codex-stated')
  assert.equal(out.ok && out.source, 'codex_env')
  assert.equal(out.ok && out.evidence, undefined, 'a stated id has no disk evidence to name')
})

test('the 30-minute stale-rollout window cannot hand out a DEAD id when Codex states the live one', () => {
  // The exact residual issue #442 item A recorded. A Codex session that ended
  // moments ago still has a rollout inside the staleness bound, so the disk
  // path resolves it confidently: `hyp session ignore` would then opt out the
  // finished session, print "the gateway will drop this session", and leave the
  // session the user is actually in recording. mtime is a liveness PROXY.
  //
  // `CODEX_THREAD_ID` is not a proxy: Codex injects it into the environment of
  // the process it spawns for a tool call, so a session that has ended cannot
  // have set it. Taking it first closes the window for this path outright.
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-dead.jsonl', id: 'codex-just-ended', cwd: '/repo/here', ageMs: 60 * 1000 },
  ])
  const withoutEnv = resolveSessionIdForCli({ env: { CODEX_HOME: home }, cwd: '/repo/here' })
  assert.equal(
    withoutEnv.ok && withoutEnv.sessionId,
    'codex-just-ended',
    'the recently-written rollout is inside the bound, so the disk path still resolves it'
  )

  const withEnv = resolveSessionIdForCli({
    env: { CODEX_HOME: home, CODEX_THREAD_ID: 'codex-actually-live' },
    cwd: '/repo/here',
  })
  assert.equal(withEnv.ok && withEnv.sessionId, 'codex-actually-live', 'the live session, not the one that just ended')
  assert.equal(withEnv.ok && withEnv.source, 'codex_env')
})

test('two clients each stating a session id is ambiguity, and ambiguity refuses', () => {
  // Environments nest: Codex runs `claude`, or Claude runs `codex`, and the
  // child inherits the parent's variable while setting its own. Whichever is
  // preferred is wrong half the time, and being wrong here means opting out a
  // session the user is not in and reporting it done. Refuse and name both.
  const out = resolveSessionIdForCli({
    env: { CLAUDE_CODE_SESSION_ID: 'claude-outer', CODEX_THREAD_ID: 'codex-inner' },
    cwd: '/repo/here',
  })
  assert.equal(out.ok, false, 'neither variable is more authoritative than the other')
  assert.match(out.ok ? '' : out.error, /claude-outer/, 'name both candidates')
  assert.match(out.ok ? '' : out.error, /codex-inner/)
  assert.match(out.ok ? '' : out.error, /explicitly/, 'point at the escape hatch')
})

test('an empty CODEX_THREAD_ID is not a stated id: it falls through rather than resolving to nothing', () => {
  const home = tempCodexHome([
    { file: 'rollout-2026-01-01-aaa.jsonl', id: 'codex-aaa', cwd: '/repo/here', ageMs: 30 * 1000 },
  ])
  const out = resolveSessionIdForCli({
    env: { CODEX_HOME: home, CODEX_THREAD_ID: '   ' },
    cwd: '/repo/here',
  })
  assert.equal(out.ok && out.sessionId, 'codex-aaa')
  assert.equal(out.ok && out.source, 'codex_rollout')

  // A blank Claude variable alongside a real Codex one is not ambiguity either.
  const one = resolveSessionIdForCli({
    env: { CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: 'codex-live' },
    cwd: '/repo/here',
  })
  assert.equal(one.ok && one.sessionId, 'codex-live')
})

test('an explicit session id argument still beats a Codex-stated one', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CODEX_THREAD_ID: 'codex-stated' } })
    assert.equal(await runSessionIgnore(['explicit-id', '--json'], ctx.ctx), 0)
    assert.ok(set.has('explicit-id'))
    assert.equal(set.has('codex-stated'), false)
  })
})

test('a Codex-stated id is reported as stated, not as INFERRED from disk', async () => {
  // The provenance line exists to qualify an inference. Attaching it to an id
  // the client stated would train the reader to ignore it on the one path
  // where it is load-bearing.
  const set = /** @type {Set<string>} */ (new Set(['codex-stated']))
  await withControlServer(set, async (base) => {
    const human = fakeCtx({ endpoint: base, env: { CODEX_THREAD_ID: 'codex-stated' } })
    assert.equal(await runSessionStatus([], human.ctx), 0)
    assert.doesNotMatch(human.stdout(), /INFERRED/)

    const json = fakeCtx({ endpoint: base, env: { CODEX_THREAD_ID: 'codex-stated' } })
    assert.equal(await runSessionStatus(['--json'], json.ctx), 0)
    const out = JSON.parse(json.stdout())
    assert.equal(out.session_id, 'codex-stated')
    assert.equal(out.session_id_source, 'codex_env')
    assert.equal(out.session_id_evidence, null)
  })
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
 * Build a throwaway `CODEX_HOME` holding `sessions/**\/rollout-*.jsonl` files
 * whose first line is a `session_meta` record.
 *
 * `ageMs` backdates the file's mtime, which is how the resolver tells a running
 * session (appended to on every turn) from a finished one.
 *
 * @param {{ file: string, id: string, cwd: string, ageMs?: number }[]} rollouts
 */
function tempCodexHome(rollouts) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-codex-home-'))
  const dir = path.join(home, 'sessions', '2026', '01')
  fs.mkdirSync(dir, { recursive: true })
  for (const r of rollouts) {
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: r.id, cwd: r.cwd } })
    const full = path.join(dir, r.file)
    fs.writeFileSync(full, `${meta}\n{"type":"event"}\n`)
    if (r.ageMs) {
      const when = new Date(Date.now() - r.ageMs)
      fs.utimesSync(full, when, when)
    }
  }
  return home
}
