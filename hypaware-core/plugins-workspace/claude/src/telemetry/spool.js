// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Where Claude Code drops the raw request/response bodies attach asks it for.
 *
 * The path is fixed rather than configurable: attach writes it into the client
 * settings, the listener reads it, and `hyp purge` and detach sweep it, so
 * three unrelated surfaces have to agree on it without being told.
 *
 * @ref LLP 0253#spool-location [implements]: `<hyp-home>/spool/claude-bodies`,
 *   owner-only
 */

/** Path segments under the HypAware home. */
const SPOOL_SEGMENTS = ['spool', 'claude-bodies']

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
  return path.join(hypHome, ...SPOOL_SEGMENTS)
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

  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
