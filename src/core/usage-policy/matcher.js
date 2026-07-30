// @ts-check

import nodeFs from 'node:fs'
import path from 'node:path'

import { canonicalSpellings } from './canonical.js'
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
 * Both sides of every comparison are resolved over the *set* of spellings that
 * denote a directory (as-given/lexical plus canonical), never over one chosen
 * spelling: see {@link canonicalSpellings} for why the set, not the canonical
 * form alone, is the privacy-preserving choice.
 *
 * fs, the clock, and the TTL are injected for tests; fs defaults to `node:fs`,
 * the clock to `Date.now`, and the TTL to `CACHE_TTL_MS`.
 *
 * @ref LLP 0050 [implements]: the single shared matcher for all four adapter call sites; no per-adapter copies
 * @ref LLP 0050#canonicalization [implements]: one `realpath` per cache miss, inside the existing TTL, on both sides of the comparison
 * @ref LLP 0049#scope [implements]: gitignore-style ancestor walk from cwd, nearest .hypignore wins; per-cwd cache (R6)
 * @ref LLP 0052#matcher [implements]: bounded-TTL staleness so a mid-run .hypignore is honored without a daemon restart
 * @ref LLP 0070#resolver [implements]: one shared resolver, two sources, most-restrictive class wins
 * @ref LLP 0071 [implements]: the machine-local list is the second source
 * @param {object} [deps]
 * @param {(path: string, encoding: 'utf8') => string} [deps.readFileSync]
 * @param {(path: string) => boolean} [deps.existsSync]
 * @param {(path: string) => string} [deps.realpathSync] symlink canonicalizer;
 *   defaults to `node:fs`. Failure is expected and handled (see
 *   `canonicalizeDirSync`), so an injected fs need not supply one.
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
  realpathSync = nodeFs.realpathSync,
  now = Date.now,
  ttlMs = CACHE_TTL_MS,
  localOnlyListPath,
} = {}) {
  /** @type {Map<string, { result: ResolveResult, expiresAt: number }>} */
  const cache = new Map()
  /** @type {{ scopes: { entry: LocalOnlyEntry, spellings: string[] }[], expiresAt: number } | null} */
  let listCache = null

  /**
   * Resolve `cwd` over every spelling that denotes it, returning the most
   * restrictive verdict any spelling produces.
   *
   * The cache is keyed on the *lexical* path, so a hit costs no `realpath` at
   * all: the canonicalization syscall happens once per distinct `cwd` per TTL
   * window, the same bound LLP 0049 R6 already sets for the ancestor walk, not
   * once per recorded exchange.
   *
   * @param {string} cwd
   * @returns {ResolveResult}
   */
  function resolve(cwd) {
    const key = path.resolve(cwd)
    const at = now()
    const cached = cache.get(key)
    if (cached && cached.expiresAt > at) return cached.result
    /** @type {ResolveResult | null} */
    let result = null
    for (const spelling of canonicalSpellings(key, { realpathSync })) {
      const dotfileResult = walk(spelling)
      const listResult = localOnlyListPath ? matchList(spelling, at) : null
      const merged = mostRestrictive(dotfileResult, listResult)
      result = result === null ? merged : mostRestrictive(result, merged)
    }
    cache.set(key, { result: /** @type {ResolveResult} */ (result), expiresAt: at + ttlMs })
    return /** @type {ResolveResult} */ (result)
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
   * An entry governs `cwd` when *any* spelling of the entry's directory
   * equals-or-contains `cwd`, so an entry declared by a symlink spelling still
   * governs the real directory and vice versa. Specificity is measured on the
   * spelling that actually matched, so nested entries still resolve
   * nearest-governs regardless of which spelling each was declared with.
   * Widening an entry's reach must not *loosen* the list, which is what
   * {@link selectGoverning} guarantees.
   *
   * @ref LLP 0071 [implements]: segment-aware equal-or-descendant list membership, second resolver source
   * @ref LLP 0050#canonicalization [implements]: an entry governs through any spelling of its declared directory
   * @ref LLP 0103 [implements]: the entry's own class governs, not a hardcoded `local-only`
   * @param {string} cwd absolute, already `path.resolve`d
   * @param {number} at current clock reading (ms)
   * @returns {ResolveResult | null} `null` when nothing in the list governs `cwd`
   */
  function matchList(cwd, at) {
    const governing = selectGoverning(cwd, getListScopes(at))
    if (governing === null) return null
    return {
      class: governing.entry.class,
      governedBy: /** @type {string} */ (localOnlyListPath),
      declared: governing.entry.class,
    }
  }

  /**
   * The list entries paired with every spelling of each entry's declared
   * directory, computed once per TTL window along with the parse, so resolving
   * many `cwd`s in one window costs one `realpath` per entry rather than one per
   * entry per `cwd`.
   *
   * @param {number} at
   * @returns {{ entry: LocalOnlyEntry, spellings: string[] }[]}
   */
  function getListScopes(at) {
    if (listCache && listCache.expiresAt > at) return listCache.scopes
    const scopes = readListEntriesSync().map((entry) => ({
      entry,
      spellings: canonicalSpellings(entry.dir, { realpathSync }),
    }))
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
 * Length of the spelling in `dirSpellings` that equals-or-contains `cwd`, or
 * `null` when none does. The length stands in for specificity, the same way the
 * `.hypignore` walk's nearest-governs rule does; measuring it on the *matched*
 * spelling keeps nested entries ordered correctly even when they were declared
 * with different spellings of the same tree.
 *
 * Returning the first match rather than the longest is not a shortcut: two
 * spellings of one directory can only both contain the same `cwd` if one is a
 * lexical ancestor of the other, and the canonical form can never be a strict
 * lexical descendant of the as-given form (that would need a symlink pointing
 * inside itself, which `realpath` reports as `ELOOP`). So when both match, the
 * as-given spelling - which `canonicalSpellings` puts first - is the longer one.
 *
 * @param {string} cwd absolute, already `path.resolve`d
 * @param {readonly string[]} dirSpellings ordered as-given first
 * @returns {number | null}
 */
function matchDepth(cwd, dirSpellings) {
  for (const dir of dirSpellings) {
    if (isEqualOrDescendant(cwd, dir)) return dir.length
  }
  return null
}

/**
 * The nearest-governs winner over `scopes`: the entry whose matched spelling is
 * the longest, ties broken by the more restrictive class. `spellingLimit` caps
 * how many of each entry's spellings may match, so the same rule can be run
 * over the declared spellings alone or over the widened set.
 *
 * @param {string} cwd absolute, already `path.resolve`d
 * @param {readonly { entry: LocalOnlyEntry, spellings: readonly string[] }[]} scopes
 * @param {number} spellingLimit
 * @returns {{ entry: LocalOnlyEntry, depth: number } | null}
 */
function deepestMatch(cwd, scopes, spellingLimit) {
  /** @type {{ entry: LocalOnlyEntry, depth: number } | null} */
  let best = null
  for (const { entry, spellings } of scopes) {
    const depth = matchDepth(cwd, spellingLimit >= spellings.length ? spellings : spellings.slice(0, spellingLimit))
    if (depth === null) continue
    if (
      best === null ||
      depth > best.depth ||
      (depth === best.depth && CLASS_RANK[entry.class] > CLASS_RANK[best.entry.class])
    ) {
      best = { entry, depth }
    }
  }
  return best
}

/**
 * The machine-local entry that governs `cwd`, over precomputed spellings.
 *
 * Nearest-governs alone is *not* monotone in the set of spellings, which is the
 * one place canonicalization could have made the gate **less** restrictive than
 * the lexical matcher it replaced. An explicit `full` (or merely less
 * restrictive) entry that gains reach through its canonical spelling can become
 * the deepest match and so displace a broader restrictive entry that already
 * governed: a carve-out declared under one spelling would punch a hole in a
 * private tree declared under the other, and the directory would start
 * recording and forwarding. Nothing about "resolve over a set of spellings"
 * prevents that on its own, because the argmax-over-depth step in the middle
 * discards verdicts rather than merging them.
 *
 * So the rule is run twice - once over the declared spellings alone (exactly
 * what the pre-canonicalization matcher decided) and once over the widened set
 * - and the more restrictive of the two answers wins, the declared one breaking
 * a class tie because it is the spelling the user typed. Widening an entry's
 * reach can then only ever add restriction, never remove it, which is the
 * fail-toward-privacy property LLP 0050 §canonicalization claims and the reason
 * a nested loosening deliberately does not cross spellings.
 *
 * @ref LLP 0050#canonicalization [implements]: canonicalization only ever moves the gate toward more restrictive, entry side included
 * @ref LLP 0049#fail-safe [constrained-by]: a widened reach must resolve to "suppress more", never to "starts forwarding"
 * @param {string} cwd absolute, already `path.resolve`d
 * @param {readonly { entry: LocalOnlyEntry, spellings: readonly string[] }[]} scopes
 * @returns {{ entry: LocalOnlyEntry, depth: number } | null}
 */
function selectGoverning(cwd, scopes) {
  const asDeclared = deepestMatch(cwd, scopes, 1)
  const widened = deepestMatch(cwd, scopes, Number.POSITIVE_INFINITY)
  if (asDeclared === null) return widened
  if (widened === null) return asDeclared
  return CLASS_RANK[widened.entry.class] > CLASS_RANK[asDeclared.entry.class] ? widened : asDeclared
}

/**
 * Which stored machine-local entry governs `dir`, by the identical rule
 * `resolve()` applies (spelling-agnostic membership, nearest-governs,
 * most-restrictive-wins across both the declared and the widened reach, then
 * across the spellings of `dir` itself), or `null` when none does.
 *
 * Exported because a CLI verb that has already been told "the machine-local
 * store governs this" still has to name *which* entry, for display and for
 * scoping the residual row count. Re-deriving that choice at the call site is
 * how `--check` / `policy show` ends up naming an entry the gate did not use
 * (R8: one shared thing, not a second copy of the selection rule).
 *
 * Does up to two `realpath` calls per entry plus two for `dir`, so it is for
 * one-shot CLI use, not a per-row loop.
 *
 * @ref LLP 0069#requirements [implements]: R8, the governing-entry choice is shared, not re-derived per call site
 * @ref LLP 0050#canonicalization [implements]: the CLI names the entry the gate actually used
 * @param {string} dir
 * @param {readonly LocalOnlyEntry[]} entries
 * @param {{ realpathSync?: (p: string) => string, component?: string }} [deps]
 * @returns {LocalOnlyEntry | null}
 */
export function governingListEntry(dir, entries, deps = {}) {
  const scopes = entries.map((entry) => ({ entry, spellings: canonicalSpellings(entry.dir, deps) }))
  /** @type {{ entry: LocalOnlyEntry, depth: number } | null} */
  let best = null
  for (const spelling of canonicalSpellings(dir, deps)) {
    const found = selectGoverning(spelling, scopes)
    if (found === null) continue
    if (best === null || CLASS_RANK[found.entry.class] > CLASS_RANK[best.entry.class]) best = found
  }
  return best === null ? null : best.entry
}

/**
 * Canonical-aware {@link isEqualOrDescendant}: true when *any* spelling of
 * `cwd` equals or descends *any* spelling of `dir`.
 *
 * This is the predicate a CLI verb wants when it asks "which stored entry
 * governs this directory?", because the answer has to agree with what
 * `resolve()` just decided; a lexical-only answer makes `hyp policy show` name
 * a governor the gate did not use, and makes `policy unset` refuse to remove an
 * entry the gate is enforcing. `isEqualOrDescendant` stays lexical and pure for
 * callers that are comparing two already-canonical strings and must not touch
 * the filesystem.
 *
 * Does up to two `realpath` calls, so callers on a per-row loop should memoize
 * per distinct path (`src/core/cache/purge.js` does).
 *
 * @ref LLP 0069#requirements [implements]: R8, one shared equal-or-descendant test, now spelling-agnostic
 * @ref LLP 0050#canonicalization [implements]: CLI membership answers agree with the gate's verdict
 * @param {string} cwd
 * @param {string} dir
 * @param {{ realpathSync?: (p: string) => string, component?: string }} [deps]
 * @returns {boolean}
 */
export function scopeGoverns(cwd, dir, deps = {}) {
  const dirSpellings = canonicalSpellings(dir, deps)
  return canonicalSpellings(cwd, deps).some((spelling) => matchDepth(spelling, dirSpellings) !== null)
}

/**
 * True when two paths denote the same directory, i.e. they share a spelling.
 * The identity a stored `local-only`/`ignore`/`full` entry is upserted on, so
 * re-marking a directory through a different spelling updates its class rather
 * than adding a second governor for the same directory.
 *
 * @ref LLP 0050#canonicalization [implements]: entry identity is the directory, not the string
 * @param {string} a
 * @param {string} b
 * @param {{ realpathSync?: (p: string) => string, component?: string }} [deps]
 * @returns {boolean}
 */
export function sameDirectory(a, b, deps = {}) {
  const bSpellings = canonicalSpellings(b, deps)
  return canonicalSpellings(a, deps).some((spelling) => bSpellings.includes(spelling))
}

/**
 * Merge two verdicts, returning whichever is strictly more restrictive
 * (`ignore` > `local-only` > `full`); a tie (e.g. both `local-only`) keeps
 * `preferred`, which is the more specific, already-computed answer.
 *
 * Used for both merges the resolver performs: the `.hypignore` walk against the
 * list-membership result (`preferred` = the dotfile walk), and one spelling's
 * verdict against the next spelling's (`preferred` = the earlier, as-given
 * spelling, so a tie reports the governor the user would recognize).
 *
 * @ref LLP 0070#resolver [implements]: most-restrictive-wins merge of the two sources
 * @ref LLP 0050#canonicalization [implements]: also the merge across spellings, so the union can only be more restrictive
 * @param {ResolveResult} preferred
 * @param {ResolveResult | null} other
 * @returns {ResolveResult}
 */
function mostRestrictive(preferred, other) {
  if (!other) return preferred
  if (CLASS_RANK[other.class] > CLASS_RANK[preferred.class]) return other
  if (CLASS_RANK[other.class] < CLASS_RANK[preferred.class]) return preferred
  // Tie (e.g. both `full`, or both `local-only`): `preferred` wins as the more
  // specific, already-computed answer - UNLESS it's the unrecorded implicit
  // default (`governedBy: null`) tying against a result that actually recorded
  // an explicit answer (LLP 0103's explicit `full` marker resolves identically
  // to "nothing governs" but must still name its governor, so the
  // classification hook can tell "asked; syncs" apart from "never asked").
  if (preferred.governedBy === null && other.governedBy !== null) return other
  return preferred
}
