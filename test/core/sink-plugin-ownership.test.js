// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createActivationContext } from '../../src/core/runtime/activation.js'
import { createSinkRegistry } from '../../src/core/registry/sinks.js'
import { LoggerProvider, logs } from '../../src/core/observability/runtime.js'

/** @import { ExtendedSinkHandle, ExtendedSinkRegistry } from '../../src/core/registry/types.js' */

// `ctx.sinks` was `runtime.sinks` verbatim, so every activated plugin held the
// kernel's own registry: no owner bracket, no narrowing, and `SinkHandle.sink`
// live and writable. From a plugin that registered nothing, `get(instance)`
// answered with the handle the sink driver calls, which is egress to another
// plugin's configured destination under its credentials, off the driver, so
// unscheduled, unspanned, uncursored and invisible to `hyp sync`'s preview and
// the LLP 0070 read (issue #1961).

const A = '@fixture/sink-owner'
const B = '@fixture/squatter'

/**
 * A kernel runtime with a real sink registry, plus the two activation contexts
 * a plugin reaches it through. Only the members `createActivationContext`
 * touches are present.
 */
function stage() {
  const runtime = /** @type {any} */ ({
    sinks: createSinkRegistry(),
    sources: { register() {}, get() {}, list() { return [] } },
    capabilities: { provide() {}, require() {}, has() { return false }, list() { return [] } },
    activationContexts: new Map(),
  })
  /** @param {string} name */
  const contextFor = (name) => createActivationContext({
    runtime,
    plugin: /** @type {any} */ ({ name, version: '1.0.0', manifest: { name, permissions: [] }, rootDir: '/nowhere' }),
    paths: /** @type {any} */ ({ stateDir: '/nowhere', cacheDir: '/nowhere', tmpDir: '/nowhere' }),
    config: {},
    env: {},
  })
  return { runtime, ctxA: contextFor(A), ctxB: contextFor(B) }
}

/**
 * A request sink contribution plus the record of everything its live `Sink`
 * was asked to do, so a reach through a neighbour's facade is measured at the
 * destination rather than inferred from the shape of the handle.
 *
 * @param {string} name
 * @param {string} plugin
 */
function fixtureSink(name, plugin) {
  /** @type {{ exports: unknown[], closes: number, readers: number, creates: number }} */
  const seen = { exports: [], closes: 0, readers: 0, creates: 0 }
  return {
    seen,
    contribution: /** @type {any} */ ({
      name,
      plugin,
      supports: ['queryable'],
      async create() {
        seen.creates += 1
        return {
          /** @param {unknown} batch */
          async exportBatch(batch) {
            seen.exports.push(batch)
            return { exported: true }
          },
          async close() { seen.closes += 1 },
          reader() {
            seen.readers += 1
            return /** @type {any} */ ({ rows: 'ALL THE ROWS' })
          },
        }
      },
    }),
  }
}

/**
 * A's contribution registered under A and one instance materialized from
 * config, which is exactly what `materializeSinks` does at boot.
 *
 * @param {ReturnType<typeof stage>} staged
 * @param {ReturnType<typeof fixtureSink>} owner
 */
async function materialize(staged, owner) {
  staged.ctxA.sinks.register(owner.contribution)
  const registry = /** @type {ExtendedSinkRegistry} */ (staged.runtime.sinks)
  return registry.instantiate({
    kind: 'request',
    instanceName: 'org-central',
    contribution: owner.contribution,
    config: { schedule: '* * * * *', endpoint: 'https://central.example', token: 'SECRET-TOKEN' },
    plugin: /** @type {any} */ (staged.ctxA.plugin),
    paths: /** @type {any} */ (staged.ctxA.paths),
    log: /** @type {any} */ (staged.ctxA.log),
  })
}

/**
 * Collect the kernel's own log records emitted while `fn` runs.
 *
 * @param {() => void | Promise<void>} fn
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

test('a neighbour cannot drive an export to a configured sink it does not own', async () => {
  const staged = stage()
  const owner = fixtureSink('central', A)
  await materialize(staged, owner)

  const handle = /** @type {any} */ (staged.ctxB.sinks.get('org-central'))
  await assert.rejects(
    () => handle.sink.exportBatch({ partitions: [], batchId: 'forged' }, { format: 'json', schedule: '' }),
    /not owned by '@fixture\/squatter'/,
    'a plugin that registered nothing drove an export to another plugin\'s destination'
  )
  assert.deepEqual(owner.seen.exports, [], 'forged rows reached the owner\'s destination')
})

test('a neighbour cannot close, flush or read a sink it does not own', async () => {
  const staged = stage()
  const owner = fixtureSink('central', A)
  await materialize(staged, owner)

  const handle = /** @type {any} */ (staged.ctxB.sinks.get('org-central'))
  await assert.rejects(() => handle.sink.close(), /not owned by '@fixture\/squatter'/, 'a neighbour closed the sink')
  await assert.rejects(() => handle.sink.flush(), /not owned by '@fixture\/squatter'/, 'a neighbour flushed the sink')
  assert.equal(owner.seen.closes, 0, 'the owner\'s sink was closed by a plugin that does not own it')
  assert.equal(handle.sink.reader, undefined, 'a neighbour reached the queryable sink\'s reader')
  assert.equal(owner.seen.readers, 0, 'the owner\'s reader ran for a neighbour')
})

test('closeAll closes only the calling plugin\'s own sinks', async () => {
  const staged = stage()
  const owner = fixtureSink('central', A)
  await materialize(staged, owner)

  await /** @type {any} */ (staged.ctxB.sinks).closeAll()
  assert.equal(owner.seen.closes, 0, 'a neighbour\'s closeAll stopped another plugin\'s exports')
  const still = /** @type {any} */ (staged.ctxA.sinks.get('org-central'))
  assert.ok(still, 'the owner\'s handle was removed from the registry by a neighbour')

  await /** @type {any} */ (staged.ctxA.sinks).closeAll()
  assert.equal(owner.seen.closes, 1, 'the owner\'s own closeAll must still close its sink')
})

test('a neighbour sees no instance config, so an inline token is not disclosed', async () => {
  const staged = stage()
  const owner = fixtureSink('central', A)
  await materialize(staged, owner)

  const handle = /** @type {any} */ (staged.ctxB.sinks.get('org-central'))
  assert.equal(handle.config, undefined, 'a neighbour read the sink instance config')
  assert.deepEqual(
    Object.keys(handle).sort(),
    ['name', 'plugin', 'sink', 'supports'],
    'the narrowed handle carries more than the declared SinkHandle surface'
  )
  assert.equal(handle.name, 'org-central')
  assert.equal(handle.plugin, A)
  assert.deepEqual(handle.supports, ['queryable'])
})

test('a neighbour cannot substitute the object the sink driver calls', async () => {
  const staged = stage()
  const owner = fixtureSink('central', A)
  await materialize(staged, owner)

  const mine = { async exportBatch() { return { exported: true } }, async close() {} }
  const handle = /** @type {any} */ (staged.ctxB.sinks.get('org-central'))
  assert.throws(() => { handle.sink = mine }, TypeError, 'a neighbour replaced the live sink on the handle')
  assert.throws(() => { delete handle.sink }, TypeError, 'a neighbour deleted the live sink off the handle')

  const live = /** @type {ExtendedSinkHandle} */ (/** @type {any} */ (staged.ctxA.sinks.get('org-central')))
  assert.notEqual(live.sink, mine, 'the driver\'s handle carries a neighbour\'s object')
  await live.sink.exportBatch(/** @type {any} */ ({ partitions: [], batchId: 'real' }), /** @type {any} */ ({}))
  assert.equal(owner.seen.exports.length, 1, 'the owner\'s own export path stopped working')
})

test('list and listHandles hand a neighbour no live sink either', async () => {
  const staged = stage()
  const owner = fixtureSink('central', A)
  await materialize(staged, owner)

  const registry = /** @type {any} */ (staged.ctxB.sinks)
  for (const member of ['list', 'listHandles']) {
    const [entry] = registry[member]()
    assert.equal(entry.config, undefined, `${member}() disclosed the instance config`)
    await assert.rejects(
      () => entry.sink.exportBatch({ partitions: [], batchId: 'forged' }, {}),
      /not owned by '@fixture\/squatter'/,
      `${member}() handed a neighbour a live export path`
    )
  }
  assert.deepEqual(owner.seen.exports, [], 'forged rows reached the owner\'s destination')
})

test('a contribution claiming a neighbour\'s plugin is refused', async () => {
  const { ctxB } = stage()
  const liar = fixtureSink('liar', A)
  assert.throws(
    () => ctxB.sinks.register(liar.contribution),
    /declares plugin/,
    'a sink contribution naming a plugin other than the one registering it was accepted'
  )
})

test('the refused registration is observable as a structured warn naming both plugins', async () => {
  const { ctxB } = stage()
  const liar = fixtureSink('liar', A)
  const records = await recordsFrom(() => {
    assert.throws(() => ctxB.sinks.register(liar.contribution))
  })
  const warned = records.filter((r) => r.body === 'sink.register_plugin_mismatch')
  assert.equal(warned.length, 1, 'a refused registration was silent')
  assert.equal(warned[0].severityText, 'WARN')
  assert.equal(warned[0].attributes.hyp_component, 'sinks')
  assert.equal(warned[0].attributes.error_kind, 'sink_plugin_mismatch')
  assert.equal(warned[0].attributes.hyp_plugin, B)
  assert.equal(warned[0].attributes.hyp_declared_plugin, A)
  assert.equal(warned[0].attributes.hyp_sink, 'liar')
})

test('a neighbour cannot run another plugin\'s create() or stand up an unconfigured instance', async () => {
  const staged = stage()
  const owner = fixtureSink('central', A)
  await materialize(staged, owner)
  const createsAfterMaterialize = owner.seen.creates

  const registry = /** @type {any} */ (staged.ctxB.sinks)
  const foreign = registry.getContribution(A, 'central')
  assert.equal(typeof foreign, 'object', 'getContribution must still answer with a contribution')
  await assert.rejects(() => foreign.create({}), /carries no live create/, 'a neighbour ran another plugin\'s create()')
  const [listed] = registry.listContributions()
  await assert.rejects(() => listed.contribution.create({}), /carries no live create/, 'listContributions handed over a live create()')

  await assert.rejects(
    () => registry.instantiate({
      kind: 'request',
      instanceName: 'squatted',
      contribution: owner.contribution,
      config: {},
      plugin: staged.ctxB.plugin,
      paths: staged.ctxB.paths,
      log: staged.ctxB.log,
    }),
    /instance creation is driven by the kernel/,
    'a plugin stood up a sink instance the config never declared'
  )
  assert.equal(owner.seen.creates, createsAfterMaterialize, 'another plugin\'s create() ran')
  assert.equal(staged.runtime.sinks.get('squatted'), undefined, 'an unconfigured instance landed in the registry')
})

test('the owning plugin reaches its own sink unchanged', async () => {
  const staged = stage()
  const owner = fixtureSink('central', A)
  const materialized = await materialize(staged, owner)

  const handle = /** @type {any} */ (staged.ctxA.sinks.get('org-central'))
  assert.equal(handle === materialized, true, 'the owner no longer gets the live handle the kernel built')
  assert.equal(handle.config.token, 'SECRET-TOKEN')
  await handle.sink.exportBatch({ partitions: [], batchId: 'real' }, {})
  assert.equal(owner.seen.exports.length, 1, 'the owner cannot export through its own sink')
  assert.equal(handle.sink.reader().rows, 'ALL THE ROWS', 'the owner cannot read its own queryable sink')
  assert.equal(staged.ctxA.sinks.list()[0], materialized, 'list() no longer answers the owner with its own handle')
  const own = /** @type {any} */ (staged.ctxA.sinks).getContribution(A, 'central')
  assert.equal(own, owner.contribution, 'the owner no longer gets its own contribution back')
})

test('the kernel keeps the live registry, so the driver and hyp status are unaffected', async () => {
  const staged = stage()
  const owner = fixtureSink('central', A)
  const materialized = await materialize(staged, owner)

  const registry = /** @type {ExtendedSinkRegistry} */ (staged.runtime.sinks)
  assert.equal(registry.get('org-central'), materialized)
  assert.deepEqual(registry.listHandles(), [materialized])
  assert.equal(registry.listContributions()[0].contribution, owner.contribution)
  await registry.closeAll()
  assert.equal(owner.seen.closes, 1, 'the kernel\'s own shutdown no longer closes the sink')
})

test('an owner\'s throwing accessor does not escape into a neighbour\'s list()', async () => {
  const staged = stage()
  const owner = fixtureSink('central', A)
  const materialized = await materialize(staged, owner)

  // A handle is a live object the owner still holds, so `name` is a property
  // the owner can replace with code of its own. The ownership check a listing
  // runs must not become a seam that runs it inside a neighbour's call.
  Object.defineProperty(materialized, 'name', {
    configurable: true,
    get() { throw new Error('boom from the owner') },
  })

  const registry = /** @type {any} */ (staged.ctxB.sinks)
  for (const member of ['list', 'listHandles']) {
    const listed = registry[member]()
    assert.equal(listed.length, 1, `${member}() dropped the entry instead of narrowing it`)
    await assert.rejects(
      () => listed[0].sink.exportBatch({ partitions: [], batchId: 'forged' }, {}),
      /not owned by '@fixture\/squatter'/,
      `${member}() handed a neighbour a live export path for an unreadable name`
    )
  }
  assert.deepEqual(owner.seen.exports, [], 'forged rows reached the owner\'s destination')
})
