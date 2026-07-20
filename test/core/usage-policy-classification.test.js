// @ts-check

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/matcher.js'
import { localOnlyListPath } from '../../src/core/usage-policy/local_only.js'
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

test('verbArgvForClass maps each class to its hyp policy set token (LLP 0111 #teaching)', () => {
  assert.deepEqual(verbArgvForClass('full', '/work/repo'), ['policy', 'set', '/work/repo', 'sync'])
  assert.deepEqual(verbArgvForClass('local-only', '/work/repo'), ['policy', 'set', '/work/repo', 'local-only'])
  assert.deepEqual(verbArgvForClass('ignore', '/work/repo'), ['policy', 'set', '/work/repo', 'ignore'])
  assert.throws(() => verbArgvForClass(/** @type {any} */ ('nope'), '/x'), /unknown class/)
})

test('the three choices are presented least-to-most restrictive with their tokens', () => {
  assert.deepEqual(CLASSIFICATION_CHOICES.map((c) => c.class), ['full', 'local-only', 'ignore'])
  assert.deepEqual(CLASSIFICATION_CHOICES.map((c) => c.token), ['sync', 'local-only', 'ignore'])
})

test('buildClassificationPrompt names the folder, all three classes, and each policy set command', () => {
  const prompt = buildClassificationPrompt({ cwd: '/work/secret-repo' })
  assert.match(prompt, /\/work\/secret-repo/)
  assert.match(prompt, /enrolled/)
  // Every class label and its exact command are present so the assistant can
  // run the right verb without inventing a spelling.
  assert.match(prompt, /sync:/)
  assert.match(prompt, /local-only:/)
  assert.match(prompt, /ignore:/)
  assert.match(prompt, /hyp policy set \/work\/secret-repo sync/)
  assert.match(prompt, /hyp policy set \/work\/secret-repo local-only/)
  assert.match(prompt, /hyp policy set \/work\/secret-repo ignore/)
  // Exit criterion (LLP 0110): the hook never teaches an ignore-spelled command
  // for a non-ignore class - the deprecated flag spellings are gone entirely.
  assert.equal(/hyp ignore --sync/.test(prompt), false)
  assert.equal(/hyp ignore --local-only/.test(prompt), false)
  assert.equal(/hyp ignore --private/.test(prompt), false)
  // @ref LLP 0113 [tests]: the menu mandate is part of the pinned consent copy
  assert.match(prompt, /selection menu/)
  assert.match(prompt, /AskUserQuestion/)
  assert.match(prompt, /unless no such tool exists/)
  // Repo style: no em dashes anywhere in the consent copy.
  assert.equal(prompt.includes('—'), false)
})

test('decideClassification: prompt only when enrolled AND interactive AND unclassified', () => {
  assert.deepEqual(
    decideClassification({ enrolled: true, interactive: true, governed: false }),
    { prompt: true, reason: 'unclassified' }
  )
  assert.deepEqual(
    decideClassification({ enrolled: false, interactive: true, governed: false }),
    { prompt: false, reason: 'unenrolled' }
  )
  assert.deepEqual(
    decideClassification({ enrolled: true, interactive: true, governed: true }),
    { prompt: false, reason: 'classified' }
  )
  assert.deepEqual(
    decideClassification({ enrolled: true, interactive: false, governed: false }),
    { prompt: false, reason: 'non-interactive' }
  )
  // Unenrolled dominates even when interactive+unclassified would otherwise ask.
  assert.equal(decideClassification({ enrolled: false, interactive: false, governed: false }).prompt, false)
})

test('evaluateCwdClassification prompts for an enrolled, interactive, unclassified cwd', async () => {
  const result = await evaluateCwdClassification({
    cwd: '/work/fresh',
    interactive: true,
    env: { HYP_HOME: '/tmp/does-not-matter' },
    deps: {
      readCentralSinkOrigins: async () => ['https://central.example'],
      createResolver: () => makeResolver({ governedBy: null, class: 'full' }),
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
    assert.deepEqual(argv, ['policy', 'set', root, 'ignore'])
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
