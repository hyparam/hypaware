// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeConfigLayers } from '../../src/core/config/merge.js'

test('no central layer: effective is the local layer verbatim', () => {
  const local = {
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
    query: { cache: { dir: '/home/u/.hyp' } },
  }
  const merged = mergeConfigLayers(null, /** @type {any} */ (local))
  assert.deepEqual(merged.effective, local)
  assert.deepEqual(merged.drops, [])
  assert.equal(merged.centralQueryIgnored, false)
})

test('both layers absent: effective is an empty v2 config', () => {
  const merged = mergeConfigLayers(null, null)
  assert.deepEqual(merged.effective, { version: 2 })
})

test('local adds plugins/sinks the central layer does not name', () => {
  const central = {
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
  }
  const local = {
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
    sinks: { local_parquet: { writer: '@hypaware/format-parquet', destination: '@hypaware/local-fs' } },
  }
  const merged = mergeConfigLayers(/** @type {any} */ (central), /** @type {any} */ (local))
  assert.deepEqual(
    merged.effective.plugins?.map((p) => p.name),
    ['@hypaware/central', '@hypaware/ai-gateway', '@hypaware/claude']
  )
  assert.deepEqual(Object.keys(merged.effective.sinks ?? {}), ['central', 'local_parquet'])
  assert.deepEqual(merged.drops, [])
})

test('central wins and locks: a colliding local plugin/sink is dropped', () => {
  const central = {
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { listen: 'central:9999' } }],
    sinks: { exports: { plugin: '@hypaware/central', config: {} } },
    disambiguate: { 'hypaware.encoder': '@hypaware/format-parquet' },
  }
  const local = {
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { listen: 'local:8787' } }],
    sinks: { exports: { writer: '@hypaware/format-jsonl', destination: '@hypaware/local-fs' } },
    disambiguate: { 'hypaware.encoder': '@hypaware/format-jsonl' },
  }
  const merged = mergeConfigLayers(/** @type {any} */ (central), /** @type {any} */ (local))

  // Central's entries survive unchanged.
  assert.equal(merged.effective.plugins?.length, 1)
  assert.deepEqual(merged.effective.plugins?.[0].config, { listen: 'central:9999' })
  assert.deepEqual(/** @type {any} */ (merged.effective.sinks?.exports).plugin, '@hypaware/central')
  assert.equal(merged.effective.disambiguate?.['hypaware.encoder'], '@hypaware/format-parquet')

  // Every collision is recorded for `hyp status`.
  assert.deepEqual(merged.drops.sort((a, b) => a.section.localeCompare(b.section)), [
    { section: 'disambiguate', key: 'hypaware.encoder', reason: 'collides_with_central' },
    { section: 'plugins', key: '@hypaware/ai-gateway', reason: 'collides_with_central' },
    { section: 'sinks', key: 'exports', reason: 'collides_with_central' },
  ])
})

test('query is local-only: the local block wins, a central query block is ignored', () => {
  const central = {
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
    query: { cache: { dir: '/operator/fleet/path' } },
  }
  const local = {
    version: 2,
    query: { cache: { dir: '/home/u/.hyp', retention: { default_days: 7 } } },
  }
  const merged = mergeConfigLayers(/** @type {any} */ (central), /** @type {any} */ (local))
  assert.equal(merged.centralQueryIgnored, true)
  assert.deepEqual(merged.effective.query, local.query)
})
