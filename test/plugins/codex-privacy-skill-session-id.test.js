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
 * handed (`ai-gateway/src/control.js`), so nothing downstream can catch a
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

/** The first fenced bash block, which is Step 1's session-resolution script. */
const step1 = (() => {
  const m = text.match(/```bash\n([\s\S]*?)```/)
  assert.ok(m, 'the skill must still carry a fenced bash block')
  return m[1]
})()

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
  // Issue #453 puts it to work as a selector; until then it must not be sent.
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

test('Step 1 reports the id as inferred and names both ways the opt-out lapses', () => {
  // The staleness window is a bound, not a proof, so an id off disk is always
  // labelled. (#452)
  assert.match(step1, /ID_SOURCE="INFERRED from \$ROLLOUT on disk"/)

  // Issue #455: the ephemerality caveat names the fork as well as the restart,
  // matching `EPHEMERAL_NOTE` in ai-gateway/src/session_command.js.
  const prose = text.slice(text.indexOf('## Step 1'), text.indexOf('## Step 2'))
  assert.match(prose, /gateway restart/)
  assert.match(prose, /codex fork/)
  assert.doesNotMatch(
    prose,
    /a gateway restart drops it\.\s*(?:\n|$)/,
    'the restart must not be presented as the only way the opt-out lapses'
  )
})
