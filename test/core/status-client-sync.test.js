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
import { clientSyncListPath, writeClientSyncEntries } from '../../src/core/usage-policy/client_sync.js'

// On an enrolled host every configured source syncs by default (LLP 0181
// #rule); only the machine-local opt-out store keeps one local, and `hyp
// status` must show the syncing / local-only split so that withholding is
// never a silent state. The split covers every configured picker source
// (a hermes opt-out is visible, not only attach-probed clients), and a
// central-configured source is never local-only (LLP 0181 #locked).
// @ref LLP 0181#never-silent [tests]:

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

/**
 * Central layer manages ai-gateway + claude; the local layer adds codex.
 * The gateway plugin's raw-anthropic/raw-openai picker rows are configured
 * sources too, so they appear in the split as syncing.
 * @param {string} hypHome
 */
async function seedManagedHome(hypHome) {
  const stateRoot = path.join(hypHome, 'hypaware')
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/codex' }],
  }) + '\n')
  return stateRoot
}

test('an enrolled host with nothing opted out shows every configured source syncing (default-sync)', async () => {
  const hypHome = await makeHome()
  await seedManagedHome(hypHome)

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.deepEqual(report.clientSync, {
    syncing: ['claude', 'codex', 'raw-anthropic', 'raw-openai'],
    localOnly: [],
  })
})

test('an opted-out local source shows local-only; a stale central opt-out entry is inert', async () => {
  const hypHome = await makeHome()
  const stateRoot = await seedManagedHome(hypHome)
  await writeClientSyncEntries({
    stateDir: stateRoot,
    entries: [
      { source: 'codex', class: 'local-only' },
      // Stale entry for an org-managed source: never local-only (LLP 0181 #locked).
      { source: 'claude', class: 'local-only' },
    ],
  })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.deepEqual(report.clientSync, {
    syncing: ['claude', 'raw-anthropic', 'raw-openai'],
    localOnly: ['codex'],
  })

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  assert.deepEqual(json.client_sync, {
    syncing: ['claude', 'raw-anthropic', 'raw-openai'],
    local_only: ['codex'],
  })

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  assert.match(stdout.text(), /syncing: claude · raw-anthropic · raw-openai - local-only: codex/)
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

test('a corrupt opt-out store degrades to a null split plus a warning diagnostic', async () => {
  const hypHome = await makeHome()
  const stateRoot = await seedManagedHome(hypHome)
  const storePath = clientSyncListPath(stateRoot)
  await fs.mkdir(path.dirname(storePath), { recursive: true })
  await fs.writeFile(storePath, '{ nope')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.clientSync, null)
  const warning = report.diagnostics.find((d) => d.kind === 'client_sync_list_unreadable')
  assert.ok(warning, 'the corrupt store is named in a diagnostic, never silent')
  assert.equal(warning.severity, 'warning')
})
