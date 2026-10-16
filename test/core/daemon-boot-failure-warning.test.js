// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BOOT_FAILED_WARNING_PREFIX } from '../../src/core/daemon/boot_failure.js'
import { runDaemon } from '../../src/core/daemon/runtime.js'
import { collectHypAwareStatus, statusFilePath, writeStatusFile } from '../../src/core/daemon/status.js'
import { previousBootLooksStuck } from '../../src/core/update/self_update.js'
import { defaultUnitDir, unitFileName } from '../../src/core/daemon/platform.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions, DaemonStatus } from '../../src/core/daemon/types.js' */

// Issue #1419. The boot-failure label is one writer's word for an ending two
// readers act on: `hyp status` names it instead of "exited without shutting
// down", and the self-updater buys a stuck boot an hourly re-probe. Neither
// reader can import the writer (`runtime.js` imports `status.js`, and
// `self_update.js` stays import-light), so held as three bare literals a
// rename at the writer silently reverted both readers with nothing failing.
// These tests drive the real writer into its boot-failure path and hand the
// snapshot it persisted to both real readers, so the three can only agree.

/**
 * A home whose boot throws. `ensureClientSyncMigration` materializes the
 * LLP 0188 opt-out store on the first boot that sees a central layer and no
 * store, and rethrows anything that is not the corrupt-store case, so a
 * central layer beside an unwritable store directory fails the boot for a
 * production reason rather than an injected one. The directory is a symlink
 * to nothing: the store still reads as absent (ENOENT), and it is the write's
 * `mkdir -p` that cannot land.
 *
 * @returns {Promise<{ hypHome: string, stateRoot: string, usagePolicyDir: string }>}
 */
async function makeHomeThatFailsBoot() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-failure-warning-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'config-control'), { recursive: true })
  await fs.writeFile(
    path.join(stateRoot, 'config-control', 'seed.json'),
    JSON.stringify({ version: 2, plugins: [] }) + '\n'
  )
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  // The unit file on disk is what `installed` is read from, so it is real here.
  const unitDir = defaultUnitDir(hypHome)
  await fs.mkdir(unitDir, { recursive: true })
  await fs.writeFile(path.join(unitDir, unitFileName()), '[Unit]\nDescription=HypAware\n')
  const usagePolicyDir = path.join(stateRoot, 'usage-policy')
  await fs.symlink(path.join(stateRoot, 'nowhere'), usagePolicyDir)
  return { hypHome, stateRoot, usagePolicyDir }
}

/**
 * Boot that home and return the snapshot the daemon itself persisted on its
 * way out. The injected fault is removed afterwards, so everything read from
 * here on is the daemon's own record rather than the trap that produced it.
 *
 * @param {{ hypHome: string, stateRoot: string, usagePolicyDir: string }} home
 * @returns {Promise<DaemonStatus>}
 */
async function bootAndFail({ hypHome, stateRoot, usagePolicyDir }) {
  await assert.rejects(
    runDaemon({
      hypHome,
      configPath: defaultConfigPath(hypHome),
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'boot-failure-warning-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    }),
    'fixture invariant: the boot must throw, which is the only path that writes the warning'
  )
  await fs.rm(usagePolicyDir, { force: true })
  return JSON.parse(readFileSync(statusFilePath(stateRoot), 'utf8'))
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

test('both readers recognise the boot-failure warning the real writer persisted', async () => {
  const home = await makeHomeThatFailsBoot()
  try {
    const snapshot = await bootAndFail(home)
    assert.equal(snapshot.state, 'degraded', 'a boot that threw is recorded degraded')
    const warning = snapshot.warnings?.[0] ?? ''
    assert.ok(
      warning.startsWith(BOOT_FAILED_WARNING_PREFIX),
      `the writer stamps the shared label, got ${JSON.stringify(warning)}`
    )

    // Reader one: the self-updater's stuck-boot re-probe.
    assert.equal(
      previousBootLooksStuck(home.stateRoot),
      true,
      'a failed boot must buy the updater its re-probe'
    )

    // Reader two: the ending `hyp status` names.
    const report = await collectHypAwareStatus(collectOpts(home.hypHome))
    const diag = report.diagnostics.find((d) => d.kind === 'daemon_exited_abnormally')
    assert.ok(diag, 'the failed boot still raises the diagnostic')
    assert.match(diag.message, /failed boot/, 'the message names the ending the snapshot recorded')
    assert.doesNotMatch(diag.message, /exited without shutting down/)
  } finally {
    await fs.rm(home.hypHome, { recursive: true, force: true })
  }
})

test('neither reader sees a boot failure in a degraded snapshot without the label', async () => {
  const home = await makeHomeThatFailsBoot()
  try {
    const snapshot = await bootAndFail(home)
    // The daemon's own snapshot with only its warning replaced: `degraded`
    // carrying the one other label `runDaemon` writes is a daemon that served
    // with a failed source, and it must keep reading as the exit it is.
    writeStatusFile(home.stateRoot, { ...snapshot, warnings: ['source_stop_failed:codex:timed out'] })

    assert.equal(previousBootLooksStuck(home.stateRoot), false)

    const report = await collectHypAwareStatus(collectOpts(home.hypHome))
    const diag = report.diagnostics.find((d) => d.kind === 'daemon_exited_abnormally')
    assert.ok(diag)
    assert.match(diag.message, /exited without shutting down/)
  } finally {
    await fs.rm(home.hypHome, { recursive: true, force: true })
  }
})
