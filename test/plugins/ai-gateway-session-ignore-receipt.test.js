// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createControlHandler } from '../../hypaware-core/plugins-workspace/ai-gateway/src/control.js'
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
 * `control.js` adds an opaque token to a `Set` and answers `ignored: true` for
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

/** @param {string} rel */
function skillText(rel) {
  return fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hypaware-core/plugins-workspace', rel),
    'utf8'
  )
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
