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
// a multiselect where checked means "syncs" and unchecking keeps a source
// local-only. Everything is checked by default on a fresh run, locked rows
// lead read-only, and the write has editor semantics over the shown
// candidates only. The express accept auto-answers the lane and narrates the
// split instead of prompting (LLP 0201 #narrate).
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

test('a fresh enrolled express run: the accept narrates what will sync and opts nothing out', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
    autoAccept: true,
    prompt: async () => { throw new Error('the express path must not prompt') },
  }))

  assert.deepEqual(result, { optedOut: [] })
  assert.match(stdout.text(), /These will sync to your server:/)
  assert.match(stdout.text(), /capture openclaw/)
  assert.match(stdout.text(), /capture hermes/)
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [], 'the store is stamped (empty), not left absent')
})

test('the menu checks what syncs: everything checked by default on a fresh run', async () => {
  const { env, stateDir } = await makeHome()
  const { prompt, state } = capturingPrompt(['openclaw', 'hermes'])

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
    progress: 'Step 3 of 4 · Choose what syncs',
    prompt,
  }))

  assert.deepEqual(result, { optedOut: [] })
  assert.match(state.question.title, /Choose what syncs/)
  assert.match(state.question.title, /Unchecked sources stay on this machine/)
  assert.equal(state.question.progress, 'Step 3 of 4 · Choose what syncs')
  assert.ok(state.question.options.every((/** @type {any} */ o) => o.checked === true), 'default-sync: everything pre-checked on a fresh run')
  assert.equal(state.question.enterKeepsChecked, true, 'the numbered fallback must keep the checked rows on a bare enter')
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [], 'the store is stamped (empty), not left absent')
})

// The non-TTY fallback path end to end: no prompt seam, the real
// readline factory driven by scripted answers. A bare enter at the
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
  // The menu is the lane's only screen, answered with a bare enter.
  const stdout = promptDrivenOutput(input, ['\n'])

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    stdin: input,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
    // The orchestrator always offers back here (the pick lane is behind
    // this one), and the fallback's enter-hint is worded per that flag, so
    // the realistic screen is the one with it.
    allowBack: true,
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
  const stdout = promptDrivenOutput(input, ['\n'])

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
  // Only hermes stays checked; openclaw was unchecked and goes local-only.
  const { prompt } = capturingPrompt(['hermes'])
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
    prompt,
  }))

  assert.deepEqual(result, { optedOut: ['openclaw'] })
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [
    { source: 'openclaw', class: 'local-only' },
  ])
  assert.match(stdout.text(), /Keeping local-only: openclaw/)
  assert.match(stdout.text(), /hyp privacy client/)
})

test('a re-entry express run narrates both halves of the split and keeps it', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'openclaw', class: 'local-only' }] })
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
    autoAccept: true,
    prompt: async () => { throw new Error('the express path must not prompt') },
  }))

  assert.match(
    stdout.text(),
    /These will sync to your server:\n  capture hermes\nStaying local-only:\n  capture openclaw\n/,
    'a re-entry narrates both halves of the split'
  )
  assert.deepEqual(result, { optedOut: ['openclaw'] })
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [
    { source: 'openclaw', class: 'local-only' },
  ], 'the express accept round-trips the store instead of resetting it')
})

test('a re-entry renders existing opt-outs unchecked and re-checking removes them', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'openclaw', class: 'local-only' }] })
  const { prompt, state } = capturingPrompt(['openclaw'])

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw')],
    prompt,
  }))

  const row = state.question.options.find((/** @type {any} */ o) => o.value === 'openclaw')
  assert.notEqual(row.checked, true, 'the existing opt-out arrives unchecked')
  assert.deepEqual(result, { optedOut: [] })
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [], 're-checking removed the opt-out')
})

test('editor semantics: an entry for a source not shown this run is kept', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'hermes', class: 'local-only' }] })
  // openclaw is unchecked (opted out); hermes is not shown this run.
  const { prompt } = capturingPrompt([])

  await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw')],
    prompt,
  }))

  assert.deepEqual(await readClientSyncEntries({ stateDir }), [
    { source: 'hermes', class: 'local-only' },
    { source: 'openclaw', class: 'local-only' },
  ], 'the unshown hermes entry survives the openclaw-only edit')
})

// Locked (org) sources always sync (LLP 0188 #locked); the step shows them
// read-only so "choose what syncs" is the whole picture, not the editable
// slice (LLP 0190 #sync-gate).

test('locked sources lead the menu as read-only fleet-suffixed rows', async () => {
  const { env } = await makeHome()
  const { prompt, state: menu } = capturingPrompt(['claude', 'openclaw'])

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw')],
    locked: [descriptor('claude')],
    prompt,
  }))

  const lockedRow = menu.question.options[0]
  assert.equal(lockedRow.value, 'claude')
  assert.equal(lockedRow.checked, true)
  assert.equal(lockedRow.disabled, true)
  assert.match(lockedRow.label, /managed by your fleet/)
  assert.deepEqual(result, { optedOut: [] })
})

test('a locked source never enters the opt-out computation', async () => {
  const { env, stateDir } = await makeHome()
  // Only the locked claude comes back checked; the openclaw candidate was
  // unchecked and opts out - claude must not.
  const { prompt } = capturingPrompt(['claude'])

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('openclaw')],
    locked: [descriptor('claude')],
    prompt,
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
    candidatesHiddenIds: ['raw-anthropic'],
    progress: 'Step 3 of 4 · Choose what syncs',
    prompt: async () => { prompted = true; return [] },
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

// The same branch, asked of the store instead of assumed. A hidden picked
// row is addressable by 'hyp policy client raw-anthropic local-only', and
// the export seam reads exactly that store (LLP 0188 #opt-out), so with a
// standing entry the row does not ship: nothing was picked and nothing
// syncs. The sentence that says otherwise is a false promise on a
// privacy-facing screen (LLP 0188 #never-silent).
// @ref LLP 0289#ask-the-store [tests]:
test('zero visible candidates with a hidden picked row already opted out: says nothing syncs', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'raw-anthropic', class: 'local-only' }] })
  const stdout = makeBuf()
  let prompted = false

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
    lockedHidden: 0,
    candidatesHiddenIds: ['raw-anthropic'],
    progress: 'Step 3 of 4 · Choose what syncs',
    prompt: async () => { prompted = true; return [] },
  }))

  assert.deepEqual(result, { noQuestion: true, optedOut: [] })
  assert.equal(prompted, false)
  assert.match(stdout.text(), /nothing syncs to your server/)
  assert.doesNotMatch(stdout.text(), /still syncs to your server/)
  assert.doesNotMatch(stdout.text(), /raw-anthropic|Anthropic API/, 'the withheld row is never named, opted out or not')
  assert.deepEqual(
    await readClientSyncEntries({ stateDir }),
    [{ source: 'raw-anthropic', class: 'local-only' }],
    'the no-question path still writes nothing'
  )
})

// One hidden pick withheld and one standing is still capture leaving the
// machine, so the qualified sentence stands: the check is "any hidden pick
// ships", never "every one does".
// @ref LLP 0289#ask-the-store [tests]:
test('zero visible candidates with one hidden pick opted out and one standing: does not claim nothing syncs', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'raw-anthropic', class: 'local-only' }] })
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
    lockedHidden: 0,
    candidatesHiddenIds: ['raw-anthropic', 'raw-openai'],
    prompt: async () => [],
  }))

  assert.deepEqual(result, { noQuestion: true, optedOut: [] })
  assert.match(stdout.text(), /still syncs to your server/)
  assert.doesNotMatch(stdout.text(), /nothing syncs to your server/)
})

// A locked row's sentence needs no store question: the export seam drops
// opt-out entries for central-classified sources (an org row always syncs,
// LLP 0188 #locked), so a stale entry for one is inert and the fleet line
// stays unconditional.
// @ref LLP 0289#ask-the-store [tests]:
test('a stale opt-out for a hidden locked row does not soften the fleet sentence', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'raw-anthropic', class: 'local-only' }] })
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
    lockedHidden: 1,
    candidatesHiddenIds: [],
    prompt: async () => [],
  }))

  assert.deepEqual(result, { noQuestion: true, optedOut: [] })
  assert.match(stdout.text(), /capture your fleet manages directly still syncs to your server/)
})

// The fifth no-question fact, and the residual LLP 0276 left open: a visible
// org row and a hidden carried pick standing at the same time. The fleet row
// is real, so the screen still names it - but the carried row composes into
// the *local* layer, so "everything you picked is managed by your fleet"
// would hand the fleet an owner's claim over capture it does not own.
// @ref LLP 0281#visible-org-row [tests]:
test('zero visible candidates with an org row and a hidden picked row: the fleet sentence covers only its own rows', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()
  let prompted = false

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [descriptor('claude')],
    lockedHidden: 0,
    candidatesHiddenIds: ['raw-anthropic'],
    progress: 'Step 3 of 4 · Choose what syncs',
    prompt: async () => { prompted = true; return [] },
  }))

  assert.deepEqual(result, { noQuestion: true, optedOut: [] })
  assert.equal(prompted, false)
  assert.match(stdout.text(), /Step 3 of 4 · Choose what syncs/)
  // The org row is still named, under a sentence scoped to it alone.
  assert.match(stdout.text(), /Your fleet manages these and they always sync:/)
  assert.match(stdout.text(), /capture claude/)
  // The claim that broke: the hidden pick is not the fleet's, so nothing may
  // say the fleet manages everything picked.
  assert.doesNotMatch(stdout.text(), /Everything you picked is managed by your fleet/)
  // And the hidden pick is disclosed as a fact without being named.
  assert.match(stdout.text(), /Capture already set up on this machine also syncs to your server\./)
  assert.doesNotMatch(stdout.text(), /raw-anthropic|Anthropic API/, 'the withheld row is still never named')
  assert.equal(await readClientSyncEntries({ stateDir }), null, 'no store write on the no-question path')
})

// The unchanged case, pinned beside it: with no hidden pick standing the
// exhaustive sentence is true and stays.
// @ref LLP 0281#visible-org-row [tests]:
test('zero visible candidates with an org row and no hidden pick: keeps the exhaustive fleet sentence', async () => {
  const { env } = await makeHome()
  const stdout = makeBuf()

  await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [descriptor('claude')],
    lockedHidden: 0,
    candidatesHiddenIds: [],
    prompt: async () => [],
  }))

  assert.match(stdout.text(), /Everything you picked is managed by your fleet and always syncs\./)
  assert.doesNotMatch(stdout.text(), /also syncs to your server/)
})

// The two claims on this branch answer to different authorities. An opt-out
// entry settles whether the machine's own capture *ships*, so the second
// line goes; it does not make the withheld row the fleet's, so the fleet
// sentence stays narrowed to the rows the fleet owns (LLP 0281
// #visible-org-row). The store is not a licence to re-acquire an owner's
// claim this branch gave up.
// @ref LLP 0289#ask-the-store [tests]:
test('zero visible candidates with an org row and a hidden pick already opted out: drops the sync line, keeps the narrowed fleet sentence', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'raw-anthropic', class: 'local-only' }] })
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [descriptor('claude')],
    lockedHidden: 0,
    candidatesHiddenIds: ['raw-anthropic'],
    prompt: async () => [],
  }))

  assert.deepEqual(result, { noQuestion: true, optedOut: [] })
  // The store answered the shipping question, so the export promise goes.
  assert.doesNotMatch(stdout.text(), /also syncs to your server/)
  // It did not answer the ownership question, so this one may not come back.
  assert.doesNotMatch(stdout.text(), /Everything you picked is managed by your fleet/)
  assert.match(stdout.text(), /Your fleet manages these and they always sync:/)
  assert.match(stdout.text(), /capture claude/)
  assert.doesNotMatch(stdout.text(), /raw-anthropic|Anthropic API/, 'the withheld row is never named, opted out or not')
})

test('a cancelled menu returns cancelled and writes nothing', async () => {
  const { env, stateDir } = await makeHome()
  const stderr = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr, env,
    candidates: [descriptor('openclaw')],
    prompt: async () => { throw new PromptCancelledError() },
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
  }))

  // Skipped and unasked: the lane after it must not try to back into it.
  assert.deepEqual(result, { skipped: true, noQuestion: true, optedOut: [] })
  assert.equal(prompted, false)
  assert.match(stderr.text(), /unreadable/)
  assert.equal(await fs.readFile(storePath, 'utf8'), '{ nope')
})
