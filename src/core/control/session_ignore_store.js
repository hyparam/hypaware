// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteFileSync } from '../util/fs_atomic.js'

// @ref LLP 0403#storage [implements]: independent markers persist opt-outs;
// live membership checks remain ordinary Set lookups.
/** @extends {Set<string>} */
export class SessionIgnoreSet extends Set {
  /** @param {string} stateDir */
  constructor(stateDir) {
    super()
    this.directory = path.join(stateDir, 'session-ignores')
    this.bytes = 0
    this.refresh()
  }

  /** Reload once before each backfill run, never per live message. */
  refresh() {
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
        if (/^[a-f0-9]{64}\.json\.\d+\.[a-f0-9]+\.tmp$/.test(entry.name)) continue
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new Error('Invalid session exclusion filename')
        const file = path.join(this.directory, entry.name)
        const stat = fs.lstatSync(file)
        bytes += stat.size
        if (!stat.isFile() || stat.size > 64 * 1024 || bytes > 4 * 1024 * 1024 || loaded.size >= 10000) {
          throw new Error('session ignore store is invalid or exceeds its read limit')
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

  /** @param {string} id */
  delete(id) {
    fs.rmSync(path.join(this.directory, markerName(id)), { force: true })
    const removed = super.delete(id)
    if (removed) this.bytes -= Buffer.byteLength(JSON.stringify(id))
    return removed
  }

  clear() {
    throw new Error('Remove session exclusions explicitly with session unignore')
  }
}

/** @param {string} id */
function markerName(id) {
  return `${createHash('sha256').update(JSON.stringify(id)).digest('hex')}.json`
}

/** @param {Set<string> | undefined} set */
export function refreshSessionIgnores(set) {
  if (set instanceof SessionIgnoreSet) set.refresh()
}
