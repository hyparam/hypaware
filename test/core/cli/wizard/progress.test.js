// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runInitWizard } from '../../../../src/core/cli/wizard/index.js'
import { runWizardJoin } from '../../../../src/core/cli/wizard/join.js'
import { WIZARD_STEP_LABELS, wizardItinerary, wizardStepProgress } from '../../../../src/core/cli/wizard/steps.js'
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

test('wizardStepProgress: the team pathway counts join, pick, sync and finale', async () => {
  assert.deepEqual(wizardItinerary('team'), ['join', 'pick', 'sync', 'finale'])
  assert.equal(wizardStepProgress('team', 'join'), 'Step 1 of 4 · Join your team')
  assert.equal(wizardStepProgress('team', 'pick'), 'Step 2 of 4 · Choose what to collect')
  assert.equal(wizardStepProgress('team', 'sync'), 'Step 3 of 4 · Choose what syncs')
  assert.equal(wizardStepProgress('team', 'finale'), 'Step 4 of 4 · Finish setup')
})

test('wizardStepProgress: the local pathway counts two steps', async () => {
  assert.deepEqual(wizardItinerary('local'), ['pick', 'finale'])
  assert.equal(wizardStepProgress('local', 'pick'), `Step 1 of 2 · ${WIZARD_STEP_LABELS.pick}`)
  assert.equal(wizardStepProgress('local', 'finale'), `Step 2 of 2 · ${WIZARD_STEP_LABELS.finale}`)
  // A lane the pathway never runs has no position to report.
  assert.equal(wizardStepProgress('local', 'join'), undefined)
  assert.equal(wizardStepProgress('local', 'sync'), undefined)
})

test('wizardStepProgress: a managed machine on the local pathway gains the sync lane (LLP 0181)', async () => {
  assert.deepEqual(wizardItinerary('local', { managed: true }), ['pick', 'sync', 'finale'])
  assert.equal(wizardStepProgress('local', 'pick', { managed: true }), 'Step 1 of 3 · Choose what to collect')
  assert.equal(wizardStepProgress('local', 'sync', { managed: true }), 'Step 2 of 3 · Choose what syncs')
  assert.equal(wizardStepProgress('local', 'finale', { managed: true }), 'Step 3 of 3 · Finish setup')
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

test('runInitWizard: the team pathway reads step 1/2/3/4 across join, pick, sync and finale', async () => {
  const { opts, seen } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    syncScope: async (/** @type {any} */ o) => { seen.sync = o; return { optedOut: [] } },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.pathway, 'team')
  assert.equal(seen.join.progress, 'Step 1 of 4 · Join your team')
  assert.equal(seen.pick.progress, 'Step 2 of 4 · Choose what to collect')
  assert.equal(seen.sync.progress, 'Step 3 of 4 · Choose what syncs')
  assert.equal(seen.finale.progress, 'Step 4 of 4 · Finish setup')
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
// but being managed adds the sync lane to that pathway's count (LLP 0181).
test('runInitWizard: a managed re-entry counts the pathway the fork returns, plus the sync lane', async () => {
  const { opts, seen } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    // Stay connected at the disconnect question (LLP 0185 #fork-disconnect).
    confirm: async () => 'stay',
    syncScope: async (/** @type {any} */ o) => { seen.sync = o; return { optedOut: [] } },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.pathway, 'local')
  assert.equal(seen.fork.progress, undefined)
  assert.equal(seen.pick.progress, 'Step 1 of 3 · Choose what to collect')
  assert.equal(seen.sync.progress, 'Step 2 of 3 · Choose what syncs')
  assert.equal(seen.finale.progress, 'Step 3 of 3 · Finish setup')
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
    waitForConverge: async () => ({ ok: false, attached: [] }),
  }))
  assert.equal(
    stdout.text().startsWith('Step 1 of 3 · Join your team\nJoining your team...\n'),
    true,
    stdout.text()
  )
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
    waitForConverge: async () => ({ ok: false, attached: [] }),
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
