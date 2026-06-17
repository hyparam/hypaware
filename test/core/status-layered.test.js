// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'

// `hyp status` on a centrally-managed host must restore inspectability of
// the merged config: per-entry provenance + the dropped-local section.
// @ref LLP 0031#status-provenance [tests]

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-layered-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

test('a never-joined host reports no layering (V1 surface unchanged)', async () => {
  const hypHome = await makeHome()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.layered, null)
  assert.deepEqual(report.activePlugins, ['@hypaware/ai-gateway'])
})

test('a joined host surfaces provenance and the dropped-local section', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')

  // Central seed (no apply yet): the authoritative central layer.
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/central' }, { name: '@hypaware/ai-gateway' }],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
    query: { cache: { dir: '/operator/path' } },
  }) + '\n')

  // Local layer: a colliding plugin (dropped) + an additive client.
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })

  // The effective (merged) plugin set: central wins, local claude adds.
  assert.deepEqual(report.activePlugins.sort(), [
    '@hypaware/ai-gateway',
    '@hypaware/central',
    '@hypaware/claude',
  ])

  assert.ok(report.layered)
  assert.equal(report.layered?.hasCentral, true)
  assert.deepEqual(report.layered?.centralPlugins.sort(), ['@hypaware/ai-gateway', '@hypaware/central'])
  assert.deepEqual(report.layered?.centralSinks, ['central'])
  assert.equal(report.layered?.centralQueryIgnored, true)
  assert.deepEqual(report.layered?.drops, [
    { section: 'plugins', key: '@hypaware/ai-gateway', reason: 'collides_with_central' },
  ])

  // A dropped local entry is its own section, never a diagnostic, and
  // never flips overall to degraded on its own.
  assert.ok(!report.diagnostics.some((d) => d.message.includes('collides_with_central')))
})
