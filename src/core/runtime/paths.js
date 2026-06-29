// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * @import { PluginName, PluginPaths } from '../../../collectivus-plugin-kernel-types.js'
 */

/**
 * Build a per-plugin `PluginPaths` bag. The kernel hands one of these
 * to every plugin during activation; the directories are stable across
 * boots (state/cache) or scoped to the current boot (temp).
 *
 * Per LLP 0004#state-directories:
 * - `rootDir`  the plugin's installed directory (where the manifest lives).
 * - `stateDir` `<state>/plugins/<name>` (durable per-plugin state).
 * - `cacheDir` `<state>/cache/plugins/<name>` (derivable per-plugin cache).
 * - `tempDir`  `<os-tmp>/<name>-<run-id>` (ephemeral per-boot scratch).
 *
 * Plugin names may contain a scope (`@hypaware/dummy-a`). The kernel
 * preserves the literal name in state/cache layouts (matching the npm
 * scoped-package convention) and sanitizes the temp dir slash because
 * it is single-purpose and not user-facing.
 *
 * Directories are created eagerly so plugins can write immediately
 * inside `activate(ctx)` without an mkdir dance.
 */

/**
 * Resolve the four standard plugin directories and create them on disk.
 *
 * @param {object} args
 * @param {PluginName} args.pluginName  Manifest `name`.
 * @param {string}     args.rootDir     Plugin installation root.
 * @param {string}     args.stateRoot   Kernel state root (e.g. `<HYP_HOME>/hypaware`).
 * @param {string}     args.runId       Kernel boot identifier (DEV_RUN_ID or similar).
 * @param {string}     [args.tmpRoot]   Override the OS temp root (tests).
 * @returns {Promise<PluginPaths>}
 * @ref LLP 0004#state-directories [implements]: kernel-owned scoped per-plugin dirs; plugins never reach into each other's
 */
export async function createPluginPaths({ pluginName, rootDir, stateRoot, runId, tmpRoot }) {
  if (!pluginName) throw new Error('createPluginPaths: pluginName is required')
  if (!rootDir) throw new Error('createPluginPaths: rootDir is required')
  if (!stateRoot) throw new Error('createPluginPaths: stateRoot is required')
  if (!runId) throw new Error('createPluginPaths: runId is required')

  const stateDir = path.join(stateRoot, 'plugins', pluginName)
  const cacheDir = path.join(stateRoot, 'cache', 'plugins', pluginName)
  const tempBase = tmpRoot ?? os.tmpdir()
  const tempDir = path.join(tempBase, `${sanitizeTempSegment(pluginName)}-${runId}`)

  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(cacheDir, { recursive: true }),
    fs.mkdir(tempDir, { recursive: true }),
  ])

  return { rootDir, stateDir, cacheDir, tempDir }
}

/**
 * Collapse a plugin name into a single filesystem segment. `/` becomes
 * `__` so a scoped plugin's temp dir is one directory rather than a
 * nested tree; characters outside `[A-Za-z0-9._@-]` get replaced with
 * `_` to keep the result safe on every platform we run on.
 *
 * @param {string} name
 */
function sanitizeTempSegment(name) {
  return name.replace(/\//g, '__').replace(/[^A-Za-z0-9._@-]/g, '_')
}
