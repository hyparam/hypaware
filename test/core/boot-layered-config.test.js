// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { bootKernel } from '../../src/core/runtime/boot.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'

// The merge wiring lives in boot.js; activate nothing (`{ activate: [] }`)
// so these assertions stay about the two-layer resolution, not plugin
// activation. boot.config is the effective merge regardless of profile.
// @ref LLP 0031#two-layers-merged-at-boot [tests]

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-layered-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(stateRoot, { recursive: true })
  return { hypHome, stateRoot }
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

async function bootNoActivate(hypHome) {
  return bootKernel({
    hypHome,
    env: env(hypHome),
    mode: 'cli',
    bootProfile: { activate: [] },
  })
}

test('a host with only a local layer boots it verbatim (effective = local)', async () => {
  const { hypHome } = await makeHome()
  const local = {
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
  }
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify(local) + '\n')

  const boot = await bootNoActivate(hypHome)
  assert.deepEqual(boot.config?.plugins?.map((p) => p.name), [
    '@hypaware/ai-gateway',
    '@hypaware/claude',
  ])
  assert.equal(boot.centralConfigPath, null)
  assert.deepEqual(boot.configDrops, [])
})

test('central seed + local layer: effective is the merge, collisions drop, central query ignored', async () => {
  const { hypHome, stateRoot } = await makeHome()

  // Central seed: the initial central layer (what `hyp join` writes).
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/central' }, { name: '@hypaware/ai-gateway', config: { listen: 'central' } }],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
    query: { cache: { dir: '/operator/path' } },
  }) + '\n')

  // Local layer: one colliding plugin (central wins) + one additive one.
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: 'local' } },
      { name: '@hypaware/claude' },
    ],
    query: { cache: { dir: '/home/u/.hyp' } },
  }) + '\n')

  const boot = await bootNoActivate(hypHome)

  // Central wins the collision; the additive local plugin merges in.
  assert.deepEqual(boot.config?.plugins?.map((p) => p.name), [
    '@hypaware/central',
    '@hypaware/ai-gateway',
    '@hypaware/claude',
  ])
  const gateway = boot.config?.plugins?.find((p) => p.name === '@hypaware/ai-gateway')
  assert.deepEqual(gateway?.config, { listen: 'central' })

  // Query is local-only: local's block is kept, central's is ignored.
  assert.deepEqual(boot.config?.query, { cache: { dir: '/home/u/.hyp' } })
  assert.equal(boot.centralQueryIgnored, true)

  // The collision surfaces structurally for `hyp status`.
  assert.deepEqual(boot.configDrops, [
    { section: 'plugins', key: '@hypaware/ai-gateway', reason: 'collides_with_central' },
  ])
  assert.equal(boot.centralConfigPath, seedPath)
})

test('a local plugin that invalidates the merge (capability tie) is dropped; central boots', async () => {
  const { hypHome, stateRoot } = await makeHome()

  // Central locks the parquet encoder.
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/central' }, { name: '@hypaware/format-parquet' }],
  }) + '\n')

  // Local adds a second encoder (ties with central: capability_ambiguous,
  // dropped) plus a clean additive client (kept).
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/format-jsonl' }, { name: '@hypaware/claude' }],
  }) + '\n')

  const boot = await bootNoActivate(hypHome)

  assert.deepEqual(boot.config?.plugins?.map((p) => p.name), [
    '@hypaware/central',
    '@hypaware/format-parquet',
    '@hypaware/claude',
  ])
  // The tie-causing local entry is dropped (not a boot failure), tagged
  // with the triggering error_kind; the central layer always boots.
  assert.deepEqual(boot.configDrops, [
    { section: 'plugins', key: '@hypaware/format-jsonl', reason: 'invalid_merge', detail: 'capability_ambiguous' },
  ])
})
