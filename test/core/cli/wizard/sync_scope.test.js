// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { runWizardSyncScope } from '../../../../src/core/cli/wizard/sync_scope.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import {
  clientSyncListPath,
  readClientSyncEntries,
  writeClientSyncEntries,
} from '../../../../src/core/usage-policy/client_sync.js'
import { PromptCancelledError } from '../../../../src/core/cli/tui/runtime.js'

// The wizard's sync-scope step (LLP 0188 #never-silent, LLP 0190 #sync-gate):
// a defaults gate stating what will sync, then on request a multiselect where
// checked means "syncs" and unchecking keeps a source local-only. Everything
// is checked by default on a fresh run, locked sources never shown (the
// candidates list is already locked-filtered), and the write has editor
// semantics over the shown candidates only.
// @ref LLP 0188#never-silent [tests]:
// @ref LLP 0190#sync-gate [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sync-scope-'))
  return { hypHome, env: { HYP_HOME: hypHome }, stateDir: readObservabilityEnv({ HYP_HOME: hypHome }).stateDir }
}

/** @param {string} id */
function descriptor(id) {
  return /** @type {any} */ ({ plugin: `@hypaware/${id}`, id, label: `capture ${id}`, summary: `${id} rows` })
}

/**
 * @param {string[]} answer checked values the fake multiselect returns
 */
function capturingPrompt(answer) {
  /** @type {{ question?: any }} */
  const state = {}
  const prompt = async (/** @type {any} */ question) => {
    state.question = question
    return answer
  }
  return { prompt, state }
}

/**
 * @param {string} answer the gate choice the fake confirm returns
 */
function capturingConfirm(answer) {
  /** @type {{ question?: any }} */
  const state = {}
  const confirm = async (/** @type {any} */ question) => {
    state.question = question
    return answer
  }
  return { confirm, state }
}

test('a fresh enrolled run: the gate states what will sync and accepting opts nothing out', async () => {
  const { env, stateDir } = await makeHome()
  const { confirm, state } = capturingConfirm('accept')
  let menuShown = false

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
    progress: 'Step 3 of 4 · Choose what syncs',
    prompt: async () => { menuShown = true; return [] },
    confirm,
  }))

  assert.deepEqual(result, { optedOut: [] })
  assert.equal(state.question.title, 'These will sync to your server:')
  assert.deepEqual(state.question.items, ['  capture openclaw', '  capture hermes'], 'one source per line, not a crammed title')
  assert.equal(state.question.progress, 'Step 3 of 4 · Choose what syncs')
  assert.equal(state.question.default, 'accept')
  // The gate branches on the option *value*, not the label, and the
  // customize side has no other anchor: renaming it while the branch still
  // reads 'customize' would silently turn "Select what to sync" into
  // accept-the-defaults. Pin the values the branch depends on.
  assert.deepEqual(state.question.options.map((/** @type {any} */ o) => o.value), ['accept', 'customize'])
  assert.equal(menuShown, false, 'accepting the defaults never opens the menu')
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [], 'the store is stamped (empty), not left absent')
})

test('the menu checks what syncs: everything checked by default on a fresh run', async () => {
  const { env, stateDir } = await makeHome()
  const { confirm } = capturingConfirm('customize')
  const { prompt, state } = capturingPrompt(['openclaw', 'hermes'])

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
    progress: 'Step 3 of 4 · Choose what syncs',
    prompt, confirm,
  }))

  assert.deepEqual(result, { optedOut: [] })
  assert.match(state.question.title, /Choose what syncs/)
  assert.match(state.question.title, /Unchecked sources stay on this machine/)
  assert.equal(state.question.progress, 'Step 3 of 4 · Choose what syncs')
  assert.ok(state.question.options.every((/** @type {any} */ o) => o.checked === true), 'default-sync: everything pre-checked on a fresh run')
  assert.equal(state.question.enterKeepsChecked, true, 'the numbered fallback must keep the checked rows on a bare enter')
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [], 'the store is stamped (empty), not left absent')
})

// The non-TTY fallback path end to end: no prompt seams, the real
// readline factories driven by scripted answers. A bare enter at the
// menu keeps the rendered defaults; the historical enter-selects-none
// would have opted every candidate out, inverting the TUI default
// (LLP 0190 #sync-gate).

/**
 * @param {PassThrough} input
 * @param {string[]} answers one per prompt line, in order
 */
function promptDrivenOutput(input, answers) {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) {
      value += String(chunk)
      if (String(chunk).startsWith('select')) {
        const answer = answers.shift()
        if (answer !== undefined) input.write(answer)
        if (answers.length === 0) input.end()
      }
      return true
    },
    text() { return value },
  }
}

test('non-TTY: opening the menu and pressing enter keeps the defaults, not opt-everything-out', async () => {
  const { env, stateDir } = await makeHome()
  const input = new PassThrough()
  // Gate: 2 = "Select what to sync"; menu: bare enter.
  const stdout = promptDrivenOutput(input, ['2\n', '\n'])

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    stdin: input,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
  }))

  assert.deepEqual(result, { optedOut: [] })
  assert.match(stdout.text(), /\[x\] capture openclaw/, 'the fallback shows the checked defaults')
  assert.match(stdout.text(), /\[x\] capture hermes/)
  assert.match(stdout.text(), /enter keeps \[x\]/, 'the prompt line says what enter does')
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [], 'everything still syncs')
})

test('non-TTY: a bare enter at the menu round-trips a standing opt-out instead of resetting it', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'openclaw', class: 'local-only' }] })
  const input = new PassThrough()
  const stdout = promptDrivenOutput(input, ['2\n', '\n'])

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    stdin: input,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
  }))

  assert.deepEqual(result, { optedOut: ['openclaw'] })
  assert.match(stdout.text(), /\[ \] capture openclaw/, 'the standing opt-out renders unchecked')
  assert.match(stdout.text(), /\[x\] capture hermes/)
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [
    { source: 'openclaw', class: 'local-only' },
  ], 'enter keeps the split it showed')
})

test('unchecking a source writes its opt-out and names the follow-up command', async () => {
  const { env, stateDir } = await makeHome()
  const { confirm } = capturingConfirm('customize')
  // Only hermes stays checked; openclaw was unchecked and goes local-only.
  const { prompt } = capturingPrompt(['hermes'])
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
    prompt, confirm,
  }))

  assert.deepEqual(result, { optedOut: ['openclaw'] })
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [
    { source: 'openclaw', class: 'local-only' },
  ])
  assert.match(stdout.text(), /Keeping local-only: openclaw/)
  assert.match(stdout.text(), /hyp policy client/)
})

test('a re-entry states the split on the gate and accepting keeps it', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'openclaw', class: 'local-only' }] })
  const { confirm, state } = capturingConfirm('accept')

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
    prompt: async () => { throw new Error('menu must not open on accept') },
    confirm,
  }))

  assert.equal(state.question.title, 'These will sync to your server:')
  assert.deepEqual(
    state.question.items,
    ['  capture hermes', 'Staying local-only:', '  capture openclaw'],
    'a re-entry lists both halves of the split'
  )
  assert.deepEqual(result, { optedOut: ['openclaw'] })
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [
    { source: 'openclaw', class: 'local-only' },
  ], 'accepting round-trips the store instead of resetting it')
})

test('a re-entry renders existing opt-outs unchecked and re-checking removes them', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'openclaw', class: 'local-only' }] })
  const { confirm } = capturingConfirm('customize')
  const { prompt, state } = capturingPrompt(['openclaw'])

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw')],
    prompt, confirm,
  }))

  const row = state.question.options.find((/** @type {any} */ o) => o.value === 'openclaw')
  assert.notEqual(row.checked, true, 'the existing opt-out arrives unchecked')
  assert.deepEqual(result, { optedOut: [] })
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [], 're-checking removed the opt-out')
})

test('editor semantics: an entry for a source not shown this run is kept', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'hermes', class: 'local-only' }] })
  const { confirm } = capturingConfirm('customize')
  // openclaw is unchecked (opted out); hermes is not shown this run.
  const { prompt } = capturingPrompt([])

  await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw')],
    prompt, confirm,
  }))

  assert.deepEqual(await readClientSyncEntries({ stateDir }), [
    { source: 'hermes', class: 'local-only' },
    { source: 'openclaw', class: 'local-only' },
  ], 'the unshown hermes entry survives the openclaw-only edit')
})

// Locked (org) sources always sync (LLP 0188 #locked); the step shows them
// read-only so "these will sync" is the whole picture, not the editable
// slice (LLP 0190 #sync-gate).

test('locked sources lead the gate list fleet-suffixed and the menu as read-only rows', async () => {
  const { env } = await makeHome()
  const { confirm, state: gate } = capturingConfirm('customize')
  const { prompt, state: menu } = capturingPrompt(['claude', 'openclaw'])

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw')],
    locked: [descriptor('claude')],
    prompt, confirm,
  }))

  assert.deepEqual(gate.question.items, [
    '  capture claude · managed by your fleet',
    '  capture openclaw',
  ], 'the always-sync org rows are part of "these will sync"')
  const lockedRow = menu.question.options[0]
  assert.equal(lockedRow.value, 'claude')
  assert.equal(lockedRow.checked, true)
  assert.equal(lockedRow.disabled, true)
  assert.match(lockedRow.label, /managed by your fleet/)
  assert.deepEqual(result, { optedOut: [] })
})

test('a locked source never enters the opt-out computation', async () => {
  const { env, stateDir } = await makeHome()
  const { confirm } = capturingConfirm('customize')
  // Only the locked claude comes back checked; the openclaw candidate was
  // unchecked and opts out - claude must not.
  const { prompt } = capturingPrompt(['claude'])

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw')],
    locked: [descriptor('claude')],
    prompt, confirm,
  }))

  assert.deepEqual(result, { optedOut: ['openclaw'] })
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [
    { source: 'openclaw', class: 'local-only' },
  ], 'no entry for the locked source')
})

test('zero candidates with org rows: prints the position and the fleet line, prompts nothing, writes nothing', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()
  let prompted = false

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [descriptor('claude')],
    progress: 'Step 3 of 4 · Choose what syncs',
    prompt: async () => { prompted = true; return [] },
    confirm: async () => { prompted = true; return 'accept' },
  }))

  // `noQuestion` is the part the orchestrator reads: a lane that only
  // stated its outcome is not a screen, so the new-folder lane behind it
  // backs past it to the picker rather than re-running it (LLP 0191
  // #back-edges).
  assert.deepEqual(result, { noQuestion: true, optedOut: [] })
  assert.equal(prompted, false)
  assert.match(stdout.text(), /Step 3 of 4 · Choose what syncs/)
  assert.match(stdout.text(), /managed by your fleet and always syncs/)
  assert.equal(await readClientSyncEntries({ stateDir: stateDir }), null, 'no store write on the no-question path')
})

// The same no-question path with nothing for the fleet to own. Reachable on
// an enrolled machine whose only locked rows are hidden (LLP 0276
// #sync-gate) and that picked nothing visible: claiming the fleet manages
// "everything you picked" would invent an owner for an empty list.
// @ref LLP 0276#sync-gate [tests]:
test('zero candidates and no org rows: says nothing syncs, never names the fleet', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()
  let prompted = false

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
    progress: 'Step 3 of 4 · Choose what syncs',
    prompt: async () => { prompted = true; return [] },
    confirm: async () => { prompted = true; return 'accept' },
  }))

  assert.deepEqual(result, { noQuestion: true, optedOut: [] })
  assert.equal(prompted, false)
  assert.match(stdout.text(), /Step 3 of 4 · Choose what syncs/)
  assert.match(stdout.text(), /nothing syncs to your server/)
  assert.doesNotMatch(stdout.text(), /fleet/)
  assert.equal(await readClientSyncEntries({ stateDir }), null, 'no store write on the no-question path')
})

// The third no-question fact: the enrolled machine of LLP 0276 §problem,
// whose only locked rows are the hidden `raw-*` pair. Nothing was picked,
// but the org's gateway rows are locked, always sync, and cannot be opted
// out (LLP 0188 #locked) - so the line must not claim nothing leaves the
// machine, while still never naming a row the picker withheld.
// @ref LLP 0276#no-candidates [tests]:
test('zero candidates with only hidden org rows: does not claim nothing syncs', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()
  let prompted = false

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
    lockedHidden: 2,
    progress: 'Step 3 of 4 · Choose what syncs',
    prompt: async () => { prompted = true; return [] },
    confirm: async () => { prompted = true; return 'accept' },
  }))

  assert.deepEqual(result, { noQuestion: true, optedOut: [] })
  assert.equal(prompted, false)
  assert.match(stdout.text(), /Step 3 of 4 · Choose what syncs/)
  assert.match(stdout.text(), /still syncs to your server/)
  assert.doesNotMatch(stdout.text(), /nothing syncs to your server/)
  assert.doesNotMatch(stdout.text(), /raw-anthropic|Anthropic API/, 'the withheld rows are still never named')
  assert.equal(await readClientSyncEntries({ stateDir }), null, 'no store write on the no-question path')
})

// The candidate half of the same fact. A carried hidden row (LLP 0202
// #carry-through) that is not locked is composed into the local layer and
// syncs unless an opt-out entry says otherwise, and the display filter takes
// it off this screen - so the empty-candidate line must not claim nothing
// leaves the machine, and must not attribute the row to the fleet either.
// @ref LLP 0276#no-candidates [tests]:
test('zero visible candidates with a hidden picked row: does not claim nothing syncs, never names the fleet', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()
  let prompted = false

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
    lockedHidden: 0,
    candidatesHidden: 1,
    progress: 'Step 3 of 4 · Choose what syncs',
    prompt: async () => { prompted = true; return [] },
    confirm: async () => { prompted = true; return 'accept' },
  }))

  assert.deepEqual(result, { noQuestion: true, optedOut: [] })
  assert.equal(prompted, false)
  assert.match(stdout.text(), /Step 3 of 4 · Choose what syncs/)
  assert.match(stdout.text(), /still syncs to your server/)
  assert.doesNotMatch(stdout.text(), /nothing syncs to your server/)
  assert.doesNotMatch(stdout.text(), /fleet/, 'the fleet owns no row here, so it is never named')
  assert.doesNotMatch(stdout.text(), /raw-anthropic|Anthropic API/, 'the withheld row is still never named')
  assert.equal(await readClientSyncEntries({ stateDir }), null, 'no store write on the no-question path')
})

test('a cancelled gate returns cancelled and writes nothing', async () => {
  const { env, stateDir } = await makeHome()
  const stderr = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr, env,
    candidates: [descriptor('openclaw')],
    prompt: async () => [],
    confirm: async () => { throw new PromptCancelledError() },
  }))

  assert.equal(result.cancelled, true)
  assert.match(stderr.text(), /cancelled/)
  assert.equal(await readClientSyncEntries({ stateDir }), null)
})

test('a cancelled menu returns cancelled and writes nothing', async () => {
  const { env, stateDir } = await makeHome()
  const stderr = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr, env,
    candidates: [descriptor('openclaw')],
    prompt: async () => { throw new PromptCancelledError() },
    confirm: async () => 'customize',
  }))

  assert.equal(result.cancelled, true)
  assert.match(stderr.text(), /cancelled/)
  assert.equal(await readClientSyncEntries({ stateDir }), null)
})

test('a corrupt store skips the step with a warning and is never overwritten', async () => {
  const { env, stateDir } = await makeHome()
  const storePath = clientSyncListPath(stateDir)
  await fs.mkdir(path.dirname(storePath), { recursive: true })
  await fs.writeFile(storePath, '{ nope')
  const stderr = makeBuf()
  let prompted = false

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr, env,
    candidates: [descriptor('openclaw')],
    prompt: async () => { prompted = true; return [] },
    confirm: async () => { prompted = true; return 'accept' },
  }))

  // Skipped and unasked: the lane after it must not try to back into it.
  assert.deepEqual(result, { skipped: true, noQuestion: true, optedOut: [] })
  assert.equal(prompted, false)
  assert.match(stderr.text(), /unreadable/)
  assert.equal(await fs.readFile(storePath, 'utf8'), '{ nope')
})

// The lane's write rides the config commit (LLP 0279 #one-commit-point):
// with `deferWrite` it answers and states the split, and hands the caller
// the store write to run once the config it belongs to is on disk.
// @ref LLP 0279#one-commit-point [tests]:
test('deferWrite answers and states the split, but hands the store write back to the caller', async () => {
  const { env, stateDir } = await makeHome()
  const { prompt } = capturingPrompt(['b'])
  const { confirm } = capturingConfirm('customize')
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [descriptor('a'), descriptor('b')],
    deferWrite: true,
    prompt,
    confirm,
  }))

  assert.deepEqual(result.optedOut, ['a'])
  assert.ok(result.commit, 'the store write comes back as a commit for the caller to run')
  assert.equal(
    await fs.access(clientSyncListPath(stateDir)).then(() => true, () => false),
    false,
    'nothing is stamped until the caller commits'
  )
  assert.match(stdout.text(), /Keeping local-only: a/)

  await result.commit()
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [{ source: 'a', class: 'local-only' }])
})

// The deferred commit runs after this run's config is on disk, with the
// new-folder lane's held write, the configure phase, and the finale still
// owed. A throw there would abandon the run half-done, so it warns and
// leaves the standing store alone, exactly as the new-folder lane's
// deferred write does.
// @ref LLP 0279#one-commit-point [tests]:
test('a deferred store write that fails warns instead of aborting the run', async () => {
  const { env, stateDir } = await makeHome()
  const { prompt } = capturingPrompt(['b'])
  const { confirm } = capturingConfirm('customize')
  const stderr = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr, env,
    candidates: [descriptor('a'), descriptor('b')],
    deferWrite: true,
    prompt,
    confirm,
  }))
  // A directory where the file belongs makes the deferred write fail.
  await fs.mkdir(clientSyncListPath(stateDir), { recursive: true })

  assert.ok(result.commit)
  await result.commit()
  assert.match(stderr.text(), /could not record the sync answers/)
  assert.match(stderr.text(), /the previous sync scope stands/)
})

// The warning a failing deferred commit prints is followed by the configure
// phase and the finale, so it has scrolled away by the time the run ends.
// What survives is the set the commit reported, which the orchestrator puts
// on the finish log - so it has to be the scope that actually stands, not
// the answer the write could not keep.
// @ref LLP 0279#one-commit-point [tests]:
test('a failed deferred store write reports the sync scope still in force, not the answer', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'a', class: 'local-only' }] })
  const { prompt } = capturingPrompt(['a', 'b'])
  const { confirm } = capturingConfirm('customize')

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('a'), descriptor('b')],
    deferWrite: true,
    prompt,
    confirm,
  }))
  assert.deepEqual(result.optedOut, [], 'the answer checks both sources back on')

  // A directory where the file belongs makes the deferred write fail.
  await fs.rm(clientSyncListPath(stateDir))
  await fs.mkdir(clientSyncListPath(stateDir), { recursive: true })

  assert.ok(result.commit)
  assert.deepEqual(await result.commit(), ['a'], 'the opt-out that still stands is what is reported')
})
