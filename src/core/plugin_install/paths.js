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
 * True when `name` has the shape of an install destination: one
 * unscoped segment, or exactly `@scope/name`.
 *
 * Containment alone is not enough. A bare `@scope` stays inside the
 * root but names the directory every `@scope/*` plugin lives in, so
 * installing it deletes them all. Each segment must also be literal
 * and in normal form: no `\` (a separator on Windows), no NUL, and no
 * trailing space or dot, which Windows strips and so aliases `. ` to
 * the root and `a.` to `a`. That rule also refuses `.` and `..`.
 *
 * @param {string} name
 * @ref LLP 0505#install-name-shape [implements]: install-time only; boot-time
 *   manifest validation keeps accepting what it accepted
 */
export function isInstallName(name) {
  if (typeof name !== 'string') return false
  const segments = name.split('/')
  if (segments.length === 1) {
    return !segments[0].startsWith('@') && isLiteralSegment(segments[0])
  }
  if (segments.length !== 2) return false
  const [scope, base] = segments
  return scope.startsWith('@') &&
    isLiteralSegment(scope.slice(1)) &&
    !base.startsWith('@') &&
    isLiteralSegment(base)
}

/** @param {string} segment */
function isLiteralSegment(segment) {
  return segment.length > 0 &&
    !segment.includes('\\') &&
    !segment.includes('\0') &&
    !segment.endsWith('.') &&
    !segment.endsWith(' ')
}

/**
 * True when `name` is an install name ({@link isInstallName}) and
 * derives an install directory strictly beneath the plugin install
 * root.
 *
 * `name` is third-party manifest text that both fetchers interpolate
 * into `pluginInstallDir` and then destroy whatever sits at: a name of
 * `../../victim` deletes a directory two levels above the plugins
 * root, and a name of `.` resolves to the root itself and would take
 * every installed plugin with it.
 *
 * @param {string} stateDir
 * @param {string} name plugin name from the manifest
 * @ref LLP 0007#install-root-and-lock-file [constrained-by]: the install root is
 *   `<state>/plugins/<plugin-name>/`, so that is the boundary a derived path
 *   must stay inside, not the state dir it sits in
 */
export function installDirIsContained(stateDir, name) {
  if (!isInstallName(name)) return false
  const root = path.join(stateDir, PLUGIN_INSTALL_SUBDIR)
  const dir = pluginInstallDir(stateDir, name)
  return path.resolve(dir) !== path.resolve(root) && isWithinDir(dir, root)
}

/**
 * True when `installDir` is a directory `hyp plugin remove` may delete:
 * strictly beneath the plugin install root, at a path that is itself an
 * install name. A lock row is hand-editable, and one keyed (or pointing
 * at) a bare `@scope` names the directory of every plugin under that
 * scope, so such a row is cleared without deleting anything.
 *
 * @param {string} stateDir
 * @param {string} installDir
 * @ref LLP 0505#removal [implements]: the row is still cleared; only the delete
 *   is withheld
 */
export function isRemovableInstallDir(stateDir, installDir) {
  const root = path.join(stateDir, PLUGIN_INSTALL_SUBDIR)
  if (path.resolve(installDir) === path.resolve(root) || !isWithinDir(installDir, root)) return false
  const rel = path.relative(path.resolve(root), path.resolve(installDir))
  return isInstallName(rel.split(path.sep).join('/'))
}

/** @param {string} stateDir */
export function pluginLockPath(stateDir) {
  return path.join(stateDir, PLUGIN_LOCK_BASENAME)
}
