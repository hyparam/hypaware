// @ts-check

import fs from 'node:fs/promises'

import { atomicWriteJson } from '../util/fs_atomic.js'
import { pluginLockPath } from './paths.js'

/**
 * @import { PluginLockEntry, PluginLockFile, PluginName } from '../../../hypaware-plugin-kernel-types.js'
 */

const SCHEMA_VERSION = 1

/** @returns {PluginLockFile} */
export function emptyLock() {
  return { schema_version: SCHEMA_VERSION, plugins: {} }
}

/**
 * Load `plugin-lock.json` from the state directory. A missing file is
 * not an error: callers get an empty lock back. A malformed file is
 * an error: we refuse to silently drop entries the user thinks are
 * installed.
 *
 * @param {string} stateDir
 * @returns {Promise<PluginLockFile>}
 */
export async function readLock(stateDir) {
  const lockPath = pluginLockPath(stateDir)
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(lockPath, 'utf8')
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return emptyLock()
    }
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`plugin-lock.json is not valid JSON: ${message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('plugin-lock.json must be a JSON object')
  }
  const candidate = /** @type {Record<string, unknown>} */ (parsed)
  if (candidate.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `plugin-lock.json has unsupported schema_version ${String(candidate.schema_version)}`
    )
  }
  if (!candidate.plugins || typeof candidate.plugins !== 'object' || Array.isArray(candidate.plugins)) {
    throw new Error('plugin-lock.json plugins must be an object')
  }
  return /** @type {PluginLockFile} */ ({
    schema_version: SCHEMA_VERSION,
    plugins: /** @type {Record<PluginName, PluginLockEntry>} */ (candidate.plugins),
  })
}

/**
 * Write the lock file atomically. The file is created with stable key
 * order (plugin names sorted) so diffs stay reviewable.
 *
 * @param {string} stateDir
 * @param {PluginLockFile} lock
 */
export async function writeLock(stateDir, lock) {
  const lockPath = pluginLockPath(stateDir)
  await atomicWriteJson(lockPath, normalizeLock(lock))
}

/**
 * Return a new lock with `entry` upserted under its plugin name.
 *
 * @param {PluginLockFile} lock
 * @param {PluginLockEntry} entry
 * @returns {PluginLockFile}
 */
export function upsertEntry(lock, entry) {
  return {
    schema_version: SCHEMA_VERSION,
    plugins: { ...lock.plugins, [entry.name]: entry },
  }
}

/**
 * Return a new lock with `name` removed.
 *
 * @param {PluginLockFile} lock
 * @param {PluginName} name
 * @returns {PluginLockFile}
 */
export function removeEntry(lock, name) {
  if (!Object.hasOwn(lock.plugins, name)) return lock
  const next = { ...lock.plugins }
  delete next[name]
  return { schema_version: SCHEMA_VERSION, plugins: next }
}

/**
 * Look up an entry by exact plugin name.
 *
 * @param {PluginLockFile} lock
 * @param {PluginName} name
 * @returns {PluginLockEntry | undefined}
 */
export function getEntry(lock, name) {
  // `Object.hasOwn`, not a bare lookup: `plugins` is a plain object parsed
  // from `plugin-lock.json`, so an operator-typed name that is an
  // `Object.prototype` member would otherwise come back as the inherited
  // function and read as an install record (issue #1601).
  return Object.hasOwn(lock.plugins, name) ? lock.plugins[name] : undefined
}

/** @param {PluginLockFile} lock */
export function listEntries(lock) {
  return Object.keys(lock.plugins).sort().map((name) => lock.plugins[name])
}

/** @param {PluginLockFile} lock */
function normalizeLock(lock) {
  // `Object.fromEntries`, not `sorted[name] = ...` into a `{}`: a bracket
  // assignment of '__proto__' runs Object.prototype's setter instead of adding
  // an own key, so a plugin by that name vanished from the file it had just
  // been installed into, leaving its directory on disk and no row for `list`,
  // `info` or `remove` to reach. Nothing rejects the name on the way in:
  // the manifest asks only for a non-empty string, and a local-dir source
  // carries none to cross-check it against. `fromEntries` defines own
  // properties, so the write side answers as the reads above now do (#1601).
  /** @type {Record<string, PluginLockEntry>} */
  const sorted = Object.fromEntries(
    Object.keys(lock.plugins).sort().map((name) => [name, lock.plugins[name]])
  )
  return { schema_version: SCHEMA_VERSION, plugins: sorted }
}
