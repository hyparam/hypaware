// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteFileSync } from '../util/fs_atomic.js'

/**
 * @import { Dirent } from 'node:fs'
 * @import { PluginLogger } from '../../../hypaware-plugin-kernel-types.js'
 */

const LOAD_ERROR = 'Session exclusions could not be loaded; capture is disabled. Repair the session-ignores store and restart HypAware.'

/**
 * How many leading transcript line uuids a fork fingerprint holds.
 *
 * Eight is enough that a forked transcript still shares one even if a future
 * client build prepends metadata lines to the copy, and small enough that the
 * whole record stays a few hundred bytes against the store's byte ceiling.
 * @ref LLP 0419#fingerprint [implements]
 */
export const FORK_FINGERPRINT_UUIDS = 8

/** An id marker: sha256 of the id's JSON encoding. */
const MARKER_FILE = /^[a-f0-9]{64}\.json$/

/**
 * A fork fingerprint, stored beside the marker for the same id. The marker
 * pattern above is anchored, so a fingerprint is never read as one: `load`
 * learns this name to count its bytes and refuse a damaged one, never to add
 * an id.
 */
const FINGERPRINT_FILE = /^[a-f0-9]{64}\.fingerprint\.json$/

/** `atomicWriteFileSync`'s temporary name, for either of the two above. */
const TMP_FILE = /^[a-f0-9]{64}(?:\.fingerprint)?\.json\.\d+\.[a-f0-9]+\.tmp$/

/**
 * What may appear inside a fingerprint. Transcript uuids are v4 hex with
 * dashes; the bound is deliberately narrow so nothing resembling conversation
 * text can be written into the privacy store by a client whose transcript
 * format drifted. A line whose `uuid` fails this is simply not fingerprinted.
 */
const FINGERPRINT_TOKEN = /^[A-Za-z0-9._:-]{8,128}$/

// @ref LLP 0403#storage [implements]: independent markers persist opt-outs;
// live membership checks remain ordinary Set lookups.
/** @extends {Set<string>} */
export class SessionIgnoreSet extends Set {
  /** @param {string} stateDir @param {PluginLogger} [log] */
  constructor(stateDir, log) {
    super()
    this.directory = path.join(stateDir, 'session-ignores')
    this.bytes = 0
    this.log = log
    /** @type {string | undefined} */
    this.loadError = undefined
    // @ref LLP 0403#storage [implements]: preserve routing when privacy state
    // cannot load. Capture seams refuse all content until a valid refresh.
    try { this.refresh() } catch { /* refresh records the failure */ }
  }

  /** Reload once before each backfill run, never per live message. */
  refresh() {
    try {
      this.load()
      this.loadError = undefined
    } catch {
      const firstFailure = !this.loadError
      this.loadError = LOAD_ERROR
      if (firstFailure) this.log?.error('session_ignore_load_failed', {
        component: 'session-ignore', operation: 'load', status: 'error',
        error_kind: 'session_ignore_load_failed',
      })
      throw new Error(LOAD_ERROR)
    }
  }

  load() {
    const loaded = new Set()
    let directory
    try {
      directory = fs.opendirSync(this.directory)
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        super.clear()
        this.bytes = 0
        return
      }
      throw error
    }
    let bytes = 0
    try {
      let entry
      while ((entry = directory.readSync())) {
        if (TMP_FILE.test(entry.name)) continue
        const fingerprint = FINGERPRINT_FILE.test(entry.name)
        if (!fingerprint && !MARKER_FILE.test(entry.name)) throw new Error('Invalid session exclusion filename')
        const file = path.join(this.directory, entry.name)
        const stat = fs.lstatSync(file)
        bytes += stat.size
        if (!stat.isFile() || stat.size > 64 * 1024 || bytes > 4 * 1024 * 1024 || loaded.size >= 10000) {
          throw new Error('session ignore store is invalid or exceeds its read limit')
        }
        // A fingerprint carries no id, so it never joins the drop set. It is
        // refused when damaged for the reason a damaged marker is: a
        // fingerprint that cannot be read is a fork that would be recorded.
        if (fingerprint) {
          if (!parseFingerprint(fs.readFileSync(file, 'utf8'))) {
            throw new Error('session ignore store contains an invalid fork fingerprint')
          }
          continue
        }
        const id = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (typeof id !== 'string' || !id.trim() || markerName(id) !== entry.name) {
          throw new Error('session ignore store contains an invalid exclusion')
        }
        loaded.add(id)
      }
    } finally {
      directory.closeSync()
    }
    super.clear()
    for (const id of loaded) super.add(id)
    this.bytes = bytes
  }

  /** @param {string} id */
  add(id) {
    if (this.loadError) throw new Error(this.loadError)
    const data = JSON.stringify(id)
    if (typeof id !== 'string' || !id.trim() || Buffer.byteLength(data) > 64 * 1024) {
      throw new Error('invalid session ignore id')
    }
    const extra = this.has(id) ? 0 : Buffer.byteLength(data)
    if ((!this.has(id) && this.size >= 10000) || this.bytes + extra > 4 * 1024 * 1024) {
      throw new Error('session ignore store is full')
    }
    // Save before changing memory or acknowledging. Repeated adds still write:
    // another recorder may have removed the marker since this snapshot loaded.
    atomicWriteFileSync(path.join(this.directory, markerName(id)), data, { mode: 0o600, dirMode: 0o700 })
    this.bytes += extra
    return super.add(id)
  }

  /**
   * Remove an exclusion: the id marker AND the fork fingerprint stored beside
   * it. Both go, because `unignore` means "record this conversation again" and
   * a surviving fingerprint would keep closing its forks after the user asked
   * for the opposite.
   * @ref LLP 0419#fingerprint [implements]: unignore removes both files
   * @param {string} id
   */
  delete(id) {
    if (this.loadError) throw new Error(this.loadError)
    const fingerprint = path.join(this.directory, fingerprintName(id))
    let freed = 0
    try { freed = fs.lstatSync(fingerprint).size } catch { /* none stored */ }
    fs.rmSync(path.join(this.directory, markerName(id)), { force: true })
    fs.rmSync(fingerprint, { force: true })
    const removed = super.delete(id)
    if (removed) freed += Buffer.byteLength(JSON.stringify(id))
    // Clamped: another process may have written the fingerprint since this
    // instance last loaded, so its bytes were never counted here, and an
    // undercount is the direction that lets the store grow past its ceiling.
    this.bytes = Math.max(0, this.bytes - freed)
    return removed
  }

  clear() {
    throw new Error('Remove session exclusions explicitly with session unignore')
  }
}

/** @param {string} id */
function markerName(id) {
  return `${sessionHash(id)}.json`
}

/** @param {string} id */
function fingerprintName(id) {
  return `${sessionHash(id)}.fingerprint.json`
}

/** @param {string} id */
function sessionHash(id) {
  return createHash('sha256').update(JSON.stringify(id)).digest('hex')
}

/**
 * Narrow raw fingerprint file content to the uuid list it must be, or
 * `undefined` when it is anything else. Shared by the loader (which refuses a
 * file this rejects) and the matcher (which skips one).
 *
 * @param {string} raw
 * @returns {string[] | undefined}
 */
function parseFingerprint(raw) {
  /** @type {unknown} */
  let parsed
  try { parsed = JSON.parse(raw) } catch { return undefined }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > FORK_FINGERPRINT_UUIDS) return undefined
  /** @type {string[]} */
  const out = []
  for (const value of parsed) {
    if (typeof value !== 'string' || !FINGERPRINT_TOKEN.test(value)) return undefined
    out.push(value)
  }
  return out
}

/**
 * Reduce transcript line uuids to what a fingerprint stores: the leading
 * `FORK_FINGERPRINT_UUIDS` distinct tokens that pass `FINGERPRINT_TOKEN`.
 *
 * @param {readonly string[]} uuids
 * @returns {string[] | undefined}
 */
function normalizeForkFingerprint(uuids) {
  /** @type {string[]} */
  const out = []
  for (const value of uuids) {
    if (typeof value !== 'string' || !FINGERPRINT_TOKEN.test(value) || out.includes(value)) continue
    out.push(value)
    if (out.length >= FORK_FINGERPRINT_UUIDS) break
  }
  return out.length > 0 ? out : undefined
}

/**
 * Record the fork fingerprint of an excluded session: the leading transcript
 * line uuids that a forked copy of that transcript carries unchanged.
 *
 * Written beside the id marker rather than into it, so every existing drop
 * path - each of which reads markers and nothing else - is untouched, and a
 * store written by an older build stays loadable by a newer one.
 *
 * @ref LLP 0419#fingerprint [implements]: the parent's own line uuids are the
 * only handle a Claude fork leaves behind
 * @param {string} stateDir
 * @param {string} id
 * @param {readonly string[]} uuids
 * @returns {boolean} whether a fingerprint was stored
 */
export function writeSessionForkFingerprint(stateDir, id, uuids) {
  if (typeof id !== 'string' || !id.trim()) return false
  const list = normalizeForkFingerprint(uuids)
  if (!list) return false
  // Overshooting the ceiling would not merely lose fork protection: the next
  // load would refuse the whole store and capture would stop everywhere. That
  // is what this walk, on the person-initiated opt-out path, buys.
  let bytes = Buffer.byteLength(JSON.stringify(list))
  walkExclusionDir(stateDir, (_entry, file) => {
    try { bytes += fs.lstatSync(file).size } catch { /* gone */ }
    return undefined
  })
  if (bytes > 4 * 1024 * 1024) return false
  atomicWriteFileSync(
    path.join(stateDir, 'session-ignores', fingerprintName(id)),
    JSON.stringify(list),
    { mode: 0o600, dirMode: 0o700 }
  )
  return true
}

/**
 * Is `id` excluded, answered from one `stat` rather than a full load?
 *
 * `SessionIgnoreSet` is the right reader for a recorder, which loads once and
 * then answers from memory. A client hook is the opposite: a fresh process per
 * event asking about exactly one id, so loading the whole store to answer
 * would put a directory walk on every hook invocation.
 *
 * @param {string} stateDir
 * @param {string} id
 * @returns {boolean}
 */
export function hasSessionIgnoreMarker(stateDir, id) {
  if (typeof id !== 'string' || !id.trim()) return false
  try {
    return fs.lstatSync(path.join(stateDir, 'session-ignores', markerName(id))).isFile()
  } catch {
    return false
  }
}

/**
 * Is any fork fingerprint stored at all? One bounded directory walk that stops
 * at the first hit, so a caller can skip reading a transcript on the common
 * path where nothing has ever been excluded.
 *
 * @param {string} stateDir
 * @returns {boolean}
 */
export function hasSessionForkFingerprint(stateDir) {
  return walkExclusionDir(stateDir, (entry) => FINGERPRINT_FILE.test(entry.name) || undefined) === true
}

/**
 * Does any stored fingerprint share a uuid with `uuids`?
 *
 * **Any one match, not all.** Transcript uuids are random v4, so a single
 * shared value is not a coincidence, and matching on one survives a client
 * build that prepends a line to the copy. The heads are shared down a whole
 * fork chain, so a fork of a fork matches the original parent with no record
 * per generation.
 *
 * Reports no match when the store cannot be read. Wrongly ignoring a session
 * destroys capture silently and the user cannot see that it happened, so an
 * unreadable store loses fork protection rather than guessing.
 *
 * @ref LLP 0419#any-match [implements]
 * @param {string} stateDir
 * @param {readonly string[]} uuids
 * @returns {boolean}
 */
export function sessionForkFingerprintMatches(stateDir, uuids) {
  /** @type {Set<string>} */
  const wanted = new Set()
  for (const value of uuids) {
    if (typeof value === 'string' && FINGERPRINT_TOKEN.test(value)) wanted.add(value)
  }
  if (wanted.size === 0) return false
  return walkExclusionDir(stateDir, (entry, file) => {
    if (!FINGERPRINT_FILE.test(entry.name)) return undefined
    let stat
    try { stat = fs.lstatSync(file) } catch { return undefined }
    if (!stat.isFile() || stat.size > 64 * 1024) return undefined
    const stored = parseFingerprint(fs.readFileSync(file, 'utf8'))
    if (!stored) return undefined
    for (const value of stored) if (wanted.has(value)) return true
    return undefined
  }) === true
}

/**
 * Walk the exclusion directory with a streamed iterator, stopping as soon as
 * `visit` returns a value. Shared by the writer and the two readers above, so
 * none of them holds a directory listing in memory.
 *
 * @param {string} stateDir
 * @param {(entry: Dirent, file: string) => boolean | undefined} visit
 * @returns {boolean | undefined}
 */
function walkExclusionDir(stateDir, visit) {
  const dir = path.join(stateDir, 'session-ignores')
  let directory
  try {
    directory = fs.opendirSync(dir)
  } catch {
    return undefined
  }
  try {
    let entry
    while ((entry = directory.readSync())) {
      const answer = visit(entry, path.join(dir, entry.name))
      if (answer !== undefined) return answer
    }
  } catch {
    return undefined
  } finally {
    directory.closeSync()
  }
  return undefined
}

/** @param {Set<string> | undefined} set */
export function refreshSessionIgnores(set) {
  if (set instanceof SessionIgnoreSet) set.refresh()
}

/** @param {Set<string> | undefined} set */
export function sessionIgnoreLoadError(set) {
  return set instanceof SessionIgnoreSet ? set.loadError : undefined
}
