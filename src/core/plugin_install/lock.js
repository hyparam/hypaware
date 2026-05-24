// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { pluginLockPath } from './paths.js'

/**
 * @import { PluginLockEntry, PluginLockFile, PluginName } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

const SCHEMA_VERSION = 1

/** @returns {PluginLockFile} */
export function emptyLock() {
  return { schema_version: SCHEMA_VERSION, plugins: {} }
}

/**
 * Load `plugin-lock.json` from the state directory. A missing file is
 * not an error — callers get an empty lock back. A malformed file is
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
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const normalized = normalizeLock(lock)
  const tmpPath = `${lockPath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmpPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
  await fs.rename(tmpPath, lockPath)
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
  if (!(name in lock.plugins)) return lock
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
  return lock.plugins[name]
}

/** @param {PluginLockFile} lock */
export function listEntries(lock) {
  return Object.keys(lock.plugins).sort().map((name) => lock.plugins[name])
}

/** @param {PluginLockFile} lock */
function normalizeLock(lock) {
  /** @type {Record<string, PluginLockEntry>} */
  const sorted = {}
  for (const name of Object.keys(lock.plugins).sort()) {
    sorted[name] = lock.plugins[name]
  }
  return { schema_version: SCHEMA_VERSION, plugins: sorted }
}
