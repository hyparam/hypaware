import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * @import { CollectivusIgnoreConfig, IgnoreEvaluation } from './types.js'
 */

/**
 * Default location for the user-persistent ignore-paths file.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultIgnoreConfigPath(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.hyp', 'collectivus.json')
}

/**
 * Resolve a user-supplied path into a canonical key used everywhere ignore
 * paths are stored or compared. Strategy:
 *
 *  1. Make absolute against `cwd` if relative.
 *  2. Resolve symlinks via `realpath` when the path exists. Missing paths are
 *     still accepted (a user may pre-register a folder before creating it);
 *     they just skip symlink resolution.
 *  3. Strip a trailing path separator (root `/` is preserved).
 *
 * The output is a string suitable for comparison via `===` or as a Map key.
 *
 * @param {string} input
 * @param {{ cwd?: string }} [opts]
 * @returns {string}
 */
export function normalizeIgnorePath(input, opts = {}) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('path must be a non-empty string')
  }
  const baseRaw = opts.cwd ?? process.cwd()
  let base = baseRaw
  try {
    base = fs.realpathSync(baseRaw)
  } catch { /* keep raw base when it does not exist */ }
  const abs = path.isAbsolute(input) ? input : path.resolve(base, input)
  let resolved
  try {
    resolved = fs.realpathSync(abs)
  } catch {
    // realpath fails on a path whose final segment does not yet exist; walk
    // up to the deepest existing ancestor, canonicalize that, then re-append
    // the remaining segments so the output canonical-ness matches what we
    // would have produced had the leaf existed.
    resolved = realpathWithMissingTail(abs)
  }
  return stripTrailingSep(resolved)
}

/**
 * @param {string} abs Absolute path that may name a directory which is not
 *   yet created. Returns a best-effort canonical absolute path.
 * @returns {string}
 */
function realpathWithMissingTail(abs) {
  /** @type {string[]} */
  const tail = []
  let current = abs
  while (current !== path.parse(current).root) {
    try {
      const canonical = fs.realpathSync(current)
      return tail.length === 0 ? canonical : path.join(canonical, ...tail.reverse())
    } catch {
      tail.push(path.basename(current))
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return path.resolve(abs)
}

/**
 * Like `normalizeIgnorePath` but never blocks on the file system.
 *
 * @param {string} input
 * @param {{ cwd?: string }} [opts]
 * @returns {string}
 */
export function normalizeIgnorePathSync(input, opts = {}) {
  return normalizeIgnorePath(input, opts)
}

/**
 * Walk from `cwd` upward looking for a `.ctvsignore` file. Returns the
 * directory that contained the marker, or `undefined` when none was found.
 * The marker's content is intentionally unused in v1 — its mere presence is
 * the signal.
 *
 * Robust to missing or unreadable directories — any non-ENOENT stat error
 * stops the walk so a transient permission failure does not silently disable
 * the filter.
 *
 * @param {string} cwd Absolute, symlink-resolved directory path.
 * @param {{ statSync?: typeof fs.statSync }} [deps]
 * @returns {string | undefined}
 */
export function findCtvsIgnoreMarker(cwd, deps = {}) {
  const statSync = deps.statSync ?? fs.statSync
  let dir = stripTrailingSep(cwd)
  // Path.parse(dir).root is '/' on POSIX, 'C:\' on Windows; the loop stops
  // when we cannot ascend any further.
  let previous
  while (dir !== previous) {
    const marker = path.join(dir, '.ctvsignore')
    try {
      const stat = statSync(marker)
      if (stat.isFile()) return dir
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
      if (code !== 'ENOENT') return undefined
    }
    previous = dir
    dir = path.dirname(dir)
  }
  return undefined
}

/**
 * Stateful filter the proxy consults on every recorded request. Holds the
 * temporary session set, the user-persistent path list loaded from disk, and
 * a small ancestor-walk cache for `.ctvsignore`.
 *
 * Three lifetimes, evaluated in this precedence:
 *
 *  1. Temporary session set (in-memory, bounded FIFO).
 *  2. User-persistent paths from `~/.hyp/collectivus.json` `ignored_paths`.
 *  3. `.ctvsignore` walk-up from the request's `cwd`.
 *
 * Any hit short-circuits the filter and the row is dropped.
 */
export class IgnoreFilter {
  /**
   * @param {{
   *   configPath?: string,
   *   maxIgnoredSessions?: number,
   *   ctvsignoreCacheSize?: number,
   *   statSync?: typeof fs.statSync,
   * }} [opts]
   */
  constructor(opts = {}) {
    /** @type {string} */
    this.configPath = opts.configPath ?? defaultIgnoreConfigPath()
    /** @type {number} */
    this.maxIgnoredSessions = opts.maxIgnoredSessions ?? 1000
    /** @type {number} */
    this.ctvsignoreCacheSize = opts.ctvsignoreCacheSize ?? 512
    /**
     * Insertion-order Set; FIFO eviction when capacity is exceeded.
     * @type {Set<string>}
     */
    this.ignoredSessions = new Set()
    /**
     * Normalized absolute paths the user has marked ignored. Comparison is
     * `cwd === entry || cwd.startsWith(entry + sep)` so registering a
     * directory implicitly covers its descendants.
     * @type {Set<string>}
     */
    this.ignoredPaths = new Set()
    /**
     * Per-cwd cache of the most recent `.ctvsignore` walk-up.
     * Entries are invalidated when a new `conversationId` first appears for
     * the same `cwd` — effectively per-session re-resolution without a file
     * watcher.
     * @type {Map<string, { conversationId: string | undefined, hit: boolean }>}
     */
    this.ctvsignoreCache = new Map()
    /** @type {typeof fs.statSync} */
    this.statSync = opts.statSync ?? fs.statSync
    /** @type {boolean} */
    this.loaded = false
  }

  /**
   * Load `ignored_paths` from the on-disk config. Missing file is fine; the
   * filter just starts empty. Malformed JSON or a non-array `ignored_paths`
   * is also tolerated — bad config must never break recording — but a warning
   * is appended to the optional `stderr` writer so an operator notices.
   *
   * @param {{ stderr?: { write: (s: string) => void } }} [opts]
   * @returns {Promise<void>}
   */
  async load(opts = {}) {
    /** @type {string} */
    let raw
    try {
      raw = await fsp.readFile(this.configPath, 'utf8')
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
      if (code === 'ENOENT') {
        this.loaded = true
        return
      }
      opts.stderr?.write(`warning: failed to read ${this.configPath}: ${formatError(err)}\n`)
      this.loaded = true
      return
    }
    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      opts.stderr?.write(`warning: ${this.configPath} is not valid JSON: ${formatError(err)}\n`)
      this.loaded = true
      return
    }
    if (!parsed || typeof parsed !== 'object') {
      this.loaded = true
      return
    }
    const list = /** @type {Record<string, unknown>} */ (parsed).ignored_paths
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (typeof entry === 'string' && entry.length > 0) {
          this.ignoredPaths.add(stripTrailingSep(entry))
        }
      }
    }
    this.loaded = true
  }

  /**
   * Add `absPath` to the user-persistent set and write it back to disk.
   * The caller is responsible for normalization — the persisted form is the
   * normalized string.
   *
   * @param {string} absPath Pre-normalized via `normalizeIgnorePath`.
   * @returns {Promise<{ added: boolean }>}
   */
  async addPath(absPath) {
    if (!this.loaded) await this.load()
    const key = stripTrailingSep(absPath)
    const added = !this.ignoredPaths.has(key)
    this.ignoredPaths.add(key)
    if (added) await this._persist()
    return { added }
  }

  /**
   * Remove `absPath` from the user-persistent set.
   *
   * @param {string} absPath Pre-normalized via `normalizeIgnorePath`.
   * @returns {Promise<{ removed: boolean }>}
   */
  async removePath(absPath) {
    if (!this.loaded) await this.load()
    const key = stripTrailingSep(absPath)
    const removed = this.ignoredPaths.delete(key)
    if (removed) await this._persist()
    return { removed }
  }

  /**
   * @returns {string[]} Sorted alphabetically for stable CLI output.
   */
  listPaths() {
    return [...this.ignoredPaths].sort()
  }

  /**
   * Add `sessionId` to the in-memory temporary set. Bounded FIFO: when the
   * set reaches `maxIgnoredSessions` the oldest entry is evicted. Adding a
   * session already in the set re-inserts it at the tail so it stays the
   * "youngest" — matches the user's intent that re-issuing `/ctvs-ignore`
   * keeps the session ignored.
   *
   * @param {string} sessionId
   * @returns {{ total: number }}
   */
  addIgnoredSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('sessionId must be a non-empty string')
    }
    if (this.ignoredSessions.has(sessionId)) {
      this.ignoredSessions.delete(sessionId)
      this.ignoredSessions.add(sessionId)
      return { total: this.ignoredSessions.size }
    }
    this.ignoredSessions.add(sessionId)
    while (this.ignoredSessions.size > this.maxIgnoredSessions) {
      const oldest = this.ignoredSessions.values().next().value
      if (oldest === undefined) break
      this.ignoredSessions.delete(oldest)
    }
    return { total: this.ignoredSessions.size }
  }

  /**
   * @param {string} sessionId
   * @returns {{ removed: boolean, total: number }}
   */
  removeIgnoredSession(sessionId) {
    const removed = this.ignoredSessions.delete(sessionId)
    return { removed, total: this.ignoredSessions.size }
  }

  /**
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasIgnoredSession(sessionId) {
    return this.ignoredSessions.has(sessionId)
  }

  /**
   * @returns {string[]} Insertion order (oldest first).
   */
  listIgnoredSessions() {
    return [...this.ignoredSessions]
  }

  /**
   * Decide whether a request should be filtered out. Inputs are evaluated in
   * the documented precedence: temp session > user persistent path > ancestor
   * `.ctvsignore`. The first hit short-circuits.
   *
   * `cwd` may be undefined (no session-context registered) — in that case
   * only the session-id branch can fire.
   *
   * @param {{ sessionId?: string, cwd?: string, conversationId?: string }} input
   * @returns {boolean}
   */
  shouldDrop(input) {
    const { sessionId, cwd, conversationId } = input
    if (sessionId && this.ignoredSessions.has(sessionId)) return true
    if (cwd) {
      if (this._matchesIgnoredPath(cwd)) return true
      if (this._lookupCtvsIgnore(cwd, conversationId)) return true
    }
    return false
  }

  /**
   * Verbose breakdown of which mechanism caused the drop. Useful for
   * `--why`-style debugging and for tests that need to assert precedence.
   *
   * @param {{ sessionId?: string, cwd?: string, conversationId?: string }} input
   * @returns {IgnoreEvaluation}
   */
  evaluate(input) {
    const { sessionId, cwd, conversationId } = input
    if (sessionId && this.ignoredSessions.has(sessionId)) {
      return { drop: true, reason: 'session', match: sessionId }
    }
    if (cwd) {
      const pathHit = this._ignoredPathFor(cwd)
      if (pathHit !== undefined) {
        return { drop: true, reason: 'path', match: pathHit }
      }
      const markerDir = this._lookupCtvsIgnoreMarker(cwd, conversationId)
      if (markerDir !== undefined) {
        return { drop: true, reason: 'ctvsignore', match: markerDir }
      }
    }
    return { drop: false }
  }

  /**
   * Drop any cached `.ctvsignore` resolution for `cwd`. Used by tests and by
   * the daemon when a refresh is forced.
   *
   * @param {string} [cwd]
   * @returns {void}
   */
  invalidateCtvsignoreCache(cwd) {
    if (cwd === undefined) {
      this.ctvsignoreCache.clear()
      return
    }
    this.ctvsignoreCache.delete(stripTrailingSep(cwd))
  }

  /**
   * @returns {CollectivusIgnoreConfig}
   */
  snapshot() {
    return {
      ignored_paths: this.listPaths(),
      ignored_sessions: this.listIgnoredSessions(),
    }
  }

  /**
   * Persist the user-persistent path set back to `~/.hyp/collectivus.json`.
   * Merges into any existing JSON object so unrelated keys (proxy config,
   * upload config, …) are preserved.
   *
   * @returns {Promise<void>}
   */
  async _persist() {
    /** @type {Record<string, unknown>} */
    let existing = {}
    try {
      const raw = await fsp.readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = /** @type {Record<string, unknown>} */ (parsed)
      }
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
      if (code !== 'ENOENT') throw err
    }
    const next = { ...existing, ignored_paths: this.listPaths() }
    await fsp.mkdir(path.dirname(this.configPath), { recursive: true })
    const tmp = `${this.configPath}.tmp.${process.pid}.${Date.now()}`
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    await fsp.rename(tmp, this.configPath)
  }

  /**
   * @param {string} cwd Pre-normalized cwd from a session context.
   * @returns {boolean}
   */
  _matchesIgnoredPath(cwd) {
    return this._ignoredPathFor(cwd) !== undefined
  }

  /**
   * Return the ignored-path entry that covers `cwd`, or undefined when none.
   * A registered path matches itself and any descendant; matching is on
   * already-normalized strings so prefix comparison is exact.
   *
   * @param {string} cwd
   * @returns {string | undefined}
   */
  _ignoredPathFor(cwd) {
    if (!cwd) return undefined
    const target = stripTrailingSep(cwd)
    for (const entry of this.ignoredPaths) {
      if (target === entry) return entry
      if (target.startsWith(entry + path.sep)) return entry
    }
    return undefined
  }

  /**
   * @param {string} cwd
   * @param {string | undefined} conversationId
   * @returns {boolean}
   */
  _lookupCtvsIgnore(cwd, conversationId) {
    return this._lookupCtvsIgnoreMarker(cwd, conversationId) !== undefined
  }

  /**
   * Cached `findCtvsIgnoreMarker`. Cache key is the normalized cwd; entries
   * remember which conversationId populated them so a new conversation in
   * the same cwd re-resolves (the user may have added or removed a
   * `.ctvsignore` between sessions).
   *
   * @param {string} cwd
   * @param {string | undefined} conversationId
   * @returns {string | undefined} The directory containing `.ctvsignore`.
   */
  _lookupCtvsIgnoreMarker(cwd, conversationId) {
    const key = stripTrailingSep(cwd)
    const cached = this.ctvsignoreCache.get(key)
    if (cached && cached.conversationId === conversationId) {
      return cached.hit ? key : undefined
    }
    const markerDir = findCtvsIgnoreMarker(key, { statSync: this.statSync })
    // LRU-ish eviction: remove the oldest entry when cache is full.
    if (this.ctvsignoreCache.size >= this.ctvsignoreCacheSize) {
      const oldest = this.ctvsignoreCache.keys().next().value
      if (oldest !== undefined) this.ctvsignoreCache.delete(oldest)
    }
    this.ctvsignoreCache.set(key, { conversationId, hit: markerDir !== undefined })
    return markerDir
  }
}

/**
 * Strip exactly one trailing path separator, preserving root paths like `/`
 * and `C:\` so `path.dirname` doesn't ascend past them.
 *
 * @param {string} p
 * @returns {string}
 */
function stripTrailingSep(p) {
  if (p.length <= 1) return p
  if (p.endsWith(path.sep) && p !== path.parse(p).root) {
    return p.slice(0, -1)
  }
  return p
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
