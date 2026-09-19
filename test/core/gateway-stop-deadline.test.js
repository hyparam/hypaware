// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Issue #1531. The gateway's stop arms a four-second deadline whose whole job
// is to guarantee the forked `processor.js` dies (LLP 0038). Its `finally`
// clears that deadline, and a `sources.stop('ai-gateway')` that rejects can
// reach there without ever waiting for the child: the one thing that would
// have killed it is cancelled, and the gateway writes a `stopped` snapshot
// over an unsupervised child still holding the same `HYP_HOME`.
//
// The daemon runs outside the test runner, as `gateway-boot-failure-status`
// does and for the same reasons (#1527): it forks with this process's stdout
// inherited, so a surviving child would hold the runner's report channel open.
// Spawning it also turns a wedged daemon into a failed assertion here rather
// than a wedged suite.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATEWAY_URL = pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'daemon', 'gateway.js')).href

/** @param {number | null} pid @returns {boolean} */
function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A processing child that cannot stop itself: the preload registers its
 * `message` listener before `processor.js` registers its own, so a
 * `processing.stop` blocks the child's event loop for good. That also takes
 * out the `disconnect` handler `processor.js` exits on when its supervisor
 * dies, leaving exactly the child the SIGKILL deadline exists for.
 *
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function writeBlockedChildPreload(dir) {
  const blocker = path.join(dir, 'block-processing-stop.cjs')
  await fs.writeFile(blocker, [
    "process.on('message', msg => {",
    "  if (msg && msg.type === 'processing.stop') for (;;) {}",
    '})',
    '',
  ].join('\n'))
  return blocker
}

/**
 * Boot one gateway, make its source stop reject, stop it, and report whether
 * the processing child outlived the stop.
 *
 * @param {{ hypHome: string, configPath: string, blocker: string, resultPath: string }} opts
 * @returns {{ childPid: number | null, aliveBeforeStop: boolean, aliveAfterStop: boolean | null, stopError: string | null }}
 */
function runGatewayOutsideTestRunner({ hypHome, configPath, blocker, resultPath }) {
  const scriptPath = path.join(hypHome, 'gateway-stop-deadline.mjs')
  const errPath = path.join(hypHome, 'gateway-stop-deadline.err')
  const daemonOpts = {
    hypHome,
    configPath,
    runId: 'gateway-stop-deadline-test',
    tickIntervalMs: 0,
    installSignalHandlers: false,
    processingExecArgv: ['--require', blocker],
  }
  writeFileSync(scriptPath, [
    "import fs from 'node:fs'",
    `import { runGatewayDaemon } from ${JSON.stringify(GATEWAY_URL)}`,
    'const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }',
    'const result = { childPid: null, aliveBeforeStop: false, aliveAfterStop: null, stopError: null }',
    `const record = () => fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result))`,
    `const handle = await runGatewayDaemon({ ...${JSON.stringify(daemonOpts)}, env: { ...process.env } })`,
    'result.childPid = handle.snapshot().processes?.processing?.pid ?? null',
    'result.aliveBeforeStop = alive(result.childPid)',
    // Recorded before the stop as well as after it, so a run that never gets
    // to report still leaves the caller the pid it has to clean up.
    'record()',
    // The injected failure reaches for no production seam: the source registry
    // the gateway stops through is the one the handle already exposes.
    "handle.runtime.sources.stop = async () => { throw new Error('injected source stop failure') }",
    'try {',
    '  await handle.stop()',
    '  await handle.done',
    '} catch (error) {',
    '  result.stopError = error instanceof Error ? error.message : String(error)',
    '}',
    'result.aliveAfterStop = alive(result.childPid)',
    'record()',
    // The daemon's own handles are the daemon's business: the run ends once
    // its record is on disk, rather than depending on every one of them.
    'process.exit(0)',
    '',
  ].join('\n'))

  // A file, never a pipe: a pipe is the one thing the forked processing child
  // could still be holding when its parent goes.
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

test('a source stop that rejects still kills the processing child', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-gateway-stop-deadline-'))
  const resultPath = path.join(hypHome, 'gateway-stop-deadline.json')
  /** @type {number | null} */
  let childPid = null
  try {
    const configPath = path.join(hypHome, 'hypaware-config.json')
    // An upstream is what makes `listen` a bind at all; without one the
    // gateway compiles to an empty routing table and idles (#1527).
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      auto_update: false,
      plugins: [{
        name: '@hypaware/ai-gateway',
        config: { listen: '127.0.0.1:0', upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' }] },
      }],
    }))
    const blocker = await writeBlockedChildPreload(hypHome)
    const run = runGatewayOutsideTestRunner({ hypHome, configPath, blocker, resultPath })
    childPid = run.childPid

    assert.ok(run.childPid, 'fixture invariant: the gateway must have forked a processing child')
    assert.equal(run.aliveBeforeStop, true, 'fixture invariant: the child must still be running when the stop begins')
    assert.equal(
      run.stopError,
      'injected source stop failure',
      'the rejection must reach the caller rather than being swallowed by the stop'
    )
    assert.equal(
      run.aliveAfterStop,
      false,
      'a source stop that rejected left the processing child running, unsupervised, on the same HYP_HOME'
    )
  } finally {
    // Only ever the pid this test's own run reported, never a process name.
    if (!childPid && existsSync(resultPath)) {
      try { childPid = JSON.parse(readFileSync(resultPath, 'utf8')).childPid ?? null } catch { /* nothing was recorded */ }
    }
    if (alive(childPid)) process.kill(/** @type {number} */ (childPid), 'SIGKILL')
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
