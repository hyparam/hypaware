// @ts-check

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

/**
 * @import { ColumnSpec } from '../../../collectivus-plugin-kernel-types'
 * @import { CacheSpool, FlushResult, PendingInfo, SpoolAppendResult } from './types.d.ts'
 */

export const SPOOL_DIR = '_hypaware_spool'
export const DEFAULT_SPOOL_BYTES_THRESHOLD = 4 * 1024 * 1024
export const DEFAULT_FLUSH_ROW_CHUNK_SIZE = 1000
export const QUERY_FLUSH_DEBOUNCE_MS = 2 * 60 * 1000

const ACTIVE_FILE = 'active.jsonl'
const FLUSH_PREFIX = 'flush-'
const FLUSH_SUFFIX = '.jsonl'
const LAST_FLUSH_FILE = 'last-flush.json'

/**
 * @param {{
 *   cacheRoot: string,
 *   appendChunk(tablePath: string, columns: readonly ColumnSpec[], rows: Record<string, unknown>[]): Promise<{ bytesWritten: number }>,
 *   rowChunkSize?: number,
 * }} args
 * @returns {CacheSpool}
 */
export function createCacheSpool(args) {
  const rowChunkSize = args.rowChunkSize ?? DEFAULT_FLUSH_ROW_CHUNK_SIZE
  /** @type {Map<string, { writeLock: Promise<unknown>, flushLock: Promise<unknown> }>} */
  const states = new Map()
  /** @type {Set<string>} */
  const knownTables = new Set()

  /**
   * @param {string} tablePath
   */
  function stateFor(tablePath) {
    knownTables.add(tablePath)
    let state = states.get(tablePath)
    if (!state) {
      state = { writeLock: Promise.resolve(), flushLock: Promise.resolve() }
      states.set(tablePath, state)
    }
    return state
  }

  /**
   * @template T
   * @param {string} tablePath
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withWriteLock(tablePath, fn) {
    const state = stateFor(tablePath)
    const next = state.writeLock.catch(() => undefined).then(fn)
    state.writeLock = next.catch(() => undefined)
    return next
  }

  /**
   * @template T
   * @param {string} tablePath
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withFlushLock(tablePath, fn) {
    const state = stateFor(tablePath)
    const next = state.flushLock.catch(() => undefined).then(fn)
    state.flushLock = next.catch(() => undefined)
    return next
  }

  return {
    async append(tablePath, columns, rows) {
      if (rows.length === 0) {
        return { bytesWritten: 0, pendingBytes: pendingBytesSync(tablePath) }
      }
      const line = JSON.stringify({ version: 1, columns, rows }, spoolReplacer) + '\n'
      const bytesWritten = Buffer.byteLength(line, 'utf8')
      const result = await withWriteLock(tablePath, async () => {
        const dir = spoolDir(tablePath)
        await fs.mkdir(dir, { recursive: true })
        const handle = await fs.open(path.join(dir, ACTIVE_FILE), 'a')
        try {
          await handle.writeFile(line, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        return { bytesWritten, pendingBytes: pendingBytesSync(tablePath) }
      })
      return result
    },

    async flushTable(tablePath, opts = {}) {
      return withFlushLock(tablePath, async () => {
        const reason = opts.reason ?? 'manual'
        await withWriteLock(tablePath, async () => {
          await rotateActiveFile(tablePath)
        })

        const files = listFlushFiles(tablePath)
        if (files.length === 0) {
          return { flushed: false, rowCount: 0, chunkCount: 0, bytesWritten: 0, pendingBytes: pendingBytesSync(tablePath), reason }
        }

        let rowCount = 0
        let chunkCount = 0
        let bytesWritten = 0
        for (const filePath of files) {
          const chunks = await readFlushChunks(filePath, rowChunkSize)
          for (const chunk of chunks) {
            const written = await args.appendChunk(tablePath, chunk.columns, chunk.rows)
            rowCount += chunk.rows.length
            chunkCount += 1
            bytesWritten += written.bytesWritten
          }
          await fs.rm(filePath, { force: true })
        }
        if (chunkCount > 0) {
          await writeLastFlush(tablePath, { rowCount, bytesWritten })
        }
        return { flushed: chunkCount > 0, rowCount, chunkCount, bytesWritten, pendingBytes: pendingBytesSync(tablePath), reason }
      })
    },

    async flushAll(opts = {}) {
      const tables = new Set([...knownTables, ...(await discoverSpoolTables(args.cacheRoot))])
      /** @type {FlushResult} */
      const total = {
        flushed: false,
        rowCount: 0,
        chunkCount: 0,
        bytesWritten: 0,
        pendingBytes: 0,
        reason: opts.reason ?? 'manual',
      }
      for (const tablePath of tables) {
        const result = await this.flushTable(tablePath, opts)
        total.flushed ||= result.flushed
        total.rowCount += result.rowCount
        total.chunkCount += result.chunkCount
        total.bytesWritten += result.bytesWritten
        total.pendingBytes += result.pendingBytes
      }
      return total
    },

    async pendingInfo(tablePath) {
      knownTables.add(tablePath)
      return {
        pending: hasPendingSync(tablePath),
        pendingBytes: pendingBytesSync(tablePath),
        lastFlushAtMs: await readLastFlushAt(tablePath),
      }
    },

    hasPendingSync(tablePath) {
      knownTables.add(tablePath)
      return hasPendingSync(tablePath)
    },
  }
}

/**
 * @param {string} tablePath
 */
function spoolDir(tablePath) {
  return path.join(tablePath, SPOOL_DIR)
}

/**
 * @param {string} tablePath
 */
async function rotateActiveFile(tablePath) {
  const dir = spoolDir(tablePath)
  const active = path.join(dir, ACTIVE_FILE)
  let stat
  try {
    stat = await fs.stat(active)
  } catch {
    return
  }
  if (!stat.isFile() || stat.size === 0) return
  const dest = path.join(dir, `${FLUSH_PREFIX}${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}${FLUSH_SUFFIX}`)
  await fs.rename(active, dest)
}

/**
 * @param {string} tablePath
 * @returns {string[]}
 */
function listFlushFiles(tablePath) {
  const dir = spoolDir(tablePath)
  try {
    return fsSync
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(FLUSH_PREFIX) && entry.name.endsWith(FLUSH_SUFFIX))
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

/**
 * @param {string} filePath
 * @param {number} rowChunkSize
 * @returns {Promise<Array<{ columns: readonly ColumnSpec[], rows: Record<string, unknown>[] }>>}
 */
async function readFlushChunks(filePath, rowChunkSize) {
  const text = await fs.readFile(filePath, 'utf8')
  /** @type {Array<{ columns: readonly ColumnSpec[], rows: Record<string, unknown>[] }>} */
  const chunks = []
  /** @type {readonly ColumnSpec[] | null} */
  let currentColumns = null
  let currentSignature = ''
  /** @type {Record<string, unknown>[]} */
  let currentRows = []

  function flushCurrent() {
    if (!currentColumns || currentRows.length === 0) return
    chunks.push({ columns: currentColumns, rows: currentRows })
    currentColumns = null
    currentSignature = ''
    currentRows = []
  }

  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const envelope = /** @type {{ version?: number, columns?: readonly ColumnSpec[], rows?: Record<string, unknown>[] }} */ (JSON.parse(line))
    if (envelope.version !== 1 || !Array.isArray(envelope.columns) || !Array.isArray(envelope.rows)) {
      throw new Error(`invalid cache spool envelope in ${filePath}`)
    }
    const signature = JSON.stringify(envelope.columns)
    if (currentColumns && signature !== currentSignature) flushCurrent()
    currentColumns = envelope.columns
    currentSignature = signature
    for (const row of envelope.rows) {
      currentRows.push(row)
      if (currentRows.length >= rowChunkSize) flushCurrent()
      if (!currentColumns) {
        currentColumns = envelope.columns
        currentSignature = signature
      }
    }
  }
  flushCurrent()
  return chunks
}

/**
 * @param {string} tablePath
 */
function hasPendingSync(tablePath) {
  return pendingBytesSync(tablePath) > 0
}

/**
 * @param {string} tablePath
 */
function pendingBytesSync(tablePath) {
  const dir = spoolDir(tablePath)
  let total = 0
  try {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (entry.name !== ACTIVE_FILE && !(entry.name.startsWith(FLUSH_PREFIX) && entry.name.endsWith(FLUSH_SUFFIX))) continue
      try {
        total += fsSync.statSync(path.join(dir, entry.name)).size
      } catch {
        /* file may have been rotated concurrently */
      }
    }
  } catch {
    return 0
  }
  return total
}

/**
 * @param {string} tablePath
 * @param {{ rowCount: number, bytesWritten: number }} details
 */
async function writeLastFlush(tablePath, details) {
  const dir = spoolDir(tablePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `${LAST_FLUSH_FILE}.tmp.${process.pid}.${Date.now()}`)
  const payload = {
    flushedAt: new Date().toISOString(),
    rowCount: details.rowCount,
    bytesWritten: details.bytesWritten,
  }
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
  await fs.rename(tmp, path.join(dir, LAST_FLUSH_FILE))
}

/**
 * @param {string} tablePath
 * @returns {Promise<number | null>}
 */
async function readLastFlushAt(tablePath) {
  try {
    const raw = await fs.readFile(path.join(spoolDir(tablePath), LAST_FLUSH_FILE), 'utf8')
    const parsed = /** @type {{ flushedAt?: unknown }} */ (JSON.parse(raw))
    if (typeof parsed.flushedAt !== 'string') return null
    const ms = Date.parse(parsed.flushedAt)
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

/**
 * @param {string} cacheRoot
 * @returns {Promise<string[]>}
 */
async function discoverSpoolTables(cacheRoot) {
  /** @type {string[]} */
  const tables = []
  const root = path.join(cacheRoot, 'datasets')
  await walk(root)
  return tables

  /** @param {string} dir */
  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name === SPOOL_DIR) {
        tables.push(path.dirname(full))
        continue
      }
      await walk(full)
    }
  }
}

/**
 * @param {string} _key
 * @param {unknown} value
 */
function spoolReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString()
  return value
}
