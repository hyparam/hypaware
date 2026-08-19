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
// the tree (nothing outside `darwin_trust.js` can install trust any more) with
// the claims the README may not make while that fact holds, so the prose cannot
// drift back without the fact drifting back too.
//
// @ref LLP 0262#migration [tests]: attach offers the CA purge and never re-creates the keychain grant, so no document may promise one is waiting

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Where the trust installer may still be named in production code: its own
// module, which keeps exporting it for the day another client needs it.
const TRUST_INSTALLER = 'installCaTrust'
const TRUST_INSTALLER_HOME = 'src/core/tls/darwin_trust.js'

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
]

/**
 * @param {string} phrase
 * @returns {RegExp}
 */
function phrasePattern(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped.replace(/\s+/g, '\\s+'))
}

/** @returns {string[]} repo-relative production files that name the trust installer */
function trustInstallerCallers() {
  const listed = execFileSync('git', ['ls-files', '-z', '*.js'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return listed
    .split('\0')
    .filter(file => file !== '' && !file.startsWith('test/') && file !== TRUST_INSTALLER_HOME)
    .filter(file => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').includes(TRUST_INSTALLER))
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

test('the README promises no CA trust step that no attach performs', () => {
  assert.deepEqual(
    trustInstallerCallers(),
    [],
    'production code installs CA trust again: either that is the bug, or the claims this gate bans are true once more and the gate needs rewriting rather than the docs'
  )

  const found = staleClaims()
  assert.deepEqual(found, [], `stale trust-store claims:\n${found.join('\n')}`)
})
