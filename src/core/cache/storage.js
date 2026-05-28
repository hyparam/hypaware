// @ts-check

import { Attr, getLogger, getMeter, withSpan } from '../observability/index.js'
import {
  dataSourceForTable,
  scanRowsFromTable,
  tableExists as icebergTableExists,
  tableUrl as icebergTableUrl,
} from './iceberg/store.js'
import {
  appendRowsToPartition as appendRowsToPartitionImpl,
  appendRowsToSourceTable as appendRowsToSourceTableImpl,
  discoverCachePartitions as discoverCachePartitionsImpl,
  readCursorSync,
  resolveClientName,
  resolveSourceSegments,
  sanitizePathSegment,
  validateIcebergPartitionFields,
} from './partition.js'
import { cacheTablePath, datasetForTablePath } from './paths.js'
import { createCacheSpool, DEFAULT_SPOOL_BYTES_THRESHOLD } from './spool.js'
import { INTERNAL_FIELDS } from './streaming-reader.js'

import path from 'node:path'

/**
 * @import { ColumnSpec, QueryScope, QueryStorageService } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { CachePartitioningDeclaration, ExtendedQueryStorageService } from './types.d.ts'
 * @import { AsyncCells } from 'squirreling'
 */

/**
 * Resolve a tablePath to the Iceberg table directory.
 *
 * - source-table layout (`cursor.layout === 'source-table'`): `<tablePath>/table`
 * - legacy epoch layout (`cursor.layout` absent or `'epoch'`): `<tablePath>/epoch=<N>`
 * - direct legacy Iceberg table (no cursor, table exists at tablePath): unchanged
 *
 * @param {string} tablePath
 * @returns {string}
 */
export function resolveIcebergDir(tablePath) {
  const cursor = readCursorSync(tablePath)
  if (cursor.layout === 'source-table') {
    return path.join(tablePath, cursor.tableDir ?? 'table')
  }
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
 * @param {{ cacheRoot: string, getDeclaration?: (dataset: string) => CachePartitioningDeclaration | undefined }} args
 * @returns {ExtendedQueryStorageService}
 */
export function createQueryStorageService({ cacheRoot, getDeclaration }) {
  if (!cacheRoot) throw new Error('createQueryStorageService: cacheRoot is required')
  const logger = getLogger('cache')
  const meter = getMeter('cache')
  const partitionDropCounter = meter.createCounter('hyp_partition_validation_drops', {
    description: 'Rows dropped due to missing required Iceberg partition fields',
  })
  const spool = createCacheSpool({
    cacheRoot,
    async appendChunk(tablePath, columns, rows) {
      const dataset = datasetForTablePath(cacheRoot, tablePath) ?? 'unknown'
      const declaration = getDeclaration?.(dataset)
      /** @type {Map<string, { segments: string[], rows: Record<string, unknown>[] }>} */
      const groups = new Map()
      let droppedCount = 0
      /** @type {Map<string, number>} */
      const missingFieldCounts = new Map()
      for (const row of rows) {
        if (declaration) {
          const { valid, missing } = validateIcebergPartitionFields(row, declaration)
          if (!valid) {
            droppedCount++
            const missingKey = missing.join(',')
            missingFieldCounts.set(missingKey, (missingFieldCounts.get(missingKey) ?? 0) + 1)
            partitionDropCounter.add(1, {
              [Attr.DATASET]: dataset,
              missing_fields: missing.join(','),
            })
            continue
          }
        }
        const segments = declaration
          ? resolveSourceSegments(row, declaration)
          : [`source=${sanitizePathSegment(resolveClientName(row))}`]
        const key = segments.join('/')
        let group = groups.get(key)
        if (!group) {
          group = { segments, rows: [] }
          groups.set(key, group)
        }
        group.rows.push(row)
      }
      let totalBytes = 0
      const opts = declaration ? { declaration } : undefined
      for (const { segments, rows: groupRows } of groups.values()) {
        const result = await appendRowsToSourceTableImpl(cacheRoot, dataset, segments, columns, groupRows, opts)
        totalBytes += result.bytesWritten
      }
      if (droppedCount > 0) {
        logger.warn('cache.partition_validation_drops', {
          [Attr.DATASET]: dataset,
          dropped_count: droppedCount,
          row_count: rows.length,
          missing_fields: Array.from(missingFieldCounts.entries())
            .map(([fields, count]) => `${fields}:${count}`)
            .join(';'),
        })
      }
      return { bytesWritten: totalBytes, droppedCount }
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

    async *readRows(tablePath, columns) {
      const projected = columns?.filter((c) => !INTERNAL_FIELDS.includes(c))
      for await (const row of scanRowsFromTable(resolveIcebergDir(tablePath), projected)) {
        for (const f of INTERNAL_FIELDS) delete row[f]
        yield row
      }
    },

    async dataSourceForTable(tablePath) {
      const source = await dataSourceForTable(resolveIcebergDir(tablePath))
      if (!source) return null
      return {
        numRows: source.numRows,
        columns: source.columns.filter((c) => !INTERNAL_FIELDS.includes(c)),
        scan(options) {
          const inner = source.scan({
            ...options,
            columns: options.columns?.filter((c) => !INTERNAL_FIELDS.includes(c)),
          })
          return {
            appliedWhere: inner.appliedWhere,
            appliedLimitOffset: inner.appliedLimitOffset,
            async *rows() {
              for await (const row of inner.rows()) {
                const filteredColumns = row.columns.filter((c) => !INTERNAL_FIELDS.includes(c))
                const filteredResolved = row.resolved
                  ? Object.fromEntries(Object.entries(row.resolved).filter(([k]) => !INTERNAL_FIELDS.includes(k)))
                  : undefined
                /** @type {AsyncCells} */
                const filteredCells = {}
                for (const col of filteredColumns) {
                  if (row.cells && col in row.cells) filteredCells[col] = row.cells[col]
                }
                yield { ...row, columns: filteredColumns, cells: filteredCells, resolved: filteredResolved }
              }
            },
          }
        },
      }
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
          span.setAttribute('dropped_count', result.droppedCount)
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
          span.setAttribute('dropped_count', result.droppedCount)
          span.setAttribute('flushed', result.flushed)
          return result
        },
        { component: 'cache' }
      )
    },

    async appendRowsToPartition(dataset, partitionSegments, columns, rows) {
      return withSpan(
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
