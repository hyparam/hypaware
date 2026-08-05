// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { reduce } from '../../../../src/core/cli/tui/keypress.js'
import { render } from '../../../../src/core/cli/tui/render.js'
import { PromptBackRequestedError, isPromptBackError } from '../../../../src/core/cli/tui/runtime.js'
import { runWizardFork } from '../../../../src/core/cli/wizard/fork.js'
import { runWizardPick } from '../../../../src/core/cli/wizard/pick.js'
import { runWizardSyncScope } from '../../../../src/core/cli/wizard/sync_scope.js'
import { runInitWizard } from '../../../../src/core/cli/wizard/index.js'
import { LOCAL_INSTALL_RETENTION_DAYS } from '../../../../src/core/cli/walkthrough.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { clientSyncListPath } from '../../../../src/core/usage-policy/client_sync.js'
import { discoverBundledPlugins } from '../../../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../../../src/core/plugin_catalog.js'

/**
 * @import { MultiselectState, SelectState } from '../../../../src/core/cli/tui/types.js'
 * @import { PluginCatalog } from '../../../../src/core/types.js'
 */

// Wizard back-navigation (LLP 0191): escape steps back one screen where a
// screen exists behind the prompt (`allowBack`), ctrl+c stays the cancel,
// lanes loop menu-to-gate internally and propagate `back` from their first
// screen, the orchestrator carries the step-level edges, a completed join
// is reused rather than re-run, and a re-entered pick lane is seeded with
// the previously confirmed selection.
// @ref LLP 0191#esc-back [tests]:
// @ref LLP 0191#back-edges [tests]:
// @ref LLP 0191#lane-loops [tests]:
// @ref LLP 0191#re-entry-seeding [tests]:
// @ref LLP 0191#join-not-undone [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/** @returns {Promise<PluginCatalog>} */
async function realCatalog() {
  const bundled = await discoverBundledPlugins()
  return buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
}

// --- the TUI layer: escape's meaning is per-prompt and opt-in ---

/** @returns {SelectState} */
function selectState(overrides = {}) {
  return {
    kind: 'select',
    title: 'pick',
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    cursor: 0,
    status: 'active',
    ...overrides,
  }
}

/** @returns {MultiselectState} */
function multiselectState(overrides = {}) {
  return {
    kind: 'multiselect',
    title: 'pick',
    options: [{ value: 'a', label: 'A', checked: false }],
    cursor: 0,
    status: 'active',
    ...overrides,
  }
}

test('reduce: escape settles an allowBack prompt as backed, not cancelled', () => {
  for (const s of [selectState({ allowBack: true }), multiselectState({ allowBack: true })]) {
    assert.equal(reduce(s, { name: 'escape' }).status, 'backed')
  }
})

test('reduce: without allowBack escape keeps meaning cancel', () => {
  for (const s of [selectState(), multiselectState()]) {
    assert.equal(reduce(s, { name: 'escape' }).status, 'cancelled')
  }
})

test('reduce: ctrl+c cancels even on an allowBack prompt', () => {
  for (const s of [selectState({ allowBack: true }), multiselectState({ allowBack: true })]) {
    assert.equal(reduce(s, { name: 'c', ctrl: true }).status, 'cancelled')
  }
})

test('render: the default hint tells the truth about escape', () => {
  assert.match(render(selectState(), { color: false }), /esc cancel/)
  assert.match(render(selectState({ allowBack: true }), { color: false }), /esc back/)
  assert.match(render(multiselectState({ allowBack: true }), { color: false }), /esc back/)
  // An explicit hint still wins.
  assert.match(render(selectState({ allowBack: true, hint: 'custom' }), { color: false }), /custom/)
})

test('isPromptBackError recognises the error and name-preserving copies', () => {
  assert.equal(isPromptBackError(new PromptBackRequestedError()), true)
  const copy = new Error('wrapped')
  copy.name = 'PromptBackRequestedError'
  assert.equal(isPromptBackError(copy), true)
  assert.equal(isPromptBackError(new Error('other')), false)
})

// --- the fork: 'back' only where the gate showed a screen ---

test('runWizardFork: with allowBack the legacy prompt accepts b and resolves back', async () => {
  const stdout = makeBuf()
  const choice = await runWizardFork(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env: { HYP_NO_TUI: '1' },
    stdin: Readable.from(['b\n']),
    allowBack: true,
  }))
  assert.equal(choice, 'back')
  assert.match(stdout.text(), /b back/, 'the prompt line names the back key')
})

test('runWizardFork: without allowBack a stray b quits, and the prompt never mentions back', async () => {
  const stdout = makeBuf()
  const choice = await runWizardFork(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env: { HYP_NO_TUI: '1' },
    stdin: Readable.from(['b\n']),
  }))
  assert.equal(choice, 'quit')
  assert.doesNotMatch(stdout.text(), /b back/)
})

// --- the pick lane: gate/menu loop, back propagation, re-entry seeding ---

/**
 * @param {string} tmpPrefix
 * @returns {Promise<NodeJS.ProcessEnv>}
 */
async function hermeticEnv(tmpPrefix) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), tmpPrefix))
  return { HOME: tmp, HYP_HOME: path.join(tmp, '.hyp'), HYP_NO_TUI: '1' }
}

test('runWizardPick: back at the gate propagates only when the orchestrator allowed it', async () => {
  const env = await hermeticEnv('hyp-back-pick-gate-')
  const catalog = await realCatalog()
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, catalog,
    detect: async () => new Set(['claude']),
    allowBack: true,
    confirm: async (/** @type {any} */ q) => {
      assert.equal(q.allowBack, true, 'the gate carries the orchestrator opt-in')
      throw new PromptBackRequestedError()
    },
    prompt: async () => { throw new Error('the menu must not open') },
  }))
  assert.equal(result.back, true)
  assert.equal(result.exitCode, 0)
  // Nothing was composed or written on the way out.
  assert.equal(result.configPath, '')
})

test('runWizardPick: back at the menu returns to the gate, not out of the lane', async () => {
  const env = await hermeticEnv('hyp-back-pick-menu-')
  const catalog = await realCatalog()
  /** @type {string[]} */
  const screens = []
  let confirmCalls = 0
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, catalog,
    detect: async () => new Set(['claude']),
    confirm: async () => {
      screens.push('gate')
      confirmCalls += 1
      return confirmCalls === 1 ? 'customize' : 'accept'
    },
    prompt: async (/** @type {any} */ q) => {
      screens.push('menu')
      assert.equal(q.allowBack, true, 'the menu can always back into an existing gate')
      throw new PromptBackRequestedError()
    },
  }))
  assert.deepEqual(screens, ['gate', 'menu', 'gate'], 'menu escape re-presents the gate')
  assert.equal(result.back, undefined)
  assert.deepEqual(result.sourcesPicked, ['claude'], 'the second gate pass accepted the defaults')
})

test('runWizardPick: without a gate and without allowBack the menu offers no back', async () => {
  const env = await hermeticEnv('hyp-back-pick-nogate-')
  const catalog = await realCatalog()
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, catalog,
    detect: async () => new Set(),
    confirm: async () => { throw new Error('no defaults, no gate') },
    prompt: async (/** @type {any} */ q) => {
      assert.equal(q.allowBack, undefined, 'no screen exists behind this prompt')
      return ['claude']
    },
  }))
  assert.deepEqual(result.sourcesPicked, ['claude'])
})

// @ref LLP 0191#re-entry-seeding [tests]:
test('runWizardPick: initialSelection seeds the boxes and skips detection', async () => {
  const env = await hermeticEnv('hyp-back-pick-seed-')
  const catalog = await realCatalog()
  let detectCalled = false
  /** @type {any} */
  let menuQuestion = null
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, catalog,
    detect: async () => { detectCalled = true; return new Set(['codex']) },
    initialSelection: ['claude'],
    confirm: async () => 'customize',
    prompt: async (/** @type {any} */ q) => { menuQuestion = q; return ['claude'] },
  }))
  assert.equal(detectCalled, false, 're-entry must not overwrite the previous answer with detection')
  const claude = menuQuestion.options.find((/** @type {any} */ o) => o.value === 'claude')
  const codex = menuQuestion.options.find((/** @type {any} */ o) => o.value === 'codex')
  assert.equal(claude.checked, true, 'the previously confirmed source arrives checked')
  assert.doesNotMatch(claude.label, /detected/, 'a seeded row is an answer, not a guess')
  assert.notEqual(codex?.checked, true)
  assert.deepEqual(result.sourcesPicked, ['claude'])
})

// --- the sync lane: gate/menu loop, back propagation ---

/** @param {string} id */
function descriptor(id) {
  return /** @type {any} */ ({ plugin: `@hypaware/${id}`, id, label: `capture ${id}` })
}

test('runWizardSyncScope: back at the gate propagates and leaves the store unwritten', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-back-sync-gate-'))
  const env = { HYP_HOME: hypHome }
  const stateDir = readObservabilityEnv(env).stateDir
  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('claude')],
    allowBack: true,
    confirm: async (/** @type {any} */ q) => {
      assert.equal(q.allowBack, true)
      throw new PromptBackRequestedError()
    },
    prompt: async () => { throw new Error('the menu must not open') },
  }))
  assert.equal(result.back, true)
  await assert.rejects(fs.access(clientSyncListPath(stateDir)), 'a backed-out lane writes nothing')
})

test('runWizardSyncScope: back at the menu returns to the gate', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-back-sync-menu-'))
  const env = { HYP_HOME: hypHome }
  /** @type {string[]} */
  const screens = []
  let confirmCalls = 0
  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env,
    candidates: [descriptor('claude')],
    confirm: async () => {
      screens.push('gate')
      confirmCalls += 1
      return confirmCalls === 1 ? 'customize' : 'accept'
    },
    prompt: async (/** @type {any} */ q) => {
      screens.push('menu')
      assert.equal(q.allowBack, true)
      throw new PromptBackRequestedError()
    },
  }))
  assert.deepEqual(screens, ['gate', 'menu', 'gate'])
  assert.deepEqual(result, { optedOut: [] })
})

// --- the orchestrator: step-level edges ---

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
 * Base options mirroring index.test.js: every phase scripted.
 * @param {Record<string, any>} over
 */
async function wizardOpts(over = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-back-wizard-'))
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
    pick: async () => pickResult(),
    syncScope: async () => ({ optedOut: [] }),
    configure: async () => ({ results: [] }),
    finaleRunner: async () => ({
      daemonInstall: { skipped: true, dryRun: false },
      globalInstall: { skipped: true, installed: false },
      attach: [],
      skillsInstalled: [],
      agentsInstalled: [],
      daemonRestart: { skipped: true, dryRun: false, ok: false },
      backfill: [],
    }),
    ...over,
  })
  for (const name of ['gate', 'fork', 'join', 'pick', 'syncScope', 'configure']) {
    const inner = opts[name]
    opts[name] = async (/** @type {any[]} */ ...a) => { calls.push(name); return inner(...a) }
  }
  return { opts, stdout, stderr, calls }
}

test('runInitWizard: a back from pick re-presents the fork', async () => {
  let pickCalls = 0
  const { opts, calls } = await wizardOpts({
    pick: async () => {
      pickCalls += 1
      if (pickCalls === 1) return /** @type {any} */ ({ ...pickResult(), back: true })
      return pickResult()
    },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(calls.filter((c) => c === 'fork' || c === 'pick'), ['fork', 'pick', 'fork', 'pick'])
})

// @ref LLP 0191#join-not-undone [tests]:
test('runInitWizard: back past a completed join reuses it instead of re-running the login', async () => {
  let pickCalls = 0
  const { opts, stdout, calls } = await wizardOpts({
    fork: async () => 'team',
    pick: async () => {
      pickCalls += 1
      if (pickCalls === 1) return /** @type {any} */ ({ ...pickResult(), back: true })
      return pickResult()
    },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(result.pathway, 'team')
  assert.equal(calls.filter((c) => c === 'join').length, 1, 'the login ran once')
  assert.match(stdout.text(), /Already signed in - continuing\./)
})

test('runInitWizard: a back from sync re-runs pick seeded with the confirmed selection', async () => {
  let syncCalls = 0
  /** @type {any[]} */
  const pickOpts = []
  const { opts, calls } = await wizardOpts({
    fork: async () => 'team',
    pick: async (/** @type {any} */ o) => { pickOpts.push(o); return pickResult({ sourcesPicked: ['claude'] }) },
    syncScope: async (/** @type {any} */ o) => {
      assert.equal(o.allowBack, true, 'the sync lane always has the pick lane behind it')
      syncCalls += 1
      if (syncCalls === 1) return { back: true, optedOut: [] }
      return { optedOut: [] }
    },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(calls.filter((c) => c === 'pick' || c === 'syncScope'),
    ['pick', 'syncScope', 'pick', 'syncScope'])
  assert.equal(pickOpts[0].initialSelection, undefined, 'the first pass detects')
  assert.deepEqual(pickOpts[1].initialSelection, ['claude'], 'the re-entry is seeded, not re-detected')
})

test('runInitWizard: a back from the fork re-presents the returning gate', async () => {
  let forkCalls = 0
  /** @type {any[]} */
  const forkOpts = []
  const { opts, calls } = await wizardOpts({
    gate: async () => ({ action: 'reconfigure', managed: false, report: {} }),
    fork: async (/** @type {any} */ o) => {
      forkOpts.push(o)
      forkCalls += 1
      return forkCalls === 1 ? 'back' : 'local'
    },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(calls.filter((c) => c === 'gate').length, 2, 'back at the fork re-runs the gate')
  assert.equal(forkOpts[0].allowBack, true, 'a reconfigure run has a gate screen to back into')
})

test('runInitWizard: a first-run fork has no gate screen and offers no back', async () => {
  /** @type {any[]} */
  const forkOpts = []
  const { opts } = await wizardOpts({
    fork: async (/** @type {any} */ o) => { forkOpts.push(o); return 'local' },
  })
  await runInitWizard(opts)
  assert.equal(forkOpts[0].allowBack, undefined)
})

test('runInitWizard: interactive pick lanes are offered back; non-interactive are not', async () => {
  /** @type {any[]} */
  const pickOpts = []
  const { opts } = await wizardOpts({
    pick: async (/** @type {any} */ o) => { pickOpts.push(o); return pickResult() },
  })
  await runInitWizard(opts)
  assert.equal(pickOpts[0].allowBack, true)

  const { opts: scripted } = await wizardOpts({
    pick: async (/** @type {any} */ o) => { pickOpts.push(o); return pickResult() },
    picks: { sources: ['claude'], exportChoice: 'local-parquet', retentionDays: 30 },
  })
  await runInitWizard(scripted)
  assert.equal(pickOpts[1].allowBack, undefined, 'back-navigation is attended-only')
})

// A join whose org-config converge timed out returns `status: 'ok'` with no
// `managed` (nothing landed to lock), yet the sign-in completed and the
// machine is enrolled. Keying the enrolled-state decisions on `managed`
// let that run step back to the fork, choose Local, and finish with neither
// the disconnect question nor the sync lane - silently default-syncing.
// @ref LLP 0191#join-not-undone [tests]: choosing Local after a completed join keeps the disconnect offer and the sync lane even when the join locked nothing
test('runInitWizard: a join that locked nothing still counts as enrolled when backing to local', async () => {
  let forkCalls = 0
  let pickCalls = 0
  /** @type {any[]} */
  const confirmed = []
  /** @type {any[]} */
  const pickOpts = []
  const { opts, calls } = await wizardOpts({
    // The converge-timeout return: ok, nothing locked, no `managed`.
    join: async () => ({ status: 'ok', lockedSources: [] }),
    fork: async () => {
      forkCalls += 1
      return forkCalls === 1 ? 'team' : 'local'
    },
    pick: async (/** @type {any} */ o) => {
      pickOpts.push(o)
      pickCalls += 1
      if (pickCalls === 1) return /** @type {any} */ ({ ...pickResult(), back: true })
      return pickResult()
    },
    confirm: async (/** @type {any} */ q) => { confirmed.push(q); return 'stay' },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(result.pathway, 'local')
  assert.equal(confirmed.length, 1, 'the disconnect question is asked once')
  assert.match(confirmed[0].title, /Disconnect and go local-only\?/)
  assert.equal(
    calls.filter((c) => c === 'syncScope').length,
    1,
    'the enrolled machine is still asked what syncs'
  )
  assert.equal(
    pickOpts[1].retentionDefault,
    undefined,
    'an enrolled machine keeps the team retention default, not the solo 120-day one'
  )
})

// The same run, but the user takes the disconnect: `hyp leave` clears the
// remembered join, so the rest of the run is a true solo install.
// @ref LLP 0191#join-not-undone [tests]: the fork's explicit disconnect is the one exit, and it drops the sync lane with the enrollment
test('runInitWizard: disconnecting after a join that locked nothing drops the sync lane', async () => {
  let forkCalls = 0
  let pickCalls = 0
  /** @type {any[]} */
  const pickOpts = []
  const { opts, calls } = await wizardOpts({
    join: async () => ({ status: 'ok', lockedSources: [] }),
    fork: async () => {
      forkCalls += 1
      return forkCalls === 1 ? 'team' : 'local'
    },
    pick: async (/** @type {any} */ o) => {
      pickOpts.push(o)
      pickCalls += 1
      if (pickCalls === 1) return /** @type {any} */ ({ ...pickResult(), back: true })
      return pickResult()
    },
    confirm: async () => 'disconnect',
    leave: async () => 0,
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(result.pathway, 'local')
  assert.equal(calls.filter((c) => c === 'syncScope').length, 0, 'a disconnected run has nothing to sync')
  assert.equal(
    pickOpts[1].retentionDefault,
    LOCAL_INSTALL_RETENTION_DAYS,
    'a true solo install keeps the longer local retention window'
  )
})
