// @ts-check

import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, getLogger } from '../observability/index.js'
import { cacheRootOf } from './paths.js'

/**
 * @import { FileHandle } from 'node:fs/promises'
 * @import { OwnerRootOutcome } from '../../../src/core/runtime/types.js'
 */

/** Mode for a directory HypAware creates to hold recorded data. */
export const OWNER_DIR_MODE = 0o700

/** Mode for a file HypAware writes recorded data into. */
export const OWNER_FILE_MODE = 0o600

// What HypAware itself keeps directly under a custom `HYP_HOME` or a
// separate cache root. A location holding anything else is shared with
// something HypAware does not own, and is left as it is.
const HYP_HOME_ENTRIES = new Set(['hypaware', 'hypaware-config.json', 'spool', 'ask', 'exports', '.DS_Store'])
const CACHE_ROOT_ENTRIES = new Set(['datasets', 'plugins', 'session-purges', '.purge-cleanup', '.DS_Store'])

/**
 * Tighten an existing storage root to owner-only, through a descriptor on
 * the directory itself. Creates nothing: a missing root is `'missing'`.
 *
 * The final component is resolved first and the resolved directory opened
 * with `O_NOFOLLOW | O_DIRECTORY`, so a symlinked root is tightened at its
 * target and a link swapped in after the resolve fails the open instead of
 * redirecting the chmod. Owner and type come from `fstat` on that descriptor
 * and the mode is set with `fchmod` on it, so nothing is checked on one inode
 * and changed on another. Ancestors are not touched and may be links.
 *
 * `knownEntries` is the dedicated-location test for a root HypAware did not
 * name: the root is tightened only when every entry in it is one HypAware
 * writes there. A root whose group and other bits are already clear is
 * `'unchanged'` without that read.
 *
 * Never throws: storage keeps working in a location it cannot tighten.
 *
 * @ref LLP 0569#verified-root [implements]: owner, type and mode all go through one descriptor, never a path re-check
 * @param {string} dir
 * @param {{ knownEntries?: (name: string) => boolean }} [opts]
 * @returns {Promise<OwnerRootOutcome>}
 */
export async function secureOwnerRoot(dir, opts = {}) {
  if (process.platform === 'win32') return 'unsupported'
  /** @type {string} */
  let real
  /** @type {FileHandle | undefined} */
  let handle
  try {
    real = await fs.realpath(dir)
  } catch (err) {
    return openFailure(err)
  }
  try {
    handle = await fs.open(real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch (err) {
    // Linux reports a link refused by `O_NOFOLLOW | O_DIRECTORY` as ENOTDIR,
    // the same as a file. Telling them apart only names the outcome; nothing
    // is changed either way.
    const swapped = await fs.lstat(real).then(st => st.isSymbolicLink(), () => false)
    return swapped ? 'replaced' : openFailure(err)
  }
  try {
    const st = await handle.stat()
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return 'foreign_owner'
    if ((st.mode & 0o077) === 0) return 'unchanged'
    if (opts.knownEntries) {
      const names = await fs.readdir(real)
      if (!names.every(opts.knownEntries)) return 'not_dedicated'
      // The list was read by path; the descriptor is what gets the chmod.
      // A different directory at that path now means the list was not this
      // directory's, so nothing is changed.
      const again = await fs.lstat(real)
      if (again.ino !== st.ino || again.dev !== st.dev) return 'replaced'
    }
    await handle.chmod(OWNER_DIR_MODE)
    return 'secured'
  } catch (err) {
    return openFailure(err)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** @param {unknown} err @returns {OwnerRootOutcome} */
function openFailure(err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code
  if (code === 'ENOENT') return 'missing'
  if (code === 'ELOOP') return 'replaced'
  if (code === 'ENOTDIR') return 'not_directory'
  return 'error'
}

/** @param {string} name */
function isHypHomeEntry(name) {
  return HYP_HOME_ENTRIES.has(name) || name.startsWith('hypaware-config.json.')
}

/** @param {string} name */
function isCacheRootEntry(name) {
  // `_hyp_ingest_seq.json` and its lock and temp siblings.
  return CACHE_ROOT_ENTRIES.has(name) || name.startsWith('_hyp_')
}

const securedThisProcess = new Set()

/**
 * Tighten the storage roots one boot writes under, once per process each.
 *
 * - `HYP_HOME`: dedicated by name when it is a `.hyp` directory (the
 *   default), otherwise only when it holds nothing but HypAware's entries.
 * - The state root `<HYP_HOME>/hypaware`: HypAware's own directory by name.
 *   It holds the default cache, plugin state, daemon logs and credentials,
 *   so tightening it contains every existing file below it without visiting
 *   any of them.
 * - A cache root outside the state root: only when it holds nothing but the
 *   cache's own entries.
 *
 * A root that is shared, foreign-owned, replaced or unreadable is left
 * exactly as found, with one warning, and boot carries on.
 *
 * @ref LLP 0569#roots [implements]: three roots, each verified before it is tightened; no recursion, no parents
 * @param {{ hypHome: string, stateRoot: string, cacheRoot: string }} roots
 * @returns {Promise<Record<string, OwnerRootOutcome>>} outcome per root kind, for spans and tests
 */
export async function secureStorageRoots({ hypHome, stateRoot, cacheRoot }) {
  /** @type {Array<[string, string, ((name: string) => boolean) | undefined]>} */
  const roots = [
    ['hyp_home', hypHome, path.basename(hypHome) === '.hyp' ? undefined : isHypHomeEntry],
    ['state_root', stateRoot, undefined],
  ]
  if (path.resolve(cacheRoot) !== path.resolve(cacheRootOf(stateRoot))) {
    roots.push(['cache_root', cacheRoot, isCacheRootEntry])
  }
  /** @type {Record<string, OwnerRootOutcome>} */
  const outcomes = {}
  for (const [kind, dir, knownEntries] of roots) {
    const key = path.resolve(dir)
    if (securedThisProcess.has(key)) continue
    securedThisProcess.add(key)
    const outcome = await secureOwnerRoot(dir, knownEntries ? { knownEntries } : {})
    outcomes[kind] = outcome
    if (outcome === 'foreign_owner' || outcome === 'not_dedicated' || outcome === 'replaced'
      || outcome === 'not_directory' || outcome === 'error') {
      getLogger('kernel').warn('storage.root_not_secured', {
        [Attr.COMPONENT]: 'kernel',
        [Attr.ERROR_KIND]: outcome,
        status: 'skipped',
        hyp_root: kind,
      })
    }
  }
  return outcomes
}
