// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BOOT_FAILED_WARNING_PREFIX } from '../../src/core/daemon/boot_failure.js'
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
//
// Both endings are read back off the home the daemon left behind, so the
// daemon itself runs in a process of its own (see `runGatewayOutsideTestRunner`)
// and every assertion below is about files, not about a live daemon.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** @param {string} rel */
function moduleUrl(rel) {
  return pathToFileURL(path.join(REPO_ROOT, rel)).href
}

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
  const configPath = await writeGatewayHome(hypHome, `127.0.0.1:${port}`)
  return { hypHome, stateRoot: path.join(hypHome, 'hypaware'), configPath, squatter }
}

/**
 * @param {string} hypHome
 * @param {string} listen
 * @returns {Promise<string>} the config path the daemon is pointed at
 */
async function writeGatewayHome(hypHome, listen) {
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    auto_update: false,
    // The upstream is what makes `listen` a bind at all. A gateway that
    // compiles to an empty routing table idles without binding unless a CA on
    // disk says a client may still be proxying through it (LLP 0233), and that
    // CA is looked for under the running process's own $HOME. Without an
    // upstream this fixture therefore binds on a developer machine that has
    // ever attached a client, and idles on a clean CI runner, where the boot
    // then succeeds and leaves a gateway running (#1527).
    plugins: [{
      name: '@hypaware/ai-gateway',
      config: { listen, upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' }] },
    }],
  }))
  // The unit file on disk is what `installed` is read from, so it is real here.
  const unitDir = defaultUnitDir(hypHome)
  await fs.mkdir(unitDir, { recursive: true })
  await fs.writeFile(path.join(unitDir, unitFileName()), '[Unit]\nDescription=HypAware\n')
  return configPath
}

/**
 * Boot one gateway daemon against `hypHome`, stop it if it came up, and report
 * how each half ended.
 *
 * `runGatewayDaemon` is a daemon entrypoint, not a library call: it forks
 * `processor.js` with this process's stdout inherited, and its stop deadline
 * ends the process with `process.exit`. Inside a `node --test` worker that
 * stdout is the runner's report channel, so a processing child that outlives
 * the worker leaves the whole suite waiting on an EOF that never arrives, and
 * a stop that reaches its deadline exits the worker mid-file, dropping every
 * later test with no failure to show for it. Neither ending is visible as
 * anything but a job that ran out of time (#1527). So the daemon runs outside
 * the runner, holding no pipe of ours for its children to inherit, and reports
 * through a file; `spawnSync`'s timeout turns a wedged daemon into a failed
 * assertion here instead of a wedged suite.
 *
 * @param {{ hypHome: string, configPath: string, runId: string }} opts
 * @returns {{ booted: boolean, bootError: string | null, stopError: string | null }}
 */
function runGatewayOutsideTestRunner({ hypHome, configPath, runId }) {
  const scriptPath = path.join(hypHome, 'gateway-run.mjs')
  const resultPath = path.join(hypHome, 'gateway-run.json')
  const errPath = path.join(hypHome, 'gateway-run.err')
  const daemonOpts = { hypHome, configPath, runId, tickIntervalMs: 0, installSignalHandlers: false }
  writeFileSync(scriptPath, [
    "import fs from 'node:fs'",
    `import { runGatewayDaemon } from ${JSON.stringify(moduleUrl('src/core/daemon/gateway.js'))}`,
    'const result = { booted: false, bootError: null, stopError: null }',
    'let handle',
    'try {',
    `  handle = await runGatewayDaemon({ ...${JSON.stringify(daemonOpts)}, env: { ...process.env } })`,
    '  result.booted = true',
    '} catch (error) {',
    '  result.bootError = error instanceof Error ? error.message : String(error)',
    '}',
    // A boot that came up is stopped here whatever the test goes on to assert,
    // so no run of this file can leave a gateway and its processing child
    // behind on the machine that ran it.
    'if (handle) {',
    '  try {',
    '    await handle.stop()',
    '    await handle.done',
    '  } catch (error) {',
    '    result.stopError = error instanceof Error ? error.message : String(error)',
    '  }',
    '}',
    `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result))`,
    // The daemon's own handles are the daemon's business: the run ends once
    // its record is on disk, rather than depending on every one of them.
    'process.exit(0)',
    '',
  ].join('\n'))

  // A file, never a pipe: a pipe is the one thing the forked processing child
  // could still be holding when the deadline kills its parent.
  const errFd = openSync(errPath, 'w')
  let run
  try {
    run = spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: hypHome, HYP_HOME: hypHome },
      stdio: ['ignore', 'ignore', errFd],
      timeout: 60_000,
    })
  } finally {
    closeSync(errFd)
  }
  const stderr = readFileSync(errPath, 'utf8')
  assert.equal(run.signal, null, `the gateway daemon never ended, so nothing was recorded: ${stderr}`)
  assert.equal(run.status, 0, stderr)
  return JSON.parse(readFileSync(resultPath, 'utf8'))
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
    const run = runGatewayOutsideTestRunner({
      hypHome: home.hypHome,
      configPath: home.configPath,
      runId: 'gateway-boot-failure-test',
    })
    assert.equal(run.booted, false, 'fixture invariant: the configured listen must fail the boot')
    assert.match(run.bootError ?? '', /EADDRINUSE/, 'fixture invariant: the boot must fail on the taken port')
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
    const configPath = await writeGatewayHome(hypHome, '127.0.0.1:0')
    const run = runGatewayOutsideTestRunner({ hypHome, configPath, runId: 'gateway-clean-stop-test' })
    assert.equal(run.bootError, null, 'fixture invariant: an ephemeral listen must boot')
    assert.equal(run.stopError, null, 'fixture invariant: the stop must complete')

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
