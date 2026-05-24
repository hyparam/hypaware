// @ts-check

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  Attr,
  getKernelInstruments,
  getLogger,
  withSpan,
} from '../observability/index.js'
import { createPluginPaths } from './paths.js'
import { createActivationContext, createKernelRuntime } from './activation.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').ActivePlugin} ActivePlugin */
/** @typedef {import('../../../collectivus-plugin-kernel-types').JsonObject} JsonObject */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginManifest} PluginManifest */
/** @typedef {import('./activation.js').KernelRuntime} KernelRuntime */

/** @import { PluginActivationEntry, ActivationSuccess, ActivationFailure, ActivationResult } from './loader.d.ts' */

/**
 * Activate every plugin in `order`. The caller (typically the kernel
 * boot sequence) is responsible for opening the `kernel.boot` root
 * span; each `plugin.activate` child span lands in whatever context is
 * active when this function is called.
 *
 * Per-plugin behavior:
 * 1. Build a fresh `PluginPaths` (eagerly creates state/cache/temp dirs).
 * 2. Materialize an activation context that facades over the runtime.
 * 3. `import()` the entrypoint resolved against `rootDir`.
 * 4. Await `activate(ctx)` inside a `plugin.activate` span.
 * 5. On success, tick `hyp_plugins_loaded` with `hyp_plugin=<name>`.
 *
 * Failures are recorded as `plugin.activate_failed` logs with
 * `error_kind`; the loader continues with remaining plugins so a
 * single bad plugin does not take down the kernel boot.
 *
 * @param {object} args
 * @param {PluginActivationEntry[]} args.plugins  Activation-order entries.
 * @param {string} args.stateRoot                 Kernel state root (e.g. `<HYP_HOME>/hypaware`).
 * @param {string} args.runId                     Per-boot identifier used for tempDir naming.
 * @param {KernelRuntime} [args.runtime]          Override the kernel runtime (tests).
 * @param {string} [args.tmpRoot]                 Override the OS temp root (tests).
 * @returns {Promise<{ runtime: KernelRuntime, results: ActivationResult[] }>}
 */
export async function activatePlugins({ plugins, stateRoot, runId, runtime, tmpRoot }) {
  if (!Array.isArray(plugins)) throw new Error('activatePlugins: plugins must be an array')
  if (!stateRoot) throw new Error('activatePlugins: stateRoot is required')
  if (!runId) throw new Error('activatePlugins: runId is required')

  const kernel = runtime ?? createKernelRuntime()
  const loaderLog = getLogger('plugin-loader')
  const instruments = getKernelInstruments()

  /** @type {ActivationResult[]} */
  const results = []

  for (const entry of plugins) {
    const { manifest, rootDir, config } = entry
    /** @type {ActivePlugin} */
    const activePlugin = {
      name: manifest.name,
      version: manifest.version,
      manifest,
      rootDir,
    }

    try {
      const paths = await createPluginPaths({
        pluginName: manifest.name,
        rootDir,
        stateRoot,
        runId,
        tmpRoot,
      })
      const ctx = createActivationContext({
        runtime: kernel,
        plugin: activePlugin,
        paths,
        config,
      })

      await withSpan(
        'plugin.activate',
        {
          [Attr.OPERATION]: 'plugin.activate',
          [Attr.PLUGIN]: manifest.name,
          hyp_plugin_version: manifest.version,
          status: 'ok',
        },
        async () => {
          const entrypointAbs = path.resolve(rootDir, manifest.entrypoint)
          const mod = await import(pathToFileURL(entrypointAbs).href)
          if (typeof mod.activate !== 'function') {
            throw newActivationError(
              'activate_missing',
              `plugin '${manifest.name}' entrypoint '${manifest.entrypoint}' does not export activate()`
            )
          }
          await mod.activate(ctx)
          instruments.pluginsLoaded.add(1, { [Attr.PLUGIN]: manifest.name })
        },
        { component: 'plugin-loader' }
      )

      results.push({ ok: true, plugin: activePlugin })
    } catch (err) {
      const errorKind = /** @type {string} */ (
        (err && /** @type {{hypErrorKind?: string}} */ (err).hypErrorKind) || 'activate_failed'
      )
      const message = err instanceof Error ? err.message : String(err)
      loaderLog.error('plugin.activate_failed', {
        [Attr.PLUGIN]: manifest.name,
        [Attr.ERROR_KIND]: errorKind,
        message,
      })
      results.push({ ok: false, plugin: activePlugin, errorKind, message })
    }
  }

  return { runtime: kernel, results }
}

/**
 * @param {string} errorKind
 * @param {string} message
 */
function newActivationError(errorKind, message) {
  const err = new Error(message)
  /** @type {Error & { hypErrorKind?: string }} */ (err).hypErrorKind = errorKind
  return err
}
