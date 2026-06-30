// @ts-check

import nodeFs from 'node:fs'
import path from 'node:path'

import { parseHypignore } from './format.js'

/**
 * @import { ResolveResult, UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 */

const HYPIGNORE_FILENAME = '.hypignore'

/**
 * Create a usage-policy resolver: given an exchange's `cwd`, walk ancestor
 * directories to the nearest `.hypignore` and resolve it to a usage class.
 *
 * Because V1 has only the `ignore` class and no un-ignore directive, the walk
 * collapses to "any `.hypignore` found walking up from a `cwd` governs". The
 * resolver is `cwd`-agnostic path logic only: it never inspects rows, so only
 * the calling adapter need know which field carries the `cwd`.
 *
 * Results are memoized per absolute `cwd` so the capture hot path adds no
 * unbounded filesystem work. The cache is resolver-lifetime: hold one resolver
 * per daemon/backfill run; `hyp ignore --check` constructs a fresh resolver so
 * it always reflects disk.
 *
 * fs is injected for tests and defaults to `node:fs`.
 *
 * @ref LLP 0050 [implements]: the single shared matcher for all four adapter call sites; no per-adapter copies
 * @ref LLP 0049#scope [implements]: gitignore-style ancestor walk from cwd, nearest .hypignore wins; per-cwd cache (R6)
 * @param {object} [fs]
 * @param {(path: string, encoding: 'utf8') => string} [fs.readFileSync]
 * @param {(path: string) => boolean} [fs.existsSync]
 * @returns {UsagePolicyResolver}
 */
export function createUsagePolicyResolver({
  readFileSync = nodeFs.readFileSync,
  existsSync = nodeFs.existsSync,
} = {}) {
  /** @type {Map<string, ResolveResult>} */
  const cache = new Map()

  /**
   * @param {string} cwd
   * @returns {ResolveResult}
   */
  function resolve(cwd) {
    const key = path.resolve(cwd)
    const cached = cache.get(key)
    if (cached) return cached
    const result = walk(key)
    cache.set(key, result)
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
        return { class: parsed.class, governedBy: candidate, declared: parsed.declared }
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
