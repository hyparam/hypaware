// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Content invariants for Step 1 of the Codex `hypaware-privacy` skill.
 *
 * Step 1 is the one place a privacy review can fail silently in the direction
 * that matters: it opts the review session out of capture, prints
 * `opt-out confirmed`, and then the review discusses the machine's most
 * sensitive content believing it is not being recorded. The control route holds
 * the id as an opaque token and answers `ignored: true` for whatever it was
 * handed (`src/core/control/session_ignore.js`), so nothing downstream can catch a
 * wrong id. The correctness of the whole step rests on which id the embedded
 * script sends, which is a property of a markdown code block that no other
 * test covers.
 *
 * Two ways to get it wrong, both of which shipped at some point:
 *
 *   1. **Wrong session** (issue #452): resolving the newest rollout by mtime
 *      answers confidently off a FINISHED session, so marking or purging
 *      touches another session's rows while this one keeps being recorded.
 *   2. **Wrong grain** (issue #453): sending a *thread* id when the drop keys
 *      the session *container*. `codex/src/exchange-projector.js` matches
 *      `metadata.session_id` (falling back to the conversation id), and a
 *      subagent thread inherits the root's container while minting its own
 *      thread id, so a thread id names a token the drop never matches.
 *
 * These are markdown assertions, so they cannot prove the script runs; they pin
 * the two decisions a later edit could silently reverse.
 *
 * @ref LLP 0066#enforcement [tests]: the id the skill sends must be the same
 * grain the projector drops on, or the opt-out is a confirmed no-op.
 * @ref LLP 0030#decision [constrained-by]: `session_id` is the partition key
 * (Codex's `metadata.session_id`, else the thread), which is why the container
 * and not the thread is what an opt-out has to name.
 */

const SKILL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hypaware-core/plugins-workspace/codex/skills/hypaware-privacy/SKILL.md'
)

const text = fs.readFileSync(SKILL, 'utf8')

/**
 * Step 1's session-resolution script, anchored on its shebang rather than on
 * "the first fenced bash block": the verb Step 1 leads with now has a bash
 * block of its own above this one, and every assertion here is about the
 * script.
 */
const step1 = (() => {
  const m = text.match(/```bash\n(#!\/usr\/bin\/env bash\n[\s\S]*?)```/)
  assert.ok(m, 'the skill must still carry the fenced fallback script')
  return m[1]
})()

/** Step 1's prose, which is where the receipt readings and their stops live. */
const prose = (() => {
  const start = text.indexOf('## Step 1')
  const end = text.indexOf('## Step 2')
  assert.ok(start >= 0 && end > start, 'Step 1 must still be a section of its own')
  return text.slice(start, end)
})()

/** The words Step 1 opens its stop list with. */
const STOP_LIST_OPENER = '**Stop on any of these**'

/** The words Step 1 opens the paragraph that frames every receipt reading with. */
const RECEIPT_PREMISE_OPENER = '**What the receipt does and does not say.**'

test('Step 1 sends the session container, never a thread id', () => {
  // The id that goes on the wire is read from `payload.session_id`.
  assert.match(
    step1,
    /payload\.get\('session_id'\)/,
    'the resolved id must come from payload.session_id (the container the gateway drops on)'
  )

  // `payload['id']` is the thread. It may be read (to name a session in a
  // refusal message) but must never become the id that is POSTed.
  assert.doesNotMatch(
    step1,
    /matches\.append\(\(payload\['id'\]/,
    'the thread id must not be the value collected as the session id'
  )

  // CODEX_THREAD_ID is a thread id, so it is not an answer this step can use.
  // `hyp session ignore` already puts it to work as a *selector* (#453, landed
  // as #458): it looks the rollout up by `payload.id`, then reads the container
  // out of `payload.session_id` and reports `codex_env_rollout`. Selecting on
  // the variable is the verb's job; sending it is what this step must not do.
  assert.doesNotMatch(
    step1,
    /SESSION_ID="\$\{CODEX_THREAD_ID/,
    'CODEX_THREAD_ID is a thread id and must not be assigned as the session id'
  )
  assert.doesNotMatch(
    step1,
    /--data[\s\S]{0,80}CODEX_THREAD_ID/,
    'CODEX_THREAD_ID must never reach the control route'
  )

  // A rollout too old to record a container must stop, not substitute.
  assert.match(
    step1,
    /if not session_id:[\s\S]{0,400}sys\.exit\(/,
    'a rollout with no payload.session_id must refuse rather than fall back to the thread id'
  )
})

test('Step 1 resolves the rollout by cwd and refuses rather than guessing', () => {
  // Issue #452: newest-by-mtime is gone from the resolution path.
  assert.doesNotMatch(step1, /\bls -t\b/, 'no newest-by-mtime rollout selection')
  assert.doesNotMatch(step1, /xargs -0 ls/, 'no newest-by-mtime rollout selection')

  assert.match(step1, /payload\.get\('cwd'\) != cwd/, 'the rollout is matched on payload.cwd')

  // Zero, many, and stale each refuse, and each refusal is a nonzero exit
  // taken BEFORE the curl further down the script.
  const refusals = step1.match(/sys\.exit\(/g) ?? []
  assert.ok(refusals.length >= 4, `expected zero/ambiguous/stale/no-container refusals, saw ${refusals.length}`)
  assert.match(step1, /if not matches:/)
  assert.match(step1, /if len\(matches\) > 1:/)
  assert.match(step1, /30 \* 60/, 'staleness bound is still enforced')

  const curlAt = step1.indexOf('curl ')
  const resolveEnd = step1.indexOf('ID_SOURCE=')
  assert.ok(resolveEnd > 0 && curlAt > resolveEnd, 'resolution (and its refusals) must precede the curl')
})

test('Step 1 reports the id as inferred and names persistence and the fork boundary', () => {
  // The staleness window is a bound, not a proof, so an id off disk is always
  // labelled. (#452)
  assert.match(step1, /ID_SOURCE="INFERRED from \$ROLLOUT on disk"/)

  assert.match(prose, /survives recorder and daemon restarts/)
  assert.match(prose, /codex fork/)
  assert.match(prose, /until explicitly removed/)
})

/**
 * The host-specific half of the receipt reading (issue #1633).
 *
 * `hyp session ignore --json` reports which session it resolved and which
 * recorders it reached, and both answers can be a confirmed success about
 * something other than this session. Which values are the RIGHT ones is the
 * part that cannot be shared with the claude copy: `resolveSessionIdForCli`
 * reports `codex_env_rollout` (thread stated in `CODEX_THREAD_ID`, container
 * read from its rollout) or `codex_rollout` (container inferred from a `cwd`
 * match) for a Codex session, and a `claude_env` here means the verb opted out
 * a Claude session sharing this shell while this one kept being recorded.
 * Codex reaches HypAware through `base_url` only in `gateway` capture mode;
 * on the default `transcript` mode nothing reaches the gateway and a rollout
 * sweep imports the session instead. `resolveRecorderTargetsForCli` still
 * names `gateway` as the entry to read in either mode, because its control
 * route writes the shared session-ignore store before it answers and the
 * sweep reloads that same store at the start of every run. For a Claude
 * session it is the telemetry listener.
 *
 * The checks are pinned inside the stop paragraph rather than anywhere in
 * Step 1, because a reading the agent is not told to stop on is commentary.
 * Issue #1627 records the claude guard's version of that gap: it asserts the
 * recorder id appears in Step 1 and that a stop paragraph exists, never that
 * the two meet, so a clause demoted to a receipt bullet still passes.
 *
 * @ref LLP 0066#readable [tests]: R10 - an answer that could not be
 * established, or was established about another session, must not read as a
 * completed check.
 */
test('Step 1 stops on a receipt that resolved another session or missed the gateway', () => {
  const at = prose.indexOf(STOP_LIST_OPENER)
  assert.ok(at >= 0, `Step 1 must gather its stops under "${STOP_LIST_OPENER}"`)
  const rest = prose.slice(at)
  const paraEnd = rest.search(/\n\s*\n/)
  const stops = paraEnd < 0 ? rest : rest.slice(0, paraEnd)

  assert.match(
    stops,
    /a `"session_id_source"` other than `codex_env_rollout` or `codex_rollout`/,
    'the stop list must name the two sources a Codex session legitimately resolves by'
  )
  assert.match(
    stops,
    /no `gateway` entry in `"recorders"`/,
    'and must stop when the gateway was never addressed'
  )

  // The stop list is a list of names; the bullets above it are what tell the
  // agent what each name means. Both halves have to survive, or the stop is
  // unreadable in one direction and unactionable in the other. Each pin
  // therefore spans the clause carrying the meaning, not just the name it
  // hangs on: an intact name over a reversed explanation ("any other source
  // is fine", "a list without one is harmless") reads as an all-clear, and a
  // stop list on its own does not catch it.
  assert.match(
    prose,
    /- `"session_id_source"` is `codex_env_rollout`[\s\S]{0,400}means the verb resolved \*\*a different session\*\*[\s\S]{0,400}`hyp session unignore /,
    'the session_id_source bullet must say a wrong source resolved a different session, and how to undo it'
  )
  // Issue #2162. `gateway` is not "the recorder that captures this session":
  // `readCodexCaptureMode` returns `transcript` for anything but an explicit
  // `gateway`, and in that mode the rollout sweep imports this session out of
  // `~/.codex/sessions` while nothing reaches the gateway. So the pin spans the
  // actionable clause, which holds in either capture mode, and rejects the
  // apposition separately: an absence check alone passes on an emptied bullet,
  // and the clause pin alone passes on a bullet that reasserts it.
  assert.match(
    prose,
    /- `"recorders"` contains an entry for `gateway`[\s\S]{0,240}A list without one means the gateway was never addressed\b/,
    'the recorders bullet must name the recorder the coverage check looks for, and say what its absence means'
  )
  assert.doesNotMatch(
    prose,
    /recorder that captures this session/,
    'and must not describe gateway as the recorder that captures this session, in any phrasing: on the default `transcript` capture_mode nothing reaches it'
  )
})

/**
 * Issue #2148, the codex half of #1626. The stop above fires on ABSENCE, and
 * absence has two causes the receipt cannot tell apart. The gateway is missing
 * from `recorders` exactly when `resolveGatewayEndpointForCli` found no bound
 * port in the live daemon snapshot and no `listen` pinned in the config, which
 * is either a gateway that is listening somewhere the verb could not name or a
 * gateway that is not listening at all - and the second is the ordinary reading
 * (LLP 0256 #cli-posts-to-both: a recorder that is not running is not a
 * failure, it is recording nothing). It is reachable in shipped code:
 * `runMutation` exits 0 with `status: "ok"` and a `gateway not addressed:` line
 * on stderr whenever another recorder resolves and the gateway does not, so an
 * unconditional stop tells a user whose gateway is down - and whose Codex
 * traffic is therefore reaching no recorder over `base_url` - that the review
 * session is still being recorded.
 *
 * The answer is to condition the stop on a second observation, not to delete
 * it, so both directions are pinned here: a listening gateway still stops the
 * review, a gateway that bound nothing says plainly that nothing is capturing
 * this session, and a cross-check that cannot be read fails closed.
 *
 * The second observation is the gateway's own bound address, which is the
 * field the verb's recorder resolution reads (`gatewaySourceDetails` in
 * `src/core/daemon/status.js`), not the `control_routes` advertisement it
 * resolves the other recorders by. `hyp status --json` drops source `details`
 * entirely, so it cannot answer this; the shapes named below are pinned
 * against the real command in
 * test/plugins/ai-gateway-session-both-recorders.test.js.
 *
 * @ref LLP 0256#cli-posts-to-both [tests]: only a running recorder that was
 * skipped or refused is a failure.
 */
test('Step 1 stops on a missing gateway entry only while the gateway is listening', () => {
  const at = prose.indexOf(STOP_LIST_OPENER)
  assert.ok(at >= 0, `Step 1 must gather its stops under "${STOP_LIST_OPENER}"`)
  const rest = prose.slice(at)
  const paraEnd = rest.search(/\n\s*\n/)
  const stops = paraEnd < 0 ? rest : rest.slice(0, paraEnd)

  // The condition rides the list item itself, before the comma that ends it:
  // an agent acting on the list must not be able to reach the stop without
  // reading it.
  const clause = 'no `gateway` entry in `"recorders"`'
  assert.ok(stops.includes(clause), `"${clause}" must still be one of the stop conditions`)
  assert.match(
    stops,
    new RegExp(clause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^,]{0,200}\\b(?:listening|live|running)\\b'),
    'and it must carry its own liveness condition: absence alone is also what a gateway that is not listening looks like'
  )

  // The second observation, and both of its answers.
  const opener = '**Cross-check a missing `gateway` entry'
  const from = prose.indexOf(opener)
  assert.ok(from >= 0, `Step 1 must settle the two readings, opening "${opener}"`)
  const to = prose.indexOf('**Which id, exactly.**')
  assert.ok(to > from, 'and must do it before it explains which id the opt-out names')
  const crossCheck = prose.slice(from, to)

  assert.match(crossCheck, /hyp daemon status --json/, 'the cross-check must name the command that answers it')
  assert.ok(
    crossCheck.includes('@hypaware/ai-gateway') && crossCheck.includes('"port"'),
    'and the keys it reads: the gateway source entry and the address it bound'
  )
  assert.match(
    crossCheck,
    /"running": true[\s\S]{0,400}still being recorded/,
    'a port the live daemon bound is a gateway that was skipped, so the stop must still fire on it'
  )
  assert.match(
    crossCheck,
    /gateway is not listening, so nothing is capturing this session/,
    'and where nothing is listening the user must be told that, not told they are still being recorded'
  )
  assert.match(
    crossCheck,
    /nothing is capturing this session over `base_url`/,
    'and that claim must be scoped to the gateway lane: on a default `transcript` capture_mode the rollout sweep still imports this session'
  )
  assert.match(
    crossCheck,
    /capture_mode` defaults to `transcript`/,
    'so the skill must say why an idle gateway is not the same as an uncaptured session'
  )
  assert.match(
    crossCheck,
    /leave the transcript lane as something this step has not settled/,
    'the receipt cannot tell a durable recorder from an in-memory one, so the step must not report the transcript lane covered'
  )
  assert.match(
    crossCheck,
    /`"name"` is `"ai-gateway"`/,
    'and the lookup must carry core own name fallback, or a snapshot that recorded no plugin reads as not listening while a port is bound'
  )
  assert.match(
    crossCheck,
    /"running": false[\s\S]{0,160}"state": "unknown"[\s\S]{0,200}not an unreadable shape/,
    'a daemon that never wrote a snapshot must be resolved explicitly: its missing `sources` key otherwise matches both the proceed clause and the fail-closed one'
  )
  assert.match(
    crossCheck,
    /"running": false/,
    'a snapshot outlives its daemon, so a port in one must be read as live only beside a running process'
  )
  assert.match(
    crossCheck,
    /(?:cannot read|do not recognize|nonzero)[\s\S]{0,200}\bstop\b/,
    'an observation that could not be made is not an answer, so it must fail closed'
  )
})

/**
 * The premise the receipt reading rests on (issue #2159).
 *
 * The paragraph an agent reads first frames every reading under it, so a false
 * statement of fact there is not a wording nit. Codex's `capture_mode` defaults
 * to `transcript` (`readCodexCaptureMode`, src/core/config/attach_policy.js),
 * and in that mode no managed `base_url` block is written and the backfill
 * provider registers the sweep that imports this session's rollout out of
 * `~/.codex/sessions` (codex/src/backfill.js, gated on
 * `capture_mode !== 'gateway'`). So the gateway is not the capturing recorder
 * on a default install.
 *
 * The conclusion is pinned with it, because a premise pin alone passes over a
 * paragraph corrected into saying nothing: a confirmed `gateway` entry still
 * covers both lanes, since the control route saves the id to the shared
 * session-ignore store before it answers (`ignoredSessions.add`,
 * src/core/control/session_ignore.js) and the sweep reloads that store at the
 * start of every run (`refreshSessionIgnores`).
 *
 * @ref LLP 0429#default [tests]: absent or `transcript` is file capture, so
 * which recorder captures a Codex session is not one fixed answer.
 * @ref LLP 0403#backfill [tests]: the durable store is what carries a confirmed
 * opt-out across to the transcript lane.
 */
test('Step 1 frames the receipt for both capture modes, and still says what the gateway entry proves', () => {
  const at = prose.indexOf(RECEIPT_PREMISE_OPENER)
  assert.ok(at >= 0, `Step 1 must still frame the receipt under "${RECEIPT_PREMISE_OPENER}"`)
  const rest = prose.slice(at)
  const paraEnd = rest.search(/\n\s*\n/)
  const premise = paraEnd < 0 ? rest : rest.slice(0, paraEnd)

  assert.doesNotMatch(
    premise,
    /the recorder capturing this session is the \*\*gateway\*\*/,
    'the premise must not assert the gateway is the capturing recorder unconditionally'
  )

  assert.match(
    premise,
    /`capture_mode`[\s\S]{0,400}default `transcript`[\s\S]{0,300}`~\/\.codex\/sessions`[\s\S]{0,200}sweep/,
    'the premise must name capture_mode, say transcript is the default, and say the sweep imports the rollout there'
  )

  // Reversing this into "so the gateway entry does not matter" is the
  // overcorrection, and it would leave the bullets and stop list below
  // hanging on a recorder the paragraph no longer gives a reason to read.
  assert.match(
    premise,
    /\*\*gateway\*\* entry is still the one to read[\s\S]{0,500}session-ignore store[\s\S]{0,300}sweep reloads/,
    'the premise must still say why a confirmed gateway entry is what the readings below rest on'
  )
})
