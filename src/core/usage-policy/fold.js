// @ts-check

import { createHash } from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'

import { Attr } from '../observability/attrs.js'
import { getLogger } from '../observability/logger.js'

/**
 * `error_kind` for a per-volume case-sensitivity probe that could not reach a
 * definite answer. Never fatal: an undetermined volume is treated as
 * case-sensitive, which is exactly the pre-fold behaviour, so a failed probe
 * can only lose reach the fold would have added.
 */
export const PATH_CASE_PROBE_ERROR_KIND = 'path_case_probe_failed'

/**
 * Short one-way digest of a path, so a fold decision or a skipped probe is
 * diagnosable (which path, how often, which errno) without dev telemetry ever
 * carrying a raw local path. Same discipline as the `usage_policy.export_drop`
 * aggregate in `src/core/cache/storage.js`.
 *
 * @param {string} p
 * @returns {string}
 */
export function hashPath(p) {
  return createHash('sha256').update(p).digest('hex').slice(0, 16)
}

/**
 * The `errno` code of a filesystem error, as a lowercase token suitable for a
 * log attribute (`enoent`, `eacces`, `eperm`), or `unknown`.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errnoOf(err) {
  const code = /** @type {{ code?: unknown }} */ (err)?.code
  return typeof code === 'string' && code !== '' ? code.toLowerCase() : 'unknown'
}

/**
 * Fold a path into the form two spellings of the *same* directory share.
 *
 * `realpath(2)` folds symlinks and nothing else. A filesystem can give one
 * directory several spellings by two further mechanisms, and neither is
 * reachable through `realpath`:
 *
 * 1. **Unicode normalization.** macOS frameworks and Finder-derived paths emit
 *    NFD (`e` + U+0301) while typed and JSON-transported paths are usually NFC
 *    (U+00E9). On a default APFS volume both `stat` and `chdir` to the same
 *    directory. NFC is applied **unconditionally** here: it is a total function
 *    that needs no filesystem access and cannot fail, and on a path that is
 *    already NFC (every path on a Linux box that was never typed on a Mac) it
 *    is the identity, so folding costs a comparison and changes nothing.
 * 2. **Case.** On a case-insensitive volume `Proj` and `proj` are one
 *    directory. This is a property of the **volume**, not of the platform: an
 *    APFS volume can be formatted case-sensitive, and every ext4 volume is. So
 *    case is folded only when the caller passes a verdict for the volume the
 *    path lives on. Folding it unconditionally would merge two genuinely
 *    different directories on a case-sensitive volume, which is a correctness
 *    bug in the other direction.
 *
 * **Separator-preserving, and that is load-bearing.** The only consumer is a
 * path-segment prefix test, so the fold has to distribute over `/`:
 * `fold(a + '/' + b) === fold(a) + '/' + fold(b)`. It does. `/` is a starter
 * with combining class 0 that participates in no canonical composition, so NFC
 * is computed independently on each side of it, and `toLowerCase` maps `/` to
 * itself. A fold that did not distribute could turn a non-descendant into a
 * descendant across a segment boundary, so the property is asserted in the
 * test suite rather than left to inspection.
 *
 * @ref LLP 0050#normalization [implements]: the fold that makes two spellings of one directory compare equal
 * @param {string} p absolute path (already `path.resolve`d)
 * @param {{ caseInsensitive?: boolean }} [opts]
 * @returns {string}
 */
export function foldPath(p, { caseInsensitive = false } = {}) {
  const nfc = p.normalize('NFC')
  return caseInsensitive ? nfc.toLowerCase() : nfc
}

/**
 * A spelling of `p` whose **last segment** has the case of every cased
 * character flipped, or `null` when that segment has no cased character (so no
 * probe is possible from this path).
 *
 * Only the last segment is flipped, because the parent directories have to stay
 * traversable under their exact spelling for the probe to be a statement about
 * the volume `p` sits on rather than about every volume between it and the
 * root. Flipping *every* cased character of that segment rather than one is
 * deliberate: it is the spelling least likely to collide with a genuinely
 * different sibling on a case-sensitive volume, and even a collision is caught,
 * because what decides the verdict is the `dev`/`ino` identity of the two
 * spellings, not whether the flipped name resolves.
 *
 * @param {string} p
 * @returns {string | null}
 */
function flipCase(p) {
  const cut = p.lastIndexOf(path.sep)
  const head = cut < 0 ? '' : p.slice(0, cut + 1)
  const tail = cut < 0 ? p : p.slice(cut + 1)
  let flipped = ''
  let anyFlipped = false
  for (const ch of tail) {
    const lower = ch.toLowerCase()
    const upper = ch.toUpperCase()
    if (lower !== upper) {
      flipped += ch === lower ? upper : lower
      anyFlipped = true
    } else {
      flipped += ch
    }
  }
  return anyFlipped ? head + flipped : null
}

/**
 * Create a memoized per-volume case-sensitivity probe.
 *
 * The verdict is a property of the mounted volume, so it is memoized by the
 * volume's `dev` number rather than by path. The memo is keyed on `dev`, which
 * has to be *learned* before it can be consulted, so the cost is not zero on a
 * hit: every call `stat`s `dir` itself (one `stat` per directory), and only the
 * second, case-flipped `stat` is saved by the memo. So a list of `n` entries
 * costs `n` stats plus one extra per distinct volume, per TTL window, rather
 * than `2n`. That is still within the per-`cwd`-per-window bound LLP 0049 R6
 * sets for the ancestor walk, which already stats every ancestor. A volume
 * cannot change its case-sensitivity without being unmounted and reformatted,
 * at which point its `dev` changes too, so there is nothing for a TTL to
 * refresh, and the flipped-spelling probe genuinely runs once per volume for
 * the life of the resolver.
 *
 * **Inert off darwin.** On any other platform the probe returns `false`
 * immediately and issues **no syscall at all**, because no shipping
 * Linux/Windows filesystem this codebase targets presents the macOS
 * case-insensitive-by-default behaviour that motivates the fold. That also
 * means the whole probe is dead code on a Linux host, and therefore that its
 * darwin behaviour cannot be executed, let alone verified, there.
 *
 * **Undetermined resolves to `false`**, which is the pre-fold behaviour: a
 * directory that does not exist, a `stat` that is refused, or a path with no
 * cased character all fold NFC only. A failed probe can therefore only fail to
 * *add* reach; it can never remove a verdict some spelling already produced.
 *
 * @ref LLP 0050#normalization [implements]: case folding is per-volume and probed, never a platform constant
 * @ref LLP 0049#fail-safe [constrained-by]: an undetermined probe resolves to the pre-fold behaviour, never to a looser gate
 * @param {object} [deps]
 * @param {string} [deps.platform] defaults to `process.platform`
 * @param {(p: string) => { dev: number, ino: number }} [deps.statSync]
 * @param {(name: string, fields?: Record<string, unknown>) => void} [deps.logSkip]
 * @returns {(dir: string) => boolean}
 */
export function createVolumeCaseProbe({
  platform = process.platform,
  statSync = nodeFs.statSync,
  logSkip,
} = {}) {
  if (platform !== 'darwin') return () => false

  /** @type {Map<number, boolean>} */
  const byDev = new Map()

  /**
   * @param {string} dir
   * @param {string} reason
   * @param {string} errno
   */
  function skip(dir, reason, errno) {
    const emit = logSkip ?? defaultLogSkip
    emit('usage_policy.case_probe_skipped', {
      [Attr.COMPONENT]: 'usage-policy',
      [Attr.OPERATION]: 'case_probe',
      [Attr.STATUS]: 'skipped',
      [Attr.ERROR_KIND]: PATH_CASE_PROBE_ERROR_KIND,
      reason,
      errno,
      path_hash: hashPath(dir),
    })
  }

  return function probe(dir) {
    /** @type {{ dev: number, ino: number }} */
    let st
    try {
      st = statSync(dir)
    } catch (err) {
      skip(dir, 'stat_failed', errnoOf(err))
      return false
    }
    const memoized = byDev.get(st.dev)
    if (memoized !== undefined) return memoized

    const flipped = flipCase(dir)
    if (flipped === null) {
      // Not memoized: another path on this same volume may well have a cased
      // character, and would then reach a definite answer.
      skip(dir, 'no_cased_character', 'none')
      return false
    }
    let verdict
    try {
      const other = statSync(flipped)
      verdict = other.dev === st.dev && other.ino === st.ino
    } catch (err) {
      // `ENOENT` here is the *informative* outcome: the flipped spelling does
      // not resolve, so the volume is case-sensitive. Any other errno is a
      // genuinely undetermined probe and is not memoized.
      const errno = errnoOf(err)
      if (errno !== 'enoent') {
        skip(dir, 'stat_failed', errno)
        return false
      }
      verdict = false
    }
    byDev.set(st.dev, verdict)
    return verdict
  }
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} [fields]
 * @returns {void}
 */
function defaultLogSkip(name, fields) {
  // A directory that does not exist is routine at this seam (a deleted `cwd`,
  // a mark for a not-yet-created directory), so this is never a warning.
  getLogger('usage-policy').debug(name, fields)
}
