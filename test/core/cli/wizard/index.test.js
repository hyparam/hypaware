// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runInitWizard } from '../../../../src/core/cli/wizard/index.js'
import { writeFirstSyncHoldMarker } from '../../../../src/core/usage-policy/first_sync_hold.js'
import { OVERVIEW_PROBE_SQL } from '../../../../src/core/query/overview.js'

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
    syncScope: async (/** @type {any} */ o) => { opts._syncOpts = o; return { optedOut: [] } },
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
  for (const name of ['gate', 'fork', 'join', 'pick', 'syncScope', 'configure']) {
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
// "disconnect" or "adjust while staying connected" (LLP 0185
// #fork-disconnect). Yes runs hyp leave; no and cancel keep enrollment.
// @ref LLP 0185#fork-disconnect [tests]:

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

test('runInitWizard: cancelling the disconnect question returns to the fork', async () => {
  const { PromptCancelledError } = await import('../../../../src/core/cli/tui/runtime.js')
  const forkChoices = ['local', 'quit']
  let leaveRan = false
  const { opts, calls } = wizardOpts(await tmpHome(), {
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    fork: async () => forkChoices.shift(),
    confirm: async () => { throw new PromptCancelledError() },
    leave: async () => { leaveRan = true; return 0 },
  })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.equal(leaveRan, false)
  assert.equal(calls.filter((c) => c === 'fork').length, 2)
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

// --- the fork/join loop ---

// --- the sync-scope step (LLP 0181 #never-silent) ---

test('runInitWizard: the team pathway runs the sync-scope step between pick and configure', async () => {
  const { opts, calls } = wizardOpts(await tmpHome(), { fork: async () => 'team' })
  const result = await runInitWizard(opts)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(calls, ['gate', 'fork', 'join', 'pick', 'syncScope', 'configure', 'finale'])
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

// --- deferred config commit (LLP 0185 #commit-point) ---
// The pick lane composes; the orchestrator commits after the sync lane, so
// the overwrite confirm is the last question and a cancel at the sync lane
// leaves the existing config untouched.
// @ref LLP 0185#commit-point [tests]:

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
// @ref LLP 0185#abort-narration [tests]:

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
  assert.match(text, /hyp policy client <name> local-only/)
  assert.match(text, /Nothing has been uploaded yet/)
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
  assert.match(stderr.text(), /hyp init: cancelled/)
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
  // The window probe, then one query per section: setup shows the same
  // block as `hyp query overview`.
  assert.equal(stub.seen[0], OVERVIEW_PROBE_SQL)
  assert.equal(stub.seen.length, 5)
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
