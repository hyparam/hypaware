// @ts-check

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { appendRowsToTable } from './iceberg/store.js'
import { cacheTablePath, datasetsRoot } from './paths.js'

/**
 * @import { ColumnSpec, QueryScope } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { CachePartitionMeta, PartitionCursor } from './types.d.ts'
 */

const CURSOR_FILE = 'cursor.json'
const SPOOL_DIR = '_hypaware_spool'

/**
 * Read the cursor for a logical partition directory.  Returns the
 * default epoch-0 cursor when the file is missing or unparseable.
 *
 * @param {string} partitionDir
 * @returns {PartitionCursor}
 */
export function readCursorSync(partitionDir) {
  try {
    const raw = fs.readFileSync(path.join(partitionDir, CURSOR_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      epoch: typeof parsed.epoch === 'number' ? parsed.epoch : 0,
      rowCount: typeof parsed.rowCount === 'number' ? parsed.rowCount : 0,
      compaction: parsed.compaction ?? null,
    }
  } catch {
    return { epoch: 0, rowCount: 0, compaction: null }
  }
}

/**
 * Atomically write cursor.json for a logical partition.
 *
 * @param {string} partitionDir
 * @param {PartitionCursor} cursor
 */
export async function writeCursor(partitionDir, cursor) {
  await fsPromises.mkdir(partitionDir, { recursive: true })
  const tmp = path.join(partitionDir, `${CURSOR_FILE}.tmp.${process.pid}.${Date.now()}`)
  await fsPromises.writeFile(tmp, JSON.stringify(cursor, null, 2), 'utf8')
  await fsPromises.rename(tmp, path.join(partitionDir, CURSOR_FILE))
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
  const cursor = readCursorSync(partitionDir)
  const epochDir = path.join(partitionDir, `epoch=${cursor.epoch}`)
  const result = await appendRowsToTable(epochDir, columns, rows)
  await writeCursor(partitionDir, {
    epoch: cursor.epoch,
    rowCount: cursor.rowCount + rows.length,
    compaction: cursor.compaction,
  })
  return result
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
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.isFile() && e.name === CURSOR_FILE)) {
      const cursor = readCursorSync(dir)
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
      })
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('epoch=')) continue
      if (entry.name === SPOOL_DIR) continue
      await walk(path.join(dir, entry.name))
    }
  }
}

/**
 * Resolve the `client_name` partition key for an ai_gateway_messages
 * row using the fallback chain: client_name → conversation_source →
 * provider → "unknown".
 *
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function resolveClientName(row) {
  return nonEmpty(row.client_name) ?? nonEmpty(row.conversation_source) ?? nonEmpty(row.provider) ?? 'unknown'
}

/** @param {unknown} value */
function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
