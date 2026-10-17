// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BIND_RETRY_INTERVAL_MS, waitBeforeBindRetry } from '../../src/core/daemon/gateway.js'
import { addressInUse, describePortOwner, probePortOwner } from '../../src/core/daemon/port_owner.js'
import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
import { BOOT_FAILED_WARNING_PREFIX } from '../../src/core/daemon/boot_failure.js'
import { defaultUnitDir, unitFileName } from '../../src/core/daemon/platform.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { AddressInfo } from 'node:net' */
/** @import { ChildProcess } from 'node:child_process' */
/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

// Issue #137. A supervised gateway whose configured listen port is taken used
// to exit at once into a launchd/systemd relaunch, booting every 5 to 10
// seconds for as long as the conflict lasted. It now holds the failed process
// for one retry interval, names the port's owner, and reports the wait in
// `hyp status`.
// @ref LLP 0521#pacing [tests]: one boot per interval while the port stays taken, recovery once it clears, a signal ends the wait

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** @param {string} rel */
function moduleUrl(rel) {
  return pathToFileURL(path.join(REPO_ROOT, rel)).href
}

/** @returns {Promise<net.Server>} */
async function occupyLoopbackPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  return server
}

/** @param {net.Server} server */
function portOf(server) {
  return /** @type {AddressInfo} */ (server.address()).port
}

/**
 * The gateway-only home the #1501 test uses: a configured listen (which fails
 * loudly, LLP 0114) and one upstream, so the listen is a real bind.
 *
 * @param {string} hypHome
 * @param {string} listen
 */
async function writeGatewayHome(hypHome, listen) {
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(gatewayConfig(listen)))
  const unitDir = defaultUnitDir(hypHome)
  await fs.mkdir(unitDir, { recursive: true })
  await fs.writeFile(path.join(unitDir, unitFileName()), '[Unit]\nDescription=HypAware\n')
  return configPath
}

/** @param {string} listen */
function gatewayConfig(listen) {
  return {
    version: 2,
    auto_update: false,
    plugins: [{
      name: '@hypaware/ai-gateway',
      config: { listen, upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' }] },
    }],
  }
}

test('an address-in-use failure is classified with its port, and nothing else is', () => {
  const nodeError = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:8787'), { code: 'EADDRINUSE', port: 8787, address: '127.0.0.1' })
  assert.deepEqual(addressInUse(nodeError), { port: 8787, host: '127.0.0.1' })
  // An activation failure carries the reason in its message only.
  assert.deepEqual(
    addressInUse(new Error('configured gateway failed to activate: listen EADDRINUSE: address already in use 127.0.0.1:9911')),
    { port: 9911, host: '127.0.0.1' }
  )
  assert.deepEqual(addressInUse(new Error('listen EADDRINUSE: address already in use')), { port: 0 })
  assert.equal(addressInUse(new Error('listen EACCES: permission denied 127.0.0.1:80')), undefined)
  assert.equal(addressInUse(new Error('daemon already running (pid=12)')), undefined)
  assert.equal(addressInUse(undefined), undefined)
})

test('the owner probe names the process holding a real loopback port, by pid and executable only', { skip: process.platform !== 'linux' && 'reads /proc' }, async () => {
  const server = await occupyLoopbackPort()
  try {
    const owner = await probePortOwner(portOf(server), { host: '127.0.0.1' })
    assert.equal(owner?.pid, process.pid)
    assert.equal(owner?.executable, path.basename(process.execPath))
    assert.equal(describePortOwner(portOf(server), owner), `port ${portOf(server)} is held by pid ${process.pid} (${path.basename(process.execPath)})`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('the owner probe says unknown when it cannot know', async () => {
  const free = await occupyLoopbackPort()
  const port = portOf(free)
  await new Promise(resolve => free.close(resolve))
  assert.equal(await probePortOwner(port, { platform: 'linux' }), undefined, 'nobody listens')
  assert.equal(await probePortOwner(port, { platform: 'win32' }), undefined, 'no probe on this platform')
  assert.equal(await probePortOwner(0), undefined)
  assert.equal(describePortOwner(port, undefined), `the owner of port ${port} is unknown`)

  // A listener whose inode no readable fd names (another user's process).
  const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-port-owner-proc-'))
  try {
    await fs.mkdir(path.join(procRoot, 'net'))
    const hexPort = (8787).toString(16).toUpperCase().padStart(4, '0')
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
    const row = (/** @type {string} */ addr, /** @type {string} */ inode) =>
      `   0: ${addr}:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`
    // 10.0.0.5 is not the host that refused the bind, so its listener is not the owner.
    await fs.writeFile(path.join(procRoot, 'net', 'tcp'), header + row('0500000A', '111') + row('0100007F', '222'))
    await fs.mkdir(path.join(procRoot, '4242', 'fd'), { recursive: true })
    await fs.symlink('socket:[111]', path.join(procRoot, '4242', 'fd', '3'))
    await fs.writeFile(path.join(procRoot, '4242', 'comm'), 'other\n')
    assert.equal(await probePortOwner(8787, { platform: 'linux', procRoot, host: '127.0.0.1' }), undefined, 'a listener on another address is never named')
    assert.deepEqual(await probePortOwner(8787, { platform: 'linux', procRoot, host: '10.0.0.5' }), { pid: 4242, executable: 'other' }, 'comm stands in for an unreadable exe link')
    // Unreadable fd directories (permission denied) are skipped, not fatal.
    await fs.mkdir(path.join(procRoot, '4343'))
    assert.equal(await probePortOwner(8787, { platform: 'linux', procRoot, host: '127.0.0.1' }), undefined)
  } finally {
    await fs.rm(procRoot, { recursive: true, force: true })
  }
})

test('the macOS probe reads lsof field output and folds every failure to unknown', async () => {
  /** @type {string[][]} */
  const calls = []
  const fakeExec = /** @type {any} */ ((/** @type {string} */ file, /** @type {string[]} */ args, /** @type {any} */ _opts, /** @type {Function} */ cb) => {
    calls.push([file, ...args])
    cb(null, 'p321\ncnc\np322\ncother\n', '')
  })
  assert.deepEqual(await probePortOwner(8787, { platform: 'darwin', execFile: fakeExec }), { pid: 321, executable: 'nc' })
  assert.deepEqual(calls[0], ['lsof', '-nP', '-w', '-iTCP:8787', '-sTCP:LISTEN', '-Fpc'])
  const failing = /** @type {any} */ ((/** @type {string} */ _f, /** @type {string[]} */ _a, /** @type {any} */ _o, /** @type {Function} */ cb) => cb(new Error('spawn lsof ENOENT'), '', ''))
  assert.equal(await probePortOwner(8787, { platform: 'darwin', execFile: failing }), undefined)
})

test('the retry wait lasts one interval, and a signal ends it at once without leaking', async () => {
  const signals = new EventEmitter()
  /** @type {{ fn: () => void, ms: number, cleared: boolean }[]} */
  const timers = []
  const clock = {
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimeout: (/** @type {any} */ t) => { if (t) t.cleared = true },
  }

  const elapsed = waitBeforeBindRetry({ signals, ...clock })
  assert.equal(timers[0].ms, BIND_RETRY_INTERVAL_MS)
  assert.equal(BIND_RETRY_INTERVAL_MS, 60_000)
  timers[0].fn()
  assert.equal(await elapsed, 'elapsed')

  for (const signal of ['SIGTERM', 'SIGINT']) {
    const waiting = waitBeforeBindRetry({ signals, ...clock })
    signals.emit(signal)
    assert.equal(await waiting, 'signalled')
    assert.equal(timers.at(-1)?.cleared, true, 'the interval timer is cleared, not left to fire')
  }

  for (let i = 0; i < 20; i++) {
    const waiting = waitBeforeBindRetry({ signals, ...clock })
    timers.at(-1)?.fn()
    await waiting
  }
  assert.equal(signals.listenerCount('SIGTERM'), 0, 'no signal listener outlives its wait')
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

test('status names a live process whose own snapshot records a failed boot', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-boot-failed-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  try {
    await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
    await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
    const unitDir = defaultUnitDir(hypHome)
    await fs.mkdir(unitDir, { recursive: true })
    await fs.writeFile(path.join(unitDir, unitFileName()), '[Unit]\nDescription=HypAware\n')
    const startedAt = new Date().toISOString()
    const reason = 'listen EADDRINUSE: address already in use 127.0.0.1:8787 (port 8787 is held by pid 77 (nc))'
    writeStatusFile(stateRoot, { state: 'degraded', pid: process.pid, startedAt, healthyAt: startedAt, uptimeMs: 0, runId: 'r', mode: 'foreground', sources: [], sinks: [], warnings: [`${BOOT_FAILED_WARNING_PREFIX}: ${reason}`] })
    /** @type {CollectStatusOptions} */
    const live = { env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }, platform: 'linux', homeDir: hypHome, systemdUnitStatus: async () => ({ loaded: true, pid: process.pid }) }
    const report = await collectHypAwareStatus(live)
    const diag = report.diagnostics.find(d => d.kind === 'daemon_boot_failed')
    assert.ok(diag, 'a waiting process must not read as a serving daemon')
    assert.equal(diag.severity, 'error')
    assert.ok(diag.message.includes(reason), diag.message)
    assert.match(diag.message, /about once a minute/)
    assert.deepEqual(diag.repair, ['hyp daemon restart'])
    assert.equal(report.overall, 'degraded')
    assert.equal(report.diagnostics.find(d => d.kind === 'daemon_exited_abnormally'), undefined, 'it has not exited')

    // Once it exits, the existing reading takes over.
    const exited = await collectHypAwareStatus({ ...live, systemdUnitStatus: async () => ({ loaded: true }) })
    assert.equal(exited.diagnostics.find(d => d.kind === 'daemon_boot_failed'), undefined)
    assert.ok(exited.diagnostics.find(d => d.kind === 'daemon_exited_abnormally'))

    // A live daemon that served degraded is not a failed boot.
    writeStatusFile(stateRoot, { state: 'degraded', pid: process.pid, startedAt, healthyAt: startedAt, uptimeMs: 0, runId: 'r', mode: 'foreground', sources: [], sinks: [], warnings: ['processing_unavailable: x'] })
    const serving = await collectHypAwareStatus(live)
    assert.equal(serving.diagnostics.find(d => d.kind === 'daemon_boot_failed'), undefined)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

/**
 * Stand in for the service manager: call `hyp daemon run` in a loop, relaunching
 * on every exit, against a home whose configured port this process squats on.
 * The retry wait is the test seam, driven off a virtual clock, so the loop
 * runs at full speed and proves the cadence without a real minute.
 *
 * The daemon runs outside the test runner for the reason the #1501 test gives:
 * a gateway that boots forks a processing child that inherits stdout, and a
 * stop deadline that exits would end the worker mid-file.
 */
test('a supervised port conflict boots once per interval, then recovers when the port frees', { skip: process.platform !== 'linux' && 'reads /proc' }, async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-port-conflict-loop-'))
  const scriptPath = path.join(hypHome, 'supervisor.mjs')
  const resultPath = path.join(hypHome, 'supervisor.json')
  const errPath = path.join(hypHome, 'supervisor.err')
  try {
    const configPath = await writeGatewayHome(hypHome, '127.0.0.1:0')
    const failuresBeforeClear = 4
    writeFileSync(scriptPath, `
import fs from 'node:fs'
import net from 'node:net'
import { runDaemonRun } from ${JSON.stringify(moduleUrl('src/core/commands/daemon.js'))}
import { collectHypAwareStatus, readStatusFile } from ${JSON.stringify(moduleUrl('src/core/daemon/status.js'))}
import { pidFilePath } from ${JSON.stringify(moduleUrl('src/core/daemon/pid.js'))}
const hypHome = ${JSON.stringify(hypHome)}
const configPath = ${JSON.stringify(configPath)}
const stateRoot = hypHome + '/hypaware'
const squatter = net.createServer()
await new Promise((resolve, reject) => { squatter.once('error', reject); squatter.listen(0, '127.0.0.1', resolve) })
const port = squatter.address().port
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
config.plugins[0].config.listen = '127.0.0.1:' + port
fs.writeFileSync(configPath, JSON.stringify(config))
const supervised = { ...process.env, HYP_HOME: hypHome, HOME: hypHome, INVOCATION_ID: 'test-invocation' }
const statusOpts = { env: { ...supervised, HYP_CONFIG: '' }, platform: 'linux', homeDir: hypHome, systemdUnitStatus: async () => ({ loaded: true, pid: process.pid }) }
const result = { pid: process.pid, port, unsupervised: null, attempts: [], waits: [], served: null, stderr: '' }
const ctx = env => ({
  env, cwd: hypHome, config: {}, plugins: [],
  stderr: { write: s => { result.stderr += String(s); return true } },
  stdout: { write: s => { if (String(s).startsWith('daemon: running')) void onServing(); return true } },
})
async function onServing() {
  const deadline = Date.now() + 30_000
  let snapshot = readStatusFile(stateRoot)
  while (!snapshot?.sources?.some(s => s.name === 'ai-gateway') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100))
    snapshot = readStatusFile(stateRoot)
  }
  const report = await collectHypAwareStatus(statusOpts)
  result.served = {
    boundPort: snapshot?.sources?.find(s => s.name === 'ai-gateway')?.details?.port,
    warnings: snapshot?.warnings ?? [],
    bootFailedDiag: report.diagnostics.some(d => d.kind === 'daemon_boot_failed'),
  }
  process.kill(process.pid, 'SIGTERM')
}
let unsupervisedWaits = 0
result.unsupervised = await runDaemonRun(['--config', configPath], ctx({ ...supervised, INVOCATION_ID: '' }), { waitBeforeBindRetry: async () => { unsupervisedWaits++; return 'elapsed' } })
result.unsupervisedWaits = unsupervisedWaits
let clock = 0
for (let i = 0; i < ${failuresBeforeClear} + 2; i++) {
  const attempt = { at: clock, code: null }
  result.attempts.push(attempt)
  attempt.code = await runDaemonRun(['--config', configPath], ctx(supervised), {
    waitBeforeBindRetry: async () => {
      const snapshot = readStatusFile(stateRoot)
      const wait = {
        at: clock,
        fds: fs.readdirSync('/proc/self/fd').length,
        sigterm: process.listenerCount('SIGTERM'),
        handles: process.getActiveResourcesInfo().filter(r => r !== 'TTYWrap').length,
        state: snapshot?.state, snapshotPid: snapshot?.pid, warning: snapshot?.warnings?.[0],
        pidFile: fs.existsSync(pidFilePath(stateRoot)),
      }
      const report = await collectHypAwareStatus(statusOpts)
      wait.diag = report.diagnostics.find(d => d.kind === 'daemon_boot_failed') ?? null
      wait.overall = report.overall
      result.waits.push(wait)
      clock += 60_000
      if (result.waits.length === ${failuresBeforeClear}) await new Promise(r => squatter.close(r))
      return 'elapsed'
    },
  })
  if (attempt.code === 0) break
}
fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result))
process.exit(0)
`)
    const errFd = openSync(errPath, 'w')
    let run
    try {
      run = spawnSync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: hypHome, HYP_HOME: hypHome },
        stdio: ['ignore', 'ignore', errFd],
        timeout: 90_000,
      })
    } finally {
      closeSync(errFd)
    }
    const stderr = readFileSync(errPath, 'utf8')
    assert.equal(run.signal, null, `the supervisor loop never ended: ${stderr}`)
    assert.equal(run.status, 0, stderr)
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))

    // Nobody relaunches a foreground run, so it fails fast and does not wait.
    assert.equal(result.unsupervised, 1)
    assert.equal(result.unsupervisedWaits, 0)

    // Bounded: one wait per failed boot, each boot an interval after the last.
    const failed = result.attempts.filter((/** @type {any} */ a) => a.code === 1)
    assert.equal(failed.length, failuresBeforeClear, result.stderr)
    assert.equal(result.waits.length, failuresBeforeClear)
    for (let i = 1; i < result.attempts.length; i++) {
      assert.ok(result.attempts[i].at - result.attempts[i - 1].at >= 60_000, 'no boot sooner than an interval after a failed one')
    }

    // Diagnosed: the real occupied port, named with its holder.
    const owner = `port ${result.port} is held by pid ${result.pid} (${path.basename(process.execPath)})`
    for (const wait of result.waits) {
      assert.equal(wait.state, 'degraded', 'a waiting process never claims healthy')
      assert.equal(wait.snapshotPid, result.pid)
      assert.ok(wait.warning.startsWith(`${BOOT_FAILED_WARNING_PREFIX}: `), wait.warning)
      assert.match(wait.warning, /EADDRINUSE/)
      assert.ok(wait.warning.includes(owner), wait.warning)
      assert.equal(wait.pidFile, false, 'the failed boot released its pid file')
      assert.ok(wait.diag, 'status names the wait')
      assert.equal(wait.diag.severity, 'error')
      assert.equal(wait.overall, 'degraded')
    }
    assert.match(result.stderr, /retrying in 60s/)

    // Cleanup: later failures hold nothing the earlier ones did not.
    const [, second, ...rest] = result.waits
    const last = rest.at(-1)
    assert.equal(last.fds, second.fds, 'file descriptors grow across failed boots')
    assert.equal(last.handles, second.handles, 'active handles grow across failed boots')
    assert.equal(last.sigterm, second.sigterm, 'signal listeners grow across failed boots')

    // Recovery: the boot after the port frees serves on it, and the retry state is gone.
    const final = result.attempts.at(-1)
    assert.equal(final.code, 0, result.stderr)
    assert.equal(result.served?.boundPort, result.port)
    assert.equal(result.served?.warnings.some((/** @type {string} */ w) => w.startsWith(BOOT_FAILED_WARNING_PREFIX)), false)
    assert.equal(result.served?.bootFailedDiag, false)

    const log = await fs.readFile(path.join(hypHome, 'hypaware', 'logs', 'daemon.log'), 'utf8')
    const failures = log.split('\n').filter(line => line.includes('"daemon.boot_failed"')).map(line => JSON.parse(line))
    assert.equal(failures.length, failuresBeforeClear + 1, 'one log line per failed boot, the unsupervised one included')
    for (const line of failures) {
      assert.equal(line.level, 'error')
      assert.equal(line.error_kind, 'port_in_use')
      assert.equal(line.owner_pid, result.pid)
    }
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('stopping a supervised daemon during the retry wait is prompt, and the owner is left alone', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-port-conflict-stop-'))
  const squatter = await occupyLoopbackPort()
  /** @type {ChildProcess | undefined} */
  let child
  try {
    const configPath = await writeGatewayHome(hypHome, `127.0.0.1:${portOf(squatter)}`)
    let squatterConnections = 0
    squatter.on('connection', socket => { squatterConnections++; socket.destroy() })
    child = spawn(process.execPath, [path.join(REPO_ROOT, 'bin', 'hypaware.js'), 'daemon', 'run', '--config', configPath], {
      cwd: hypHome,
      env: { ...process.env, HOME: hypHome, HYP_HOME: hypHome, INVOCATION_ID: 'test-invocation', XPC_SERVICE_NAME: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const proc = child
    let stderr = ''
    const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })))
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`never reached the retry wait: ${stderr}`)), 45_000)
      proc.stderr?.on('data', chunk => {
        stderr += String(chunk)
        if (stderr.includes('retrying in 60s')) { clearTimeout(timer); resolve(undefined) }
      })
      proc.once('exit', () => { clearTimeout(timer); reject(new Error(`exited before the wait: ${stderr}`)) })
    })
    assert.ok(stderr.includes(`held by pid ${process.pid}`), stderr)

    const signalledAt = Date.now()
    proc.kill('SIGTERM')
    const ending = /** @type {{ code: number | null, signal: string | null }} */ (await exited)
    const tookMs = Date.now() - signalledAt
    assert.ok(tookMs < 5_000, `the stop took ${tookMs}ms`)
    assert.deepEqual(ending, { code: 0, signal: null }, 'the wait ends as a requested stop')

    // The probe only read: the owner still holds its port, and was never connected to.
    assert.equal(squatter.listening, true)
    assert.equal(squatterConnections, 0)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await new Promise(resolve => squatter.close(resolve))
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
