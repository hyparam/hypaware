// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  collectHypAwareStatus,
  daemonHeartbeatAgeMs,
  readStatusFile,
  writeStatusFile,
} from '../../src/core/daemon/status.js'
import { runDaemon } from '../../src/core/daemon/runtime.js'
import { defaultUnitDir, unitFileName } from '../../src/core/daemon/platform.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

/** @import { CollectStatusOptions, DaemonStatus } from '../../src/core/daemon/types.js' */

// Issue #1417. `healthyAt` was written only by a boot whose aggregate landed
// `healthy`, so a daemon that booted `degraded` carried none and a permanent
// `uptimeMs: 0` for its whole run. Every reader of the LLP 0348 heartbeat
// derivation therefore went quiet for that whole population: the live-pid
// staleness check, and LLP 0384's stalled-stop reading of a terminal
// `stopping` snapshot. Such a daemon killed mid-shutdown reported
// `overall: healthy` forever.
//
// @ref LLP 0386#serving-dates-the-write [tests]: a degraded boot dates its snapshot writes, so the heartbeat the readers derive exists for it too

const PLUGIN = '@third-party/refusing-source-fixture'

/**
 * Stage a plugin whose only source refuses to start, which is the boot the
 * runtime aggregates to `degraded`.
 *
 * @param {string} hypHome
 * @returns {Promise<string>}
 */
async function stageRefusingPlugin(hypHome) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', PLUGIN)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1,
    name: PLUGIN,
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }))
  await fs.writeFile(
    path.join(installDir, 'index.js'),
    `
export async function activate(ctx) {
  ctx.sources.register({
    name: 'refusing-fixture',
    plugin: '${PLUGIN}',
    async start() {
      throw new Error('fixture source refuses to start')
    },
  })
}
`
  )
  await writeLock(path.join(hypHome, 'hypaware'), {
    schema_version: 1,
    plugins: {
      [PLUGIN]: {
        name: PLUGIN,
        version: '0.1.0',
        source: { kind: 'local-dir', raw: installDir, path: installDir },
        install_dir: installDir,
        content_hash: 'a'.repeat(64),
        manifest_hash: 'b'.repeat(64),
        installed_at: '2026-09-05T00:00:00.000Z',
      },
    },
  })
  const configPath = defaultConfigPath(hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: PLUGIN, config: {} }],
  }))
  return configPath
}

/**
 * Boot a daemon whose only source fails, and return the snapshot it wrote at
 * boot plus the terminal `stopping` snapshot a kill anywhere across shutdown
 * would freeze on disk. `shutdown()` persists `stopping` as its first
 * statement, so reading it synchronously beside a stop in flight is reading
 * exactly the file such a kill leaves behind.
 *
 * @param {string} hypHome
 * @returns {Promise<{ atBoot: DaemonStatus, stopping: DaemonStatus }>}
 */
async function runDegradedDaemon(hypHome) {
  const stateRoot = path.join(hypHome, 'hypaware')
  const configPath = await stageRefusingPlugin(hypHome)
  const handle = await runDaemon({
    hypHome,
    configPath,
    env: { ...process.env, HYP_HOME: hypHome },
    runId: 'degraded-boot-heartbeat-test',
    tickIntervalMs: 0,
    installSignalHandlers: false,
  })
  const atBoot = readStatusFile(stateRoot)
  assert.ok(atBoot, 'the daemon must have written a boot snapshot')
  const stopping = handle.stop()
  const midShutdown = readStatusFile(stateRoot)
  await stopping
  await handle.done
  assert.ok(midShutdown, 'the stop must be on disk before shutdown can block')
  return { atBoot, stopping: midShutdown }
}

/**
 * A clean home holding nothing but an installed unit and the snapshot handed
 * in, so the only thing the collector can be reading is that snapshot.
 *
 * @param {DaemonStatus} snapshot
 * @returns {Promise<string>} the hypHome
 */
async function replaySnapshot(snapshot) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-degraded-boot-replay-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  const unitDir = defaultUnitDir(hypHome)
  await fs.mkdir(unitDir, { recursive: true })
  await fs.writeFile(path.join(unitDir, unitFileName()), '[Unit]\nDescription=HypAware\n')
  writeStatusFile(stateRoot, snapshot)
  return hypHome
}

/**
 * The unit-file probe is the real one; only the systemctl query is stubbed, to
 * the answer a service manager still holding a unit with nothing under it
 * gives.
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

test('a daemon that boots degraded still dates its status writes', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-degraded-boot-heartbeat-'))
  try {
    const { atBoot } = await runDegradedDaemon(hypHome)
    assert.equal(atBoot.state, 'degraded', 'fixture invariant: the source refused, so the boot is degraded')
    assert.equal(atBoot.sources[0]?.state, 'failed')
    assert.ok(atBoot.healthyAt, 'a serving daemon dates its writes whatever the boot aggregate said')

    const ageMs = daemonHeartbeatAgeMs(atBoot, Date.now())
    assert.notEqual(ageMs, null, 'the heartbeat every staleness reader derives must exist for this daemon')
    assert.ok(/** @type {number} */ (ageMs) < 60_000, `the boot write is fresh, got ${ageMs}ms`)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The acceptance case. A degraded daemon killed mid-shutdown freezes its
// snapshot at `stopping`, and LLP 0384 reads that as an incomplete stop only
// once it goes stale - which needs an age, which needs the write above.
test('a degraded daemon killed mid-shutdown is reported once its snapshot goes stale', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-degraded-boot-stalled-'))
  let replayHome
  try {
    const { stopping } = await runDegradedDaemon(hypHome)
    assert.equal(stopping.state, 'stopping', 'fixture invariant: the kill lands on the stop that started')

    // The daemon's own snapshot, aged by half an hour: the pair is left as
    // written and only moved wholesale into the past, so the last-write time
    // it derives to is the daemon's own, thirty minutes ago. The pid is one
    // the OS has not issued, because the process the file names is gone. A
    // snapshot that dates no write cannot be aged at all, which is the defect
    // under test: it is replayed as it stands and the collector is asked what
    // it makes of it.
    const writtenAtMs = Date.parse(stopping.healthyAt ?? '')
    const aged = { ...stopping, pid: 999999 }
    if (Number.isFinite(writtenAtMs)) {
      aged.healthyAt = new Date(writtenAtMs - 30 * 60_000).toISOString()
    }
    replayHome = await replaySnapshot(aged)

    const report = await collectHypAwareStatus(collectOpts(replayHome))
    assert.equal(report.daemon.loaded, true, 'the service manager is still holding the unit')
    assert.equal(report.daemon.running, false, 'and nothing is capturing')
    assert.notEqual(report.overall, 'healthy', 'a stop that never completed is not a completed stop')

    const diag = report.diagnostics.find((d) => d.kind === 'daemon_exited_abnormally')
    assert.ok(diag, 'the abandoned stop is named')
    assert.equal(diag.severity, 'error')
    assert.match(diag.message, /recorded 'stopping' 30m ago/)
    assert.match(diag.message, /the stop began but never completed/)
    assert.deepEqual(diag.repair, ['hyp daemon restart'])
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
    if (replayHome) await fs.rm(replayHome, { recursive: true, force: true })
  }
})
