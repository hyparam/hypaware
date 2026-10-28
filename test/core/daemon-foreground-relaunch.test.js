// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { runDaemonRun } from '../../src/core/commands/daemon.js'
import { RELAUNCH_LIMIT, RELAUNCH_WINDOW_MS, relaunchDelayMs, relaunchForeground } from '../../src/core/daemon/relaunch.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { LAUNCH_LABEL } from '../../src/core/daemon/platform.js'

/** @import { AddressInfo } from 'node:net' */
/** @import { ChildProcess } from 'node:child_process' */

// Issue #2513. An unsupervised `hyp daemon run` (a container) exited 75 on
// every staged config apply, and nothing relaunched it, so the gateway went
// down with it. It now relaunches itself, bounded, and a supervised run is
// unchanged.
// @ref LLP 0529#bounded [tests]: the cap, the backoff, the window reset and the real exit 75 naming the staged config
// @ref LLP 0529#who-relaunches [tests]: supervised and launcher-owned runs exit 75 exactly as before

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function buf() {
  let text = ''
  return { write(/** @type {string} */ chunk) { text += chunk; return true }, text: () => text }
}

/**
 * A spawn stand-in whose children exit with the queued codes, in order.
 *
 * @param {Array<number | null | 'error'>} codes
 */
function fakeSpawn(codes) {
  /** @type {Array<{ command: string, args: string[], options: any, child: EventEmitter & { kill: (signal: string) => void, killed: string[] } }>} */
  const calls = []
  /** @param {string} command @param {string[]} args @param {object} options */
  const spawnChild = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      killed: /** @type {string[]} */ ([]),
      /** @param {string} signal */
      kill(signal) { child.killed.push(signal) },
    })
    calls.push({ command, args, options, child })
    const code = codes.shift()
    if (code === 'error') setImmediate(() => child.emit('error', new Error('spawn ENOENT')))
    else if (code !== null && code !== undefined) setImmediate(() => child.emit('exit', code, null))
    return /** @type {ChildProcess} */ (/** @type {unknown} */ (child))
  }
  return { calls, spawnChild }
}

/** @param {Partial<Parameters<typeof relaunchForeground>[0]>} overrides */
function relaunchOpts(overrides) {
  return {
    env: { HOME: '/home/test' },
    stdout: buf(),
    stderr: buf(),
    stagedConfigPath: () => '/state/config-control/config.b.json',
    command: '/usr/bin/node',
    args: ['/app/bin/hypaware.js', 'daemon', 'run', '--config', '/etc/hyp.json'],
    cwd: '/srv',
    signals: new EventEmitter(),
    ...overrides,
  }
}

test('the backoff waits nothing before the first relaunch, then doubles from 1s', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(relaunchDelayMs), [0, 1000, 2000, 4000, 8000])
})

test('a config that fails every apply relaunches RELAUNCH_LIMIT times, then exits 75 naming the staged config', async () => {
  const { calls, spawnChild } = fakeSpawn(Array(RELAUNCH_LIMIT + 3).fill(75))
  /** @type {number[]} */
  const waits = []
  const opts = relaunchOpts({ spawn: spawnChild, sleep: async ms => { waits.push(ms) }, now: () => 0 })
  const code = await relaunchForeground(opts)
  assert.equal(code, 75)
  assert.equal(calls.length, RELAUNCH_LIMIT, 'no hot loop past the cap')
  assert.deepEqual(waits, [1000, 2000, 4000, 8000])
  assert.match(/** @type {any} */ (opts.stderr).text(), /restarted 5 times in 10 minutes without staying up; exiting 75\. Check the staged config: \/state\/config-control\/config\.b\.json\n$/)
  // The child is the same command: argv, env, cwd, and inherited stdio.
  for (const call of calls) {
    assert.equal(call.command, '/usr/bin/node')
    assert.deepEqual(call.args, ['/app/bin/hypaware.js', 'daemon', 'run', '--config', '/etc/hyp.json'])
    assert.equal(call.options.env, opts.env)
    assert.equal(call.options.cwd, '/srv')
    assert.deepEqual(call.options.stdio, ['inherit', 'inherit', 'inherit', 'ipc'])
  }
})

test('the count resets once the window passes, so a daemon that stays up keeps applying', async () => {
  let clock = 0
  const { calls, spawnChild } = fakeSpawn([...Array(RELAUNCH_LIMIT).fill(75), 0])
  /** @type {number[]} */
  const waits = []
  const code = await relaunchForeground(relaunchOpts({
    spawn: spawnChild,
    sleep: async ms => { waits.push(ms) },
    // Each child runs longer than the window, as a serving daemon would.
    now: () => (clock += RELAUNCH_WINDOW_MS),
  }))
  assert.equal(code, 0)
  assert.equal(calls.length, RELAUNCH_LIMIT + 1)
  assert.deepEqual(waits, [], 'every relaunch is the first of its window')
})

test('a child that stops for any other reason ends the run with its code', async () => {
  for (const [exit, expected] of /** @type {Array<[number, number]>} */ ([[0, 0], [1, 1], [2, 2]])) {
    const { calls, spawnChild } = fakeSpawn([exit])
    assert.equal(await relaunchForeground(relaunchOpts({ spawn: spawnChild })), expected)
    assert.equal(calls.length, 1)
  }
  // Killed by a signal: the shell convention, 128 + the signal number.
  const { calls, spawnChild } = fakeSpawn([null])
  const running = relaunchForeground(relaunchOpts({ spawn: spawnChild }))
  await new Promise(resolve => setImmediate(resolve))
  calls[0].child.emit('exit', null, 'SIGKILL')
  assert.equal(await running, 128 + os.constants.signals.SIGKILL)
})

test('stop signals reach the child and end the loop; SIGHUP is a reload and is relaunched', async () => {
  const signals = new EventEmitter()
  /** @type {Array<EventEmitter & { killed: string[] }>} */
  const children = []
  /** @param {string} _command @param {string[]} _args @param {object} _options */
  const spawnChild = (_command, _args, _options) => {
    const child = Object.assign(new EventEmitter(), {
      killed: /** @type {string[]} */ ([]),
      /** @param {string} signal */
      kill(signal) {
        child.killed.push(signal)
        // The gateway's own handlers: a reload exits 75, a stop exits 0.
        setImmediate(() => child.emit('exit', signal === 'SIGHUP' ? 75 : 0, null))
      },
    })
    children.push(child)
    return /** @type {ChildProcess} */ (/** @type {unknown} */ (child))
  }
  const running = relaunchForeground(relaunchOpts({ spawn: spawnChild, signals, sleep: async () => {} }))
  await new Promise(resolve => setImmediate(resolve))
  signals.emit('SIGHUP')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(children.length, 2, 'the reload is relaunched')
  signals.emit('SIGTERM')
  assert.equal(await running, 0)
  assert.deepEqual(children.map(child => child.killed), [['SIGHUP'], ['SIGTERM']])
  assert.equal(children.length, 2, 'no relaunch after a stop')
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 0, `${signal} handler removed`)
})

test('a stop during a backoff wait ends it at once with exit 0', async () => {
  const signals = new EventEmitter()
  const { calls, spawnChild } = fakeSpawn([75, 75])
  let waiting = false
  const running = relaunchForeground(relaunchOpts({
    spawn: spawnChild,
    signals,
    sleep: (_ms, signal) => {
      waiting = true
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    },
  }))
  while (!waiting) await new Promise(resolve => setImmediate(resolve))
  signals.emit('SIGINT')
  assert.equal(await running, 0)
  assert.equal(calls.length, 1, 'the first relaunch had no wait; the stop ended the second one')
})

test('a relaunch that cannot start exits 75 without retrying', async () => {
  const { calls, spawnChild } = fakeSpawn(['error', 75])
  const opts = relaunchOpts({ spawn: spawnChild })
  assert.equal(await relaunchForeground(opts), 75)
  assert.equal(calls.length, 1)
  assert.match(/** @type {any} */ (opts.stderr).text(), /relaunch failed: spawn ENOENT/)
})

/**
 * `hyp daemon run` with the gateway boot stubbed to end with `exitCode`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {number} exitCode
 * @param {{ hasLauncher?: () => boolean, argv?: string[] }} [extra]
 */
async function runWithStub(env, exitCode, extra = {}) {
  const stdout = buf()
  const stderr = buf()
  /** @type {any[]} */
  const relaunches = []
  /** @type {any[]} */
  const boots = []
  const code = await runDaemonRun(extra.argv ?? [], /** @type {any} */ ({ env, stdout, stderr }), {
    runDaemon: async opts => { boots.push(opts); return { done: Promise.resolve(exitCode) } },
    hasLauncher: extra.hasLauncher ?? (() => false),
    relaunch: async opts => { relaunches.push(opts); return 0 },
  })
  return { code, stdout: stdout.text().replace(/pid=\d+/, 'pid=N'), stderr: stderr.text(), relaunches, relaunchesOnRestart: boots[0].relaunchesOnRestart }
}

test('a supervised run exits 75 exactly as before; only an unsupervised one relaunches', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-relaunch-branch-'))
  try {
    const base = { HOME: hypHome, HYP_HOME: hypHome }
    const plain = 'daemon: running (pid=N)\ndaemon: stopped\n'
    for (const env of [{ ...base, INVOCATION_ID: 'systemd-unit' }, { ...base, XPC_SERVICE_NAME: LAUNCH_LABEL }]) {
      const result = await runWithStub(env, 75)
      // No `relaunchesOnRestart` reaches the gateway, so its stop deadline still exits.
      assert.deepEqual(result, { code: 75, stdout: plain, stderr: '', relaunches: [], relaunchesOnRestart: undefined }, JSON.stringify(env))
    }
    // A Node parent with an IPC channel (an earlier run, pm2) owns the relaunch.
    assert.deepEqual(await runWithStub(base, 75, { hasLauncher: () => true }), { code: 75, stdout: plain, stderr: '', relaunches: [], relaunchesOnRestart: undefined })
    // Any other exit is never relaunched.
    assert.deepEqual(await runWithStub(base, 0), { code: 0, stdout: plain, stderr: '', relaunches: [], relaunchesOnRestart: true })

    const unsupervised = await runWithStub({ ...base, INVOCATION_ID: '', XPC_SERVICE_NAME: 'application.com.apple.Terminal' }, 75)
    assert.equal(unsupervised.code, 0, 'the relaunch decides the exit')
    assert.equal(unsupervised.relaunchesOnRestart, true, 'the gateway is told its stop deadline must not exit the run')
    assert.equal(unsupervised.relaunches.length, 1)
    // Before any apply the staged config is the local file; once joined, the central layer.
    assert.equal(unsupervised.relaunches[0].stagedConfigPath(), defaultConfigPath(hypHome))
    const seed = centralSeedPath(path.join(hypHome, 'hypaware'))
    await fs.mkdir(path.dirname(seed), { recursive: true })
    await fs.writeFile(seed, '{}')
    assert.equal(unsupervised.relaunches[0].stagedConfigPath(), seed)

    // With no central layer, the config the boot actually read: HYP_CONFIG before the default.
    const pointed = await runWithStub({ ...base, HYP_CONFIG: path.join(hypHome, 'elsewhere.json') }, 75)
    await fs.rm(seed)
    assert.equal(pointed.relaunches[0].stagedConfigPath(), path.join(hypHome, 'elsewhere.json'))
    const explicit = await runWithStub({ ...base, HYP_CONFIG: path.join(hypHome, 'elsewhere.json') }, 75, { argv: ['--config', path.join(hypHome, 'given.json')] })
    assert.equal(explicit.relaunches[0].stagedConfigPath(), path.join(hypHome, 'given.json'), '--config before HYP_CONFIG')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

/** @returns {Promise<number>} */
async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const port = /** @type {AddressInfo} */ (server.address()).port
  await new Promise(resolve => server.close(resolve))
  return port
}

/** @param {http.RequestListener} handler */
async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  return { server, url: `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}` }
}

/** @param {string} url */
async function ask(url) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m","messages":[]}' })
  return { status: res.status, body: await res.text() }
}

/**
 * @param {() => Promise<boolean> | boolean} predicate
 * @param {number} ms
 * @param {() => string} describe
 */
async function waitFor(predicate, ms, describe) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try { if (await predicate()) return } catch { /* not yet */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`timed out: ${describe()}`)
}

test('an unsupervised daemon run applies a staged central config and keeps the gateway answering', { timeout: 90_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-relaunch-e2e-'))
  const hypHome = path.join(root, '.hyp')
  const stateRoot = path.join(hypHome, 'hypaware')
  // The upstream the gateway forwards to: its answer is the identity the test
  // compares, because it does not depend on which process served it.
  const upstream = await listen((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"upstream":"relaunch-e2e"}')
    })
  })
  /** @type {unknown} */
  let served = null
  let initialPolls = 0
  const central = await listen((req, res) => {
    req.resume()
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST' && url.pathname.startsWith('/v1/identity/')) {
      const b64 = (/** @type {object} */ obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jwt: `${b64({ alg: 'none' })}.${b64({ sub: 'relaunch-e2e' })}.x`, expires_at: Math.floor(Date.now() / 1000) + 86400 }))
    } else if (req.method === 'GET' && url.pathname === '/v1/config') {
      // The revision is temporarily unavailable. A 404 invokes the protocol's
      // five-minute legacy backoff, making this test race its 45-second wait.
      if (!served) { initialPolls++; res.writeHead(503, { 'retry-after': '1' }); res.end() }
      else if (req.headers['if-none-match'] === 'rev-1') { res.writeHead(304, { etag: 'rev-1' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'application/json', etag: 'rev-1' }); res.end(JSON.stringify(served)) }
    } else {
      res.writeHead(202)
      res.end()
    }
  })
  /** @type {ChildProcess | undefined} */
  let daemon
  try {
    const port = await freePort()
    await fs.mkdir(hypHome, { recursive: true })
    await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
      version: 2,
      auto_update: false,
      plugins: [{
        name: '@hypaware/ai-gateway',
        config: { listen: `127.0.0.1:${port}`, upstreams: [{ name: 'anthropic', base_url: upstream.url, path_prefix: '/v1/messages' }] },
      }],
    }))
    const centralLayer = (/** @type {object} */ identity) => ({
      version: 2,
      plugins: [{ name: '@hypaware/central' }],
      sinks: { central: { plugin: '@hypaware/central', config: { url: central.url, identity, schedule: '0 * * * *', poll_interval_seconds: 5 } } },
    })
    const seedPath = centralSeedPath(stateRoot)
    await fs.mkdir(path.dirname(seedPath), { recursive: true })
    await fs.writeFile(seedPath, JSON.stringify(centralLayer({ bootstrap_token: 'relaunch-e2e-token' })))

    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, HOME: root, HYP_HOME: hypHome, HYP_DEV_TELEMETRY: '1' }
    // Unsupervised: neither systemd's nor launchd's marker.
    delete env.INVOCATION_ID
    delete env.XPC_SERVICE_NAME
    const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'bin', 'hypaware.js'), 'daemon', 'run'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    daemon = proc
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', chunk => { stdout += chunk })
    proc.stderr?.on('data', chunk => { stderr += chunk })
    const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })))
    const describe = () => `stdout:\n${stdout}\nstderr:\n${stderr}`
    const gateway = `http://127.0.0.1:${port}/v1/messages`

    await waitFor(async () => (await ask(gateway)).status === 200, 30_000, describe)
    const before = await ask(gateway)
    assert.deepEqual(before, { status: 200, body: '{"upstream":"relaunch-e2e"}' })

    // Central now serves a revision: the daemon applies it, which is a staged restart.
    await waitFor(() => initialPolls > 0, 5000, describe)
    served = centralLayer({})
    await waitFor(() => /daemon: running \(pid=\d+\)[\s\S]*daemon: running \(pid=\d+\)/.test(stdout), 45_000, describe)
    await waitFor(async () => (await ask(gateway)).status === 200, 30_000, describe)
    const after = await ask(gateway)

    assert.deepEqual(after, before, 'the same gateway answers after the apply')
    assert.equal(proc.exitCode, null, 'the process the container runs never exited')
    assert.match(stdout, /daemon: relaunching to apply the staged config/)
    const pids = [...stdout.matchAll(/daemon: running \(pid=(\d+)\)/g)].map(match => Number(match[1]))
    assert.equal(pids[0], proc.pid)
    assert.notEqual(pids[1], proc.pid, 'the relaunch is a fresh process (LLP 0017)')
    const applied = JSON.parse(await fs.readFile(path.join(stateRoot, 'config-control', 'config.b.json'), 'utf8'))
    assert.equal(applied.sinks.central.config.identity.bootstrap_token, undefined, 'the served revision is the operative central layer')

    proc.kill('SIGTERM')
    assert.deepEqual(await exited, { code: 0, signal: null }, describe())
    await assert.rejects(ask(gateway), 'the relaunched gateway stopped with the run')
  } finally {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL')
    await new Promise(resolve => upstream.server.close(resolve))
    central.server.closeAllConnections()
    await new Promise(resolve => central.server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a reload whose processing child will not stop still relaunches once the stop deadline kills it', { timeout: 90_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-relaunch-stalled-'))
  const hypHome = path.join(root, '.hyp')
  const upstream = await listen((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"upstream":"relaunch-stalled"}')
    })
  })
  /** @type {ChildProcess | undefined} */
  let daemon
  /** @type {number | undefined} */
  let stalled
  try {
    const port = await freePort()
    await fs.mkdir(hypHome, { recursive: true })
    await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
      version: 2,
      auto_update: false,
      plugins: [{
        name: '@hypaware/ai-gateway',
        config: { listen: `127.0.0.1:${port}`, upstreams: [{ name: 'anthropic', base_url: upstream.url, path_prefix: '/v1/messages' }] },
      }],
    }))
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, HOME: root, HYP_HOME: hypHome, HYP_DEV_TELEMETRY: '1' }
    delete env.INVOCATION_ID
    delete env.XPC_SERVICE_NAME
    const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'bin', 'hypaware.js'), 'daemon', 'run'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    daemon = proc
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', chunk => { stdout += chunk })
    proc.stderr?.on('data', chunk => { stderr += chunk })
    const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })))
    const describe = () => `stdout:\n${stdout}\nstderr:\n${stderr}`
    const gateway = `http://127.0.0.1:${port}/v1/messages`
    const statusFile = path.join(hypHome, 'hypaware', 'run', 'status.json')
    /** @returns {Promise<any>} */
    const readStatus = async () => JSON.parse(await fs.readFile(statusFile, 'utf8'))

    await waitFor(async () => (await readStatus()).state === 'healthy' && (await ask(gateway)).status === 200, 30_000, describe)
    const first = await readStatus()
    stalled = first.processes.processing.pid
    assert.equal(first.processes.gateway.pid, proc.pid)
    // A processing child that cannot answer the stop: only the deadline's SIGKILL ends it.
    process.kill(/** @type {number} */ (stalled), 'SIGSTOP')
    proc.kill('SIGHUP')

    await waitFor(() => /daemon: relaunching to apply the staged config/.test(stdout), 20_000, describe)
    await waitFor(async () => {
      const next = await readStatus()
      return next.state === 'healthy' && next.processes.gateway.pid !== proc.pid && (await ask(gateway)).status === 200
    }, 30_000, describe)
    const relaunched = await readStatus()
    assert.equal(proc.exitCode, null, 'the deadline did not exit the run past its relaunch')
    assert.equal(alive(/** @type {number} */ (stalled)), false, 'the stalled child was killed, not orphaned')
    assert.notEqual(relaunched.processes.processing.pid, stalled)
    assert.equal([...stdout.matchAll(/daemon: relaunching/g)].length, 1)
    assert.deepEqual(await ask(gateway), { status: 200, body: '{"upstream":"relaunch-stalled"}' })

    proc.kill('SIGTERM')
    assert.deepEqual(await exited, { code: 0, signal: null }, describe())
    await assert.rejects(ask(gateway), 'nothing still serves after the run stopped')
  } finally {
    if (stalled !== undefined && alive(stalled)) {
      try { process.kill(stalled, 'SIGKILL') } catch { /* gone */ }
    }
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL')
    await new Promise(resolve => upstream.server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  }
})

/** @param {number} pid @returns {boolean} */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
