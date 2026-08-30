// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

import { isConfirmedSymlink } from './cache/paths.js'
import { Attr, getLogger } from './observability/index.js'
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
 * Say that the sweep refused a directory, and say it out loud.
 *
 * A guard on a deleting pass fails silently by construction: the symptom of a
 * refusal nobody reports is a spool that quietly stops being emptied, with
 * both verbs still returning success and a zero count that reads exactly like
 * an empty spool. `ls -l` at the logged component answers in one line.
 *
 * The two paths are directories, not filenames. This file's privacy rule
 * (counts, never names) bounds the spooled bodies, whose names are the
 * client's and whose contents are raw prompts; a spool directory is one we or
 * the attach marker named, and the component that refused is the only fact
 * worth saying about it.
 *
 * @param {string} root the spool the sweep was asked to empty
 * @param {string} planted the component on the way down that is a symlink
 */
function reportPlantedSpoolPath(root, planted) {
  try {
    getLogger('capture-spool').warn('a symlink stands on the spool sweep path; emptying nothing beneath it', {
      [Attr.COMPONENT]: 'capture-spool',
      [Attr.OPERATION]: 'capture_spool.sweep',
      [Attr.ERROR_KIND]: 'capture_spool_path_is_symlink',
      spool_dir: root,
      planted_component: planted,
    })
  } catch { /* a sweep must not fail on a logger provider that is not installed */ }
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
 * Every directory is asked one question before it is walked: `lstat`, is this
 * a symlink. {@link isCaptureSpoolDir} is string work only, so it cannot see
 * that `<hyp-home>/spool/claude-bodies` is a link, and `readdir` follows the
 * path it is handed. This walk then removes every file it lists, with no name
 * predicate and no grace window, recursing through real subdirectories, so a
 * link at the entry path (or at `<hyp-home>/spool` itself, which `hyp purge`
 * sweeps whatever its target) aims the whole deletion at a tree outside the
 * HypAware home. Nothing we or a client write mints a symlink here, so a
 * confirmed one means this is not a spool to empty.
 *
 * Only a symlink the filesystem confirms refuses. An unanswerable stat
 * accepts, and the `readdir` behind it then reports the directory as
 * `failed`, which is the line that tells a user to empty it by hand. Reading
 * silence as an escape would replace that with the same zero-count success an
 * empty spool returns.
 *
 * The entry path is resolved before any of that, because `lstat` answers about
 * a link only when the path names the link: a trailing `/` or `/.` makes the
 * kernel resolve the last component, so the guard would inspect the target
 * while `readdir` walked it. Detach hands this function the attach marker's
 * `spool_dir` verbatim, and `isCaptureSpoolDir` approved a `path.resolve`d
 * form of that same string, so an un-normalized spelling is the one input that
 * can make the checked path and the walked path differ.
 *
 * @ref LLP 0253#purge-and-detach-sweep [implements]: purge and detach both
 *   remove the spool directory's contents
 * @ref LLP 0328#sweep-path [implements]: the containment test is a string, so
 *   the walk asks the filesystem about each directory at the point it walks it
 * @param {string} dir
 * @param {{ fs?: typeof fsp }} [opts]
 * @returns {Promise<{ filesRemoved: number, bytesRemoved: number, failed: number }>}
 */
export async function sweepCaptureSpool(dir, opts = {}) {
  const fs = opts.fs ?? fsp
  let filesRemoved = 0
  let bytesRemoved = 0
  let failed = 0

  // One spelling for the check, the walk, and the report. `path.resolve`
  // strips a trailing separator and folds a `.` component, which is what makes
  // the `lstat` below ask about the same path `readdir` will open.
  const root = path.resolve(dir)

  /** @type {string[]} */
  const pending = [root]
  while (pending.length > 0) {
    const current = /** @type {string} */ (pending.pop())
    // Asked of the entry path and of every subdirectory alike, because the
    // question is about the path this iteration is about to walk rather than
    // about who supplied it. In-walk dirents are already safe (a symlink is
    // not `isDirectory()`, so it is removed as the link it is and never
    // queued); this covers the one path no dirent ever described.
    if (isConfirmedSymlink(current)) {
      reportPlantedSpoolPath(root, current)
      continue
    }
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
