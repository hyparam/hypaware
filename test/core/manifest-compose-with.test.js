// @ts-check

/**
 * `compose_with` validation and catalog surfacing.
 *
 * @ref LLP 0005#compose-with [tests]: the manifest field a derived-data plugin rides a pick with
 * @ref LLP 0213#d1 [tests]: the graph plugins declare the gateway as their condition
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { validateManifest } from '../../src/core/manifest.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'

/** @param {Record<string, unknown>} extra */
function manifest(extra) {
  return {
    schema_version: 1,
    name: '@hypaware/example',
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './src/index.js',
    ...extra,
  }
}

test('compose_with is optional', () => {
  const r = validateManifest(manifest({}))
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.manifest.compose_with, undefined)
})

test('compose_with survives validation as a plugin name array', () => {
  const r = validateManifest(manifest({ compose_with: ['@hypaware/ai-gateway'] }))
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.manifest.compose_with, ['@hypaware/ai-gateway'])
})

// A nonsense value should be legible rather than mysterious: the next user
// of this field is a plugin author who is not in the room.
test('compose_with rejects non-arrays, non-strings, and the empty array', () => {
  for (const bad of ['@hypaware/ai-gateway', {}, [1], ['ok', 2], []]) {
    const r = validateManifest(manifest({ compose_with: bad }))
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`)
    if (!r.ok) assert.match(r.message, /compose_with/)
  }
})

// An empty array would mean "ride nothing", which is indistinguishable from
// omitting the field and reads as a typo. Rejecting it keeps the fold's rule
// (every named plugin present) from being vacuously true.
test('the empty array is rejected rather than treated as no condition', () => {
  const r = validateManifest(manifest({ compose_with: [] }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.message, /non-empty/)
})

// Regression (neutral review of PR #720, finding H): a plugin that waits for
// itself is *safe* (the fixpoint terminates) and that is what makes it bad.
// It composes nothing, forever, with no error anywhere: the plugin is just
// missing. Validation is the only layer positioned to say so.
test('compose_with rejects a self-reference', () => {
  const r = validateManifest(manifest({ compose_with: ['@hypaware/example'] }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.message, /compose_with/)
})

test('a self-reference is rejected even alongside a real condition', () => {
  const r = validateManifest(
    manifest({ compose_with: ['@hypaware/ai-gateway', '@hypaware/example'] })
  )
  assert.equal(r.ok, false)
})

// The mutual case is deliberately NOT rejected: A waits for B and B waits
// for A is only a stall if neither is composed by anything else, which
// validation of a single manifest cannot see (each manifest is valid in
// isolation, and the pair may be composed by a pick). Pinned so the
// asymmetry with the self-reference above reads as a decision.
test('a mutual compose_with pair each validate on their own', () => {
  const a = validateManifest(manifest({ name: '@hypaware/a', compose_with: ['@hypaware/b'] }))
  const b = validateManifest(manifest({ name: '@hypaware/b', compose_with: ['@hypaware/a'] }))
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
})

// Pinning the current silent no-op, which is a real gap and not a feature:
// `compose_with` names are never checked against the catalog, so a typo'd
// package name validates, is surfaced by the catalog verbatim, and simply
// never composes. Nothing warns at any layer. This test exists so the
// behaviour is documented and so adding a warning is a visible change here
// rather than a surprise.
test('a typo in a compose_with name is a silent no-op at every layer', async () => {
  const typo = validateManifest(manifest({ compose_with: ['@hypaware/ai-gatway'] }))
  assert.equal(typo.ok, true, 'validation does not resolve names, so the typo passes')

  assert.ok(typo.ok)
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([
    ...bundled.loaded,
    ...bundled.excluded,
    {
      ok: true,
      manifest: typo.manifest,
      rootDir: '/nonexistent',
      manifestPath: '/nonexistent/hypaware.plugin.json',
    },
  ])
  assert.deepEqual(
    (catalog.composeWith ?? new Map()).get('@hypaware/example'),
    ['@hypaware/ai-gatway'],
    'the catalog carries the misspelling through verbatim'
  )
  assert.equal(
    catalog.plugins.has(/** @type {any} */ ('@hypaware/ai-gatway')),
    false,
    'and nothing by that name exists, so the condition can never be met'
  )
})

test('the catalog surfaces compose_with from the shipped graph manifests', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const riders = catalog.composeWith ?? new Map()
  assert.deepEqual(riders.get('@hypaware/context-graph'), ['@hypaware/ai-gateway'])
  assert.deepEqual(riders.get('@hypaware/ai-gateway-graph'), ['@hypaware/ai-gateway'])
})

// A plugin without the field must not appear as a rider with an empty
// condition, which the fold would read as "compose me always".
test('plugins without the field are absent from the rider map', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const riders = catalog.composeWith ?? new Map()
  assert.equal(riders.has('@hypaware/otel'), false)
  assert.equal(riders.has('@hypaware/claude'), false)
})
