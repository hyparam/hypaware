// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runInitWizard } from '../../../../src/core/cli/wizard/index.js'
import { writeFirstSyncHoldMarker } from '../../../../src/core/usage-policy/first_sync_hold.js'

// The wizard orchestrator (LLP 0135 #orchestration): gate short-circuits,
// the fork/join loop, phase threading (locked/managed/scoped), the
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
  for (const name of ['gate', 'fork', 'join', 'pick', 'configure']) {
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

test('runInitWizard: scoped re-entry skips the fork and picks scoped + managed', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'scoped-reconfigure', managed: true, report: {} }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.ok(!calls.includes('fork'))
  assert.ok(!calls.includes('join'))
  assert.equal(opts._pickOpts.scoped, true)
  assert.equal(opts._pickOpts.managed, true)
  assert.equal(result.pathway, 'scoped')
})

// --- the fork/join loop ---

test('runInitWizard: local pathway runs pick -> configure -> finale, no join', async () => {
  const { opts, calls } = wizardOpts(await tmpHome())
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(calls, ['gate', 'fork', 'pick', 'configure', 'finale'])
  assert.equal(result.pathway, 'local')
  assert.equal(opts._pickOpts.managed, undefined)
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
  const { LOGIN_ORG_SELECTION_MESSAGE } = await import('../../../../src/core/cli/remote_commands.js')
  const forkChoices = ['team', 'local']
  const { opts, stderr } = wizardOpts(await tmpHome(), {
    fork: async () => forkChoices.shift(),
    join: async () => ({ status: 'failed', detail: `hyp remote login: ${LOGIN_ORG_SELECTION_MESSAGE}\n` }),
  })
  const result = await runInitWizard(opts)
  assert.equal(result.pathway, 'local')
  assert.match(stderr.text(), /hyp remote login --org <name>/)
  assert.doesNotMatch(stderr.text(), /admin needs to grant/)
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
  assert.match(stderr.text(), /hyp init: cancelled/)
})

// --- run summary + privacy narration ---

test('runInitWizard: prints the run summary with the written config path', async () => {
  const { opts, stdout } = wizardOpts(await tmpHome())
  await runInitWizard(opts)
  assert.match(stdout.text(), /✓ Wrote \/tmp\/x\/config\.json/)
  assert.match(stdout.text(), /next: hyp query sql/)
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
  assert.match(text, /Nothing has been uploaded yet/)
  assert.match(text, /hypaware-privacy/)
  assert.match(text, /hyp status/)
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
