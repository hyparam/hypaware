// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import {
  fileCatalog,
  icebergAppend,
  icebergCreateTable,
  icebergDataSource,
  icebergRead,
  loadLatestFileCatalogMetadata,
} from 'icebird'

import { createLocalIcebergIO, tableUrlForDir } from './resolver.js'
import {
  icebergSchemaForColumns,
  mergeFieldIdsFromTable,
  partitionSpecForDeclaration,
  rowsToIcebergRecords,
  validatePartitionSpecStability,
} from './schema.js'

/**
 * @import { ColumnSpec } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { CachePartitioningDeclaration } from '../types.d.ts'
 * @import { Lister, PartitionSpec, Resolver, Schema, TableMetadata } from 'icebird/src/types.js'
 * @import { AsyncDataSource, AsyncRow } from 'squirreling'
 */

/**
 * Reusable cache for the local IO pair. Constructed once per process —
 * the resolver/lister are pure functions over the filesystem so there's
 * no per-table state to worry about.
 *
 * @type {Promise<{ resolver: Resolver, lister: Lister }> | null}
 */
let cachedIO = null

function getLocalIO() {
  cachedIO ??= createLocalIcebergIO()
  return cachedIO
}

/**
 * Tests reset the IO cache so `installObservability` resets are
 * matched by a fresh resolver — keeps smoke-flow isolation honest.
 */
export function resetLocalIO() {
  cachedIO = null
}

/**
 * @param {string} tablePath
 * @returns {string}
 */
export function tableUrl(tablePath) {
  return tableUrlForDir(tablePath)
}

/**
 * @param {string} tablePath
 * @returns {boolean}
 */
export function tableExists(tablePath) {
  const metadataDir = path.join(tablePath, 'metadata')
  try {
    return fs.readdirSync(metadataDir).some((entry) => /\.metadata\.json$/.test(entry))
  } catch {
    return false
  }
}

/**
 * @typedef {{ declaration?: CachePartitioningDeclaration, partitionSpec?: PartitionSpec }} AppendOptions
 */

/**
 * Append `rows` to the Iceberg table rooted at `tablePath`, creating
 * the table on first use. Returns the byte size of the newest data
 * files written by this append so callers can populate
 * `bytes_written` on observability spans.
 *
 * When `options.declaration` is provided:
 * - **New tables** are created with an Iceberg partition spec derived
 *   from the declaration.
 * - **Existing tables** validate schema evolution (stable field IDs,
 *   no partition-column removal/type changes, no new required columns)
 *   and reject partition-spec drift.
 *
 * @param {string} tablePath
 * @param {readonly ColumnSpec[]} columns
 * @param {Record<string, unknown>[]} rows
 * @param {AppendOptions} [options]
 * @returns {Promise<{ tableUrl: string, appended: boolean, bytesWritten: number }>}
 */
export async function appendRowsToTable(tablePath, columns, rows, options) {
  const url = tableUrlForDir(tablePath)
  const { resolver, lister } = await getLocalIO()
  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
  const schema = icebergSchemaForColumns(columns)
  const declaration = options?.declaration

  if (!tableExists(tablePath)) {
    /** @type {PartitionSpec | undefined} */
    const partitionSpec = declaration
      ? partitionSpecForDeclaration(declaration, schema)
      : options?.partitionSpec
    await icebergCreateTable({
      catalog,
      tableUrl: url,
      schema,
      formatVersion: 3,
      partitionSpec,
    })
  } else if (declaration) {
    const { metadata: existing } = await loadLatestFileCatalogMetadata({
      tableUrl: url, resolver, lister,
    })
    const existingSchema = currentSchema(existing)
    if (existingSchema) {
      const partitionColumns = new Set(declaration.iceberg.fields.map(f => f.column))
      mergeFieldIdsFromTable(columns, existingSchema, partitionColumns)
    }
    const existingSpec = currentPartitionSpec(existing)
    if (existingSpec) {
      validatePartitionSpecStability(declaration, existingSpec)
    }
  }
  /** @type {TableMetadata | null} */
  let metadata = null
  if (rows.length > 0) {
    metadata = await icebergAppend({
      catalog,
      tableUrl: url,
      records: rowsToIcebergRecords(columns, rows),
    })
  }
  const bytesWritten = metadata ? addedFilesSize(metadata) : 0
  return { tableUrl: url, appended: rows.length > 0, bytesWritten }
}

/**
 * Read every row in the table. Returns an array, so callers should
 * pass small tables or stick to `scanRowsFromTable` for streaming.
 *
 * @param {string} tablePath
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function readRowsFromTable(tablePath) {
  if (!tableExists(tablePath)) return []
  const { resolver, lister } = await getLocalIO()
  const url = tableUrlForDir(tablePath)
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver, lister })
  if (metadata['current-snapshot-id'] === undefined || !metadata.snapshots?.length) return []
  const rows = await icebergRead({ tableUrl: url, metadata, resolver })
  return /** @type {Record<string, unknown>[]} */ (rows)
}

/**
 * Streaming counterpart to `readRowsFromTable`. Yields rows one at a
 * time so callers (in particular `QueryStorageService.readRows`) never
 * materialize the full table in memory.
 *
 * @param {string} tablePath
 * @param {string[]} [columns]
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export async function* scanRowsFromTable(tablePath, columns) {
  if (!tableExists(tablePath)) return
  const { resolver, lister } = await getLocalIO()
  const url = tableUrlForDir(tablePath)
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver, lister })
  if (metadata['current-snapshot-id'] === undefined || !metadata.snapshots?.length) return
  const source = await icebergDataSource({ tableUrl: url, metadata, resolver, lister })
  const projected = columns && columns.length > 0 ? columns : source.columns
  const scan = source.scan({ columns: projected })
  for await (const row of scan.rows()) {
    yield await resolveAsyncRow(row, projected)
  }
}

/**
 * Build a squirreling-compatible `AsyncDataSource` over the latest
 * snapshot of the table. Returns `null` if the table does not exist
 * yet or has no committed snapshot — the query layer treats that as
 * an empty table.
 *
 * @param {string} tablePath
 * @returns {Promise<AsyncDataSource | null>}
 */
export async function dataSourceForTable(tablePath) {
  if (!tableExists(tablePath)) return null
  const { resolver, lister } = await getLocalIO()
  const url = tableUrlForDir(tablePath)
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver, lister })
  if (metadata['current-snapshot-id'] === undefined || !metadata.snapshots?.length) return null
  return icebergDataSource({ tableUrl: url, metadata, resolver, lister })
}

/**
 * @param {AsyncRow} row
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

/**
 * @param {TableMetadata} metadata
 * @returns {Schema | undefined}
 */
export function currentSchema(metadata) {
  const schemaId = metadata['current-schema-id']
  if (metadata.schemas?.length) {
    const match = metadata.schemas.find(s => s['schema-id'] === schemaId)
    if (match) return match
    return metadata.schemas[metadata.schemas.length - 1]
  }
  return undefined
}

/**
 * @param {TableMetadata} metadata
 * @returns {PartitionSpec | undefined}
 */
export function currentPartitionSpec(metadata) {
  const specId = metadata['default-spec-id']
  if (metadata['partition-specs']?.length) {
    const match = metadata['partition-specs'].find(s => s['spec-id'] === specId)
    if (match) return match
    return metadata['partition-specs'][metadata['partition-specs'].length - 1]
  }
  return undefined
}

/**
 * @param {TableMetadata} metadata
 */
function addedFilesSize(metadata) {
  const current = metadata['current-snapshot-id']
  const snapshot = metadata.snapshots?.find((entry) => String(entry['snapshot-id']) === String(current))
  const raw = snapshot?.summary?.['added-files-size']
  const value = raw === undefined ? 0 : Number(raw)
  return Number.isFinite(value) ? value : 0
}
