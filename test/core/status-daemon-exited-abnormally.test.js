// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
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
 */
function leaveSnapshot(stateRoot, state) {
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
