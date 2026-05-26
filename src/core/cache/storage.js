// @ts-check

import { Attr, withSpan } from '../observability/index.js'
import {
  dataSourceForTable,
  scanRowsFromTable,
  tableExists as icebergTableExists,
  tableUrl as icebergTableUrl,
} from './iceberg/store.js'
import {
  appendRowsToPartition as appendRowsToPartitionImpl,
  discoverCachePartitions as discoverCachePartitionsImpl,
  readCursorSync,
  resolvePartitionSegments,
} from './partition.js'
import { cacheTablePath, datasetForTablePath } from './paths.js'
import { createCacheSpool, DEFAULT_SPOOL_BYTES_THRESHOLD } from './spool.js'

import path from 'node:path'

/**
 * @import { ColumnSpec, QueryScope, QueryStorageService } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from './types.d.ts'
 */

/**
 * Resolve a tablePath to the Iceberg table directory.  When the path
 * is a partition directory (has cursor.json), the actual Iceberg table
 * lives at `epoch=<N>/`.  For flat paths without a cursor the path is
 * returned unchanged.
 *
 * @param {string} tablePath
 * @returns {string}
 */
function resolveIcebergDir(tablePath) {
  const cursor = readCursorSync(tablePath)
  if (cursor.rowCount > 0 || cursor.epoch > 0) {
    return path.join(tablePath, `epoch=${cursor.epoch}`)
  }
  return tablePath
}

/**
 * Build the kernel-owned `QueryStorageService`. Plugins reach this
 * through `ctx.storage` during activation, refresh, and dataset
 * scans; the dispatcher hands the same instance to built-in commands.
 *
 * Every `appendRows` call is wrapped in a `cache.append` span carrying
 * `hyp_dataset`, `row_count`, and `bytes_written` — the contract the
 * Phase 4 smoke (and the SQL assertion in the implementation plan)
 * exercise.
 *
 * @param {{ cacheRoot: string }} args
 * @returns {ExtendedQueryStorageService}
 */
export function createQueryStorageService({ cacheRoot }) {
  if (!cacheRoot) throw new Error('createQueryStorageService: cacheRoot is required')
  const spool = createCacheSpool({
    cacheRoot,
    async appendChunk(tablePath, columns, rows) {
      const dataset = datasetForTablePath(cacheRoot, tablePath) ?? 'unknown'
      /** @type {Map<string, { segments: string[], rows: Record<string, unknown>[] }>} */
      const groups = new Map()
      for (const row of rows) {
        const segments = resolvePartitionSegments(row)
        const key = segments.join('/')
        let group = groups.get(key)
        if (!group) {
          group = { segments, rows: [] }
          groups.set(key, group)
        }
        group.rows.push(row)
      }
      let totalBytes = 0
      for (const { segments, rows: groupRows } of groups.values()) {
        const result = await appendRowsToPartitionImpl(cacheRoot, dataset, segments, columns, groupRows)
        totalBytes += result.bytesWritten
      }
      return { bytesWritten: totalBytes }
    },
  })

  /** @type {ExtendedQueryStorageService} */
  const service = {
    cacheRoot,

    cacheTablePath(dataset, partitionSegments) {
      return cacheTablePath(cacheRoot, dataset, partitionSegments)
    },

    async appendRows(tablePath, columns, rows) {
      const dataset = datasetForTablePath(cacheRoot, tablePath) ?? 'unknown'
      await withSpan(
        'cache.append',
        {
          [Attr.COMPONENT]: 'cache',
          [Attr.OPERATION]: 'cache.append',
          [Attr.DATASET]: dataset,
          row_count: rows.length,
          status: 'ok',
        },
        async (span) => {
          const { bytesWritten, pendingBytes } = await spool.append(tablePath, columns, rows)
          span.setAttribute('bytes_written', bytesWritten)
          span.setAttribute('pending_bytes', pendingBytes)
          span.setAttribute('spooled', true)
          if (pendingBytes >= DEFAULT_SPOOL_BYTES_THRESHOLD) {
            void service.flushTable(tablePath, { reason: 'size_threshold' }).catch(() => undefined)
          }
        },
        { component: 'cache' }
      )
    },

    tableExists(tablePath) {
      const dir = resolveIcebergDir(tablePath)
      return icebergTableExists(dir) || spool.hasPendingSync(tablePath)
    },

    tableUrl(tablePath) {
      return icebergTableUrl(resolveIcebergDir(tablePath))
    },

    readRows(tablePath, columns) {
      return scanRowsFromTable(resolveIcebergDir(tablePath), columns)
    },

    dataSourceForTable(tablePath) {
      return dataSourceForTable(resolveIcebergDir(tablePath))
    },

    async flushTable(tablePath, opts = {}) {
      const dataset = datasetForTablePath(cacheRoot, tablePath) ?? 'unknown'
      return withSpan(
        'cache.flush',
        {
          [Attr.COMPONENT]: 'cache',
          [Attr.OPERATION]: 'cache.flush',
          [Attr.DATASET]: dataset,
          flush_reason: opts.reason ?? 'manual',
          force: opts.force === true,
          status: 'ok',
        },
        async (span) => {
          const result = await spool.flushTable(tablePath, opts)
          span.setAttribute('row_count', result.rowCount)
          span.setAttribute('chunk_count', result.chunkCount)
          span.setAttribute('bytes_written', result.bytesWritten)
          span.setAttribute('pending_bytes', result.pendingBytes)
          span.setAttribute('flushed', result.flushed)
          return result
        },
        { component: 'cache' }
      )
    },

    async flushAll(opts = {}) {
      return withSpan(
        'cache.flush_all',
        {
          [Attr.COMPONENT]: 'cache',
          [Attr.OPERATION]: 'cache.flush_all',
          flush_reason: opts.reason ?? 'manual',
          force: opts.force === true,
          status: 'ok',
        },
        async (span) => {
          const result = await spool.flushAll(opts)
          span.setAttribute('row_count', result.rowCount)
          span.setAttribute('chunk_count', result.chunkCount)
          span.setAttribute('bytes_written', result.bytesWritten)
          span.setAttribute('pending_bytes', result.pendingBytes)
          span.setAttribute('flushed', result.flushed)
          return result
        },
        { component: 'cache' }
      )
    },

    async appendRowsToPartition(dataset, partitionSegments, columns, rows) {
      await withSpan(
        'cache.append_partition',
        {
          [Attr.COMPONENT]: 'cache',
          [Attr.OPERATION]: 'cache.append_partition',
          [Attr.DATASET]: dataset,
          row_count: rows.length,
          status: 'ok',
        },
        async (span) => {
          const result = await appendRowsToPartitionImpl(cacheRoot, dataset, partitionSegments, columns, rows)
          span.setAttribute('bytes_written', result.bytesWritten)
          span.setAttribute('appended', result.appended)
        },
        { component: 'cache' }
      )
    },

    discoverCachePartitions(scope) {
      return discoverCachePartitionsImpl(cacheRoot, scope)
    },

    pendingInfo(tablePath) {
      return spool.pendingInfo(tablePath)
    },
  }
  return service
}
