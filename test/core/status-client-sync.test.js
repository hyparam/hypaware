// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'

// On a managed host, a local client addition (LLP 0031 additive layer) is
// collected but never forwarded (LLP 0132 #rule). `hyp status` must show the
// syncing / local-only split so that withholding is never a silent state.
// @ref LLP 0132#never-silent [tests]:

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-client-sync-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

test('a managed host groups picked clients: central -> syncing, local -> local-only', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')

  // Central layer names the ai-gateway + claude; the org manages claude.
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
  }) + '\n')

  // Local layer adds codex - the user's own client the org never asked for.
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/codex' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })

  assert.deepEqual(report.clientSync, { syncing: ['claude'], localOnly: ['codex'] })

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  assert.deepEqual(json.client_sync, { syncing: ['claude'], local_only: ['codex'] })

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  assert.match(stdout.text(), /syncing: claude - local-only: codex/)
})

test('a solo host leaves the split null and the V1 surface unchanged', async () => {
  const hypHome = await makeHome()
  // No central seed: a never-joined host with a couple of local clients.
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/claude' }, { name: '@hypaware/codex' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.clientSync, null)

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  assert.equal(json.client_sync, null)

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  assert.doesNotMatch(stdout.text(), /syncing:/)
})

test('a managed host with only central clients still shows the split (empty local-only)', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')

  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.deepEqual(report.clientSync, { syncing: ['claude'], localOnly: [] })

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  assert.match(stdout.text(), /syncing: claude - local-only: \(none\)/)
})
