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
// '\n' (see buildClassificationPrompt). A phrase that straddles that join
// (a destination word on one push, a hedge word on the next) would dodge any
// pattern that treats '\n' as a hard stop, so every check below runs against
// this collapsed form instead of the raw rendered string.
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim()
}

// A closed list of destination "families" (server/cloud/remote) is exactly
// as strong as the list is complete: a fourth term (a product name, "the
// service") never appears in it and slips through naming a second
// destination for free. So instead of banning known-bad terms, assert a
// positive fact: every forwarding verb in the block names an object, and all
// of those objects are the same place. The capture is bounded to one clause
// (stops at , . ( ` : or a conditional-opener / command word) so it can
// never run past the sentence that actually names the destination into
// unrelated prose, such as the next bullet's `hyp ...` command line.
const CONDITIONAL_OPENERS =
  'when|whenever|while|if|once|unless|until|provided|assuming|as long as|so long as|only|where|subject to|depending on'

const FORWARDING_DESTINATION = new RegExp(
  '\\b(?:forward|forwards|forwarded|sync|syncs|synced|send|sends|sent|upload|uploads|uploaded)' +
    '\\s+(?:it\\s+|them\\s+)?to\\s+' +
    '([^,.():`]+?)' +
    '(?=[,.():`]|\\s+\\b(?:' + CONDITIONAL_OPENERS + '|hyp)\\b|$)',
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
  const normalized = normalizeWhitespace(text)
  const found = []
  let m
  // A fresh RegExp per call: the pattern is /g, and a shared exec-stateful
  // instance would carry lastIndex across calls in the same process.
  const re = new RegExp(FORWARDING_DESTINATION)
  while ((m = re.exec(normalized))) {
    found.push(normalizeDestination(m[1]))
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

// The block also contains bare instances of some opener words in sentences
// that say nothing about forwarding ("keep sessions on this machine only",
// "run the matching command once"). Broadening CONNECTIVITY_TOKENS without
// narrowing where it is allowed to fire would make those innocent sentences
// trip the guard. So the whole-block check below only evaluates sentences
// that themselves make a forwarding claim.
const FORWARDING_VERB = /\b(?:forward\w*|sync\w*|sen[dt]s?|sent|upload\w*)\b/i

function forwardingSentences(text) {
  const normalized = normalizeWhitespace(text)
  return normalized.split(/(?<=[.!?])\s+/).filter((s) => FORWARDING_VERB.test(s))
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
  // against the normalized, sentence-split text rather than the raw prompt.
  const prompt = buildClassificationPrompt({ cwd: '/work/secret-repo' })
  const hedgedForwardingSentence = forwardingSentences(prompt).find((s) => CONNECTION_CONDITIONAL.test(s))
  assert.equal(
    hedgedForwardingSentence,
    undefined,
    `the rendered consent prompt hedges a disclosure that is unconditional where it renders: ${JSON.stringify(hedgedForwardingSentence)}`
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
