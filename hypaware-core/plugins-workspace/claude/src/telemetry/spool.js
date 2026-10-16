// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { compareStrings } from 'hypaware/core/util'

import { captureSpoolRoot } from '../../../../../src/core/capture_spool.js'

/**
 * Where Claude Code drops the raw request/response bodies attach asks it for.
 *
 * The path is fixed rather than configurable: attach writes it into the client
 * settings, the listener reads it, and `hyp purge` and detach sweep it, so
 * three unrelated surfaces have to agree on it without being told. The parent
 * is core's capture-spool root rather than a second spelling of it, which is
 * what makes this directory one `hyp purge` empties and one detach is allowed
 * to sweep.
 *
 * @ref LLP 0253#spool-location [implements]: `<hyp-home>/spool/claude-bodies`,
 *   owner-only
 */

/** This client's directory name under the shared capture-spool root. */
const SPOOL_DIRNAME = 'claude-bodies'

/**
 * Default byte cap for the spool.
 *
 * @ref LLP 0253#byte-cap [implements]: bounded by a configured cap, default
 *   512 MB, so a down daemon can never fill the disk
 */
export const DEFAULT_SPOOL_MAX_BYTES = 512 * 1024 * 1024

/**
 * The body spool directory for a HypAware home.
 *
 * @param {string} hypHome
 * @returns {string}
 */
export function claudeBodySpoolDir(hypHome) {
  return path.join(captureSpoolRoot(hypHome), SPOOL_DIRNAME)
}

/**
 * Create the spool directory owner-only, before anything is told to write into
 * it. `mkdir`'s mode is filtered by the process umask, so the permission is
 * set explicitly afterwards rather than hoped for; an existing directory is
 * tightened the same way, which is what repairs a directory Claude Code
 * created itself at the default mode.
 *
 * @ref LLP 0253#spool-location [implements]: created mode 0700, because raw
 *   prompts must not be world-readable
 * @param {string} dir
 * @returns {Promise<string>} the same directory, for chaining
 */
export async function ensureClaudeBodySpool(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700)
  return dir
}

/**
 * Tighten the spool's permissions IF it already exists, and create nothing.
 *
 * The daemon's job on this directory is repair, not creation: attach is what
 * brings the spool into being (it is the same write that tells Claude Code
 * where to put bodies), so a daemon that creates it anyway announces a capture
 * surface on a machine that never attached this client - and does it against
 * whatever `HYP_HOME` the activation context happened to resolve, which is how
 * a test run reaches the developer's real `~/.hyp`. A missing directory is the
 * normal state for an unattached install, so it is silently nothing to do.
 *
 * @ref LLP 0253#spool-location [implements]: the daemon keeps the directory
 *   owner-only; it is not the thing that mints it
 * @param {string} dir
 * @returns {Promise<boolean>} whether a directory was found and tightened
 */
export async function tightenClaudeBodySpool(dir) {
  try {
    const stat = await fs.stat(dir)
    if (!stat.isDirectory()) return false
  } catch {
    return false
  }
  await fs.chmod(dir, 0o700)
  return true
}

/**
 * Enforce the spool's byte cap: when the directory's regular files sum
 * past `maxBytes`, delete files strictly oldest-first (mtime, then name
 * for a stable order when mtimes tie) until the total fits.
 *
 * The eviction direction is settled, not incidental: the newest bodies
 * are the ones whose events are still arriving, so they are the ones
 * worth keeping. An evicted body is not lost content: the transcript
 * backfill path recovers the session later.
 *
 * Runs concurrently with Claude Code writing new files and with the
 * listener deleting projected ones, so every per-file stat and unlink
 * tolerates the file vanishing underneath it.
 *
 * @ref LLP 0253#byte-cap [implements]: oldest files are removed first when the
 *   cap is exceeded, enforced by the daemon rather than by hoping the reader
 *   keeps up
 * @param {string} dir
 * @param {number} maxBytes
 * @returns {Promise<{ spoolBytes: number, evictedCount: number, evictedBytes: number }>}
 */
export async function enforceClaudeBodySpoolCap(dir, maxBytes) {
  /** @type {Array<{ name: string, size: number, mtimeMs: number }>} */
  const files = []
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { spoolBytes: 0, evictedCount: 0, evictedBytes: 0 }
    }
    throw err
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      const stat = await fs.stat(path.join(dir, entry.name))
      files.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      // Deleted between readdir and stat: it no longer counts.
    }
  }

  let spoolBytes = files.reduce((sum, f) => sum + f.size, 0)
  let evictedCount = 0
  let evictedBytes = 0
  if (spoolBytes <= maxBytes) return { spoolBytes, evictedCount, evictedBytes }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs || compareStrings(a.name, b.name))
  for (const file of files) {
    if (spoolBytes <= maxBytes) break
    try {
      await fs.rm(path.join(dir, file.name), { force: true })
    } catch {
      continue
    }
    spoolBytes -= file.size
    evictedCount += 1
    evictedBytes += file.size
  }
  return { spoolBytes, evictedCount, evictedBytes }
}
