// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { isWithinDir } from '../runtime/contribution_names.js'

/** @import { Stats } from 'node:fs' */

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
 * True when `hyp plugin remove` may delete `installDir` for the lock row
 * keyed `name`: the key is itself an install name whose derived
 * directory is strictly beneath the plugin install root
 * ({@link installDirIsContained}), and `installDir` is that directory.
 * Both install lanes record exactly the derived directory, so a row
 * that fails this was hand-edited. Checking the directory alone is not
 * enough: a key of `a/../b` or `trail/`, or a recorded `install_dir`
 * naming another plugin, resolves to a valid destination that belongs
 * to a different plugin, and a bare `@scope` names the directory of
 * every plugin under that scope.
 *
 * @param {string} stateDir
 * @param {string} name lock key
 * @param {string} installDir directory the row records, or the derived one
 * @ref LLP 0505#removal [implements]: the row is still cleared; only the delete
 *   is withheld
 */
export function isRemovableInstallDir(stateDir, name, installDir) {
  return installDirIsContained(stateDir, name) &&
    path.resolve(installDir) === path.resolve(pluginInstallDir(stateDir, name))
}

/**
 * Check on disk that the install destination for `name` sits where its
 * lexical path says, before anything creates, replaces or deletes it.
 * `name` must already be an install name ({@link isInstallName}).
 *
 * The plugin install root is resolved as configured, so a `HYP_HOME`
 * (or the root itself) under a symlink keeps working. Below the root,
 * a scope directory must be a real directory: a `@scope` that is a
 * symlink would steer a recursive delete, mkdir or rename outside the
 * root, or onto another scope's plugins. The destination itself may be
 * anything, including a link: both lanes and removal unlink a final
 * link rather than follow it. A component that cannot be inspected
 * (permissions, a loop) refuses. A missing component is fine, since
 * nothing below it exists to be followed.
 *
 * This is bounded work along one path (at most three stat calls), not a
 * sandbox: a hostile writer racing the check can still swap a component
 * between it and the mutation.
 *
 * @param {string} stateDir
 * @param {string} name install name
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 * @ref LLP 0508#filesystem-parent [implements]: resolve the configured root,
 *   refuse a linked or uninspectable component below it
 */
export async function checkInstallDestination(stateDir, name) {
  const root = path.join(stateDir, PLUGIN_INSTALL_SUBDIR)
  const dir = pluginInstallDir(stateDir, name)
  const below = name.includes('/') ? [path.dirname(dir), dir] : [dir]
  try {
    const rootStat = await fs.stat(root)
    if (!rootStat.isDirectory()) return { ok: false, reason: `${root} is not a directory` }
  } catch (err) {
    const code = errorCode(err)
    if (code !== 'ENOENT') return { ok: false, reason: `cannot inspect ${root} (${code})` }
    // A dangling link at the root reports ENOENT through stat too.
    try {
      await fs.lstat(root)
      return { ok: false, reason: `${root} is a symbolic link to nothing` }
    } catch (lerr) {
      const lcode = errorCode(lerr)
      return lcode === 'ENOENT' ? { ok: true } : { ok: false, reason: `cannot inspect ${root} (${lcode})` }
    }
  }
  for (const [i, component] of below.entries()) {
    /** @type {Stats} */
    let st
    try {
      st = await fs.lstat(component)
    } catch (err) {
      const code = errorCode(err)
      return code === 'ENOENT' ? { ok: true } : { ok: false, reason: `cannot inspect ${component} (${code})` }
    }
    if (i === below.length - 1) return { ok: true }
    if (st.isSymbolicLink()) return { ok: false, reason: `${component} is a symbolic link` }
    if (!st.isDirectory()) return { ok: false, reason: `${component} is not a directory` }
  }
  return { ok: true }
}

/** @param {unknown} err */
function errorCode(err) {
  return /** @type {NodeJS.ErrnoException} */ (err)?.code ?? 'unknown'
}

/** @param {string} stateDir */
export function pluginLockPath(stateDir) {
  return path.join(stateDir, PLUGIN_LOCK_BASENAME)
}
