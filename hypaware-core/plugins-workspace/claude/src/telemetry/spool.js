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
