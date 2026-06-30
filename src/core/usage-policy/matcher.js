// @ts-check

import nodeFs from 'node:fs'
import path from 'node:path'

import { parseHypignore } from './format.js'

/**
 * @import { ResolveResult, UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 */

const HYPIGNORE_FILENAME = '.hypignore'

// How long a resolved `cwd` is trusted before its ancestor walk is re-run. A
// short TTL keeps the capture hot path bounded (at most one walk per cwd per
// window, R6) while bounding staleness the other way: a long-lived daemon
// resolver that cached a cwd as `full` picks up a newly written `.hypignore`
// within this window instead of never, until restart (R1). The value is the
// interim leak bound; a future CLI-to-daemon signal would drive it to zero.
const CACHE_TTL_MS = 5_000

/**
 * Create a usage-policy resolver: given an exchange's `cwd`, walk ancestor
 * directories to the nearest `.hypignore` and resolve it to a usage class.
 *
 * Because V1 has only the `ignore` class and no un-ignore directive, the walk
 * collapses to "any `.hypignore` found walking up from a `cwd` governs". The
 * resolver is `cwd`-agnostic path logic only: it never inspects rows, so only
 * the calling adapter need know which field carries the `cwd`.
 *
 * Results are memoized per absolute `cwd` with a short TTL, so the capture hot
 * path does at most one ancestor walk per `cwd` per TTL window (R6) rather than
 * one per exchange. The TTL also bounds staleness: a long-lived daemon resolver
 * that cached a `cwd` as `full` re-walks once the entry expires, so a
 * `.hypignore` written (or removed) mid-run is honored within the TTL instead
 * of only after a daemon restart (R1). `hyp ignore --check` still constructs a
 * fresh resolver, so it always reflects disk immediately.
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
 * @param {object} [deps]
 * @param {(path: string, encoding: 'utf8') => string} [deps.readFileSync]
 * @param {(path: string) => boolean} [deps.existsSync]
 * @param {() => number} [deps.now] injectable clock in ms; defaults to Date.now
 * @param {number} [deps.ttlMs] cache entry lifetime in ms; defaults to CACHE_TTL_MS
 * @returns {UsagePolicyResolver}
 */
export function createUsagePolicyResolver({
  readFileSync = nodeFs.readFileSync,
  existsSync = nodeFs.existsSync,
  now = Date.now,
  ttlMs = CACHE_TTL_MS,
} = {}) {
  /** @type {Map<string, { result: ResolveResult, expiresAt: number }>} */
  const cache = new Map()

  /**
   * @param {string} cwd
   * @returns {ResolveResult}
   */
  function resolve(cwd) {
    const key = path.resolve(cwd)
    const at = now()
    const cached = cache.get(key)
    if (cached && cached.expiresAt > at) return cached.result
    const result = walk(key)
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
   * @param {string} cwd
   * @returns {boolean}
   */
  function isIgnored(cwd) {
    return resolve(cwd).class === 'ignore'
  }

  return { resolve, isIgnored }
}
