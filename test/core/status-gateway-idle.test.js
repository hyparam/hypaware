// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

// The `gateway_idle_no_upstreams` diagnostic. Letting an upstream-less gateway
// idle rather than fail its start (#649, LLP 0120) is right for the config
// that wants it - hermes composes the gateway plugin for its materializer and
// contributes no upstream - but the same idle path swallows a real
// misconfiguration: upstreams that were configured and then dropped whole by
// `compileUpstreams` (a `url =` where `base_url` was meant) leave the source
// `started`, the daemon `healthy`, and the user's client with ECONNREFUSED.
// `details.upstreams` carries the *raw* configured names, so it tells the two
// apart. The diagnostic is non-degrading: a correct hermes-only install must
// stay healthy and quiet.
// @ref LLP 0114#fallback-is-visible [tests]: an idle gateway that was meant to be listening is readable from hyp status, not only from a log line

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-idle-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
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
    sources: [{ name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started', details }],
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
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

test('an idle gateway that was configured with upstreams warns', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // The shape a `url = "..."` typo produces: the name survives into
  // `details.upstreams`, the entry never survives `compileUpstreams`, so
  // nothing is bound and no port is advertised.
  writeRunningDaemon(stateRoot, { listening: false, upstreams: ['anthropic'], registered_presets: [] })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams')
  assert.ok(diag, 'gateway_idle_no_upstreams diagnostic is emitted')
  assert.equal(diag.severity, 'warning')
  assert.match(diag.message, /anthropic/, 'the message names the upstream that went missing')
  assert.match(diag.message, /base_url/, 'and points at the field that drops an entry')
})

test('an idle gateway with no configured upstreams stays quiet and healthy', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // The hermes-only shape: the config asked for no upstream, so idling is the
  // outcome it wanted and there is nothing to report.
  writeRunningDaemon(stateRoot, { listening: false, upstreams: [], registered_presets: [] })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'), undefined)
  assert.equal(report.overall, 'healthy', 'a deliberately idle gateway is a working install')
})

test('a listening gateway never warns, however many upstreams it has', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, { host: '127.0.0.1', port: 18521, upstreams: ['anthropic'] })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'), undefined)
})

test('the idle warning does not degrade overall health', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, { listening: false, upstreams: ['anthropic'] })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.ok(report.diagnostics.some((d) => d.kind === 'gateway_idle_no_upstreams'))
  // Same call as `gateway_port_fallback`: loud in the diagnostics list, but it
  // does not flip `overall`, which is reserved for what makes an install
  // unusable rather than misrouted.
  assert.equal(report.overall, 'healthy')
})

test('a stopped daemon does not warn off a stale status snapshot', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'stopped',
    sources: [{
      name: 'ai-gateway',
      plugin: '@hypaware/ai-gateway',
      state: 'stopped',
      details: { listening: false, upstreams: ['anthropic'] },
    }],
    sinks: [],
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'), undefined)
})
