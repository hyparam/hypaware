// @ts-check

import { createHash, randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteJson, readJsonIfExists } from '../../../../src/core/util/fs_atomic.js'

/**
 * @import { Dirent } from 'node:fs'
 * @import { ReplicaRecord } from '../../../../hypaware-core/plugins-workspace/graph-cache/src/types.js'
 */

/**
 * On-disk home of the team graph replicas, under the plugin's own state
 * directory (never the cache, never a dataset):
 *
 *   replicas/<key>/
 *     replica.json                   the record: target, origin, org, active generation, lease, last check
 *     generations/<g>/manifest.json  as served, verified
 *     generations/<g>/nodes.ndjson.gz
 *     generations/<g>/edges.ndjson.gz
 *     staging/<random>/              removed at the start of every pass and after any failed sync
 *
 * Every write is a rename into place or an atomic JSON write, so a crash at
 * any point leaves either the previous generation active or the new one,
 * never a partial one.
 *
 * @ref LLP 0480#replica [implements]: one replica per (origin, org) under the plugin state dir, generations plus staging, never a dataset
 */

export const REPLICA_FORMAT = 1
const RECORD_FILE = 'replica.json'

/**
 * The directory name of the replica for one server origin and login org.
 * Readable prefix for an operator listing the directory, hash suffix for
 * uniqueness: two origins or orgs that slug alike still get distinct keys.
 * An org not known before the first manifest (a static or env token) keys
 * as the empty org.
 *
 * @param {string} origin canonical server origin
 * @param {string | null} org
 * @returns {string}
 */
export function replicaKey(origin, org) {
  const host = origin.replace(/^[a-z]+:\/\//, '')
  const digest = createHash('sha256').update(`${origin}\0${org ?? ''}`).digest('hex').slice(0, 12)
  return `${slug(host)}--${slug(org || 'org')}--${digest}`
}

/** @param {string} value */
function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9.-]+/g, '_').slice(0, 40)
}

/** @param {string} stateDir the plugin state directory */
export function replicasRoot(stateDir) {
  return path.join(stateDir, 'replicas')
}

/**
 * Paths of one replica.
 *
 * @param {string} stateDir
 * @param {string} key
 */
export function replicaPaths(stateDir, key) {
  const dir = path.join(replicasRoot(stateDir), key)
  return {
    dir,
    record: path.join(dir, RECORD_FILE),
    generations: path.join(dir, 'generations'),
    staging: path.join(dir, 'staging'),
    /** @param {string} generation */
    generation: (generation) => path.join(dir, 'generations', generationDirName(generation)),
  }
}

/**
 * Generations are opaque server strings; only a safe spelling reaches the
 * filesystem. A generation that is not already a plain name is hashed.
 *
 * @param {string} generation
 */
export function generationDirName(generation) {
  return /^[A-Za-z0-9._-]{1,80}$/.test(generation) && generation !== '.' && generation !== '..'
    ? generation
    : `g-${createHash('sha256').update(generation).digest('hex').slice(0, 24)}`
}

/**
 * The replica record, or null when absent or unreadable. An unreadable
 * record is not trusted: the caller starts over, which at worst downloads
 * the current generation again.
 *
 * @param {string} recordPath
 * @returns {Promise<ReplicaRecord | null>}
 */
export async function readRecord(recordPath) {
  try {
    const value = /** @type {ReplicaRecord | null} */ (await readJsonIfExists(recordPath))
    return value && value.format === REPLICA_FORMAT ? value : null
  } catch {
    return null
  }
}

/**
 * @param {string} recordPath
 * @param {ReplicaRecord} record
 */
export function writeRecord(recordPath, record) {
  return atomicWriteJson(recordPath, record, { fsync: true, mode: 0o600 })
}

/**
 * A fresh, empty staging directory for one download.
 *
 * @param {string} stagingRoot
 * @returns {Promise<string>}
 */
export async function createStaging(stagingRoot) {
  const dir = path.join(stagingRoot, randomBytes(8).toString('hex'))
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** @param {string} dir */
export function removeTree(dir) {
  return fsp.rm(dir, { recursive: true, force: true, maxRetries: 2 })
}

/**
 * Moves a verified staging directory into `generations/` under its
 * generation name. A leftover directory of the same name (a crash after the
 * rename but before the record was written) is replaced.
 *
 * @param {string} stagingDir
 * @param {string} generationDir
 */
export async function promoteStaging(stagingDir, generationDir) {
  await fsp.mkdir(path.dirname(generationDir), { recursive: true, mode: 0o700 })
  await removeTree(generationDir)
  await fsp.rename(stagingDir, generationDir)
}

/**
 * Deletes every generation directory except `keep`.
 *
 * @param {string} generationsRoot
 * @param {string | null} keep generation directory name to keep
 * @returns {Promise<string[]>} removed directory names
 */
export async function pruneGenerations(generationsRoot, keep) {
  /** @type {string[]} */
  const removed = []
  for (const name of await listDir(generationsRoot)) {
    if (name === keep) continue
    await removeTree(path.join(generationsRoot, name))
    removed.push(name)
  }
  return removed
}

/**
 * Deletes every replica directory except `keepKey`: a replica whose key is
 * no longer current (another default remote, org or server, or no login at
 * all) is teammates' data this machine no longer has a reason to hold.
 *
 * @param {string} stateDir
 * @param {string | null} keepKey
 * @returns {Promise<string[]>} removed keys
 */
export async function pruneReplicas(stateDir, keepKey) {
  /** @type {string[]} */
  const removed = []
  for (const name of await listDir(replicasRoot(stateDir))) {
    if (name === keepKey) continue
    await removeTree(path.join(replicasRoot(stateDir), name))
    removed.push(name)
  }
  return removed
}

/**
 * Total size in bytes of the regular files under `dir` (zero when absent).
 *
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function diskBytes(dir) {
  let total = 0
  /** @type {Dirent[]} */
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true, recursive: true })
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return 0
    throw err
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      total += (await fsp.stat(path.join(entry.parentPath, entry.name))).size
    } catch { /* removed meanwhile */ }
  }
  return total
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listDir(dir) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return []
    throw err
  }
}
