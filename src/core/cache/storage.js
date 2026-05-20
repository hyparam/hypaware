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

/** @typedef {import('../../../collectivus-plugin-kernel-types').ColumnSpec} ColumnSpec */
/** @typedef {import('../../../collectivus-plugin-kernel-types').QueryStorageService} QueryStorageService */

/**
 * @typedef {QueryStorageService & {
 *   dataSourceForTable(tablePath: string): Promise<import('squirreling').AsyncDataSource | null>
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

  return {
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
          const { bytesWritten } = await appendRowsToTable(tablePath, columns, rows)
          span.setAttribute('bytes_written', bytesWritten)
        },
        { component: 'cache' }
      )
    },

    tableExists(tablePath) {
      return icebergTableExists(tablePath)
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
  }
}
