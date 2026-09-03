// @ts-check

import { createHash } from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'

import { Attr } from '../observability/attrs.js'
import { getLogger } from '../observability/logger.js'

import { canonicalSpellings } from './canonical.js'
import { createVolumeCaseProbe, foldPath, hashPath, sameDirectoryOnDisk } from './fold.js'
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
// recorded, moot at the export seam, but total for completeness) beats
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
 * optionally merged with a second source, the machine-local `local-only`
 * directory list (LLP 0071), when `localOnlyListPath` is supplied.
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
 * denote a directory, never over one chosen spelling. A filesystem hands out
 * those spellings by two independent mechanisms, and the resolver folds both:
 * symlinks, resolved by {@link canonicalSpellings} into a set of strings (see
 * there for why the set, not the canonical form alone, is the privacy-preserving
 * choice), and Unicode normalization plus per-volume case, resolved by
 * {@link foldPath} into one folded image of each of those strings. Neither can
 * remove a spelling the other produced, and the merge across spellings takes the
 * most restrictive verdict, so the composition can only ever move the gate
 * toward more restrictive.
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
 * @ref LLP 0050#normalization [implements]: list membership compares folded spellings, so an NFC/NFD divergence between two processes does not open the gate
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
  realpathSync = nodeFs.realpathSync,
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
   * Resolve `cwd` over every spelling that denotes it, returning the most
   * restrictive verdict any spelling produces.
   *
   * The cache is keyed on the *lexical* path and consulted before any
   * canonicalization or folding, so a hit costs exactly what it did before
   * either existed: the `realpath` syscall and the fold happen once per distinct
   * `cwd` per TTL window, the same bound LLP 0049 R6 already sets for the
   * ancestor walk, not once per recorded exchange.
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
   * equals-or-contains `cwd`: symlink-resolved as well as declared, and each of
   * those folded (Unicode-normalized, and case-folded on a volume probed
   * case-insensitive). So an entry declared by a symlink spelling still governs
   * the real directory and vice versa, and an entry declared NFC still governs a
   * `cwd` that arrives NFD. Specificity is measured on the spelling that
   * actually matched, so nested entries still resolve nearest-governs regardless
   * of which spelling each was declared with. Widening an entry's reach must not
   * *loosen* the list, which is what {@link selectGoverning} guarantees.
   *
   * @ref LLP 0071 [implements]: segment-aware equal-or-descendant list membership, second resolver source
   * @ref LLP 0050#canonicalization [implements]: an entry governs through any spelling of its declared directory
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
   * Structured signal for the one interesting outcome: the widened pass reached
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
   * The list entries paired with every spelling of each entry's declared
   * directory (symlink-resolved, then folded) and the case verdict for the
   * volume it lives on, computed once per TTL window along with the parse. So
   * resolving many `cwd`s in one window costs one `realpath` and one fold per
   * entry rather than one per entry per `cwd`.
   *
   * @param {number} at
   * @returns {ListScope[]}
   */
  function getListScopes(at) {
    if (listCache && listCache.expiresAt > at) return listCache.scopes
    const scopes = readListEntriesSync().map((entry) => listScope(entry, probeVolume, { realpathSync }))
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

  /**
   * Cheap stable digest of this resolver's mutable machine-local input: the
   * class-per-entry list file's bytes, hashed so no directory path leaves the
   * store. Distinct sentinels for "no list configured", "list absent", and
   * "list unreadable" so each transition reads as a change; the unreadable
   * sentinel errs toward firing a revalidation, matching the fail-safe
   * direction of the list readers above. Committable `.hypignore` dotfiles
   * are deliberately outside the digest: they are unenumerable, and the
   * consumer's age backstop covers them.
   *
   * @ref LLP 0367#policy-fingerprint [implements]: the usage-policy half of the export-policy fingerprint
   * @returns {string}
   */
  function fingerprint() {
    if (!localOnlyListPath) return 'no-list'
    if (!existsSync(localOnlyListPath)) return 'absent'
    try {
      const raw = String(readFileSync(localOnlyListPath, 'utf8'))
      return createHash('sha256').update(raw).digest('hex').slice(0, 16)
    } catch {
      return 'unreadable'
    }
  }

  return { resolve, isIgnored, fingerprint }
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
 * path logic), it needs the same equal-or-ancestor test to find which
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
 * The scope one machine-local entry occupies at the **gate**: its declared
 * spelling, the widened set (symlink-resolved *and* folded), and the case
 * verdict the `cwd` side has to be folded through to match it.
 *
 * The two widenings compose in exactly one direction, which is why the widened
 * set is a `map` and not a second set: `realpath` produces a *set* of strings
 * (as-given, canonical), while the fold is a *function* on a string, so the
 * widened set is the fold's image of the canonical set. Computing it here means
 * an entry is canonicalized and folded once per TTL window, not once per `cwd`.
 *
 * @ref LLP 0050#canonicalization [implements]: the entry side is a set of spellings, not one chosen string
 * @ref LLP 0050#normalization [implements]: each of those spellings is compared through the volume's fold
 * @param {LocalOnlyEntry} entry
 * @param {(dir: string) => boolean} probeVolume
 * @param {{ realpathSync?: (p: string) => string, component?: string }} deps
 * @returns {ListScope}
 */
function listScope(entry, probeVolume, deps) {
  const spellings = canonicalSpellings(entry.dir, deps)
  const caseInsensitive = probeVolume(entry.dir)
  return {
    entry,
    folded: true,
    caseInsensitive,
    declaredSpellings: [spellings[0]],
    widenedSpellings: spellings.map((spelling) => foldPath(spelling, { caseInsensitive })),
  }
}

/**
 * The same scope for a **one-shot CLI** call site: symlink-widened, deliberately
 * *not* folded.
 *
 * The asymmetry is the point, and it is a decision rather than an oversight.
 * Unconditional NFC folding is sound at the gate only because the gate's answer
 * is `max(declared, widened)` on the restrictiveness lattice, so a fold that
 * merges two genuinely distinct directories (which it does on Linux, where NFC
 * and NFD names are two inodes) can only ever over-suppress. That argument does
 * not survive the trip to a CLI verb: `policy unset` **removes an opt-out**
 * through {@link scopeGoverns}, and `sameDirectory` decides which stored
 * declaration to **replace**. In each of those, widening the match destroys
 * something the user did not name, so the fold's word alone does not buy it.
 *
 * `hyp purge` is the one call site that has bought it, and it did so without
 * relaxing this rule: {@link scopeGovernance}'s `proveAliases` mode uses the
 * fold only to *propose* a spelling and then requires `dev`/`ino` identity
 * before deleting through it. That proof is available because a purge compares
 * one pair of paths; it is not available to the verbs above, which ask about a
 * directory rather than about a pair, so they stay here.
 *
 * @ref LLP 0050#normalization [constrained-by]: "do not reuse foldPath as a verdict in a predicate where widening is not free"
 * @ref LLP 0104#spellings [constrained-by]: what it takes to widen a destructive predicate, and why only that one did
 * @param {LocalOnlyEntry} entry
 * @param {{ realpathSync?: (p: string) => string, component?: string }} deps
 * @returns {ListScope}
 */
function canonicalScope(entry, deps) {
  const spellings = canonicalSpellings(entry.dir, deps)
  return {
    entry,
    folded: false,
    caseInsensitive: false,
    declaredSpellings: [spellings[0]],
    widenedSpellings: spellings,
  }
}

/**
 * Length of the longest spelling in `dirSpellings` that equals-or-contains
 * `cwd`, or `null` when none does. The length stands in for specificity, the
 * same way the `.hypignore` walk's nearest-governs rule does; measuring it on
 * the *matched* spelling keeps nested entries ordered correctly even when they
 * were declared with different spellings of the same tree.
 *
 * The longest rather than the first, deliberately. Over symlink spellings alone
 * the two coincide, because two spellings of one directory can only both contain
 * the same `cwd` if one is a lexical ancestor of the other, the canonical form
 * can never be a strict lexical descendant of the as-given one (that would need
 * a symlink pointing inside itself, which `realpath` reports as `ELOOP`), and
 * `canonicalSpellings` puts the as-given form first. Folding breaks that: NFC is
 * length-reducing, so the folded image of the as-given spelling is not
 * necessarily the longer one any more. Taking the maximum makes the ordering
 * independent of how the spellings happen to be arranged.
 *
 * @param {string} cwd absolute, already `path.resolve`d
 * @param {readonly string[]} dirSpellings folded consistently with `cwd`
 * @returns {number | null}
 */
function matchDepth(cwd, dirSpellings) {
  /** @type {number | null} */
  let depth = null
  for (const dir of dirSpellings) {
    if (isEqualOrDescendant(cwd, dir) && (depth === null || dir.length > depth)) depth = dir.length
  }
  return depth
}

/**
 * The nearest-governs winner over `scopes`: the entry whose matched spelling is
 * the longest, ties broken by the more restrictive class.
 *
 * When `widened` is false this compares `cwd` against each entry's declared
 * spelling alone, unfolded, which is bit-for-bit the rule the matcher applied
 * before either widening existed. When it is true it compares `cwd` against the
 * scope's widened set, folding `cwd` through the same verdict that set was built
 * with, so an entry reaches every spelling the filesystem treats as the same
 * directory: a symlink always, and a Unicode or case respelling for a scope that
 * opted into the fold ({@link listScope} does, {@link canonicalScope} does not).
 *
 * @param {string} cwd absolute, already `path.resolve`d
 * @param {readonly ListScope[]} scopes
 * @param {boolean} widened
 * @returns {{ entry: LocalOnlyEntry, depth: number } | null}
 */
function deepestMatch(cwd, scopes, widened) {
  // `foldPath(cwd, { caseInsensitive: true })` is `foldPath(cwd)` lowered, so
  // each variant is computed at most once per call rather than once per entry,
  // and not at all for a scope set that does not fold.
  /** @type {string | null} */
  let nfcCwd = null
  /** @type {string | null} */
  let loweredCwd = null
  /** @type {{ entry: LocalOnlyEntry, depth: number } | null} */
  let best = null
  for (const scope of scopes) {
    let target = cwd
    let dirs = scope.declaredSpellings
    if (widened) {
      dirs = scope.widenedSpellings
      if (scope.folded) {
        nfcCwd ??= foldPath(cwd)
        target = scope.caseInsensitive ? (loweredCwd ??= nfcCwd.toLowerCase()) : nfcCwd
      }
    }
    const depth = matchDepth(target, dirs)
    if (depth === null) continue
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
 * The machine-local entry that governs `cwd`, over precomputed spellings.
 *
 * Nearest-governs alone is *not* monotone in the set of spellings an entry can
 * reach, and that is the one place widening the entry side could have made the
 * gate **less** restrictive than the plain string matcher it replaced. An
 * explicit `full` (or merely less restrictive) entry that gains reach through a
 * widened spelling can become the deepest match and so displace a broader
 * restrictive entry that already governed: a carve-out declared under one
 * spelling would punch a hole in a private tree declared under the other, and
 * the directory would start recording and forwarding. Nothing about "resolve
 * over a set of spellings" prevents that on its own, because the
 * argmax-over-depth step in the middle discards verdicts rather than merging
 * them.
 *
 * This is one guard for both widenings, and it has to be, because they compose:
 * an entry reaches `cwd` through a symlink (LLP 0050 §canonicalization), through
 * a Unicode or case respelling (§normalization), or through both at once, and
 * the displacement hazard is identical in each case. So the rule is run twice -
 * once over the declared spellings alone, unfolded (exactly what the matcher
 * decided before either widening existed) and once over the widened, folded set
 * - and the more restrictive of the two answers wins, the declared one breaking
 * a class tie because it is the spelling the user typed. The resolved class is
 * therefore `max(pre_widening, widened)` on the restrictiveness lattice by
 * construction: widening an entry's reach can only ever add restriction, never
 * remove it, which is the fail-toward-privacy property both sections claim. The
 * visible cost is that a nested loosening does not cross spellings, which is the
 * direction LLP 0049 §fail-safe picks.
 *
 * Note the exact reach of the guard: it preserves a verdict the **declared**
 * pass produced, so it blocks a cross-spelling loosening only when the broader
 * restrictive entry matches `cwd` by its own declared, unfolded spelling. If
 * that entry reaches `cwd` only through a widening, the declared pass matches
 * nothing and plain nearest-governs picks between entries that are all in the
 * widened namespace, so a deeper carve-out wins. That is still never a
 * demotion: the pre-widening matcher matched neither entry in that shape either.
 *
 * @ref LLP 0050#canonicalization [implements]: canonicalization only ever moves the gate toward more restrictive, entry side included
 * @ref LLP 0050#normalization [implements]: a folded spelling only ever adds restriction, entry side included
 * @ref LLP 0049#fail-safe [constrained-by]: a widened reach must resolve to "suppress more", never to "starts forwarding"
 * @param {string} cwd absolute, already `path.resolve`d
 * @param {readonly ListScope[]} scopes
 * @param {(cwd: string, declaredClass: UsageClass | null, widenedClass: UsageClass) => void} [onTightened]
 * @returns {{ entry: LocalOnlyEntry, depth: number } | null}
 */
function selectGoverning(cwd, scopes, onTightened) {
  const asDeclared = deepestMatch(cwd, scopes, false)
  const widened = deepestMatch(cwd, scopes, true)
  const declaredRank = asDeclared === null ? CLASS_RANK.full : CLASS_RANK[asDeclared.entry.class]
  if (widened !== null && CLASS_RANK[widened.entry.class] > declaredRank) {
    if (onTightened) onTightened(cwd, asDeclared === null ? null : asDeclared.entry.class, widened.entry.class)
    return widened
  }
  return asDeclared ?? widened
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
 * Symlink-widened but **not folded**, unlike the gate: see
 * {@link canonicalScope} for why the fold stops at the gate.
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
  const scopes = entries.map((entry) => canonicalScope(entry, deps))
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
 * Symlink-widened always; folded only for a caller that passes
 * `proveAliases` and can therefore afford the `stat` pair that makes a folded
 * match safe (see {@link scopeGovernance}). Without it this is bit-for-bit the
 * unfolded predicate `canonicalScope` describes.
 *
 * Does up to two `realpath` calls, so callers on a per-row loop should memoize
 * per distinct path (`src/core/cache/purge.js` does).
 *
 * @ref LLP 0069#requirements [implements]: R8, one shared equal-or-descendant test, now spelling-agnostic
 * @ref LLP 0050#canonicalization [implements]: CLI membership answers agree with the gate's verdict
 * @ref LLP 0050#normalization [constrained-by]: a deletion predicate never widens for free; `proveAliases` buys the widening with a `dev`/`ino` proof
 * @param {string} cwd
 * @param {string} dir
 * @param {{ realpathSync?: (p: string) => string, statSync?: (p: string) => { dev: number, ino: number }, component?: string, proveAliases?: boolean }} [deps]
 * @returns {boolean}
 */
export function scopeGoverns(cwd, dir, deps = {}) {
  return scopeGovernance(cwd, dir, deps) === 'governs'
}

/**
 * The full verdict {@link scopeGoverns} collapses into a boolean: does `dir`
 * govern `cwd` (`governs`), is `cwd` unrelated to it (`outside`), or is `cwd`
 * spelled as if it were inside `dir` on a volume that folds spellings, without
 * *this* filesystem confirming the two spellings are one directory (`aliased`)?
 * `aliased` is the absence of a proof, not a proof of difference. It covers
 * three distinct situations and only the first is the filesystem adjudicating:
 * a live pair with two inodes; a spelling that is no longer on disk, so the
 * `stat` landed on nothing; and a spelling that could not be `stat`ed at all,
 * because {@link sameDirectoryOnDisk} answers `false` for *every* error and not
 * only for `ENOENT`, so an `EACCES` on an ancestor, an `ELOOP` or an `ENOTDIR`
 * arrive here too. A caller rendering this verdict must therefore claim neither
 * that the filesystem adjudicated (only the first gave a verdict) nor that the
 * spelling is gone (only the second says so); `src/core/commands/purge.js` names
 * all three, and LLP 0104 #spellings records why an enumeration that stops at
 * two is making the same unearned claim the report exists to avoid.
 *
 * The third answer is the point, and it exists because `hyp purge` deletes. At
 * the gate, folding two spellings together is free: the resolved class is
 * `max(declared, folded)`, so a fold that merges two genuinely distinct
 * directories can only over-suppress. In a deletion predicate the same fold
 * destroys rows for a directory the user never named, and on every ext4 volume
 * `caf` + U+00E9 and `cafe` + U+0301 (or `Proj` and `proj`) genuinely *are* two
 * directories. So the fold here is only a **candidate generator**: it proposes
 * the prefix of `cwd` that a spelling-insensitive volume would fold onto `dir`,
 * and {@link sameDirectoryOnDisk} decides, by `dev`/`ino`, whether that prefix
 * and `dir` are one directory. `governs` is therefore returned only for a
 * subtree relation the filesystem itself asserts, which makes over-deletion
 * structurally unreachable rather than merely unlikely: the widening never
 * rests on a rule about strings.
 *
 * When the proof fails the answer is `aliased` rather than `outside`, so the
 * caller can say so. A purge that retains rows under a lookalike spelling is
 * indistinguishable from one that found nothing (LLP 0104 §spellings), and that
 * silence is the actual complaint: reporting the near-miss is what turns a
 * quiet non-deletion into a stated one.
 *
 * The candidate generator folds case **unconditionally**, with no volume probe.
 * That is not the probe's job here: the probe exists to keep an *unproven* case
 * fold from widening, and nothing widens on a proposal alone at this seam. On a
 * case-sensitive volume the proposal is simply refused by `dev`/`ino`, which is
 * the same verdict the probe would have produced, reached from the actual pair
 * rather than from a synthesized flip of a different path.
 *
 * Cost is bounded by the lexical answer: the fold runs only when plain
 * canonical matching already said no, and the `stat` pair runs only when the
 * fold proposes something, so a cache whose rows are all inside or all far
 * outside the target issues no extra syscall at all.
 *
 * @ref LLP 0050#normalization [implements]: the one shared predicate folds for purge too, with the fold proposing and the filesystem disposing
 * @ref LLP 0104#spellings [implements]: purge deletes an aliased spelling it can prove, and names one it cannot
 * @param {string} cwd
 * @param {string} dir
 * @param {{ realpathSync?: (p: string) => string, statSync?: (p: string) => { dev: number, ino: number }, component?: string, proveAliases?: boolean }} [deps]
 * @returns {'governs' | 'aliased' | 'outside'}
 */
export function scopeGovernance(cwd, dir, deps = {}) {
  const dirSpellings = canonicalSpellings(dir, deps)
  const cwdSpellings = canonicalSpellings(cwd, deps)
  if (cwdSpellings.some((spelling) => matchDepth(spelling, dirSpellings) !== null)) return 'governs'
  if (!deps.proveAliases) return 'outside'

  let aliased = false
  for (const spelling of cwdSpellings) {
    for (const base of dirSpellings) {
      const alias = foldedAliasOf(spelling, base)
      if (alias === null) continue
      if (sameDirectoryOnDisk(alias, base, deps)) return 'governs'
      aliased = true
    }
  }
  return aliased ? 'aliased' : 'outside'
}

/**
 * The prefix of `cwd` that a volume folding Unicode normalization and case
 * would treat as `dir`, or `null` when no such fold makes `cwd` a descendant of
 * `dir`.
 *
 * Two properties of {@link foldPath} carry this. It **distributes over the path
 * separator**, so a folded segment-aware prefix match implies the unfolded
 * prefix is a fold-equal spelling of `dir` (a sibling like `caf` + U+00E9 +
 * `-other` still fails the match, because the segment boundary survives the
 * fold). And it **preserves segment count**, since neither NFC nor
 * `toLowerCase` creates or removes a `/`, so the matching prefix can be cut
 * from the unfolded `cwd` by counting segments; character offsets could not be
 * used, because NFC is length-reducing.
 *
 * Returns `null` rather than `dir` itself when the prefix already equals `dir`:
 * that is the plain lexical relation the caller tested first, so proposing it
 * again would only buy a redundant `stat` pair.
 *
 * @param {string} cwd absolute, already `path.resolve`d
 * @param {string} dir absolute, already `path.resolve`d
 * @returns {string | null}
 */
function foldedAliasOf(cwd, dir) {
  const opts = { caseInsensitive: true }
  if (!isEqualOrDescendant(foldPath(cwd, opts), foldPath(dir, opts))) return null
  const segments = dir.split(path.sep).length
  const parts = cwd.split(path.sep)
  if (parts.length < segments) return null
  const alias = parts.slice(0, segments).join(path.sep)
  return alias === dir ? null : alias
}

/**
 * True when two paths denote the same directory, i.e. they share a spelling.
 * The identity a stored `local-only`/`ignore`/`full` entry is upserted on, so
 * re-marking a directory through a different spelling updates its class rather
 * than adding a second governor for the same directory.
 *
 * Symlink-widened but **not folded**: see {@link canonicalScope}. Widening this
 * one merges two stored entries into one, which silently drops a class the user
 * declared, so it is not free either.
 *
 * @ref LLP 0050#canonicalization [implements]: entry identity is the directory, not the string
 * @ref LLP 0050#normalization [constrained-by]: the fold stops at the gate; merging two declarations is not free
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
