// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'

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
    folderAsk: async () => ({ mode: 'sync' }),
    // The express gate (LLP 0201) fronts the lanes; these tests walk the
    // back edges between them, so it declines by default.
    express: async () => 'choose',
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
  for (const name of ['gate', 'fork', 'join', 'pick', 'syncScope', 'folderAsk', 'express', 'configure']) {
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

/**
 * A catalog with one picker row, so `expressRowsSafe` finds something to
 * accept and the express gate is actually shown. With the default empty
 * catalog there is nothing to accept and no gate at all (LLP 0201
 * #no-default-no-accept), which is a different back chain.
 */
function gatedOverrides() {
  return {
    fork: async () => 'team',
    detect: async () => new Set(['claude']),
    catalog: /** @type {any} */ ({
      plugins: new Map(),
      pluginMetadata: new Map(),
      knownDatasets: new Set(),
      clientDescriptors: new Map(),
      pickerDescriptors: new Map([['claude', { id: 'claude', label: 'Claude Code', plugin: '@hypaware/claude' }]]),
    }),
  }
}

// The express gate is a screen, so it is on the back chain like any other:
// the lane behind it steps back *to it*, not past it to the fork. Without
// this, inserting a question into the forward chain silently made its
// neighbour overshoot by one screen.
// @ref LLP 0191#back-edges [tests]: escape steps exactly one screen back, express gate included
test('runInitWizard: a back from pick re-presents the express gate, not the fork', async () => {
  let pickCalls = 0
  const { opts, calls } = await wizardOpts({
    ...gatedOverrides(),
    pick: async () => {
      pickCalls += 1
      if (pickCalls === 1) return /** @type {any} */ ({ ...pickResult(), back: true })
      return pickResult()
    },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(
    calls.filter((c) => c === 'fork' || c === 'express' || c === 'pick'),
    ['fork', 'express', 'pick', 'express', 'pick'],
    'the gate is re-presented once; the fork is not'
  )
})

// @ref LLP 0191#back-edges [tests]: the sync lane backs to the picker, not past it to the express gate
test('runInitWizard: a back from sync re-presents pick without re-asking the express gate', async () => {
  let syncCalls = 0
  const { opts, calls } = await wizardOpts({
    ...gatedOverrides(),
    syncScope: async () => {
      syncCalls += 1
      if (syncCalls === 1) return { back: true, optedOut: [] }
      return { optedOut: [] }
    },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(
    calls.filter((c) => c === 'express' || c === 'pick' || c === 'syncScope'),
    ['express', 'pick', 'syncScope', 'pick', 'syncScope'],
    'the gate is asked once per pass through the lanes, and a sync back is not a new pass'
  )
})

// @ref LLP 0201#no-default-no-accept [tests]: with no gate shown, pick's back edge still reaches the fork
test('runInitWizard: with nothing to accept there is no gate, and pick backs straight to the fork', async () => {
  let pickCalls = 0
  const { opts, calls } = await wizardOpts({
    fork: async () => 'team',
    pick: async () => {
      pickCalls += 1
      if (pickCalls === 1) return /** @type {any} */ ({ ...pickResult(), back: true })
      return pickResult()
    },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(calls.filter((c) => c === 'express').length, 0, 'nothing detected, nothing locked, no gate')
  assert.deepEqual(calls.filter((c) => c === 'fork' || c === 'pick'), ['fork', 'pick', 'fork', 'pick'])
})

// A lane that narrates instead of asking is not a screen, so escape has to
// step past it. The sync lane asks nothing when everything picked is
// fleet-locked (and nothing when the client store is corrupt): backing
// "into" it re-ran it and re-asked the new-folder question, so escape at
// the folders lane became a redraw with no exit but ctrl+c.
// @ref LLP 0191#back-edges [tests]: escape past a lane that rendered a statement rather than a question reaches the picker
test('runInitWizard: a back from folders skips a sync lane that asked nothing and reaches pick', async () => {
  let folderCalls = 0
  const { opts, calls } = await wizardOpts({
    ...gatedOverrides(),
    // The fully fleet-managed shape: every picked row is locked, so the
    // real lane's `candidates` list is empty and it only states its outcome.
    syncScope: async (/** @type {any} */ o) => {
      assert.deepEqual(o.candidates, [], 'nothing is left for this lane to ask about')
      return { optedOut: [], noQuestion: true }
    },
    folderAsk: async () => {
      folderCalls += 1
      if (folderCalls === 1) return /** @type {any} */ ({ back: true, mode: 'sync' })
      return { mode: 'sync' }
    },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(
    calls.filter((c) => c === 'pick' || c === 'syncScope' || c === 'folderAsk'),
    ['pick', 'syncScope', 'folderAsk', 'pick', 'syncScope', 'folderAsk'],
    'escape reaches the picker, the last screen the user could answer'
  )
})

// The same edge for the lane that does ask: a sync lane with a question
// behind it is still where a folders back lands.
// @ref LLP 0191#back-edges [tests]: a sync lane that asked is the screen behind the folders lane
test('runInitWizard: a back from folders re-presents a sync lane that did ask', async () => {
  let folderCalls = 0
  const { opts, calls } = await wizardOpts({
    ...gatedOverrides(),
    folderAsk: async () => {
      folderCalls += 1
      if (folderCalls === 1) return /** @type {any} */ ({ back: true, mode: 'sync' })
      return { mode: 'sync' }
    },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(
    calls.filter((c) => c === 'pick' || c === 'syncScope' || c === 'folderAsk'),
    ['pick', 'syncScope', 'folderAsk', 'syncScope', 'folderAsk'],
    'the picker is two screens back, not one'
  )
})

// The gate's rows are the picker's own confirmed defaults, so a confirmed
// empty selection leaves nothing to accept and the gate cannot render on
// the pass a pick-back opens. Falling forward into the picker again would
// make that escape a redraw; the screen behind an unshowable gate is the
// fork.
// @ref LLP 0201#edges [tests]: a back into a gate this pass cannot show reaches the fork instead of re-opening the picker
test('runInitWizard: a back from pick reaches the fork when the confirmed picks leave the gate empty', async () => {
  let pickCalls = 0
  let syncCalls = 0
  let forkCalls = 0
  const { opts, calls } = await wizardOpts({
    ...gatedOverrides(),
    fork: async () => { forkCalls += 1; return 'team' },
    pick: async () => {
      pickCalls += 1
      // 1: confirm an empty selection, so the seed the next gate pass would
      // list is empty. 2: escape out of the re-entered lane.
      if (pickCalls === 1) return pickResult({ sourcesPicked: [] })
      if (pickCalls === 2) return /** @type {any} */ ({ ...pickResult(), back: true })
      return pickResult()
    },
    syncScope: async () => {
      syncCalls += 1
      // One back, to re-enter the picker with the empty selection standing.
      if (syncCalls === 1) return { back: true, optedOut: [] }
      return { optedOut: [] }
    },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(forkCalls, 2, 'one escape, one step: the fork is what is behind a gate with no rows')
  assert.deepEqual(
    calls.filter((c) => c === 'fork' || c === 'express' || c === 'pick'),
    ['fork', 'express', 'pick', 'pick', 'fork', 'pick'],
    'the escape out of the re-entered picker steps to the fork, never back into the picker itself'
  )
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

// Ctrl+C at the disconnect question is a cancel, not a back-step: sharing
// the back arm's `continue` re-presented the fork, so "get me out" became
// the first of two keystrokes - the exact shape LLP 0191 #esc-back says
// ctrl+c exists to avoid. Nothing is disconnected either way, which is all
// LLP 0190 #fork-disconnect requires of a cancel.
// @ref LLP 0191#esc-back [tests]: ctrl+c at the disconnect question ends the run rather than stepping back
test('runInitWizard: ctrl+c at the disconnect question cancels the run instead of re-presenting the fork', async () => {
  const { PromptCancelledError } = await import('../../../../src/core/cli/tui/runtime.js')
  let forkCalls = 0
  const { opts, stdout, stderr, calls } = await wizardOpts({
    join: async () => ({ status: 'ok', lockedSources: [] }),
    fork: async () => {
      forkCalls += 1
      if (forkCalls > 2) throw new Error('the fork must not be re-presented after a cancel')
      return forkCalls === 1 ? 'team' : 'local'
    },
    pick: async () => /** @type {any} */ ({ ...pickResult(), back: true }),
    confirm: async () => { throw new PromptCancelledError() },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 130)
  assert.equal(result.cancelled, true)
  assert.equal(forkCalls, 2, 'the fork ran once per pathway choice and never a third time')
  assert.match(stderr.text(), /hyp init: cancelled/)
  // The enrollment the cancel cannot undo is still narrated (LLP 0190
  // #abort-narration), and nothing was disconnected.
  assert.match(stdout.text(), /This machine is enrolled/)
  assert.equal(calls.filter((c) => c === 'syncScope').length, 0)
})

// --- one run, no lane stubs: keystrokes in, config out ---
//
// Every test above (and in index.test.js) tests one layer against a fake
// of the next: the orchestrator with `fork`/`pick`/`syncScope` scripted,
// the lanes with `prompt`/`confirm` injected. That is a legitimate unit
// scope, but it means no test ever executes the fork, pick and sync lanes
// *inside* an orchestrator run, and both bugs that reached review sat in
// exactly that gap - the enrolled-state divergence below, and a `runtime`
// arm every caller was tested against a hand-built error for.
//
// So: one run with no lane stubs. Only the two phases that would leave
// the machine (`join`'s browser login, `configure`/`firstLook`'s command
// execution) are replaced; the fork, the pick lane, the disconnect
// question, the sync lane and the config commit are the real ones, driven
// through the real readline prompt factories by scripted answers.
// @ref LLP 0191#back-edges [tests]: the back edges as the user meets them, from keystrokes to a written config

/**
 * A stdout that answers the wizard's own prompts: each time a readline
 * prompt line is written, the next scripted answer is pushed into stdin.
 * The prompt strings are the real ones (`fork.js`'s `Choose [...]`,
 * `walkthrough.js`'s `select ...` and overwrite confirm), so a change to
 * any of them fails here rather than hanging.
 *
 * @param {string[]} answers
 */
function scriptedIo(answers) {
  const input = new PassThrough()
  const pending = [...answers]
  let value = ''
  const PROMPTS = ['Choose [1-', 'select [', 'select (e.g.', 'Continue? [y/N]: ']
  return {
    stdin: input,
    pending,
    stdout: {
      /** @param {string} chunk */
      write(chunk) {
        const text = String(chunk)
        value += text
        if (text.endsWith(': ') && PROMPTS.some((p) => text.includes(p))) {
          const next = pending.shift()
          if (next !== undefined) input.write(`${next}\n`)
        }
        return true
      },
      text() { return value },
    },
  }
}

test('runInitWizard end-to-end: join, back to the fork, local, and the enrolled machine is still asked what syncs', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-wizard-e2e-'))
  const env = { HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_NO_TUI: '1', NO_COLOR: '1' }
  const io = scriptedIo([
    '1',    // fork: Collect shared agent logs
    '2',    // express gate: No, take me through the steps
    'b',    // pick menu: step back one screen - the express gate
    'b',    // express gate: step back one screen - the fork
    '2',    // fork: Collect agent logs locally
    '1',    // disconnect?: No, stay connected
    '2',    // express gate (asked again on this pass): step by step
    'all',  // pick menu: record everything offered
    '1',    // sync gate: Sync all
    '1',    // new folders: Sync them all
  ])
  const stderr = makeBuf()
  let joinCalls = 0

  const result = await runInitWizard(/** @type {any} */ ({
    stdout: io.stdout,
    stderr,
    stdin: io.stdin,
    env,
    ctx: /** @type {any} */ ({ commands: { run: async () => 0 } }),
    catalog: await realCatalog(),
    // The one lane that would leave the machine, in the shape that made
    // `managed` diverge from "enrolled": the sign-in completed, but the
    // org-config converge timed out, so nothing landed to lock.
    join: async () => { joinCalls += 1; return /** @type {any} */ ({ status: 'ok', lockedSources: [] }) },
    gate: async () => /** @type {any} */ ({ action: 'first-run', managed: false, report: {} }),
    // Detection is scripted, not probed: the express gate (LLP 0201) is
    // shown only when there is something to accept, so a run that read the
    // real machine would ask one fewer question on a host with no AI
    // clients installed than on the developer laptop that wrote this
    // script - and every scripted answer below would land on the wrong
    // prompt. The rows themselves do not matter here ('all' picks whatever
    // the menu offers); that there *are* rows does.
    detect: async () => new Set(['claude']),
    configure: async () => ({ results: [] }),
    // A fresh install has no cache, so the real first look would find no
    // dataset and print nothing; the stub says exactly that.
    firstLook: /** @type {any} */ ({ hasDataset: () => false }),
  }))

  assert.equal(result.exitCode, 0)
  assert.equal(result.pathway, 'local')
  assert.equal(joinCalls, 1, 'the remembered join is reused, never re-run')
  assert.equal(io.pending.length, 0, 'every scripted answer was consumed - no prompt was skipped')

  const out = io.stdout.text()
  // The back edge: the fork was presented twice, the second time after
  // `b` at the pick menu.
  assert.equal(out.split('How do you want to collect agent logs?').length - 1, 2)
  // Enrolled-state decisions survive the walk to the local pathway.
  assert.match(out, /This machine syncs to your team server\. Disconnect and go local-only\?/)
  assert.match(out, /These will sync to your server:/)
  // The itinerary is the enrolled one (pick, sync, folders, finish), not
  // the solo two-step local one: the denominator is the same `enrolled()`
  // read both enrolled lanes are gated on, so a regression there shows up
  // here too.
  assert.match(out, /Step 1 of 4 · Choose what to collect/)
  assert.match(out, /Step 2 of 4 · Choose what syncs/)
  assert.match(out, /Step 3 of 4 · Choose how new folders are handled/)

  // The run ended in a real config on disk, written after the last question.
  assert.match(String(result.configPath), /hypaware-config\.json$/)
  const written = JSON.parse(await fs.readFile(String(result.configPath), 'utf8'))
  assert.equal(written.version, 2)
  assert.ok(Array.isArray(written.plugins) && written.plugins.length > 0)
  assert.deepEqual(result.config, written)
})
