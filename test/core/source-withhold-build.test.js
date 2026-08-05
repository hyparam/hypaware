// @ts-check

// Boot-glue for export-seam source-scoped withholding (LLP 0188):
// `buildSourceWithholdResolver` turns the opt-out store + provenance
// classification + the catalog's attribution/ownership declarations into
// the resolver `readRowsSince` consults, and `ensureClientSyncMigration`
// materializes the pre-0181 derived withheld set on upgrade. This suite
// exercises the build layer directly (it previously had no coverage at
// all); the seam semantics live in source-withhold-export-drop.test.js.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  buildSourceWithholdResolver,
  datasetAttributionColumnsFromCatalog,
  datasetOwnedSourceIdsFromCatalog,
  ensureClientSyncMigration,
} from '../../src/core/runtime/source_withhold.js'
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
