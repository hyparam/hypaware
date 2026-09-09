// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createActivationContext } from '../../src/core/runtime/activation.js'
import { createSourceRegistry } from '../../src/core/registry/sources.js'
import { startConfiguredSources } from '../../src/core/daemon/runtime.js'
import { LoggerProvider, logs } from '../../src/core/observability/runtime.js'

/** @import { SourceContribution } from '../../hypaware-plugin-kernel-types.js' */

// `SourceRegistry.register` validated `contribution.plugin` as a non-empty
// string and then discarded it: the Map was keyed by source name only and no
// record was kept of which plugin registered which source. The daemon's boot
// walk picked the activation context with that self-declared string, so a
// plugin whose source contribution named a neighbour was started with the
// neighbour's config slice, paths, scoped logger, capability handles and
// permission context (issue #1541). A plain static string did it.

const A = '@fixture/owner-a'
const B = '@fixture/owner-b'

/**
 * Install `over`'s property descriptors onto an already-registered
 * contribution, so `plugin` becomes a live accessor on the object the registry
 * is holding.
 *
 * Descriptors, not `{ ...base, ...over }`: a spread invokes each getter once
 * and copies the value out, leaving a contribution whose `plugin` is an
 * ordinary string, and the probe proves nothing about a live read. The read
 * counters are asserted for the same reason.
 *
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} over
 */
function beHostile(base, over) {
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(over))
}

/** @param {Record<string, unknown>} contribution */
function pluginIsStillAnAccessor(contribution) {
  const descriptor = Object.getOwnPropertyDescriptor(contribution, 'plugin')
  return typeof descriptor?.get === 'function'
}

function makeLog() {
  /** @type {Array<{ level: string, event: string, fields: Record<string, unknown> }>} */
  const records = []
  /** @param {string} level */
  const at = (level) => (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields) => {
    records.push({ level, event, fields: fields ?? {} })
  }
  return { records, info: at('info'), warn: at('warn'), error: at('error') }
}

/**
 * A source whose handle does nothing but exist, plus the record of what it was
 * started with.
 *
 * @param {string} name
 * @param {string} plugin
 */
function fixtureSource(name, plugin) {
  /** @type {{ starts: number, ctx: unknown }} */
  const seen = { starts: 0, ctx: undefined }
  return {
    seen,
    contribution: /** @type {any} */ ({
      name,
      plugin,
      /** @param {unknown} ctx */
      async start(ctx) {
        seen.starts += 1
        seen.ctx = ctx
        return { async stop() {} }
      },
    }),
  }
}

/**
 * A kernel runtime with a real source registry, plus the two activation
 * contexts the boot walk chooses between. Only the members
 * `createActivationContext` and `startConfiguredSources` reach for are
 * present; the rest of the runtime is not what is under test here.
 */
function stage() {
  const runtime = /** @type {any} */ ({
    sources: createSourceRegistry(),
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

test('a source contribution declaring a neighbour\'s plugin is refused, and the neighbour keeps its own context', async () => {
  const { runtime, ctxA, ctxB } = stage()
  // `aaa` sorts first, so on the unfixed code the boot walk reaches it before
  // the honest source it impersonates.
  const impostor = fixtureSource('aaa', B)
  const honest = fixtureSource('bbb', B)

  assert.throws(
    () => ctxA.sources.register(impostor.contribution),
    /declares plugin/,
    'a contribution naming a plugin other than the one registering it was accepted'
  )
  ctxB.sources.register(honest.contribution)

  const log = makeLog()
  const fileLog = makeLog()
  const snapshots = await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })

  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state })),
    [{ name: 'bbb', plugin: B, state: 'started' }],
    'the status rows list a source the kernel never bound to the plugin that registered it'
  )
  assert.equal(impostor.seen.starts, 0, 'the refused contribution was started')
  assert.equal(honest.seen.starts, 1, 'the honest source must start exactly once')
  assert.equal(honest.seen.ctx, ctxB, 'the honest source was handed a context that is not its own')
})

test('the refused registration is observable as a structured warn naming both plugins', async () => {
  const { ctxA } = stage()
  const impostor = fixtureSource('aaa', B)

  const records = await recordsFrom(() => {
    assert.throws(() => ctxA.sources.register(impostor.contribution))
  })

  const warned = records.filter((r) => r.body === 'source.register_plugin_mismatch')
  assert.equal(warned.length, 1, 'a refused registration was silent')
  assert.equal(warned[0].severityText, 'WARN')
  assert.equal(warned[0].attributes.hyp_component, 'sources')
  assert.equal(warned[0].attributes.hyp_operation, 'source.register')
  assert.equal(warned[0].attributes.error_kind, 'source_plugin_mismatch')
  assert.equal(warned[0].attributes.hyp_source, 'aaa')
  assert.equal(warned[0].attributes.hyp_plugin, A, 'the warn does not say which plugin was registering')
  assert.equal(warned[0].attributes.hyp_declared_plugin, B, 'the warn does not say which plugin was claimed')
})

test('a source registered under the plugin it honestly declares is unaffected', async () => {
  const { runtime, ctxA, ctxB } = stage()
  const second = fixtureSource('zzz-second', B)
  const first = fixtureSource('aaa-first', A)
  ctxB.sources.register(second.contribution)
  ctxA.sources.register(first.contribution)

  const log = makeLog()
  const fileLog = makeLog()
  const snapshots = await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })

  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state, health: s.health })),
    [
      { name: 'aaa-first', plugin: A, state: 'started', health: { state: 'ready' } },
      { name: 'zzz-second', plugin: B, state: 'started', health: { state: 'ready' } },
    ],
    'the registered order or the snapshot rows changed for honest contributions'
  )
  assert.equal(first.seen.ctx, ctxA)
  assert.equal(second.seen.ctx, ctxB)
  assert.equal(fileLog.records.filter((r) => r.level === 'warn').length, 0, 'an honest boot warned about something')
})

test('a plugin that drifts to a neighbour after registering is still started under its own context', async () => {
  const { runtime, ctxA, ctxB } = stage()
  const drifting = fixtureSource('aaa', A)
  const honest = fixtureSource('bbb', B)
  ctxA.sources.register(drifting.contribution)
  ctxB.sources.register(honest.contribution)
  let reads = 0
  beHostile(drifting.contribution, {
    get plugin() {
      reads += 1
      return B
    },
  })

  const log = makeLog()
  const fileLog = makeLog()
  const snapshots = await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })

  assert.equal(drifting.seen.ctx, ctxA, 'a drifted plugin field chose the activation context')
  assert.equal(honest.seen.ctx, ctxB)
  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state })),
    [{ name: 'aaa', plugin: A, state: 'started' }, { name: 'bbb', plugin: B, state: 'started' }],
    'a status row carries a plugin the kernel did not record as the registrar'
  )
  // Non-vacuity: the registry holds the live accessor and the walk did read it.
  assert.ok(pluginIsStillAnAccessor(drifting.contribution), 'the fixture stopped being hostile')
  assert.equal(reads, 1, `the walk read the drifted plugin ${reads} times`)
})

test('a contribution registered straight on the registry, with no activating plugin, is unchanged', () => {
  const registry = createSourceRegistry()
  const direct = fixtureSource('direct', A)
  registry.register(direct.contribution)
  assert.equal(/** @type {SourceContribution} */ (registry.get('direct')), direct.contribution)
  assert.equal(registry.ownerOf('direct'), undefined, 'the kernel recorded an owner it never saw register')
})

test('a plugin cannot register as someone else through the registrar bracket it is handed', () => {
  const { runtime, ctxA } = stage()
  const impostor = fixtureSource('aaa', B)

  assert.throws(
    // The bracket around the registry's own `register`, not the facade's:
    // the facade pins the activating plugin on this member too, so the
    // spread does not hand a plugin the lever the kernel registers with.
    () => /** @type {any} */ (ctxA.sources).registeringAs(B, () => runtime.sources.register(impostor.contribution)),
    /declares plugin/,
    'a plugin set the registrar to a neighbour and registered under it'
  )
  assert.equal(runtime.sources.get('aaa'), undefined, 'the impostor reached the registry anyway')
})

test('an activation context over a registry with only the contract surface still registers', () => {
  /** @type {Map<string, any>} */
  const held = new Map()
  const runtime = /** @type {any} */ ({
    sources: {
      /** @param {any} c */
      register(c) { held.set(c.name, c) },
      /** @param {string} n */
      get(n) { return held.get(n) },
      list() { return Array.from(held.values()) },
    },
    capabilities: { provide() {}, require() {}, has() { return false }, list() { return [] } },
    activationContexts: new Map(),
  })
  const ctx = createActivationContext({
    runtime,
    plugin: /** @type {any} */ ({ name: A, version: '1.0.0', manifest: { name: A, permissions: [] }, rootDir: '/nowhere' }),
    paths: /** @type {any} */ ({}),
    config: {},
    env: {},
  })
  const source = fixtureSource('plain', A)
  ctx.sources.register(source.contribution)
  assert.equal(held.get('plain'), source.contribution, 'a host registry without the kernel members lost a registration')
  assert.equal(
    /** @type {any} */ (ctx.sources).registeringAs(B, () => 'ran'),
    'ran',
    'the bracket must still run its callback when the registry has nothing to record with'
  )
})
