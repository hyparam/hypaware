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
  // `get` and `list` are bracketed because this registry records registrars;
  // the lifecycle members are not, because it has none to bracket.
  assert.deepEqual(Object.keys(sources).sort(), ['get', 'list', 'register', 'registeringAs'])
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
  // The lifecycle members are bracketed over this registry too, and are
  // pinned the same way the two above are.
  assert.deepEqual(
    Object.keys(sources).sort(),
    ['get', 'list', 'listStarted', 'register', 'registeringAs', 'reload', 'start', 'started', 'stop', 'stopAll']
  )
  // Every one of them pinned the same way, which is what makes the `[[Get]]`
  // trap fail closed when `Object.hasOwn` is patched out from under it.
  for (const member of Object.keys(sources)) {
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(sources, member),
      { value: sources[member], writable: false, enumerable: true, configurable: false },
      `'${member}' is not pinned`
    )
  }
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

// Issue #1947. The facade bracketed `register` and forwarded the kernel-side
// lifecycle members unchanged, which is #1541 pointed the other way: rather
// than taking a neighbour's context by registering under its name, a plugin
// handed a neighbour's already-registered source its own context by starting
// it. Activation order makes the window the ordinary one: a plugin activating
// second sees its neighbours' sources registered and none of them started,
// because `startConfiguredSources` runs after every activation. The same
// handle pointed `stop` and `stopAll` at a neighbour's running source.

test('a plugin cannot start a neighbour\'s source under its own context', async () => {
  const { runtime, ctxA, ctxB } = stage()
  const victim = fixtureSource('ai-gateway', A)
  ctxA.sources.register(victim.contribution)

  // B activates second and reaches for the neighbour the kernel has not
  // started yet. Rejected, not resolved under B.
  await assert.rejects(
    () => /** @type {any} */ (ctxB.sources).start('ai-gateway', ctxB),
    /is registered by '@fixture\/owner-a', not by '@fixture\/owner-b'/,
    'a plugin started a source it does not own'
  )
  assert.equal(victim.seen.starts, 0, 'the neighbour\'s start() ran for the squatter')
  assert.equal(victim.seen.ctx, undefined, 'the neighbour\'s start() was handed a context')

  // And the owner still gets its own source, started under its own context, on
  // the boot walk that follows activation.
  const log = makeLog()
  const fileLog = makeLog()
  const snapshots = await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })
  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state })),
    [{ name: 'ai-gateway', plugin: A, state: 'started' }],
    'the refusal cost the owner its own source'
  )
  assert.equal(victim.seen.starts, 1)
  assert.equal(victim.seen.ctx, ctxA, 'the owner was not handed its own context')
})

test('a plugin cannot stop, reload or stopAll a neighbour\'s running source', async () => {
  const { runtime, ctxA, ctxB } = stage()
  const victim = fixtureSource('aaa-victim', A)
  const own = fixtureSource('zzz-own', B)
  ctxA.sources.register(victim.contribution)
  ctxB.sources.register(own.contribution)

  const log = makeLog()
  const fileLog = makeLog()
  await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })
  assert.ok(runtime.sources.started('aaa-victim'), 'the fixture did not start both sources')
  assert.ok(runtime.sources.started('zzz-own'))

  const sourcesB = /** @type {any} */ (ctxB.sources)
  await assert.rejects(() => sourcesB.stop('aaa-victim'), /not by '@fixture\/owner-b'/)
  await assert.rejects(() => sourcesB.reload('aaa-victim', ctxB), /not by '@fixture\/owner-b'/)
  assert.ok(runtime.sources.started('aaa-victim'), 'a neighbour stopped the source')

  // `stopAll` addresses no source by name, so it is not refused: it stops the
  // caller's own started sources and leaves every neighbour running.
  await sourcesB.stopAll()
  assert.ok(runtime.sources.started('aaa-victim'), 'stopAll took a neighbour down with it')
  assert.equal(runtime.sources.started('zzz-own'), undefined, 'stopAll did not stop the caller\'s own source')
})

test('a source with no recorded registrar is nobody\'s to drive through a facade', async () => {
  const { runtime, ctxA } = stage()
  // Registered straight on the registry, so `ownerOf` is undefined: the claim
  // the contribution carries is the one party that must not choose.
  const ownerless = fixtureSource('aaa', A)
  runtime.sources.register(ownerless.contribution)

  await assert.rejects(
    () => /** @type {any} */ (ctxA.sources).start('aaa', ctxA),
    /is registered by no recorded plugin, not by '@fixture\/owner-a'/
  )
  assert.equal(ownerless.seen.starts, 0)
  // A name no source was ever registered under is refused the same way.
  await assert.rejects(() => /** @type {any} */ (ctxA.sources).start('nothing', ctxA), /no recorded plugin/)
})

test('the refused lifecycle call is observable as a structured warn naming both plugins', async () => {
  const { ctxA, ctxB } = stage()
  const victim = fixtureSource('aaa', A)
  ctxA.sources.register(victim.contribution)

  const records = await recordsFrom(async () => {
    await assert.rejects(() => /** @type {any} */ (ctxB.sources).start('aaa', ctxB))
  })

  const warned = records.filter((r) => r.body === 'source.lifecycle_owner_mismatch')
  assert.equal(warned.length, 1, 'a refused lifecycle call was silent')
  assert.equal(warned[0].severityText, 'WARN')
  assert.equal(warned[0].attributes.hyp_component, 'sources')
  assert.equal(warned[0].attributes.hyp_operation, 'source.start')
  assert.equal(warned[0].attributes.error_kind, 'source_owner_mismatch')
  assert.equal(warned[0].attributes.hyp_source, 'aaa')
  assert.equal(warned[0].attributes.hyp_plugin, B, 'the warn does not say which plugin was calling')
  assert.equal(warned[0].attributes.hyp_owner_plugin, A, 'the warn does not say which plugin owns the source')
})

test('a plugin still drives its own source through the facade, the way @hypaware/otel does', async () => {
  const { runtime, ctxA } = stage()
  /** @type {{ reloads: number, stops: number }} */
  const handle = { reloads: 0, stops: 0 }
  /** @type {{ starts: number, ctx: unknown }} */
  const seen = { starts: 0, ctx: undefined }
  const own = /** @type {any} */ ({
    name: 'otlp',
    plugin: A,
    /** @param {unknown} ctx */
    async start(ctx) {
      seen.starts += 1
      seen.ctx = ctx
      return {
        async reload() { handle.reloads += 1 },
        async stop() { handle.stops += 1 },
      }
    },
  })
  const sourcesA = /** @type {any} */ (ctxA.sources)

  // `@hypaware/otel` registers and starts its listener inside `activate()`.
  ctxA.sources.register(own)
  await sourcesA.start('otlp', ctxA)
  assert.equal(seen.starts, 1, 'a plugin could not start its own source')
  assert.equal(seen.ctx, ctxA)
  assert.ok(runtime.sources.started('otlp'))

  // `@hypaware/gascity` reloads and stops its own source from its commands.
  await sourcesA.reload('otlp', ctxA)
  assert.equal(handle.reloads, 1, 'a plugin could not reload its own source')
  assert.notEqual(await sourcesA.status('otlp'), undefined, 'status stopped answering for an own source')
  await sourcesA.stop('otlp')
  assert.equal(handle.stops, 1, 'a plugin could not stop its own source')
  assert.equal(runtime.sources.started('otlp'), undefined)

  // The boot walk then reports it as a source that is simply not started yet,
  // rather than as something the refusal broke.
  const log = makeLog()
  const fileLog = makeLog()
  const snapshots = await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })
  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state })),
    [{ name: 'otlp', plugin: A, state: 'started' }]
  )
  assert.equal(seen.starts, 2)
  assert.equal(seen.ctx, ctxA)
})

test('a registry with no lifecycle members of its own does not acquire them', () => {
  // Same host registry as above, plus the binding: the bracket has something
  // to read, but there is no `start`/`stop`/`reload`/`stopAll` to shadow, so
  // the facade must not grow one. A plugin feature-detecting `typeof
  // ctx.sources.start === 'function'` still gets the truth about the registry
  // behind it.
  const inner = createSourceRegistry()
  const runtime = /** @type {any} */ ({
    sources: {
      /** @param {any} c */
      register(c) { return inner.register(c) },
      /** @param {any} p @param {() => any} fn */
      registeringAs(p, fn) { return inner.registeringAs(p, fn) },
      /** @param {string} n */
      ownerOf(n) { return inner.ownerOf(n) },
      /** @param {string} n */
      get(n) { return inner.get(n) },
      list() { return inner.list() },
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
  const sources = /** @type {any} */ (ctx.sources)
  // `get` and `list` are there because this registry has both to shadow.
  assert.deepEqual(Object.keys(sources).sort(), ['get', 'list', 'register', 'registeringAs'])
  assert.equal(sources.start, undefined, 'the facade grew a start the registry behind it does not have')
  assert.equal('stopAll' in sources, false)
  assert.equal('started' in sources, false)
  assert.equal('listStarted' in sources, false)
  // The honest surface the read-through is for is unchanged.
  assert.equal(typeof sources.list, 'function')
  assert.equal(typeof sources.ownerOf, 'function')
})

test('a plugin cannot delete or redefine the bracketed lifecycle members', () => {
  const { runtime, ctxA } = stage()
  const sources = /** @type {any} */ (ctxA.sources)
  for (const member of ['start', 'stop', 'reload', 'stopAll', 'started', 'listStarted']) {
    assert.equal(Reflect.deleteProperty(sources, member), false, `'${member}' can be deleted off the facade`)
    assert.equal(Reflect.set(sources, member, 1), false, `'${member}' can be written over on the facade`)
    assert.throws(() => Object.defineProperty(sources, member, { value: 1 }), TypeError)
    assert.notEqual(sources[member], runtime.sources[member], `'${member}' is the registry's own, unbracketed`)
  }
  // Nothing the plugin can read off the facade is the registry itself, so
  // there is no second hop to the unbracketed members either.
  for (const key of Reflect.ownKeys(sources)) {
    assert.notEqual(sources[key], runtime.sources, `the facade hands the registry out as '${String(key)}'`)
  }
})

test('a plugin cannot reach a neighbour\'s StartedSource through started or listStarted', async () => {
  // Refusing `stop(name)` by name and then handing the same handle out through
  // `started(name)` closes nothing: `started('aaa-victim').stop()` is the same
  // call one hop further along, and it runs behind the registry, which keeps
  // the source in its started map and the `hyp_sources_started` gauge ticked
  // up. The boot walk reads `started(name)` to decide a source is already
  // running, so the neighbour's row would keep reporting `started` with
  // nothing behind it.
  const { runtime, ctxA, ctxB } = stage()
  /** @type {{ stops: number, reloads: number, ctx: unknown }} */
  const handle = { stops: 0, reloads: 0, ctx: undefined }
  const victim = /** @type {any} */ ({
    name: 'aaa-victim',
    plugin: A,
    async start() {
      return {
        async stop() { handle.stops += 1 },
        /** @param {unknown} ctx */
        async reload(ctx) { handle.reloads += 1; handle.ctx = ctx },
      }
    },
  })
  const own = fixtureSource('zzz-own', B)
  ctxA.sources.register(victim)
  ctxB.sources.register(own.contribution)

  const log = makeLog()
  const fileLog = makeLog()
  await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })
  assert.ok(runtime.sources.started('aaa-victim'), 'the fixture did not start both sources')

  const sourcesB = /** @type {any} */ (ctxB.sources)
  assert.equal(sourcesB.started('aaa-victim'), undefined, 'a neighbour\'s lifecycle handle was handed out')
  assert.deepEqual(
    sourcesB.listStarted().map((/** @type {{ name: string }} */ e) => e.name),
    ['zzz-own'],
    'listStarted handed out every started source, neighbours included'
  )
  assert.equal(handle.stops, 0)
  assert.equal(handle.reloads, 0)

  // The owner still reads its own handle, and the kernel still reads every one.
  const sourcesA = /** @type {any} */ (ctxA.sources)
  assert.ok(sourcesA.started('aaa-victim'), 'a plugin lost its own started handle')
  assert.deepEqual(sourcesA.listStarted().map((/** @type {{ name: string }} */ e) => e.name), ['aaa-victim'])
  assert.deepEqual(
    runtime.sources.listStarted().map((/** @type {{ name: string }} */ e) => e.name).sort(),
    ['aaa-victim', 'zzz-own'],
    'the kernel\'s own registry lost sight of a started source'
  )
})

// Issue #1953. #1950 bracketed the lifecycle members, and the rule they land is
// that a plugin drives the lifecycle of the sources the kernel recorded it as
// registering and of no others. `get` and `list` reached around it one hop
// along: the registry stores contributions by reference and both forwarded the
// live object, so a plugin did not need `sources.start` at all. It took the
// neighbour's `start` off the contribution and called it with its own context,
// and because nothing went through the registry the start was not counted, not
// spanned, and not in `started`, so the boot walk started the real source again
// afterwards: two binds of one port, or two writers on the victim's dataset.

test('a plugin cannot start a neighbour\'s source through the contribution get() hands back', async () => {
  const { runtime, ctxA, ctxB } = stage()
  const victim = fixtureSource('ai-gateway', A)
  ctxA.sources.register(victim.contribution)

  const reached = /** @type {any} */ (ctxB.sources).get('ai-gateway')
  assert.notEqual(reached, victim.contribution, 'a neighbour was handed the registry\'s own contribution')
  await assert.rejects(
    () => reached.start(ctxB),
    /carries no live start\(\).*cannot start 'ai-gateway'/s,
    'a neighbour\'s start() ran off the contribution get() handed back'
  )
  assert.equal(victim.seen.starts, 0, 'the neighbour\'s start() ran for the squatter')
  assert.equal(victim.seen.ctx, undefined, 'the neighbour\'s start() was handed a context')

  // And the owner still gets its own source, started once, under its own
  // context, on the boot walk that follows activation.
  const log = makeLog()
  const fileLog = makeLog()
  const snapshots = await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })
  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state })),
    [{ name: 'ai-gateway', plugin: A, state: 'started' }],
    'the narrowing cost the owner its own source'
  )
  assert.equal(victim.seen.starts, 1, 'the source did not start exactly once')
  assert.equal(victim.seen.ctx, ctxA, 'the owner was not handed its own context')
})

test('list() is the same reach without needing the name, and is narrowed too', async () => {
  const { runtime, ctxA, ctxB } = stage()
  const victim = fixtureSource('ai-gateway', A)
  ctxA.sources.register(victim.contribution)

  const listed = /** @type {any[]} */ (/** @type {any} */ (ctxB.sources).list())
  assert.equal(listed.length, 1, 'list() stopped answering with the registered set')
  assert.notEqual(listed[0], victim.contribution, 'list() handed out the registry\'s own contribution')
  await assert.rejects(() => listed[0].start(ctxB), /carries no live start\(\)/)
  assert.equal(victim.seen.starts, 0, 'the neighbour\'s start() ran off a list() entry')

  const log = makeLog()
  const fileLog = makeLog()
  await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })
  assert.equal(victim.seen.starts, 1)
  assert.equal(victim.seen.ctx, ctxA)
})

// Round 2 of the same review. Hiding `start` behind a refusal is only half of
// it while the object it sits on is writable: assigning over `.start` put the
// squatter's own function on the contribution the daemon's boot walk calls, so
// the squatter ran under the *victim's* real context rather than dragging the
// victim into its own.
test('a plugin cannot write its own start() onto a neighbour\'s contribution', async () => {
  const { runtime, ctxA, ctxB } = stage()
  const victim = fixtureSource('ai-gateway', A)
  ctxA.sources.register(victim.contribution)
  /** @type {unknown} */
  let hijacked
  /** @param {unknown} ctx */
  const squatterStart = async (ctx) => { hijacked = ctx; return { async stop() {} } }

  for (const reached of [
    /** @type {any} */ (ctxB.sources).get('ai-gateway'),
    /** @type {any} */ (ctxB.sources).list()[0],
  ]) {
    assert.throws(() => { 'use strict'; reached.start = squatterStart }, TypeError)
    assert.equal(Reflect.set(reached, 'start', squatterStart), false)
    assert.equal(Reflect.defineProperty(reached, 'start', { value: squatterStart }), false)
    assert.equal(Reflect.deleteProperty(reached, 'start'), false)
    // Not only `start`: nothing on the view is the plugin's to move, and the
    // prototype is not a second way to reach the contribution's own `start`.
    assert.equal(Reflect.set(reached, 'plugin', B), false)
    assert.equal(Reflect.setPrototypeOf(reached, { start: squatterStart }), false)
    assert.equal(Object.getPrototypeOf(reached), null)
    assert.notEqual(victim.contribution.start, squatterStart, 'the write reached the live contribution')
  }

  const log = makeLog()
  const fileLog = makeLog()
  const snapshots = await startConfiguredSources({
    runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })
  assert.equal(hijacked, undefined, 'the boot walk ran the squatter\'s function under the victim\'s context')
  assert.equal(victim.seen.starts, 1, 'the victim\'s own start() did not run')
  assert.equal(victim.seen.ctx, ctxA)
  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state })),
    [{ name: 'ai-gateway', plugin: A, state: 'started' }]
  )
})

test('a class-supplied start() is not reachable through the view either', () => {
  const { ctxA, ctxB } = stage()
  /** @type {unknown} */
  let seenCtx
  // The shape the plugin doctor keeps a whole stand-in honest about: a
  // contribution whose fields, `start` included, come from its prototype.
  class ClassSource {
    get name() { return 'ai-gateway' }
    get plugin() { return A }
    get summary() { return 'a class instance' }
    /** @param {unknown} ctx */
    async start(ctx) { seenCtx = ctx; return { async stop() {} } }
  }
  ctxA.sources.register(/** @type {any} */ (new ClassSource()))

  const reached = /** @type {any} */ (ctxB.sources).get('ai-gateway')
  // The declarative fields the prototype supplies still read through.
  assert.equal(reached.name, 'ai-gateway')
  assert.equal(reached.plugin, A)
  assert.equal(reached.summary, 'a class instance')
  assert.equal(Object.getPrototypeOf(reached), null, 'the view handed back the contribution\'s prototype')
  assert.equal(seenCtx, undefined)
})

test('the narrowed contribution still reads as the contract declares one', () => {
  const { ctxA, ctxB } = stage()
  const victim = /** @type {any} */ ({
    name: 'ai-gateway',
    plugin: A,
    summary: 'the gateway',
    configSection: 'ai_gateway',
    async start() { return { async stop() {} } },
  })
  ctxA.sources.register(victim)

  const reached = /** @type {any} */ (ctxB.sources).get('ai-gateway')
  assert.deepEqual(
    { ...reached, start: typeof reached.start },
    { name: 'ai-gateway', plugin: A, summary: 'the gateway', configSection: 'ai_gateway', start: 'function' },
    'a plugin reading the declared shape no longer finds it'
  )
  assert.deepEqual(Object.keys(reached), ['name', 'plugin', 'summary', 'configSection', 'start'])
  assert.ok('start' in reached)
  assert.ok('summary' in reached)
  // Nothing outside the declared surface, so a second entry point a
  // contribution carries of its own is not passed on with it.
  assert.equal(reached.somethingElse, undefined)
  assert.equal('somethingElse' in reached, false)

  // One view per contribution, so a plugin keying a `Set` or a `Map` by what
  // it read, or comparing two reads, sees the identity the live object gave it.
  assert.equal(reached, /** @type {any} */ (ctxB.sources).get('ai-gateway'))
  assert.equal(reached, /** @type {any} */ (ctxB.sources).list()[0])
})

test('the refused contribution start is observable as a structured warn', async () => {
  const { ctxA, ctxB } = stage()
  ctxA.sources.register(fixtureSource('aaa', A).contribution)

  const records = await recordsFrom(async () => {
    await assert.rejects(() => /** @type {any} */ (ctxB.sources).get('aaa').start(ctxB))
  })

  const warned = records.filter((r) => r.body === 'source.contribution_start_denied')
  assert.equal(warned.length, 1, 'a refused contribution start was silent')
  assert.equal(warned[0].severityText, 'WARN')
  assert.equal(warned[0].attributes.hyp_component, 'sources')
  assert.equal(warned[0].attributes.hyp_operation, 'source.start')
  assert.equal(warned[0].attributes.error_kind, 'source_contribution_start_denied')
  assert.equal(warned[0].attributes.hyp_source, 'aaa')
  assert.equal(warned[0].attributes.hyp_plugin, B, 'the warn does not say which plugin was calling')
})

test('a plugin reads its own contribution back exactly as it registered it', async () => {
  const { runtime, ctxA, ctxB } = stage()
  const own = fixtureSource('aaa-own', A)
  const neighbour = fixtureSource('zzz-neighbour', B)
  ctxA.sources.register(own.contribution)
  ctxB.sources.register(neighbour.contribution)

  const sourcesA = /** @type {any} */ (ctxA.sources)
  assert.equal(sourcesA.get('aaa-own'), own.contribution, 'a plugin lost its own contribution')
  assert.equal(sourcesA.get('zzz-neighbour').name, 'zzz-neighbour', 'a neighbour fell out of get()')
  assert.equal(sourcesA.get('nothing-registered'), undefined, 'an unknown name stopped answering undefined')

  // `list()` keeps every source and the registry's order, which is what the
  // plugin doctor's report and a plugin's own introspection read it for.
  assert.deepEqual(
    sourcesA.list().map((/** @type {any} */ c) => c.name),
    ['aaa-own', 'zzz-neighbour'],
    'list() lost a source or its order'
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
      { name: 'aaa-own', plugin: A, state: 'started' },
      { name: 'zzz-neighbour', plugin: B, state: 'started' },
    ]
  )
  assert.equal(own.seen.ctx, ctxA)
  assert.equal(neighbour.seen.ctx, ctxB)
})

test('a hostile name accessor cannot throw out of the refusal refusing it', async () => {
  const { ctxA, ctxB } = stage()
  const victim = fixtureSource('aaa', A)
  ctxA.sources.register(victim.contribution)
  // Registered under a name the registry validated, then turned into an
  // accessor that raises. The refusal has to arrive as itself.
  beHostile(victim.contribution, { get name() { throw new Error('hostile name') } })

  const reached = /** @type {any} */ (ctxB.sources).get('aaa')
  await assert.rejects(() => reached.start(ctxB), /carries no live start\(\)/)
  assert.equal(victim.seen.starts, 0)
})
