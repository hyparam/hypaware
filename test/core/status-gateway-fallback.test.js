// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, gatewaySourceDetails, writeStatusFile } from '../../src/core/daemon/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

// The `gateway_port_fallback` diagnostic: a fallback boot (default port
// taken, gateway on an ephemeral bind) must be readable from `hyp status`,
// not only from a boot-time log line. Non-degrading, like
// `client_attach_stale`.
// @ref LLP 0114#fallback-is-visible [tests]:

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-fallback-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

/**
 * Simulate a live daemon: a pid file naming this (alive) test process, and a
 * status snapshot whose gateway source carries the given details.
 *
 * @param {string} stateRoot
 * @param {Record<string, unknown>} details
 */
function writeRunningDaemon(stateRoot, details) {
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'test-run', mode: 'foreground' }))
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'running',
    sources: [{ name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'ready', details }],
    sinks: [],
  }))
}

function collectOpts(/** @type {string} */ hypHome) {
  // Stub out the launch-agent probe so the machine's real daemon install
  // cannot leak into the report; daemon liveness then comes from the pid
  // file written above.
  return { env: env(hypHome), platform: 'darwin', isLaunchAgentInstalled: () => false }
}

test('gatewaySourceDetails surfaces the fallback marker from status.json', () => {
  const details = gatewaySourceDetails(/** @type {any} */ ([{
    name: 'ai-gateway',
    plugin: '@hypaware/ai-gateway',
    details: { host: '127.0.0.1', port: 54321, listen_fallback: true, listen_fallback_from: '127.0.0.1:18521' },
  }]))
  assert.ok(details)
  assert.equal(details.port, 54321)
  assert.equal(details.listenFallback, true)
  assert.equal(details.listenFallbackFrom, '127.0.0.1:18521')
})

test('a fallback boot emits a non-degrading gateway_port_fallback warning', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, {
    host: '127.0.0.1',
    port: 54321,
    listen_fallback: true,
    listen_fallback_from: '127.0.0.1:18521',
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_port_fallback')
  assert.ok(diag, 'gateway_port_fallback diagnostic is emitted')
  assert.equal(diag.severity, 'warning')
  assert.match(diag.message, /127\.0\.0\.1:18521/)
  assert.match(diag.message, /54321/)
})

test('a default-port boot emits no gateway_port_fallback diagnostic', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, { host: '127.0.0.1', port: 18521 })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_port_fallback'), undefined)
})
