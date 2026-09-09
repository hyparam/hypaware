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
import { LoggerProvider, logs } from '../../src/core/observability/runtime.js'

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

/**
 * Activate the three sink-contributing plugins HypAware ships against one
 * registry.
 *
 * @param {string} dir
 */
async function shippedSinks(dir) {
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
  return sinks
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
  //
  // The probe is an element the registry cannot read rather than the `join`
  // it once was: since #1568 the label is joined off the registry's own copy
  // of the tags, so taking that copy is the step that reads the plugin's
  // array, and it is the step that has to raise above the write.
  const reg = createSinkRegistry()
  const supports = /** @type {any} */ ([])
  Object.defineProperty(supports, 0, {
    get() { throw new TypeError('supports is not readable') },
  })
  assert.throws(() => reg.register(/** @type {any} */ ({
    name: 'half',
    plugin: '@third-party/raising-supports',
    supports,
    async create() { return { async exportBatch() { return {} }, async close() {} } },
  })), /supports is not readable/)

  assert.equal(
    reg.getContribution('@third-party/raising-supports', 'half'),
    undefined,
    'a refused registration was left in the registry'
  )
  assert.deepEqual(reg.listContributions(), [])

  // The `join` that used to raise here is contained rather than refused now:
  // it is never called on the plugin's array, so the registration stands and
  // the record carries the tags that were validated.
  const joinless = /** @type {any} */ (['queryable'])
  Object.defineProperty(joinless, 'join', {
    value() { throw new TypeError('supports is not joinable') },
  })
  reg.register(sinkOf({ name: 'joinless', plugin: '@third-party/raising-supports', supports: joinless }))
  assert.deepEqual(reg.listContributions().map((e) => e.supports), [['queryable']])
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
    const sinks = await shippedSinks(dir)

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

// `register` validated `contribution.supports` and then threw the value away:
// the stored wrapper was `{ plugin, contribution }`, so `resolveSupports` read
// the plugin's property again at instantiate time and a contribution
// registered - and logged in `sink.contribute` - as supporting nothing came
// back tagged `queryable` (#1568). `supports` is a declaration made once,
// matching the manifest entry (LLP 0014 #queryable-sinks), so the tags the
// registry validated are the tags it resolves.
//
// A fixture that installs its accessor onto an already-registered
// contribution installs it with `Object.defineProperties`: a spread or
// `Object.assign` invokes the getter once and copies the value out, leaving an
// ordinary array on the contribution the registry holds and a test that passes
// however the kernel behaves. Read counters are reset after the install for
// the same reason, and liveness is proved by requiring the getter to run twice
// for two reads, which a copied value cannot do.

/** @param {Record<string, unknown>} contribution */
function supportsIsStillAnAccessor(contribution) {
  return typeof Object.getOwnPropertyDescriptor(contribution, 'supports')?.get === 'function'
}

/**
 * @param {string} instanceName
 * @param {unknown} contribution
 */
function requestArgs(instanceName, contribution) {
  return /** @type {any} */ ({
    kind: 'request',
    instanceName,
    contribution,
    config: {},
    plugin: '@third-party/drifting-supports',
    paths: { rootDir: '/', stateDir: '/', cacheDir: '/', tempDir: '/' },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  })
}

/**
 * Collect the log records emitted while `fn` runs, then put the global
 * provider slot back the way the rest of this file expects it.
 *
 * @param {() => Promise<void>|void} fn
 * @returns {Promise<any[]>}
 */
async function recordsFrom(fn) {
  /** @type {any[]} */
  const records = []
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: [{ exportBatch: (/** @type {any[]} */ batch) => { records.push(...batch) } }],
  })
  logs.setGlobalLoggerProvider(provider)
  try {
    await fn()
  } finally {
    await provider.shutdown()
  }
  return records
}

test('instantiate resolves supports from the tags register validated', async () => {
  // The reported defect, in the shape it was reported: a getter answering `[]`
  // to `register` and `['queryable']` to everything after it.
  const reg = createSinkRegistry()
  let reads = 0
  const contribution = /** @type {any} */ ({
    name: 'a-sink',
    plugin: '@third-party/drifting-supports',
    get supports() {
      reads += 1
      return reads === 1 ? [] : ['queryable']
    },
    async create() { return { async exportBatch() { return {} }, async close() {} } },
  })
  reg.register(contribution)
  assert.equal(reads, 1, 'register read the plugin\'s `supports` more than once')

  const handle = await reg.instantiate(requestArgs('inst', contribution))

  assert.deepEqual(handle.supports, [], 'a sink registered as supporting nothing came back tagged')
  assert.equal(reads, 1, 'instantiate read the plugin\'s `supports` again')
  // Non-vacuity: the accessor is still live and still drifting.
  assert.deepEqual(contribution.supports, ['queryable'], 'the fixture stopped drifting')
  await reg.closeAll()
})

test('a supports accessor installed after registration decides nothing', async () => {
  // The same drift, arriving later: a plugin holding `ctx.sinks` can dress its
  // own contribution up between `activate()` and the daemon materializing the
  // configured sinks.
  const reg = createSinkRegistry()
  const contribution = sinkOf({ name: 'later', plugin: '@third-party/drifting-supports', supports: [] })
  reg.register(contribution)

  let reads = 0
  Object.defineProperties(contribution, Object.getOwnPropertyDescriptors({
    get supports() {
      reads += 1
      return ['queryable']
    },
  }))
  reads = 0

  const handle = await reg.instantiate(requestArgs('later-inst', contribution))

  assert.deepEqual(handle.supports, [])
  assert.equal(reads, 0, 'instantiate read the contribution\'s `supports` instead of the registry\'s')
  // Non-vacuity: a live getter runs once per read, which a copied value cannot
  // do. `Object.assign`/spread here would leave a plain array and this fails.
  assert.ok(supportsIsStillAnAccessor(contribution), 'the install flattened the accessor')
  assert.deepEqual(contribution.supports, ['queryable'])
  assert.deepEqual(contribution.supports, ['queryable'])
  assert.equal(reads, 2, 'the fixture stopped being live')
  await reg.closeAll()
})

test('mutating the registered supports array in place decides nothing', async () => {
  // No accessor needed: the plugin keeps a reference to the array it handed
  // over, so storing that array by reference would leave the tags editable
  // after they were checked.
  const reg = createSinkRegistry()
  /** @type {string[]} */
  const tags = []
  const contribution = sinkOf({ name: 'mutable', plugin: '@third-party/drifting-supports', supports: tags })
  reg.register(contribution)
  tags.push('queryable')

  const handle = await reg.instantiate(requestArgs('mutable-inst', contribution))

  assert.deepEqual(handle.supports, [])
  assert.deepEqual(contribution.supports, ['queryable'], 'the fixture stopped mutating')
  await reg.closeAll()
})

test('the tags the listing hands out are a copy of the ones the registry resolves', async () => {
  // `ctx.sinks` is this registry itself (`src/core/runtime/activation.js`), so
  // the listing is a plugin's route to the wrapper. Handing out the validated
  // array by reference would let it be edited after the check, which is #1568's
  // drift arriving by the other door.
  const reg = createSinkRegistry()
  const contribution = sinkOf({ name: 'listed', plugin: '@third-party/drifting-supports', supports: [] })
  reg.register(contribution)

  const entry = reg.listContributions()[0]
  entry.supports.push('queryable')
  const pushed = await reg.instantiate(requestArgs('listed-push', contribution))
  assert.deepEqual(pushed.supports, [], 'pushing onto the listed array decided supports')

  entry.supports = ['queryable']
  const reassigned = await reg.instantiate(requestArgs('listed-set', contribution))
  assert.deepEqual(reassigned.supports, [], 'reassigning the listed field decided supports')

  // Non-vacuity: the listing is still reporting the registration, and the
  // contribution reached instantiate by the identity the registry resolves on.
  assert.deepEqual(reg.listContributions().map((e) => e.supports), [[]])
  assert.equal(reg.listContributions()[0].contribution, contribution)
  await reg.closeAll()
})

test('the copy the registry keeps is a plain array the plugin cannot own', async () => {
  // The copy has to be one the plugin has no handle on. `slice()` builds its
  // result through `Symbol.species`, so an `Array` subclass that names its own
  // constructor is handed back the "copy" and answers a different tag list each
  // time it is read, which is #1568's drift through the field added to end it.
  let reads = 0
  const Species = /** @type {any} */ (class extends Array {})
  // Defined off the class body: TypeScript refuses a `Symbol.species` that is
  // not an `ArrayConstructor`, which is the whole point of the fixture.
  Object.defineProperty(Species, Symbol.species, {
    get() {
      return function () {
        return {
          length: 0,
          join() { return '' },
          slice() { return this },
          [Symbol.iterator]() {
            reads += 1
            return (reads === 1 ? [] : ['queryable'])[Symbol.iterator]()
          },
        }
      }
    },
  })
  const reg = createSinkRegistry()
  const contribution = sinkOf({ name: 'species', plugin: '@third-party/drifting-supports', supports: new Species() })
  reg.register(contribution)

  const first = await reg.instantiate(requestArgs('species-1', contribution))
  const second = await reg.instantiate(requestArgs('species-2', contribution))
  assert.deepEqual(first.supports, [])
  assert.deepEqual(second.supports, [], 'the second instance resolved tags the registry never validated')

  // Non-vacuity: the fixture is still hostile (its species is what `slice`
  // would have used), and the registry kept a plain array instead.
  assert.equal(Array.isArray(new Species().slice()), false, 'the fixture stopped hijacking slice')
  assert.equal(Array.isArray(reg.listContributions()[0].supports), true)
  assert.equal(reads, 0, 'the registry read the plugin-controlled stand-in')
  await reg.closeAll()
})

test('the sink.contribute, sink.resolved and sink.register records agree on supports', async () => {
  const reg = createSinkRegistry()
  let reads = 0
  const contribution = /** @type {any} */ ({
    name: 'a-sink',
    plugin: '@third-party/drifting-supports',
    get supports() {
      reads += 1
      return reads === 1 ? [] : ['queryable']
    },
    async create() { return { async exportBatch() { return {} }, async close() {} } },
  })

  const records = await recordsFrom(async () => {
    reg.register(contribution)
    await reg.instantiate(requestArgs('inst', contribution))
  })

  const supportsOf = (/** @type {string} */ event) => records
    .filter((r) => r.body === event)
    .map((r) => r.attributes.hyp_sink_supports)
  assert.deepEqual(supportsOf('sink.contribute'), [''])
  assert.deepEqual(supportsOf('sink.resolved'), [''], 'sink.resolved contradicted sink.contribute')
  assert.deepEqual(supportsOf('sink.register'), [''], 'sink.register contradicted sink.contribute')
  assert.equal(reads, 1)
  assert.deepEqual(contribution.supports, ['queryable'], 'the fixture stopped drifting')
  await reg.closeAll()
})

test('the shipped sink contributions resolve the supports they declare', async () => {
  // Honest-path equivalence: the three sinks HypAware ships declare plain
  // arrays, so the validated tags and a live read are the same value, and the
  // writer+destination intersection still decides `queryable`.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sink-supports-'))
  try {
    const sinks = await shippedSinks(dir)

    assert.deepEqual(
      sinks.listContributions().map((e) => [e.plugin, e.supports]),
      [
        ['@hypaware/local-fs', ['queryable']],
        ['@hypaware/central', []],
        ['@hypaware/s3', ['queryable']],
      ]
    )
    for (const entry of sinks.listContributions()) {
      assert.deepEqual(entry.supports, entry.contribution.supports, `${entry.plugin} drifted`)
    }

    const localFs = /** @type {any} */ (sinks.getContribution('@hypaware/local-fs', 'local-fs'))
    /**
     * @param {string} instanceName
     * @param {string[]} encoderSupports
     */
    const blob = (instanceName, encoderSupports) => /** @type {any} */ ({
      kind: 'blob',
      instanceName,
      destination: localFs,
      writerPlugin: '@hypaware/format-parquet',
      encoder: { format: 'parquet', supports: encoderSupports, async encodePartition() { return {} } },
      config: { dir: path.join(dir, 'exports') },
      plugin: '@hypaware/local-fs',
      paths: { rootDir: dir, stateDir: dir, cacheDir: dir, tempDir: dir },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    })
    const queryable = await sinks.instantiate(blob('parquet-on-local-fs', ['queryable']))
    assert.deepEqual(queryable.supports, ['queryable'])
    const notQueryable = await sinks.instantiate(blob('jsonl-on-local-fs', []))
    assert.deepEqual(notQueryable.supports, [], 'the encoder no longer bounds the pair')
    await sinks.closeAll()
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
