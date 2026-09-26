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
  const prompt = buildClassificationPrompt({ cwd: '/work/secret-repo' })
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
  const prompt = buildClassificationPrompt({ cwd: '/work/secret-repo' })
  assert.match(prompt, /hyp privacy folders sync/)
  assert.match(prompt, /hyp privacy folders ask/)
})

// The prose array wraps sentences across several pushed lines joined with
// '\n' (see buildClassificationPrompt): a phrase that straddles that join (a
// destination word on one push, a hedge word on the next) has to survive
// being read as one clause. But the prompt also has a bullet/command region
// with no sentence-terminating punctuation at all ('  - sync: ...' and
// '      hyp privacy set ...'), where collapsing everything into one string
// would glue unrelated bullets and commands into a single ~700-character
// pseudo-sentence, letting a word in one bullet pair with an opener from a
// different bullet or an unrelated command line. So instead of collapsing
// all whitespace uniformly, split the raw prompt into clauses along its own
// structure: a blank line, or an indented line, closes the current unit, and
// only consecutive prose lines get joined before the sentence split. That
// keeps the line-wrap protection for prose while still isolating each bullet
// and each command line from its neighbors. The units are returned grouped
// rather than flattened because the hedge check below needs to know which
// clauses sit in the same paragraph as a forwarding claim.
function promptUnits(text) {
  const lines = text.split('\n')
  const units = []
  let current = []
  const flush = () => {
    if (current.length > 0) {
      units.push(current.join(' '))
      current = []
    }
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      flush()
      continue
    }
    // buildClassificationPrompt emits its prose flush left and indents
    // exactly the lines that stand alone: bullets ('  - sync: ...') and the
    // command under each ('      hyp privacy set ...'). Keying on that
    // emitted shape rather than on the binary's name is deliberate: `hyp`
    // and `hypaware` are both bound, so a name-matching rule silently stops
    // covering one of them, which is the bug this split exists to fix.
    if (/^\s/.test(line)) {
      flush()
      units.push(trimmed)
      continue
    }
    current.push(trimmed)
  }
  flush()
  return units.map((unit) =>
    unit
      .split(/(?<=[.!?])\s+/)
      .map((clause) => clause.replace(/\s+/g, ' ').trim())
      .filter((clause) => clause !== '')
  )
}

function promptClauses(text) {
  return promptUnits(text).flat()
}

// A closed list of destination "families" (server/cloud/remote) is exactly
// as strong as the list is complete: a fourth term (a product name, "the
// service") never appears in it and slips through naming a second
// destination for free. So instead of banning known-bad terms, assert a
// positive fact: every forwarding verb in the block names an object, and all
// of those objects are the same place. The capture is bounded to one clause
// (stops at , . ( ` : or a conditional-opener) so it can never run past the
// sentence that actually names the destination into unrelated prose; running
// per-clause (via promptClauses) rather than over the whole collapsed prompt
// is what keeps a bullet's destination from reaching into the next bullet's
// command line, so no binary-name stop word is needed here either.
const CONDITIONAL_OPENERS =
  'when|whenever|while|if|once|unless|until|provided|assuming|as long as|so long as|only|where|subject to|depending on'

const FORWARDING_DESTINATION = new RegExp(
  '\\b(?:forward|forwards|forwarded|sync|syncs|synced|send|sends|sent|upload|uploads|uploaded)' +
    '\\s+(?:it\\s+|them\\s+)?to\\s+' +
    '([^,.():`]+?)' +
    '(?=[,.():`]|\\s+\\b(?:' + CONDITIONAL_OPENERS + ')\\b|$)',
  'gi'
)

// A forwarding verb's object is not the only place this block can name the
// destination, and #2190 is about naming it two ways. The wording this PR
// replaced put one of its two namings in the enrollment clause ("enrolled
// with a shared HypAware server ... forwarded to that server"), so a guard
// that reads only forwarding objects passes a partial revert that restores
// "enrolled with a shared HypAware server" and leaves "forwarded to the
// cloud" alone: two terms for one destination, which is the defect. Count the
// enrollment object as a destination naming too, bounded the same way.
//
// Two limits, recorded rather than left to be rediscovered. This over-reads an
// enrollment clause whose object is not a place at all ("enrolled with the
// folder ask turned on"), and the assertion below quotes every captured phrase
// precisely so that failure explains itself. That direction is the right one to
// err in on a consent surface: the cost is an author reading a message that
// names the phrase it objected to, against shipping two names for one
// destination. And a second naming in neither position ("your organisation's
// HypAware server keeps the history") is still missed; catching that needs a
// closed list of destination nouns, which is the thing this guard replaced.
const ENROLLMENT_DESTINATION = new RegExp(
  '\\benrolled\\s+(?:with|in|into|to|against|on)\\s+' +
    '([^,.():`]+?)' +
    '(?=[,.():`]|\\s+\\b(?:' + CONDITIONAL_OPENERS + ')\\b|$)',
  'gi'
)

// Normalize a captured object so "the cloud", "the cloud " and "The Cloud"
// all count as the same destination, and only differ when they actually name
// a different place.
function normalizeDestination(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^(?:the|that|a|an|your|our|its)\s+/, '')
    .trim()
}

function extractDestinations(text) {
  const found = []
  for (const clause of promptClauses(text)) {
    let m
    // A fresh RegExp per clause: the patterns are /g, and a shared
    // exec-stateful instance would carry lastIndex across calls in the same
    // process.
    for (const pattern of [FORWARDING_DESTINATION, ENROLLMENT_DESTINATION]) {
      const re = new RegExp(pattern)
      while ((m = re.exec(clause))) {
        found.push(normalizeDestination(m[1]))
      }
    }
  }
  return found
}

// A conditional keyword within one clause of a connectivity word, so any
// synonym of "when this machine is connected" trips, not just that spelling.
// Broadened past the original connect*/online/offline/reachable/network/
// signed-in/logged-in set to also catch "once linked", "where available",
// "subject to connectivity" and "when ... can reach it": a hedge does not
// have to reuse "connect" or "reachable" to say the same thing.
const CONNECTIVITY_TOKENS =
  'connect\\w*|online|offline|reach\\w*|network|signed[- ]in|logged[- ]in|link\\w*|available|availability|internet|connectivity'

const CONNECTION_CONDITIONAL = new RegExp(
  '\\b(?:' + CONDITIONAL_OPENERS + ')\\b[^.\\n]{0,60}\\b(?:' + CONNECTIVITY_TOKENS + ')\\b',
  'i'
)

// The block also contains bare instances of some opener words in clauses
// that say nothing about forwarding ("keep sessions on this machine only",
// "run the matching command once"). Broadening CONNECTIVITY_TOKENS without
// narrowing where it is allowed to fire would make those innocent clauses
// trip the guard. So the whole-block check below only evaluates clauses
// that themselves make a forwarding claim, and it draws those clauses from
// promptClauses so a bullet's own opener (or "only" inside "local-only")
// never reaches across into a different bullet's forwarding verb.
const FORWARDING_VERB = /\b(?:forward\w*|sync\w*|sen[dt]s?|sent|upload\w*)\b/i

// A hedge does not have to sit inside the sentence that makes the forwarding
// claim. An author told not to hedge the claim writes the hedge as the next
// sentence instead ("... forwarded to the cloud. That happens when this
// machine is connected."), and a strictly per-clause filter reads that
// continuation as an innocent clause because it carries no forwarding verb of
// its own. So scan from a paragraph's first forwarding claim to the end of
// that paragraph. That still excludes the menu-presentation clause, which
// precedes its paragraph's first forwarding claim, so the false positive the
// per-clause narrowing was added for stays closed.
//
// Residual, recorded rather than left unknown: a hedge placed *before* a
// paragraph's first forwarding claim is not scanned, because widening to the
// whole paragraph puts the menu clause back in range.
function forwardingClauses(text) {
  const scanned = []
  for (const unit of promptUnits(text)) {
    const first = unit.findIndex((clause) => FORWARDING_VERB.test(clause))
    if (first >= 0) scanned.push(...unit.slice(first))
  }
  return scanned
}

test('the consent prompt names the sync destination exactly one way', () => {
  // The choice blurbs are rendered into the prompt, so the whole block is what
  // the user reads and what has to agree with itself.
  const prompt = buildClassificationPrompt({ cwd: '/work/secret-repo' })
  const destinations = extractDestinations(prompt)
  // A forwarding claim with no named destination at all (e.g. "forwarded off
  // this machine") is not a pass by default: the guard below only checks
  // distinctness among what was found, so an empty set has to fail loudly
  // here rather than vacuously satisfying "at most one".
  assert.ok(destinations.length > 0, 'the rendered prompt makes a forwarding claim but names no destination for it')
  const distinct = [...new Set(destinations)]
  assert.equal(
    distinct.length,
    1,
    `the rendered prompt names ${distinct.length} distinct destinations (${distinct.join(', ')}); one consent surface gets one term`
  )
})

test('the sync blurb states the forwarding without a connection-conditional hedge', () => {
  // `decideClassification` never returns prompt on an unenrolled machine, so
  // the forwarding is unconditionally true wherever this block renders and a
  // connectivity hedge understates it.
  const sync = CLASSIFICATION_CHOICES.find((c) => c.class === 'full')
  assert.ok(sync, 'the full/sync choice is present')
  // The disclosure has to be there before its phrasing can be pinned.
  assert.match(sync.blurb, /\b(?:sync\w*|forward\w*|upload\w*|sen[dt])\b/i)
  assert.equal(
    CONNECTION_CONDITIONAL.test(sync.blurb),
    false,
    `the sync blurb hedges the forwarding on connectivity: ${JSON.stringify(sync.blurb)}`
  )
  // And nowhere else in the block either, so the hedge cannot simply move -
  // including across the prose array's line wrap, which is why this runs
  // against promptClauses's structural split rather than the raw prompt.
  const prompt = buildClassificationPrompt({ cwd: '/work/secret-repo' })
  const hedgedForwardingClause = forwardingClauses(prompt).find((c) => CONNECTION_CONDITIONAL.test(c))
  assert.equal(
    hedgedForwardingClause,
    undefined,
    `the rendered consent prompt hedges a disclosure that is unconditional where it renders: ${JSON.stringify(hedgedForwardingClause)}`
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
