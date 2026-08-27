// @ts-check

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteJson } from '../util/fs_atomic.js'
import { countGatewayFallbackRows } from './gateway_fallback.js'
import { appendRowsToTable, tableExists as icebergTableExists } from './iceberg/store.js'
import { cacheTablePath, datasetsRoot } from './paths.js'

/**
 * @import { ColumnSpec, QueryScope } from '../../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration, CachePartitionMeta, PartitionCursor } from '../../../src/core/cache/types.js'
 * @import { Dirent } from 'node:fs'
 */

const CURSOR_FILE = 'cursor.json'
const SPOOL_DIR = '_hypaware_spool'
const RETIRED_DIR = '.retired'

/** @type {Map<string, Promise<unknown>>} */
const partitionMutationLocks = new Map()

/**
 * Serialize cursor-coupled mutations of one logical cache partition inside
 * the process. Flush and maintenance run on independent daemon timers, but a
 * compaction cursor swap must not strand an append in the retired generation.
 *
 * @ref LLP 0301#requirements [implements]: keep the replacement-generation cursor swap atomic with respect to daemon flushes
 * @template T
 * @param {string} partitionDir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withPartitionMutationLock(partitionDir, fn) {
  const previous = partitionMutationLocks.get(partitionDir) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(fn)
  partitionMutationLocks.set(partitionDir, current)
  return current.finally(() => {
    if (partitionMutationLocks.get(partitionDir) === current) {
      partitionMutationLocks.delete(partitionDir)
    }
  })
}

/**
 * Read the cursor for a logical partition directory.  Returns the
 * default epoch-0 cursor when the file is missing or unparseable.
 *
 * @param {string} partitionDir
 * @returns {PartitionCursor}
 */
export function readCursorSync(partitionDir) {
  return tryReadCursorSync(partitionDir) ?? { epoch: 0, rowCount: 0, compaction: null }
}

/**
 * Like {@link readCursorSync}, but distinguishes "no cursor" / "cursor
 * unreadable" from a real cursor: returns `null` when the file is
 * missing OR cannot be read/parsed, instead of synthesizing a default
 * epoch-0 cursor. Callers that take destructive action based on the
 * cursor (e.g. the orphan-generation sweep) must use this so a corrupt
 * `cursor.json` is never mistaken for "the live generation is epoch 0".
 *
 * @param {string} partitionDir
 * @returns {PartitionCursor | null}
 */
export function tryReadCursorSync(partitionDir) {
  /** @type {string} */
  let raw
  try {
    raw = fs.readFileSync(path.join(partitionDir, CURSOR_FILE), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    /** @type {PartitionCursor} */
    const cursor = {
      epoch: typeof parsed.epoch === 'number' ? parsed.epoch : 0,
      rowCount: typeof parsed.rowCount === 'number' ? parsed.rowCount : 0,
      compaction: parsed.compaction ?? null,
    }
    if (parsed.layout === 'source-table' || parsed.layout === 'epoch') {
      cursor.layout = parsed.layout
    }
    if (typeof parsed.tableDir === 'string') {
      cursor.tableDir = parsed.tableDir
    }
    if (parsed.retention && typeof parsed.retention === 'object') {
      cursor.retention = parsed.retention
    }
    if (typeof parsed.pendingFallbacks === 'number') {
      cursor.pendingFallbacks = parsed.pendingFallbacks
    }
    return cursor
  } catch {
    return null
  }
}

/**
 * Atomically write cursor.json for a logical partition.
 *
 * @param {string} partitionDir
 * @param {PartitionCursor} cursor
 */
export async function writeCursor(partitionDir, cursor) {
  await atomicWriteJson(path.join(partitionDir, CURSOR_FILE), cursor)
}

/**
 * Append rows into the source-table layout for the resolved
 * partition.  Creates the partition directory, Iceberg table
 * subdirectory, and cursor on first write.
 *
 * The on-disk layout is:
 *   `<cacheRoot>/datasets/<dataset>/source=<source>/table/`
 * with a `cursor.json` at the `source=<source>/` level carrying
 * `layout: 'source-table'`.
 *
 * @param {string} cacheRoot
 * @param {string} dataset
 * @param {string[]} sourceSegments
 * @param {readonly ColumnSpec[]} columns
 * @param {Record<string, unknown>[]} rows
 * @param {{ declaration?: CachePartitioningDeclaration }} [options]
 * @returns {Promise<{ tableUrl: string, appended: boolean, bytesWritten: number }>}
 */
export async function appendRowsToSourceTable(cacheRoot, dataset, sourceSegments, columns, rows, options) {
  if (rows.length === 0) {
    return { tableUrl: '', appended: false, bytesWritten: 0 }
  }
  const partitionDir = cacheTablePath(cacheRoot, dataset, sourceSegments)
  // @ref LLP 0027#re-settle-sweep [implements]: the sweep's gate is this
  // count, so the write path is where it is maintained - maintenance reading
  // the cursor is only cheap because nothing here forgets to tally. Rows
  // arrive after the flush-time settle hook has run, so a marker still
  // present is a genuinely unsettled row.
  const fallbackAppended = countGatewayFallbackRows(rows)
  return withPartitionMutationLock(partitionDir, async () => {
    const cursorOnDisk = tryReadCursorSync(partitionDir)
    const cursor = cursorOnDisk ?? { epoch: 0, rowCount: 0, compaction: null }
    const tableDir = cursor.tableDir ?? 'table'
    const icebergDir = path.join(partitionDir, tableDir)
    const declaration = options?.declaration
    const result = await appendRowsToTable(icebergDir, columns, rows, declaration ? { declaration } : undefined)
    await writeCursor(partitionDir, {
      epoch: cursor.epoch,
      rowCount: cursor.rowCount + rows.length,
      compaction: cursor.compaction,
      layout: 'source-table',
      tableDir,
      retention: cursor.retention,
      ...pendingFallbacksAfterAppend(cursor, cursorFileExists(partitionDir), fallbackAppended),
    })
    return result
  })
}

/**
 * Append rows into the current epoch's Iceberg table for the resolved
 * partition.  Creates the partition directory and cursor on first
 * write.
 *
 * @param {string} cacheRoot
 * @param {string} dataset
 * @param {string[]} partitionSegments
 * @param {readonly ColumnSpec[]} columns
 * @param {Record<string, unknown>[]} rows
 * @returns {Promise<{ tableUrl: string, appended: boolean, bytesWritten: number }>}
 */
export async function appendRowsToPartition(cacheRoot, dataset, partitionSegments, columns, rows) {
  if (rows.length === 0) {
    return { tableUrl: '', appended: false, bytesWritten: 0 }
  }
  const partitionDir = cacheTablePath(cacheRoot, dataset, partitionSegments)
  // @ref LLP 0027#re-settle-sweep [implements]: as above - the legacy epoch
  // layout is not settle-eligible today, but a cursor field maintained on
  // only one of two write paths is a count that drifts the day it is.
  const fallbackAppended = countGatewayFallbackRows(rows)
  return withPartitionMutationLock(partitionDir, async () => {
    const cursorOnDisk = tryReadCursorSync(partitionDir)
    const cursor = cursorOnDisk ?? { epoch: 0, rowCount: 0, compaction: null }
    const epochDir = path.join(partitionDir, `epoch=${cursor.epoch}`)
    const result = await appendRowsToTable(epochDir, columns, rows)
    await writeCursor(partitionDir, {
      epoch: cursor.epoch,
      rowCount: cursor.rowCount + rows.length,
      compaction: cursor.compaction,
      ...pendingFallbacksAfterAppend(cursor, cursorFileExists(partitionDir), fallbackAppended),
    })
    return result
  })
}

/**
 * Is there a `cursor.json` for this partition at all? Deliberately NOT
 * "did {@link tryReadCursorSync} return a cursor": that also answers null
 * for a file that exists but cannot be parsed, and a partition whose
 * cursor is unreadable is not a fresh one - its table may already hold
 * committed marker rows. Only the absence of the file proves the partition
 * is new, which is what lets an append claim a concrete zero.
 *
 * @param {string} partitionDir
 * @returns {boolean}
 */
function cursorFileExists(partitionDir) {
  return fs.existsSync(path.join(partitionDir, CURSOR_FILE))
}

/**
 * The `pendingFallbacks` entry an append should write, as a spreadable
 * fragment. A first write to a fresh partition starts the count at the
 * appended tally, so tables born after the field existed always carry a
 * concrete number. On an existing cursor an absent count means "unknown"
 * (written before the field existed, or unreadable, over a table that may
 * hold old marker rows), and an append of zero marker rows must preserve
 * that: claiming zero would let maintenance skip the legacy table's one
 * seeding scan and strand its split twins. Once a marker row lands the
 * count turns concrete regardless - an undercount only until the next
 * rewrite records the exact remainder, and any positive value routes to
 * that rewrite.
 *
 * @param {PartitionCursor} cursor
 * @param {boolean} cursorExisted whether a cursor FILE is present, not whether it parsed
 * @param {number} fallbackAppended
 * @returns {{ pendingFallbacks?: number }}
 */
function pendingFallbacksAfterAppend(cursor, cursorExisted, fallbackAppended) {
  if (cursorExisted && cursor.pendingFallbacks === undefined && fallbackAppended === 0) return {}
  return { pendingFallbacks: (cursor.pendingFallbacks ?? 0) + fallbackAppended }
}

/**
 * Walk the datasets tree to discover logical partitions that carry a
 * cursor.json.  Filters by the supplied scope (datasets, date range).
 *
 * @param {string} cacheRoot
 * @param {Partial<QueryScope>} [scope]
 * @returns {Promise<CachePartitionMeta[]>}
 */
export async function discoverCachePartitions(cacheRoot, scope = {}) {
  /** @type {CachePartitionMeta[]} */
  const results = []
  const root = datasetsRoot(cacheRoot)
  try {
    await fsPromises.access(root)
  } catch {
    return results
  }
  await walk(root)
  return results

  /** @param {string} dir */
  async function walk(dir) {
    /** @type {Dirent[]} */
    let entries
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const hasCursor = entries.some((e) => e.isFile() && e.name === CURSOR_FILE)
    const hasIceberg = !hasCursor && icebergTableExists(dir)
    if (hasCursor || hasIceberg) {
      const cursor = hasCursor ? readCursorSync(dir) : { epoch: 0, rowCount: 0, compaction: null }
      const rel = path.relative(root, dir)
      const parts = rel.split(path.sep)
      const dataset = parts[0]
      if (scope.datasets && scope.datasets.length > 0 && !scope.datasets.includes(dataset)) return
      /** @type {Record<string, string>} */
      const partition = {}
      for (let i = 1; i < parts.length; i++) {
        const eq = parts[i].indexOf('=')
        if (eq > 0) {
          partition[parts[i].slice(0, eq)] = parts[i].slice(eq + 1)
        }
      }
      if (partition.date) {
        if (scope.date && partition.date !== scope.date) return
        if (scope.dates && scope.dates.length > 0 && !scope.dates.includes(partition.date)) return
        if (scope.from && partition.date < scope.from) return
        if (scope.to && partition.date > scope.to) return
      }
      results.push({
        dataset,
        partition,
        path: dir,
        epoch: cursor.epoch,
        rowCount: cursor.rowCount,
        legacy: hasIceberg,
      })
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('epoch=')) continue
      if (entry.name.startsWith('table')) continue
      if (entry.name === SPOOL_DIR) continue
      if (entry.name === RETIRED_DIR) continue
      await walk(path.join(dir, entry.name))
    }
  }
}

/**
 * Resolve the source partition key from a row using the fallback
 * chain: client_name → conversation_source → provider → "unknown".
 * Used as the default source resolver for all datasets when no
 * `CachePartitioningDeclaration` is registered. Datasets without any
 * of these fields will be grouped under "unknown".
 *
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function resolveClientName(row) {
  return nonEmpty(row.client_name) ?? nonEmpty(row.conversation_source) ?? nonEmpty(row.provider) ?? 'unknown'
}

/**
 * Extract a `YYYY-MM-DD` date string from common timestamp fields.
 * Returns `undefined` when no recognizable timestamp is present.
 *
 * @param {Record<string, unknown>} row
 * @returns {string | undefined}
 */
export function resolvePartitionDate(row) {
  const ts = row.timestamp ?? row.created_at ?? row.recorded_at ?? row.date
  if (typeof ts === 'string') {
    const match = ts.match(/^(\d{4}-\d{2}-\d{2})/)
    if (match) return match[1]
    const d = new Date(ts)
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }
  if (ts instanceof Date) return ts.toISOString().slice(0, 10)
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString().slice(0, 10)
  return undefined
}

/**
 * Derive the partition segments for a row by inspecting its data for
 * client and date fields.  Falls back to `['all']` when neither
 * dimension is resolvable, preserving backwards compatibility with
 * datasets that carry no partition-relevant columns.
 *
 * @param {Record<string, unknown>} row
 * @returns {string[]}
 */
export function resolvePartitionSegments(row) {
  const client = resolveClientName(row)
  const date = resolvePartitionDate(row)
  if (client === 'unknown' && !date) return ['all']
  /** @type {string[]} */
  const segments = []
  segments.push(`client=${client}`)
  if (date) segments.push(`date=${date}`)
  return segments
}

/**
 * Sanitize a value for use as a filesystem path segment.
 * Replaces path separators, control characters, and reserved names with
 * safe alternatives.
 *
 * @param {string} value
 * @returns {string}
 */
export function sanitizePathSegment(value) {
  let safe = value.replace(/[\x00-\x1f/\\:*?"<>|]/g, '_')
  if (safe === '.' || safe === '..') safe = `_${safe}_`
  if (safe.length === 0) safe = '_empty_'
  return safe
}

/**
 * Resolve path segments for the source table using the dataset's
 * declared source columns. Falls back through the column list in
 * order, then to the declaration's fallback value.
 *
 * @param {Record<string, unknown>} row
 * @param {CachePartitioningDeclaration} declaration
 * @returns {string[]}
 */
export function resolveSourceSegments(row, declaration) {
  let source = declaration.source.fallback ?? 'unknown'
  for (const col of declaration.source.columns) {
    const val = nonEmpty(row[col])
    if (val) {
      source = val
      break
    }
  }
  return [`source=${sanitizePathSegment(source)}`]
}

/**
 * Validate that required Iceberg partition fields are present and
 * non-empty in a row.
 *
 * @param {Record<string, unknown>} row
 * @param {CachePartitioningDeclaration} declaration
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateIcebergPartitionFields(row, declaration) {
  /** @type {string[]} */
  const missing = []
  for (const field of declaration.iceberg.fields) {
    if (field.required && nonEmpty(row[field.column]) === undefined) {
      missing.push(field.column)
    }
  }
  return { valid: missing.length === 0, missing }
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  if (value == null) return undefined
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  return String(value)
}
