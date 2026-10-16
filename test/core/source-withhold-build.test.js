// @ts-check

// Boot-glue for export-seam source-scoped withholding (LLP 0188):
// `buildSourceWithholdResolver` turns the opt-out store + provenance
// classification + the catalog's attribution/ownership declarations into
// the resolver `readRowsSince` consults, and `ensureClientSyncMigration`
// materializes the pre-0188 derived withheld set on upgrade. This suite
// exercises the build layer directly (it previously had no coverage at
// all); the seam semantics live in source-withhold-export-drop.test.js.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  buildSourceWithholdResolver,
  clientEntrypointOwnersFromCatalog,
  datasetAttributionColumnsFromCatalog,
  datasetOwnedSourceIdsFromCatalog,
  ensureClientSyncMigration,
} from '../../src/core/runtime/source_withhold.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import {
  clientSyncListPath,
  readClientSyncEntries,
  writeClientSyncEntries,
  ClientSyncListUnreadableError,
} from '../../src/core/usage-policy/client_sync.js'

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-withhold-build-'))
}

/**
 * A minimal catalog: three picker sources over three plugins. `claude` is
 * org-configured (central), `hermes` and `openclaw` are local additions.
 * The gateway dataset declares an attribution column; the otel-ish
 * `signals` dataset does not and is owned by the hermes plugin's row.
 * @returns {any}
 */
function makeCatalog() {
  const plugins = new Map([
    ['@hypaware/claude', {
      name: '@hypaware/claude',
      contributes: { datasets: [{ name: 'ai_gateway_messages', attribution_column: 'client_name' }] },
    }],
    ['@hypaware/hermes', {
      name: '@hypaware/hermes',
      contributes: { datasets: [{ name: 'signals' }] },
    }],
    ['@hypaware/openclaw', { name: '@hypaware/openclaw', contributes: {} }],
  ])
  const pickerDescriptors = new Map([
    ['claude', { plugin: '@hypaware/claude', id: 'claude', label: 'Claude' }],
    ['hermes', { plugin: '@hypaware/hermes', id: 'hermes', label: 'Hermes' }],
    ['openclaw', { plugin: '@hypaware/openclaw', id: 'openclaw', label: 'OpenClaw' }],
  ])
  return { plugins, pickerDescriptors, clientDescriptors: new Map() }
}

/**
 * @param {{ central?: string[], local?: string[] }} args plugin names per layer
 * @returns {any}
 */
function makeLayered({ central = [], local = [] } = {}) {
  const centralPlugins = central.map((name) => ({ name }))
  const localPlugins = local.map((name) => ({ name }))
  return {
    centralConfig: central.length > 0 ? { version: 2, plugins: centralPlugins } : null,
    effective: { version: 2, plugins: [...centralPlugins, ...localPlugins] },
  }
}

const ENROLLED = { central: ['@hypaware/claude'], local: ['@hypaware/hermes', '@hypaware/openclaw'] }

// --- buildSourceWithholdResolver ---------------------------------------------

test('no central layer -> undefined (solo machines have nothing to withhold from)', async () => {
  const stateDir = await makeTmpDir()
  const resolver = buildSourceWithholdResolver({
    catalog: makeCatalog(),
    layered: makeLayered({ local: ['@hypaware/hermes'] }),
    stateDir,
  })
  assert.equal(resolver, undefined)
})

test('enrolled machine with an empty (or absent) store withholds nothing: default-sync', async () => {
  const stateDir = await makeTmpDir()
  const resolver = buildSourceWithholdResolver({
    catalog: makeCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.ok(resolver, 'the resolver is built even with nothing opted out: the set is live')
  assert.equal(resolver.shouldWithhold('hermes'), false)
  assert.equal(resolver.shouldWithhold('openclaw'), false)
  assert.equal(resolver.shouldWithhold('claude'), false)
})

test('opt-out entries feed the withheld set', async () => {
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'hermes', class: 'local-only' }] })
  const resolver = buildSourceWithholdResolver({
    catalog: makeCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.ok(resolver)
  assert.equal(resolver.shouldWithhold('hermes'), true)
  assert.equal(resolver.shouldWithhold('openclaw'), false)
})

test('a central-classified source cannot be withheld: a stale entry is inert (LLP 0188 #locked)', async () => {
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({
    stateDir,
    entries: [
      { source: 'claude', class: 'local-only' },
      { source: 'openclaw', class: 'local-only' },
    ],
  })
  const resolver = buildSourceWithholdResolver({
    catalog: makeCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.ok(resolver)
  assert.equal(resolver.shouldWithhold('claude'), false, 'org-configured sources always sync')
  assert.equal(resolver.shouldWithhold('openclaw'), true)
})

test('the store is re-read after the TTL, so an opt-out lands in a running daemon', async () => {
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [] })
  let clock = 0
  const resolver = buildSourceWithholdResolver({
    catalog: makeCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
    now: () => clock,
    ttlMs: 1000,
  })
  assert.ok(resolver)
  assert.equal(resolver.shouldWithhold('hermes'), false)

  await writeClientSyncEntries({ stateDir, entries: [{ source: 'hermes', class: 'local-only' }] })
  clock = 500
  assert.equal(resolver.shouldWithhold('hermes'), false, 'within the TTL the cached set holds')
  clock = 1500
  assert.equal(resolver.shouldWithhold('hermes'), true, 'past the TTL the new opt-out applies without a rebuild')
})

test('a corrupt store throws ClientSyncListUnreadableError from shouldWithhold (fail closed)', async () => {
  const stateDir = await makeTmpDir()
  await fs.mkdir(path.dirname(clientSyncListPath(stateDir)), { recursive: true })
  await fs.writeFile(clientSyncListPath(stateDir), '{ nope', 'utf8')
  const resolver = buildSourceWithholdResolver({
    catalog: makeCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.ok(resolver)
  assert.throws(() => resolver.shouldWithhold('hermes'), ClientSyncListUnreadableError)
  assert.throws(() => resolver.shouldWithholdDataset?.('signals'), ClientSyncListUnreadableError)
})

test('dataset-scoped withholding: an unattributed dataset drops wholesale only when every owning source is opted out', async () => {
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'hermes', class: 'local-only' }] })
  const resolver = buildSourceWithholdResolver({
    catalog: makeCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.ok(resolver)
  assert.equal(resolver.shouldWithholdDataset?.('signals'), true, 'hermes is the sole owner of signals')
  assert.equal(
    resolver.shouldWithholdDataset?.('ai_gateway_messages'),
    false,
    'an attributed dataset stays per-row even when a contributor is opted out'
  )
  assert.equal(resolver.shouldWithholdDataset?.('unknown-dataset'), false)
})

/**
 * Give the attributed dataset a second declared owner, so the fail-closed
 * rule has a multi-owner arming set to be `some`-not-`every` over. This is a
 * synthetic stand-in, not a copy of production: in the real catalog
 * `ai_gateway_messages` is declared by `@hypaware/ai-gateway` alone and its
 * two owners are that plugin's own picker rows, `raw-anthropic` and
 * `raw-openai` (pinned against the real manifests by the test below). The
 * client plugins that write into the dataset through their projectors,
 * claude and codex among them, declare no `datasets` and are therefore not
 * owners, which is exactly why an opt-out on one of them does not arm the
 * rule (LLP 0192 #fail-closed). The base `makeCatalog()` this extends is
 * itself a deliberate divergence here: it has `@hypaware/claude` declare
 * `ai_gateway_messages` with picker id `claude`, standing in for what
 * `@hypaware/ai-gateway` declares in production.
 * @returns {any}
 */
function makeGatewayCoOwnedCatalog() {
  const catalog = makeCatalog()
  catalog.plugins.set('@hypaware/hermes', {
    name: '@hypaware/hermes',
    contributes: {
      datasets: [
        { name: 'signals' },
        { name: 'ai_gateway_messages', attribution_column: 'client_name' },
      ],
    },
  })
  return catalog
}

// @ref LLP 0192#fail-closed [tests]: an unattributed row in an attributed dataset is withheld once any of that dataset's declared owners is opted out
test('fail-closed: any opted-out owner of an attributed dataset withholds its unattributed rows', async () => {
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'hermes', class: 'local-only' }] })
  const resolver = buildSourceWithholdResolver({
    catalog: makeGatewayCoOwnedCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.ok(resolver)
  assert.equal(
    resolver.shouldWithholdUnattributed?.('ai_gateway_messages'),
    true,
    'some, not every: one standing opt-out is enough for an unlabeled row'
  )
  assert.equal(
    resolver.shouldWithholdUnattributed?.('signals'),
    false,
    'a dataset without an attribution column has no unattributed-row rule; shouldWithholdDataset covers it'
  )
  assert.equal(resolver.shouldWithholdUnattributed?.('unknown-dataset'), false)
})

// Binds LLP 0192 #fail-closed's stated arming set to the REAL bundled
// manifests: `ai_gateway_messages` is declared by `@hypaware/ai-gateway`
// alone, so its owners are exactly the two raw rows, and a client-only
// opt-out (claude/codex/openclaw/hermes) does not arm the unattributed
// rule - the intended scope, per the doc. If a manifest change moves this
// (a client plugin declaring the dataset, a new contributor), this fails
// and the doc's claim gets revisited instead of silently drifting.
// @ref LLP 0192#fail-closed [tests]: the arming set is the manifest-declared owners, pinned against the real catalog
test('fail-closed arming set matches the real bundled manifests: the raw rows own ai_gateway_messages', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const owners = datasetOwnedSourceIdsFromCatalog(catalog).get('ai_gateway_messages') ?? []
  assert.deepEqual([...owners].sort(), ['raw-anthropic', 'raw-openai'])
  assert.equal(
    datasetAttributionColumnsFromCatalog(catalog).get('ai_gateway_messages'),
    'client_name'
  )
})

test('fail-closed: inert with nothing opted out, and inert for an opt-out on a non-owner', async () => {
  const freshStateDir = await makeTmpDir()
  const nothing = buildSourceWithholdResolver({
    catalog: makeGatewayCoOwnedCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir: freshStateDir,
  })
  assert.equal(nothing?.shouldWithholdUnattributed?.('ai_gateway_messages'), false, 'no opt-outs -> nothing changes')

  // In the base catalog only the central claude row owns the gateway
  // dataset; a hermes opt-out is an opt-out on a non-owner.
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'hermes', class: 'local-only' }] })
  const nonOwner = buildSourceWithholdResolver({
    catalog: makeCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.equal(
    nonOwner?.shouldWithholdUnattributed?.('ai_gateway_messages'),
    false,
    'an opt-out on a source that cannot produce this dataset withholds nothing here'
  )
})

// --- catalog folds -----------------------------------------------------------

test('datasetAttributionColumnsFromCatalog folds declared attribution columns, first writer wins', () => {
  const map = datasetAttributionColumnsFromCatalog(makeCatalog())
  assert.deepEqual([...map.entries()], [['ai_gateway_messages', 'client_name']])
})

test('datasetOwnedSourceIdsFromCatalog maps each dataset to its owning picker ids', () => {
  const map = datasetOwnedSourceIdsFromCatalog(makeCatalog())
  assert.deepEqual(map.get('signals'), ['hermes'])
  assert.deepEqual(map.get('ai_gateway_messages'), ['claude'])
})

/**
 * Two plugins contributing one attribution-column-less dataset name: the
 * local `hermes` row and the org's `claude` row. Nothing in the manifest
 * schema forbids it, and the ownership fold has to survive it.
 *
 * `hermes` is declared *first* on purpose: that is the order in which a
 * first-manifest-wins fold picks the opted-out plugin as the dataset's
 * sole owner and withholds the org's rows along with it.
 * @returns {any}
 */
function makeSharedDatasetCatalog() {
  const catalog = makeCatalog()
  catalog.plugins = new Map([
    ['@hypaware/hermes', {
      name: '@hypaware/hermes',
      contributes: { datasets: [{ name: 'signals' }] },
    }],
    ['@hypaware/claude', {
      name: '@hypaware/claude',
      contributes: { datasets: [{ name: 'signals' }] },
    }],
    ['@hypaware/openclaw', { name: '@hypaware/openclaw', contributes: {} }],
  ])
  return catalog
}

// "Every source that could have produced it" is a union, not the first
// manifest's list: a first-wins fold would hand back only one plugin's
// rows and withhold the whole dataset off it.
test('datasetOwnedSourceIdsFromCatalog unions owners across every plugin contributing a dataset', () => {
  const map = datasetOwnedSourceIdsFromCatalog(makeSharedDatasetCatalog())
  assert.deepEqual([...(map.get('signals') ?? [])].sort(), ['claude', 'hermes'])
})

// @ref LLP 0188#locked [tests]: a locked source that co-owns a dataset keeps it exported, whatever the opted-out co-owner does
test('a shared dataset is not withheld wholesale while a locked co-owner still syncs', async () => {
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'hermes', class: 'local-only' }] })
  const resolver = buildSourceWithholdResolver({
    catalog: makeSharedDatasetCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.ok(resolver)
  assert.equal(resolver.shouldWithhold('hermes'), true, 'the opt-out itself still stands')
  assert.equal(
    resolver.shouldWithholdDataset?.('signals'),
    false,
    'claude is org-configured and always syncs, so signals cannot be dropped wholesale'
  )
})

// --- ensureClientSyncMigration ------------------------------------------------

test('migration: central layer + absent store materializes the local-classified set as opt-outs', async () => {
  const stateDir = await makeTmpDir()
  const result = await ensureClientSyncMigration({
    catalog: makeCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.equal(result.migrated, true)
  assert.deepEqual(result.sources?.sort(), ['hermes', 'openclaw'])
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [
    { source: 'hermes', class: 'local-only' },
    { source: 'openclaw', class: 'local-only' },
  ])
})

test('migration: an existing store (even empty) is the new-era marker, no-op', async () => {
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [] })
  const result = await ensureClientSyncMigration({
    catalog: makeCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.equal(result.migrated, false)
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [], 'fresh picks stay default-sync')
})

test('migration: no central layer, no-op (solo machine never migrates)', async () => {
  const stateDir = await makeTmpDir()
  const result = await ensureClientSyncMigration({
    catalog: makeCatalog(),
    layered: makeLayered({ local: ['@hypaware/hermes'] }),
    stateDir,
  })
  assert.equal(result.migrated, false)
  assert.equal(await readClientSyncEntries({ stateDir }), null, 'the marker file is not created early')
})

test('migration: a corrupt store is left untouched (never overwrite a privacy signal)', async () => {
  const stateDir = await makeTmpDir()
  await fs.mkdir(path.dirname(clientSyncListPath(stateDir)), { recursive: true })
  await fs.writeFile(clientSyncListPath(stateDir), '{ nope', 'utf8')
  const result = await ensureClientSyncMigration({
    catalog: makeCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.equal(result.migrated, false)
  assert.equal(await fs.readFile(clientSyncListPath(stateDir), 'utf8'), '{ nope')
})

test('migration is idempotent: a second boot after materialization changes nothing', async () => {
  const stateDir = await makeTmpDir()
  const args = { catalog: makeCatalog(), layered: makeLayered(ENROLLED), stateDir }
  await ensureClientSyncMigration(args)
  const before = await readClientSyncEntries({ stateDir })
  const second = await ensureClientSyncMigration(args)
  assert.equal(second.migrated, false)
  assert.deepEqual(await readClientSyncEntries({ stateDir }), before)
})

// --- aliased-client entrypoint ownership (LLP 0346) --------------------------

// Binds the refinement's input to the REAL bundled manifests. Two things
// have to hold for `hyp privacy client claude-desktop local-only` to mean
// anything: Desktop's entrypoint values must be claimed by a client whose
// name is the picker id the opt-out store holds, and the map must not grow
// beyond the clients that actually declare ownership (every extra name
// widens the set of `client_name` values whose `entrypoint` is read as an
// ownership claim). If a manifest change moves either, this fails rather
// than silently under- or over-withholding.
// @ref LLP 0346#entrypoint-refinement [tests]: the ownership map is folded from the shipped `transcript_entrypoints` declarations, restricted to picker ids
test('entrypoint ownership matches the real bundled manifests: claude and claude-desktop, nobody else', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  assert.deepEqual(
    [...clientEntrypointOwnersFromCatalog(catalog).entries()].sort((a, b) => a[0].localeCompare(b[0])),
    [
      ['claude-desktop', 'claude-desktop'],
      ['claude-desktop-3p', 'claude-desktop'],
      ['cli', 'claude'],
      ['sdk-cli', 'claude'],
    ].sort((a, b) => a[0].localeCompare(b[0]))
  )
  // Both owners are picker ids, so both can appear in the opt-out store.
  assert.ok(catalog.pickerDescriptors.has('claude-desktop'))
  assert.ok(catalog.pickerDescriptors.has('claude'))
})

// @ref LLP 0346#entrypoint-refinement [tests]: the built resolver enforces an aliased client's opt-out, and reaches no other client's rows
test('a claude-desktop opt-out on an enrolled machine withholds by entrypoint, not by client_name alone', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'claude-desktop', class: 'local-only' }] })
  const resolver = buildSourceWithholdResolver({
    catalog,
    layered: makeLayered({ central: ['@hypaware/claude'], local: ['@hypaware/claude-desktop'] }),
    stateDir,
  })
  assert.ok(resolver)
  assert.equal(resolver.entrypointColumnFor?.('ai_gateway_messages'), 'entrypoint')
  assert.equal(
    resolver.shouldWithhold('claude'),
    false,
    'the opt-out is on claude-desktop, so Claude Code keeps syncing'
  )
  assert.equal(
    resolver.shouldWithholdEntrypoint?.('claude', 'claude-desktop-3p'),
    true,
    "Desktop's live rows are withheld through the entrypoint its manifest claims"
  )
  assert.equal(
    resolver.shouldWithholdEntrypoint?.('claude', 'cli'),
    false,
    'Claude Code rows in the same dataset are untouched'
  )
  assert.equal(
    resolver.shouldWithholdEntrypoint?.('hermes', 'cli'),
    false,
    "a client that declares no entrypoint ownership keeps its own `cli` vocabulary"
  )
  await fs.rm(stateDir, { recursive: true, force: true })
})

// A dataset that declares no attribution column is not subject to per-row
// withholding at all, so it is not offered the second column either.
test('entrypointColumnFor is undefined for a dataset with no attribution column', async () => {
  const stateDir = await makeTmpDir()
  const resolver = buildSourceWithholdResolver({
    catalog: makeCatalog(),
    layered: makeLayered(ENROLLED),
    stateDir,
  })
  assert.equal(resolver?.entrypointColumnFor?.('signals'), undefined)
  await fs.rm(stateDir, { recursive: true, force: true })
})

// A third-party client plugin that declares one of Desktop's entrypoint
// values, and sorts ahead of it, must not be able to delete that value from
// the map. Only picker ids can reach the opt-out store, so the picker filter
// is applied to the descriptors before the first-declaration-wins race, not
// to its winner: filtering the winner drops the value entirely instead of
// falling through to the picker that also declares it, which silently turns
// the opt-out back off with nothing in the store or the receipt to say so.
test('a non-picker client that declares a Desktop entrypoint cannot delete the mapping', async () => {
  /** @type {any} */
  const catalog = {
    clientDescriptors: new Map([
      ['rogue', { name: 'rogue', plugin: '@third/rogue', transcriptEntrypoints: ['claude-desktop-3p'] }],
      ['claude-desktop', { name: 'claude-desktop', plugin: '@hypaware/claude-desktop', transcriptEntrypoints: ['claude-desktop', 'claude-desktop-3p'] }],
      ['claude', { name: 'claude', plugin: '@hypaware/claude', transcriptEntrypoints: ['cli', 'sdk-cli'] }],
    ]),
    pickerDescriptors: new Map([
      ['claude-desktop', { plugin: '@hypaware/claude-desktop', id: 'claude-desktop', label: 'Claude Desktop' }],
      ['claude', { plugin: '@hypaware/claude', id: 'claude', label: 'Claude' }],
    ]),
  }
  const owners = clientEntrypointOwnersFromCatalog(catalog)
  assert.equal(
    owners.get('claude-desktop-3p'),
    'claude-desktop',
    'the picker that declares the value still owns it, so the opt-out still enforces'
  )
  assert.equal(owners.get('rogue'), undefined, 'a non-picker never enters the namespace')
})
