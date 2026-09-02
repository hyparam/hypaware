// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
import { runDaemonStatus } from '../../src/core/commands/daemon.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

// Issue #1003. A daemon whose event loop cannot run still owns its pid and
// still holds its bound listeners: the kernel completes the TCP handshake out
// of the accept backlog, so a client connects instantly and then waits for
// bytes that never come. `hyp status` read `state` straight out of
// `status.json` and reported whatever the last tick wrote there, which is
// `healthy` - the file freezes at exactly the moment the daemon stops being
// able to serve.
// @ref LLP 0348#stale-heartbeat-is-unresponsive [tests]:

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-heartbeat-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  // Stub the launch-agent probe so the developer's own installed daemon
  // cannot leak into the report; liveness then comes from the pid file.
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

/**
 * The snapshot a daemon leaves behind. `healthyAt` plus `uptimeMs` is the
 * moment of the last `persist()`: the tick recomputes `uptimeMs` from
 * `healthyAt` on every write, so the pair already carries the heartbeat and
 * nothing new has to be recorded to read it back.
 *
 * @param {string} stateRoot
 * @param {{ pid: number, lastPersistAgoMs: number, port: number, otelPort: number }} args
 */
function writeDaemonSnapshot(stateRoot, { pid, lastPersistAgoMs, port, otelPort }) {
  const healthyAtMs = Date.now() - lastPersistAgoMs - 60_000
  const snapshot = {
    state: 'healthy',
    pid,
    startedAt: new Date(healthyAtMs - 1000).toISOString(),
    healthyAt: new Date(healthyAtMs).toISOString(),
    uptimeMs: Date.now() - healthyAtMs - lastPersistAgoMs,
    runId: 'test-run',
    mode: 'detached',
    sources: [
      { name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started', details: { host: '127.0.0.1', port } },
      { name: 'claude-otel', plugin: '@hypaware/otel', state: 'started', details: { host: '127.0.0.1', port: otelPort } },
    ],
    sinks: [],
  }
  writePidFile(stateRoot, /** @type {any} */ ({ pid, runId: 'test-run', mode: 'detached' }))
  writeStatusFile(stateRoot, /** @type {any} */ (snapshot))
  return snapshot
}

/**
 * Connect, send a small HTTP request, and report how many response bytes came
 * back before the deadline. This is the probe from the issue: a stalled
 * listener answers the connect and then nothing.
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{ connected: boolean, bytes: number }>}
 */
function probeHttp(port, timeoutMs) {
  return new Promise((resolve) => {
    let connected = false
    let bytes = 0
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = () => {
      socket.destroy()
      resolve({ connected, bytes })
    }
    socket.setTimeout(timeoutMs, finish)
    socket.on('connect', () => {
      connected = true
      socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    })
    socket.on('data', (chunk) => { bytes += chunk.length })
    socket.on('error', finish)
    socket.on('close', finish)
  })
}

/**
 * A child that binds an HTTP listener and then blocks its event loop, which
 * is the fault: the process is alive, the port is bound, the accept backlog
 * completes handshakes, and no byte of HTTP is ever written.
 *
 * @param {number} blockMs
 * @returns {Promise<{ pid: number, port: number, kill: () => void }>}
 */
function startStalledListener(blockMs) {
  const source = `
    const http = require('node:http')
    const server = http.createServer((_req, res) => res.end('ok'))
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n')
      const sab = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(sab, 0, 0, ${blockMs})
      process.exit(0)
    })
  `
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] })
  return new Promise((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', (chunk) => {
      buf += String(chunk)
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const { port } = JSON.parse(buf.slice(0, nl))
      resolve({ pid: /** @type {number} */ (child.pid), port, kill: () => child.kill('SIGKILL') })
    })
    child.on('error', reject)
    // A child that dies before it prints its port would otherwise leave this
    // promise unsettled forever, and the runner sets no per-test timeout, so
    // the whole suite would hang with nothing said. A reject after a resolve
    // is a no-op, so the normal exit (the block elapses, or the kill below)
    // is unaffected.
    child.on('exit', (code, signal) => {
      reject(new Error(`the stalled-listener child exited before it bound a port (code ${code}, signal ${signal})`))
    })
  })
}

test('a live daemon whose listener accepts TCP but never answers is not reported healthy', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // Long enough that the child is still blocked for the whole test. The
  // `finally` below kills it, so the number is a ceiling on a leak, not a
  // budget the assertions have to finish inside: at 4s a loaded runner could
  // let the child exit mid-collect and fail on `daemon.running` instead.
  const stalled = await startStalledListener(60_000)
  try {
    // Ground truth for the fault: the connect succeeds and zero bytes come back.
    const probe = await probeHttp(stalled.port, 700)
    assert.equal(probe.connected, true, 'the stalled listener still completes the TCP handshake')
    assert.equal(probe.bytes, 0, 'and returns no HTTP bytes before the deadline')

    // What such a daemon leaves in status.json: its last persist is old,
    // because the tick that writes the file cannot run either. Written
    // directly rather than waited for, so the test does not sleep out the
    // real staleness window.
    writeDaemonSnapshot(stateRoot, {
      pid: stalled.pid,
      lastPersistAgoMs: 11 * 60_000,
      port: stalled.port,
      otelPort: stalled.port,
    })

    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.equal(report.daemon.running, true, 'the process is alive and owns its pid')
    assert.notEqual(report.daemon.state, 'healthy', 'a daemon that cannot serve must not report healthy')
    assert.equal(report.overall, 'degraded')
    const diag = report.diagnostics.find((d) => d.kind === 'daemon_heartbeat_stale')
    assert.ok(diag, 'a daemon_heartbeat_stale diagnostic is emitted')
    assert.equal(diag.severity, 'error')
  } finally {
    stalled.kill()
  }
})

// The over-fixing guard. A daemon that is ticking normally must stay healthy,
// with no new diagnostic and no change to `overall`.
test('a daemon that persisted within the heartbeat window still reports healthy', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeDaemonSnapshot(stateRoot, {
    pid: process.pid,
    lastPersistAgoMs: 5_000,
    port: 18521,
    otelPort: 4319,
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.running, true)
  assert.equal(report.daemon.state, 'healthy')
  assert.equal(report.overall, 'healthy')
  assert.equal(report.diagnostics.find((d) => d.kind === 'daemon_heartbeat_stale'), undefined)
})

// A stopped daemon leaves a status file that ages forever. Staleness is only
// a claim about a process that is still running, so a leftover snapshot must
// not manufacture an error.
test('a status file left behind by a dead daemon raises no heartbeat diagnostic', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const healthyAtMs = Date.now() - 24 * 3_600_000
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    pid: 999_999,
    startedAt: new Date(healthyAtMs).toISOString(),
    healthyAt: new Date(healthyAtMs).toISOString(),
    uptimeMs: 60_000,
    runId: 'test-run',
    mode: 'detached',
    sources: [],
    sinks: [],
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.running, false)
  assert.equal(report.diagnostics.find((d) => d.kind === 'daemon_heartbeat_stale'), undefined)
})

// Pid reuse. `processIsAlive` proves a pid is taken, not that the daemon took
// it, so a leftover snapshot whose pid the OS has since handed to an unrelated
// process must not be read as that process's frozen heartbeat.
test('a leftover snapshot is not read as the heartbeat of whatever now holds its pid', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const healthyAtMs = Date.now() - 90 * 60_000
  // The pid file names this live process; the snapshot names a different one.
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'test-run', mode: 'detached' }))
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    pid: process.pid + 1,
    startedAt: new Date(healthyAtMs).toISOString(),
    healthyAt: new Date(healthyAtMs).toISOString(),
    uptimeMs: 60_000,
    runId: 'other-run',
    mode: 'detached',
    sources: [],
    sinks: [],
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.running, true)
  assert.equal(report.diagnostics.find((d) => d.kind === 'daemon_heartbeat_stale'), undefined)
  assert.equal(report.overall, 'healthy')
})

// The same wedge, read from the other command. `hyp status` reports the
// collector's verdict, but `hyp daemon status` transcribed `state` straight
// out of the file and recomputed `uptime_ms` against `Date.now()`, so during
// the wedge the two commands gave an operator contradictory answers and the
// uptime counter went on climbing for a loop that had stopped running
// (issue #1183, deferred from PR #1181).
// @ref LLP 0348#stale-heartbeat-is-unresponsive [tests]: the state reported for a live pid is a verdict on every surface that prints it, not a transcription

/**
 * @param {string} hypHome
 * @param {string[]} [argv]
 * @returns {Promise<{ code: number, out: string }>}
 */
async function runDaemonStatusText(hypHome, argv = []) {
  let out = ''
  const ctx = /** @type {any} */ ({
    env: { ...process.env, HYP_HOME: hypHome },
    stdout: { write: (/** @type {string} */ chunk) => { out += String(chunk); return true } },
    stderr: { write: () => true },
    argv,
  })
  const code = await runDaemonStatus(argv, ctx)
  return { code, out }
}

test('hyp daemon status does not repeat a wedged daemon\'s recorded healthy state', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const snapshot = writeDaemonSnapshot(stateRoot, {
    pid: process.pid,
    lastPersistAgoMs: 11 * 60_000,
    port: 18521,
    otelPort: 4319,
  })

  const { out } = await runDaemonStatusText(hypHome)
  assert.match(out, /^daemon: degraded/, 'a daemon that cannot serve must not print healthy here either')
  assert.match(out, /no status write for 11m/, 'and says how long the snapshot has been frozen')
  // The uptime counter stops at the last write. `now - healthyAt` would keep
  // advancing it for a loop that is not running.
  assert.match(out, new RegExp(`uptime_ms:\\s+${snapshot.uptimeMs}\\n`))
})

// The machine copy is unchanged: `--json` stays a byte-exact copy of the file
// (LLP 0225), including the `uptimeMs` the heartbeat derivation reads.
test('hyp daemon status --json still copies the wedged snapshot verbatim', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const snapshot = writeDaemonSnapshot(stateRoot, {
    pid: process.pid,
    lastPersistAgoMs: 11 * 60_000,
    port: 18521,
    otelPort: 4319,
  })

  const { out } = await runDaemonStatusText(hypHome, ['--json'])
  const payload = JSON.parse(out)
  assert.equal(payload.running, true)
  assert.equal(payload.state, 'healthy')
  assert.equal(payload.uptimeMs, snapshot.uptimeMs)
})

// The over-fixing guard. A daemon that is ticking normally prints exactly what
// it printed before: its own state, no annotation, and the live uptime.
test('hyp daemon status still prints the recorded state and live uptime for a ticking daemon', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const snapshot = writeDaemonSnapshot(stateRoot, {
    pid: process.pid,
    lastPersistAgoMs: 5_000,
    port: 18521,
    otelPort: 4319,
  })

  const { out } = await runDaemonStatusText(hypHome)
  assert.match(out, /^daemon: healthy\n/)
  assert.doesNotMatch(out, /status write/)
  const uptime = Number(/uptime_ms:\s+(\d+)/.exec(out)?.[1])
  assert.ok(uptime >= snapshot.uptimeMs, 'a live daemon keeps the up-to-date uptime')
})

// A leftover snapshot ages forever and is a record, not a claim about now, so
// it must not be annotated as stale.
test('hyp daemon status leaves a dead daemon\'s leftover snapshot alone', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const healthyAtMs = Date.now() - 24 * 3_600_000
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    pid: 999_999,
    startedAt: new Date(healthyAtMs).toISOString(),
    healthyAt: new Date(healthyAtMs).toISOString(),
    uptimeMs: 60_000,
    runId: 'test-run',
    mode: 'detached',
    sources: [],
    sinks: [],
  }))

  const { out } = await runDaemonStatusText(hypHome)
  assert.match(out, /^daemon: healthy \(no live process\)\n/)
  assert.doesNotMatch(out, /status write/)
})

// Pid reuse, on this surface too: the pid file names a live process, the
// snapshot names a different one, so the frozen pair is not that stranger's
// heartbeat and must not be reported as one.
test('hyp daemon status does not read a leftover snapshot as the heartbeat of whatever now holds its pid', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const healthyAtMs = Date.now() - 90 * 60_000
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'test-run', mode: 'detached' }))
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    pid: process.pid + 1,
    startedAt: new Date(healthyAtMs).toISOString(),
    healthyAt: new Date(healthyAtMs).toISOString(),
    uptimeMs: 60_000,
    runId: 'other-run',
    mode: 'detached',
    sources: [],
    sinks: [],
  }))

  const { out } = await runDaemonStatusText(hypHome)
  assert.match(out, /^daemon: healthy\n/)
  assert.doesNotMatch(out, /status write/)
  // The uptime is that leftover's own recorded value, not a live count
  // against a stranger's clock: the same snapshot the state line refuses to
  // read as a heartbeat cannot supply a climbing uptime either.
  assert.match(out, /uptime_ms:\s+60000\n/)
})
