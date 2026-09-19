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

test('a prototype-backed registry reaches a plugin with the whole registry, not the own half', () => {
  // The facade forwards "the rest of the registry" to the plugin. A spread
  // would carry own enumerable properties and nothing else, so a registry
  // holding `get`/`list`/the lifecycle members on a prototype reached
  // `activate()` without them, and a plugin that starts its own source there
  // (`@hypaware/otel`) got `ctx.sources.list is not a function`. A host
  // supplies exactly such a registry through `hypaware/integration`'s
  // `run(argv, { kernel })`, which dispatch hands to both of its activation
  // seams unchanged, so this is reachable without `createKernelRuntime` being
  // exported.
  class HostSourceRegistry {
    /** @param {ReturnType<typeof createSourceRegistry>} inner */
    constructor(inner) { this.inner = inner }
    /** @param {SourceContribution} c */
    register(c) { return this.inner.register(c) }
    /** @param {any} p @param {() => any} fn */
    registeringAs(p, fn) { return this.inner.registeringAs(p, fn) }
    /** @param {string} n */
    ownerOf(n) { return this.inner.ownerOf(n) }
    /** @param {string} n */
    get(n) { return this.inner.get(n) }
    list() { return this.inner.list() }
  }

  const inner = createSourceRegistry()
  const runtime = /** @type {any} */ ({
    sources: new HostSourceRegistry(inner),
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

  const sources = /** @type {any} */ (ctx.sources)
  assert.equal(typeof sources.get, 'function', 'an inherited `get` did not reach the plugin')
  assert.equal(typeof sources.list, 'function', 'an inherited `list` did not reach the plugin')
  assert.equal(typeof sources.ownerOf, 'function', 'an inherited `ownerOf` did not reach the plugin')

  const source = fixtureSource('proto', A)
  ctx.sources.register(source.contribution)
  assert.deepEqual(sources.list().map((/** @type {any} */ c) => c.name), ['proto'], 'the inherited `list` did not answer')
  assert.equal(sources.ownerOf('proto'), A, 'the registrar was not recorded through the inherited member')

  // The host registry's own state is not copied onto what the plugin holds.
  assert.deepEqual(Object.keys(sources).sort(), ['register', 'registeringAs'])
})

// Issue #1944. The facade forwarded "the rest" of the registry by putting the
// registry on its prototype chain, and a prototype is reachable from the object
// that inherits it. `Object.getPrototypeOf(ctx.sources).register(c)` reached the
// registry's own unbracketed `register`, where the registrar is the empty
// string: `owners.set` never ran and the `plugin !== registrar` refusal above
// never ran, so a plugin took any free source name while declaring any plugin
// it liked. The daemon's boot walk then resolved that claim into the named
// plugin's activation context, its config slice, paths, logger, capability
// handles and permission context.

test('a plugin cannot reach the registry through the facade it is handed', () => {
  const { runtime, ctxA } = stage()

  assert.equal(
    Object.getPrototypeOf(ctxA.sources),
    null,
    'the facade still puts the registry one property read away from the plugin'
  )
  // Not only the first hop: nothing the plugin can read off the facade is the
  // registry, so there is no second hop either.
  for (const key of Reflect.ownKeys(ctxA.sources)) {
    assert.notEqual(
      /** @type {any} */ (ctxA.sources)[key],
      runtime.sources,
      `the facade hands the registry out as '${String(key)}'`
    )
  }
  // The registry's members still answer, which is what the chain was for.
  assert.equal(typeof /** @type {any} */ (ctxA.sources).list, 'function')
  assert.ok('ownerOf' in ctxA.sources, 'the facade stopped seeing the registry members')
})

// The shadow the facade puts over `register`/`registeringAs` is only as good
// as a plugin's inability to lift it. While the two members were ordinary
// assigned properties, `delete ctx.sources.register` took the own property
// away and the proxy's miss read the registry's own unbracketed `register`
// back out, reopening #1944 in one statement; deleting `registeringAs` as well
// reached the registrar lever and recorded whatever owner the squatter named,
// which the boot walk now trusts with no fallback.

test('a plugin cannot delete the facade members to uncover the registry\'s own', () => {
  const { runtime, ctxA, ctxB } = stage()
  const sources = /** @type {any} */ (ctxA.sources)

  assert.throws(() => { 'use strict'; delete sources.register }, TypeError)
  assert.throws(() => { 'use strict'; delete sources.registeringAs }, TypeError)
  assert.equal(Reflect.deleteProperty(sources, 'register'), false)
  assert.equal(Reflect.deleteProperty(sources, 'registeringAs'), false)
  assert.throws(() => Object.defineProperty(sources, 'register', { value: 1 }), TypeError)
  assert.equal(Reflect.set(sources, 'register', 1), false)

  // Non-vacuity: the members are still the facade's, not the registry's.
  assert.notEqual(sources.register, runtime.sources.register)
  assert.notEqual(sources.registeringAs, runtime.sources.registeringAs)

  // The full squat the deletions bought, attempted against the live facade.
  const squatter = fixtureSource('aaa', B)
  sources.registeringAs(B, () => {
    assert.throws(() => sources.register(squatter.contribution), /declares plugin/)
  })
  assert.equal(runtime.sources.get('aaa'), undefined, 'the squatter reached the registry anyway')
  assert.equal(runtime.sources.ownerOf('aaa'), undefined)

  // And the honest path is untouched by the lock.
  const honest = fixtureSource('bbb', A)
  ctxA.sources.register(honest.contribution)
  assert.equal(runtime.sources.ownerOf('bbb'), A)
  assert.deepEqual(Object.keys(sources).sort(), ['register', 'registeringAs'])
  assert.ok(ctxB)
})

test('a squatter cannot take a name ownerless and be started under the plugin it names', async () => {
  const { runtime, ctxA, ctxB } = stage()
  // The whole squat: `aaa` is registered out of band, declaring B, so the
  // registry records no owner and never compares the claim to the registrar.
  // `ctxA` stands in for the squatter and `ctxB` for the plugin it names.
  const squatter = fixtureSource('aaa', B)
  assert.throws(
    () => /** @type {any} */ (Object.getPrototypeOf(ctxA.sources)).register(squatter.contribution),
    /Cannot read properties of null/,
    'the facade prototype still reaches an unbracketed register'
  )
  assert.equal(runtime.sources.get('aaa'), undefined, 'the squatter reached the registry anyway')

  // The registration the bypass used to produce, staged straight on the
  // registry: the boot walk must refuse it rather than resolve its claim.
  runtime.sources.register(squatter.contribution)
  assert.equal(runtime.sources.ownerOf('aaa'), undefined)

  const log = makeLog()
  const fileLog = makeLog()
  const snapshots = await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })

  assert.equal(squatter.seen.starts, 0, 'a source with no recorded registrar was started')
  assert.notEqual(squatter.seen.ctx, ctxB, 'the squatter was handed the context of the plugin it named')
  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state, error: s.error })),
    [{
      name: 'aaa',
      plugin: B,
      state: 'failed',
      error: "no registering plugin recorded for source 'aaa'",
    }],
    'the refusal is not on the status row, or does not say what it refused'
  )
  assert.equal(
    fileLog.records.filter((r) => r.event === 'daemon.source_start_failed').length,
    1,
    'the refusal was not logged'
  )
})

test('every way a plugin legitimately registers still records it as the owner', async () => {
  const { runtime, ctxA, ctxB } = stage()

  // Plain call.
  const plain = fixtureSource('aaa-plain', A)
  ctxA.sources.register(plain.contribution)

  // Destructured off the facade, so `this` is not the facade at the call.
  const detached = fixtureSource('bbb-detached', A)
  const { register } = ctxA.sources
  register(detached.contribution)

  // After an `await` inside `activate()`, the case the bracket is synchronous
  // for: two activations interleaved around a microtask still each record
  // their own registrar.
  const awaitedA = fixtureSource('ccc-awaited-a', A)
  const awaitedB = fixtureSource('ddd-awaited-b', B)
  await Promise.all([
    (async () => { await Promise.resolve(); ctxA.sources.register(awaitedA.contribution) })(),
    (async () => { await Promise.resolve(); ctxB.sources.register(awaitedB.contribution) })(),
  ])

  // The plugin brackets the call itself, through the extended surface
  // `@hypaware/otel` already reaches for. The name it passes is ignored.
  const bracketed = fixtureSource('eee-bracketed', A)
  const extended = /** @type {any} */ (ctxA.sources)
  extended.registeringAs(B, () => {
    ctxA.sources.register(bracketed.contribution)
  })

  assert.deepEqual(
    [
      runtime.sources.ownerOf('aaa-plain'),
      runtime.sources.ownerOf('bbb-detached'),
      runtime.sources.ownerOf('ccc-awaited-a'),
      runtime.sources.ownerOf('ddd-awaited-b'),
      runtime.sources.ownerOf('eee-bracketed'),
    ],
    [A, A, A, B, A],
    'a legitimate registration path lost its owner, or recorded the wrong one'
  )

  const log = makeLog()
  const fileLog = makeLog()
  const snapshots = await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })
  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state })),
    [
      { name: 'aaa-plain', plugin: A, state: 'started' },
      { name: 'bbb-detached', plugin: A, state: 'started' },
      { name: 'ccc-awaited-a', plugin: A, state: 'started' },
      { name: 'ddd-awaited-b', plugin: B, state: 'started' },
      { name: 'eee-bracketed', plugin: A, state: 'started' },
    ],
    'a legitimately registered source stopped starting'
  )
  assert.equal(plain.seen.ctx, ctxA)
  assert.equal(detached.seen.ctx, ctxA)
  assert.equal(awaitedA.seen.ctx, ctxA)
  assert.equal(awaitedB.seen.ctx, ctxB)
  assert.equal(bracketed.seen.ctx, ctxA)
  assert.equal(fileLog.records.filter((r) => r.level === 'error').length, 0, 'an honest boot failed a source')
})

test('a registry that records no registrars at all is read as before', async () => {
  // A host drives its own registry through `hypaware/integration`. It has no
  // `registeringAs` and no `ownerOf`, so there is no binding to defeat and the
  // contribution's claim is all the boot walk has ever had here. Refusing on
  // its absence would stop every source such a host runs.
  /** @type {Map<string, any>} */
  const held = new Map()
  const runtime = /** @type {any} */ ({
    sources: {
      /** @param {any} c */
      register(c) { held.set(c.name, c) },
      /** @param {string} n */
      get(n) { return held.get(n) },
      list() { return Array.from(held.values()) },
      started() { return undefined },
      /** @param {string} n @param {any} ctx */
      async start(n, ctx) { await held.get(n).start(ctx) },
      async status() { return undefined },
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
  const source = fixtureSource('host', A)
  ctx.sources.register(source.contribution)

  const log = makeLog()
  const fileLog = makeLog()
  const snapshots = await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })
  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state })),
    [{ name: 'host', plugin: A, state: 'started' }],
    'a host registry that never recorded a registrar stopped starting its sources'
  )
  assert.equal(source.seen.ctx, ctx)
})
