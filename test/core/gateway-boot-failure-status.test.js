// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { BOOT_FAILED_WARNING_PREFIX } from '../../src/core/daemon/boot_failure.js'
import { runGatewayDaemon } from '../../src/core/daemon/gateway.js'
import { collectHypAwareStatus, readStatusFile } from '../../src/core/daemon/status.js'
import { previousBootLooksStuck } from '../../src/core/update/self_update.js'
import { defaultUnitDir, unitFileName } from '../../src/core/daemon/platform.js'

/** @import { AddressInfo } from 'node:net' */
/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

// Issue #1501. `stop()` is reached from two endings that must not read alike:
// an operator's stop, and a boot that threw before the gateway ever served.
// Both wrote `stopped`, which LLP 0383 reads as "a shutdown completed", so a
// gateway stuck in a bind-failure crash loop reported the exact shape of a
// deliberate `hyp daemon stop` and raised nothing.

/**
 * A home whose gateway boot throws for a production reason: the configured
 * `listen` port is already taken, and a *configured* listen fails loudly
 * rather than falling back to an ephemeral bind (LLP 0114). The squatting
 * socket is the caller's to close.
 *
 * @returns {Promise<{ hypHome: string, stateRoot: string, configPath: string, squatter: net.Server }>}
 */
async function makeHomeThatFailsGatewayBoot() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-gateway-boot-failure-'))
  const squatter = net.createServer()
  await new Promise((resolve, reject) => {
    squatter.once('error', reject)
    squatter.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const port = /** @type {AddressInfo} */ (squatter.address()).port
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    auto_update: false,
    plugins: [{ name: '@hypaware/ai-gateway', config: { listen: `127.0.0.1:${port}` } }],
  }))
  // The unit file on disk is what `installed` is read from, so it is real here.
  const unitDir = defaultUnitDir(hypHome)
  await fs.mkdir(unitDir, { recursive: true })
  await fs.writeFile(path.join(unitDir, unitFileName()), '[Unit]\nDescription=HypAware\n')
  return { hypHome, stateRoot: path.join(hypHome, 'hypaware'), configPath, squatter }
}

/**
 * The unit-file probe is the real one; only the systemctl query is stubbed, to
 * the answer a service manager still holding a unit with nothing under it
 * gives, which is what an installed gateway in a relaunch loop leaves behind.
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

test('a gateway boot failure records the failed boot rather than a completed stop', async () => {
  const home = await makeHomeThatFailsGatewayBoot()
  try {
    await assert.rejects(
      runGatewayDaemon({
        hypHome: home.hypHome,
        configPath: home.configPath,
        env: { ...process.env, HOME: home.hypHome, HYP_HOME: home.hypHome },
        runId: 'gateway-boot-failure-test',
        installSignalHandlers: false,
      }),
      /EADDRINUSE/,
      'fixture invariant: the configured listen must fail the boot'
    )
    // The trap is gone from here on, so everything below reads the gateway's
    // own record rather than the condition that produced it.
    await new Promise(resolve => home.squatter.close(resolve))

    const snapshot = readStatusFile(home.stateRoot)
    assert.equal(snapshot?.state, 'degraded', 'a boot that threw is not a completed stop')
    assert.equal(snapshot?.stoppedAt, undefined, 'and dates no stop it never performed')
    const warning = snapshot?.warnings?.[0] ?? ''
    assert.ok(
      warning.startsWith(BOOT_FAILED_WARNING_PREFIX),
      `the gateway stamps the shared boot-failure label, got ${JSON.stringify(warning)}`
    )

    // Reader one: the self-updater's stuck-boot re-probe, which a crash-looping
    // release has to buy so the machine can jump forward.
    assert.equal(previousBootLooksStuck(home.stateRoot), true)

    // Reader two: what the operator is told.
    const report = await collectHypAwareStatus(collectOpts(home.hypHome))
    const diag = report.diagnostics.find(d => d.kind === 'daemon_exited_abnormally')
    assert.ok(diag, 'a gateway that never booted must not read as a requested stop')
    assert.equal(diag.severity, 'error')
    assert.match(diag.message, /failed boot/, 'the message names the ending the snapshot recorded')
    assert.deepEqual(diag.repair, ['hyp daemon restart'])

    // And the error is on the surface `recent_errors` counts, not only stderr.
    const log = await fs.readFile(path.join(home.stateRoot, 'logs', 'daemon.log'), 'utf8')
    const failure = log.split('\n').find(line => line.includes('daemon.boot_failed'))
    assert.ok(failure, 'the gateway boot failure went unrecorded in daemon.log')
    assert.equal(JSON.parse(failure).level, 'error')
  } finally {
    home.squatter.close()
    await fs.rm(home.hypHome, { recursive: true, force: true })
  }
})

test('a gateway that boots and is asked to stop still records a completed stop', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-gateway-clean-stop-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  try {
    const configPath = path.join(hypHome, 'hypaware-config.json')
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      auto_update: false,
      plugins: [{ name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:0' } }],
    }))
    const unitDir = defaultUnitDir(hypHome)
    await fs.mkdir(unitDir, { recursive: true })
    await fs.writeFile(path.join(unitDir, unitFileName()), '[Unit]\nDescription=HypAware\n')

    const handle = await runGatewayDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HOME: hypHome, HYP_HOME: hypHome },
      runId: 'gateway-clean-stop-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })
    await handle.stop()
    await handle.done

    const snapshot = readStatusFile(stateRoot)
    assert.equal(snapshot?.state, 'stopped', 'an operator stop still records a completed stop')
    assert.ok(snapshot?.stoppedAt, 'and dates it')
    assert.equal(previousBootLooksStuck(stateRoot), false)

    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.equal(
      report.diagnostics.find(d => d.kind === 'daemon_exited_abnormally'),
      undefined,
      'a requested stop must not be reported as an abnormal ending'
    )
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
