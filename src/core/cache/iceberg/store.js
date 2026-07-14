// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { parquetReadObjects } from 'hyparquet'
import {
  fileCatalog,
  icebergAppend,
  icebergCreateTable,
  icebergDataSource,
  icebergDelete,
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
// Deep imports for the position-delete purge path, matching retention.js's
// reuse of the same icebird write internals (LLP 0104 rewrite mechanics).
import { deleteFileAppliesToDataEntry } from 'icebird/src/delete.js'
import { fetchAvroRecords, fetchDeleteMaps } from 'icebird/src/fetch.js'
import { findDataFileEntries, loadManifestEntries } from 'icebird/src/write/stage-position-delete.js'

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
import { INGEST_SEQ_COLUMN } from '../streaming-reader.js'

/**
 * @import { ColumnSpec } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AppendOptions, CachePartitioningDeclaration } from '../../../../src/core/cache/types.js'
 * @import { Catalog, Lister, Manifest, ManifestEntry, PartitionSpec, Resolver, Schema, TableMetadata } from 'icebird/src/types.js'
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
    // @ref LLP 0029#in-place-evolution [implements]: the single switch point.
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
 * @ref LLP 0029#reachable-path [implements]: fileCatalogCommit is the reachable
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

const PURGE_DELETE_BATCH_SIZE = 5000

/**
 * Delete every live row in the Iceberg table for which `predicate(row)` is
 * true, by committing Iceberg position-delete files — the same mechanism the
 * retention enforcer uses (LLP 0013), reused here for the `hyp purge`
 * destructive verb (LLP 0104).
 *
 * Position-delete, not a rewrite of surviving rows: this is deliberate and is
 * the resolution of LLP 0104's deferred rewrite mechanics.
 *
 *  - **`part_id` identity is preserved.** Surviving rows are never rewritten,
 *    so their `part_id` — the deterministic `<message_id>#<part_index>`
 *    forward-dedupe key — is unchanged. A later re-record of a purged
 *    directory therefore mints identical `part_id`s that the forward sink's
 *    chunk-level dedupe absorbs, so purge-then-re-record never produces
 *    server-side duplicate identities (LLP 0104 consequences).
 *  - **Watermark integrity.** Deletes never touch the `_hyp_ingest_seq` of
 *    surviving rows, so no sink's high-water mark moves and no incremental
 *    read is wedged. Purged rows are dropped by every subsequent read
 *    (`icebergDataSource` applies position-deletes), so a purged row above a
 *    sink's watermark is simply never exported, and one below it — already
 *    exported — just vanishes locally. The deletes are durable in table
 *    metadata, so a re-scan re-applies them: no resurrection via a stale
 *    watermark.
 *
 * Rows already covered by a committed position-delete are skipped, so this is
 * idempotent and composes with retention's deletes over the same table.
 *
 * @ref LLP 0104 [implements]: cache-only row deletion via position-deletes; preserves part_id identity and the export watermark
 * @param {string} tablePath the Iceberg table directory
 * @param {(row: Record<string, unknown>) => boolean} predicate
 * @param {{ columns: string[] }} opts columns the predicate reads (intersected with the table schema)
 * @returns {Promise<{ rowsDeleted: number, filesAffected: number, batchCount: number }>}
 */
export async function deleteMatchingRows(tablePath, predicate, opts) {
  if (!tableExists(tablePath)) return { rowsDeleted: 0, filesAffected: 0, batchCount: 0 }
  const { resolver, lister } = await getLocalIO()
  const url = tableUrlForDir(tablePath)

  /** @type {TableMetadata} */
  let metadata
  try {
    const loaded = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver, lister })
    metadata = loaded.metadata
  } catch {
    return { rowsDeleted: 0, filesAffected: 0, batchCount: 0 }
  }
  if (metadata['current-snapshot-id'] === undefined || !metadata.snapshots?.length) {
    return { rowsDeleted: 0, filesAffected: 0, batchCount: 0 }
  }

  const dataFileMap = await findDataFileEntries(metadata, resolver)
  if (dataFileMap.size === 0) return { rowsDeleted: 0, filesAffected: 0, batchCount: 0 }

  // Only project columns that exist in the current schema; a predicate column
  // absent from an older partition reads as `undefined`, which the caller's
  // predicate must tolerate (the additive-schema contract, LLP 0032).
  const schema = currentSchema(metadata)
  const schemaColumns = new Set(schema?.fields.map((f) => f.name) ?? [])
  const projected = opts.columns.filter((c) => schemaColumns.has(c))

  const alreadyDeleted = await loadDeletedPositions(metadata, resolver, dataFileMap)
  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })

  /** @type {{ file_path: string, pos: number }[]} */
  let pending = []
  let rowsDeleted = 0
  let filesAffected = 0
  let batchCount = 0

  for (const [filePath] of dataFileMap) {
    const positions = await scanFileForMatchingRows(
      filePath, resolver, predicate, projected, alreadyDeleted.get(filePath)
    )
    if (positions.length === 0) continue
    filesAffected++
    pending.push(...positions.map((pos) => ({ file_path: filePath, pos })))
    while (pending.length >= PURGE_DELETE_BATCH_SIZE) {
      const batch = pending.splice(0, PURGE_DELETE_BATCH_SIZE)
      await icebergDelete({ catalog, tableUrl: url, deletes: batch })
      rowsDeleted += batch.length
      batchCount++
    }
  }
  if (pending.length > 0) {
    await icebergDelete({ catalog, tableUrl: url, deletes: pending })
    rowsDeleted += pending.length
    batchCount++
  }

  return { rowsDeleted, filesAffected, batchCount }
}

/**
 * Scan one Iceberg data file and return the row positions of live rows that
 * satisfy `predicate`. Rows already covered by a committed position-delete are
 * skipped so re-purges never re-plan the same delete.
 *
 * @param {string} filePath
 * @param {Resolver} resolver
 * @param {(row: Record<string, unknown>) => boolean} predicate
 * @param {string[]} columns projected columns the predicate needs
 * @param {Set<bigint>} [deletedPositions]
 * @returns {Promise<number[]>}
 */
async function scanFileForMatchingRows(filePath, resolver, predicate, columns, deletedPositions) {
  /** @type {number[]} */
  const positions = []
  try {
    const file = await Promise.resolve(resolver.reader(filePath))
    const readOpts = columns.length > 0 ? { file, columns } : { file }
    const rows = /** @type {Record<string, unknown>[]} */ (await parquetReadObjects(readOpts))
    for (let i = 0; i < rows.length; i++) {
      if (deletedPositions?.has(BigInt(i))) continue
      if (predicate(rows[i])) positions.push(i)
    }
  } catch {
    // Unreadable file: skip rather than block the whole purge. The rows stay
    // cached; a subsequent purge over a healthy file still removes them.
  }
  return positions
}

/**
 * Load the set of already-committed position-delete row positions per data
 * file, so a purge never re-plans a delete another purge or the retention
 * enforcer already committed. Mirrors retention.js's private helper of the
 * same name (LLP 0013); kept local to the iceberg store so the delete path is
 * self-contained rather than reaching up into the retention module.
 *
 * @param {TableMetadata} metadata
 * @param {Resolver} resolver
 * @param {Map<string, { entry: ManifestEntry }>} dataFileMap
 * @returns {Promise<Map<string, Set<bigint>>>}
 */
async function loadDeletedPositions(metadata, resolver, dataFileMap) {
  const snapshotId = metadata['current-snapshot-id']
  const snapshot = metadata.snapshots?.find((s) => String(s['snapshot-id']) === String(snapshotId))
  if (!snapshot?.['manifest-list']) return new Map()
  const manifests = /** @type {Manifest[]} */ (await fetchAvroRecords(snapshot['manifest-list'], resolver))
  /** @type {ManifestEntry[]} */
  const deleteEntries = []
  await Promise.all(manifests.map(async (manifest) => {
    if (manifest.content !== 1) return
    const entries = await loadManifestEntries(manifest, resolver)
    for (const entry of entries) {
      if (entry.status === 2) continue
      if (entry.data_file.content !== 1) continue
      deleteEntries.push(entry)
    }
  }))
  if (deleteEntries.length === 0) return new Map()
  const { positionDeletesMap } = await fetchDeleteMaps(deleteEntries, resolver)
  /** @type {Map<string, Set<bigint>>} */
  const out = new Map()
  for (const [filePath, groups] of positionDeletesMap) {
    const found = dataFileMap.get(filePath)
    if (!found) continue
    /** @type {Set<bigint>} */
    const set = new Set()
    for (const group of groups) {
      if (!deleteFileAppliesToDataEntry(found.entry, group.deleteEntry, metadata, 'position')) continue
      for (const pos of group.positions) set.add(pos)
    }
    if (set.size > 0) out.set(filePath, set)
  }
  return out
}

/**
 * Streaming counterpart to `readRowsFromTable`. Yields rows one at a
 * time so callers (in particular `QueryStorageService.readRows`) never
 * materialize the full table in memory.
 *
 * When `opts.since` is set (a bigint `_hyp_ingest_seq` watermark) only rows
 * NEWER than the watermark are yielded. A row whose `_hyp_ingest_seq` is
 * `null`/absent is a pre-column "legacy" row; its disposition is governed by
 * `opts.includeLegacy`:
 *
 * - `includeLegacy` true (default) — legacy rows are treated as NEW (yielded).
 *   This is the safe migration default: a fresh sink with no durable watermark
 *   exports the pre-upgrade backlog once rather than silently skipping it
 *   (LLP 0040 risk #1, the data-loss hazard).
 * - `includeLegacy` false — legacy rows are treated as ALREADY EXPORTED
 *   (skipped). A sink passes this once it HAS a durable watermark, so the
 *   pre-upgrade backlog is re-exported exactly once, never on every subsequent
 *   tick (LLP 0040 §6 risk #1). No new null-seq row can appear post-upgrade —
 *   the `decorateRow` chokepoint stamps a real seq on every flushed row — so
 *   excluding legacy rows after the first export is safe.
 *
 * A real seq is yielded iff strictly `> since`. The seq column is force-projected
 * so the predicate can be evaluated even when the caller asked for a narrower
 * set; `QueryStorageService` strips it from the row afterwards.
 *
 * The predicate is applied as a yielded-row filter rather than pushed into
 * icebird's `scan({ where })`. icebird couples file/row-group pruning with a
 * per-row match that DROPS nulls (`null > since` is false in both hyparquet's
 * matcher and JS), which would skip exactly the legacy null-seq rows the
 * migration must preserve. The design (LLP 0040 §2) names this yielded-row
 * filter as the fallback; a future null-aware icebird filter can layer the
 * file-skip optimization on top without changing this contract.
 *
 * @ref LLP 0040#storage-api-extension [implements] — since-filtered incremental scan; null-seq new on first export, then excluded
 * @param {string} tablePath
 * @param {string[]} [columns]
 * @param {{ since?: bigint, includeLegacy?: boolean }} [opts]
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export async function* scanRowsFromTable(tablePath, columns, opts) {
  if (!tableExists(tablePath)) return
  const since = opts?.since
  const filtering = since !== undefined
  const includeLegacy = opts?.includeLegacy !== false
  const { resolver, lister } = await getLocalIO()
  const url = tableUrlForDir(tablePath)
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver, lister })
  if (metadata['current-snapshot-id'] === undefined || !metadata.snapshots?.length) return
  const source = await icebergDataSource({ tableUrl: url, metadata, resolver, lister })
  // A table that has never been flushed under the seq-column schema carries no
  // seq field: every row is implicitly null-seq, so the seq is read as `null`
  // and the `includeLegacy` policy decides it.
  const hasSeqColumn = source.columns.includes(INGEST_SEQ_COLUMN.name)
  let projected = columns && columns.length > 0 ? columns : source.columns
  if (filtering && hasSeqColumn && !projected.includes(INGEST_SEQ_COLUMN.name)) {
    projected = [...projected, INGEST_SEQ_COLUMN.name]
  }
  const scan = source.scan({ columns: projected })
  for await (const row of scan.rows()) {
    const resolved = await resolveAsyncRow(row, projected)
    if (filtering) {
      const seq = hasSeqColumn ? seqValue(resolved[INGEST_SEQ_COLUMN.name]) : null
      if (seq === null) {
        // Legacy (pre-upgrade) row: new on a fresh sink, already-exported once a
        // durable watermark exists.
        if (!includeLegacy) continue
      } else if (seq <= /** @type {bigint} */ (since)) {
        continue
      }
    }
    yield resolved
  }
}

/**
 * Decode a raw `_hyp_ingest_seq` cell to a bigint, or `null` when the row has
 * no usable seq — a pre-column legacy row (null/absent), or an unparseable
 * value. Returning `null` for an unparseable value is the safe direction: the
 * caller treats `null` as a NEW row and never skips it (LLP 0040 risk #1).
 *
 * @param {unknown} raw
 * @returns {bigint | null}
 */
export function seqValue(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'bigint') return raw
  if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw)
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return BigInt(raw)
  return null
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
