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
 * Codex reaches HypAware through `base_url`, so the recorder that captures it
 * is `gateway` (`resolveRecorderTargetsForCli`), where for a Claude session it
 * is the telemetry listener.
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
    'and must stop when the recorder that captures this session was never addressed'
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
  assert.match(
    prose,
    /- `"recorders"` contains an entry for `gateway`, the recorder that captures this session\. A list without one means the gateway was never addressed\b/,
    'the recorders bullet must name the recorder the coverage check looks for, and say what its absence means'
  )
})
