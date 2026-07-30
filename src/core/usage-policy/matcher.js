// @ts-check

import nodeFs from 'node:fs'
import path from 'node:path'

import { Attr } from '../observability/attrs.js'
import { getLogger } from '../observability/logger.js'

import { createVolumeCaseProbe, foldPath, hashPath } from './fold.js'
import { parseHypignore } from './format.js'
import { LocalOnlyListUnreadableError } from './local_only.js'

/**
 * @import { ListScope, LocalOnlyEntry, ResolveResult, UsageClass, UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
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
 * @ref LLP 0050#normalization [implements]: list membership compares folded spellings, so an NFC/NFD divergence between two processes does not open the gate
 * @param {object} [deps]
 * @param {(path: string, encoding: 'utf8') => string} [deps.readFileSync]
 * @param {(path: string) => boolean} [deps.existsSync]
 * @param {() => number} [deps.now] injectable clock in ms; defaults to Date.now
 * @param {number} [deps.ttlMs] cache entry lifetime in ms; defaults to CACHE_TTL_MS
 * @param {string} [deps.localOnlyListPath] absolute path of the machine-local
 *   `local-only` list (`localOnlyListPath(stateDir)`, LLP 0071); omitted =>
 *   the resolver behaves exactly as it did before the list existed
 * @param {(dir: string) => boolean} [deps.caseInsensitiveVolume] per-volume
 *   case-sensitivity verdict for an entry's directory; defaults to
 *   {@link createVolumeCaseProbe}, which is inert (constant `false`, no
 *   syscall) off darwin. Injected so the folding logic can be exercised for a
 *   case-insensitive volume on a host that has none
 * @param {(name: string, fields?: Record<string, unknown>) => void} [deps.logEvent]
 * @returns {UsagePolicyResolver}
 */
export function createUsagePolicyResolver({
  readFileSync = nodeFs.readFileSync,
  existsSync = nodeFs.existsSync,
  now = Date.now,
  ttlMs = CACHE_TTL_MS,
  localOnlyListPath,
  caseInsensitiveVolume,
  logEvent,
} = {}) {
  /** @type {Map<string, { result: ResolveResult, expiresAt: number }>} */
  const cache = new Map()
  /** @type {{ scopes: ListScope[], expiresAt: number } | null} */
  let listCache = null
  const emit = logEvent ?? emitDebug
  const probeVolume = caseInsensitiveVolume ?? createVolumeCaseProbe({ logSkip: emit })

  /**
   * @param {string} cwd
   * @returns {ResolveResult}
   */
  function resolve(cwd) {
    const key = path.resolve(cwd)
    const at = now()
    const cached = cache.get(key)
    // The memo is keyed on the *lexical* path and consulted before any folding,
    // so a cache hit costs exactly what it did before this existed. Folding is
    // on the miss path only.
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
   * throws, matching the fail-safe the store (`local_only.js`) applies, so a
   * corrupt list fails the caller loudly rather than silently resolving to
   * "nothing excluded" (LLP 0080 #fail-safe). When more than one entry
   * governs `cwd` (nested entries), the most specific (longest `dir`) wins,
   * mirroring the `.hypignore` walk's nearest-governs rule; a tie is broken
   * by the more restrictive class.
   *
   * An entry governs `cwd` when its declared `dir` equals-or-contains `cwd`,
   * **or** when the two do once both are folded (Unicode-normalized, and
   * case-folded on a volume probed case-insensitive). Widening an entry's
   * reach that way must not *loosen* the list, which is what
   * {@link selectGoverning} guarantees.
   *
   * @ref LLP 0071 [implements]: segment-aware equal-or-descendant list membership, second resolver source
   * @ref LLP 0050#normalization [implements]: an entry governs through any spelling the volume folds together
   * @ref LLP 0103 [implements]: the entry's own class governs, not a hardcoded `local-only`
   * @param {string} cwd absolute, already `path.resolve`d
   * @param {number} at current clock reading (ms)
   * @returns {ResolveResult | null} `null` when nothing in the list governs `cwd`
   */
  function matchList(cwd, at) {
    const governing = selectGoverning(cwd, getListScopes(at), reportFold)
    if (governing === null) return null
    return {
      class: governing.entry.class,
      governedBy: /** @type {string} */ (localOnlyListPath),
      declared: governing.entry.class,
    }
  }

  /**
   * Structured signal for the one interesting outcome: the folded pass reached
   * a **more restrictive** verdict than the declared spellings did, i.e. a
   * spelling divergence that would otherwise have opened the gate. Paths are
   * hashed, never logged raw, the same discipline as the
   * `usage_policy.export_drop` aggregate.
   *
   * @param {string} cwd
   * @param {UsageClass | null} declaredClass
   * @param {UsageClass} foldedClass
   * @returns {void}
   */
  function reportFold(cwd, declaredClass, foldedClass) {
    emit('usage_policy.fold_tightened', {
      [Attr.COMPONENT]: 'usage-policy',
      [Attr.OPERATION]: 'match_list',
      [Attr.STATUS]: 'ok',
      declared_class: declaredClass ?? 'none',
      folded_class: foldedClass,
      cwd_hash: hashPath(cwd),
    })
  }

  /**
   * The list entries paired with the folded spelling of each entry's declared
   * directory and the case verdict for the volume it lives on, computed once
   * per TTL window along with the parse. Resolving many `cwd`s in one window
   * therefore costs one fold per entry, not one per entry per `cwd`.
   *
   * @param {number} at
   * @returns {ListScope[]}
   */
  function getListScopes(at) {
    if (listCache && listCache.expiresAt > at) return listCache.scopes
    const scopes = readListEntriesSync().map((entry) => {
      const caseInsensitive = probeVolume(entry.dir)
      return { entry, caseInsensitive, foldedDir: foldPath(entry.dir, { caseInsensitive }) }
    })
    listCache = { scopes, expiresAt: at + ttlMs }
    return scopes
  }

  /**
   * Synchronously read and parse the LLP 0103 list file, migrating a
   * version-1 `dirs` array on read as all-`local-only` entries. Missing =>
   * `[]` (the common case); present-but-unreadable/malformed => throws
   * {@link LocalOnlyListUnreadableError}, mirroring `readLocalOnlyEntries`'s
   * async fail-safe so both paths name the same `error_kind`. Throwing rather
   * than yielding an empty list is LLP 0080 §fail-safe's mechanic; what makes
   * it mandatory is the invariant cited below.
   *
   * @ref LLP 0049#fail-safe [constrained-by]: an uninterpretable privacy signal must resolve to "suppress more", never silently to "no exclusions"
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
 * Default sink for the resolver's structured signals. Both of them (a fold that
 * tightened a verdict, a case probe that could not reach an answer) are routine
 * rather than faults, so neither is ever louder than `debug`.
 *
 * @param {string} name
 * @param {Record<string, unknown>} [fields]
 * @returns {void}
 */
function emitDebug(name, fields) {
  getLogger('usage-policy').debug(name, fields)
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
 * The nearest-governs winner over `scopes`: the entry whose matched directory
 * spelling is the longest, ties broken by the more restrictive class. When
 * `folded` is false this compares the spellings exactly as declared, which is
 * bit-for-bit the rule the matcher applied before folding existed; when it is
 * true both sides are folded first, so an entry reaches every spelling its
 * volume treats as the same directory.
 *
 * @param {string} cwd absolute, already `path.resolve`d
 * @param {readonly ListScope[]} scopes
 * @param {boolean} folded
 * @returns {{ entry: LocalOnlyEntry, depth: number } | null}
 */
function deepestMatch(cwd, scopes, folded) {
  const foldedCwd = folded ? foldPath(cwd) : cwd
  /** @type {string | null} */
  let loweredCwd = null
  /** @type {{ entry: LocalOnlyEntry, depth: number } | null} */
  let best = null
  for (const scope of scopes) {
    let target = cwd
    let dir = scope.entry.dir
    if (folded) {
      dir = scope.foldedDir
      // `foldPath(cwd, { caseInsensitive: true })` is `foldPath(cwd)` lowered,
      // so the two variants are computed at most once each per call rather than
      // once per entry.
      target = scope.caseInsensitive ? (loweredCwd ??= foldedCwd.toLowerCase()) : foldedCwd
    }
    if (!isEqualOrDescendant(target, dir)) continue
    const depth = dir.length
    if (
      best === null ||
      depth > best.depth ||
      (depth === best.depth && CLASS_RANK[scope.entry.class] > CLASS_RANK[best.entry.class])
    ) {
      best = { entry: scope.entry, depth }
    }
  }
  return best
}

/**
 * The machine-local entry that governs `cwd`, over precomputed folded scopes.
 *
 * Nearest-governs alone is **not** monotone in how many spellings an entry can
 * reach, and that is the one place a fold could make the gate *less*
 * restrictive than the string matcher it replaces. A less restrictive entry
 * that gains reach through its folded spelling can become the deepest match and
 * displace a broader restrictive entry that already governed: an explicit
 * `full`/`sync` carve-out spelled NFC would punch a hole in a private tree
 * spelled NFD, and the directory would start recording and forwarding. Nothing
 * about "compare folded spellings" prevents that on its own, because the
 * argmax-over-depth step in the middle discards verdicts instead of merging
 * them.
 *
 * So the rule is run twice, once over the spellings exactly as declared (which
 * reproduces the pre-fold verdict) and once folded, and the **more restrictive
 * of the two answers wins**, the declared one breaking a class tie because it
 * is the spelling the user typed. The resolved class is therefore
 * `max(pre_fold, folded)` on the restrictiveness lattice by construction:
 * folding can only ever add restriction, never remove it. The visible cost is
 * that a nested loosening does not cross spellings, which is the direction LLP
 * 0049 §fail-safe picks.
 *
 * This is the same shape PR #482 arrived at for symlink canonicalization, for
 * the same reason. Neither branch depends on the other; whichever lands second
 * should collapse the two into one pass over one spelling set rather than keep
 * two.
 *
 * @ref LLP 0050#normalization [implements]: a folded spelling only ever adds restriction, entry side included
 * @ref LLP 0049#fail-safe [constrained-by]: a widened reach must resolve to "suppress more", never to "starts forwarding"
 * @param {string} cwd absolute, already `path.resolve`d
 * @param {readonly ListScope[]} scopes
 * @param {(cwd: string, declaredClass: UsageClass | null, foldedClass: UsageClass) => void} [onTightened]
 * @returns {{ entry: LocalOnlyEntry, depth: number } | null}
 */
function selectGoverning(cwd, scopes, onTightened) {
  const asDeclared = deepestMatch(cwd, scopes, false)
  const folded = deepestMatch(cwd, scopes, true)
  const declaredRank = asDeclared === null ? CLASS_RANK.full : CLASS_RANK[asDeclared.entry.class]
  if (folded !== null && CLASS_RANK[folded.entry.class] > declaredRank) {
    if (onTightened) onTightened(cwd, asDeclared === null ? null : asDeclared.entry.class, folded.entry.class)
    return folded
  }
  return asDeclared ?? folded
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
