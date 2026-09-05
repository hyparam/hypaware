// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions, HypAwareStatusReport } from '../../src/core/daemon/types.js' */

// Issue #1392. `status.json` outlives the process that wrote it, so a machine
// with no daemon running still has a snapshot saying `state: 'healthy'`. The
// `daemon:` line printed that word with no tense, which put a stopped machine's
// last recorded boot verdict in the present tense next to `overall: degraded`.
// LLP 0348 already says what that value is - a record of what happened, not a
// claim about now - so the line has to read that way too. The machine surfaces
// are untouched: `daemon.state` in `--json` and the `daemon_state` span
// attribute are the record, and `daemon.running` sits beside both.

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-daemon-state-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * Stub the launch-agent probe so this machine's real daemon install cannot
 * leak in; liveness then comes from the pid file alone.
 *
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

/** @param {HypAwareStatusReport} report */
function daemonLine(report) {
  let out = ''
  const stdout = /** @type {any} */ ({
    write: (/** @type {string} */ chunk) => { out += String(chunk); return true },
  })
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/cache', stdout })
  const line = out.split('\n').find((l) => l.startsWith('  daemon:'))
  assert.ok(line, 'the report has a daemon line')
  return line
}

test('a stopped daemon\'s recorded state is printed as a record, not as a claim about now', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // No pid file: the snapshot is all that is left of a daemon that has exited.
  writeStatusFile(stateRoot, /** @type {any} */ ({ state: 'healthy', sources: [], sinks: [] }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.running, false, 'nothing is running')
  assert.equal(report.daemon.state, 'healthy', 'and the collector still carries the snapshot value')

  const line = daemonLine(report)
  assert.match(line, /not running/)
  assert.match(line, /last state=healthy/, 'the state is marked as the last one recorded')
  assert.doesNotMatch(line, /(?<!last )state=healthy/, 'and never reads as a present-tense claim')

  // The machine plane is the record, and is deliberately unchanged: a consumer
  // pinning `daemon.state` keeps the value, with `daemon.running: false` beside
  // it to say what tense it is in.
  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/cache' })
  assert.equal(json.daemon.state, 'healthy')
  assert.equal(json.daemon.running, false)
})

// The over-fixing guard. A live process's state is a claim about now, which is
// exactly what LLP 0348 made it, so that line keeps the tense it had.
test('a running daemon keeps the present-tense state line', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  // Production-shaped, so the collector's verdict is what answers here: a real
  // snapshot carries the writing process's pid and the `healthyAt + uptimeMs`
  // pair LLP 0348 reads as the heartbeat. Without them the pid gate and the
  // heartbeat both short-circuit, and the case would pass with the verdict
  // deleted.
  const healthyAt = new Date(Date.now() - 1000).toISOString()
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    pid: process.pid,
    startedAt: healthyAt,
    healthyAt,
    uptimeMs: 1000,
    sources: [],
    sinks: [],
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.running, true)
  const line = daemonLine(report)
  assert.match(line, /running, state=healthy/)
  assert.doesNotMatch(line, /last state=/)
})

// LLP 0351's thread to pull. A daemon that wedged before it ever reached
// `healthy` is alive, so its `degraded` / `starting` snapshot is still the one
// signal an operator has while `overall` stays quiet: it must not be softened
// into a historical note.
test('a live daemon that never reached healthy still states its snapshot in the present tense', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  // Production-shaped too: a daemon that never reached `healthy` writes its
  // pid and `uptimeMs: 0` with no `healthyAt`, so the heartbeat is null by
  // design (LLP 0351's gap) and the pid gate is the check that actually runs.
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'starting',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    uptimeMs: 0,
    sources: [],
    sinks: [],
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const line = daemonLine(report)
  assert.match(line, /running, state=starting/)
  assert.doesNotMatch(line, /last state=/)
})
