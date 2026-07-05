// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createActivationContext, createKernelRuntime } from '../runtime/activation.js'
import { createCommandRegistry } from '../registry/commands.js'
import { createVerbRegistry } from '../registry/verbs.js'
import { createPluginPaths } from '../runtime/paths.js'

/**
 * @import { ActivePlugin, PluginManifest } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedSinkRegistry } from '../../../src/core/registry/types.js'
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
 *   removed before returning, so no state leaks into `<HYP_HOME>`;
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
    const ctx = createActivationContext({ runtime, plugin, paths, config: {} })

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
        registered: snapshotRegistry(runtime),
      }
    }

    return { ok: true, registered: snapshotRegistry(runtime) }
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
 * @returns {RegisteredSnapshot}
 */
function snapshotRegistry(runtime) {
  const sinks = /** @type {ExtendedSinkRegistry} */ (runtime.sinks)
  return {
    sources: runtime.sources.list().map((c) => c.name),
    sinks: sinks.listContributions().map((e) => e.contribution.name),
    datasets: runtime.query.listDatasets().map((d) => d.name),
    commands: runtime.commands.list().map((c) => c.name),
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
      return proxy
    },
    apply() { return proxy },
    construct() { return proxy },
  }
  const proxy = new Proxy(target, handler)
  return proxy
}

/** @returns {RegisteredSnapshot} */
function emptySnapshot() {
  return {
    sources: [],
    sinks: [],
    datasets: [],
    commands: [],
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
