// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

import { errCode } from './util/json_util.js'

/**
 * @import { Dirent } from 'node:fs'
 */

/**
 * The capture-spool root under the HypAware home: `<hyp-home>/spool`.
 *
 * A client that writes raw request/response bodies for us drops them into a
 * directory beneath it, one per client (`spool/claude-bodies` today). Core
 * knows the root; the client directories are the plugins'. That split is what
 * lets `hyp purge` empty every spool without naming a plugin, and what bounds
 * the directory a detach may sweep from a path it read out of a settings file.
 *
 * @ref LLP 0253#spool-location [implements]: a path under the HypAware home is
 *   what `hyp purge` and detach can find without being told
 */
const SPOOL_ROOT_DIRNAME = 'spool'

/**
 * @param {string} hypHome
 * @returns {string}
 */
export function captureSpoolRoot(hypHome) {
  return path.join(hypHome, SPOOL_ROOT_DIRNAME)
}

/**
 * Whether `dir` names a capture spool this install owns: an absolute path
 * whose parent is exactly `<hyp-home>/spool`.
 *
 * The test exists because detach learns the path from the attach marker, which
 * lives in the user's own settings file and is therefore reachable by a hand
 * edit. Without a containment rule, "sweep the directory the marker names"
 * would be a recursive-delete primitive pointed at an arbitrary path. Depth
 * one, not "somewhere under the root", so a marker cannot walk the sweep down
 * into a nested tree either; `path.resolve` normalizes any `..` away first, so
 * an escaping spelling lands outside the root and fails the test.
 *
 * @param {unknown} dir
 * @param {string} hypHome
 * @returns {boolean}
 */
export function isCaptureSpoolDir(dir, hypHome) {
  if (typeof dir !== 'string' || dir.length === 0 || !path.isAbsolute(dir)) return false
  const resolved = path.resolve(dir)
  return path.dirname(resolved) === path.resolve(captureSpoolRoot(hypHome))
}

/**
 * Empty a capture spool: remove every file under `dir`, keeping the
 * directories themselves.
 *
 * The directory survives because the client that writes into it was told its
 * path at attach and is not asked again; only the contents are the user's data.
 * The walk never throws - a spool sweep runs at the end of a destructive verb
 * whose real work has already landed, so an unreadable subdirectory is a
 * `failed` count the caller reports, not a reason to fail a purge or a detach
 * that already succeeded.
 *
 * @ref LLP 0253#purge-and-detach-sweep [implements]: purge and detach both
 *   remove the spool directory's contents
 * @param {string} dir
 * @param {{ fs?: typeof fsp }} [opts]
 * @returns {Promise<{ filesRemoved: number, bytesRemoved: number, failed: number }>}
 */
export async function sweepCaptureSpool(dir, opts = {}) {
  const fs = opts.fs ?? fsp
  let filesRemoved = 0
  let bytesRemoved = 0
  let failed = 0

  /** @type {string[]} */
  const pending = [dir]
  while (pending.length > 0) {
    const current = /** @type {string} */ (pending.pop())
    /** @type {Dirent[]} */
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (err) {
      // An absent spool is the normal case on a machine that never attached a
      // body-writing client; anything else is a directory we could not empty.
      if (errCode(err) !== 'ENOENT') failed += 1
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(full)
        continue
      }
      // `lstat`, so a symlink is measured and removed as the link it is rather
      // than followed out of the spool.
      let size = 0
      try {
        size = (await fs.lstat(full)).size
      } catch (err) {
        if (errCode(err) === 'ENOENT') continue
      }
      try {
        await fs.rm(full, { force: true })
        filesRemoved += 1
        bytesRemoved += size
      } catch {
        failed += 1
      }
    }
  }

  return { filesRemoved, bytesRemoved, failed }
}
