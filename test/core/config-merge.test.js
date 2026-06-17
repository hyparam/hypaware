// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeConfigLayers, resolveLayeredConfig } from '../../src/core/config/merge.js'

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

// ---- resolveLayeredConfig: the validation-driven drop pass (LLP 0031
// §central-layer-is-sacrosanct). A fake validator keeps these unit-level:
// "two encoders enabled together is a capability tie".
// @ref LLP 0031#central-layer-is-sacrosanct [tests]

/** @param {any} cfg */
function fakeValidate(cfg) {
  const names = new Set((cfg.plugins ?? []).map((/** @type {any} */ p) => p.name))
  if (names.has('@hypaware/format-parquet') && names.has('@hypaware/format-jsonl')) {
    return [{ pointer: '/disambiguate/hypaware.encoder', errorKind: 'capability_ambiguous', message: 'tie' }]
  }
  return []
}

test('resolveLayeredConfig: a valid-in-isolation local addition that invalidates the merge is dropped', () => {
  const central = { version: 2, plugins: [{ name: '@hypaware/format-parquet' }] }
  const local = {
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/format-jsonl' }],
  }
  const merged = resolveLayeredConfig({
    central: /** @type {any} */ (central),
    local: /** @type {any} */ (local),
    validate: /** @type {any} */ (fakeValidate),
  })
  // ai-gateway adds cleanly; format-jsonl ties with the central parquet
  // encoder and is dropped with the triggering error_kind.
  assert.deepEqual(merged.effective.plugins?.map((p) => p.name), [
    '@hypaware/format-parquet',
    '@hypaware/ai-gateway',
  ])
  assert.deepEqual(merged.drops, [
    { section: 'plugins', key: '@hypaware/format-jsonl', reason: 'invalid_merge', detail: 'capability_ambiguous' },
  ])
})

test('resolveLayeredConfig: an error the central layer carries alone never drops a local entry', () => {
  // Central is already ambiguous on its own — that is apply-time's concern.
  // The local layer is blameless, so nothing local is dropped.
  const central = {
    version: 2,
    plugins: [{ name: '@hypaware/format-parquet' }, { name: '@hypaware/format-jsonl' }],
  }
  const local = { version: 2, plugins: [{ name: '@hypaware/ai-gateway' }] }
  const merged = resolveLayeredConfig({
    central: /** @type {any} */ (central),
    local: /** @type {any} */ (local),
    validate: /** @type {any} */ (fakeValidate),
  })
  assert.deepEqual(merged.effective.plugins?.map((p) => p.name), [
    '@hypaware/format-parquet',
    '@hypaware/format-jsonl',
    '@hypaware/ai-gateway',
  ])
  assert.deepEqual(merged.drops, [])
})

test('resolveLayeredConfig: collisions and invalid additions both surface as drops', () => {
  const central = {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: 'central' } },
      { name: '@hypaware/format-parquet' },
    ],
  }
  const local = {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: 'local' } }, // collision → dropped
      { name: '@hypaware/format-jsonl' },                            // tie → dropped
      { name: '@hypaware/claude' },                                  // additive → kept
    ],
  }
  const merged = resolveLayeredConfig({
    central: /** @type {any} */ (central),
    local: /** @type {any} */ (local),
    validate: /** @type {any} */ (fakeValidate),
  })
  assert.deepEqual(merged.effective.plugins?.map((p) => p.name), [
    '@hypaware/ai-gateway',
    '@hypaware/format-parquet',
    '@hypaware/claude',
  ])
  // Central's ai-gateway config survives the collision.
  assert.deepEqual(
    merged.effective.plugins?.find((p) => p.name === '@hypaware/ai-gateway')?.config,
    { listen: 'central' }
  )
  assert.deepEqual(merged.drops.sort((a, b) => a.key.localeCompare(b.key)), [
    { section: 'plugins', key: '@hypaware/ai-gateway', reason: 'collides_with_central' },
    { section: 'plugins', key: '@hypaware/format-jsonl', reason: 'invalid_merge', detail: 'capability_ambiguous' },
  ])
})

test('resolveLayeredConfig: no central layer is a pure passthrough (never validated)', () => {
  const local = {
    version: 2,
    plugins: [{ name: '@hypaware/format-parquet' }, { name: '@hypaware/format-jsonl' }],
  }
  let called = false
  const merged = resolveLayeredConfig({
    central: null,
    local: /** @type {any} */ (local),
    validate: () => { called = true; return [] },
  })
  // A host that never joined is never validated or pruned.
  assert.equal(called, false)
  assert.deepEqual(merged.effective, local)
  assert.deepEqual(merged.drops, [])
})
