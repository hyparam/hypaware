// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createSinkRegistry } from '../../src/core/registry/sinks.js'
import { activate as activateCentral } from '../../hypaware-core/plugins-workspace/central/index.js'
import { activate as activateLocalFs } from '../../hypaware-core/plugins-workspace/local-fs/src/index.js'
import { activate as activateS3 } from '../../hypaware-core/plugins-workspace/s3/src/index.js'

// `SinkRegistry.register` validates a contribution and then stores it **by
// reference**, so every later read runs the plugin's property again. The
// contribution key and the stored wrapper came from two different reads of
// `contribution.plugin`, so the registry indexed a sink under one plugin name
// and handed every caller of `listContributions()` another: a caller
// round-tripping the listing back through `getContribution()` missed a sink
// the registry holds (#1553). Same shape as #1524 in the dataset registry and
// #1530 in the source and verb ones.
//
// The hostile contributions below are written as object literals rather than
// through `sinkOf()`: an object spread reads a getter once and copies the
// value, which would leave the accessor behind and the test proving nothing.
// Each of them asserts the read count it expects, so a fixture that stopped
// being hostile fails loudly rather than passing vacuously.

/** @param {Record<string, unknown>} [overrides] */
function sinkOf(overrides = {}) {
  return /** @type {any} */ ({
    name: 'local-fs',
    plugin: '@hypaware/local-fs',
    supports: ['queryable'],
    async create() { return { async exportBatch() { return {} }, async close() {} } },
    ...overrides,
  })
}

test('the sink registry indexes a contribution by plugin and name', () => {
  const reg = createSinkRegistry()
  reg.register(sinkOf())
  reg.register(sinkOf({ name: 'forward', plugin: '@hypaware/central', supports: [] }))

  assert.equal(reg.getContribution('@hypaware/local-fs', 'local-fs')?.name, 'local-fs')
  assert.equal(reg.getContribution('@hypaware/central', 'forward')?.name, 'forward')
  // The key is the pair, not either half: neither name alone answers.
  assert.equal(reg.getContribution('@hypaware/central', 'local-fs'), undefined)
  assert.equal(reg.getContribution('@hypaware/local-fs', 'forward'), undefined)
  assert.deepEqual(reg.listContributions().map((e) => e.plugin), ['@hypaware/local-fs', '@hypaware/central'])
})

test('the sink registry refuses a malformed contribution', () => {
  const reg = createSinkRegistry()
  assert.throws(() => reg.register(/** @type {any} */ (null)), /contribution must be an object/)
  assert.throws(() => reg.register(sinkOf({ name: '' })), /contribution.name must be a non-empty string/)
  assert.throws(() => reg.register(sinkOf({ plugin: '' })), /missing plugin/)
  assert.throws(() => reg.register(sinkOf({ supports: 'queryable' })), /supports must be an array/)
  assert.throws(() => reg.register(sinkOf({ create: undefined })), /missing create\(\)/)
  reg.register(sinkOf())
  assert.throws(() => reg.register(sinkOf()), /duplicate sink contribution 'local-fs'/)
})

test('register keys a contribution by the plugin it validated', () => {
  // The reported defect. The key came from one read of `contribution.plugin`
  // and the stored wrapper from the next, so the registry held the sink under
  // `P3` while `listContributions()` reported `P4`.
  const reg = createSinkRegistry()
  let reads = 0
  const hostile = /** @type {any} */ ({
    name: 'a-sink',
    get plugin() {
      reads += 1
      return `P${reads}`
    },
    supports: [],
    async create() { return { async exportBatch() { return {} }, async close() {} } },
  })
  reg.register(hostile)

  assert.equal(reads, 1, 'register read the plugin\'s `plugin` more than once')
  const [entry] = reg.listContributions()
  assert.equal(entry.plugin, 'P1')
  assert.equal(
    reg.getContribution(entry.plugin, 'a-sink'),
    hostile,
    'the listing named a plugin the index does not answer to'
  )
  // Non-vacuity: the accessor is still live and still drifting, so the
  // agreement above is the fix and not a fixture that stopped being hostile.
  assert.notEqual(entry.plugin, hostile.plugin, 'the fixture stopped drifting')
})

test('register keys a contribution by the name it validated', () => {
  const reg = createSinkRegistry()
  let reads = 0
  const hostile = /** @type {any} */ ({
    get name() {
      reads += 1
      return `N${reads}`
    },
    plugin: '@third-party/drifting-name',
    supports: [],
    async create() { return { async exportBatch() { return {} }, async close() {} } },
  })
  reg.register(hostile)

  assert.equal(reads, 1, 'register read the plugin\'s `name` more than once')
  assert.equal(
    reg.getContribution('@third-party/drifting-name', 'N1'),
    hostile,
    'the registry keyed the sink under a name it never validated'
  )
  assert.notEqual(hostile.name, 'N1', 'the fixture stopped drifting')
})

test('every entry listContributions hands out round-trips through getContribution', () => {
  // What `src/core/plugin_doctor/dry_run.js` does with the listing, and the
  // reason the reported defect can only under-report: a wrapper naming a
  // plugin the index does not answer to drops a real sink from the report.
  const reg = createSinkRegistry()
  let pluginReads = 0
  reg.register(sinkOf())
  reg.register(/** @type {any} */ ({
    name: 'drifting-plugin',
    get plugin() {
      pluginReads += 1
      return `Q${pluginReads}`
    },
    supports: [],
    async create() { return { async exportBatch() { return {} }, async close() {} } },
  }))
  reg.register(sinkOf({ name: 'forward', plugin: '@hypaware/central', supports: [] }))

  const listed = reg.listContributions()
  assert.equal(listed.length, 3)
  for (const entry of listed) {
    const name = entry.contribution.name
    assert.equal(
      reg.getContribution(entry.plugin, name),
      entry.contribution,
      `getContribution missed '${entry.plugin}::${name}', which listContributions handed out`
    )
  }
  assert.equal(pluginReads, 1, 'register or the listing read the plugin\'s `plugin` more than once')
  assert.equal(listed[1].plugin, 'Q1')
  assert.notEqual(listed[1].contribution.plugin, 'Q1', 'the fixture stopped drifting')
})

test('register touches the Map only after every plugin property has been read', () => {
  // `supports.join(',')` for the `sink.contribute` record ran below the Map
  // write. A `join` that raises there left this registry holding the
  // contribution while the loader marked the plugin's whole activation
  // failed: a plugin reported as not loaded and a sink the kernel would
  // still instantiate.
  const reg = createSinkRegistry()
  const supports = /** @type {any} */ ([])
  Object.defineProperty(supports, 'join', {
    value() { throw new TypeError('supports is not joinable') },
  })
  assert.throws(() => reg.register(/** @type {any} */ ({
    name: 'half',
    plugin: '@third-party/raising-supports',
    supports,
    async create() { return { async exportBatch() { return {} }, async close() {} } },
  })), /supports is not joinable/)

  assert.equal(
    reg.getContribution('@third-party/raising-supports', 'half'),
    undefined,
    'a refused registration was left in the registry'
  )
  assert.deepEqual(reg.listContributions(), [])
})

test('instantiate attributes its span, its handle and its counter from one read of plugin', async () => {
  // `instantiate` read `contribution.plugin` once per use, seven times on
  // this path: both `sink.*` records name it twice each, and the span, the
  // handle and the `hyp_sinks_registered` counter once. One instantiation
  // could be spanned under one plugin, counted under another and returned as
  // a third.
  const reg = createSinkRegistry()
  let reads = 0
  const contribution = /** @type {any} */ ({
    name: 'a-sink',
    get plugin() {
      reads += 1
      return `R${reads}`
    },
    supports: [],
    async create() { return { async exportBatch() { return {} }, async close() {} } },
  })
  const handle = await reg.instantiate(/** @type {any} */ ({
    kind: 'request',
    instanceName: 'inst',
    contribution,
    config: {},
    plugin: '@third-party/drifting-plugin',
    paths: { rootDir: '/', stateDir: '/', cacheDir: '/', tempDir: '/' },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  }))

  assert.equal(reads, 1, 'instantiate read the plugin\'s `plugin` more than once')
  assert.equal(handle.plugin, 'R1')
  assert.notEqual(contribution.plugin, 'R1', 'the fixture stopped drifting')
  await reg.closeAll()
})

test('instantiate resolves supports from one read of the encoder', async () => {
  // `resolveSupports` guarded on `Array.isArray(encoder.supports)` and then
  // built the intersection from a second read, so `queryable` was decided by
  // tags the guard never saw (LLP 0014 #queryable-sinks).
  const reg = createSinkRegistry()
  let reads = 0
  const encoder = /** @type {any} */ ({
    format: 'parquet',
    get supports() {
      reads += 1
      return reads === 1 ? ['queryable'] : []
    },
    async encodePartition() { return {} },
  })
  const handle = await reg.instantiate(/** @type {any} */ ({
    kind: 'blob',
    instanceName: 'blob-inst',
    destination: sinkOf(),
    writerPlugin: '@hypaware/format-parquet',
    encoder,
    config: {},
    plugin: '@hypaware/local-fs',
    paths: { rootDir: '/', stateDir: '/', cacheDir: '/', tempDir: '/' },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  }))

  assert.equal(reads, 1, 'resolveSupports read the encoder\'s `supports` more than once')
  assert.deepEqual(handle.supports, ['queryable'])
  assert.deepEqual(encoder.supports, [], 'the fixture stopped drifting')
  await reg.closeAll()
})

test('instantiate names a table-format sink from one read of the provider', async () => {
  const reg = createSinkRegistry()
  let reads = 0
  const tableFormat = /** @type {any} */ ({
    get format() {
      reads += 1
      return `F${reads}`
    },
    supports: ['queryable'],
    async createSink() { return { async exportBatch() { return {} }, async close() {} } },
  })
  const handle = await reg.instantiate(/** @type {any} */ ({
    kind: 'table-format',
    instanceName: 'table-inst',
    tableFormat,
    writerPlugin: '@hypaware/format-iceberg',
    destinationPlugin: '@hypaware/local-fs',
    blobStore: { async putObject() {} },
    encoder: { supports: ['queryable'] },
    config: {},
    plugin: '@hypaware/format-iceberg',
    paths: { rootDir: '/', stateDir: '/', cacheDir: '/', tempDir: '/' },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  }))

  assert.equal(reads, 1, 'instantiate read the provider\'s `format` more than once')
  assert.equal(handle.tableFormat, 'F1')
  assert.notEqual(tableFormat.format, 'F1', 'the fixture stopped drifting')
  await reg.closeAll()
})

test('the shipped sink contributions are unchanged by the one-read discipline', async () => {
  // Honest-path equivalence over the sink set HypAware ships: each plugin
  // registers under the plugin and name it declares, and the listing and the
  // index agree entry for entry.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sink-registry-'))
  try {
    const sinks = createSinkRegistry()
    /** @param {Record<string, unknown>} config */
    const ctx = (config) => /** @type {any} */ ({
      config,
      env: {},
      provideCapability() {},
      sinks,
      query: {},
      storage: {},
    })
    await activateLocalFs(ctx({ exports_dir: path.join(dir, 'exports') }))
    await activateCentral(ctx({}))
    await activateS3(ctx({}))

    const listed = sinks.listContributions()
    assert.deepEqual(
      listed.map((e) => `${e.plugin}::${e.contribution.name}`),
      ['@hypaware/local-fs::local-fs', '@hypaware/central::forward', '@hypaware/s3::s3']
    )
    for (const entry of listed) {
      assert.equal(sinks.getContribution(entry.plugin, entry.contribution.name), entry.contribution)
    }
    assert.deepEqual(sinks.getContribution('@hypaware/local-fs', 'local-fs')?.supports, ['queryable'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
