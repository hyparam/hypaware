// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createActivationContext, createKernelRuntime } from '../runtime/activation.js'
import { createPluginPaths } from '../runtime/paths.js'

/**
 * @import { ActivePlugin, PluginManifest } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedSinkRegistry } from '../registry/types.d.ts'
 * @import { DryRunResult, RegisteredSnapshot } from './types.d.ts'
 */

const DRY_RUN_ID = 'doctor-dryrun'

/**
 * Activate a single plugin in complete isolation so the doctor can see
 * what its `activate()` actually registers. Unlike the kernel loader
 * (`src/core/runtime/loader.js`), this:
 *
 * - builds a throwaway `KernelRuntime`, so registrations never touch the
 *   live kernel;
 * - roots all plugin paths in a fresh `mkdtemp` directory that is
 *   removed before returning, so no state leaks into `<HYP_HOME>`;
 * - passes an empty config — a well-behaved plugin registers its
 *   contributions during `activate()` and defers config reads to
 *   `start()`/`create()`. A plugin that throws on missing config at
 *   activation surfaces as `activate_threw`, which is itself a finding.
 *
 * Import or activation failures are captured (never thrown) so the
 * doctor can report them alongside the static checks.
 *
 * Note: the entrypoint is loaded with dynamic `import()`, which caches
 * by resolved URL. Each CLI invocation is a fresh process so this never
 * bites in normal use; within one long-lived process (tests/smokes),
 * re-doctoring the *same* path returns the first-loaded module — point
 * such callers at distinct directories.
 *
 * @param {PluginManifest} manifest
 * @param {string} rootDir Absolute path to the plugin directory.
 * @returns {Promise<DryRunResult>}
 */
export async function dryRunActivate(manifest, rootDir) {
  const snapshot = emptySnapshot()
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-doctor-'))
  try {
    const runtime = createKernelRuntime({ cacheRoot: path.join(tmpRoot, 'cache') })
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
      // Snapshot whatever registered before the throw — partial output
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
 * a contribution, not a materialized handle).
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
    init_presets: runtime.initPresets.list().map((p) => p.name),
    capabilities: runtime.capabilities.list().map((c) => c.name),
  }
}

/** @returns {RegisteredSnapshot} */
function emptySnapshot() {
  return {
    sources: [],
    sinks: [],
    datasets: [],
    commands: [],
    skills: [],
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
