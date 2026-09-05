// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runInitWizard } from '../../../../src/core/cli/wizard/index.js'
import { runWizardJoin } from '../../../../src/core/cli/wizard/join.js'
import { WIZARD_STEP_LABELS, wizardItinerary, wizardStepProgress } from '../../../../src/core/cli/wizard/steps.js'
import { runWizardSyncScope } from '../../../../src/core/cli/wizard/sync_scope.js'
import { defaultPromptFactory, runPickerFinale } from '../../../../src/core/cli/walkthrough.js'
import { render } from '../../../../src/core/cli/tui/render.js'

// The wizard's position indicator (LLP 0135 #progress): the denominator is
// resolved once the pathway is committed, only prompt lanes are counted, and
// the fork itself never carries a counter because the pathway that fixes the
// total is exactly what the fork is asking for.
// @ref LLP 0135#progress [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-wizard-progress-'))
}

/** Minimal empty catalog so the orchestrator never discovers real plugins. */
function emptyCatalog() {
  return /** @type {any} */ ({
    plugins: new Map(),
    pluginMetadata: new Map(),
    knownDatasets: new Set(),
    clientDescriptors: new Map(),
    pickerDescriptors: new Map(),
  })
}

/** A completed pick result the finale and configure stubs can consume. */
function pickResult() {
  return /** @type {any} */ ({
    exitCode: 0,
    configPath: '/tmp/x/config.json',
    config: { version: 2, plugins: [] },
    sourcesPicked: ['claude'],
    exportPicked: 'local-parquet',
    clientsPicked: ['claude'],
    retentionDays: 30,
    descriptors: [],
    lockedSources: [],
  })
}

/**
 * Wizard options with every phase scripted, recording the options each
 * phase was handed so the breadcrumb threading can be asserted directly.
 *
 * @param {string} home
 * @param {Record<string, any>} over
 */
function wizardOpts(home, over = {}) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {Record<string, any>} */
  const seen = {}
  const opts = /** @type {any} */ ({
    stdout,
    stderr,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_NO_TUI: '1' },
    ctx: /** @type {any} */ ({ commands: { run: async () => 0 } }),
    capabilities: /** @type {any} */ ({ has: () => false }),
    catalog: emptyCatalog(),
    finale: {},
    gate: async () => ({ action: 'first-run', managed: false, report: {} }),
    fork: async (/** @type {any} */ o) => { seen.fork = o; return 'local' },
    // Positions are what these tests read, and an express run states none
    // (LLP 0201): decline the gate so every lane counts.
    express: async (/** @type {any} */ o) => { seen.express = o; return 'choose' },
    join: async (/** @type {any} */ o) => { seen.join = o; return { status: 'ok', lockedSources: [], managed: true } },
    pick: async (/** @type {any} */ o) => { seen.pick = o; return pickResult() },
    configure: async () => ({ results: [] }),
    finaleRunner: async (/** @type {any} */ a) => {
      seen.finale = a
      return {
        daemonInstall: { skipped: true, dryRun: false },
        globalInstall: { skipped: true, installed: false },
        attach: [],
        skillsInstalled: [],
        agentsInstalled: [],
        daemonRestart: { skipped: true, dryRun: false, ok: false },
        backfill: [],
      }
    },
    ...over,
  })
  return { opts, stdout, stderr, seen }
}

// --- the step vocabulary ---

test('wizardStepProgress: the team pathway counts join, pick, sync, folders and finale', async () => {
  assert.deepEqual(wizardItinerary('team'), ['join', 'pick', 'sync', 'folders', 'finale'])
  assert.equal(wizardStepProgress('team', 'join'), 'Step 1 of 5 · Join your team')
  assert.equal(wizardStepProgress('team', 'pick'), 'Step 2 of 5 · Choose what to collect')
  assert.equal(wizardStepProgress('team', 'sync'), 'Step 3 of 5 · Choose what syncs')
  // The new-folder question is its own lane (LLP 0200 #wizard): the sync
  // lane answers which adapters ship, this one answers what happens the
  // next time the user works somewhere new.
  assert.equal(wizardStepProgress('team', 'folders'), 'Step 4 of 5 · Choose how new folders are handled')
  assert.equal(wizardStepProgress('team', 'finale'), 'Step 5 of 5 · Finish setup')
})

test('wizardStepProgress: the local pathway counts two steps', async () => {
  assert.deepEqual(wizardItinerary('local'), ['pick', 'finale'])
  assert.equal(wizardStepProgress('local', 'pick'), `Step 1 of 2 · ${WIZARD_STEP_LABELS.pick}`)
  assert.equal(wizardStepProgress('local', 'finale'), `Step 2 of 2 · ${WIZARD_STEP_LABELS.finale}`)
  // A lane the pathway never runs has no position to report.
  assert.equal(wizardStepProgress('local', 'join'), undefined)
  assert.equal(wizardStepProgress('local', 'sync'), undefined)
  assert.equal(wizardStepProgress('local', 'folders'), undefined)
})

test('wizardStepProgress: a managed machine on the local pathway gains both enrolled lanes (LLP 0188, LLP 0200)', async () => {
  assert.deepEqual(wizardItinerary('local', { managed: true }), ['pick', 'sync', 'folders', 'finale'])
  assert.equal(wizardStepProgress('local', 'pick', { managed: true }), 'Step 1 of 4 · Choose what to collect')
  assert.equal(wizardStepProgress('local', 'sync', { managed: true }), 'Step 2 of 4 · Choose what syncs')
  assert.equal(wizardStepProgress('local', 'folders', { managed: true }), 'Step 3 of 4 · Choose how new folders are handled')
  assert.equal(wizardStepProgress('local', 'finale', { managed: true }), 'Step 4 of 4 · Finish setup')
})

// A question lane keeps its place in the total and states its position on
// the machine where it turns out to have nothing to ask (LLP 0338
// #counts-anyway). The sync lane on a fully fleet-managed machine is the
// shipped instance: everything picked is the fleet's, so it states that
// and asks nothing. Pinned by rendering the real lane, because the
// alternatives this decision rejected - dropping the lane from the total,
// or blanking its position line - are both invisible in `steps.js` and
// only show up on the screen.
// @ref LLP 0338#counts-anyway [tests]: a lane with no question still prints its position above the statement it makes instead
test('the sync lane states its position even when it has nothing to ask', async () => {
  const stdout = makeBuf()
  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout,
    stderr: makeBuf(),
    env: { HYP_HOME: await tmpHome(), HYP_NO_TUI: '1' },
    candidates: [],
    locked: [{ id: 'claude', label: 'Claude Code' }],
    lockedHidden: 0,
    candidatesHiddenIds: [],
    progress: 'Step 3 of 5 · Choose what syncs',
    // The lane's prompt seam is `prompt`, not `confirm`: a guard on the
    // wrong field is inert, and a regression in the no-candidates arm
    // would reach the real stdin instead of failing here.
    prompt: async () => { throw new Error('a fully fleet-managed machine has nothing to ask') },
  }))

  assert.equal(result.noQuestion, true, 'the lane asked nothing')
  const lines = stdout.text().split('\n').filter((l) => l !== '')
  // The position line, and then the statement that corrects what the
  // label promised, in the same frame at the first moment it is knowable.
  assert.deepEqual(lines, [
    'Step 3 of 5 · Choose what syncs',
    'Everything you picked is managed by your fleet and always syncs.',
    '  Claude Code',
  ], stdout.text())
})

// The other half of the same decision: the lane keeps its place in the
// total, not just its line. `wizardItinerary` takes the pathway and
// `managed` and nothing else, and hands back a list no caller can edit,
// so there is no seam through which a lane's emptiness could reach the
// denominator - which is the point, since the sync lane's candidates are
// the pick lane's result and the pick lane runs after the fork has fixed
// the total (LLP 0338 #counts-anyway).
// @ref LLP 0338#counts-anyway [tests]: the denominator is a function of the pathway alone, so an empty lane never leaves it
test('wizardItinerary: no lane emptiness can reach the denominator', async () => {
  // Every shape a lane's emptiness could arrive in, offered to the
  // function at once. A future seam that read any of them - a candidate
  // list, a `noQuestion` flag, a pick result - would drop `sync` from the
  // total here, which is what this asserts cannot happen. Asserting only
  // over `managed` would not: it passes just as well against a function
  // that grew the seam, because nothing would be passing through it.
  const emptiness = /** @type {any} */ ({
    managed: true,
    syncEmpty: true,
    noQuestion: true,
    candidates: [],
    picked: { descriptors: [] },
  })
  const forEveryMachine = [
    wizardItinerary('team'),
    wizardItinerary('team', {}),
    wizardItinerary('team', { managed: true }),
    wizardItinerary('team', { managed: false }),
    wizardItinerary('team', emptiness),
  ]
  for (const itinerary of forEveryMachine) {
    assert.deepEqual(itinerary, ['join', 'pick', 'sync', 'folders', 'finale'])
  }
  assert.equal(wizardStepProgress('team', 'sync'), 'Step 3 of 5 · Choose what syncs')
  assert.equal(wizardStepProgress('team', 'folders'), 'Step 4 of 5 · Choose how new folders are handled')
  assert.equal(wizardStepProgress('team', 'sync', emptiness), 'Step 3 of 5 · Choose what syncs')
  assert.equal(
    wizardStepProgress('team', 'folders', emptiness),
    'Step 4 of 5 · Choose how new folders are handled'
  )

  // The other pathway that runs the lane, because it reaches it by the
  // other route: `team` reads the sync lane off the table, a managed
  // `local` run splices it in beside `pick`. A seam grown on that arm
  // alone leaves every assertion above green, so the emptiness has to
  // bounce off both routes and not just the one the shipped instance was
  // rendered on.
  for (const itinerary of [
    wizardItinerary('local', { managed: true }),
    wizardItinerary('local', emptiness),
  ]) {
    assert.deepEqual(itinerary, ['pick', 'sync', 'folders', 'finale'])
  }
  assert.equal(wizardStepProgress('local', 'sync', emptiness), 'Step 2 of 4 · Choose what syncs')
  assert.equal(
    wizardStepProgress('local', 'folders', emptiness),
    'Step 3 of 4 · Choose how new folders are handled'
  )

  // An options bag cannot see the last seam: the returned list itself. It
  // used to be the module's own array, so a caller that spliced a lane out
  // of what it was handed moved the total for every lane after it, with
  // nothing passing through an argument at all.
  const handed = wizardItinerary('team')
  handed.splice(2, 1)
  assert.deepEqual(
    wizardItinerary('team'),
    ['join', 'pick', 'sync', 'folders', 'finale'],
    'the itinerary a caller was handed is not the one the next caller gets'
  )
})

test('wizardStepProgress: an uncommitted pathway has no denominator', async () => {
  assert.equal(wizardStepProgress(undefined, 'pick'), undefined)
  assert.deepEqual(wizardItinerary(undefined), [])
})

// --- orchestrator threading ---

test('runInitWizard: the local pathway reads step 1 of 2 then step 2 of 2', async () => {
  const { opts, seen } = wizardOpts(await tmpHome())
  const result = await runInitWizard(opts)
  assert.equal(result.pathway, 'local')
  assert.equal(seen.pick.progress, 'Step 1 of 2 · Choose what to collect')
  assert.equal(seen.finale.progress, 'Step 2 of 2 · Finish setup')
})

test('runInitWizard: the team pathway reads step 1/2/3/4/5 across join, pick, sync, folders and finale', async () => {
  const { opts, seen } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    syncScope: async (/** @type {any} */ o) => { seen.sync = o; return { optedOut: [] } },
    folderAsk: async (/** @type {any} */ o) => { seen.folders = o; return { mode: 'sync' } },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.pathway, 'team')
  assert.equal(seen.join.progress, 'Step 1 of 5 · Join your team')
  assert.equal(seen.pick.progress, 'Step 2 of 5 · Choose what to collect')
  assert.equal(seen.sync.progress, 'Step 3 of 5 · Choose what syncs')
  assert.equal(seen.folders.progress, 'Step 4 of 5 · Choose how new folders are handled')
  assert.equal(seen.finale.progress, 'Step 5 of 5 · Finish setup')
})

test('runInitWizard: the fork never carries a counter, before or after a failed join', async () => {
  let forks = 0
  const { opts, seen } = wizardOpts(await tmpHome(), {
    fork: async (/** @type {any} */ o) => {
      forks += 1
      seen.fork = o
      return forks === 1 ? 'team' : 'local'
    },
    join: async (/** @type {any} */ o) => { seen.join = o; return { status: 'failed', detail: 'nope' } },
  })
  const result = await runInitWizard(opts)
  assert.equal(forks, 2)
  assert.equal(result.pathway, 'local')
  // The fork is the question that fixes the total, so it can never state one.
  assert.equal(seen.fork.progress, undefined)
  // The retry lands on the local pathway: the counter states that pathway's
  // total, not the abandoned team one.
  assert.equal(seen.pick.progress, 'Step 1 of 2 · Choose what to collect')
  assert.equal(seen.finale.progress, 'Step 2 of 2 · Finish setup')
})

// A managed machine's Reconfigure runs the fork like any other (LLP
// 0182), so its counter is the fork's answer, not a pathway of its own -
// but being managed adds the sync lane to that pathway's count (LLP 0188).
test('runInitWizard: a managed re-entry counts the pathway the fork returns, plus both enrolled lanes', async () => {
  const { opts, seen } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    // Stay connected at the disconnect question (LLP 0190 #fork-disconnect).
    confirm: async () => 'stay',
    syncScope: async (/** @type {any} */ o) => { seen.sync = o; return { optedOut: [] } },
    folderAsk: async (/** @type {any} */ o) => { seen.folders = o; return { mode: 'sync' } },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.pathway, 'local')
  assert.equal(seen.fork.progress, undefined)
  assert.equal(seen.pick.progress, 'Step 1 of 4 · Choose what to collect')
  assert.equal(seen.sync.progress, 'Step 2 of 4 · Choose what syncs')
  assert.equal(seen.folders.progress, 'Step 3 of 4 · Choose how new folders are handled')
  assert.equal(seen.finale.progress, 'Step 4 of 4 · Finish setup')
})

test('runInitWizard: a non-interactive run carries no breadcrumb anywhere', async () => {
  const { opts, stdout, seen } = wizardOpts(await tmpHome(), {
    picks: { sources: ['claude'], exportChoice: 'local-parquet', retentionDays: 30 },
  })
  await runInitWizard(opts)
  assert.equal(seen.pick.progress, undefined)
  assert.equal(seen.finale.progress, undefined)
  assert.ok(!stdout.text().includes('Step '), stdout.text())
})

// --- the phases that render it ---

test('runWizardJoin: prints its position above the joining narration', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()
  await runWizardJoin(/** @type {any} */ ({
    stdout,
    stderr,
    env: {},
    catalog: { pickerDescriptors: new Map(), clientDescriptors: new Map() },
    progress: 'Step 1 of 3 · Join your team',
    runLogin: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    waitForConverge: async () => ({ ok: false }),
  }))
  // The position line names the lane, so the plain sentence is not repeated under it.
  assert.equal(stdout.text().startsWith('Step 1 of 3 · Join your team\n'), true, stdout.text())
  assert.doesNotMatch(stdout.text(), /Joining your team\.\.\./)
})

test('runWizardJoin: without a position it narrates exactly as it does today', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()
  await runWizardJoin(/** @type {any} */ ({
    stdout,
    stderr,
    env: {},
    catalog: { pickerDescriptors: new Map(), clientDescriptors: new Map() },
    runLogin: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    waitForConverge: async () => ({ ok: false }),
  }))
  assert.equal(stdout.text().startsWith('Joining your team...\n'), true, stdout.text())
})

/**
 * The finale with every action skipped: enough to prove the lane prints
 * its own position line, without installing or attaching anything.
 *
 * @param {{ write(chunk: string): unknown, text(): string }} stdout
 * @param {Record<string, unknown>} over
 */
function finaleArgs(stdout, over = {}) {
  return /** @type {any} */ ({
    finale: { skipDaemon: true, skipDaemonInstall: true, skipRestart: true },
    clientsPicked: [],
    capabilities: /** @type {any} */ ({ has: () => false }),
    config: { version: 2, plugins: [] },
    configPath: '/tmp/x/config.json',
    env: { HOME: '/tmp/x' },
    stdout,
    stderr: makeBuf(),
    retentionDays: 30,
    interactive: true,
    ...over,
  })
}

test('runPickerFinale: states its position once, where the lane starts', async () => {
  const stdout = makeBuf()
  await runPickerFinale(finaleArgs(stdout, { progress: 'Step 2 of 2 · Finish setup' }))
  assert.equal(stdout.text().startsWith('Step 2 of 2 · Finish setup\n'), true, stdout.text())
  // Once, not once per action inside the lane.
  assert.equal(stdout.text().split('Step 2 of 2').length - 1, 1, stdout.text())
})

test('runPickerFinale: without a position it writes exactly what it writes today', async () => {
  const withProgress = makeBuf()
  const without = makeBuf()
  await runPickerFinale(finaleArgs(withProgress, { progress: 'Step 2 of 2 · Finish setup' }))
  await runPickerFinale(finaleArgs(without))
  assert.equal(
    withProgress.text(),
    'Step 2 of 2 · Finish setup\n' + without.text(),
    without.text()
  )
})

test('the legacy numbered picker prompt prints the breadcrumb as plain text', async () => {
  const stdout = makeBuf()
  const stdin = /** @type {any} */ ({
    on() {}, once() {}, removeListener() {}, resume() {}, pause() {}, read() { return null },
  })
  const ask = defaultPromptFactory(/** @type {any} */ ({
    stdin,
    stdout,
    env: { HYP_NO_TUI: '1' },
  }))
  // The question is never answered: the prompt's own output is what is
  // under test, so the pending promise is abandoned after one tick.
  const pending = ask(/** @type {any} */ ({
    pickType: 'sources',
    title: 'What do you want to collect?',
    progress: 'Step 1 of 2 · Choose what to collect',
    options: [{ value: 'claude', label: 'Claude' }],
  }))
  pending.catch(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  const text = stdout.text()
  assert.ok(text.includes('Step 1 of 2 · Choose what to collect'), text)
  assert.ok(text.indexOf('Step 1 of 2') < text.indexOf('What do you want to collect?'), text)
})

test('render: the breadcrumb is its own line above the title, never folded into it', async () => {
  const frame = render(
    /** @type {any} */ ({
      kind: 'multiselect',
      title: 'What do you want to collect?',
      progress: 'Step 1 of 2 · Choose what to collect',
      options: [{ value: 'claude', label: 'Claude', checked: false }],
      cursor: 0,
      status: 'active',
    }),
    { color: false }
  )
  const lines = frame.split('\n')
  assert.equal(lines[0], 'Step 1 of 2 · Choose what to collect')
  assert.equal(lines[1], 'What do you want to collect?')
})

test('render: a spec without a breadcrumb renders exactly as it does today', async () => {
  const base = /** @type {any} */ ({
    kind: 'select',
    title: 'Pick one',
    options: [{ value: 'a', label: 'A' }],
    cursor: 0,
    status: 'active',
  })
  assert.equal(render(base, { color: false }).split('\n')[0], 'Pick one')
})
