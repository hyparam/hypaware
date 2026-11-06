// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusSummary, renderStatusText } from '../../src/core/commands/status.js'
import { versionInfo } from '../../src/core/commands/misc.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

// `hyp status` names which install answered (the `hyp version` facts) and the
// gateway id this host forwards under, read from each central sink's identity.
// @ref LLP 0455#identity [tests]

const URL_A = 'https://central-a.example.com'
const JWT = 'header.payload.signature-never-printed'

/** @param {Record<string, unknown>} sinks */
async function makeHome(sinks = {}) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-identity-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  const plugins = Object.keys(sinks).length > 0
    ? [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/central' }]
    : [{ name: '@hypaware/ai-gateway' }]
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins, sinks }) + '\n')
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

/** @param {string} hypHome */
function defaultIdentityPath(hypHome) {
  return path.join(hypHome, 'hypaware', 'plugins', '@hypaware/central', 'identity.json')
}

/**
 * @param {string} file
 * @param {Record<string, unknown>} body
 */
async function writeIdentity(file, body) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(body))
}

/** @param {string} hypHome */
async function renderAll(hypHome) {
  const e = env(hypHome)
  const report = await collectHypAwareStatus({ env: e })
  const info = versionInfo(e)
  let compact = ''
  renderStatusSummary({ report, info, stdout: { write(chunk) { compact += chunk } } })
  let verbose = ''
  renderStatusText({ report, info, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout: { write(chunk) { verbose += chunk } } })
  const json = renderStatusJson({ report, info, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  return { report, info, compact, verbose, json }
}

test('a host that never enrolled reads Not enrolled and a null gateway_id', async () => {
  const hypHome = await makeHome()
  const { report, info, compact, verbose, json } = await renderAll(hypHome)
  assert.deepEqual(report.gateways, [])
  assert.match(compact, /Gateway {4}Not enrolled\n/)
  assert.match(compact, new RegExp(`Version {4}${info.version.replace(/\./g, '\\.')} · ${info.platform} ${info.arch}\\n`))
  assert.match(verbose, /gateway: {2}Not enrolled\n/)
  assert.match(verbose, new RegExp(`hyp_home: ${hypHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`))
  assert.equal(json.identity.gateway_id, null)
  assert.deepEqual(json.identity.gateways, [])
  assert.equal(json.identity.hyp_home, hypHome)
  assert.equal(json.identity.version, info.version)
})

test('an issued identity shows its gateway id and never the JWT', async () => {
  const hypHome = await makeHome({ central: { plugin: '@hypaware/central', config: { url: URL_A } } })
  await writeIdentity(defaultIdentityPath(hypHome), { jwt: JWT, expires_at: 9999999999, gateway_id: 'GW_123456789', central_url: URL_A })
  const { report, compact, verbose, json } = await renderAll(hypHome)
  assert.deepEqual(report.gateways, [{ sink: 'central', gatewayId: 'GW_123456789', state: 'issued' }])
  assert.match(compact, /Gateway {4}GW_123456789\n/)
  assert.match(verbose, /gateway: {2}GW_123456789\n/)
  assert.equal(json.identity.gateway_id, 'GW_123456789')
  for (const out of [compact, verbose, JSON.stringify(json)]) assert.ok(!out.includes(JWT))
})

test('a configured sink with no identity yet, or one a join token replaces, is pending', async () => {
  const hypHome = await makeHome({ central: { plugin: '@hypaware/central', config: { url: URL_A, identity: { bootstrap_token: 'hyp_join_token' } } } })
  let { report, compact } = await renderAll(hypHome)
  assert.deepEqual(report.gateways, [{ sink: 'central', gatewayId: null, state: 'pending' }])
  assert.match(compact, /Gateway {4}Pending \(not issued yet\)\n/)

  await writeIdentity(defaultIdentityPath(hypHome), { jwt: JWT, expires_at: 1, gateway_id: 'GW_OTHER', central_url: 'https://elsewhere.example.com' })
  ;({ report } = await renderAll(hypHome))
  assert.deepEqual(report.gateways, [{ sink: 'central', gatewayId: null, state: 'pending' }])
})

test('an identity another server minted, with no join token to replace it, is not pending', async () => {
  // The sink refuses this identity rather than minting a new one, so the
  // gateway line must not read as if waiting would issue one.
  const hypHome = await makeHome({ central: { plugin: '@hypaware/central', config: { url: URL_A } } })
  await writeIdentity(defaultIdentityPath(hypHome), { jwt: JWT, expires_at: 9999999999, gateway_id: 'GW_OTHER', central_url: 'https://elsewhere.example.com' })
  const { report, compact, verbose, json } = await renderAll(hypHome)
  assert.deepEqual(report.gateways, [{ sink: 'central', gatewayId: null, state: 'other_server' }])
  assert.match(compact, /Gateway {4}Enrolled with another server\n/)
  assert.equal(json.identity.gateway_id, null)
  for (const out of [compact, verbose, JSON.stringify(json)]) assert.ok(!out.includes(JWT) && !out.includes('GW_OTHER'))
})

test('a malformed identity file reads unreadable', async () => {
  const hypHome = await makeHome({ central: { plugin: '@hypaware/central', config: { url: URL_A } } })
  const file = defaultIdentityPath(hypHome)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '{not json')
  const { report, compact, json } = await renderAll(hypHome)
  assert.deepEqual(report.gateways, [{ sink: 'central', gatewayId: null, state: 'unreadable' }])
  assert.match(compact, /Gateway {4}Unreadable identity\n/)
  assert.equal(json.identity.gateway_id, null)
})

test('persisted_path is honored, and several sinks are each named', async () => {
  const hypHome = await makeHome({
    a: { plugin: '@hypaware/central', config: { url: URL_A } },
    b: { plugin: '@hypaware/central', config: { url: URL_A, identity: { persisted_path: '' } } },
  })
  const custom = path.join(hypHome, 'custom-identity.json')
  const configPath = defaultConfigPath(hypHome)
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  config.sinks.b.config.identity.persisted_path = custom
  await fs.writeFile(configPath, JSON.stringify(config))
  await writeIdentity(defaultIdentityPath(hypHome), { jwt: JWT, expires_at: 9999999999, gateway_id: 'GW_A', central_url: URL_A })
  await writeIdentity(custom, { jwt: JWT, expires_at: 9999999999, gateway_id: 'GW_B', central_url: URL_A })
  const { compact, json } = await renderAll(hypHome)
  assert.match(compact, /Gateway {4}GW_A \(a\), GW_B \(b\)\n/)
  assert.equal(json.identity.gateway_id, 'GW_A')
  assert.deepEqual(json.identity.gateways.map((g) => g.gateway_id), ['GW_A', 'GW_B'])
})
