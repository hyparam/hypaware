// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
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
  writePidFile(stateRoot, /** @type {any} */ ({ pid, runId: 'test-run', mode: 'detached' }))
  writeStatusFile(stateRoot, /** @type {any} */ ({
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
  }))
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
  })
}

test('a live daemon whose listener accepts TCP but never answers is not reported healthy', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const stalled = await startStalledListener(4000)
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
