// @ts-check

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { Attr, getLogger } from '../observability/index.js'
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
 * A `tableDir` that names anything outside its own partition makes the
 * whole cursor unreadable, and it is rejected here rather than at any call
 * site: see {@link generationDirIsContained}.
 *
 * @ref LLP 0323#one-gate [implements]: the containment check belongs to the reader every destructive path already shares.
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
      if (!generationDirIsContained(partitionDir, parsed.tableDir)) {
        reportEscapingTableDir(partitionDir, parsed.tableDir)
        return null
      }
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
 * Does `tableDir` name a generation directory inside `partitionDir`?
 *
 * Every writer in the tree mints a bare `table` or `table-<ms>` name
 * (`generationLayout`'s `nextDirName`, the context-graph rewrite, and the
 * first append below), so a value that resolves anywhere else did not come
 * from `hyp`. It came from a corrupt or edited `cursor.json`, and the
 * readers downstream are not all read-only: maintenance joins this name
 * onto the partition path and then sweeps, unlinks, and rewrites whatever
 * it finds there. One `..` segment therefore aims destructive cache
 * maintenance at a directory the cache does not own.
 *
 * One segment, because the consumers do not all resolve the value: the
 * orphan sweep compares it to a `readdir` entry name (`entry.name ===
 * liveDirName`), so `./table` and `table/` resolve to the live
 * generation while matching no entry, and the sweep reclaims the very
 * directory the cursor meant to protect. A spelling that resolves inside
 * the partition is therefore not enough; the string itself has to be the
 * name. That is also what every writer mints, so nothing legitimate is
 * spelled any other way.
 *
 * Resolution is still checked after that, because `.` and `..` are both
 * single segments: one names the partition, which holds the cursor rather
 * than a generation, and the other leaves it.
 *
 * @ref LLP 0323#contained [implements]: a cursor may name a generation only inside its own partition, by its own name.
 * @param {string} partitionDir
 * @param {string} tableDir
 * @returns {boolean}
 */
function generationDirIsContained(partitionDir, tableDir) {
  if (tableDir === '' || tableDir !== path.basename(tableDir)) return false
  const root = path.resolve(partitionDir)
  return path.resolve(root, tableDir).startsWith(root + path.sep)
}

/**
 * Say that a cursor was rejected for naming a generation outside its
 * partition, and say it out loud.
 *
 * The rejection is otherwise indistinguishable from every other unreadable
 * cursor: the partition stops compacting, stops sweeping, and reads as
 * empty until the next append rewrites the cursor. That is the safe
 * behaviour and the useless diagnostic - "my rows vanished" and "a file I
 * never wrote is in my cache" are two symptoms an operator would otherwise
 * have to reconcile against silence.
 *
 * `warn`, not `error`: nothing failed, and the tick carries on.
 *
 * @ref LLP 0323#say-it [implements]: this is the one corrupt-cursor case that knows its cause, so it does not degrade silently.
 * @param {string} partitionDir
 * @param {string} tableDir
 */
function reportEscapingTableDir(partitionDir, tableDir) {
  try {
    getLogger('cache').warn(
      'cursor.tableDir names a directory outside its partition; treating the cursor as unreadable',
      {
        [Attr.OPERATION]: 'cache.cursor_read',
        [Attr.ERROR_KIND]: 'cursor_table_dir_escapes_partition',
        partition_dir: partitionDir,
        table_dir: tableDir,
      }
    )
  } catch { /* a cursor read must not fail on a logger provider that is not installed */ }
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
    // Asked BEFORE the append, which creates the table on first use: after
    // it every partition looks like one that already held rows.
    const mayHoldUncountedRows = partitionHasCommittedRows(partitionDir, icebergDir)
    const declaration = options?.declaration
    const result = await appendRowsToTable(icebergDir, columns, rows, declaration ? { declaration } : undefined)
    await writeCursor(partitionDir, {
      epoch: cursor.epoch,
      rowCount: cursor.rowCount + rows.length,
      compaction: cursor.compaction,
      layout: 'source-table',
      tableDir,
      retention: cursor.retention,
      ...pendingFallbacksAfterAppend(cursor, mayHoldUncountedRows, fallbackAppended),
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
    // As above: asked before the append creates the epoch's table.
    const mayHoldUncountedRows = partitionHasCommittedRows(partitionDir, epochDir)
    const result = await appendRowsToTable(epochDir, columns, rows)
    await writeCursor(partitionDir, {
      epoch: cursor.epoch,
      rowCount: cursor.rowCount + rows.length,
      compaction: cursor.compaction,
      ...pendingFallbacksAfterAppend(cursor, mayHoldUncountedRows, fallbackAppended),
    })
    return result
  })
}

/**
 * May this partition already hold committed rows that no cursor count
 * covers? Yes whenever a `cursor.json` is present - deliberately NOT "did
 * {@link tryReadCursorSync} return a cursor", which also answers null for a
 * file that exists but cannot be parsed, and a partition whose cursor is
 * unreadable is not a fresh one. Yes also when the cursor is gone but the
 * Iceberg table is not: that is what a crash between an append and its
 * cursor write leaves behind, and a source-table partition in that state is
 * invisible to {@link discoverCachePartitions} until an append restores its
 * cursor, so nothing else would ever re-derive the count for it.
 *
 * Only when NEITHER exists is the partition provably new, and only then may
 * an append claim a concrete zero.
 *
 * @param {string} partitionDir
 * @param {string} tableDir  the Iceberg table this append writes into
 * @returns {boolean}
 */
function partitionHasCommittedRows(partitionDir, tableDir) {
  return fs.existsSync(path.join(partitionDir, CURSOR_FILE)) || icebergTableExists(tableDir)
}

/**
 * The `pendingFallbacks` entry an append should write, as a spreadable
 * fragment. A first write to a provably new partition starts the count at
 * the appended tally, so tables born after the field existed always carry a
 * concrete number. Over anything that may already hold committed rows an
 * absent count means "unknown" (a cursor written before the field existed,
 * an unreadable one, or a table whose cursor was lost), and an append of
 * zero marker rows must preserve that: claiming zero would let maintenance
 * skip that table's one seeding scan and strand its split twins. Once a
 * marker row lands the count turns concrete regardless - an undercount only
 * until the next rewrite records the exact remainder, and any positive
 * value routes to that rewrite.
 *
 * @param {PartitionCursor} cursor
 * @param {boolean} mayHoldUncountedRows see {@link partitionHasCommittedRows}
 * @param {number} fallbackAppended
 * @returns {{ pendingFallbacks?: number }}
 */
function pendingFallbacksAfterAppend(cursor, mayHoldUncountedRows, fallbackAppended) {
  if (mayHoldUncountedRows && cursor.pendingFallbacks === undefined && fallbackAppended === 0) return {}
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
