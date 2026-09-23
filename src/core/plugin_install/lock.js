// @ts-check

import fs from 'node:fs/promises'

import { atomicWriteJson } from '../util/fs_atomic.js'
import { isPlainObject, stringValue } from '../util/json_util.js'
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

/**
 * True for a lock row the install surfaces can read at all: a plain object
 * carrying a non-empty `install_dir`. `plugin-lock.json` is hand-editable and
 * `readLock` validates the container and nothing inside it, so a row can be
 * `null`, a string, a number, `true`, an array, or an object with the field
 * removed, and two separate surfaces then have to decide what to do with it.
 * This is the one place that decides: `discoverInstalledPlugins` routes the
 * rest into `malformed[]` for `hyp status` to report as
 * `plugin_lock_entry_invalid`, and `partitionEntries` keeps them out of the
 * entry list the CLI renders from, so the two cannot drift apart.
 *
 * @param {unknown} entry
 * @returns {entry is PluginLockEntry}
 */
export function isUsableEntry(entry) {
  return isPlainObject(entry)
    && typeof entry.install_dir === 'string'
    && entry.install_dir.length > 0
}

/**
 * Split the lock into the entries a caller may dereference and the keys of the
 * rows it may not, both in stable name order. Callers used to get every value
 * raw, so one hand-edited row took down the whole listing (issue #1966).
 *
 * The unusable half is keys, not values, for the reason
 * `discoverInstalledPlugins` walks keys: the lock key is the name every install
 * surface indexes by, and it is the only identity a row that is not an object
 * still has.
 *
 * One clause stricter than `isUsableEntry` alone, because a renderer
 * dereferences one field the manifest walk does not: an object carrying an
 * `install_dir` and no usable `name` crashes nothing, but it printed
 * `undefined@0.1.0` and put a `--json` row with no `name` key at all in front
 * of a consumer. It has a lock key like every other unreadable row, so it is
 * reported as one.
 *
 * @param {PluginLockFile} lock
 * @returns {{ entries: PluginLockEntry[], unusable: PluginName[] }}
 */
export function partitionEntries(lock) {
  /** @type {PluginLockEntry[]} */
  const entries = []
  /** @type {PluginName[]} */
  const unusable = []
  for (const name of Object.keys(lock.plugins).sort()) {
    const entry = lock.plugins[name]
    if (isUsableEntry(entry) && stringValue(entry.name) !== undefined) entries.push(entry)
    else unusable.push(name)
  }
  return { entries, unusable }
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
