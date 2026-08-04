// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'

// The mirror image of `client_attach_missing`: a client whose settings still
// carry the attach marker while nothing enables its adapter (issue #604). The
// wizard warns when it creates that state; this is the after-the-fact backstop.
// @ref LLP 0185#status-backstop [tests]: the diagnostic fires on a solo host, stays quiet on a joined one, and never reads an unparseable local layer as intent

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-stranded-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

/**
 * A home whose `~/.codex/config.toml` carries the managed block a previous
 * attach wrote: the marker the codex `attach_probe` reads back.
 */
async function homeWithAttachedCodex() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-stranded-home-'))
  await fs.mkdir(path.join(home, '.codex'), { recursive: true })
  await fs.writeFile(
    path.join(home, '.codex', 'config.toml'),
    '# BEGIN hypaware\n[model_providers.hypaware]\nname = "hypaware"\n# END hypaware\n',
    'utf8'
  )
  return home
}

test('a client attached with no plugin enabling it is a warning naming the detach', async () => {
  const hypHome = await makeHome()
  const homeDir = await homeWithAttachedCodex()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome), homeDir })

  const found = report.diagnostics.find((d) => d.kind === 'client_attached_not_configured')
  assert.ok(found, JSON.stringify(report.diagnostics, null, 2))
  assert.equal(found.severity, 'warning')
  assert.match(found.message, /codex/)
  assert.deepEqual(found.repair, ['hyp detach --client codex'])
})

test('a configured attached client draws no stranded diagnostic', async () => {
  const hypHome = await makeHome()
  const homeDir = await homeWithAttachedCodex()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/codex' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome), homeDir })

  assert.equal(report.diagnostics.some((d) => d.kind === 'client_attached_not_configured'), false)
})

// The org/central attach markers are the reconciler's to reverse, so a managed
// host's config-drop is a pass it has not run yet, never an operator's detach.
test('a managed host leaves the reverse lane to the reconciler and stays quiet', async () => {
  const hypHome = await makeHome()
  const homeDir = await homeWithAttachedCodex()
  const seedPath = centralSeedPath(path.join(hypHome, 'hypaware'))
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome), homeDir })

  assert.equal(report.layered?.hasCentral, true)
  assert.equal(report.diagnostics.some((d) => d.kind === 'client_attached_not_configured'), false)
})

// A local layer that does not parse leaves the active-plugin set empty for a
// reason that has nothing to do with what the operator enabled. Reading that
// as "not configured" would hand back a detach for every attached client, on
// top of the config error that is the actual repair.
test('an unreadable local config is not read as an instruction to detach', async () => {
  const hypHome = await makeHome()
  const homeDir = await homeWithAttachedCodex()
  await fs.writeFile(defaultConfigPath(hypHome), '{ not valid json', 'utf8')

  const report = await collectHypAwareStatus({ env: env(hypHome), homeDir })

  assert.equal(report.diagnostics.some((d) => d.kind === 'config_unreadable'), true)
  assert.equal(
    report.diagnostics.some((d) => d.kind === 'client_attached_not_configured'),
    false,
    JSON.stringify(report.diagnostics, null, 2)
  )
})
