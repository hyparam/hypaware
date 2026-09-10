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
  assert.ok(
    step1.includes(CLAUDE_TELEMETRY_SOURCE),
    `Step 1 must name the listener's own recorder id (${CLAUDE_TELEMETRY_SOURCE}) for its coverage check to be actionable`
  )
  // And the check has to be a stop condition, not an observation: the whole
  // bug this skill's Step 1 was rewritten for is an `ok` over a recorder that
  // was never addressed (issue #1615).
  assert.match(
    step1,
    /\*\*Stop on any of these\*\*/,
    'the receipt readings must be framed as stop conditions, not as commentary'
  )
  assert.match(
    step1,
    /a `"session_id_source"` other than `claude_env`/,
    'an id resolved off disk for another session must be one of them'
  )
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
