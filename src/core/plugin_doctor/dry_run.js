// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createActivationContext, createKernelRuntime } from '../runtime/activation.js'
import { createCommandRegistry } from '../registry/commands.js'
import { createVerbRegistry } from '../registry/verbs.js'
import { createPluginPaths } from '../runtime/paths.js'
import { createSourceRegistry } from '../registry/sources.js'

/**
 * @import { ActivePlugin, PluginManifest, SourceContribution, StartedSource } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedSinkRegistry, ExtendedSourceRegistry } from '../../../src/core/registry/types.js'
 * @import { DryRunResult, RegisteredSnapshot } from '../../../src/core/plugin_doctor/types.js'
 */

const DRY_RUN_ID = 'doctor-dryrun'

// Provider name used when pre-seeding capabilities other plugins would
// supply at runtime. Filtered back out of the snapshot so these stubs
// never count as contributions of the plugin under test.
const STUB_PROVIDER = '@doctor/stub-provider'

/**
 * Activate a single plugin in isolation so the doctor can see what its
 * `activate()` actually registers. Unlike the kernel loader
 * (`src/core/runtime/loader.js`), this:
 *
 * - builds a throwaway `KernelRuntime`, so registrations never touch the
 *   live kernel;
 * - roots all plugin paths in a fresh `mkdtemp` directory that is
 *   removed before returning, and points `ctx.env.HYP_HOME` at that same
 *   directory, so no state leaks into the caller's `<HYP_HOME>`;
 * - hands the plugin a source registry whose `start()` never runs the
 *   contribution. `@hypaware/otel` starts its own OTLP source from
 *   `activate()`, which binds a real port; a diagnostic pass must not
 *   take one, and it has no bearing on what the plugin registers;
 * - passes an empty config. A well-behaved plugin registers its
 *   contributions during `activate()` and defers config reads to
 *   `start()`/`create()`. A plugin that throws on missing config at
 *   activation surfaces as `activate_threw`, which is itself a finding;
 * - pre-seeds the capability registry with stub providers for every
 *   capability a bundled/installed plugin offers, so a plugin that calls
 *   `ctx.requireCapability()` during `activate()` resolves the handle
 *   instead of false-failing as `activate_threw`.
 *
 * Trust boundary: this is NOT a security sandbox. The entrypoint is
 * imported and `activate()` is run in-process with the real environment;
 * only `ctx.paths` (state/cache/temp) is isolated to a throwaway dir.
 * Run the doctor only on plugin code you trust, same as installing it.
 *
 * Import or activation failures are captured (never thrown) so the
 * doctor can report them alongside the static checks.
 *
 * Note: the entrypoint is loaded with dynamic `import()`, which caches
 * by resolved URL. Each CLI invocation is a fresh process so this never
 * bites in normal use; within one long-lived process (tests/smokes),
 * re-doctoring the *same* path returns the first-loaded module. Point
 * such callers at distinct directories.
 *
 * @param {PluginManifest} manifest
 * @param {string} rootDir Absolute path to the plugin directory.
 * @param {{ knownCapabilities?: Map<string, string[]> }} [opts]
 *   `knownCapabilities` maps a capability name to the versions other
 *   plugins provide; each is pre-seeded as a stub so `requireCapability`
 *   resolves during the dry run.
 * @returns {Promise<DryRunResult>}
 */
export async function dryRunActivate(manifest, rootDir, opts = {}) {
  const knownCapabilities = opts.knownCapabilities ?? new Map()
  const snapshot = emptySnapshot()
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-doctor-'))
  try {
    // Empty verb registry (no core verbs), so the kernel-projected
    // `query sql` command never counts as a contribution of the plugin
    // under test. The plugin's own `ctx.verbs.register` still projects its
    // commands into this registry, so a plugin that contributes a verb is
    // diagnosed exactly like one that contributes a command.
    const commandRegistry = createCommandRegistry()
    const runtime = createKernelRuntime({
      cacheRoot: path.join(tmpRoot, 'cache'),
      commandRegistry,
      verbRegistry: createVerbRegistry({ commandRegistry }),
      sourceRegistry: inertSourceRegistry(),
    })
    for (const [name, versions] of knownCapabilities) {
      for (const version of versions) {
        runtime.capabilities.provide(STUB_PROVIDER, name, version, capabilityStub())
      }
    }
    const paths = await createPluginPaths({
      pluginName: manifest.name,
      rootDir,
      stateRoot: tmpRoot,
      runId: DRY_RUN_ID,
      tmpRoot,
    })
    /** @type {ActivePlugin} */
    const plugin = { name: manifest.name, version: manifest.version, manifest, rootDir }
    // `ctx.env` defaults to `process.env`, which points a plugin that reads
    // `HYP_HOME` during `activate()` at the caller's real install:
    // `@hypaware/local-fs` mkdirs `<HYP_HOME>/exports` from `activate()`, so
    // merely diagnosing it wrote into the home directory this function
    // promises not to touch. Redirect `HYP_HOME` at the throwaway root the
    // rest of the dry run already uses. The rest of the environment is passed
    // through: this is a diagnostic, not a sandbox (see the trust boundary
    // above), and a plugin that reads `PATH` should see what it would see for
    // real.
    const env = { ...process.env, HYP_HOME: tmpRoot }
    const ctx = createActivationContext({ runtime, plugin, paths, config: {}, env })

    const entrypointAbs = path.resolve(rootDir, manifest.entrypoint)
    let mod
    try {
      mod = await import(pathToFileURL(entrypointAbs).href)
    } catch (err) {
      return { ok: false, error: { kind: 'entrypoint_import_failed', message: describe(err) }, registered: snapshot }
    }

    if (typeof mod.activate !== 'function') {
      return {
        ok: false,
        error: {
          kind: 'activate_missing',
          message: `entrypoint '${manifest.entrypoint}' does not export an activate() function`,
        },
        registered: snapshot,
      }
    }

    try {
      await mod.activate(ctx)
    } catch (err) {
      // Snapshot whatever registered before the throw. Partial output
      // still helps locate the failing registration.
      return {
        ok: false,
        error: { kind: 'activate_threw', message: describe(err) },
        registered: snapshotRegistry(runtime, commandRegistry),
      }
    }

    return { ok: true, registered: snapshotRegistry(runtime, commandRegistry) }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Read the registered names out of a kernel runtime after activation.
 * Sinks are read from `listContributions()` (a dry-run `register()` adds
 * a contribution, not a materialized handle). Pre-seeded stub
 * capabilities are excluded so only what the plugin itself provided
 * shows up.
 *
 * @param {ReturnType<typeof createKernelRuntime>} runtime
 * @param {ReturnType<typeof createCommandRegistry>} commandRegistry
 *   The same registry `runtime` was built over. Passed separately because
 *   group descriptions are not commands, so `KernelRuntime.commands` (the
 *   plugin-facing `CommandRegistry`) does not expose `listGroups`.
 * @returns {RegisteredSnapshot}
 */
function snapshotRegistry(runtime, commandRegistry) {
  const sinks = /** @type {ExtendedSinkRegistry} */ (runtime.sinks)
  const commands = commandRegistry.list()
  const groups = commandRegistry.listGroups()
  return {
    sources: runtime.sources.list().map((c) => c.name),
    sinks: sinks.listContributions().map((e) => e.contribution.name),
    datasets: runtime.query.listDatasets().map((d) => d.name),
    commands: commands.map((c) => c.name),
    commandDetails: commands.map((c) => ({ name: c.name, summary: c.summary, hidden: c.hidden === true })),
    commandGroups: groups.map((g) => ({ name: g.name, ...(g.summary !== undefined ? { summary: g.summary } : {}) })),
    skills: runtime.skills.list().map((s) => s.name),
    agents: runtime.agents.list().map((a) => a.name),
    init_presets: runtime.initPresets.list().map((p) => p.name),
    capabilities: runtime.capabilities
      .list()
      .filter((c) => c.provider !== STUB_PROVIDER)
      .map((c) => c.name),
  }
}


/**
 * A source registry that records registrations but refuses to run them.
 * A plugin may start one of its own sources from `activate()` (see
 * `@hypaware/otel`, which binds the OTLP listener there), and the doctor
 * only ever reads back `list()`. Running the real `start()` would bind
 * ports and open files on behalf of a plugin the caller is merely
 * inspecting, and would fail outright on a host where the daemon already
 * holds the port.
 *
 * @ref LLP 0267#d4 [implements]: diagnosing a plugin must not take a port on its behalf
 * @returns {ExtendedSourceRegistry}
 */
function inertSourceRegistry() {
  const registry = createSourceRegistry()
  return {
    ...registry,
    /** @param {SourceContribution} contribution */
    register(contribution) {
      // Neutered at registration, not by overriding `start`. The registry
      // records the started handle in a map it closes over, so an override
      // that returned its own handle left `reload`/`status`/`started`
      // believing the source never started: a plugin that starts one of its
      // own sources from `activate()` and then reloads it would fail its dry
      // run as `activate_threw` under a kernel where it works. Routing the
      // no-op through the real `register` keeps the whole lifecycle
      // bookkeeping intact and runs nothing.
      //
      // A malformed contribution is passed through untouched so the real
      // `register` still rejects it: a source missing `start()` is a finding
      // about the plugin, not something the doctor should paper over.
      //
      // The stand-in delegates rather than copying. The guard below reads
      // `start` through the prototype chain while a spread carries own
      // enumerable properties and nothing else, so the two disagreed on a
      // contribution that is a class instance: what reached the real
      // `register` had lost whatever `name`, `plugin`, or `configSection`
      // the class supplies from its prototype, and the doctor reported a
      // fabricated `activate_threw` about a missing name against a plugin
      // the kernel registers and starts without complaint. Validating one
      // object and storing another is the same defect
      // `src/core/registry/commands.js` fixed by copying before it checks;
      // this registry stores by reference, so the fix here is the opposite
      // direction: hand it something that reads like the contribution rather
      // than a flattened copy of it.
      if (contribution && typeof contribution === 'object' && typeof contribution.start === 'function') {
        registry.register(neuter(contribution))
        return
      }
      registry.register(contribution)
    },
  }
}

/**
 * Wrap a source contribution so the registry stores the contribution it was
 * handed, minus a live `start()`. Every read but `start` forwards to the
 * original with the original as the receiver, so inherited fields, accessors,
 * and private state answer exactly as they do under the real kernel, and
 * neutering writes nothing to the plugin's own object. It does not make that
 * object read-only: a write, a define, and a delete through the stand-in all
 * reach the contribution, because the real registry hands the contribution out
 * by reference and does not shield it either.
 *
 * @param {SourceContribution} contribution
 * @returns {SourceContribution}
 */
function neuter(contribution) {
  /**
   * @param {SourceContribution} _target
   * @param {string | symbol} prop
   */
  function get(_target, prop) {
    if (prop === 'start') return inertStart
    // The receiver is the contribution, not the proxy, so an accessor that
    // reads a private field off `this` still finds it.
    return Reflect.get(contribution, prop, contribution)
  }

  // A proxy may not answer a non-writable, non-configurable own property with
  // anything but the target's real value, so a contribution holding its own
  // `start` frozen cannot have it shadowed: the read inside `register` throws,
  // and the doctor reports the fabricated `activate_threw` this stand-in
  // exists to avoid, against a plugin the real registry accepts. Freezing a
  // registered object is ordinary defensive style, so in that case proxy an
  // empty object that inherits from the contribution. Reads resolve off the
  // contribution itself either way.
  const own = Object.getOwnPropertyDescriptor(contribution, 'start')
  const frozenStart = own !== undefined && own.writable === false && own.configurable === false
  if (!frozenStart) return new Proxy(contribution, { get })

  // That inheriting target has no own properties and a prototype of its own,
  // so the remaining traps exist to hide it: without them the stored
  // contribution enumerates as `{}` and reports the wrong prototype, which is
  // the same store-a-different-shape defect this stand-in exists to close.
  // `start` is reported as the inert function the `get` trap already answers
  // with, and a descriptor is reported configurable unless `defineProperty`
  // pinned that property onto the target, because otherwise the target holds
  // no non-configurable property to pin one to.
  return new Proxy(Object.create(contribution), {
    get,
    ownKeys: () => Reflect.ownKeys(contribution),
    /**
     * @param {object} target
     * @param {string | symbol} prop
     */
    getOwnPropertyDescriptor(target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(contribution, prop)
      if (desc === undefined) return undefined
      const shown = prop === 'start' ? { ...desc, value: inertStart } : desc
      const pinned = Reflect.getOwnPropertyDescriptor(target, prop)
      if (pinned !== undefined && pinned.configurable === false) return shown
      return { ...shown, configurable: true }
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(contribution),
    /**
     * @param {object} target
     * @param {string | symbol} prop
     * @param {PropertyDescriptor} desc
     */
    defineProperty(target, prop, desc) {
      // The define has to reach the contribution: that is the object the real
      // registry stores and hands back, and the one every read here answers
      // from. Untrapped it landed on the inheriting target alone, so it
      // succeeded while the `get` trap kept answering from a contribution
      // that never got the property, and the next read of that property threw
      // the proxy invariant: the fabricated `activate_threw` this stand-in
      // exists to prevent. Forwarding first also keeps a define the kernel
      // refuses, on a contribution frozen whole, refused here.
      if (!Reflect.defineProperty(contribution, prop, desc)) return false
      // Then mirror what the contribution ended up with, because a
      // non-configurable define may only be reported as having succeeded when
      // the target carries that property too. `start` mirrors the inert value
      // the `get` trap answers with, so pinning it cannot leave the next read
      // disagreeing with the target.
      const applied = /** @type {PropertyDescriptor} */ (Reflect.getOwnPropertyDescriptor(contribution, prop))
      Reflect.defineProperty(target, prop, prop === 'start' ? { ...applied, value: inertStart } : applied)
      return true
    },
    /**
     * @param {object} target
     * @param {string | symbol} prop
     */
    deleteProperty(target, prop) {
      // Symmetrically: the kernel removes the property from the contribution,
      // or refuses to, where the untrapped trap silently no-opped against a
      // target that never held it.
      if (!Reflect.deleteProperty(contribution, prop)) return false
      Reflect.deleteProperty(target, prop)
      return true
    },
    /**
     * @param {object} _target
     * @param {string | symbol} prop
     * @param {unknown} value
     */
    set: (_target, prop, value) => Reflect.set(contribution, prop, value),
  })
}

/**
 * The `start()` every source gets under a dry run: it runs none of the
 * plugin's own start logic and hands back the minimal `StartedSource` the
 * registry requires. `reload`/`status` are deliberately absent, so the
 * registry takes its documented unsupported-reload and default-status paths
 * rather than reporting a behavior the real source may not have.
 *
 * @returns {Promise<StartedSource>}
 */
async function inertStart() {
  return { async stop() {} }
}

/**
 * A permissive no-op stand-in for a capability handle that another
 * plugin would normally provide. Real adapters (e.g. `@hypaware/claude`)
 * call methods on the handle *during* `activate()`, such as
 * `gateway.registerUpstreamPreset(...)` and `registerClient(...)`. A plain
 * object would throw on the first such call and abort activation before
 * the plugin registers its own contributions. This Proxy answers every
 * property access (and call) with itself, so activation runs to
 * completion and the declared-vs-registered diff stays meaningful. It
 * deliberately does NOT model real behavior. The doctor only checks
 * what the plugin registers via `ctx.*`, not what it does with a
 * capability it requires.
 *
 * @returns {unknown}
 */
function capabilityStub() {
  const target = function () {}
  /** @type {ProxyHandler<typeof target>} */
  const handler = {
    get(_t, prop) {
      // Don't masquerade as a thenable, or `await handle` would hang.
      if (prop === 'then') return undefined
      // Nor as something unprintable. A plugin that puts a value read off
      // the handle into a log attribute (`embed_model: embedder.model`)
      // reaches `String()`, and a proxy answering `Symbol.toPrimitive`,
      // `valueOf`, and `toString` with itself never yields a primitive, so
      // the conversion throws. The doctor would then report `activate_threw`
      // against a plugin whose only fault was logging what the stub returned.
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return describeStub
      return proxy
    },
    apply() { return proxy },
    construct() { return proxy },
  }
  const proxy = new Proxy(target, handler)
  return proxy
}

/** @returns {string} */
function describeStub() {
  return '[doctor capability stub]'
}

/** @returns {RegisteredSnapshot} */
function emptySnapshot() {
  return {
    sources: [],
    sinks: [],
    datasets: [],
    commands: [],
    commandDetails: [],
    commandGroups: [],
    skills: [],
    agents: [],
    init_presets: [],
    capabilities: [],
  }
}

/** @param {unknown} err */
function describe(err) {
  if (err instanceof Error) {
    const head = err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : err.message
    return head
  }
  return String(err)
}
