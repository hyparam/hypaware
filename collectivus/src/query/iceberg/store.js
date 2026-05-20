import fs from 'node:fs'
import path from 'node:path'
import { fileCatalog, icebergAppend, icebergCreateTable, icebergDataSource, icebergRead, loadLatestFileCatalogMetadata } from 'icebird'
import { createLocalIcebergIO, tableUrlForDir } from './resolver.js'
import { icebergSchemaForColumns, rowsToIcebergRecords } from './schema.js'

/**
 * @import { ColumnSpec } from '../../upload/upload.d.ts'
 * @import { QueryCacheCursor } from './types.d.ts'
 */

/**
 * @param {string} tablePath
 * @returns {string}
 */
export function queryCacheTableUrl(tablePath) {
  return tableUrlForDir(tablePath)
}

/**
 * @param {string} tablePath
 * @returns {boolean}
 */
export function queryCacheTableExists(tablePath) {
  const metadataDir = path.join(tablePath, 'metadata')
  try {
    return fs.readdirSync(metadataDir).some((entry) => /\.metadata\.json$/.test(entry))
  } catch {
    return false
  }
}

/**
 * @param {QueryCacheCursor | undefined} cursor
 * @returns {boolean}
 */
export function cursorTableExists(cursor) {
  return Boolean(cursor && queryCacheTableExists(cursor.table_path))
}

/**
 * @param {string} tablePath
 * @param {readonly ColumnSpec[]} columns
 * @param {Record<string, unknown>[]} rows
 * @returns {Promise<{ tableUrl: string, appended: boolean }>}
 */
export async function appendRowsToTable(tablePath, columns, rows) {
  const tableUrl = queryCacheTableUrl(tablePath)
  const { resolver, lister } = await createLocalIcebergIO()
  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
  const schema = icebergSchemaForColumns(columns)

  if (!queryCacheTableExists(tablePath)) {
    await icebergCreateTable({
      catalog,
      tableUrl,
      schema,
      formatVersion: 3,
    })
  }
  if (rows.length > 0) {
    await icebergAppend({
      catalog,
      tableUrl,
      records: rowsToIcebergRecords([...columns], rows),
    })
  }
  return { tableUrl, appended: rows.length > 0 }
}

/**
 * @param {QueryCacheCursor} cursor
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function readRowsFromCursor(cursor) {
  if (!queryCacheTableExists(cursor.table_path)) return []
  const { resolver, lister } = await createLocalIcebergIO()
  const tableUrl = cursor.table_url || queryCacheTableUrl(cursor.table_path)
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  if (metadata['current-snapshot-id'] === undefined || !metadata.snapshots?.length) return []
  const rows = await icebergRead({ tableUrl, metadata, resolver })
  return /** @type {Record<string, unknown>[]} */ (rows)
}

/**
 * @param {QueryCacheCursor} cursor
 * @param {string[]} columns
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export async function* scanRowsFromCursor(cursor, columns) {
  if (!queryCacheTableExists(cursor.table_path)) return
  const { resolver, lister } = await createLocalIcebergIO()
  const tableUrl = cursor.table_url || queryCacheTableUrl(cursor.table_path)
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  if (metadata['current-snapshot-id'] === undefined || !metadata.snapshots?.length) return
  const source = await icebergDataSource({ tableUrl, metadata, resolver, lister })
  const scan = source.scan({ columns })
  for await (const row of scan.rows()) {
    yield await resolveAsyncRow(row, columns)
  }
}

/**
 * @param {import('squirreling').AsyncRow} row
 * @param {string[]} columns
 * @returns {Promise<Record<string, unknown>>}
 */
async function resolveAsyncRow(row, columns) {
  /** @type {Record<string, unknown>} */
  const out = row.resolved ? { ...row.resolved } : {}
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(out, column)) continue
    out[column] = await row.cells[column]?.()
  }
  return out
}
