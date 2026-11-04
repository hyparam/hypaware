// @ts-check

/**
 * Find the crush databases to poll: the union of the `projects.json` index
 * Crush keeps in its global data dir and the configured `data_dirs`, one
 * `crush.db` per distinct real `data_dir`.
 *
 * Bounded per pass: one `stat` of the index (a read only when its signature
 * moved), then at most one `realpath` and one `stat` per listed data dir
 * until the cap fills.
 * The index list is cached between passes in a {@link CrushDiscoveryState}.
 *
 * @import { CrushDatabase, CrushDiscoveryInput, CrushDiscoveryResult, CrushDiscoveryState } from './types.js'
 */

import fs from 'node:fs'
import path from 'node:path'

/** Most databases one source polls (LLP 0573#discovery, #cost). */
export const MAX_DATABASES = 1024

/** @returns {CrushDiscoveryState} */
export function createDiscoveryState() {
  return { indexSig: null, indexDataDirs: [], indexUnreadable: false }
}

/**
 * Run one discovery pass. Never throws: an unreadable index is reported in
 * the result and the last good list stays in use.
 *
 * @ref LLP 0573#discovery [implements]: reread the index only when its stat
 *   signature moved, keep the last good list on a malformed one, dedupe by
 *   real path, count a data dir without `crush.db` as stale.
 *
 * @param {CrushDiscoveryState} state mutated in place
 * @param {CrushDiscoveryInput} input
 * @returns {CrushDiscoveryResult}
 */
export function discoverDatabases(state, input) {
  const indexRead = refreshIndex(state, input.indexPath)
  const indexPresent = state.indexSig !== null

  /** @type {CrushDatabase[]} */
  const databases = []
  /** @type {Set<string>} */
  const seenText = new Set()
  /** @type {Set<string>} */
  const seenReal = new Set()
  let listed = 0
  let stale = 0
  let overCap = 0

  for (const dir of [...state.indexDataDirs, ...input.dataDirs]) {
    if (seenText.has(dir)) continue
    seenText.add(dir)
    // @ref LLP 0573#discovery: past the cap the extras are skipped in index
    // order, so membership follows list order rather than activity. That is
    // only the degraded too_many_projects state, and the per-tick bound holds
    // over whichever 1,024 databases are in the set. Entries past the cap are
    // counted by text without a realpath or stat, so a huge index costs no
    // more syscalls than a full one.
    if (databases.length >= MAX_DATABASES) {
      listed++
      overCap++
      continue
    }
    if (!path.isAbsolute(dir)) {
      listed++
      stale++
      continue
    }
    let real
    try {
      real = fs.realpathSync(dir)
    } catch {
      listed++
      stale++
      continue
    }
    if (seenReal.has(real)) continue
    seenReal.add(real)
    listed++
    const dbPath = path.join(real, 'crush.db')
    const dbSig = fileSig(dbPath)
    if (dbSig === null) {
      stale++
      continue
    }
    databases.push({ dataDir: real, dbPath, projectDir: path.dirname(real), dbSig })
  }

  return {
    databases,
    indexPresent,
    indexRead,
    indexUnreadable: indexPresent && state.indexUnreadable,
    listed,
    stale,
    overCap,
  }
}

/**
 * Reread `projects.json` when its signature moved. Returns whether it read.
 *
 * @param {CrushDiscoveryState} state
 * @param {string} indexPath
 * @returns {boolean}
 */
function refreshIndex(state, indexPath) {
  let st
  try {
    st = fs.statSync(indexPath)
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      state.indexSig = null
      state.indexDataDirs = []
      state.indexUnreadable = false
      return false
    }
    // Present but not stat-able: keep the last good list.
    state.indexSig = state.indexSig ?? 'unreadable'
    state.indexUnreadable = true
    return false
  }
  const sig = `${st.size}:${st.mtimeMs}:${st.ino}`
  if (sig === state.indexSig) return false
  state.indexSig = sig
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  } catch {
    state.indexUnreadable = true
    return true
  }
  const projects = parsed && typeof parsed === 'object' ? parsed.projects : undefined
  if (!Array.isArray(projects)) {
    state.indexUnreadable = true
    return true
  }
  /** @type {string[]} */
  const dirs = []
  const seen = new Set()
  for (const entry of projects) {
    const dir = entry && typeof entry === 'object' ? entry.data_dir : undefined
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  state.indexDataDirs = dirs
  state.indexUnreadable = false
  return true
}

/**
 * The `size:mtimeNs:ino` signature of a regular file, null when it is
 * absent or not a file. Nanosecond mtime, so two writes inside one
 * millisecond still move it; the poll reuses it as the database half of its
 * change gate, so an idle database costs this stat and one of its `-wal`.
 *
 * @param {string} p
 * @returns {string | null}
 */
export function fileSig(p) {
  try {
    const st = fs.statSync(p, { bigint: true })
    return st.isFile() ? `${st.size}:${st.mtimeNs}:${st.ino}` : null
  } catch {
    return null
  }
}
