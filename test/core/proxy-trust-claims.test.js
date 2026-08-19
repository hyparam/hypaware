// @ts-check

// LLP 0262 moved Claude Code off proxy capture, and the last production caller
// that installed the interception CA into a trust store went with it. The
// product prose did not all move. The README's "Proxy mode" section, the
// privacy document, and `hyp detach --help` all still described attach adding
// the CA to the macOS login keychain, still described macOS raising a password
// dialog for it, and still sold a detach as sparing the reader that dialog on
// the next attach.
//
// The last one is the expensive kind of wrong: it reads the keychain trust an
// older release left on the account as a convenience being held for you, when
// it is a leftover nothing re-creates and only `hyp detach <client> --purge` or
// `hyp daemon uninstall` clears.
//
// This is a lint over documents, not a behavior check. It pairs a fact about
// the tree (the two trust writers have no caller outside their own modules)
// with the claims those documents may not make while that fact holds, so the
// prose cannot drift back without the fact drifting back too.
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

/**
 * Every document that carries the claim, with its own banned phrases and its
 * own required replacements. Per document, not one shared list: these say the
 * same thing in three registers (product prose, privacy prose, terminal help),
 * and a phrase that has to be present in the README reads as a non-sequitur in
 * `hyp detach --help`. Adding a fourth document means writing its own pair of
 * lists, which is the point: the gate widens by stating what that document
 * must say, never by demanding another's sentences.
 *
 * `banned` catches a revert. `required` catches a rewrite: a paragraph
 * re-documented from scratch could re-assert every banned claim in fresh words
 * and trip nothing, so each document must also still carry the sentences that
 * make the leftover explicit. Dropping one fails here even though it matches no
 * banned phrase.
 *
 * Reword a `required` phrase freely, but say the same thing and update this
 * list in the same commit; the list is the claim, not the wording. Phrases
 * match whitespace-insensitively, so reflowing a paragraph does not hide one.
 */
const SCANNED = [
  {
    file: 'README.md',
    banned: [
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
      {
        phrase: '`hyp detach <client>` unsets the variable and removes the agent',
        truth: 'a plain detach releases the launchd environment only for a marker that still records a proxy attach, so on a migrated machine it is not the command that clears the leftover',
      },
    ],
    required: [
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
      {
        phrase: 'only clears them while that client\'s attach marker still records a proxy attach',
        why: 'releaseProxyModeLaunchdEnv returns early on a non-proxy marker, so pointing a migrated machine at a plain detach would name a command that does nothing for it',
      },
    ],
  },
  {
    file: 'docs/PRIVACY.md',
    banned: [
      {
        phrase: 'attach installs the CA into your **login keychain**',
        truth: 'no attach installs the CA into a trust store; an earlier release did, and the privacy document is the last place that may imply otherwise',
      },
      {
        phrase: 'which is why macOS itself raises the password dialog',
        truth: 'nothing HypAware runs raises that dialog any more',
      },
      {
        phrase: 'so attach also runs `launchctl setenv NODE_USE_SYSTEM_CA 1`',
        truth: 'no attach runs it today; on a machine that ran an earlier release the variable and its login agent are leftovers to remove',
      },
      {
        phrase: 'so re-attaching later does not ask for your password again',
        truth: 'no attach re-creates the grant, so a detach is not saving the reader a dialog',
      },
    ],
    required: [
      {
        phrase: 'nothing HypAware runs installs the CA into an OS trust store',
        why: 'the privacy document is where a reader checks what touched their machine, so it has to state that no trust store is written',
      },
      {
        phrase: 'that trust setting is still on your account until you remove it',
        why: 'a reader who ran an earlier release learns here that the grant is theirs to clear',
      },
      {
        phrase: 'No attach writes either one today',
        why: 'the launchd variable and its login agent are leftovers on the same terms',
      },
      {
        phrase: 'no attach re-creates the grant',
        why: 'without it the lifetime paragraph reads as a detach holding a convenience open, which is the claim this gate exists to keep out',
      },
    ],
  },
  {
    file: 'src/core/cli/core_commands.js',
    banned: [
      {
        phrase: 'needs no new password dialog',
        truth: 'the detach help text is read at the moment the user is deciding, and no attach re-creates the grant it promises to spare them',
      },
    ],
    required: [
      {
        phrase: 'no attach re-creates that grant',
        why: 'the help text has to say the kept trust is a leftover, or a terminal contradicts the README a line at a time',
      },
    ],
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

/** @returns {string[]} one `<file> names <symbol>` entry per production module outside the writer's home that names it */
function trustInstallerNamers() {
  const listed = execFileSync('git', ['ls-files', '-z', '*.js'], { cwd: REPO_ROOT, encoding: 'utf8' })
  const candidates = listed
    .split('\0')
    .filter(file => file !== '' && !file.startsWith('test/'))
    // A tracked path can be absent from the working tree mid-rebase. That is
    // not a caller, and this gate must not die on it.
    .filter(file => fs.existsSync(path.join(REPO_ROOT, file)))
  /** @type {string[]} */
  const namers = []
  for (const file of candidates) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
    for (const { symbol, home } of TRUST_INSTALLERS) {
      // Word-bounded, so a future `installCaTrustForHost` is not read as this
      // one. Still only a mention, not proof of a call: a `{@link}` in a
      // comment trips it too, which is why the failure below says "names"
      // rather than accusing the file of installing anything.
      if (file !== home && new RegExp(`\\b${symbol}\\b`).test(text)) namers.push(`${file} names ${symbol}`)
    }
  }
  return namers
}

/** @returns {string[]} one entry per stale claim still standing in the scanned documents */
function staleClaims() {
  /** @type {string[]} */
  const found = []
  for (const { file, banned } of SCANNED) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
    for (const claim of banned) {
      const match = phrasePattern(claim.phrase).exec(text)
      if (!match) continue
      const line = text.slice(0, match.index).split('\n').length
      found.push(`${file}:${line}  "${claim.phrase}"\n    true instead: ${claim.truth}`)
    }
  }
  return found
}

/** @returns {string[]} one entry per required truth a scanned document no longer states */
function missingTruths() {
  /** @type {string[]} */
  const missing = []
  for (const { file, required } of SCANNED) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
    for (const truth of required) {
      if (phrasePattern(truth.phrase).test(text)) continue
      missing.push(`${file}  "${truth.phrase}"\n    why it has to stay: ${truth.why}`)
    }
  }
  return missing
}

test('no document promises a trust step that no attach performs', () => {
  assert.deepEqual(
    trustInstallerNamers(),
    [],
    'a production module outside its home names a proxy trust writer: if it now calls one, the claims this gate bans are true again and the gate needs rewriting rather than the docs; if it only mentions one in prose, reword the mention'
  )

  const found = staleClaims()
  assert.deepEqual(found, [], `stale trust-store claims:\n${found.join('\n')}`)

  const missing = missingTruths()
  assert.deepEqual(missing, [], `a document dropped what it has to say instead:\n${missing.join('\n')}`)
})
