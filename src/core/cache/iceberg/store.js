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
// Deep imports for in-place schema evolution. icebird's public top-level API
// (`icebergTransaction`'s `tx`) exposes append/delete/setRef/expireSnapshots
// but no schema-update primitive (icebird#25). These two helpers ARE public:
// the package `exports` map publishes `"./src/*.js"`, and the cache already
// deep-imports icebird write internals this way (e.g. retention.js reaches
// `icebird/src/write/stage-position-delete.js` and `icebird/src/delete.js`).
import { loadTable } from 'icebird/src/catalog/loadTable.js'
import { fileCatalogCommit } from 'icebird/src/write/commit.js'

import { createLocalIcebergIO, tableUrlForDir } from './resolver.js'
import {
  icebergSchemaForColumns,
  mergeFieldIdsFromTable,
  rowsToIcebergRecords,
} from './schema.js'
import {
  partitionSpecForDeclaration,
  validatePartitionSpecStability,
} from '../../iceberg/partition-spec.js'

/**
 * @import { ColumnSpec } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { AppendOptions, CachePartitioningDeclaration } from '../../../../src/core/cache/types.js'
 * @import { Catalog, Lister, PartitionSpec, Resolver, Schema, TableMetadata } from 'icebird/src/types.js'
 * @import { AsyncDataSource, AsyncRow } from 'squirreling'
 */

/**
 * Reusable cache for the local IO pair. Constructed once per process,
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
 * matched by a fresh resolver - keeps smoke-flow isolation honest.
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

  // Coerce/validate rows up front, before any metadata commit (table create
  // or schema evolution). A row-level rejection (null in a required column, a
  // bad numeric coercion) must abort BEFORE we durably advance the table's
  // schema: otherwise evolveSchemaInPlace lands the new column and the append
  // then throws, leaving the table's schema ahead of its data.
  const records = rows.length > 0 ? rowsToIcebergRecords(columns, rows) : []

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
      sortOrder: options?.sortOrder ? sortOrderForColumns(options.sortOrder, schema) : undefined,
    })
  } else if (declaration) {
    const { metadata: existing } = await loadLatestFileCatalogMetadata({
      tableUrl: url, resolver, lister,
    })
    const existingSchema = currentSchema(existing)
    let effectiveSchema = schema
    if (existingSchema) {
      const partitionColumns = new Set(declaration.iceberg.fields.map(f => f.column))
      // mergeFieldIdsFromTable reconciles the declared columns with the table's
      // current schema: it keeps existing field ids, rejects breaking changes
      // (type changes, dropped/partition columns, new required columns,
      // nullable→required tightening), and assigns fresh ids to new *nullable*
      // columns. Only additive (new-nullable) deltas survive to here.
      effectiveSchema = mergeFieldIdsFromTable(columns, existingSchema, partitionColumns)
    }
    const existingSpec = currentPartitionSpec(existing)
    if (existingSpec) {
      validatePartitionSpecStability(declaration, existingSpec, effectiveSchema)
    }
    // @ref LLP 0029#in-place-evolution [implements] - the single switch point.
    // effectiveSchema is the merged write schema; if it adds nullable columns
    // or widens an existing column required->nullable that the table's current
    // schema doesn't reflect yet, evolve the table in place (add-schema +
    // set-current-schema) so the append below lands under the new schema and
    // the columns become queryable: no recreate, old rows read null.
    if (existingSchema) {
      await evolveSchemaInPlace({
        catalog, tableUrl: url, resolver, lister, existingSchema, effectiveSchema,
      })
    }
  }
  /** @type {TableMetadata | null} */
  let metadata = null
  if (records.length > 0) {
    metadata = await icebergAppend({
      catalog,
      tableUrl: url,
      records,
    })
  }
  const bytesWritten = metadata ? addedFilesSize(metadata) : 0
  return { tableUrl: url, appended: rows.length > 0, bytesWritten }
}

/**
 * Evolve a table's current schema in place to `effectiveSchema` when it adds
 * nullable columns the table doesn't have yet. Additive-only: by the time we
 * reach here, `mergeFieldIdsFromTable` has already rejected every breaking
 * change, so any delta between `existingSchema` and `effectiveSchema` is one or
 * more new nullable fields (or a widened required->nullable). No-op when the two
 * schemas carry the same field ids: the common case, so a steady-state append
 * pays only a cheap id-set comparison, no extra commit.
 *
 * Mechanism: stage `add-schema` (with the merged schema) + `set-current-schema`
 * and commit them through `fileCatalogCommit` as their own metadata-only
 * commit. The subsequent `icebergAppend` reloads metadata, sees the new
 * current schema, and writes the new columns; pre-existing data files simply
 * lack the new field ids and icebird reads them back as `null`. This is the
 * single place the merged schema actually reaches storage: historically it
 * was computed and discarded, so the new column never appeared without a full
 * cache recreate (issue #102).
 *
 * The `add-schema` is assigned a fresh schema-id via the spec sentinel `-1`;
 * `set-current-schema: -1` then points the table at the just-added schema.
 * `fileCatalogCommit` applies these via `applyUpdates`, which enforces
 * icebird's own evolution rules (stable field ids, type promotion only, no new
 * required fields without defaults) as a second guard behind
 * `mergeFieldIdsFromTable`.
 *
 * @ref LLP 0029#reachable-path [implements] - fileCatalogCommit is the reachable
 *   icebird primitive; icebergTransaction's tx has no schema method (icebird#25).
 * @param {object} options
 * @param {Catalog} options.catalog
 * @param {string} options.tableUrl
 * @param {Resolver} options.resolver
 * @param {Lister} options.lister
 * @param {Schema} options.existingSchema
 * @param {Schema} options.effectiveSchema
 * @returns {Promise<void>}
 */
async function evolveSchemaInPlace({ catalog, tableUrl, resolver, lister, existingSchema, effectiveSchema }) {
  if (!schemaNeedsEvolution(existingSchema, effectiveSchema)) return
  const ctx = await loadTable({ catalog, tableUrl, resolver })
  if (!ctx.resolver) throw new Error('cache-iceberg: resolver is required to evolve schema')
  await fileCatalogCommit({
    tableUrl: ctx.tableUrl,
    metadata: ctx.metadata,
    metadataFileName: ctx.metadataFileName,
    currentVersion: ctx.version,
    resolver: ctx.resolver,
    conditionalCommits: catalog.type === 'file' && catalog.conditionalCommits,
    staged: {
      // fileCatalogCommit applies updates and never reads `snapshot`; this is a
      // metadata-only commit (no data files, no new snapshot).
      snapshot: /** @type {any} */ (undefined),
      requirements: [],
      updates: [
        { action: 'add-schema', schema: { ...effectiveSchema, 'schema-id': -1 } },
        { action: 'set-current-schema', 'schema-id': -1 },
      ],
      writtenFiles: [],
    },
  })
}

/**
 * True when `next` differs from `prior` in a way that needs a
 * set-current-schema commit. `mergeFieldIdsFromTable` produces exactly two
 * kinds of additive delta, and both must trigger evolution:
 *
 *  - a new field id `prior` lacks (a new nullable column), and
 *  - a shared field id whose `required` flag WIDENED (required -> nullable):
 *    the merge keeps the same id when only nullability flips, so an id-set
 *    check alone misses it: the table would stay marked `required` and a
 *    later append writing `null` would be rejected (issue #102 / LLP 0029
 *    lists widening as additive).
 *
 * Every other delta is rejected before this point, so any shared-id `required`
 * difference here is a widening.
 *
 * @param {Schema} prior
 * @param {Schema} next
 * @returns {boolean}
 */
function schemaNeedsEvolution(prior, next) {
  const priorById = new Map(prior.fields.map(f => [f.id, f]))
  for (const f of next.fields) {
    const before = priorById.get(f.id)
    if (!before) return true
    if (before.required !== f.required) return true
  }
  return false
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
 * yet or has no committed snapshot: the query layer treats that as
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
 * Recover the column-name sort declaration from a table's default sort
 * order, so a rewrite into a fresh table directory (the cache's
 * compaction generation swap) can re-declare it. Returns `undefined`
 * when the table has no default sort order or uses non-identity
 * transforms the declaration can't express.
 *
 * @param {TableMetadata} metadata
 * @returns {{ column: string, direction: 'asc' | 'desc' }[] | undefined}
 */
export function sortColumnsFromMetadata(metadata) {
  const orderId = metadata['default-sort-order-id']
  const order = metadata['sort-orders']?.find((o) => o['order-id'] === orderId)
  if (!order || order.fields.length === 0) return undefined
  const schema = currentSchema(metadata)
  if (!schema) return undefined
  /** @type {{ column: string, direction: 'asc' | 'desc' }[]} */
  const columns = []
  for (const field of order.fields) {
    if (field.transform !== 'identity') return undefined
    const source = schema.fields.find((f) => f.id === field['source-id'])
    if (!source) return undefined
    columns.push({ column: source.name, direction: field.direction })
  }
  return columns
}

/**
 * Translate a column-name sort declaration into the Iceberg `SortOrder`
 * passed to `icebergCreateTable`. Sorting is by identity transform;
 * null ordering follows the Iceberg defaults (nulls-first for asc,
 * nulls-last for desc).
 *
 * (icebird does not export its `SortOrder` interface, so the type is
 * reached through `TableMetadata['sort-orders']`.)
 *
 * @param {readonly { column: string, direction?: 'asc' | 'desc' }[]} spec
 * @param {Schema} schema
 * @returns {TableMetadata['sort-orders'][number]}
 */
function sortOrderForColumns(spec, schema) {
  /** @type {TableMetadata['sort-orders'][number]['fields']} */
  const fields = []
  for (const { column, direction = 'asc' } of spec) {
    const field = schema.fields.find((f) => f.name === column)
    if (!field) throw new Error(`cache: sortOrder column '${column}' is not in the table schema`)
    fields.push({
      transform: 'identity',
      'source-id': field.id,
      direction,
      'null-order': direction === 'asc' ? 'nulls-first' : 'nulls-last',
    })
  }
  return { 'order-id': 1, fields }
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
