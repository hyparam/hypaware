// @ts-check

import { Attr, withSpan } from '../observability/index.js'
import {
  appendRowsToTable,
  dataSourceForTable,
  scanRowsFromTable,
  tableExists as icebergTableExists,
  tableUrl as icebergTableUrl,
} from './iceberg/store.js'
import { cacheTablePath, datasetForTablePath } from './paths.js'
import { createCacheSpool, DEFAULT_SPOOL_BYTES_THRESHOLD } from './spool.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').ColumnSpec} ColumnSpec */
/** @typedef {import('../../../collectivus-plugin-kernel-types').QueryStorageService} QueryStorageService */

/**
 * @typedef {QueryStorageService & {
 *   dataSourceForTable(tablePath: string): Promise<import('squirreling').AsyncDataSource | null>,
 *   flushTable(tablePath: string, opts?: { reason?: string, force?: boolean }): Promise<{ flushed: boolean, rowCount: number, chunkCount: number, bytesWritten: number, pendingBytes: number, reason: string }>,
 *   flushAll(opts?: { reason?: string, force?: boolean }): Promise<{ flushed: boolean, rowCount: number, chunkCount: number, bytesWritten: number, pendingBytes: number, reason: string }>,
 *   pendingInfo(tablePath: string): Promise<{ pending: boolean, pendingBytes: number, lastFlushAtMs: number | null }>
 * }} ExtendedQueryStorageService
 */

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
    appendChunk(tablePath, columns, rows) {
      return appendRowsToTable(tablePath, columns, rows)
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
      return icebergTableExists(tablePath) || spool.hasPendingSync(tablePath)
    },

    tableUrl(tablePath) {
      return icebergTableUrl(tablePath)
    },

    readRows(tablePath, columns) {
      return scanRowsFromTable(tablePath, columns)
    },

    dataSourceForTable(tablePath) {
      return dataSourceForTable(tablePath)
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

    pendingInfo(tablePath) {
      return spool.pendingInfo(tablePath)
    },
  }
  return service
}
