// @ts-check

import path from 'node:path'

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

/** @param {string} stateDir */
export function pluginInstallRoot(stateDir) {
  return path.join(stateDir, PLUGIN_INSTALL_SUBDIR)
}

/**
 * @param {string} stateDir
 * @param {string} name plugin name (may include `@scope/`)
 */
export function pluginInstallDir(stateDir, name) {
  return path.join(stateDir, PLUGIN_INSTALL_SUBDIR, name)
}

/** @param {string} stateDir */
export function pluginLockPath(stateDir) {
  return path.join(stateDir, PLUGIN_LOCK_BASENAME)
}
