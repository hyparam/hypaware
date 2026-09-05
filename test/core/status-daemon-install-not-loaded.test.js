// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { installSystemdUnit } from '../../src/core/daemon/linux.js'
import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusText } from '../../src/core/commands/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions, HypAwareStatusReport, SystemctlAdapter, SystemctlResult } from '../../src/core/daemon/types.js' */

// Issue #1387. `installSystemdUnit` writes the unit file before it runs
// `daemon-reload`, so a service-manager step that fails leaves the file on
// disk. `hyp status` reads that file's presence as `installed`, finds nothing
// loaded and no process, and still printed `overall: healthy` next to
// `daemon: installed, not loaded, not running`: a machine capturing nothing
// calling itself healthy.

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-install-not-loaded-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/** @returns {SystemctlResult} */
function failed() {
  return { exitCode: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' }
}

/**
 * A systemctl that is not there: every call fails, which is what a session
 * with no running systemd user instance gives.
 *
 * @type {SystemctlAdapter}
 */
const brokenSystemctl = {
  async daemonReload() { return failed() },
  async enable() { return failed() },
  async disable() { return failed() },
  async start() { return failed() },
  async stop() { return failed() },
  async restart() { return failed() },
  async status() { return failed() },
  async show() { return failed() },
}

/**
 * Run the real installer against that broken service manager, and return the
 * unit path the failed install left behind.
 *
 * @param {string} hypHome
 * @returns {Promise<string>}
 */
async function installAgainstBrokenSystemctl(hypHome) {
  const unitDir = path.join(hypHome, '.config', 'systemd', 'user')
  await assert.rejects(() => installSystemdUnit({
    binPath: path.join(hypHome, 'bin', 'hypaware'),
    configPath: defaultConfigPath(hypHome),
    homeDir: hypHome,
    unitDir,
    logDir: path.join(hypHome, 'hypaware', 'logs'),
    systemctl: brokenSystemctl,
  }), /daemon-reload/)
  return path.join(unitDir, 'hypaware.service')
}

/**
 * The unit-file probe is the real one, because the file on disk is the
 * evidence. Only the systemctl query is stubbed, to the answer a service
 * manager that never reloaded gives.
 *
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'linux',
    homeDir: hypHome,
    systemdUnitStatus: async () => ({ loaded: false }),
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

test('a daemon install whose service-manager step failed is not reported healthy', async () => {
  const { hypHome } = await makeHome()
  const unitPath = await installAgainstBrokenSystemctl(hypHome)
  // Ground truth for the fault: the failed install still left the unit file.
  await fs.access(unitPath)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.installed, true, 'the unit file on disk reads as installed')
  assert.equal(report.daemon.loaded, false)
  assert.equal(report.daemon.running, false, 'and nothing is capturing')
  assert.notEqual(report.overall, 'healthy', 'a machine capturing nothing must not call itself healthy')

  const diag = report.diagnostics.find((d) => d.kind === 'daemon_loaded_no_pid')
  assert.ok(diag, 'the unfinished install is named')
  assert.equal(diag.severity, 'error')

  const text = renderText(report)
  assert.match(text, /daemon:\s+installed, not loaded, not running/)
  assert.doesNotMatch(text, /overall:\s+healthy/)
})

// The over-fixing guard. An unloaded unit alongside a live foreground daemon
// is a machine that is capturing: it keeps the warning it already had, and
// `overall` is untouched.
test('an unloaded unit with a foreground daemon running stays healthy', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await installAgainstBrokenSystemctl(hypHome)
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'test-run', mode: 'foreground' }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.installed, true)
  assert.equal(report.daemon.loaded, false)
  assert.equal(report.daemon.running, true)
  assert.equal(report.overall, 'healthy')
  assert.equal(report.diagnostics.find((d) => d.kind === 'daemon_loaded_no_pid')?.severity, 'warning')
})
