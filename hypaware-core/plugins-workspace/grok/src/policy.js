// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'

/** @import { GrokPolicy, GrokSession, GrokWithheldStore } from '../../../../hypaware-core/plugins-workspace/grok/src/types.js' */

/**
 * @param {Set<string> | undefined} ignored
 * @param {{ resolve: (cwd: string) => { class: string } }} resolver
 * @returns {GrokPolicy}
 * @ref LLP 0585#lineage: an exclusion covers the forks and subagents a session spawned
 */
export function createGrokPolicy(ignored, resolver) {
  /** @param {GrokSession} session */
  const sessionIgnored = session => session.lineage.some(id => ignored?.has(id))
  return {
    sessionIgnored,
    allowed: session => !sessionIgnoreLoadError(ignored) && !sessionIgnored(session) && resolver.resolve(session.cwd).class !== 'ignore',
  }
}

/** @param {string} id */
const floorName = id => `${createHash('sha256').update(id).digest('hex')}.json`

/**
 * One small file per session that was ever read while ignored, so its size
 * tracks exclusions rather than history. Shared with manual imports, which run
 * in their own process. An unreadable floor fails the read, not open.
 *
 * @param {string} stateDir
 * @returns {GrokWithheldStore}
 * @ref LLP 0585#withheld: a byte floor per session
 */
export function createGrokWithheldStore(stateDir) {
  const dir = path.join(stateDir, 'grok-withheld')
  /** @param {string} id */
  async function read(id) {
    let raw
    try { raw = await fs.readFile(path.join(dir, floorName(id)), 'utf8') } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return 0
      throw error
    }
    const offset = JSON.parse(raw).offset
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('withheld_floor_invalid')
    return offset
  }
  return {
    async floor(session) {
      let floor = await read(session.id)
      for (const id of session.fork_sources) floor = Math.max(floor, await read(id))
      return floor
    },
    async mark(sessionId, offset) {
      if (offset <= await read(sessionId)) return
      await atomicWriteFile(path.join(dir, floorName(sessionId)), JSON.stringify({ offset }) + '\n', { mode: 0o600, dirMode: 0o700, fsync: true })
    },
  }
}
