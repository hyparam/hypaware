// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

import { collectHypAwareStatus, statusFilePath, writeStatusFile } from '../../src/core/daemon/status.js'
import { runDaemon } from '../../src/core/daemon/runtime.js'
import { renderStatusText } from '../../src/core/commands/status.js'
import { defaultUnitDir, unitFileName } from '../../src/core/daemon/platform.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions, DaemonState, DaemonStatus, HypAwareStatusReport } from '../../src/core/daemon/types.js' */

// Issue #1391. `hyp daemon stop` never touches the service manager (it rides
// the control file), and `loaded` is a bootstrap fact independent of whether
// anything is running, so "installed, loaded, not running" is the state left
// by a deliberate stop *and* by a daemon that died under a unit the service
// manager is still holding. The pair of live facts cannot tell those apart;
// the daemon's own last snapshot can, because an orderly shutdown writes
// `state: 'stopped'` before the process leaves and a crash never gets to.
//
// @ref LLP 0383#the-signal-is-the-daemons-last-state [tests]: a crash and a deliberate stop leave the same three live facts and differ only in the snapshot's terminal state

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-exited-abnormally-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  // The unit file on disk is what `installed` is read from, so it is real here.
  const unitDir = defaultUnitDir(hypHome)
  await fs.mkdir(unitDir, { recursive: true })
  await fs.writeFile(path.join(unitDir, unitFileName()), '[Unit]\nDescription=HypAware\n')
  return { hypHome, stateRoot }
}

/**
 * The snapshot a daemon leaves behind, ending in `state`. `stopped` is what an
 * orderly shutdown persists last; anything else is where the process was when
 * it stopped writing.
 *
 * @param {string} stateRoot
 * @param {DaemonState} state
 * @param {{ writtenMsAgo?: number }} [opts] how long ago the snapshot was last
 *   written, when the test needs that readable
 */
function leaveSnapshot(stateRoot, state, opts = {}) {
  /** @type {DaemonStatus} */
  const status = {
    state,
    pid: 999999,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    uptimeMs: 60_000,
    runId: 'test-run',
    mode: 'detached',
    sources: [],
    sinks: [],
  }
  if (typeof opts.writtenMsAgo === 'number') {
    // `healthyAt + uptimeMs` is the moment of the last persist (LLP 0348
    // #heartbeat-is-derived), so this puts that write where the test wants it.
    status.healthyAt = new Date(Date.now() - opts.writtenMsAgo - 60_000).toISOString()
    status.uptimeMs = 60_000
  }
  writeStatusFile(stateRoot, status)
}

/**
 * The unit-file probe is the real one. Only the systemctl query is stubbed, to
 * the answer a service manager still holding a unit with nothing under it
 * gives: loaded, no pid.
 *
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'linux',
    homeDir: hypHome,
    systemdUnitStatus: async () => ({ loaded: true }),
  }
}

/** @param {HypAwareStatusReport} report */
function renderText(report) {
  let out = ''
  const stdout = /** @type {any} */ ({
    write: (/** @type {string} */ chunk) => { out += String(chunk); return true },
  })
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/cache', stdout })
  return out
}

test('a daemon that died under a still-loaded unit is not reported healthy', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // The daemon was up and serving when it stopped writing: no shutdown ran.
  leaveSnapshot(stateRoot, 'healthy')

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.installed, true)
  assert.equal(report.daemon.loaded, true, 'the service manager is still holding the unit')
  assert.equal(report.daemon.running, false, 'and nothing is capturing')
  assert.notEqual(report.overall, 'healthy', 'a machine capturing nothing must not call itself healthy')

  const diag = report.diagnostics.find((d) => d.kind === 'daemon_exited_abnormally')
  assert.ok(diag, 'the abnormal exit is named')
  assert.equal(diag.severity, 'error')
  assert.match(diag.message, /healthy/, 'the message states the recorded state it read')
  assert.deepEqual(diag.repair, ['hyp daemon restart'])

  const text = renderText(report)
  assert.doesNotMatch(text, /overall:\s+healthy/)
})

// The same shape after a boot that never finished: `starting` is where a
// daemon that died inside `bootKernel` left its snapshot, and it is no more a
// completed stop than `healthy` is.
test('a daemon that died before it finished booting is not reported healthy', async () => {
  const { hypHome, stateRoot } = await makeHome()
  leaveSnapshot(stateRoot, 'starting')

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.notEqual(report.overall, 'healthy')
  assert.equal(report.diagnostics.find((d) => d.kind === 'daemon_exited_abnormally')?.severity, 'error')
})

// The over-fixing guard, and the whole reason the live facts are not enough.
// `hyp daemon stop` leaves exactly the state above: installed, loaded, not
// running. It must stay healthy.
test('a deliberately stopped daemon stays healthy', async () => {
  const { hypHome, stateRoot } = await makeHome()
  leaveSnapshot(stateRoot, 'stopped')

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.installed, true)
  assert.equal(report.daemon.loaded, true)
  assert.equal(report.daemon.running, false)
  assert.equal(report.overall, 'healthy', 'a stop the operator asked for is not a fault')
  assert.equal(report.diagnostics.find((d) => d.kind === 'daemon_exited_abnormally'), undefined)

  const text = renderText(report)
  assert.match(text, /overall:\s+healthy/)
})

// The second over-fixing guard. A fresh install that has never run has no
// snapshot at all, so there is no exit to call abnormal.
test('an installed daemon that has never run stays healthy', async () => {
  const { hypHome } = await makeHome()

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.loaded, true)
  assert.equal(report.daemon.running, false)
  assert.equal(report.overall, 'healthy', 'nothing has run, so nothing exited')
  assert.equal(report.diagnostics.find((d) => d.kind === 'daemon_exited_abnormally'), undefined)
})

// Issue #1409. `shutdown()` persists `stopping` as its first statement, so a
// process killed anywhere across shutdown leaves that snapshot behind for good,
// and LLP 0383 read it as a stop that ran. The unit is still loaded and nothing
// is capturing, so a machine in that state called itself healthy forever. What
// says the stop never finished is the snapshot's age: nothing wrote to it since.
//
// @ref LLP 0384#stopping-is-a-claim-with-an-expiry [tests]: a terminal `stopping` snapshot older than the heartbeat window is a stop that never finished
test('a shutdown killed before it completed is not reported healthy once its snapshot goes stale', async () => {
  const { hypHome, stateRoot } = await makeHome()
  leaveSnapshot(stateRoot, 'stopping', { writtenMsAgo: 30 * 60_000 })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.loaded, true, 'the service manager is still holding the unit')
  assert.equal(report.daemon.running, false, 'and nothing is capturing')
  assert.notEqual(report.overall, 'healthy', 'a stop that never completed is not a completed stop')

  const diag = report.diagnostics.find((d) => d.kind === 'daemon_exited_abnormally')
  assert.ok(diag, 'the abandoned stop is named')
  assert.equal(diag.severity, 'error')
  assert.match(diag.message, /recorded 'stopping' 30m ago/, 'the message states how long ago it was written')
  assert.match(diag.message, /the stop began but never completed/)
  assert.doesNotMatch(diag.message, /exited without shutting down/, 'a shutdown did begin')
  assert.deepEqual(diag.repair, ['hyp daemon restart'])

  const text = renderText(report)
  assert.doesNotMatch(text, /overall:\s+healthy/)
})

// The over-fixing guard, and the reason the signal is an age rather than the
// state alone. A stop in progress is spent with the process alive, so the
// closest a probe gets is the race where the file is read just before the
// process probe and the `stopped` write lands between the two, which leaves a
// `stopping` snapshot seconds old.
test('a stop that has only just begun raises nothing', async () => {
  const { hypHome, stateRoot } = await makeHome()
  leaveSnapshot(stateRoot, 'stopping', { writtenMsAgo: 2_000 })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.loaded, true)
  assert.equal(report.daemon.running, false)
  assert.equal(report.overall, 'healthy', 'a stop the operator asked for is still under way')
  assert.equal(report.diagnostics.find((d) => d.kind === 'daemon_exited_abnormally'), undefined)
})

// LLP 0383's named-forwards rule in the time dimension. A snapshot with no
// readable last-write time (no `healthyAt`, so the daemon was killed while
// stopping before it ever reached `healthy`, which is also how an older build's
// file reads) has an unreadable age, not a stale one.
test('a stopping snapshot whose age cannot be derived stays healthy', async () => {
  const { hypHome, stateRoot } = await makeHome()
  leaveSnapshot(stateRoot, 'stopping')

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.loaded, true)
  assert.equal(report.daemon.running, false)
  assert.equal(report.overall, 'healthy', 'an unreadable age is not evidence of anything')
  assert.equal(report.diagnostics.find((d) => d.kind === 'daemon_exited_abnormally'), undefined)
})

// That guard is only worth anything if the daemon reaches `stopping` before
// the parts of shutdown that can hold it open for minutes: `await
// maintenanceInFlight` and `await reconcileScheduler.settle()`, which waits
// out a `hyp backfill` import by design. A snapshot still reading `healthy`
// through that window would report a crash for a stop the operator asked for.
// Read synchronously, so it can only pass if the write precedes every `await`
// in `shutdown()`.
test('the daemon records the stop before anything that can block its shutdown', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-shutdown-records-stop-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  const configPath = defaultConfigPath(hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }) + '\n')

  const handle = await runDaemon({
    hypHome,
    configPath,
    env: { ...process.env, HYP_HOME: hypHome },
    runId: 'shutdown-records-stop-test',
    tickIntervalMs: 0,
    installSignalHandlers: false,
  })
  try {
    const stopping = handle.stop()
    const snapshot = JSON.parse(readFileSync(statusFilePath(stateRoot), 'utf8'))
    assert.equal(snapshot.state, 'stopping', 'the stop is on disk before shutdown can block')
    await stopping
    await handle.done
    assert.equal(JSON.parse(readFileSync(statusFilePath(stateRoot), 'utf8')).state, 'stopped')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
