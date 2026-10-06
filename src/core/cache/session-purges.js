// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readBatchColumn, selectedRowCount, selectBatch, valueAt } from 'squirreling'
import { atomicWriteFileSync } from '../util/fs_atomic.js'

const graphIdentifiers = ['node_id', 'src_id', 'dst_id']

/** @import { ScannableDataSource } from '../../../hypaware-plugin-kernel-types.js' */

/**
 * Durable, additive session fences. null org means a local machine's session;
 * a string means exactly that server organization, including the empty org.
 * Refresh once per batch/scan, never once per row. A directory entry whose
 * name is not a 64-hex-char marker (a stray `.DS_Store`, an editor backup) is
 * ignored; a marker-named file that fails to load or validate still fails
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
    let mtimeNs = 0n
    try {
      const stat = fs.statSync(directory, { bigint: true })
      mtimeNs = stat.mtimeNs
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
        // A foreign filename (not a 64-hex-char marker) is ignored, and does
        // not count toward the byte/load limits below; a name that DOES match
        // the marker shape is held to every existing check.
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
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
    // Directory timestamps come from the kernel's coarse clock, so a marker
    // another process lands in the same tick as the last one leaves the stamp
    // unchanged. A stamp younger than a second is not memoized: the next
    // refresh re-reads the store until the clock has moved past the write.
    fingerprint = Date.now() * 1e6 - Number(mtimeNs) < 1e9 ? '' : stamp
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
 * Sources remain fenced even when planned before the first purge.
 * @param {ScannableDataSource} source
 * @param {ReturnType<typeof createSessionPurgeStore>} store
 * @returns {ScannableDataSource}
 */
export function filterPurgedSessions(source, store) {
  store.refresh()
  const identifiers = ['session_id', ...graphIdentifiers].filter(name => source.columns.includes(name))
  if (identifiers.length === 0) return source
  const scopeColumns = [...identifiers, 'org']
  /** @type {ScannableDataSource} */
  const wrapped = {
    columns: source.columns,
    scan(options) {
      store.refresh()
      const requested = options?.columns ?? source.columns
      const columns = [...new Set([...requested, ...identifiers, ...(source.columns.includes('org') ? ['org'] : [])])]
      const inner = source.scan({ ...options, columns, limit: undefined, offset: undefined })
      return {
        appliedWhere: inner.appliedWhere,
        appliedLimitOffset: false,
        async *rows() {
          store.refresh()
          let sinceRefresh = 0
          const scope = {}
          for await (const row of inner.rows()) {
            // Bound cross-process refresh cost on row-only providers.
            if (++sinceRefresh === 1024) {
              store.refresh()
              sinceRefresh = 0
            }
            if (!store.size) {
              yield row
              continue
            }
            for (const key of scopeColumns) scope[key] = row.resolved?.[key] ?? await row.cells?.[key]?.()
            if (!store.has(scope)) yield row
          }
        },
      }
    },
  }
  const schema = source.schema
  const prepareScan = source.prepareScan?.bind(source)
  if (schema && prepareScan) {
    wrapped.schema = schema
    // @ref LLP 0417#performance [implements]: fence native batches without materializing payload rows
    wrapped.prepareScan = request => {
      const demands = [...request.columns]
      for (const field of schema.fields) {
        if (scopeColumns.includes(field.name) && !demands.some(demand => demand.field === field.id)) {
          demands.push({ field: field.id, phase: 0, purpose: 'filter', mode: 'required' })
        }
      }
      const inner = prepareScan({ ...request, columns: demands, limit: undefined, offset: undefined })
      const output = request.columns.map(demand => inner.schema.fields.findIndex(field => field.id === demand.field))
      const scopes = inner.schema.fields.flatMap((field, index) => scopeColumns.includes(field.name) ? [{ name: field.name, index }] : [])
      return {
        schema: { fields: output.map(index => inner.schema.fields[index]) },
        residual: { ...inner.residual, limit: request.limit, offset: request.offset },
        properties: { ...inner.properties, exactRows: undefined },
        async *batches(options = {}) {
          for await (const batch of inner.batches(options)) {
            options.signal?.throwIfAborted()
            store.refresh()
            // Before the first purge, forward lazy payloads without reading
            // scope vectors or allocating a row selection. Scope demands stay
            // available if a fence arrives after this source was prepared.
            if (!store.size) {
              yield { selection: batch.selection, columns: output.map(index => batch.columns[index]) }
              continue
            }
            const vectors = await Promise.all(scopes.map(({ index }) => readBatchColumn({ batch, columnIndex: index, signal: options.signal })))
            const count = selectedRowCount(batch.selection)
            const indices = new Uint32Array(count)
            const scope = {}
            let kept = 0
            for (let row = 0; row < count; row++) {
              for (let col = 0; col < scopes.length; col++) scope[scopes[col].name] = valueAt(vectors[col], row)
              if (!store.has(scope)) indices[kept++] = row
            }
            if (!kept) continue
            const selected = kept === count ? batch : selectBatch(batch, { type: 'indices', indices: indices.subarray(0, kept), length: count })
            yield { selection: selected.selection, columns: output.map(columnIndex => ({
              read: ({ selection, signal }) => readBatchColumn({ batch, columnIndex, selection, signal }),
            })) }
          }
        },
      }
    }
    const prepared = wrapped.prepareScan
    wrapped.scanColumn = options => {
      const field = schema.fields.find(field => field.name === options.column)
      if (!field) throw new Error('Unknown scan column')
      const scan = prepared({ columns: [{ field: field.id, phase: 0, purpose: 'output', mode: 'required' }], filter: options.where })
      return {
        appliedWhere: !scan.residual.filter,
        appliedLimitOffset: false,
        async *chunks() {
          for await (const batch of scan.batches({ signal: options.signal })) {
            const vector = await readBatchColumn({ batch, columnIndex: 0, signal: options.signal })
            yield Array.from({ length: vector.length }, (_, index) => valueAt(vector, index))
          }
        },
      }
    }
  }
  return wrapped
}

/** @param {string} sessionId */
export function sessionGraphNodeId(sessionId) {
  return createHash('sha256').update(`node\0Session\0${sessionId}`).digest('hex').slice(0, 24)
}
