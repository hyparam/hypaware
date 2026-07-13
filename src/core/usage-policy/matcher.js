// @ts-check

import nodeFs from 'node:fs'
import path from 'node:path'

import { parseHypignore } from './format.js'
import { LocalOnlyListUnreadableError } from './local_only.js'

/**
 * @import { LocalOnlyEntry, ResolveResult, UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 */

const HYPIGNORE_FILENAME = '.hypignore'

// How long a resolved `cwd` is trusted before its ancestor walk is re-run. A
// short TTL keeps the capture hot path bounded (at most one walk per cwd per
// window, R6) while bounding staleness the other way: a long-lived daemon
// resolver that cached a cwd as `full` picks up a newly written `.hypignore`
// within this window instead of never, until restart (R1). The value is the
// interim leak bound; a future CLI-to-daemon signal would drive it to zero.
const CACHE_TTL_MS = 5_000

// Class precedence for merging the two usage-policy sources: `ignore` (never
// recorded — moot at the export seam, but total for completeness) beats
// `local-only` (recorded, withheld from forwarding) beats `full` (the
// default). Exported so CLI callers (LLP 0103 #cli marking verbs) compare
// classes without a second copy of the ranking (R8's "one shared thing"),
// and so the query-seam visibility filter (LLP 0105) compares a caller's
// class against each row's class on this same restrictiveness lattice --
// there is exactly one ordering in the codebase.
// @ref LLP 0070#resolver [implements]: most-restrictive-wins ordering
export const CLASS_RANK = { ignore: 2, 'local-only': 1, full: 0 }

// LLP 0103's on-disk list version. Kept in sync with local_only.js's private
// constant of the same value; a version mismatch (neither 1 nor 2) is
// treated as unreadable (fail-safe), not silently coerced.
const LOCAL_ONLY_LIST_VERSION_V1 = 1
const LOCAL_ONLY_LIST_VERSION_V2 = 2

/**
 * Create a usage-policy resolver: given an exchange's `cwd`, walk ancestor
 * directories to the nearest `.hypignore` and resolve it to a usage class,
 * optionally merged with a second source — the machine-local `local-only`
 * directory list (LLP 0071) — when `localOnlyListPath` is supplied.
 *
 * The `.hypignore` walk finds the nearest governing file (empty/`ignore`
 * token => `ignore`; the newly-implemented `local-only` token => `local-only`;
 * an unimplemented token still fails safe to `ignore`). When a
 * `localOnlyListPath` is given, `resolve` additionally checks whether `cwd`
 * equals or is a path-segment descendant of any listed directory (the LLP
 * 0049 #scope ancestor rule, segment-aware: `/a/bc` is not under `/a/b`), and
 * returns the **most restrictive** of the two verdicts: `ignore` >
 * `local-only` > `full` (LLP 0070 #resolver). The resolver is `cwd`-agnostic
 * path logic only: it never inspects rows, so only the calling adapter need
 * know which field carries the `cwd`.
 *
 * Results are memoized per absolute `cwd` with a short TTL, so the capture hot
 * path does at most one ancestor walk (and, when a list is configured, one
 * list-membership check) per `cwd` per TTL window (R6) rather than one per
 * exchange. The TTL also bounds staleness: a long-lived daemon resolver
 * that cached a `cwd` as `full` re-walks once the entry expires, so a
 * `.hypignore` written (or removed) mid-run is honored within the TTL instead
 * of only after a daemon restart (R1). `hyp ignore --check` still constructs a
 * fresh resolver, so it always reflects disk immediately. The parsed
 * `local-only` list itself is memoized separately with the same TTL, so
 * resolving many distinct `cwd`s in one window still does at most one list
 * read/parse, not one per `cwd`.
 *
 * Future enhancement (not V1): `hyp ignore` / `hyp unignore` could signal the
 * running daemon to invalidate and prime the affected `cwd`'s cache entry,
 * collapsing the apply latency from "within the TTL" to zero. Until that path
 * exists, the TTL is the leak bound.
 *
 * fs, the clock, and the TTL are injected for tests; fs defaults to `node:fs`,
 * the clock to `Date.now`, and the TTL to `CACHE_TTL_MS`.
 *
 * @ref LLP 0050 [implements]: the single shared matcher for all four adapter call sites; no per-adapter copies
 * @ref LLP 0049#scope [implements]: gitignore-style ancestor walk from cwd, nearest .hypignore wins; per-cwd cache (R6)
 * @ref LLP 0052#matcher [implements]: bounded-TTL staleness so a mid-run .hypignore is honored without a daemon restart
 * @ref LLP 0070#resolver [implements]: one shared resolver, two sources, most-restrictive class wins
 * @ref LLP 0071 [implements]: the machine-local list is the second source
 * @param {object} [deps]
 * @param {(path: string, encoding: 'utf8') => string} [deps.readFileSync]
 * @param {(path: string) => boolean} [deps.existsSync]
 * @param {() => number} [deps.now] injectable clock in ms; defaults to Date.now
 * @param {number} [deps.ttlMs] cache entry lifetime in ms; defaults to CACHE_TTL_MS
 * @param {string} [deps.localOnlyListPath] absolute path of the machine-local
 *   `local-only` list (`localOnlyListPath(stateDir)`, LLP 0071); omitted =>
 *   the resolver behaves exactly as it did before the list existed
 * @returns {UsagePolicyResolver}
 */
export function createUsagePolicyResolver({
  readFileSync = nodeFs.readFileSync,
  existsSync = nodeFs.existsSync,
  now = Date.now,
  ttlMs = CACHE_TTL_MS,
  localOnlyListPath,
} = {}) {
  /** @type {Map<string, { result: ResolveResult, expiresAt: number }>} */
  const cache = new Map()
  /** @type {{ entries: LocalOnlyEntry[], expiresAt: number } | null} */
  let listCache = null

  /**
   * @param {string} cwd
   * @returns {ResolveResult}
   */
  function resolve(cwd) {
    const key = path.resolve(cwd)
    const at = now()
    const cached = cache.get(key)
    if (cached && cached.expiresAt > at) return cached.result
    const dotfileResult = walk(key)
    const listResult = localOnlyListPath ? matchList(key, at) : null
    const result = mostRestrictive(dotfileResult, listResult)
    cache.set(key, { result, expiresAt: at + ttlMs })
    return result
  }

  /**
   * @param {string} startDir
   * @returns {ResolveResult}
   */
  function walk(startDir) {
    let dir = startDir
    while (true) {
      const candidate = path.join(dir, HYPIGNORE_FILENAME)
      if (existsSync(candidate)) {
        const parsed = parseHypignore(safeRead(candidate))
        // Carry `warn` only on a fail-safe clamp, so a plain `ignore` result
        // stays `{ class, governedBy, declared }` with no `warn` key.
        return {
          class: parsed.class,
          governedBy: candidate,
          declared: parsed.declared,
          ...(parsed.warn ? { warn: parsed.warn } : {}),
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break // reached the filesystem root
      dir = parent
    }
    // Nothing governs: the implicit `full` default (LLP 0049 #classes).
    return { class: 'full', governedBy: null, declared: null }
  }

  /**
   * Read a governing `.hypignore`, failing safe to an empty body (which the
   * format parses as `ignore`) when the file exists but cannot be read: an
   * uninterpretable privacy signal must suppress, never record.
   *
   * @param {string} file
   * @returns {string}
   */
  function safeRead(file) {
    try {
      return String(readFileSync(file, 'utf8'))
    } catch {
      return ''
    }
  }

  /**
   * Check `cwd` against the machine-local class-per-entry list (LLP 0103),
   * re-reading and re-parsing the list file at most once per `ttlMs` window
   * (independent of how many distinct `cwd`s are resolved in that window). A
   * missing file is "no exclusions" (`[]`); a present-but-unparseable file
   * throws — the same fail-safe the store (`local_only.js`) applies, so a
   * corrupt list fails the caller loudly rather than silently resolving to
   * "nothing excluded" (LLP 0080 #fail-safe). When more than one entry
   * governs `cwd` (nested entries), the most specific (longest `dir`) wins,
   * mirroring the `.hypignore` walk's nearest-governs rule; a tie is broken
   * by the more restrictive class.
   *
   * @ref LLP 0071 [implements]: segment-aware equal-or-descendant list membership, second resolver source
   * @ref LLP 0103 [implements]: the entry's own class governs, not a hardcoded `local-only`
   * @param {string} cwd absolute, already `path.resolve`d
   * @param {number} at current clock reading (ms)
   * @returns {ResolveResult | null} `null` when nothing in the list governs `cwd`
   */
  function matchList(cwd, at) {
    const entries = getListEntries(at)
    const matches = entries.filter((entry) => isEqualOrDescendant(cwd, entry.dir))
    if (matches.length === 0) return null
    const governing = matches.reduce((best, entry) => {
      if (entry.dir.length > best.dir.length) return entry
      if (entry.dir.length === best.dir.length && CLASS_RANK[entry.class] > CLASS_RANK[best.class]) return entry
      return best
    })
    return {
      class: governing.class,
      governedBy: /** @type {string} */ (localOnlyListPath),
      declared: governing.class,
    }
  }

  /**
   * @param {number} at
   * @returns {LocalOnlyEntry[]}
   */
  function getListEntries(at) {
    if (listCache && listCache.expiresAt > at) return listCache.entries
    const entries = readListEntriesSync()
    listCache = { entries, expiresAt: at + ttlMs }
    return entries
  }

  /**
   * Synchronously read and parse the LLP 0103 list file, migrating a
   * version-1 `dirs` array on read as all-`local-only` entries. Missing =>
   * `[]` (the common case); present-but-unreadable/malformed => throws
   * {@link LocalOnlyListUnreadableError}, mirroring `readLocalOnlyEntries`'s
   * async fail-safe so both paths name the same `error_kind`.
   *
   * @ref LLP 0080#fail-safe [implements]: a corrupt list fails the resolve loudly, never silently to "no exclusions"
   * @ref LLP 0103 [implements]: migrate-on-read for the sync capture-hot-path reader
   * @returns {LocalOnlyEntry[]}
   */
  function readListEntriesSync() {
    const filePath = /** @type {string} */ (localOnlyListPath)
    if (!existsSync(filePath)) return []
    let raw
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (err) {
      throw new LocalOnlyListUnreadableError(filePath, { cause: err })
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new LocalOnlyListUnreadableError(filePath, { cause: err })
    }
    if (!parsed || typeof parsed !== 'object') throw new LocalOnlyListUnreadableError(filePath)

    if (parsed.version === LOCAL_ONLY_LIST_VERSION_V1) {
      if (!Array.isArray(parsed.dirs) || !parsed.dirs.every((/** @type {unknown} */ dir) => typeof dir === 'string')) {
        throw new LocalOnlyListUnreadableError(filePath)
      }
      return parsed.dirs.map((/** @type {string} */ dir) => ({ dir: path.resolve(dir), class: /** @type {const} */ ('local-only') }))
    }
    if (parsed.version === LOCAL_ONLY_LIST_VERSION_V2) {
      const valid =
        Array.isArray(parsed.entries) &&
        parsed.entries.every(
          (/** @type {unknown} */ entry) =>
            entry !== null &&
            typeof entry === 'object' &&
            typeof (/** @type {{ dir?: unknown }} */ (entry)).dir === 'string' &&
            Object.prototype.hasOwnProperty.call(CLASS_RANK, /** @type {{ class?: unknown }} */ (entry).class)
        )
      if (!valid) throw new LocalOnlyListUnreadableError(filePath)
      return (/** @type {LocalOnlyEntry[]} */ (parsed.entries)).map((entry) => ({
        dir: path.resolve(entry.dir),
        class: entry.class,
      }))
    }
    throw new LocalOnlyListUnreadableError(filePath)
  }

  /**
   * @param {string} cwd
   * @returns {boolean}
   */
  function isIgnored(cwd) {
    return resolve(cwd).class === 'ignore'
  }

  return { resolve, isIgnored }
}

/**
 * True when `cwd` equals `dir`, or is a path-segment descendant of it.
 * Segment-aware: `/a/bc` is not a descendant of `/a/b` even though it shares
 * the string prefix `/a/b` (the LLP 0049 #scope ancestor rule, per LLP 0071's
 * "Match semantics").
 *
 * Exported for reuse by the `hyp ignore --local-only` / `hyp unignore
 * --local-only` CLI (R8: the single shared matcher, never a second copy of
 * path logic) — it needs the same equal-or-ancestor test to find which
 * machine-local list entries govern a target directory.
 *
 * @ref LLP 0069#requirements [implements]: R8, shared equal-or-descendant path logic
 * @param {string} cwd absolute, already `path.resolve`d
 * @param {string} dir absolute, already `path.resolve`d
 * @returns {boolean}
 */
export function isEqualOrDescendant(cwd, dir) {
  if (cwd === dir) return true
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep
  return cwd.startsWith(prefix)
}

/**
 * Merge the `.hypignore` walk result with an optional list-membership result,
 * returning whichever is strictly more restrictive (`ignore` > `local-only` >
 * `full`); a tie (e.g. both `local-only`) keeps the dotfile result, which is
 * already the more specific, already-computed answer.
 *
 * @ref LLP 0070#resolver [implements]: most-restrictive-wins merge of the two sources
 * @param {ResolveResult} dotfileResult
 * @param {ResolveResult | null} listResult
 * @returns {ResolveResult}
 */
function mostRestrictive(dotfileResult, listResult) {
  if (!listResult) return dotfileResult
  if (CLASS_RANK[listResult.class] > CLASS_RANK[dotfileResult.class]) return listResult
  if (CLASS_RANK[listResult.class] < CLASS_RANK[dotfileResult.class]) return dotfileResult
  // Tie (e.g. both `full`, or both `local-only`): the dotfile walk's result
  // wins as the more specific, already-computed answer - UNLESS it's the
  // unrecorded implicit default (`governedBy: null`) tying against a list
  // entry that actually recorded an explicit answer (LLP 0103's explicit
  // `full` marker resolves identically to "nothing governs" but must still
  // name its governor, so the classification hook can tell "asked; syncs"
  // apart from "never asked").
  if (dotfileResult.governedBy === null && listResult.governedBy !== null) return listResult
  return dotfileResult
}
