// @ts-check

import path from 'node:path'

import { isWithinDir } from '../runtime/contribution_names.js'

/**
 * Layout helpers for the plugin install root. Everything lives under
 * the kernel state directory (`<HYP_HOME>/hypaware`):
 *
 *   <state>/plugins/<plugin-name>/   installed artifact tree
 *   <state>/plugin-lock.json         lock file
 *
 * Scoped plugin names (`@hypaware/dummy-a`) preserve their slash on
 * disk to match the npm-scoped convention also used by `runtime/paths.js`
 * for per-plugin state.
 */

const PLUGIN_LOCK_BASENAME = 'plugin-lock.json'
const PLUGIN_INSTALL_SUBDIR = 'plugins'

/**
 * @param {string} stateDir
 * @param {string} name plugin name (may include `@scope/`)
 */
export function pluginInstallDir(stateDir, name) {
  return path.join(stateDir, PLUGIN_INSTALL_SUBDIR, name)
}

/**
 * True when `name` derives an install directory strictly beneath the
 * plugin install root.
 *
 * `name` is third-party manifest text that both fetchers interpolate
 * into `pluginInstallDir` and then destroy whatever sits at: a name of
 * `../../victim` deletes a directory two levels above the plugins
 * root. Equality with the root is refused as well as escape: a name of
 * `.` resolves to the root itself and would take every installed
 * plugin with it. A name that normalizes back inside (`a/../b`) passes,
 * because it installs where every later lookup of that name also goes.
 *
 * @param {string} stateDir
 * @param {string} name plugin name from the manifest
 * @ref LLP 0007#install-root-and-lock-file [constrained-by]: the install root is
 *   `<state>/plugins/<plugin-name>/`, so that is the boundary a derived path
 *   must stay inside, not the state dir it sits in
 */
export function installDirIsContained(stateDir, name) {
  const root = path.join(stateDir, PLUGIN_INSTALL_SUBDIR)
  const dir = pluginInstallDir(stateDir, name)
  return path.resolve(dir) !== path.resolve(root) && isWithinDir(dir, root)
}

/** @param {string} stateDir */
export function pluginLockPath(stateDir) {
  return path.join(stateDir, PLUGIN_LOCK_BASENAME)
}
