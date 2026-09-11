// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createControlHandler } from '../../src/core/control/session_ignore.js'
import { DEFAULT_GATEWAY_ENDPOINT } from '../../src/core/config/gateway_endpoint.js'
import { CLAUDE_TELEMETRY_SOURCE } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/source.js'
import { createCodexExchangeProjector } from '../../hypaware-core/plugins-workspace/codex/src/exchange-projector.js'
import { USAGE_POLICY_DROP } from '../../src/core/usage-policy/index.js'
import { runSessionIgnore, runSessionStatus, runSessionUnignore } from '../../hypaware-core/plugins-workspace/ai-gateway/src/session_command.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 */

/**
 * Regression suite for issue #460: the `POST` receipt claimed a drop it could
 * not have verified.
 *
 * The shared control handler adds an opaque token to a `Set` and answers `ignored: true` for
 * whatever it was handed; the drop happens later, in the client adapter, keyed
 * on the `session_id` that adapter stamps on the row. Nothing compares the two,
 * so the receipt is evidence of a write and of nothing else - yet
 * `hyp session ignore` printed "the gateway will drop this session", which is
 * a statement about live traffic the gateway never sees.
 *
 * The tests below pin the false-confidence case end to end rather than
 * asserting a string in isolation: an id that live traffic does not carry is
 * registered successfully, the REAL projector is then shown recording that
 * traffic anyway, and the receipt printed over that outcome is required not to
 * have promised otherwise.
 *
 * @ref LLP 0066#receipt-is-membership [tests]: R14 - `ignored: true` is set
 * membership, so the receipt reports the write and names who owns the key.
 * @ref LLP 0067#cli-receipt [tests]
 */

/* ------------------------------------------------------------------ */
/* 1. The receipt must not promise a drop the gateway cannot verify    */
/* ------------------------------------------------------------------ */

test('a successful ignore receipt does not claim a drop, for an id live traffic never carries', async () => {
  // The exact false-confidence case. A Codex SUBAGENT thread inherits the
  // root's session container and mints its own thread id, and the two are
  // easy to confuse (they are the same uuid on a root thread). A user - or a
  // skill resolving on its own - hands the THREAD id to `hyp session ignore`.
  const threadId = 'thread-subagent'
  const containerId = 'session-root'

  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base })
    const code = await runSessionIgnore([threadId], ctx.ctx)

    // The write itself genuinely succeeded: the route holds the token now.
    assert.equal(code, 0)
    assert.ok(set.has(threadId), 'the id is in the set - that much is true')

    // And it drops nothing. Proven against the code that performs the drop,
    // not against a restatement of it: the session's live exchanges are
    // stamped with the CONTAINER, so the registered thread id matches none of
    // them and the turn is recorded exactly as if no opt-out had been made.
    const projector = createCodexExchangeProjector()
    const recorded = /** @type {any} */ (
      projector.project(codexExchange({ sessionId: containerId, threadId }), dropContext(set))
    )
    assert.ok(
      recorded && recorded !== USAGE_POLICY_DROP,
      'precondition: the registered id matches no live traffic, so nothing is dropped'
    )
    assert.equal(recorded.session_id, containerId)

    // So the receipt printed over that outcome must not have claimed a drop.
    const out = ctx.stdout()
    assert.doesNotMatch(
      out,
      /will drop this session/,
      'the gateway never saw an exchange; it cannot promise a drop, and here there is none'
    )
    assert.doesNotMatch(out, /gateway will drop/, 'no phrasing of the same promise')

    // What it may claim - the write - it must claim plainly.
    assert.match(out, /in the gateway drop set/, 'report the membership that IS established')

    // And it must state the bound, next to the success, where a caller reading
    // "ignored" as done would see it.
    assert.match(out, /what this proves/, 'the receipt names what it is a receipt for')
    assert.match(out, /never inspects traffic/, 'why the gateway cannot say more')
    assert.match(out, /suppresses nothing/, 'the failure this receipt cannot rule out')
    assert.match(out, /the caller/, 'and where the guarantee actually comes from (R13)')
  })
})

test('the --json receipt states its guarantee, so `status: ok` cannot read as "dropped"', async () => {
  // The skills parse this form, and an agent reads a bare `ok` as done. The
  // machine-readable receipt therefore says what kind of ok it is.
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base })
    assert.equal(await runSessionIgnore(['thread-subagent', '--json'], ctx.ctx), 0)
    const out = JSON.parse(ctx.stdout())
    assert.equal(out.status, 'ok')
    assert.equal(out.ignored, true)
    assert.equal(
      out.guarantee,
      'set_membership',
      'the receipt names the claim it is making, rather than leaving `ok` to be read as a verified drop'
    )
  })
})

test('the unignore receipt reports the removal, not a resumption it cannot verify', async () => {
  // R14 mirrored. "recording resumed" is the same inference from the same
  // `Set` answer, read the other way: a token nothing carried was suppressing
  // nothing to resume, and `.hypignore` is an independent governor (R7) that
  // can keep the session unrecorded regardless of what this verb just removed.
  const set = new Set(['thread-subagent'])
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base })
    assert.equal(await runSessionUnignore(['thread-subagent'], ctx.ctx), 0)
    assert.ok(!set.has('thread-subagent'), 'the removal itself happened - that much is true')
    const out = ctx.stdout()
    assert.match(out, /out of the gateway drop set/, 'report the membership that IS established')
    assert.doesNotMatch(out, /recording resumed/, 'the gateway cannot know recording resumed')
  })
})

test('the reader carries the same qualifier, so writer and reader cannot drift', async () => {
  // `status` answers the same `Set.has` question, so a confirmed `ignored`
  // there rests on the identical bound. One shared constant, as with the
  // ephemerality caveat: two statements of one contract drift apart.
  const set = new Set(['sess-live'])
  await withControlServer(set, async (base) => {
    const ctx = fakeCtx({ endpoint: base, env: { CLAUDE_CODE_SESSION_ID: 'sess-live' } })
    assert.equal(await runSessionStatus([], ctx.ctx), 0)
    assert.match(ctx.stdout(), /what this proves/)
    assert.match(ctx.stdout(), /never inspects traffic/)
  })
})

/* ------------------------------------------------------------------ */
/* 2. The skills that call the route directly validate the reply       */
/* ------------------------------------------------------------------ */

// Only the privacy skills still post to the control route from shell. The
// `hypaware-ignore` / `hypaware-unignore` skills were retired (LLP 0212): the
// session opt-out is `hyp session ignore` now, whose receipt is held to R14 by
// section 1 above, so there is no second shell implementation of it to bind.
const SKILLS = [
  'claude/skills/hypaware-privacy/SKILL.md',
  'codex/skills/hypaware-privacy/SKILL.md',
]

/**
 * The sentence each copy must carry to scope its shell fallback, pinned per copy
 * because the two fallbacks can serve different failures (issue #1628).
 *
 * The claude script is never the right answer to an id-resolution failure: with
 * `CLAUDE_CODE_SESSION_ID` unset it exits 1 before any POST, and the one such
 * refusal that happens with the variable set (a second client also stating an
 * id) Step 1 routes to the stated-id re-run rather than here, because that
 * re-run reaches every recorder where the script reaches the gateway alone.
 * A missing `hyp` is the whole of what its fallback covers, so a sentence
 * licensing more of them contradicts the routing further down Step 1.
 *
 * The codex script resolves the container by walking every rollout for a `cwd`
 * match, where `resolveSessionIdForCli` refuses once that scan hits its
 * `MAX_ROLLOUT_SCAN` bound, so there a verb that cannot resolve the session is
 * a case the script really can serve and the wider scoping is accurate.
 *
 * @type {Record<string, RegExp>}
 */
const FALLBACK_SCOPE = {
  'claude/skills/hypaware-privacy/SKILL.md':
    /Only where it is unavailable \(`command not found`\) does the script below apply/,
  'codex/skills/hypaware-privacy/SKILL.md':
    /Only where it is unavailable, or cannot resolve the session, does the script below apply/,
}

/** @param {string} rel */
function skillText(rel) {
  return fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hypaware-core/plugins-workspace', rel),
    'utf8'
  )
}

/**
 * Just the "Protect this session first" section. Every assertion about the
 * opt-out recipe is scoped to it, so a later step mentioning the verb in
 * passing can neither satisfy nor break one.
 *
 * @param {string} rel
 * @returns {string}
 */
function privacyStep1(rel) {
  const text = skillText(rel)
  const start = text.indexOf('## Step 1')
  const end = text.indexOf('## Step 2')
  assert.ok(start >= 0 && end > start, 'Step 1 must still be a section of its own')
  return text.slice(start, end)
}

for (const rel of SKILLS) {
  test(`${rel} checks the control reply is about the session it posted`, () => {
    // R14's second half. The JS resolver refuses a reply naming a different
    // session (`validateControlResponse`); the shell paths in the skills
    // printed `opt-out confirmed` off whatever came back, so a reply about
    // another session - or from whatever else now owns that port - read as
    // this session's success. That does not prove the drop (nothing here
    // does), but without it a second overclaim stacks on the first.
    const text = skillText(rel)

    // The verifier compares the echoed id against the one that was posted,
    // rather than printing the value the responder chose to send back.
    assert.match(
      text,
      /r\.get\("session_id"\) != expected/,
      'the echoed session_id must be compared with the id that was sent'
    )
    assert.match(text, /isinstance\(r\.get\("total"\), int\)/, 'and `total` must be a real number')
    // `isinstance(True, int)` is True in Python, so the int test alone is
    // weaker than the CLI's `typeof total !== "number"` it claims to mirror:
    // a responder answering `total: true` would pass here and fail there.
    assert.match(
      text,
      /isinstance\(r\.get\("total"\), bool\)/,
      'and a JSON `true` must not satisfy the numeric check the CLI applies'
    )
    assert.doesNotMatch(
      text,
      /opt-out confirmed for session %s[^\n]*% \(r\.get\("session_id"\)/,
      'the confirmation must not echo the responder-supplied id as if it were verified'
    )

    // And the reply is described as the membership receipt it is.
    assert.match(text, /drop set, and nothing more/, 'state the narrow contract plainly')
  })
}

/* ------------------------------------------------------------------ */
/* 3. Both privacy skills lead with the CLI verb, not the shell POST   */
/* ------------------------------------------------------------------ */

/**
 * A privacy review's Step 1 opts the review session out before it discusses the
 * machine's most sensitive content, so which surface it reaches for decides
 * whether the opt-out reaches every recorder. `hyp session ignore` addresses
 * each one advertising the control route (LLP 0256 #cli-posts-to-both); a shell
 * `curl` reaches one, and since LLP 0262 the recorder capturing a Claude
 * session is usually the OTHER one, the `@hypaware/claude` telemetry listener.
 *
 * Nothing downstream can catch that: the control route holds the id as an
 * opaque token and answers `ignored: true` for whatever it was handed, so a
 * recorder that was never asked is indistinguishable from a confirmed opt-out.
 * The choice is a property of the markdown, which is why it is pinned here.
 *
 * @ref LLP 0212#cli-is-the-verb [tests]: the CLI verb is the opt-out; a shell
 * POST may only appear below it, as the documented fallback.
 */
for (const rel of SKILLS) {
  test(`${rel} reaches for the CLI verb before any shell POST`, () => {
    const step1 = privacyStep1(rel)

    const verbAt = step1.indexOf('hyp session ignore')
    const postAt = step1.indexOf('/_hypaware/ignore/session')
    assert.ok(verbAt >= 0, '`hyp session ignore` must be named in Step 1')
    assert.ok(
      postAt < 0 || verbAt < postAt,
      'the CLI verb must come before the shell POST, which is the fallback and not the path'
    )

    // Framed as the preference, not offered as one of two equals: a model given
    // two interchangeable recipes will pick either.
    assert.match(
      step1,
      /Prefer `hyp session ignore --json`/,
      'Step 1 must state the preference in words, not just mention the verb'
    )
    assert.match(
      step1,
      FALLBACK_SCOPE[rel],
      'the shell block must be scoped to where the verb cannot serve, and to no more than that'
    )
  })
}

/**
 * The expansion each copy's fallback default sits in. The claude script defaults
 * `ANTHROPIC_BASE_URL` directly; the codex one defaults `BASE`, after
 * `OPENAI_BASE_URL` and the `config.toml` read have both missed. So the positive
 * assertion is per-copy. The negative one is not, and that is the point: #1620
 * corrected the literal in the claude copy and pinned it with a claude-only
 * `doesNotMatch`, leaving the codex copy on the same stale default with nothing
 * to catch it (issue #1631).
 *
 * @type {Record<string, string>}
 */
const FALLBACK_DEFAULT = {
  'claude/skills/hypaware-privacy/SKILL.md': `ANTHROPIC_BASE_URL:-${DEFAULT_GATEWAY_ENDPOINT}`,
  'codex/skills/hypaware-privacy/SKILL.md': `BASE:-${DEFAULT_GATEWAY_ENDPOINT}`,
}

for (const rel of SKILLS) {
  test(`${rel} fallback names the real default gateway endpoint`, () => {
    // LLP 0212 recorded `http://127.0.0.1:8787` as a shipped defect: it is not
    // the port an unpinned gateway binds, and where nothing sets a base url
    // there is nothing to mask it, so the fallback addressed a closed port.
    // Pinned to the constant rather than the literal so the two cannot drift.
    const text = skillText(rel)
    const expansion = FALLBACK_DEFAULT[rel]
    assert.ok(
      text.includes(expansion),
      `${rel} must default its base to DEFAULT_GATEWAY_ENDPOINT, as ${expansion}`
    )
    // Naming the right port somewhere is weaker than not naming the wrong one:
    // the stale literal reintroduced in any other arm of the chain would leave
    // the assertion above satisfied and the fallback still pointing nowhere.
    assert.doesNotMatch(text, /127\.0\.0\.1:8787/, 'and the stale 8787 default must be gone from the file')
  })
}

// @ref LLP 0403#contract [tests]: both hosts describe durable opt-out and forks.
for (const rel of SKILLS) {
  test(`${rel} names persistence and the fork boundary`, () => {
    const step1 = privacyStep1(rel)
    const at = step1.indexOf('The opt-out is saved locally')
    assert.ok(at >= 0, 'Step 1 must state that exclusions are saved')
    const para = step1.slice(at).split(/\n\s*\n/)[0]
    assert.match(para, /survives recorder and daemon restarts/)
    assert.match(para, /until explicitly removed/)
    assert.match(para, rel.startsWith('claude/') ? /claude --fork-session/ : /codex fork/)
    assert.match(para, /Transcript backfill honors the saved exclusion/)
    assert.doesNotMatch(step1, /restart.{0,40}drops it/i)
  })
}

/** The words the claude copy's Step 1 opens its stop list with, bolded as it writes them. */
const CLAUDE_STOP_LIST_OPENER = '**Stop on any of these**'

/** The words the claude copy's Step 1 opens the two-clients-state-an-id refusal with. */
const CLAUDE_AMBIGUITY_OPENER = '**If the verb refuses because more than one client states an id**'

/**
 * The receipt tells the agent to stop unless the recorder that captures THIS
 * session appears in `recorders`, which only works if the skill names the id
 * that recorder actually reports. `runMutation` fills `recorders[].recorder`
 * from the live snapshot's `source.name`, which for the telemetry listener is
 * `CLAUDE_TELEMETRY_SOURCE` - so the skill and the source must not drift.
 *
 * Checked because the failure is silent in the direction that matters: a skill
 * naming a recorder id nothing reports would find it missing from every
 * receipt and stop on a session that was in fact covered, and the obvious
 * "fix" for that noise is to delete the check that makes the opt-out real.
 *
 * @ref LLP 0256#cli-posts-to-both [tests]: the listener is a recorder in its
 * own right, so the skill's coverage check has to be able to find it.
 */
test('the claude privacy skill names the recorder id the listener reports', () => {
  const step1 = privacyStep1('claude/skills/hypaware-privacy/SKILL.md')

  // The check has to be a stop condition, not an observation: the whole bug
  // this skill's Step 1 was rewritten for is an `ok` over a recorder that was
  // never addressed (issue #1615).
  const at = step1.indexOf(CLAUDE_STOP_LIST_OPENER)
  assert.ok(at >= 0, `the receipt readings must be framed as stop conditions, opening "${CLAUDE_STOP_LIST_OPENER}"`)
  const rest = step1.slice(at)
  const end = rest.search(/\n\s*\n/)
  const stopList = end < 0 ? rest : rest.slice(0, end)

  // Scoped to the stop list itself. Step 1 names `claude-telemetry` twice more,
  // in the receipt bullet above the list and in the stated-id re-run below it,
  // so a Step-1-wide `includes` is satisfied by either bystander and an edit
  // demoting the recorder check to commentary passes it (issue #1627).
  //
  // It pins the clause rather than the bare id for the same reason one level
  // down: an aside inside this paragraph names the id too ("for reference,
  // `"recorders"` usually lists `claude-telemetry`"), so a bare `includes`
  // survives deleting the stop it is supposed to be guarding. The phrase is
  // built from the imported id, which is what keeps skill and source pinned
  // together.
  const missingEntryClause = `no \`${CLAUDE_TELEMETRY_SOURCE}\` entry`
  assert.ok(
    stopList.includes(missingEntryClause),
    `"${missingEntryClause}" must be one of the stop conditions, not an aside that only mentions the id`
  )
  assert.match(
    stopList,
    /a `"session_id_source"` other than `claude_env`/,
    'an id resolved off disk for another session must be one of them'
  )
  // And the one documented exception to that stop, or Step 1 routes the
  // ambiguous case to a re-run whose receipt trips the stop it just set: the
  // re-run states the id, so it reports `argument` by construction.
  assert.match(
    stopList,
    /\bexception\b[\s\S]*`argument`/,
    'the stated-id re-run reports `argument`, so the stop must carry it as the exception'
  )
})

/**
 * Where Step 1 sends the one id-resolution refusal that happens with
 * `CLAUDE_CODE_SESSION_ID` set: a second client stating an id too, so the verb
 * will not guess. The answer is the same verb with the id stated, which still
 * addresses every recorder; the shell block below reaches the gateway alone, so
 * rerouting this refusal there reports an opt-out of the machine over a live
 * telemetry listener - the `ok`-over-a-skipped-recorder failure Step 1 exists
 * to prevent.
 *
 * @ref LLP 0256#cli-posts-to-both [tests]: the re-run belongs here because it
 * reaches both recorders where the script reaches one.
 */
test('the claude privacy skill answers an ambiguous id with the stated-id re-run, not the fallback', () => {
  const step1 = privacyStep1('claude/skills/hypaware-privacy/SKILL.md')

  const at = step1.indexOf(CLAUDE_AMBIGUITY_OPENER)
  assert.ok(at >= 0, `Step 1 must still route the ambiguous case, opening "${CLAUDE_AMBIGUITY_OPENER}"`)
  const rest = step1.slice(at)
  const open = rest.indexOf('```')
  const close = rest.indexOf('```', open + 3)
  assert.ok(open > 0 && close > open, 'and must still answer it with a command block')
  // Through the paragraph after the fence, not just to the fence. A reroute
  // reads most naturally as the next sentence after the answer ("If that also
  // refuses, drop to the script below"), which a slice ending at the fence
  // leaves outside the guard entirely (issue #1627).
  const afterFence = rest.slice(close + 3)
  const gap = afterFence.search(/\S/)
  const brk = gap < 0 ? -1 : afterFence.slice(gap).search(/\n\s*\n/)
  const follows = gap < 0 ? 0 : brk < 0 ? afterFence.length : gap + brk
  const routing = rest.slice(0, close + 3 + follows)

  // Scoped to that block. Both `hyp session ignore` and the fallback are named
  // throughout Step 1, so a Step-1-wide match says nothing about where THIS
  // refusal is sent: a reroute that names the re-run in a later aside passes it.
  assert.match(
    routing,
    /hyp session ignore --json "\$CLAUDE_CODE_SESSION_ID"/,
    'the answer is the verb again with the id stated, which still reaches every recorder'
  )
  // The emphasis is optional because this copy bolds the refusal already
  // (`do **not** drop`), and an unbolded rewrite is the same sentence.
  assert.match(
    routing,
    /do \*{0,2}not\*{0,2} drop to the script below/,
    'and the gateway-only script must be refused in words, not left standing as the other option'
  )
  // The refusal is licensed to name the script, to refuse it. Any other pointer
  // to it in this block is a reroute whichever sentence carries it, so every
  // instance of the licensed phrase is dropped before the block is held to
  // that: restating the refusal is stronger prose, not a second route.
  assert.doesNotMatch(
    routing.replace(/do \*{0,2}not\*{0,2} drop to the script below/g, ''),
    /drop to the script|fall back to the script|use the script below/,
    'nothing else in this block may send the ambiguous case to the gateway-only script'
  )
  assert.doesNotMatch(
    routing,
    /_hypaware\/ignore\/session|curl /,
    'an ambiguous id must not be answered with a gateway-only POST'
  )
})

/** The words both copies open their stop list with. */
const STOP_LIST_OPENER = '**Stop on any of these**'

/**
 * The one receipt reading whose substance is host-agnostic, so it is pinned
 * over both copies rather than per copy: `runMutation` reports `partial`
 * (exit 3) when a recorder it addressed refused, and the recorder that refused
 * is the one still recording, whichever client the session belongs to. Which
 * sources and which recorder are right do differ by host, and are pinned in
 * each copy's own suite.
 *
 * Looped because the per-copy guard is what let this drift: the check #1620
 * added names `claude_env` and `claude-telemetry`, so it could only ever have
 * run on one copy, and the codex copy carried no stop at all (issue #1633).
 *
 * @ref LLP 0256#cli-posts-to-both [tests]: partial is not swallowed, so the
 * surface reading the receipt must not swallow it either.
 */
const PARTIAL_RECEIPT_BULLET =
  /- exit `0` with `"status": "ok"`\. `"status": "partial"` \(exit 3\) means an addressed recorder \*\*refused and is still recording\*\*\./

for (const rel of SKILLS) {
  test(`${rel} stops on a partial receipt, where an addressed recorder kept recording`, () => {
    const step1 = privacyStep1(rel)

    assert.match(
      step1,
      PARTIAL_RECEIPT_BULLET,
      'Step 1 must say what `partial` means: a recorder refused and is still recording'
    )

    // Scoped to the stop paragraph itself. Explaining `partial` in a bullet
    // while leaving it out of the list the agent acts on is the shape that
    // ships a documented-but-unenforced stop, so the whole-of-Step-1 match
    // above cannot stand in for this one.
    const at = step1.indexOf(STOP_LIST_OPENER)
    assert.ok(at >= 0, `Step 1 must gather its stops under "${STOP_LIST_OPENER}"`)
    const rest = step1.slice(at)
    const end = rest.search(/\n\s*\n/)
    const stops = end < 0 ? rest : rest.slice(0, end)
    assert.match(stops, /`"status": "partial"`/, '`partial` must be one of the stops, not only an explanation')
    assert.match(
      stops,
      /the review session is still being recorded/,
      'and the stop must say what the user is being told'
    )
  })
}

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

/**
 * Minimal `CommandRunContext` stand-in, with the endpoint threaded through the
 * gateway plugin's configured `listen` (how the CLI resolves it when no live
 * daemon status file is present).
 *
 * @param {{ endpoint: string, env?: Record<string, string> }} args
 */
function fakeCtx(args) {
  let out = ''
  let err = ''
  const hypHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-receipt-home-'))
  const ctx = {
    stdout: { write: (/** @type {string} */ s) => { out += s; return true } },
    stderr: { write: (/** @type {string} */ s) => { err += s; return true } },
    env: { HYP_HOME: hypHome, ...(args.env ?? {}) },
    cwd: '/repo/here',
    config: {
      version: 2,
      plugins: [{ name: '@hypaware/ai-gateway', config: { listen: args.endpoint.replace(/^https?:\/\//, '') } }],
    },
  }
  return { ctx: /** @type {any} */ (ctx), stdout: () => out, stderr: () => err }
}

/**
 * One live Codex exchange carrying the turn metadata a subagent turn has: its
 * own thread id, and the session container holding it. This is the input the
 * drop sees, so the test asserts against the real projector rather than a
 * restatement of what it matches.
 *
 * @param {{ sessionId: string, threadId: string }} ids
 */
function codexExchange(ids) {
  return /** @type {any} */ ({
    exchange_id: 'ex-460',
    ts_start: '2026-07-31T10:00:00.000Z',
    ts_end: '2026-07-31T10:00:00.250Z',
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
 * The projector context the gateway dispatcher supplies, with the
 * ignored-session predicate backed by the live control-route set.
 *
 * @param {Set<string>} ignored
 */
function dropContext(ignored) {
  return {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    isSessionIgnored: (/** @type {string} */ id) => ignored.has(id),
  }
}
