// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/matcher.js'
import { localOnlyListPath } from '../../src/core/usage-policy/local_only.js'
import { folderAskPath, writeFolderAskMode } from '../../src/core/usage-policy/folder_ask.js'
import { LocalOnlyListUnreadableError } from '../../src/core/usage-policy/local_only.js'
import { readObservabilityEnv } from '../../src/core/observability/env.js'
import {
  CLASSIFICATION_CHOICES,
  buildClassificationPrompt,
  decideClassification,
  evaluateCwdClassification,
  verbArgvForClass,
} from '../../src/core/usage-policy/classification.js'

/**
 * @import { CommandRegistration, CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

// LLP 0106 session-start classification: the shared decision, the consent-copy,
// and the verb mapping the per-client hooks (T8) all funnel through. The prompt
// copy is load-bearing (many users' first contact with the class vocabulary),
// so it is pinned here like the other consent surfaces.

test('verbArgvForClass maps each class to its hyp privacy set token (LLP 0111 #teaching)', () => {
  assert.deepEqual(verbArgvForClass('full', '/work/repo'), ['privacy', 'set', '/work/repo', 'sync'])
  assert.deepEqual(verbArgvForClass('local-only', '/work/repo'), ['privacy', 'set', '/work/repo', 'local-only'])
  assert.deepEqual(verbArgvForClass('ignore', '/work/repo'), ['privacy', 'set', '/work/repo', 'ignore'])
  assert.throws(() => verbArgvForClass(/** @type {any} */ ('nope'), '/x'), /unknown class/)
})

test('the three choices are presented least-to-most restrictive with their tokens', () => {
  assert.deepEqual(CLASSIFICATION_CHOICES.map((c) => c.class), ['full', 'local-only', 'ignore'])
  assert.deepEqual(CLASSIFICATION_CHOICES.map((c) => c.token), ['sync', 'local-only', 'ignore'])
})

test('buildClassificationPrompt names the folder, all three classes, and each privacy set command', () => {
  const prompt = buildClassificationPrompt({ cwd: '/work/secret-repo', origins: [BUILTIN_ORIGIN] })
  assert.match(prompt, /\/work\/secret-repo/)
  assert.match(prompt, /enrolled/)
  // Every class label and its exact command are present so the assistant can
  // run the right verb without inventing a spelling.
  assert.match(prompt, /sync:/)
  assert.match(prompt, /local-only:/)
  assert.match(prompt, /ignore:/)
  assert.match(prompt, /hyp privacy set \/work\/secret-repo sync/)
  assert.match(prompt, /hyp privacy set \/work\/secret-repo local-only/)
  assert.match(prompt, /hyp privacy set \/work\/secret-repo ignore/)
  // Exit criterion (LLP 0110): the hook never teaches an ignore-spelled command
  // for a non-ignore class - the deprecated flag spellings are gone entirely.
  assert.equal(/hyp ignore --sync/.test(prompt), false)
  assert.equal(/hyp ignore --local-only/.test(prompt), false)
  assert.equal(/hyp ignore --private/.test(prompt), false)
  // @ref LLP 0113 [tests]: the menu mandate is part of the pinned consent copy
  assert.match(prompt, /selection menu/)
  assert.match(prompt, /AskUserQuestion/)
  assert.match(prompt, /unless no such tool exists/)
  // Repo style: no em dashes anywhere in the consent copy. Spelled as an escape
  // so the assertion survives the repo-wide U+2014 gate that now backs it
  // (`house-style-em-dash.test.js`) instead of being swept into a hyphen.
  assert.equal(prompt.includes('\u2014'), false)
})

test('the prompt names its own off switch (LLP 0200 #escape-hatch)', () => {
  // A user who does not want this question at all has to be able to answer
  // that in the session that asked, not by finding a setting later.
  const prompt = buildClassificationPrompt({ cwd: '/work/secret-repo', origins: [BUILTIN_ORIGIN] })
  assert.match(prompt, /hyp privacy folders sync/)
  assert.match(prompt, /hyp privacy folders ask/)
})

// #2190's two defects are semantic: the block named its destination two ways,
// and it hedged a forwarding claim that is unconditional wherever the block
// renders. Two review rounds tried to pin those semantically, with a clause
// splitter and a destination extractor, and the result was defeated more than
// twenty times between them: a destination named after "shared with" or
// "uploaded into" rather than "forwarded to", one inside parentheses the
// capture stops at, one in no verb's object at all, a hedge moved into the
// next sentence, a hedge on an indented continuation line, a hedge with no
// conditional opener ("network permitting"). Each repair closed some holes and
// opened others, and the clause boundaries were wrong in three successive
// attempts. It also failed on copy that was perfectly correct: one adverb
// ("forwarded to the cloud automatically") reported two destinations, and
// rendering the bullets flush left reported the destination as "cloud hyp
// privacy set /work/secret-repo local-only - ignore".
//
// A consent surface does not need a pattern that guesses at intent. It needs
// every reword to be read by a human. So pin the rendered block literally,
// which is how the sibling destination-naming copy is already pinned
// (test/core/cli/wizard/sync_scope.test.js asserts nine of these lines with
// plain equality). Every one of those bypasses changes the copy, so the pin
// catches all of them, and it cannot false-fail on copy that is fine.
//
// This test is meant to fail on any copy edit. Whoever updates a literal is
// the human the guard exists to summon, and these are the three things to check
// before doing so:
//
//   1. The block names the sync destination exactly one way. Two spellings of
//      one place ("HypAware Cloud" and "the cloud") still count as two.
//   2. The forwarding claim carries no connectivity hedge.
//      `decideClassification` returns prompt only on an enrolled machine, so
//      the forwarding is unconditionally true wherever this renders and a
//      hedge understates it.
//   3. The destination is the one this enrollment actually forwards to, so
//      there is a literal per lane (#2197) and an edit has to land in both.
const CLASSIFICATION_PROMPT_CWD = '/work/secret-repo'

// The hosted default server, and a self-hosted one. `serverDisplayName` maps
// the first to the product name and the second to its bare host
// (test/core/remote-server-display-name.test.js pins both mappings).
const BUILTIN_ORIGIN = 'https://api.hypaware.ai'
const SELF_HOSTED_ORIGIN = 'https://hyp.acme.dev/'

const EXPECTED_CLASSIFICATION_PROMPT = [
  'This machine is enrolled, so by default the AI coding sessions you run here',
  'are recorded and forwarded to HypAware Cloud.',
  'The folder /work/secret-repo has not been classified yet, so it would sync by default.',
  '',
  'Before continuing, ask the user how this folder should be handled, then run',
  'the matching command once to record the answer (you will not be asked again',
  'for this folder):',
  '',
  "  - sync: this folder's sessions sync to HypAware Cloud (the current default)",
  '      hyp privacy set /work/secret-repo sync',
  '  - local-only: keep sessions on this machine only, never send them to HypAware Cloud',
  '      hyp privacy set /work/secret-repo local-only',
  "  - ignore: do not record this folder's sessions at all",
  '      hyp privacy set /work/secret-repo ignore',
  '',
  "Present these three choices as a selection menu using your environment's",
  'native question tool (in Claude Code, the AskUserQuestion tool); do not ask',
  'in open-ended text unless no such tool exists. Then run the chosen command.',
  'If the user is unsure, the safe choice is local-only (recorded here, never',
  'forwarded). This affects only what HypAware records and forwards; it does',
  'not change your task.',
  '',
  'If the user does not want to be asked about folders at all, run',
  '`hyp privacy folders sync` instead: new folders then sync without asking,',
  'and `hyp privacy folders ask` brings the question back.',
].join('\n')

test('the consent prompt renders exactly the reviewed block (one destination term, no connectivity hedge)', () => {
  assert.equal(
    buildClassificationPrompt({ cwd: CLASSIFICATION_PROMPT_CWD, origins: [BUILTIN_ORIGIN] }),
    EXPECTED_CLASSIFICATION_PROMPT
  )
})

// #2197: the destination is resolved per enrollment, not a constant. Self-hosted
// enrollment is a supported lane (LLP 0134 #custom-url-deferred: "self-hosted
// teams use `hyp remote login <name>` by hand"), so a machine enrolled at
// hyp.acme.dev must not be told its sessions go to a hosted service it does not
// use. The whole block is pinned literally for each lane, for the same reason
// the built-in lane is: any reword of a consent surface gets read by a human.
const EXPECTED_SELF_HOSTED_CLASSIFICATION_PROMPT = [
  'This machine is enrolled, so by default the AI coding sessions you run here',
  'are recorded and forwarded to hyp.acme.dev.',
  'The folder /work/secret-repo has not been classified yet, so it would sync by default.',
  '',
  'Before continuing, ask the user how this folder should be handled, then run',
  'the matching command once to record the answer (you will not be asked again',
  'for this folder):',
  '',
  "  - sync: this folder's sessions sync to hyp.acme.dev (the current default)",
  '      hyp privacy set /work/secret-repo sync',
  '  - local-only: keep sessions on this machine only, never send them to hyp.acme.dev',
  '      hyp privacy set /work/secret-repo local-only',
  "  - ignore: do not record this folder's sessions at all",
  '      hyp privacy set /work/secret-repo ignore',
  '',
  "Present these three choices as a selection menu using your environment's",
  'native question tool (in Claude Code, the AskUserQuestion tool); do not ask',
  'in open-ended text unless no such tool exists. Then run the chosen command.',
  'If the user is unsure, the safe choice is local-only (recorded here, never',
  'forwarded). This affects only what HypAware records and forwards; it does',
  'not change your task.',
  '',
  'If the user does not want to be asked about folders at all, run',
  '`hyp privacy folders sync` instead: new folders then sync without asking,',
  'and `hyp privacy folders ask` brings the question back.',
].join('\n')

test('a self-hosted enrollment is told its own server, never the hosted product (#2197)', () => {
  const prompt = buildClassificationPrompt({ cwd: CLASSIFICATION_PROMPT_CWD, origins: [SELF_HOSTED_ORIGIN] })
  assert.equal(prompt, EXPECTED_SELF_HOSTED_CLASSIFICATION_PROMPT)
  // Not satisfied by an incidental substring: the host stands in all three
  // destination slots (the header disclosure and both destination-bearing
  // blurbs), and the pinned cwd does not contain it.
  assert.equal(CLASSIFICATION_PROMPT_CWD.includes('hyp.acme.dev'), false)
  assert.equal(countOccurrences(prompt, 'hyp.acme.dev'), 3)
  // The hosted product's vocabulary is absent in every casing: a blurb that
  // kept "the cloud" while the header resolved would leak a second
  // destination into one prompt, which is #2190's defect returning.
  assert.equal(/cloud/i.test(prompt), false, `a self-hosted block still names a cloud: ${JSON.stringify(prompt)}`)
})

test('the built-in enrollment is named by its one product name (#2197)', () => {
  const prompt = buildClassificationPrompt({ cwd: CLASSIFICATION_PROMPT_CWD, origins: [BUILTIN_ORIGIN] })
  assert.equal(countOccurrences(prompt, 'HypAware Cloud'), 3)
  // One spelling of the one place: the generic lower-case "the cloud" the
  // block used before #2197 is a second spelling, so it must be gone.
  assert.equal(/the cloud/i.test(prompt), false, `the block spells its destination two ways: ${JSON.stringify(prompt)}`)
})

test('more than one central origin names every destination, not the first (#2197)', () => {
  // `readCentralSinkOrigins` can return several, and every one of them
  // receives the sessions, so naming one would understate the disclosure.
  const prompt = buildClassificationPrompt({
    cwd: CLASSIFICATION_PROMPT_CWD,
    origins: [BUILTIN_ORIGIN, SELF_HOSTED_ORIGIN],
  })
  assert.equal(countOccurrences(prompt, 'HypAware Cloud and hyp.acme.dev'), 3)
  // Still one destination term: neither name appears anywhere on its own.
  assert.equal(countOccurrences(prompt, 'HypAware Cloud'), 3)
  assert.equal(countOccurrences(prompt, 'hyp.acme.dev'), 3)
  // Two origins of the same server (the alias table folds them) are one name.
  const aliased = buildClassificationPrompt({
    cwd: CLASSIFICATION_PROMPT_CWD,
    origins: [BUILTIN_ORIGIN, 'https://hypaware.hyperparam.app'],
  })
  assert.equal(aliased, EXPECTED_CLASSIFICATION_PROMPT)
})

test('an unresolvable destination degrades to a neutral name, never a blank or a cloud (#2197)', () => {
  // Every in-tree caller prompts only when enrolled, so this is the direct
  // caller / unreadable-layer case. It must not render "forwarded to ." and
  // it must not name a hosted service the machine may not be using.
  // The last entry is the one an equality-typed guard would miss: a non-string
  // that coerces to a valid URL, which reaches here from a corrupt central
  // layer and would otherwise print whatever is on disk.
  const unnameable = [undefined, [], [''], ['not a url'], /** @type {any} */ ([42, null, ['https://sneaky.example']])]
  for (const origins of unnameable) {
    const prompt = buildClassificationPrompt({ cwd: CLASSIFICATION_PROMPT_CWD, origins })
    assert.match(prompt, /are recorded and forwarded to your HypAware server\.$/m)
    assert.equal(countOccurrences(prompt, 'your HypAware server'), 3)
    assert.equal(/cloud/i.test(prompt), false)
  }
})

// The blurb is also checked on its own, so the two properties the literal above
// encodes are still named in code rather than only in a comment. This one is a
// single string with no structure to parse, so it has none of the clause
// problems the block-wide version had: it reads the one field a hedge would
// most naturally be added back to.
const CONDITIONAL_OPENERS =
  'when|whenever|while|if|once|unless|until|provided|assuming|as long as|so long as|only|where|subject to|depending on'

const CONNECTIVITY_TOKENS =
  'connect\\w*|online|offline|reach\\w*|network|signed[- ]in|logged[- ]in|link\\w*|available|availability|internet|connectivity'

const CONNECTION_CONDITIONAL = new RegExp(
  '\\b(?:' + CONDITIONAL_OPENERS + ')\\b[^.\\n]{0,60}\\b(?:' + CONNECTIVITY_TOKENS + ')\\b',
  'i'
)

test('the sync blurb states the forwarding without a connection-conditional hedge', () => {
  const sync = CLASSIFICATION_CHOICES.find((c) => c.class === 'full')
  assert.ok(sync, 'the full/sync choice is present')
  // The disclosure has to be there before its phrasing can be pinned.
  const blurb = sync.blurb('HypAware Cloud')
  assert.match(blurb, /\b(?:sync\w*|forward\w*|upload\w*|sen[dt])\b/i)
  assert.equal(
    CONNECTION_CONDITIONAL.test(blurb),
    false,
    `the sync blurb hedges the forwarding on connectivity: ${JSON.stringify(blurb)}`
  )
})

test('decideClassification: with the ask on, prompt only when enrolled AND interactive AND unclassified', () => {
  const asking = { askMode: /** @type {const} */ ('ask') }
  assert.deepEqual(
    decideClassification({ enrolled: true, interactive: true, governed: false, ...asking }),
    { prompt: true, reason: 'unclassified' }
  )
  assert.deepEqual(
    decideClassification({ enrolled: false, interactive: true, governed: false, ...asking }),
    { prompt: false, reason: 'unenrolled' }
  )
  assert.deepEqual(
    decideClassification({ enrolled: true, interactive: true, governed: true, ...asking }),
    { prompt: false, reason: 'classified' }
  )
  assert.deepEqual(
    decideClassification({ enrolled: true, interactive: false, governed: false, ...asking }),
    { prompt: false, reason: 'non-interactive' }
  )
  // Unenrolled dominates even when interactive+unclassified would otherwise ask.
  assert.equal(decideClassification({ enrolled: false, interactive: false, governed: false, ...asking }).prompt, false)
  // An omitted askMode is the product default (LLP 0200 #default), which is
  // sync: the per-folder ask is the opt-in half of the pair.
  assert.equal(decideClassification({ enrolled: true, interactive: true, governed: false }).reason, 'ask-disabled')
})

test('decideClassification: the default sync mode means no ask at all (LLP 0200 #default)', () => {
  assert.deepEqual(
    decideClassification({ enrolled: true, interactive: true, governed: false, askMode: 'sync' }),
    { prompt: false, reason: 'ask-disabled' }
  )
  // "Stop asking me" is the broadest answer on the screen, so it outranks
  // every per-folder reason below it - but never enrollment, which is what
  // makes the hook exist at all.
  assert.equal(
    decideClassification({ enrolled: true, interactive: true, governed: true, askMode: 'sync' }).reason,
    'ask-disabled'
  )
  assert.equal(
    decideClassification({ enrolled: false, interactive: true, governed: false, askMode: 'sync' }).reason,
    'unenrolled'
  )
  // The explicit `ask` is exactly today's behavior, not a third state.
  assert.deepEqual(
    decideClassification({ enrolled: true, interactive: true, governed: false, askMode: 'ask' }),
    { prompt: true, reason: 'unclassified' }
  )
})

test('evaluateCwdClassification honors a standing sync preference and reports it', async () => {
  const hypHome = mkdtempSync(path.join(tmpdir(), 'classify-folder-ask-'))
  try {
    const stateDir = readObservabilityEnv({ HYP_HOME: hypHome }).stateDir
    await writeFolderAskMode({ stateDir, mode: 'sync' })
    const result = await evaluateCwdClassification({
      cwd: '/work/fresh',
      interactive: true,
      env: { HYP_HOME: hypHome },
      deps: {
        readCentralSinkOrigins: async () => ['https://central.example'],
        createResolver: () => makeResolver({ governedBy: null, class: 'full' }),
      },
    })
    assert.equal(result.prompt, false)
    assert.equal(result.reason, 'ask-disabled')
    assert.equal(result.askMode, 'sync')
    assert.equal(result.promptText, undefined)
    assert.equal(result.enrolled, true, 'the machine is still enrolled; only the question is off')
  } finally {
    rmSync(hypHome, { recursive: true, force: true })
  }
})

test('a machine that never answered is not asked: the default is sync (LLP 0200 #default)', async () => {
  const hypHome = mkdtempSync(path.join(tmpdir(), 'classify-folder-default-'))
  try {
    const result = await evaluateCwdClassification({
      cwd: '/work/fresh',
      interactive: true,
      env: { HYP_HOME: hypHome },
      deps: {
        readCentralSinkOrigins: async () => ['https://central.example'],
        createResolver: () => makeResolver({ governedBy: null, class: 'full' }),
      },
    })
    assert.equal(result.prompt, false)
    assert.equal(result.reason, 'ask-disabled')
    assert.equal(result.askMode, 'sync', 'no preference on disk means the product default, not the ask')
  } finally {
    rmSync(hypHome, { recursive: true, force: true })
  }
})

test('turning the ask on restores the per-folder question', async () => {
  const hypHome = mkdtempSync(path.join(tmpdir(), 'classify-folder-on-'))
  try {
    const stateDir = readObservabilityEnv({ HYP_HOME: hypHome }).stateDir
    await writeFolderAskMode({ stateDir, mode: 'ask' })
    const result = await evaluateCwdClassification({
      cwd: '/work/fresh',
      interactive: true,
      env: { HYP_HOME: hypHome },
      deps: {
        readCentralSinkOrigins: async () => ['https://central.example'],
        createResolver: () => makeResolver({ governedBy: null, class: 'full' }),
      },
    })
    assert.equal(result.prompt, true)
    assert.equal(result.reason, 'unclassified')
    assert.ok(result.promptText?.includes('/work/fresh'))
  } finally {
    rmSync(hypHome, { recursive: true, force: true })
  }
})

test('a corrupt preference costs a question, never a silent sync', async () => {
  const hypHome = mkdtempSync(path.join(tmpdir(), 'classify-folder-corrupt-'))
  try {
    const stateDir = readObservabilityEnv({ HYP_HOME: hypHome }).stateDir
    const prefPath = folderAskPath(stateDir)
    mkdirSync(path.dirname(prefPath), { recursive: true })
    writeFileSync(prefPath, '{ truncated')
    const result = await evaluateCwdClassification({
      cwd: '/work/fresh',
      interactive: true,
      env: { HYP_HOME: hypHome },
      deps: {
        readCentralSinkOrigins: async () => ['https://central.example'],
        createResolver: () => makeResolver({ governedBy: null, class: 'full' }),
      },
    })
    assert.equal(result.prompt, true)
    assert.equal(result.askMode, 'ask')
  } finally {
    rmSync(hypHome, { recursive: true, force: true })
  }
})

test('evaluateCwdClassification prompts for an enrolled, interactive, unclassified cwd with the ask on', async () => {
  const result = await evaluateCwdClassification({
    cwd: '/work/fresh',
    interactive: true,
    env: { HYP_HOME: '/tmp/does-not-matter' },
    deps: {
      readCentralSinkOrigins: async () => ['https://central.example'],
      createResolver: () => makeResolver({ governedBy: null, class: 'full' }),
      readFolderAskMode: async () => 'ask',
    },
  })
  assert.equal(result.prompt, true)
  assert.equal(result.reason, 'unclassified')
  assert.equal(result.enrolled, true)
  assert.equal(result.governed, false)
  assert.ok(result.promptText && result.promptText.includes('/work/fresh'))
  // The origins that answered the enrollment question are the ones the copy
  // names (#2197): dropping them on the way to the prompt would silently
  // degrade every enrolled machine to the neutral fallback.
  assert.equal(countOccurrences(result.promptText, 'central.example'), 3)
  assert.equal(/cloud/i.test(result.promptText), false)
})

test('evaluateCwdClassification is inert on an unenrolled machine', async () => {
  const result = await evaluateCwdClassification({
    cwd: '/work/fresh',
    interactive: true,
    env: { HYP_HOME: '/tmp/x' },
    deps: {
      readCentralSinkOrigins: async () => [],
      createResolver: () => makeResolver({ governedBy: null, class: 'full' }),
    },
  })
  assert.equal(result.prompt, false)
  assert.equal(result.reason, 'unenrolled')
  assert.equal(result.promptText, undefined)
})

test('evaluateCwdClassification does not prompt once the folder is classified', async () => {
  // An explicit machine-local entry (even an explicit `full`/sync) sets
  // governedBy, so the folder reads as "asked and answered".
  const result = await evaluateCwdClassification({
    cwd: '/work/answered',
    interactive: true,
    env: { HYP_HOME: '/tmp/x' },
    deps: {
      readCentralSinkOrigins: async () => ['https://central.example'],
      createResolver: (listPath) => makeResolver({ governedBy: listPath, class: 'full' }),
      readFolderAskMode: async () => 'ask',
    },
  })
  assert.equal(result.prompt, false)
  assert.equal(result.reason, 'classified')
  assert.equal(result.governed, true)
})

test('evaluateCwdClassification passes a non-interactive session through', async () => {
  const result = await evaluateCwdClassification({
    cwd: '/work/ci',
    interactive: false,
    env: { HYP_HOME: '/tmp/x' },
    deps: {
      readCentralSinkOrigins: async () => ['https://central.example'],
      createResolver: () => makeResolver({ governedBy: null, class: 'full' }),
      readFolderAskMode: async () => 'ask',
    },
  })
  assert.equal(result.prompt, false)
  assert.equal(result.reason, 'non-interactive')
})

test('evaluateCwdClassification never fails the session on a corrupt list or a broken enrollment read', async () => {
  const result = await evaluateCwdClassification({
    cwd: '/work/corrupt',
    interactive: true,
    env: { HYP_HOME: '/tmp/x' },
    deps: {
      // Enrollment lookup throws -> treated as not enrolled, never surfaced.
      readCentralSinkOrigins: async () => { throw new Error('cannot read central layer') },
      createResolver: () => ({
        resolve() { throw new LocalOnlyListUnreadableError('/tmp/x/usage-policy/local-only.json') },
        isIgnored() { return false },
      }),
    },
  })
  assert.equal(result.prompt, false)
  // Enrollment failed -> unenrolled dominates; the point is it did not throw.
  assert.equal(result.enrolled, false)
})

test('the classification answer lands via the real hyp policy set verb (LLP 0106 -> LLP 0111 -> LLP 0103)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'classify-verb-repo-'))
  const hypHome = mkdtempSync(path.join(tmpdir(), 'classify-verb-home-'))
  try {
    const stateDir = readObservabilityEnv({ HYP_HOME: hypHome }).stateDir
    const listPath = localOnlyListPath(stateDir)

    // Before answering: nothing governs the folder, so a fresh resolver reads
    // the implicit default and evaluate would prompt.
    const before = createUsagePolicyResolver({ localOnlyListPath: listPath }).resolve(root)
    assert.equal(before.governedBy, null)

    // Answer "ignore" by running exactly the argv the hook advertises.
    const argv = verbArgvForClass('ignore', root)
    assert.deepEqual(argv, ['privacy', 'set', root, 'ignore'])
    const res = await runVerb(argv, { cwd: root, hypHome })
    assert.equal(res.code, 0, res.stderr)

    // After answering: the folder is governed by the machine-local list with
    // the chosen class, so it would never be asked about again.
    const after = createUsagePolicyResolver({ localOnlyListPath: listPath }).resolve(root)
    assert.equal(after.class, 'ignore')
    assert.equal(after.governedBy, listPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(hypHome, { recursive: true, force: true })
  }
})

/**
 * How many times `needle` occurs in `haystack`.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

/**
 * A minimal resolver stub returning a fixed resolve result.
 * @param {{ governedBy: string | null, class: 'ignore' | 'local-only' | 'full' }} result
 */
function makeResolver(result) {
  return {
    resolve() {
      return { class: result.class, governedBy: result.governedBy, declared: result.governedBy ? result.class : null }
    },
    isIgnored() {
      return result.class === 'ignore'
    },
  }
}

/**
 * @param {string[]} argv
 * @param {{ cwd: string, hypHome: string }} opts
 */
async function runVerb(argv, opts) {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  // The marking answer now dispatches the two-word `policy set` verb
  // (LLP 0111 #teaching), so resolve a two-word command name before falling
  // back to the single-word form - exactly how the CLI's group dispatch works.
  const twoWord = argv.length >= 2 ? `${argv[0]} ${argv[1]}` : null
  const useTwoWord = Boolean(twoWord && registry.get(twoWord))
  const name = useTwoWord ? /** @type {string} */ (twoWord) : argv[0]
  const rest = useTwoWord ? argv.slice(2) : argv.slice(1)
  const command = /** @type {CommandRegistration} */ (registry.get(name))
  assert.ok(command, `${name} is registered`)
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    cwd: opts.cwd,
    env: { HYP_HOME: opts.hypHome },
    config: { version: 2 },
    query: { getDataset: () => undefined, listDatasets: () => [] },
    storage: { cacheRoot: path.join(opts.cwd, '.cache'), pendingInfo: async () => ({ pending: false }) },
  })
  const code = await command.run(rest, /** @type {CommandRunContext} */ (ctx))
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}
