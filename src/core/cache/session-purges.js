// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from '../util/fs_atomic.js'

const graphIdentifiers = ['node_id', 'src_id', 'dst_id']

/** @import { ScannableDataSource } from '../../../hypaware-plugin-kernel-types.js' */

/**
 * Durable, additive session fences. null org means a local machine's session;
 * a string means exactly that server organization, including the empty org.
 * Refresh once per batch/scan, never once per row. An unreadable store fails
 * closed, and the explicit admission bound never evicts an older exclusion.
 * @ref LLP 0417#operation [implements]: deletion cannot be undone by replay or by unignoring capture
 * @param {string} cacheRoot
 */
export function createSessionPurgeStore(cacheRoot) {
  const directory = path.join(cacheRoot, 'session-purges')
  /** @type {Set<string>} */
  let keys = new Set()
  /** @type {Map<string | null, Set<string>>} */
  let sessions = new Map()
  /** @type {Map<string | null, Set<string>>} */
  let graphNodes = new Map()
  let storedBytes = 0
  let fingerprint = ''
  function refresh() {
    let stamp
    try {
      const stat = fs.statSync(directory, { bigint: true })
      stamp = `${stat.mtimeNs}:${stat.ctimeNs}`
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
      keys = new Set()
      sessions = new Map()
      graphNodes = new Map()
      storedBytes = 0
      fingerprint = ''
      return
    }
    if (stamp === fingerprint) return
    const loaded = new Set()
    /** @type {Map<string | null, Set<string>>} */
    const byOrg = new Map()
    /** @type {Map<string | null, Set<string>>} */
    const graphByOrg = new Map()
    let bytes = 0
    const dir = fs.opendirSync(directory)
    try {
      let entry
      while ((entry = dir.readSync())) {
        if (/\.tmp$/.test(entry.name)) continue
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new Error('Invalid session purge marker')
        const file = path.join(directory, entry.name)
        const stat = fs.lstatSync(file)
        bytes += stat.size
        if (!stat.isFile() || stat.size > 65536 || bytes > 4 * 1024 * 1024 || loaded.size >= 10000) {
          throw new Error('Session purge store exceeds its read limit')
        }
        const value = JSON.parse(fs.readFileSync(file, 'utf8'))
        const key = sessionKey(value.sessionId, value.org)
        if (marker(key) !== entry.name) throw new Error('Invalid session purge marker')
        loaded.add(key)
        let ids = byOrg.get(value.org)
        if (!ids) byOrg.set(value.org, ids = new Set())
        ids.add(value.sessionId)
        let nodes = graphByOrg.get(value.org)
        if (!nodes) graphByOrg.set(value.org, nodes = new Set())
        nodes.add(sessionGraphNodeId(value.sessionId))
      }
    } finally { dir.closeSync() }
    keys = loaded
    sessions = byOrg
    graphNodes = graphByOrg
    storedBytes = bytes
    fingerprint = stamp
  }
  return {
    refresh,
    /** @param {string} sessionId @param {string | null} [org] */
    add(sessionId, org = null) {
      const key = sessionKey(sessionId, org)
      refresh()
      const payload = JSON.stringify({ sessionId, org })
      if (!keys.has(key) && (keys.size >= 10000 || storedBytes + Buffer.byteLength(payload) > 4 * 1024 * 1024)) {
        throw new Error('Session purge store is full')
      }
      atomicWriteFileSync(path.join(directory, marker(key)), payload, { mode: 0o600, dirMode: 0o700 })
      // The marker must survive before a deletion can remove its evidence.
      for (const file of [path.join(directory, marker(key)), directory, cacheRoot]) {
        const fd = fs.openSync(file, 'r')
        try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      }
      fingerprint = ''
      refresh()
    },
    /** @param {Record<string, unknown>} row */
    has(row) {
      if (!keys.size) return false
      const org = typeof row.org === 'string' ? row.org : ''
      if (typeof row.session_id === 'string' &&
        (sessions.get(null)?.has(row.session_id) || sessions.get(org)?.has(row.session_id))) return true
      for (const key of graphIdentifiers) {
        const value = row[key]
        if (typeof value === 'string' && (graphNodes.get(null)?.has(value) || graphNodes.get(org)?.has(value))) return true
      }
      return false
    },
    get size() { return keys.size },
  }
}

/** @param {string} key */
function marker(key) { return `${createHash('sha256').update(key).digest('hex')}.json` }

/** @param {unknown} sessionId @param {unknown} org */
function sessionKey(sessionId, org) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || Buffer.byteLength(sessionId) > 4096 ||
    (org !== null && (typeof org !== 'string' || Buffer.byteLength(org) > 1024))) {
    throw new Error('Invalid session purge scope')
  }
  return JSON.stringify([org, sessionId])
}

/**
 * Fence reads of snapshots opened while a writer was finishing. Positional
 * deletion remains the persisted table mutation; this fence also ensures a
 * concurrent older process cannot re-expose a session after completion.
 * Keep the native prepared scan untouched for stores without purges.
 * @param {ScannableDataSource} source
 * @param {ReturnType<typeof createSessionPurgeStore>} store
 * @returns {ScannableDataSource}
 */
export function filterPurgedSessions(source, store) {
  store.refresh()
  if (store.size === 0) return source
  const identifiers = ['session_id', ...graphIdentifiers].filter(name => source.columns.includes(name))
  if (identifiers.length === 0) return source
  const scopeColumns = [...identifiers, 'org']
  return {
    columns: source.columns,
    numRows: source.numRows,
    scan(options) {
      store.refresh()
      const requested = options?.columns ?? source.columns
      const columns = [...new Set([...requested, ...identifiers, ...(source.columns.includes('org') ? ['org'] : [])])]
      const inner = source.scan({ ...options, columns, limit: undefined, offset: undefined })
      return {
        appliedWhere: inner.appliedWhere,
        appliedLimitOffset: false,
        async *rows() {
          for await (const row of inner.rows()) {
            const scope = {}
            for (const key of scopeColumns) scope[key] = row.resolved?.[key] ?? await row.cells?.[key]?.()
            if (!store.has(scope)) yield row
          }
        },
      }
    },
  }
}

/** @param {string} sessionId */
export function sessionGraphNodeId(sessionId) {
  return createHash('sha256').update(`node\0Session\0${sessionId}`).digest('hex').slice(0, 24)
}
