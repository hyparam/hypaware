// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { firstLookHadRows, runInitWizard } from '../../../../src/core/cli/wizard/index.js'
import { writeFirstSyncHoldMarker } from '../../../../src/core/usage-policy/first_sync_hold.js'
import { writeClientSyncEntries } from '../../../../src/core/usage-policy/client_sync.js'
import { runWizardSyncScope } from '../../../../src/core/cli/wizard/sync_scope.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { OVERVIEW_PROBE_SQL } from '../../../../src/core/query/overview.js'
import { SUGGESTED_PROMPTS } from '../../../../src/core/cli/wizard/first_ask.js'

// The wizard orchestrator (LLP 0135 #orchestration): gate short-circuits,
// the fork/join loop, phase threading (locked/managed), the
// non-interactive short-circuit, and the cancel/refusal exits. Phases are
// scripted through the test seams; each phase's own behavior is covered by
// its sibling test file.
// @ref LLP 0129#failed-join-returns-to-fork [tests]:
// @ref LLP 0129#returning-gate [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-wizard-index-'))
}

/**
 * A catalog with one picker row plus a detector that finds it, so the
 * express gate (LLP 0201) has rows to list. With nothing detected and
 * nothing locked the gate is skipped entirely, which is what
 * `emptyCatalog` gives.
 */
function detectableCatalog() {
  const catalog = emptyCatalog()
  catalog.pickerDescriptors.set('claude', { plugin: '@hypaware/claude', id: 'claude', label: 'Claude Code' })
  return catalog
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

/**
 * Write a central layer (the join seed slot, LLP 0031) under a wizard
 * home, so the locked-set computation resolves it from disk exactly as it
 * does on a real enrolled machine.
 *
 * @param {string} home
 * @param {string[]} plugins
 */
async function seedCentralLayer(home, plugins) {
  const control = path.join(home, '.hyp', 'hypaware', 'config-control')
  await fs.mkdir(control, { recursive: true })
  const config = { version: 2, plugins: plugins.map((name) => ({ name, enabled: true, config: {} })) }
  await fs.writeFile(path.join(control, 'seed.json'), JSON.stringify(config))
}

/** A completed pick result the finale and configure stubs can consume. */
function pickResult(over = {}) {
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
    ...over,
  })
}

/**
 * Base options: every phase scripted, recording calls. Tests override the
 * phases they exercise.
 *
 * @param {string} home
 * @param {Record<string, any>} over
 */
function wizardOpts(home, over = {}) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {string[]} */
  const calls = []
  const opts = /** @type {any} */ ({
    stdout,
    stderr,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_NO_TUI: '1' },
    ctx: /** @type {any} */ ({ commands: { run: async () => 0 } }),
    capabilities: /** @type {any} */ ({ has: () => false }),
    catalog: emptyCatalog(),
    finale: {},
    gate: async () => ({ action: 'first-run', managed: false, report: {} }),
    fork: async () => 'local',
    join: async () => ({ status: 'ok', lockedSources: [], managed: true }),
    pick: async (/** @type {any} */ o) => { opts._pickOpts = o; return pickResult() },
    syncScope: async (/** @type {any} */ o) => { opts._syncOpts = o; return { optedOut: [] } },
    folderAsk: async (/** @type {any} */ o) => { opts._folderOpts = o; return { mode: 'sync' } },
    // The express gate (LLP 0201) fronts the lanes on every attended run
    // with default rows; these tests exercise the step-by-step path, so it
    // declines by default.
    express: async (/** @type {any} */ o) => { opts._expressOpts = o; return 'choose' },
    configure: async () => ({ results: [] }),
    finaleRunner: async (/** @type {any} */ args) => {
      opts._finaleArgs = args
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
  // Record phase invocations regardless of which stub a test supplied, so
  // ordering assertions hold for overridden phases too.
  for (const name of ['gate', 'fork', 'join', 'pick', 'syncScope', 'folderAsk', 'configure']) {
    const inner = opts[name]
    opts[name] = async (/** @type {any[]} */ ...a) => { calls.push(name); return inner(...a) }
  }
  const innerFinale = opts.finaleRunner
  opts.finaleRunner = async (/** @type {any} */ a) => { calls.push('finale'); return innerFinale(a) }
  return { opts, stdout, stderr, calls }
}

// --- returning gate short-circuits ---

test('runInitWizard: gate quit exits 0 without running any phase', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'quit', managed: false, report: {} }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(calls, ['gate'])
})

test('runInitWizard: gate status delegates to runStatus and returns its code', async () => {
  let statusRan = false
  const { opts, calls } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'status', managed: false, report: {} }),
    runStatus: async () => { statusRan = true; return 7 },
  })
  const result = await runInitWizard(opts)
  assert.equal(statusRan, true)
  assert.equal(result.exitCode, 7)
  assert.deepEqual(calls, ['gate'])
})

// A managed machine reconfigures through the same fork as anyone else
// (LLP 0182). What being managed still buys is the locked set and the
// `managed` flag the picker labels its rows from - not a pathway.
// @ref LLP 0182#one-reconfigure [tests]:
test('runInitWizard: a managed machine reconfigures through the fork, carrying managed into the picker', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    confirm: async () => 'stay',
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.ok(calls.includes('fork'))
  assert.equal(opts._pickOpts.managed, true)
  assert.equal(result.pathway, 'local')
})

// LLP 0137 #pathway-defaults keys the 120-day window on the cache being
// the only copy of history. A managed machine has an org server holding
// the durable copy, so it takes the 90-day default even when its
// Reconfigure walks down the local pathway.
test('runInitWizard: a managed machine on the local pathway keeps the 90-day default, not the local 120', async () => {
  const { opts } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    confirm: async () => 'stay',
  })
  await runInitWizard(opts)
  assert.equal(opts._pickOpts.retentionDefault, undefined)
})

// A managed machine choosing local is asked once whether it means
// "disconnect" or "adjust while staying connected" (LLP 0190
// #fork-disconnect). Yes runs hyp leave; no and cancel keep enrollment.
// @ref LLP 0190#fork-disconnect [tests]:

test('runInitWizard: managed + local + stay connected keeps the locked rows and the sync lane', async () => {
  let leaveRan = false
  const { opts, calls } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    confirm: async () => 'stay',
    leave: async () => { leaveRan = true; return 0 },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(leaveRan, false)
  assert.equal(opts._pickOpts.managed, true)
  assert.ok(calls.includes('syncScope'), 'still enrolled, so the sync lane still runs')
})

test('runInitWizard: managed + local + disconnect runs hyp leave and continues as a solo install', async () => {
  let leaveRan = false
  const { opts, calls } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    confirm: async () => 'disconnect',
    leave: async () => { leaveRan = true; return 0 },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(leaveRan, true)
  assert.equal(opts._pickOpts.managed, undefined, 'no longer managed after the teardown')
  assert.equal(opts._pickOpts.locked, undefined, 'no rows left to lock')
  assert.equal(opts._pickOpts.retentionDefault, 120, 'a solo machine takes the local retention default')
  assert.ok(!calls.includes('syncScope'), 'no server left to scope syncing for')
})

test('runInitWizard: a failed hyp leave returns to the fork still connected', async () => {
  const forkChoices = ['local', 'quit']
  const { opts, calls, stderr } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    fork: async () => forkChoices.shift(),
    confirm: async () => 'disconnect',
    leave: async () => 1,
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(calls.filter((c) => c === 'fork').length, 2, 'the fork is re-presented')
  assert.ok(!calls.includes('pick'), 'the quit ended the run before any phase')
  assert.match(stderr.text(), /still connected/)
})

// Ctrl+C at the disconnect question ends the run: it shares the prompt
// with the escape that steps back, but not its handling. Re-presenting the
// fork made "get me out" the first of two keystrokes, which is what
// LLP 0191 #esc-back separates ctrl+c from escape to avoid. Nothing is
// disconnected either way, which is all LLP 0190 #fork-disconnect asks of
// a cancel.
// @ref LLP 0191#esc-back [tests]: ctrl+c at the disconnect question cancels the run rather than stepping back
test('runInitWizard: cancelling the disconnect question ends the run without disconnecting', async () => {
  const { PromptCancelledError } = await import('../../../../src/core/cli/tui/runtime.js')
  const forkChoices = ['local', 'quit']
  let leaveRan = false
  const { opts, calls, stderr } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    fork: async () => forkChoices.shift(),
    confirm: async () => { throw new PromptCancelledError() },
    leave: async () => { leaveRan = true; return 0 },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 130)
  assert.equal(result.cancelled, true)
  assert.equal(leaveRan, false, 'a cancel never disconnects')
  assert.equal(calls.filter((c) => c === 'fork').length, 1, 'the fork is not re-presented')
  assert.ok(!calls.includes('pick'), 'the cancel ended the run before any phase')
  assert.match(stderr.text(), /hyp setup: cancelled/)
})

test('runInitWizard: an unmanaged machine choosing local is never asked about disconnecting', async () => {
  let confirmAsked = false
  const { opts } = wizardOpts(await tmpHome(), {
    confirm: async () => { confirmAsked = true; return 'stay' },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(confirmAsked, false, 'nothing to disconnect from')
})

test('runInitWizard: a managed machine can still re-join a team from the gate', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    fork: async () => 'team',
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.ok(calls.includes('join'))
  assert.equal(result.pathway, 'team')
})

// A managed machine whose merged config no longer validates falls to the
// first-run path, but the central layer on disk still owns its rows. The
// locked set has to be computed there too, or the picker offers the org's
// rows for free composition into the local layer.
// @ref LLP 0129#join-before-picker [tests]:
test('runInitWizard: a managed first run locks the org rows from the on-disk central layer', async () => {
  const home = await tmpHome()
  await seedCentralLayer(home, ['@hypaware/claude'])
  const catalog = emptyCatalog()
  catalog.pickerDescriptors.set('claude', { plugin: '@hypaware/claude', id: 'claude', label: 'Claude' })
  const { opts } = wizardOpts(home, {
    catalog,
    gate: async () => ({ action: 'first-run', managed: true, report: {} }),
    confirm: async () => 'stay',
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(opts._pickOpts.locked, ['claude'])
  assert.equal(opts._pickOpts.managed, true)
})

// --- the fork/join loop ---

// --- the sync-scope step (LLP 0188 #never-silent) ---

// The express gate (LLP 0201): one yes before the lanes accepts every
// lane's stated default. The lanes still run - they narrate instead of
// prompting - so nothing is skipped except the keypresses.
// @ref LLP 0201#gate [tests]:

test('runInitWizard: accepting the express gate auto-accepts every lane and states no positions', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    catalog: detectableCatalog(),
    detect: async () => new Set(['claude']),
    express: async (/** @type {any} */ o) => { opts._expressOpts = o; return 'defaults' },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  // Every lane still runs, in order: the gate answers them, it does not
  // remove them.
  assert.deepEqual(calls, ['gate', 'fork', 'join', 'pick', 'syncScope', 'folderAsk', 'configure', 'finale'])
  assert.equal(opts._pickOpts.autoAccept, true)
  assert.equal(opts._syncOpts.autoAccept, true)
  assert.equal(opts._folderOpts.autoAccept, true)
  assert.equal(opts._expressOpts.enrolled, true, 'the gate is told whether it can promise anything about a server')
  // No lane is answering anything, so no lane states a position.
  assert.equal(opts._pickOpts.progress, undefined)
  assert.equal(opts._syncOpts.progress, undefined)
  assert.equal(opts._folderOpts.progress, undefined)
  assert.equal(opts._finaleArgs.progress, undefined)
})

test('runInitWizard: with nothing detected and nothing locked, no express gate is shown', async () => {
  let gates = 0
  const { opts } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    detect: async () => new Set(),
    express: async () => { gates += 1; return 'defaults' },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(gates, 0, 'nothing to accept is nothing to ask about (LLP 0201 #no-default-no-accept)')
  assert.equal(opts._pickOpts.autoAccept, undefined, 'the lane opens its own menu instead')
})

test('runInitWizard: declining the express gate leaves the lanes prompting, positions and all', async () => {
  const { opts } = wizardOpts(await tmpHome(), { fork: async () => 'team' })
  await runInitWizard(opts)
  assert.equal(opts._pickOpts.autoAccept, undefined)
  assert.equal(opts._syncOpts.autoAccept, undefined)
  assert.equal(opts._folderOpts.autoAccept, undefined)
  assert.equal(opts._pickOpts.progress, 'Step 2 of 5 · Choose what to collect')
})

test('runInitWizard: a cancelled express gate exits 130 before any lane runs', async () => {
  const { opts, calls, stderr } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    catalog: detectableCatalog(),
    detect: async () => new Set(['claude']),
    express: async () => 'cancelled',
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 130)
  assert.equal(result.cancelled, true)
  assert.deepEqual(calls, ['gate', 'fork', 'join'])
  assert.match(stderr.text(), /cancelled/)
})

test('runInitWizard: back at the express gate re-presents the fork', async () => {
  let forks = 0
  let gates = 0
  const { opts } = wizardOpts(await tmpHome(), {
    fork: async () => { forks += 1; return 'team' },
    catalog: detectableCatalog(),
    detect: async () => new Set(['claude']),
    express: async () => { gates += 1; return gates === 1 ? 'back' : 'choose' },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(forks, 2, 'the fork is the screen behind the express gate')
  assert.equal(gates, 2)
})

// The gate is the wizard's only accept-or-customize screen, so the solo
// local pathway shows it too (LLP 0201 #gate): accepting there is the
// whole run, and declining opens the pick menu directly.
// @ref LLP 0201#gate [tests]: the unenrolled local pathway shows the express gate and its accept auto-answers the pick lane
test('runInitWizard: the unenrolled local pathway shows the express gate; accepting narrates the pick lane', async () => {
  let gates = 0
  const { opts } = wizardOpts(await tmpHome(), {
    fork: async () => 'local',
    catalog: detectableCatalog(),
    detect: async () => new Set(['claude']),
    express: async (/** @type {any} */ o) => { gates += 1; opts._expressOpts = o; return 'defaults' },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(gates, 1, 'the accept question is asked on every pathway')
  assert.equal(opts._expressOpts.enrolled, false, 'a solo run makes no sync claim')
  assert.equal(opts._pickOpts.autoAccept, true)
  assert.equal(opts._pickOpts.progress, undefined, 'an express run states no positions')
})

// Another enrolled shape: managed without a join this run. Its local
// itinerary adds the sync and folder lanes (LLP 0188, LLP 0200), and the
// gate's accept answers them all.
test('runInitWizard: a managed machine reconfiguring down the local pathway still gets the express gate', async () => {
  let gates = 0
  const { opts, calls } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    confirm: async () => 'stay',
    catalog: detectableCatalog(),
    detect: async () => new Set(['claude']),
    express: async () => { gates += 1; return 'defaults' },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(gates, 1)
  assert.equal(opts._pickOpts.autoAccept, true)
  // No `join`: a reconfigure never runs it. The extra lanes (`syncScope`,
  // `folderAsk`) still run behind the accept, narrating instead of asking.
  assert.deepEqual(calls, ['gate', 'fork', 'pick', 'syncScope', 'folderAsk', 'configure', 'finale'])
})

// The accept row's sync claim is read off the store the sync lane reads,
// because an express accept preserves standing opt-outs rather than
// clearing them (LLP 0188 #opt-out).
test('runInitWizard: a standing opt-out on a named row narrows the express gate\'s sync claim', async () => {
  const home = await tmpHome()
  const stateDir = readObservabilityEnv({ HYP_HOME: path.join(home, '.hyp') }).stateDir
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'claude', class: 'local-only' }] })
  const { opts } = wizardOpts(home, {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    confirm: async () => 'stay',
    catalog: detectableCatalog(),
    detect: async () => new Set(['claude']),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(opts._expressOpts.enrolled, true)
  assert.equal(opts._expressOpts.syncWithheld, true, 'the gate may not promise sync for a row the store withholds')
})

test('runInitWizard: with nothing withheld the express gate keeps its unqualified sync claim', async () => {
  const { opts } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    confirm: async () => 'stay',
    catalog: detectableCatalog(),
    detect: async () => new Set(['claude']),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(opts._expressOpts.enrolled, true)
  assert.equal(opts._expressOpts.syncWithheld, undefined, 'an empty store withholds nothing')
})

test('runInitWizard: a solo run never pays for the store read', async () => {
  const home = await tmpHome()
  const stateDir = readObservabilityEnv({ HYP_HOME: path.join(home, '.hyp') }).stateDir
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'claude', class: 'local-only' }] })
  const { opts } = wizardOpts(home, {
    fork: async () => 'local',
    catalog: detectableCatalog(),
    detect: async () => new Set(['claude']),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  // Unenrolled the row claims no sync at all, so the store has no say.
  assert.equal(opts._expressOpts.enrolled, false)
  assert.equal(opts._expressOpts.syncWithheld, undefined)
})

test('runInitWizard: the team pathway runs the sync-scope and new-folder steps between pick and configure', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), { fork: async () => 'team' })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  // The two enrolled-only questions run in order (LLP 0188, then LLP 0200
  // #wizard) and both precede the acting phases.
  assert.deepEqual(calls, ['gate', 'fork', 'join', 'pick', 'syncScope', 'folderAsk', 'configure', 'finale'])
  // Candidates are the pick result's locked-filtered descriptors.
  assert.deepEqual(opts._syncOpts.candidates, pickResult().descriptors)
})

test('runInitWizard: the sync-scope step receives the locked descriptors so it can state the whole sync picture', async () => {
  const catalog = emptyCatalog()
  const claudeDescriptor = { plugin: '@hypaware/claude', id: 'claude', label: 'Claude Code' }
  catalog.pickerDescriptors.set('claude', claudeDescriptor)
  const { opts } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    catalog,
    pick: async () => pickResult({ lockedSources: ['claude'] }),
  })
  await runInitWizard(opts)
  assert.deepEqual(opts._syncOpts.locked, [claudeDescriptor])
})

// The new-folder question's title names the tools whose sessions raise it
// (LLP 0200 #wizard). A source the user sent local-only one screen earlier
// never reaches the server from any folder, so naming it would promise
// "syncs without asking" for a client that syncs nothing at all. Locked
// rows always sync (LLP 0188 #locked) and are never filtered.
// @ref LLP 0200#wizard [tests]: the title names the syncing rows, not the ones the sync menu just opted out
test('runInitWizard: the new-folder title drops the sources the sync step opted out, and keeps the locked ones', async () => {
  const catalog = emptyCatalog()
  const claude = { plugin: '@hypaware/claude', id: 'claude', label: 'Claude Code' }
  const codex = { plugin: '@hypaware/codex', id: 'codex', label: 'Codex' }
  const openclaw = { plugin: '@hypaware/openclaw', id: 'openclaw', label: 'OpenClaw' }
  catalog.pickerDescriptors.set('claude', claude)
  const { opts } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    catalog,
    pick: async () => pickResult({ lockedSources: ['claude'], descriptors: [codex, openclaw] }),
    syncScope: async (/** @type {any} */ o) => { opts._syncOpts = o; return { optedOut: ['codex'] } },
  })
  await runInitWizard(opts)
  assert.deepEqual(opts._folderOpts.names, ['Claude Code', 'OpenClaw'])
})

// The filter above reads `optedOut`, and a skipped lane returns `[]`
// because it could not read the store, not because the store withholds
// nothing (`sync_scope.js` warns and skips on an unreadable client policy
// store). Naming every picked tool off that empty list promises "syncs
// without asking" for rows the run has just said it cannot account for.
// @ref LLP 0200#wizard [tests]: an unreadable sync store leaves the new-folder title with no names it can stand behind
test('runInitWizard: a skipped sync step leaves the new-folder title tool-free', async () => {
  const catalog = emptyCatalog()
  const claude = { plugin: '@hypaware/claude', id: 'claude', label: 'Claude Code' }
  const codex = { plugin: '@hypaware/codex', id: 'codex', label: 'Codex' }
  catalog.pickerDescriptors.set('claude', claude)
  const { opts } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    catalog,
    pick: async () => pickResult({ lockedSources: ['claude'], descriptors: [codex] }),
    syncScope: async () => ({ skipped: true, noQuestion: true, optedOut: [] }),
  })
  await runInitWizard(opts)
  assert.deepEqual(opts._folderOpts.names, [], 'no list the run can stand behind, so no names')
  // The question still runs: the preference is machine-local and worth
  // recording whatever the client store says.
  assert.equal(opts._folderOpts.progress !== undefined || opts._folderOpts.allowBack === true, true)
})

// The whole sync picture is the *visible* whole picture. `raw-anthropic` and
// `raw-openai` are hidden (LLP 0202) and owned by `@hypaware/ai-gateway`,
// which the central layer declares on every enrolled machine - so without
// this filter the sync gate led with two fleet-labelled rows the picker had
// deliberately never offered, and the label read as if it described the
// client rows beneath them.
// @ref LLP 0276#sync-gate [tests]:
test('runInitWizard: a hidden locked row stays off the sync-scope screen', async () => {
  const catalog = emptyCatalog()
  const claudeDescriptor = { plugin: '@hypaware/claude', id: 'claude', label: 'Claude Code' }
  const rawDescriptor = { plugin: '@hypaware/ai-gateway', id: 'raw-anthropic', label: 'Anthropic API', hidden: true }
  catalog.pickerDescriptors.set('claude', claudeDescriptor)
  catalog.pickerDescriptors.set('raw-anthropic', rawDescriptor)
  const { opts } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    catalog,
    pick: async () => pickResult({ lockedSources: ['raw-anthropic', 'claude'] }),
  })
  await runInitWizard(opts)
  assert.deepEqual(opts._syncOpts.locked, [claudeDescriptor], 'the hidden org row is filtered out, the visible one kept')
  assert.equal(opts._syncOpts.lockedHidden, 1, 'the lane is told a locked row was withheld, without being given the row')
  assert.deepEqual(opts._syncOpts.candidatesHiddenIds, [], 'nothing hidden among the picks')
})

// The candidate list takes the same filter. A carried hidden row (LLP 0202
// #carry-through) reaches `picked.descriptors` whenever it is not locked -
// a team join whose org config has not converged, say - and unfiltered the
// gate offered it as an editable checkbox for a row the picker never showed.
// @ref LLP 0276#sync-gate [tests]:
test('runInitWizard: a hidden picked row is not a sync-scope candidate', async () => {
  const catalog = emptyCatalog()
  const claudeDescriptor = { plugin: '@hypaware/claude', id: 'claude', label: 'Claude Code' }
  const rawDescriptor = { plugin: '@hypaware/ai-gateway', id: 'raw-anthropic', label: 'Anthropic API', hidden: true }
  catalog.pickerDescriptors.set('claude', claudeDescriptor)
  catalog.pickerDescriptors.set('raw-anthropic', rawDescriptor)
  const { opts } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    catalog,
    pick: async () => pickResult({ descriptors: [rawDescriptor, claudeDescriptor] }),
  })
  await runInitWizard(opts)
  assert.deepEqual(opts._syncOpts.candidates, [claudeDescriptor], 'the hidden row is not offered as an opt-out candidate')
  assert.equal(opts._syncOpts.lockedHidden, 0, 'nothing locked, so nothing was withheld from the locked list')
  assert.deepEqual(
    opts._syncOpts.candidatesHiddenIds,
    ['raw-anthropic'],
    'the lane is given the withheld pick by id, so it can ask the store whether it still syncs (LLP 0289 #ask-the-store)'
  )
})

// The `platform` seam (LLP 0368 #testability) pins a row set that is
// otherwise a function of the host. Every screen a run shows reads it, or
// the run gates its picker on the caller's platform and its sync screen on
// `process.platform`. Both platforms are asserted, so neither test can
// pass by accident on a host that happens to match.
// @ref LLP 0368#testability [tests]: the seam pins the whole run's row set, not just the picker's
test('runInitWizard: the sync-scope screen gates rows on the wizard platform, not the host', async () => {
  const lockedMac = { plugin: '@hypaware/a', id: 'locked-mac', label: 'Locked Mac', platforms: ['darwin'] }
  const lockedLinux = { plugin: '@hypaware/b', id: 'locked-linux', label: 'Locked Linux', platforms: ['linux'] }
  const pickedMac = { plugin: '@hypaware/c', id: 'picked-mac', label: 'Picked Mac', platforms: ['darwin'] }
  const pickedLinux = { plugin: '@hypaware/d', id: 'picked-linux', label: 'Picked Linux', platforms: ['linux'] }
  for (const [platform, on, off] of [['darwin', 'mac', 'linux'], ['linux', 'linux', 'mac']]) {
    const catalog = emptyCatalog()
    for (const d of [lockedMac, lockedLinux]) catalog.pickerDescriptors.set(d.id, d)
    const { opts } = wizardOpts(await tmpHome(), {
      fork: async () => 'team',
      catalog,
      platform,
      pick: async (/** @type {any} */ o) => {
        opts._pickOpts = o
        return pickResult({
          lockedSources: ['locked-mac', 'locked-linux'],
          descriptors: [pickedMac, pickedLinux],
        })
      },
    })
    await runInitWizard(opts)
    assert.equal(opts._pickOpts.platform, platform, 'the pick lane gates on the caller platform')
    assert.deepEqual(
      opts._syncOpts.locked.map((/** @type {any} */ d) => d.id),
      [`locked-${on}`],
      'the locked list gates on the same platform the picker did'
    )
    assert.deepEqual(
      opts._syncOpts.candidates.map((/** @type {any} */ d) => d.id),
      [`picked-${on}`],
      'and so does the candidate list'
    )
    assert.deepEqual(
      opts._syncOpts.candidatesHiddenIds,
      [`picked-${off}`],
      'the row the gate withheld crosses as an id, exactly as a hidden one does'
    )
  }
})

// The express gate names the pick lane's own default rows (LLP 0201
// #gate), so it reads that row set through the same platform gate.
// @ref LLP 0368#testability [tests]: the express gate reads the same pinned row set the picker does
test('runInitWizard: the express gate lists rows for the wizard platform, not the host', async () => {
  const mac = { plugin: '@hypaware/a', id: 'row-mac', label: 'Row Mac', platforms: ['darwin'] }
  const linux = { plugin: '@hypaware/b', id: 'row-linux', label: 'Row Linux', platforms: ['linux'] }
  for (const [platform, label] of [['darwin', 'Row Mac'], ['linux', 'Row Linux']]) {
    const catalog = emptyCatalog()
    for (const d of [mac, linux]) catalog.pickerDescriptors.set(d.id, d)
    const { opts } = wizardOpts(await tmpHome(), {
      catalog,
      platform,
      detect: async () => new Set(['row-mac', 'row-linux']),
    })
    await runInitWizard(opts)
    assert.deepEqual(opts._expressOpts.rows, [label], 'the gate names what the picker would show on this platform')
  }
})

// The sentence the empty-candidate branch prints when a hidden row was
// withheld from the screen is a claim about the export seam, and the export
// seam reads the client policy store (LLP 0188 #opt-out). A hidden picked
// row is addressable there ('hyp policy client raw-anthropic local-only'),
// so with a standing entry the row does not ship and the lane must not say
// it does. Driven through the real sync lane, so the assertion is on what
// the user reads rather than on the lane's inputs.
// @ref LLP 0289#ask-the-store [tests]:
test('runInitWizard: a hidden picked row with a standing opt-out does not make the lane claim capture syncs', async () => {
  const home = await tmpHome()
  const stateDir = path.join(home, '.hyp', 'hypaware')
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'raw-anthropic', class: 'local-only' }] })
  const catalog = emptyCatalog()
  const rawDescriptor = { plugin: '@hypaware/ai-gateway', id: 'raw-anthropic', label: 'Anthropic API', hidden: true }
  catalog.pickerDescriptors.set('raw-anthropic', rawDescriptor)
  const { opts, stdout } = wizardOpts(home, {
    fork: async () => 'team',
    catalog,
    pick: async () => pickResult({ descriptors: [rawDescriptor], sourcesPicked: ['raw-anthropic'] }),
    syncScope: runWizardSyncScope,
  })
  await runInitWizard(opts)
  const text = stdout.text()
  assert.match(text, /nothing syncs to your server/, 'the only standing pick is withheld by the store, so nothing ships')
  assert.doesNotMatch(text, /still syncs to your server/)
  assert.doesNotMatch(text, /raw-anthropic|Anthropic API/, 'the withheld row is still never named')
})

// The boundary of the same case: no entry in the store, so the carried
// hidden row does ship and the sentence LLP 0276 minted is the true one.
// @ref LLP 0289#ask-the-store [tests]:
test('runInitWizard: a hidden picked row with no opt-out keeps the sentence that says capture still syncs', async () => {
  const home = await tmpHome()
  const catalog = emptyCatalog()
  const rawDescriptor = { plugin: '@hypaware/ai-gateway', id: 'raw-anthropic', label: 'Anthropic API', hidden: true }
  catalog.pickerDescriptors.set('raw-anthropic', rawDescriptor)
  const { opts, stdout } = wizardOpts(home, {
    fork: async () => 'team',
    catalog,
    pick: async () => pickResult({ descriptors: [rawDescriptor], sourcesPicked: ['raw-anthropic'] }),
    syncScope: runWizardSyncScope,
  })
  await runInitWizard(opts)
  const text = stdout.text()
  assert.match(text, /still syncs to your server/)
  assert.doesNotMatch(text, /nothing syncs to your server/)
})

test('runInitWizard: a managed machine on the local pathway also runs the sync-scope step', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    confirm: async () => 'stay',
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.ok(calls.includes('syncScope'), 'managed gates the step, not the pathway label')
})

test('runInitWizard: an unmanaged local run never sees the sync-scope step', async () => {
  const { opts, calls } = wizardOpts(await tmpHome())
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.ok(!calls.includes('syncScope'), 'a solo machine has no server to scope syncing for')
})

test('runInitWizard: non-interactive picks skip the sync-scope step (default-sync is the scripted outcome)', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    picks: { sources: ['claude'], exportChoice: 'local-parquet', retentionDays: 30 },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.ok(!calls.includes('syncScope'))
})

test('runInitWizard: a cancelled sync-scope step exits 130 and runs nothing further', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    syncScope: async () => ({ cancelled: true, optedOut: [] }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 130)
  assert.equal(result.cancelled, true)
  assert.ok(!calls.includes('configure'), 'cancel stops before the configure phase')
  assert.ok(!calls.includes('finale'))
})

test('runInitWizard: local pathway runs pick -> configure -> finale, no join', async () => {
  const { opts, calls } = wizardOpts(await tmpHome())
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(calls, ['gate', 'fork', 'pick', 'configure', 'finale'])
  assert.equal(result.pathway, 'local')
  assert.equal(opts._pickOpts.managed, undefined)
  // The local pathway supplies the 120-day retention default without a
  // prompt (LLP 0137 #pathway-defaults).
  assert.equal(opts._pickOpts.retentionDefault, 120)
})

test('runInitWizard: fork quit exits 0 before the pick phase', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    fork: async () => 'quit',
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(calls, ['gate', 'fork'])
})

test('runInitWizard: team pathway threads locked + managed into the pick phase', async () => {
  const { opts } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    join: async () => ({ status: 'ok', lockedSources: ['claude'], managed: true }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.pathway, 'team')
  assert.deepEqual(opts._pickOpts.locked, ['claude'])
  assert.equal(opts._pickOpts.managed, true)
  // The team pathway takes the pick phase's 90-day default: no
  // retentionDefault override (LLP 0137 #pathway-defaults).
  assert.equal(opts._pickOpts.retentionDefault, undefined)
})

test('runInitWizard: a failed join explains and returns to the fork', async () => {
  const forkChoices = ['team', 'local']
  const { opts, stderr, calls } = wizardOpts(await tmpHome(), {
    fork: async () => forkChoices.shift(),
    join: async () => ({ status: 'failed', detail: 'no membership' }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(result.pathway, 'local')
  // fork -> join(failed) -> fork -> local -> pick...
  assert.deepEqual(calls.slice(0, 4), ['gate', 'fork', 'join', 'fork'])
  assert.match(stderr.text(), /admin needs to grant/)
})

test('runInitWizard: a multi-org join failure points at hyp remote login --org', async () => {
  const forkChoices = ['team', 'local']
  const { opts, stderr } = wizardOpts(await tmpHome(), {
    fork: async () => forkChoices.shift(),
    // The reason picks the branch; `detail` is the lane's own prose, echoed
    // but never matched (LLP 0179#no-prose-control-flow).
    join: async () => ({ status: 'failed', reason: 'org_selection_required', detail: 'hyp remote login: more than one org\n' }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.pathway, 'local')
  assert.match(stderr.text(), /hyp remote login --org <name>/)
  assert.doesNotMatch(stderr.text(), /admin needs to grant/)
})

// A successful enrollment whose daemon install failed is not a failed
// sign-in: the machine is enrolled, so re-presenting the fork would offer
// enrollment to a machine that already has it, and "Sign-in did not complete"
// contradicts the three lines above it (#978). The run carries on down the
// team pathway and says what is actually missing.
test('runInitWizard: an enrolled join whose daemon install failed proceeds on the team pathway', async () => {
  // 'quit' backs the fork so a wizard that loops back terminates instead of
  // hanging; reaching it at all is the defect this test names.
  const forkChoices = ['team', 'quit']
  const { opts, stderr, calls } = wizardOpts(await tmpHome(), {
    fork: async () => forkChoices.shift(),
    join: async () => ({ status: 'daemon_incomplete', lockedSources: ['claude'], managed: true }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.doesNotMatch(stderr.text(), /Sign-in did not complete/)
  assert.doesNotMatch(stderr.text(), /admin needs to grant/)
  assert.match(stderr.text(), /background service could not be installed/)
  assert.equal(calls.filter((c) => c === 'fork').length, 1, 'must not re-present the fork')
  assert.equal(result.pathway, 'team')
  // fork -> join -> the team pathway's lanes, with no second fork.
  assert.deepEqual(calls, ['gate', 'fork', 'join', 'pick', 'syncScope', 'folderAsk', 'configure', 'finale'])
  // The enrollment still applies: the org's rows reach the picker locked.
  assert.deepEqual(opts._pickOpts.locked, ['claude'])
  assert.equal(opts._pickOpts.managed, true)
})

// The login lane's install just failed on this machine, so the finale must
// not run it again. Nothing on disk can decide that: both installers write
// the plist/unit before they call the service manager and neither rolls it
// back, so `hyp status` reports `installed` for a service that never ran,
// and where the platform has no installer the file is absent and
// `installDaemon` throws instead - uncaught all the way out of `hyp setup`,
// after the config commit, with the fork already behind the user (#978).
test('runInitWizard: a daemon_incomplete run never re-runs the install it just watched fail', async () => {
  // A home with no plist and no unit file: the shape of a platform that has
  // no installer, and the half that would have thrown rather than no-opped.
  const forkChoices = ['team', 'quit']
  const { opts } = wizardOpts(await tmpHome(), {
    fork: async () => forkChoices.shift(),
    join: async () => ({ status: 'daemon_incomplete', lockedSources: ['claude'], managed: true }),
  })
  await runInitWizard(opts)
  assert.equal(opts._finaleArgs.finale.skipDaemonInstall, true, 'the finale is told not to retry the install')
  // The restart step is untouched: it is already non-fatal, so a transient
  // failure keeps its one best-effort revival.
  assert.equal(opts._finaleArgs.finale.skipDaemonRestart, undefined)
})

test('runInitWizard: an abandoned join is retriable and re-presents the fork', async () => {
  const forkChoices = ['team', 'team', 'local']
  const joins = [
    { status: 'abandoned' },
    { status: 'ok', lockedSources: [], managed: true },
  ]
  const { opts, stderr } = wizardOpts(await tmpHome(), {
    fork: async () => forkChoices.shift(),
    join: async () => joins.shift(),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.pathway, 'team')
  assert.match(stderr.text(), /did not complete/)
})

// --- non-interactive short-circuit ---

test('runInitWizard: pre-baked picks skip gate, fork, and join entirely', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    picks: { sources: ['claude'], exportChoice: 'local-parquet', retentionDays: 30 },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.ok(!calls.includes('gate'))
  assert.ok(!calls.includes('fork'))
  assert.ok(!calls.includes('join'))
  assert.deepEqual(calls, ['pick', 'configure', 'finale'])
  assert.equal(opts._pickOpts.picks.sources[0], 'claude')
  assert.equal(result.pathway, undefined)
})

// --- exits: cancel and refusal ---

test('runInitWizard: a cancelled pick returns 130 and runs nothing further', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    pick: async () => pickResult({ exitCode: 130, cancelled: true }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 130)
  assert.equal(result.cancelled, true)
  assert.ok(!calls.includes('configure'))
  assert.ok(!calls.includes('finale'))
})

test('runInitWizard: an overwrite refusal returns the pick phase exit 1', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    pick: async () => pickResult({ exitCode: 1 }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 1)
  assert.ok(!calls.includes('finale'))
})

// --- deferred config commit (LLP 0190 #commit-point) ---
// The pick lane composes; the orchestrator commits after the sync lane, so
// the overwrite confirm is the last question and a cancel at the sync lane
// leaves the existing config untouched.
// @ref LLP 0190#commit-point [tests]:

test('runInitWizard: a pending config lands on disk after the sync lane, before configure', async () => {
  const home = await tmpHome()
  const configPath = path.join(home, '.hyp', 'config.json')
  let onDiskDuringSync = true
  const { opts, calls } = wizardOpts(home, {
    fork: async () => 'team',
    pick: async () => pickResult({ configPath, configPending: true }),
    syncScope: async () => {
      onDiskDuringSync = await fs.access(configPath).then(() => true, () => false)
      return { optedOut: [] }
    },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(onDiskDuringSync, false, 'the sync lane runs before the config write')
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), pickResult().config)
  assert.ok(calls.includes('configure'), 'the acting phases still run after the commit')
})

test('runInitWizard: a declined commit exits 1, runs nothing further, and narrates on the team pathway', async () => {
  const home = await tmpHome()
  const configPath = path.join(home, '.hyp', 'config.json')
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, '{"version":2,"plugins":["existing"]}\n', 'utf8')
  const { opts, calls, stdout } = wizardOpts(home, {
    fork: async () => 'team',
    pick: async () => pickResult({ configPath, configPending: true }),
    confirmOverwrite: async () => false,
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 1)
  assert.notEqual(result.cancelled, true)
  assert.ok(calls.includes('syncScope'), 'the questions all ran before the commit refused')
  assert.ok(!calls.includes('configure'))
  assert.ok(!calls.includes('finale'))
  assert.equal(await fs.readFile(configPath, 'utf8'), '{"version":2,"plugins":["existing"]}\n', 'the existing config is untouched')
  assert.match(stdout.text(), /This machine is enrolled/)
})

test('runInitWizard: a scripted pick result without configPending is never committed by the orchestrator', async () => {
  const home = await tmpHome()
  const configPath = path.join(home, '.hyp', 'config.json')
  const { opts } = wizardOpts(home, {
    pick: async () => pickResult({ configPath }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(await fs.access(configPath).then(() => true, () => false), false, 'no pending flag, no write')
})

// A team-pathway abort lands after the join lane already enrolled the
// machine; the wizard cannot roll that back, so it must say what state the
// machine is in (default-sync plus the standing control) instead of exiting
// silently. Narration only, never another prompt.
// @ref LLP 0190#abort-narration [tests]:

test('runInitWizard: a team-path overwrite refusal narrates the enrolled state and the deadline', async () => {
  const home = await tmpHome()
  await writeFirstSyncHoldMarker({ stateDir: path.join(home, '.hyp', 'hypaware') })
  const { opts, stdout } = wizardOpts(home, {
    fork: async () => 'team',
    pick: async () => pickResult({ exitCode: 1 }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 1)
  const text = stdout.text()
  assert.match(text, /This machine is enrolled/)
  assert.match(text, /hyp privacy client <name> local-only/)
  assert.match(text, /Nothing has been uploaded yet/)
  // No sync offer follows an abort, so the narration keeps the way out.
  assert.match(text, /To send it sooner, run `hyp sync`/)
})

test('runInitWizard: a team-path pick cancel narrates the enrolled state; no hold means no deadline claim', async () => {
  const { opts, stdout } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    pick: async () => pickResult({ exitCode: 130, cancelled: true }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 130)
  const text = stdout.text()
  assert.match(text, /This machine is enrolled/)
  assert.doesNotMatch(text, /Nothing has been uploaded yet/)
})

test('runInitWizard: a team-path sync-scope cancel narrates that default-sync stands', async () => {
  const { opts, stdout } = wizardOpts(await tmpHome(), {
    fork: async () => 'team',
    syncScope: async () => ({ cancelled: true, optedOut: [] }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 130)
  assert.match(stdout.text(), /This machine is enrolled/)
})

test('runInitWizard: a local-path abort stays quiet - nothing enrolled this run', async () => {
  const { opts, stdout } = wizardOpts(await tmpHome(), {
    pick: async () => pickResult({ exitCode: 1 }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 1)
  assert.doesNotMatch(stdout.text(), /This machine is enrolled/)
})

test('runInitWizard: a cancelled finale returns 130 with the cancel notice', async () => {
  const { opts, stderr } = wizardOpts(await tmpHome(), {
    finaleRunner: async () => /** @type {any} */ ({
      cancelled: true,
      daemonInstall: { skipped: true, dryRun: false },
      globalInstall: { skipped: true, installed: false },
      attach: [],
      skillsInstalled: [],
      agentsInstalled: [],
      daemonRestart: { skipped: true, dryRun: false, ok: false },
      backfill: [],
    }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 130)
  assert.match(stderr.text(), /hyp setup: cancelled/)
})

// --- run summary + privacy narration ---

test('runInitWizard: prints the run summary with the written config path', async () => {
  const { opts, stdout } = wizardOpts(await tmpHome())
  await runInitWizard(opts)
  assert.match(stdout.text(), /✓ Wrote \/tmp\/x\/config\.json/)
  // The old `next: hyp query sql 'select count(*) from logs'` hint named a
  // dataset most installs do not register (LLP 0135 #first-look).
  assert.ok(!stdout.text().includes('next: hyp query sql'))
})

// --- first look ---

/**
 * A first-look runner: the probe answers with one day of history, then one
 * query per section. Only the two sections this file asserts on are
 * scripted; the rest come back empty (which renders as absent).
 */
function firstLookStub(providerRows, dailyRows) {
  /** @type {string[]} */
  const seen = []
  return {
    seen,
    runner: {
      hasDataset: () => true,
      /** @param {string} sql */
      async run(sql) {
        seen.push(sql)
        if (sql === OVERVIEW_PROBE_SQL) return { columns: [], rows: [{ date: '2026-07-24', n: 40 }] }
        if (sql.includes('group by 1, 2')) return { columns: [], rows: providerRows }
        if (sql.includes('count(distinct session_id) sessions,')) return { columns: [], rows: dailyRows }
        return { columns: [], rows: [] }
      },
    },
  }
}

test('runInitWizard: an attended run ends on the first look, before the privacy narration', async () => {
  const home = await tmpHome()
  await writeFirstSyncHoldMarker({ stateDir: path.join(home, '.hyp', 'hypaware') })
  const stub = firstLookStub(
    [{ provider: 'anthropic', model: 'claude-opus-5', input_tokens: 400, cached_tokens: 4000, output_tokens: 40 }],
    [{ date: '2026-07-24', sessions: 3, input_tokens: 400, cached_tokens: 4000, output_tokens: 40 }]
  )
  const { opts, stdout } = wizardOpts(home, { fork: async () => 'team', firstLook: stub.runner })
  await runInitWizard(opts)
  const text = stdout.text()
  // The window probe, then the two sections setup runs. Repos and tools
  // are `hyp query overview`'s half (LLP 0198#wizard-sections).
  assert.equal(stub.seen[0], OVERVIEW_PROBE_SQL)
  assert.equal(stub.seen.length, 3)
  // Every number in the block is scoped to the window the probe chose.
  assert.match(text, /2026-07-24 to 2026-07-24 \(1 active day, 40 rows\)/)
  assert.match(text, /First look at what HypAware has recorded/)
  assert.match(text, /anthropic\s+claude-opus-5\s+400\s+4,000\s+40/)
  assert.match(text, /2026-07-24/)
  // The privacy narration stays the wizard's last words (LLP 0135 #privacy).
  assert.ok(text.indexOf('First look') < text.indexOf('Nothing has been uploaded yet'))
})

test('runInitWizard: a non-interactive or dry run skips the first look', async () => {
  const stub = firstLookStub([{ provider: 'anthropic', model: 'm', input_tokens: 1, cached_tokens: 10, output_tokens: 1 }], [])
  const { opts, stdout } = wizardOpts(await tmpHome(), {
    picks: { sources: ['claude'], exportChoice: 'local-parquet', retentionDays: 30 },
    firstLook: stub.runner,
  })
  await runInitWizard(opts)
  assert.equal(stub.seen.length, 0)
  assert.ok(!stdout.text().includes('First look'))

  const dry = firstLookStub([{ provider: 'anthropic', model: 'm', input_tokens: 1, cached_tokens: 10, output_tokens: 1 }], [])
  const { opts: dryOpts } = wizardOpts(await tmpHome(), {
    finale: { dryRun: true },
    firstLook: dry.runner,
  })
  await runInitWizard(dryOpts)
  assert.equal(dry.seen.length, 0)
})

// --- the stranded-attach warning's closing repeat (LLP 0230) ---

/**
 * A finale summary that reports clients this run left attached but no longer
 * collects. The finale itself printed the full warning before the daemon
 * restart; this is what it hands back for the closing repeat to read.
 *
 * @param {string[]} clients
 */
function strandedFinale(clients) {
  return /** @type {any} */ ({
    daemonInstall: { skipped: true, dryRun: false },
    globalInstall: { skipped: true, installed: false },
    attach: [],
    skillsInstalled: [],
    agentsInstalled: [],
    daemonRestart: { skipped: true, dryRun: false, ok: false },
    backfill: [],
    attachedNotConfigured: clients,
  })
}

// The finale names the stranded clients before the daemon restart (LLP 0185
// #warn-do-not-detach) and then the wizard writes the run summary, the first
// look's ~60 lines, and the privacy narration on top of it, so by the time an
// attended run ends the warning has scrolled away. On a managed host it is
// the only signal there is, because `hyp status`'s mirror diagnostic is gated
// to hosts with no central layer.
// @ref LLP 0230#repeat-at-the-end [tests]: the wizard repeats what its own closing output buried
test('runInitWizard: an attended run repeats the stranded-attach warning after the first look', async () => {
  const home = await tmpHome()
  await writeFirstSyncHoldMarker({ stateDir: path.join(home, '.hyp', 'hypaware') })
  const stub = firstLookStub(
    [{ provider: 'anthropic', model: 'claude-opus-5', input_tokens: 400, cached_tokens: 4000, output_tokens: 40 }],
    [{ date: '2026-07-24', sessions: 3, input_tokens: 400, cached_tokens: 4000, output_tokens: 40 }]
  )
  const { opts, stdout } = wizardOpts(home, {
    fork: async () => 'team',
    firstLook: stub.runner,
    finaleRunner: async () => strandedFinale(['codex']),
  })
  await runInitWizard(opts)
  const text = stdout.text()

  // The names and the one command that clears each, not a bare mention.
  assert.match(text, /Still attached, no longer collected: codex/, text)
  assert.match(text, /hyp client detach codex/, text)
  // Past the block that buried the finale's own print.
  assert.ok(text.indexOf('First look') >= 0, text)
  assert.ok(text.indexOf('hyp client detach codex') > text.indexOf('First look'), text)
  // And still ahead of the privacy narration, which stays the last words.
  assert.ok(
    text.indexOf('hyp client detach codex') < text.indexOf('Nothing has been uploaded yet'),
    text
  )
})

// The repeat exists because the wizard's closing sequence buries the finale's
// print. A scripted run writes nothing between the two, so repeating there
// would be the double-print on one screen the shared run summary would have
// caused. Its output stays byte-identical to what the finale alone produced.
// @ref LLP 0230#when [tests]: no closing sequence, no repeat
test('runInitWizard: a scripted run does not repeat the stranded-attach warning', async () => {
  const { opts, stdout } = wizardOpts(await tmpHome(), {
    picks: { sources: ['claude'], exportChoice: 'local-parquet', retentionDays: 30 },
    finaleRunner: async () => strandedFinale(['codex']),
  })
  await runInitWizard(opts)
  assert.doesNotMatch(stdout.text(), /hyp client detach/, stdout.text())
})

// A cancel at the backfill consent skips the first look, so the run summary is
// the only thing between the finale's own warning (which the finale prints
// before its restart block, cancelled or not) and the end of the run. The team
// pathway is not on its own a reason to repeat: a pathway is only resolved on
// an interactive run, so an uncancelled non-dry team run has already run the
// first look, and the runs a `pathway === 'team'` clause would add are exactly
// the ones with nothing in between.
// @ref LLP 0230#when [tests]: a cancelled team run buried nothing, so it does not repeat
test('runInitWizard: a run cancelled at the finale does not repeat the stranded-attach warning', async () => {
  const home = await tmpHome()
  await writeFirstSyncHoldMarker({ stateDir: path.join(home, '.hyp', 'hypaware') })
  const { opts, stdout } = wizardOpts(home, {
    fork: async () => 'team',
    finaleRunner: async () => ({ ...strandedFinale(['codex']), cancelled: true }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.cancelled, true)
  assert.doesNotMatch(stdout.text(), /hyp client detach/, stdout.text())
})

// The first look is documented to degrade rather than fail a finished install
// (LLP 0135 #first-look): an unregistered dataset, an unreadable cache, or a
// render that throws all leave an attended run that attempted the block and
// printed none of it. The gate that admits the repeat is therefore what the
// step wrote, not what it attempted: on a silent skip the finale's own print
// is still the last thing above the summary, and repeating under it would be
// the same-screen double print.
// @ref LLP 0230#when [tests]: a first look that printed nothing buried nothing
test('runInitWizard: an attended run whose first look skips itself does not repeat the stranded-attach warning', async () => {
  const home = await tmpHome()
  await writeFirstSyncHoldMarker({ stateDir: path.join(home, '.hyp', 'hypaware') })
  const { opts, stdout } = wizardOpts(home, {
    fork: async () => 'team',
    // The shape `firstLookRunnerFromCtx` yields when the overview dataset is
    // not registered: the step returns `{ wrote: false }` without writing.
    firstLook: { hasDataset: () => false, async run() { return { columns: [], rows: [] } } },
    finaleRunner: async () => strandedFinale(['codex']),
  })
  await runInitWizard(opts)
  const text = stdout.text()
  assert.doesNotMatch(text, /First look/, text)
  assert.doesNotMatch(text, /hyp client detach/, text)
})

// The skip that is not silent, and the reason the gate measures writes rather
// than reading `shown`. When the deadline expires with nothing renderable
// (`reason: 'slow'`, the branch `FIRST_LOOK_BUDGET_MS` exists for: a
// pathological day, a disk that stalls), the block does not render and two
// lines saying so do land on stdout. Those lines, plus the run summary and
// the privacy narration, bury the finale's own warning exactly as a full
// render would, so this run must repeat it. A gate reading `shown` drops the
// repeat here, which on a managed host is the only signal there is: LLP 0185
// #status-backstop gates `hyp status`'s mirror diagnostic off on a joined
// machine.
// @ref LLP 0230#when [tests]: a skip that still wrote buried the finale's print, so it repeats
test('runInitWizard: an attended run whose first look skips slowly still repeats the stranded-attach warning', async () => {
  const home = await tmpHome()
  await writeFirstSyncHoldMarker({ stateDir: path.join(home, '.hyp', 'hypaware') })
  const { opts, stdout } = wizardOpts(home, {
    fork: async () => 'team',
    firstLook: {
      hasDataset: () => true,
      // Far longer than the budget below, so no section ever lands. `unref`
      // so the abandoned query does not hold the test runner open.
      run: () => new Promise((resolve) => {
        setTimeout(() => resolve({ columns: [], rows: [] }), 5000).unref()
      }),
    },
    firstLookBudgetMs: 40,
    finaleRunner: async () => strandedFinale(['codex']),
  })
  await runInitWizard(opts)
  const text = stdout.text()
  // The block itself never rendered.
  assert.match(text, /Skipped the first look/, text)
  assert.doesNotMatch(text, /First look at what HypAware has recorded/, text)
  // The repeat still ran, under what the skip wrote and ahead of the privacy
  // narration, which stays the last words.
  assert.match(text, /Still attached, no longer collected: codex/, text)
  assert.ok(text.indexOf('hyp client detach codex') > text.indexOf('Skipped the first look'), text)
  assert.ok(
    text.indexOf('hyp client detach codex') < text.indexOf('Nothing has been uploaded yet'),
    text
  )
})

/**
 * A first look that finds something, so the closing question list uses its
 * recorded-history framing (LLP 0198#empty-cache).
 */
function firstLookWithRows() {
  return firstLookStub(
    [{ provider: 'anthropic', model: 'claude-opus-5', input_tokens: 400, cached_tokens: 4000, output_tokens: 40 }],
    [{ date: '2026-07-24', sessions: 3, input_tokens: 400, cached_tokens: 4000, output_tokens: 40 }]
  ).runner
}

test('runInitWizard: the suggested questions come last, after the privacy narration', async () => {
  // @ref LLP 0198#onboarding-list [tests]: onboarding closes with text and never starts a client
  const home = await tmpHome()
  await writeFirstSyncHoldMarker({ stateDir: path.join(home, '.hyp', 'hypaware') })
  const { opts, stdout } = wizardOpts(home, {
    fork: async () => 'team',
    firstLook: firstLookWithRows(),
  })
  await runInitWizard(opts)
  const text = stdout.text()
  for (const prompt of SUGGESTED_PROMPTS) assert.match(text, new RegExp(prompt.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(text, /Starting Claude Code|Starting Codex/)
  // Order: rows, then what leaves this machine, then the question.
  assert.ok(text.indexOf('First look') < text.indexOf('Nothing has been uploaded yet'))
  assert.ok(text.indexOf('Nothing has been uploaded yet') < text.indexOf('Questions worth asking'))
  assert.match(text, /To ask any of these, run `hyp ask` from the directory where you want an attached AI client to start/)
})

// @ref LLP 0203#offer [tests]: the sync offer sits between the first look it follows and the closing question list
test('runInitWizard: an enrolled run runs `hyp sync` as its one first-sync question, before the suggested questions', async () => {
  const home = await tmpHome()
  await writeFirstSyncHoldMarker({ stateDir: path.join(home, '.hyp', 'hypaware') })
  let spawned = 0
  const { opts, stdout } = wizardOpts(home, {
    fork: async () => 'team',
    firstLook: firstLookWithRows(),
    syncNow: {
      // A child that leaves the marker in place: the user read the plan and
      // answered no.
      spawnFn: /** @type {any} */ (() => {
        spawned += 1
        /** @type {Record<string, (arg: any) => void>} */
        const handlers = {}
        queueMicrotask(() => handlers.close?.(0))
        return { on: (/** @type {string} */ event, /** @type {any} */ fn) => { handlers[event] = fn } }
      }),
    },
  })
  await runInitWizard(opts)

  assert.equal(spawned, 1)
  const text = stdout.text()
  // The wizard asks nothing of its own, and its narration stands down for
  // the child's plan: no paragraph, no menu, one lead line.
  // @ref LLP 0203#no-new-consent [tests]: the informed prompt is the only prompt on the attended path
  assert.doesNotMatch(text, /Nothing has been uploaded yet/)
  assert.doesNotMatch(text, /Send your recorded history/)
  assert.ok(text.indexOf('First look') < text.indexOf('`hyp sync` shows what would leave'))
  assert.ok(text.indexOf('`hyp sync` shows what would leave') < text.indexOf('Questions worth asking'))
  // A run that ends on the wait still leaves the deadline and the release
  // verb on screen.
  assert.match(text, /Nothing was sent\. Your history stays on this machine until /)
  assert.match(text, /run `hyp sync` any time to send it sooner/)
})

test('runInitWizard: a local install with no hold is never offered a sync', async () => {
  const { opts, stdout } = wizardOpts(await tmpHome(), {
    fork: async () => 'local',
    syncNow: { spawnFn: () => { throw new Error('a local install must not sync') } },
  })
  await runInitWizard(opts)
  assert.doesNotMatch(stdout.text(), /hyp sync/)
})

test('runInitWizard: a first look with no rows still prints the questions with an empty-history note', async () => {
  // @ref LLP 0198#empty-cache [tests]: a fresh install with nothing backfilled
  // gets future-facing questions, never a launch
  const { opts, stdout } = wizardOpts(await tmpHome(), {
    // Every section comes back empty: the dataset exists and holds nothing.
    firstLook: firstLookStub([], []).runner,
  })
  await runInitWizard(opts)
  assert.match(stdout.text(), /Nothing recorded yet/)
  assert.match(stdout.text(), new RegExp(SUGGESTED_PROMPTS[0].prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('runInitWizard: no detected client or gateway dataset still prints the question list', async () => {
  const { opts, stdout } = wizardOpts(await tmpHome(), {
    firstLook: { hasDataset: () => false, async run() { return { columns: [], rows: [] } } },
  })
  await runInitWizard(opts)
  assert.match(stdout.text(), /Nothing recorded yet/)
  assert.match(stdout.text(), new RegExp(SUGGESTED_PROMPTS[0].prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(stdout.text(), /Starting Claude Code|Starting Codex/)
})

// --- firstLookHadRows ---

// The mapping from a first-look outcome to the question list's `hasRows` has
// three genuinely different answers (`no-dataset` -> false, `slow` -> true,
// `error`/absent -> undefined, which never withholds the offer). Two of
// those were reachable by a mutant that still passed the suite: flipping
// `slow`'s `true` to `false`, and flipping the no-result guard's
// `undefined` to `false`. Both would wrongly print the empty-history framing.
// @ref LLP 0198#empty-cache [tests]: no-dataset, slow, and error/absent each resolve to a distinct hasRows value
test('firstLookHadRows: a slow first look still reports hasRows true', () => {
  assert.equal(firstLookHadRows({ shown: false, reason: 'slow' }), true)
})

test('firstLookHadRows: an absent or errored first look reports hasRows undefined, not false', () => {
  assert.equal(firstLookHadRows(undefined), undefined)
  assert.equal(firstLookHadRows({ shown: false, reason: 'error' }), undefined)
})

test('runInitWizard: a non-interactive or dry run does not print the question list', async () => {
  const { opts, stdout } = wizardOpts(await tmpHome(), {
    picks: { sources: ['claude'], exportChoice: 'local-parquet', retentionDays: 30 },
  })
  await runInitWizard(opts)
  assert.ok(!stdout.text().includes('Questions worth asking'))

  const { opts: dryOpts } = wizardOpts(await tmpHome(), {
    finale: { dryRun: true },
  })
  await runInitWizard(dryOpts)
})

test('runInitWizard: team pathway with a live first-sync hold narrates the deadline', async () => {
  const home = await tmpHome()
  const stateDir = path.join(home, '.hyp', 'hypaware')
  await writeFirstSyncHoldMarker({ stateDir })
  const { opts, stdout } = wizardOpts(home, {
    fork: async () => 'team',
  })
  await runInitWizard(opts)
  const text = stdout.text()
  // No tty here, so the sync step cannot put the question and states the
  // hold itself: the deadline, the way out, and the review hint.
  assert.match(text, /Nothing has been uploaded yet: nothing leaves this machine before /)
  assert.match(text, /hypaware-privacy/)
  assert.match(text, /To send it sooner, run `hyp sync`/)
})

test('runInitWizard: local pathway never narrates the first-sync hold', async () => {
  const home = await tmpHome()
  // Even with a (stale) hold marker on disk, the local pathway stays quiet.
  const stateDir = path.join(home, '.hyp', 'hypaware')
  await writeFirstSyncHoldMarker({ stateDir })
  const { opts, stdout } = wizardOpts(home)
  await runInitWizard(opts)
  assert.doesNotMatch(stdout.text(), /Nothing has been uploaded yet/)
})
