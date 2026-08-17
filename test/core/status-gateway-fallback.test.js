// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, gatewaySourceDetails, writeStatusFile } from '../../src/core/daemon/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

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

/**
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
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

// `listen_fallback_from` is read back out of `status.json` and printed
// verbatim, into this diagnostic's message and into its repair line. That is
// the same last point before render that `recent_entrypoints` and the idle
// gateway's upstream names are cleaned at (LLP 0164), and the value has the
// same provenance as an upstream `name`: config-authored, but reaching core
// through a file this build did not necessarily write.
// @ref LLP 0164#status-reads-it-from-the-status-file [tests]: a display string read out of status.json is cleaned before it reaches the terminal
test('a hostile fallback address cannot drive the terminal from the warning', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, {
    host: '127.0.0.1',
    port: 54321,
    listen_fallback: true,
    // An erase-line sequence and a newline, which together forge a plausible
    // extra status line out of a value the operator never chose to trust.
    listen_fallback_from: '127.0.0.1:18521\u001b[2K\nhyp: all good',
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_port_fallback')
  assert.ok(diag)
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(diag.message), 'no control byte reaches the message')
  assert.ok(
    !diag.repair.some((r) => /[\u0000-\u001f\u007f-\u009f]/.test(r)),
    'and none reaches the repair line, which is printed too',
  )
  assert.match(diag.message, /127\.0\.0\.1:18521/, 'the printable part still names the address')
})

test('an unbounded fallback address is clamped in the warning', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const long = 'a'.repeat(5000)
  writeRunningDaemon(stateRoot, {
    host: '127.0.0.1',
    port: 54321,
    listen_fallback: true,
    listen_fallback_from: long,
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_port_fallback')
  assert.ok(diag)
  assert.ok(!diag.message.includes(long), 'the raw value is not printed whole')
  assert.ok(diag.message.includes('a'.repeat(117) + '...'), 'it is clamped, and marked truncated')
})

// A `listen_fallback_from` that sanitizes away entirely falls back to the
// generic phrasing, exactly as an absent one does: the warning is about the
// bind, and it stays readable with no address to name.
test('a fallback address that sanitizes away leaves the generic phrasing', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, {
    host: '127.0.0.1',
    port: 54321,
    listen_fallback: true,
    listen_fallback_from: '\u200b\u200b',
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_port_fallback')
  assert.ok(diag)
  assert.match(diag.message, /its default listen address/, 'the generic antecedent stands in')
  assert.ok(!diag.message.includes('\u200b'), 'and the empty run does not ride along')
})
