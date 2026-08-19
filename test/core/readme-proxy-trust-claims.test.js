// @ts-check

// LLP 0262 moved Claude Code off proxy capture, and the last production caller
// that installed the interception CA into a trust store went with it. The
// product prose did not all move. The README's "Proxy mode" section still
// described attach adding the CA to the macOS login keychain, still described
// macOS raising a password dialog for it, and still sold a detach as sparing
// the reader that dialog on the next attach.
//
// The last one is the expensive kind of wrong: it reads the keychain trust an
// older release left on the account as a convenience being held for you, when
// it is a leftover nothing re-creates and only `hyp detach <client> --purge` or
// `hyp daemon uninstall` clears.
//
// This is a lint over one document, not a behavior check. It pairs a fact about
// the tree (the two trust writers have no caller outside their own modules)
// with the claims the README may not make while that fact holds, so the prose
// cannot drift back without the fact drifting back too.
//
// @ref LLP 0262#migration [tests]: attach offers the CA purge and never re-creates the keychain grant, so no document may promise one is waiting

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// The two writers a proxy attach used to run, each paired with the module that
// may still name it: its own, which keeps exporting it for the day another
// client needs it. The keychain root and the launchd variable that made the
// root count are one grant in two halves, so no half may be described in the
// present tense while neither half has a caller.
const TRUST_INSTALLERS = [
  { symbol: 'installCaTrust', home: 'src/core/tls/darwin_trust.js' },
  { symbol: 'installLaunchdEnv', home: 'src/core/daemon/launchd_env.js' },
]

// Scoped to the README because it is the product document whose proxy-mode
// section LLP 0262 left behind. `docs/PRIVACY.md` and the `hyp detach` help
// text carry the same sentence and are corrected on their own change; add them
// here once they are clean, so the gate widens as the sweep does.
const SCANNED = ['README.md']

/**
 * Claims the README may not make while nothing installs CA trust, each paired
 * with what is true instead so a hit reads as an instruction, not a riddle.
 * Phrases match whitespace-insensitively, so reflowing a paragraph does not
 * hide one.
 */
const STALE_CLAIMS = [
  {
    phrase: 'added to your **login keychain**',
    truth: 'no attach installs the CA into a trust store; an earlier release did, and that trust is a leftover the reader has to purge',
  },
  {
    phrase: 'raises its own password dialog',
    truth: 'nothing HypAware runs raises that dialog any more, so the present tense promises a step that never comes',
  },
  {
    phrase: 'so re-attaching does not ask again',
    truth: 'no attach re-creates the grant, so a detach is not saving the reader a dialog',
  },
  {
    phrase: 'a proxy attach also leaves a login-session variable behind',
    truth: 'no attach runs launchctl setenv NODE_USE_SYSTEM_CA 1 or installs the login agent; on a machine that ran an earlier release both are leftovers to remove',
  },
]

/**
 * The other half of the gate. A denylist catches a revert, not a rewrite: a
 * paragraph re-documented from scratch could re-assert every banned claim in
 * fresh words and trip nothing. So the README must also still carry the
 * sentences that make the leftover explicit. Dropping one fails here even
 * though it matches no banned phrase.
 *
 * Reword these freely, but say the same thing and update this list in the same
 * commit; the list is the claim, not the wording.
 */
const REQUIRED_TRUTHS = [
  {
    phrase: 'nothing installs it into any OS trust store',
    why: 'the CA bullet has to say outright that no trust store is written, or a reader takes the keychain install to be current',
  },
  {
    phrase: 'that trust setting is still on your account until you remove it',
    why: 'the keychain grant an earlier release was given is a leftover to purge, and this is where the reader learns it is theirs to clear',
  },
  {
    phrase: 'No attach writes either one today',
    why: 'the launchd variable and its login agent are leftovers on the same terms, and the bullet says so only while this sentence survives',
  },
]

/**
 * @param {string} phrase
 * @returns {RegExp}
 */
function phrasePattern(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped.replace(/\s+/g, '\\s+'))
}

/** @returns {string[]} one `<file> names <symbol>` entry per production caller of a trust writer */
function trustInstallerCallers() {
  const listed = execFileSync('git', ['ls-files', '-z', '*.js'], { cwd: REPO_ROOT, encoding: 'utf8' })
  const candidates = listed
    .split('\0')
    .filter(file => file !== '' && !file.startsWith('test/'))
    // A tracked path can be absent from the working tree mid-rebase. That is
    // not a caller, and this gate must not die on it.
    .filter(file => fs.existsSync(path.join(REPO_ROOT, file)))
  /** @type {string[]} */
  const callers = []
  for (const file of candidates) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
    for (const { symbol, home } of TRUST_INSTALLERS) {
      if (file !== home && text.includes(symbol)) callers.push(`${file} names ${symbol}`)
    }
  }
  return callers
}

/** @returns {string[]} one entry per stale claim still standing in the scanned docs */
function staleClaims() {
  /** @type {string[]} */
  const found = []
  for (const rel of SCANNED) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    for (const claim of STALE_CLAIMS) {
      const match = phrasePattern(claim.phrase).exec(text)
      if (!match) continue
      const line = text.slice(0, match.index).split('\n').length
      found.push(`${rel}:${line}  "${claim.phrase}"\n    true instead: ${claim.truth}`)
    }
  }
  return found
}

/** @returns {string[]} one entry per required truth the scanned docs no longer state */
function missingTruths() {
  /** @type {string[]} */
  const missing = []
  for (const rel of SCANNED) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    for (const truth of REQUIRED_TRUTHS) {
      if (phrasePattern(truth.phrase).test(text)) continue
      missing.push(`${rel}  "${truth.phrase}"\n    why it has to stay: ${truth.why}`)
    }
  }
  return missing
}

test('the README promises no trust step that no attach performs', () => {
  assert.deepEqual(
    trustInstallerCallers(),
    [],
    'production code installs proxy trust again: either that is the bug, or the claims this gate bans are true once more and the gate needs rewriting rather than the docs'
  )

  const found = staleClaims()
  assert.deepEqual(found, [], `stale trust-store claims:\n${found.join('\n')}`)

  const missing = missingTruths()
  assert.deepEqual(missing, [], `the README dropped what it has to say instead:\n${missing.join('\n')}`)
})
