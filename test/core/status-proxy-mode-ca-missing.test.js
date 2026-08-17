// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { ensureLocalCa } from '../../src/core/tls/ca.js'

/**
 * `proxy_mode: true` with no CA on disk used to render as nothing at all:
 * `collectProxyTrust` returns null with no certificate to describe, so the
 * whole `proxy trust` block disappeared and the install reported healthy
 * while every attach it accepted quietly landed in base-URL mode. This is
 * the missing half of a pair whose inverse (proxy mode off, CA present) the
 * gateway has always warned about.
 *
 * @ref LLP 0259#status-names-it [tests]: the config-versus-disk disagreement is named on both surfaces, on every platform
 * @import { CollectStatusOptions, HypAwareStatusReport } from '../../src/core/daemon/types.js'
 */

/**
 * @param {{ proxyMode?: boolean }} [opts]
 * @returns {Promise<{ hypHome: string, stateRoot: string }>}
 */
async function makeHome(opts) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-proxy-ca-missing-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' }],
          ...(opts?.proxyMode === false ? {} : { proxy_mode: true }),
        },
      },
    ],
  }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * @param {string} hypHome
 * @param {NodeJS.Platform} platform
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome, platform) {
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform,
    isLaunchAgentInstalled: () => false,
    isSystemdUnitInstalled: () => false,
    isCaTrusted: async () => true,
    isLaunchdEnvSet: async () => true,
  }
}

/** @returns {{ write(chunk: string): void, text(): string }} */
function buffer() {
  /** @type {string[]} */
  const chunks = []
  return { write: (chunk) => { chunks.push(chunk) }, text: () => chunks.join('') }
}

/**
 * @param {HypAwareStatusReport} report
 * @param {string} cacheRoot
 */
function renderText(report, cacheRoot) {
  const stdout = buffer()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot, stdout })
  return stdout.text()
}

test('proxy_mode on with no CA is a named diagnostic on the text and --json surfaces', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    const report = await collectHypAwareStatus(collectOpts(hypHome, 'darwin'))

    const found = report.diagnostics.find((d) => d.kind === 'proxy_mode_ca_missing')
    assert.ok(found, 'the config-versus-disk disagreement is reported')
    assert.equal(found.severity, 'warning')
    assert.match(found.message, /base-URL mode/)
    assert.ok(
      found.repair.some((r) => r.includes('hyp daemon restart')),
      'the repair that re-mints the CA is named'
    )
    assert.equal(report.proxyTrust, null, 'there is still no certificate to describe')

    const text = renderText(report, path.join(stateRoot, 'cache'))
    assert.match(text, /\[WARN \] proxy_mode_ca_missing:/)
    assert.match(text, /repair: hyp daemon restart/)

    const json = renderStatusJson({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
    })
    assert.ok(
      json.diagnostics.some((d) => d.kind === 'proxy_mode_ca_missing'),
      'the --json surface carries it too'
    )
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// Not a darwin concern: the keychain and launchd halves are, but a config
// that asks for a transport the machine cannot serve is the same defect on
// every platform.
test('the diagnostic is platform-independent', async () => {
  const { hypHome } = await makeHome()
  try {
    const report = await collectHypAwareStatus(collectOpts(hypHome, 'linux'))
    assert.ok(report.diagnostics.some((d) => d.kind === 'proxy_mode_ca_missing'))
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('with the CA on disk there is nothing to report', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    await ensureLocalCa({ stateRoot, hosts: ['api.anthropic.com'] })
    const report = await collectHypAwareStatus(collectOpts(hypHome, 'darwin'))
    assert.ok(!report.diagnostics.some((d) => d.kind === 'proxy_mode_ca_missing'))
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('proxy_mode off and no CA is the ordinary base-URL install, not a fault', async () => {
  const { hypHome } = await makeHome({ proxyMode: false })
  try {
    const report = await collectHypAwareStatus(collectOpts(hypHome, 'darwin'))
    assert.ok(!report.diagnostics.some((d) => d.kind === 'proxy_mode_ca_missing'))
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
