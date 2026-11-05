// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { CLASS_RANK } from '../../../../src/core/usage-policy/index.js'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'

/** @import { GrokFloor, GrokPolicy, GrokSession, GrokWithheldStore } from '../../../../hypaware-core/plugins-workspace/grok/src/types.js' */

/**
 * @param {Set<string> | undefined} ignored
 * @param {{ resolve: (cwd: string) => { class: string } }} resolver
 * @returns {GrokPolicy}
 * @ref LLP 0585#lineage: an exclusion covers the forks and subagents a session spawned, wherever they run
 */
export function createGrokPolicy(ignored, resolver) {
  /** @param {GrokSession} session */
  const sessionIgnored = session => session.lineage.some(id => ignored?.has(id))
  /** @param {string} dir */
  const rank = dir => /** @type {Record<string, number>} */ (CLASS_RANK)[resolver.resolve(dir).class] ?? 0
  /** @param {GrokSession} session */
  const governingDir = session => {
    let best = session.cwd
    for (const dir of session.policy_dirs) if (rank(dir) > rank(best)) best = dir
    return best
  }
  return {
    sessionIgnored,
    governingDir,
    allowed: session => !sessionIgnoreLoadError(ignored) && !sessionIgnored(session) && resolver.resolve(governingDir(session)).class !== 'ignore',
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
    async floors(session) {
      /** @type {GrokFloor[]} */
      const floors = []
      const own = await read(session.id)
      if (own) floors.push({ offset: own })
      for (const { id, before_ms } of session.fork_sources) {
        const offset = await read(id)
        if (offset) floors.push({ offset, ...(before_ms === undefined ? {} : { before_ms }) })
      }
      return floors
    },
    async mark(sessionId, offset) {
      if (offset <= await read(sessionId)) return
      await atomicWriteFile(path.join(dir, floorName(sessionId)), JSON.stringify({ offset }) + '\n', { mode: 0o600, dirMode: 0o700, fsync: true })
    },
  }
}
