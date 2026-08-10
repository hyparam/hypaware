// @ts-check

import { parquetMetadata } from 'hyparquet'
import { ParquetWriter } from 'hyparquet-writer'
import { fileCatalog } from 'icebird'
import { loadTable } from 'icebird/src/catalog/loadTable.js'
import { sanitize, uuid4 } from 'icebird/src/utils.js'
import { fileCatalogCommit } from 'icebird/src/write/commit.js'
import { writeDataManifest } from 'icebird/src/write/manifest.js'
import { groupByPartition } from 'icebird/src/write/partition.js'
import { writeParquet } from 'icebird/src/write/parquet.js'
import { compare } from 'icebird/src/write/serde.js'
import { buildPartitionSummaries } from 'icebird/src/write/snapshot.js'
import { buildSortComparator } from 'icebird/src/write/sort.js'
import { checkWriteFormat, newSnapshotId, resolveParquetCodec, stageSnapshotForAppend } from 'icebird/src/write/stage.js'
import { computeColumnStats } from 'icebird/src/write/stats.js'

import { appendRowsToTable, currentPartitionSpec, currentSchema, tableExists } from './store.js'
import { createLocalIcebergIO, tableUrlForDir } from './resolver.js'
import { rowsToIcebergRecords } from './schema.js'

/**
 * @import { ColumnSpec } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AppendOptions, OpenCompactionFile, StreamingTableAppend } from '../../../../src/core/cache/types.js'
 * @import { Field, IcebergType, PartitionSpec, Resolver, Schema } from 'icebird/src/types.js'
 */

/**
 * How many output files a streaming append will keep open at once. Only
 * a table whose partition spec fans a rewrite across many tuples ever
 * reaches this; the cap is what keeps file descriptors and encode
 * buffers bounded when it does.
 */
const MAX_OPEN_FILES = 64

/**
 * Open a streaming append against the Iceberg table at `tableDir`.
 *
 * Each `write(rows)` call encodes its rows as ONE parquet row group and
 * appends it to the currently open data file for that row's partition
 * tuple. A file is closed and a new one started only once the bytes
 * actually written to it reach `targetFileBytes`. All files are committed
 * in a single snapshot by `close()`.
 *
 * This is the seam that decouples the compaction's heap bound from its
 * file bound: the caller still hands over one bounded batch at a time (so
 * peak heap stays one batch plus one row group of encoded bytes), but the
 * batch no longer decides how big a data file gets.
 *
 * @ref LLP 0206#row-groups [implements]: batches become row groups; files
 *   roll on bytes written.
 * @param {object} options
 * @param {string} options.tableDir
 * @param {readonly ColumnSpec[]} options.columns
 * @param {number} options.targetFileBytes
 * @param {AppendOptions} [options.appendOptions]
 * @returns {Promise<StreamingTableAppend>}
 */
export async function openStreamingAppend({ tableDir, columns, targetFileBytes, appendOptions }) {
  // Create the table first so there is metadata (schema, partition spec,
  // sort order, write properties) to write against. An empty append is the
  // existing create-only path.
  if (!tableExists(tableDir)) {
    await appendRowsToTable(tableDir, columns, [], appendOptions)
  }

  const { resolver, lister } = await createLocalIcebergIO()
  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
  const tableUrl = tableUrlForDir(tableDir)
  const ctx = await loadTable({ catalog, tableUrl, resolver })
  const metadata = ctx.metadata
  const loadedSchema = currentSchema(metadata)
  const loadedSpec = currentPartitionSpec(metadata)
  const writerFn = resolver.writer
  if (!loadedSchema || !loadedSpec || !writerFn) {
    return legacyAppend(tableDir, columns, appendOptions)
  }
  /** @type {NonNullable<Resolver["writer"]>} */
  const openWriter = writerFn
  const schema = loadedSchema
  const partitionSpec = loadedSpec
  // Nested columns need icebird's default materialization and dremel
  // shredding, which is not reachable from here. The intrinsic cache only
  // ever declares primitives, so this is a belt-and-braces fallback rather
  // than a live path.
  if (schema.fields.some((field) => typeof field.type === 'object')) {
    return legacyAppend(tableDir, columns, appendOptions)
  }

  checkWriteFormat(metadata.properties?.['write.format.default'])
  const codec = resolveParquetCodec(metadata.properties?.['write.parquet.compression-codec'])
  const orderId = metadata['default-sort-order-id'] ?? 0
  const sortOrder = (metadata['sort-orders'] ?? []).find((o) => o['order-id'] === orderId)
  const comparator = buildSortComparator(sortOrder, schema)
  const appliedSortOrderId = comparator ? orderId : 0
  const parquetSchema = await parquetSchemaForIcebergSchema(schema, codec)
  const columnNames = schema.fields.map((field) => sanitize(field.name))

  /** @type {Map<string, OpenCompactionFile>} */
  const open = new Map()
  /** @type {any[]} */
  const dataFiles = []
  /** @type {string[]} */
  const writtenPaths = []
  let totalRows = 0
  let totalBytes = 0

  /**
   * The open file for a partition tuple, opening one if needed. A table
   * whose spec splits the rewrite across many tuples would otherwise hold
   * one descriptor and one encode buffer per tuple for the whole
   * compaction, so the oldest open file is retired once the cap is
   * reached. Retiring early only produces a smaller file, which is what
   * every file used to be.
   *
   * @param {Record<string, unknown>} partition
   * @returns {Promise<OpenCompactionFile>}
   */
  async function openFileFor(partition) {
    const key = JSON.stringify(partition)
    const found = open.get(key)
    if (found) return found
    while (open.size >= MAX_OPEN_FILES) {
      const oldest = open.values().next().value
      if (!oldest) break
      await closeFile(oldest)
    }
    const dataPath = `${tableUrl}/data/${uuid4()}.parquet`
    const writer = openWriter(dataPath)
    /** @type {OpenCompactionFile} */
    const file = {
      dataPath,
      writer,
      parquet: new ParquetWriter({
        writer,
        schema: parquetSchema,
        codec,
        kvMetadata: [{ key: 'iceberg.schema', value: JSON.stringify(schema) }],
      }),
      partition,
      rowGroups: 0,
      rows: 0n,
      valueCounts: {},
      nullCounts: {},
      nanCounts: {},
      mins: {},
      maxes: {},
    }
    open.set(key, file)
    return file
  }

  /**
   * @param {OpenCompactionFile} file
   * @returns {Promise<void>}
   */
  async function closeFile(file) {
    open.delete(JSON.stringify(file.partition))
    // `ParquetWriter.finish` writes the footer and finishes the underlying
    // writer, which is what lands the file on disk.
    await file.parquet.finish()
    const bytes = BigInt(file.writer.offset)
    totalBytes += file.writer.offset
    writtenPaths.push(file.dataPath)
    dataFiles.push({
      content: 0,
      file_path: file.dataPath,
      file_format: 'parquet',
      partition: file.partition,
      record_count: file.rows,
      file_size_in_bytes: bytes,
      value_counts: file.valueCounts,
      null_value_counts: file.nullCounts,
      nan_value_counts: file.nanCounts,
      ...boundsForFile(file, schema),
      // Only a single-row-group file can honestly claim the table's sort
      // order: a multi-row-group file is a concatenation of sorted runs.
      sort_order_id: file.rowGroups === 1 ? appliedSortOrderId : 0,
    })
  }

  return {
    async write(rows) {
      if (rows.length === 0) return
      const records = rowsToIcebergRecords(columns, rows)
      const groups = partitionSpec.fields.length
        ? groupByPartition(records, schema, partitionSpec)
        : [{ partition: {}, records }]
      for (const group of groups) {
        if (group.records.length === 0) continue
        const sorted = comparator ? [...group.records].sort(comparator) : group.records
        const file = await openFileFor(group.partition)
        accumulateStats(file, sorted, schema)
        await file.parquet.write({
          columnData: columnNames.map((name, index) => ({
            name,
            data: extractColumn(sorted, schema.fields[index]),
          })),
          // One batch is one row group: the caller already sized it to the
          // heap budget, so re-splitting it here would only shrink the
          // stats granularity.
          rowGroupSize: sorted.length,
        })
        file.rowGroups++
        file.rows += BigInt(sorted.length)
        totalRows += sorted.length
        if (file.writer.offset >= targetFileBytes) await closeFile(file)
      }
    },
    async close() {
      for (const file of [...open.values()]) await closeFile(file)
      if (dataFiles.length === 0) {
        return { rowCount: totalRows, dataFiles: 0, bytesWritten: 0 }
      }
      await commitDataFiles({
        catalog, resolver, tableUrl, schema, partitionSpec, dataFiles, writtenPaths, totalRows,
      })
      return { rowCount: totalRows, dataFiles: dataFiles.length, bytesWritten: totalBytes }
    },
  }
}

/**
 * Fallback for tables this module cannot stream into (nested columns, or
 * metadata that would not load). Behaves exactly like the pre-streaming
 * compaction: one committed data file per batch.
 *
 * @param {string} tableDir
 * @param {readonly ColumnSpec[]} columns
 * @param {AppendOptions | undefined} appendOptions
 * @returns {StreamingTableAppend}
 */
function legacyAppend(tableDir, columns, appendOptions) {
  let rowCount = 0
  let files = 0
  let bytesWritten = 0
  return {
    async write(rows) {
      if (rows.length === 0) return
      const result = await appendRowsToTable(tableDir, columns, rows, appendOptions)
      rowCount += rows.length
      files++
      bytesWritten += result.bytesWritten
    },
    async close() {
      return { rowCount, dataFiles: files, bytesWritten }
    },
  }
}

/**
 * Commit every streamed data file as one Iceberg snapshot.
 *
 * Reuses icebird's own `stageSnapshotForAppend` by handing it a
 * `PreparedAppend` assembled from files this module wrote, so the manifest
 * list, snapshot summary, and metadata commit are all icebird's. Only the
 * data manifest is written here, because only this module knows the files.
 *
 * A compaction writes into a generation directory no other writer knows
 * about, so there is no contention to retry against: a failed commit aborts
 * the rewrite and the orphan sweep reclaims the directory.
 *
 * @param {object} options
 * @param {any} options.catalog
 * @param {any} options.resolver
 * @param {string} options.tableUrl
 * @param {Schema} options.schema
 * @param {PartitionSpec} options.partitionSpec
 * @param {any[]} options.dataFiles
 * @param {string[]} options.writtenPaths
 * @param {number} options.totalRows
 * @returns {Promise<void>}
 */
async function commitDataFiles({
  catalog, resolver, tableUrl, schema, partitionSpec, dataFiles, writtenPaths, totalRows,
}) {
  const ctx = await loadTable({ catalog, tableUrl, resolver })
  const metadata = ctx.metadata
  const formatVersion = /** @type {2 | 3} */ (metadata['format-version'])
  const snapshotId = newSnapshotId(metadata)
  const manifestUuid = uuid4()
  const manifestPath = `${tableUrl}/metadata/${manifestUuid}-m0.avro`
  const manifestWriter = resolver.writer(manifestPath)
  await writeDataManifest({
    writer: manifestWriter,
    schema,
    partitionSpec,
    snapshotId,
    dataFiles,
    formatVersion,
  })

  const staged = await stageSnapshotForAppend({
    tableUrl,
    metadata,
    resolver,
    prepared: {
      snapshotId,
      manifestUuid,
      formatVersion,
      manifestPath,
      manifestLength: BigInt(manifestWriter.offset),
      partitionSpecId: partitionSpec['spec-id'],
      partitions: buildPartitionSummaries(dataFiles.map((f) => f.partition), schema, partitionSpec),
      addedDataFilesCount: dataFiles.length,
      addedRowCount: dataFiles.reduce((sum, f) => sum + f.record_count, 0n),
      addedFilesSize: dataFiles.reduce((sum, f) => sum + f.file_size_in_bytes, 0n),
      recordsCount: totalRows,
      writtenFiles: [...writtenPaths, manifestPath],
    },
  })

  if (!ctx.resolver) throw new Error('cache-iceberg: resolver is required to commit a streamed append')
  await fileCatalogCommit({
    tableUrl: ctx.tableUrl,
    metadata: ctx.metadata,
    metadataFileName: ctx.metadataFileName,
    currentVersion: ctx.version,
    staged,
    resolver: ctx.resolver,
    conditionalCommits: catalog.type === 'file' && catalog.conditionalCommits,
  })
}

/**
 * Recover the parquet `SchemaElement[]` icebird would write for an Iceberg
 * schema, by writing a zero-record parquet file in memory and reading its
 * footer back.
 *
 * The iceberg-type to parquet-field mapping (field ids, logical types,
 * decimal widths) is private to icebird, and a hand-rolled copy would drift
 * silently the first time icebird changed it. Round-tripping through
 * icebird's own writer costs one tiny in-memory encode per compaction and
 * is exact by construction.
 *
 * @ref LLP 0206#schema-probe: derive the parquet schema from icebird rather
 *   than copying its mapping.
 * @param {Schema} schema
 * @param {any} codec
 * @returns {Promise<any[]>}
 */
async function parquetSchemaForIcebergSchema(schema, codec) {
  const { ByteWriter } = await import('hyparquet-writer')
  const probe = new ByteWriter()
  await writeParquet({ writer: probe, schema, records: [], codec })
  return parquetMetadata(probe.getBuffer()).schema
}

/**
 * Materialize one column's values for a row group. Primitive-only: nested
 * types are rejected before a streaming writer is opened.
 *
 * @param {Record<string, any>[]} records
 * @param {Field} field
 * @returns {unknown[]}
 */
function extractColumn(records, field) {
  const writeDefault = field['write-default']
  const out = new Array(records.length)
  for (let i = 0; i < records.length; i++) {
    const value = records[i][field.name]
    out[i] = value !== undefined ? value : writeDefault !== undefined ? writeDefault : null
  }
  return out
}

/**
 * Fold one row group's values into the file's running Iceberg metrics.
 *
 * Counts accumulate directly; bounds accumulate as the raw minimum and
 * maximum values seen so far, compared with icebird's own type-aware
 * comparator. Serialization (and the spec's 16-unit bound truncation) is
 * left to `computeColumnStats` at file close, so the encoding stays
 * icebird's.
 *
 * @param {OpenCompactionFile} file
 * @param {Record<string, any>[]} records
 * @param {Schema} schema
 * @returns {void}
 */
function accumulateStats(file, records, schema) {
  for (const field of schema.fields) {
    const type = field.type
    if (typeof type === 'object') continue
    const isFloat = type === 'float' || type === 'double'
    const bounded = tracksBounds(type)
    const writeDefault = field['write-default']
    let nulls = 0n
    let nans = 0n
    let min = file.mins[field.id]
    let max = file.maxes[field.id]
    for (const record of records) {
      let value = record[field.name]
      if (value === undefined && writeDefault !== undefined) value = writeDefault
      if (value === null || value === undefined) {
        nulls++
        continue
      }
      if (isFloat && Number.isNaN(value)) {
        nans++
        continue
      }
      if (!bounded) continue
      if (min === undefined || compare(value, min, type) < 0) min = value
      if (max === undefined || compare(value, max, type) > 0) max = value
    }
    file.valueCounts[field.id] = (file.valueCounts[field.id] ?? 0n) + BigInt(records.length)
    file.nullCounts[field.id] = (file.nullCounts[field.id] ?? 0n) + nulls
    if (isFloat) file.nanCounts[field.id] = (file.nanCounts[field.id] ?? 0n) + nans
    if (min !== undefined) file.mins[field.id] = min
    if (max !== undefined) file.maxes[field.id] = max
  }
}

/**
 * Serialize a file's accumulated raw bounds into the Iceberg
 * `lower_bounds`/`upper_bounds` maps. Feeding the min and max back through
 * `computeColumnStats` as a two-row batch reuses icebird's truncation and
 * single-value serialization rather than re-deriving them.
 *
 * @param {OpenCompactionFile} file
 * @param {Schema} schema
 * @returns {{ lower_bounds: Record<number, Uint8Array>, upper_bounds: Record<number, Uint8Array> }}
 */
function boundsForFile(file, schema) {
  /** @type {Record<string, any>} */
  const minRecord = {}
  /** @type {Record<string, any>} */
  const maxRecord = {}
  for (const field of schema.fields) {
    minRecord[field.name] = file.mins[field.id] ?? null
    maxRecord[field.name] = file.maxes[field.id] ?? null
  }
  const stats = computeColumnStats([minRecord, maxRecord], schema)
  return { lower_bounds: stats.lower_bounds, upper_bounds: stats.upper_bounds }
}

/**
 * Whether icebird can produce comparable Iceberg bounds for a primitive
 * type. Mirrors icebird's own `hasComparableBounds`, which is private;
 * getting it wrong only costs pruning, never correctness, because a field
 * with no bound is simply never pruned.
 *
 * @param {IcebergType} type
 * @returns {boolean}
 */
function tracksBounds(type) {
  if (typeof type === 'object') return false
  if (type === 'unknown' || type === 'variant') return false
  return !type.startsWith('geometry') && !type.startsWith('geography')
}
