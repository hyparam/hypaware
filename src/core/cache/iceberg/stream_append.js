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

import { Attr, getLogger } from '../../observability/index.js'
import { appendRowsToTable, currentPartitionSpec, currentSchema, tableExists } from './store.js'
import { createLocalIcebergIO, tableUrlForDir } from './resolver.js'
import { rowsToIcebergRecords } from './schema.js'

/**
 * @import { ColumnSpec } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AbortableWriter, AppendOptions, OpenCompactionFile, StreamingTableAppend } from '../../../../src/core/cache/types.js'
 * @import { Field, IcebergType, PartitionSpec, Resolver, Schema } from 'icebird/src/types.js'
 * @import { SchemaElement } from 'hyparquet'
 */

/**
 * How many output files hold a file DESCRIPTOR at once. Not how many are
 * open: a file past this is parked (flushed, its descriptor released and
 * its encode buffer dropped) and reopened in append mode the next time a
 * row group for its partition tuple arrives.
 *
 * The distinction is the whole point. Retiring the oldest file instead,
 * as this cap used to, is Belady-cyclic against the access pattern a
 * compaction actually has: the scan walks the old generation's data
 * files in manifest order, each old file holds exactly one tuple, and a
 * tuple recurs about every N files for N distinct tuples. Once
 * N exceeded the cap, every file was retired before its tuple came round
 * again, so every output file closed holding exactly one row group and
 * the rewrite emitted one file per input row group: the same count the
 * pre-streaming code produced. Measured through `maintainCache` with
 * identity partitioning on one column, 3000 fat rows in 10 ingest waves:
 * 30 tuples compacted 300 files to 30 and 64 compacted 640 to 64, but
 * 100 compacted 1000 to 1000. Parking removes the cliff rather than
 * moving it, because a parked file is still the file that tuple's next
 * row group appends to.
 *
 * 64 is left where it was because it is now bounding the thing it is
 * good at bounding, and because raising it is no longer a way to buy
 * anything: a rewrite's file count no longer depends on it. The daemon
 * shares one descriptor limit across its listeners, spool writers and
 * readers, and 64 stays well inside the soft limits it runs under
 * (commonly 1024 on Linux, 256 under macOS launchd).
 *
 * @ref LLP 0206#descriptor-parking [implements]: cap descriptors, not
 *   open files.
 */
const MAX_OPEN_DESCRIPTORS = 64

/**
 * Budget, across every file open at once, for the row-group metadata
 * `ParquetWriter` retains until the footer is written.
 *
 * `ParquetWriter.write` pushes a `ColumnChunk` per column per row group
 * onto `this.row_groups`, and each chunk's `statistics` holds the RAW,
 * untruncated JS `min_value`/`max_value` for that chunk. Truncation to 16
 * units happens at serialization, in `finish()`. So an open file pins two
 * full column values per row group per column for its whole life: a term
 * proportional to `rowGroupsPerFile x maxValueBytes`, which `flush()`
 * does nothing about because it only drains encoded page bytes.
 *
 * Measured against this module: 100 row groups of one string column
 * retained 4.4 MB at 20 KB values, 27.7 MB at 140 KB, and 109.0 MB at
 * 560 KB (0.5 MB flat when every row shared one string, isolating the
 * growth to the retained bounds). At issue #697's shape, reaching a
 * 128 MB file would have pinned ~40 MB, more than `compact_batch_bytes`.
 *
 * The budget is global rather than per-file on purpose. A per-file cap
 * has to be divided by the number of files that may be open to bound the
 * aggregate, which would force files down to a few megabytes for fat
 * rows: the exact defect LLP 0206 set out to fix. A global budget spends
 * itself on whichever files are actually open, so a single-tuple rewrite
 * reaches `target_file_bytes` and a wide fan-out rolls earlier instead.
 * 32 MiB matches the default `compact_batch_bytes`, so the streaming
 * append's retained metadata costs at most about what the batch feeding
 * it does.
 *
 * This is also the only bound on how many output files a rewrite holds
 * open at once, now that a descriptor is no longer one of the things an
 * open file costs. Every row group charges at least
 * `ROW_GROUP_STATS_OVERHEAD_BYTES` per column, so a fan-out wide enough
 * to matter is closed out by the budget long before the open files
 * themselves become a heap term.
 *
 * @ref LLP 0206#retained-metadata [implements]: bound the row-group
 *   metadata an open file pins.
 */
const MAX_OPEN_STATS_BYTES = 32 * 1024 * 1024

/**
 * Flat cost charged per column chunk toward `MAX_OPEN_STATS_BYTES`, on
 * top of the retained bound values. Covers the `ColumnChunk` object
 * itself, its offset index and its encoding stats: measured at ~1 KB per
 * column per row group. Without this term a table of narrow values could
 * accumulate unboundedly many row groups inside the budget.
 */
const ROW_GROUP_STATS_OVERHEAD_BYTES = 1024

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
 * file bound: the caller still hands over one bounded batch at a time, but
 * the batch no longer decides how big a data file gets. Peak heap is the
 * batch, plus one row group of encoded bytes, plus the row-group metadata
 * every open file pins until its footer is written - and that third term
 * is what `MAX_OPEN_STATS_BYTES` bounds.
 *
 * @ref LLP 0206#row-groups [implements]: batches become row groups; files
 *   roll on bytes written.
 * @ref LLP 0206#retained-metadata [implements]: and on retained row-group
 *   metadata, so the file bound cannot reintroduce an unbounded heap term.
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
  // Nested (list/map/struct) columns need icebird's default materialization
  // and dremel shredding, which is not reachable from here. Declared `JSON`
  // columns are NOT in that set even though they are not scalar in parquet:
  // they map to iceberg `variant`, whose parquet form is a two-leaf group
  // that `hyparquet-writer` encodes itself from the raw JS value, and
  // `ai_gateway_messages` declares seven of them. So this guard is narrower
  // than "primitives only" - it is "no type whose values this module would
  // have to shred by hand".
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
  // `columnData` is positional against `columnNames`, which assumes icebird
  // maps every schema field to exactly one top-level parquet element. It
  // does not for `unknown`, which it drops entirely - and a dropped column
  // would shift every later column's data by one. Not reachable from the
  // cache's declared types today; the probe already tells us, so check it.
  if (!alignsWithParquetSchema(parquetSchema, columnNames)) {
    return legacyAppend(tableDir, columns, appendOptions)
  }

  const logger = getLogger('cache')
  /** @type {Record<string, string|number|boolean>} */
  const baseAttrs = {
    [Attr.COMPONENT]: 'cache',
    [Attr.OPERATION]: 'cache.compaction_stream',
  }

  /** @type {Map<string, OpenCompactionFile>} */
  const open = new Map()
  // The subset of `open` currently holding a file descriptor, in
  // least-recently-written order.
  /** @type {Map<string, OpenCompactionFile>} */
  const withDescriptor = new Map()
  /** @type {any[]} */
  const dataFiles = []
  /** @type {string[]} */
  const writtenPaths = []
  let totalRows = 0
  let totalBytes = 0
  // Row-group metadata pinned by every file currently open, in the same
  // units `MAX_OPEN_STATS_BYTES` is expressed in.
  let openStatsBytes = 0
  let statsRolls = 0
  let parks = 0
  let openFileRetires = 0

  /**
   * The open file for a partition tuple, opening one if needed. A file
   * stays open for the whole append unless its bytes or the stats budget
   * close it: the descriptor cap is enforced by {@link reserveDescriptor}
   * instead, which is what keeps a wide fan-out from costing one
   * descriptor per tuple.
   *
   * @param {string} key
   * @param {Record<string, unknown>} partition
   * @returns {OpenCompactionFile}
   */
  function openFileFor(key, partition) {
    const dataPath = `${tableUrl}/data/${uuid4()}.parquet`
    const writer = /** @type {AbortableWriter} */ (openWriter(dataPath))
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
      statsBytes: 0,
      valueCounts: {},
      nullCounts: {},
      nanCounts: {},
      mins: {},
      maxes: {},
    }
    open.set(key, file)
    logger.debug('cache.compaction_file_open', { ...baseAttrs, open_files: open.size })
    return file
  }

  /**
   * Make room for `file` to hold a descriptor while its next row group is
   * written, parking the least recently written file until the descriptor
   * cap has room.
   *
   * Parking is not closing: the parked file keeps its temp file, its byte
   * offset and its accumulated metrics, and the next row group for its
   * tuple reopens it in append mode. So the number of output files a
   * rewrite produces is a function of the partition tuples and the byte
   * target, never of how the scan happens to interleave them.
   *
   * A writer that cannot park (not the local one; nothing reaches this
   * module with another today) can only be retired by closing its file,
   * which is the old behaviour and the old cliff.
   *
   * @ref LLP 0206#descriptor-parking [implements]: park the descriptor,
   *   keep the file.
   * @param {string} key
   * @param {OpenCompactionFile} file
   * @returns {Promise<void>}
   */
  async function reserveDescriptor(key, file) {
    withDescriptor.delete(key)
    while (withDescriptor.size >= MAX_OPEN_DESCRIPTORS) {
      const oldestKey = withDescriptor.keys().next().value
      if (oldestKey === undefined) break
      const oldest = /** @type {OpenCompactionFile} */ (withDescriptor.get(oldestKey))
      withDescriptor.delete(oldestKey)
      if (typeof oldest.writer.park === 'function') {
        parks++
        oldest.writer.park()
      } else {
        openFileRetires++
        await closeFile(oldest, 'open_file_cap')
      }
    }
    withDescriptor.set(key, file)
  }

  /**
   * Close open files, most metadata-hungry first, until the pinned
   * row-group metadata is back inside its budget. This is the roll that
   * bounds heap; `targetFileBytes` is the roll that bounds file size, and
   * whichever binds first wins.
   *
   * @returns {Promise<void>}
   */
  async function enforceStatsBudget() {
    while (openStatsBytes >= MAX_OPEN_STATS_BYTES && open.size > 0) {
      /** @type {OpenCompactionFile | null} */
      let fattest = null
      for (const candidate of open.values()) {
        if (!fattest || candidate.statsBytes > fattest.statsBytes) fattest = candidate
      }
      if (!fattest) break
      statsRolls++
      await closeFile(fattest, 'stats_budget')
    }
  }

  /**
   * @param {OpenCompactionFile} file
   * @param {'target_bytes' | 'stats_budget' | 'open_file_cap' | 'append_close'} reason
   * @returns {Promise<void>}
   */
  async function closeFile(file, reason) {
    const key = JSON.stringify(file.partition)
    open.delete(key)
    withDescriptor.delete(key)
    openStatsBytes -= file.statsBytes
    // `ParquetWriter.finish` writes the footer and finishes the underlying
    // writer, which is what lands the file on disk. A failure here has
    // already been dropped from `open`, so release its fd and temp file
    // now or nothing else ever will.
    try {
      await file.parquet.finish()
    } catch (err) {
      file.writer.abort?.()
      throw err
    }
    logger.debug('cache.compaction_file_closed', {
      ...baseAttrs,
      reason,
      row_groups: file.rowGroups,
      row_count: Number(file.rows),
      bytes_written: file.writer.offset,
      stats_bytes: file.statsBytes,
      open_files: open.size,
    })
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
        const key = JSON.stringify(group.partition)
        const file = open.get(key) ?? openFileFor(key, group.partition)
        await reserveDescriptor(key, file)
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
        // After the write, not before: a `write` that throws must not
        // leave the file's metrics counting a row group it never wrote.
        const statsBytes = accumulateStats(file, sorted, schema)
        file.rowGroups++
        file.rows += BigInt(sorted.length)
        file.statsBytes += statsBytes
        openStatsBytes += statsBytes
        totalRows += sorted.length
        if (file.writer.offset >= targetFileBytes) await closeFile(file, 'target_bytes')
        await enforceStatsBudget()
      }
    },
    async close() {
      for (const file of [...open.values()]) await closeFile(file, 'append_close')
      logger.debug('cache.compaction_stream_closed', {
        ...baseAttrs,
        [Attr.STATUS]: 'ok',
        data_files: dataFiles.length,
        row_count: totalRows,
        bytes_written: totalBytes,
        stats_rolls: statsRolls,
        descriptor_parks: parks,
        open_file_retires: openFileRetires,
      })
      if (dataFiles.length === 0) {
        return { rowCount: totalRows, dataFiles: 0, bytesWritten: 0 }
      }
      await commitDataFiles({
        catalog, resolver, tableUrl, schema, partitionSpec, dataFiles, writtenPaths, totalRows,
      })
      return { rowCount: totalRows, dataFiles: dataFiles.length, bytesWritten: totalBytes }
    },
    async abort() {
      // Every open file holds a `.tmp.*` sibling (and, unless it is
      // parked, an fd on it) that only `finish()` disposes of. Nothing
      // here is committed, so drop the descriptors and the temp files
      // rather than finishing them into data files no snapshot will ever
      // reference.
      const abandoned = open.size
      withDescriptor.clear()
      for (const file of [...open.values()]) {
        open.delete(JSON.stringify(file.partition))
        try {
          file.writer.abort?.()
        } catch {
          // Aborting is best-effort cleanup on a path that is already
          // failing; the original error is the one worth propagating.
        }
      }
      openStatsBytes = 0
      if (abandoned > 0) {
        logger.warn('cache.compaction_stream_aborted', {
          ...baseAttrs,
          [Attr.STATUS]: 'failed',
          abandoned_files: abandoned,
          committed_files: dataFiles.length,
        })
      }
    },
  }
}

/**
 * Whether icebird's parquet mapping produced exactly one top-level element
 * per schema field, in order. `columnData` is positional, so anything else
 * means this module would hand row-group values to the wrong columns.
 *
 * @param {SchemaElement[]} parquetSchema
 * @param {string[]} columnNames
 * @returns {boolean}
 */
function alignsWithParquetSchema(parquetSchema, columnNames) {
  const expected = parquetSchema[0]?.num_children ?? 0
  if (expected !== columnNames.length) return false
  let index = 1
  for (const name of columnNames) {
    if (index >= parquetSchema.length) return false
    if (parquetSchema[index].name !== name) return false
    index += subtreeLength(parquetSchema, index)
  }
  return index === parquetSchema.length
}

/**
 * Number of flat schema elements the subtree rooted at `index` occupies.
 * A parquet schema is a depth-first flattening, so skipping a group means
 * skipping its whole subtree.
 *
 * @param {SchemaElement[]} parquetSchema
 * @param {number} index
 * @returns {number}
 */
function subtreeLength(parquetSchema, index) {
  let length = 1
  let remaining = parquetSchema[index]?.num_children ?? 0
  while (remaining > 0 && index + length < parquetSchema.length) {
    length += subtreeLength(parquetSchema, index + length)
    remaining--
  }
  return length
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
    async abort() {
      // Nothing to release: this path commits each batch synchronously and
      // holds no writer between calls.
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
 * Fold one row group's values into the file's running Iceberg metrics, and
 * report what that row group costs against `MAX_OPEN_STATS_BYTES`.
 *
 * Counts accumulate directly; bounds accumulate as the raw minimum and
 * maximum values seen so far, compared with icebird's own type-aware
 * comparator. Serialization (and the spec's 16-unit bound truncation) is
 * left to `computeColumnStats` at file close, so the encoding stays
 * icebird's.
 *
 * The returned charge is an upper bound on what `ParquetWriter` will pin
 * for this row group: the widest value in each column counted twice (it
 * could be both the chunk's min and its max), plus a flat per-chunk term.
 * It rides along on this loop because this is the only pass that already
 * visits every value.
 *
 * @param {OpenCompactionFile} file
 * @param {Record<string, any>[]} records
 * @param {Schema} schema
 * @returns {number} bytes this row group adds to the open-file stats budget
 */
function accumulateStats(file, records, schema) {
  let statsBytes = 0
  for (const field of schema.fields) {
    const type = field.type
    if (typeof type === 'object') continue
    statsBytes += ROW_GROUP_STATS_OVERHEAD_BYTES
    const isFloat = type === 'float' || type === 'double'
    const bounded = tracksBounds(type)
    // A variant column reaches parquet as byte-array leaves, and
    // hyparquet's statistics skip non-primitive values outright, so no
    // value of one is ever retained however fat the JSON is.
    const pinsValues = type !== 'variant'
    const writeDefault = field['write-default']
    let nulls = 0n
    let nans = 0n
    let widest = 0
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
      if (pinsValues) {
        const size = retainedValueBytes(value)
        if (size > widest) widest = size
      }
      if (!bounded) continue
      if (min === undefined || compare(value, min, type) < 0) min = value
      if (max === undefined || compare(value, max, type) > 0) max = value
    }
    statsBytes += 2 * widest
    file.valueCounts[field.id] = (file.valueCounts[field.id] ?? 0n) + BigInt(records.length)
    file.nullCounts[field.id] = (file.nullCounts[field.id] ?? 0n) + nulls
    if (isFloat) file.nanCounts[field.id] = (file.nanCounts[field.id] ?? 0n) + nans
    if (min !== undefined) file.mins[field.id] = min
    if (max !== undefined) file.maxes[field.id] = max
  }
  return statsBytes
}

/**
 * Heap a single retained bound value costs. Anything hyparquet's
 * statistics would skip (objects, byte arrays) is charged nothing,
 * because nothing is retained.
 *
 * Strings are charged by how V8 actually stores them, not at the UTF-16
 * upper bound `estimateRowBytes` uses in the batch sizer. V8 keeps a
 * string one byte per character unless it holds a character above
 * U+00FF, and a UTF-8 byte length equal to the character count proves
 * every character is below U+0080. So a payload that is entirely ASCII -
 * which `ai_gateway_messages` bodies are - is charged what it costs
 * instead of twice what it costs. That is not cosmetic: the budget is
 * what rolls a file for fat rows, so a 2x overcharge halved how many row
 * groups an open file could absorb. Measured at 200 tuples x 10 batches
 * x 35 K-character ASCII values: 811 output files and 11.4 MB peak
 * retained before, 503 files and 18.6 MB after, against a 32 MiB budget.
 * The same shape with two-byte values is unchanged at 811 files, so the
 * charge did not slip on the values it exists for.
 * The test is conservative in the safe direction: a Latin-1 character
 * (U+0080 to U+00FF) is one byte in V8 but two in UTF-8, so such a string
 * is still charged double.
 *
 * @param {unknown} value
 * @returns {number}
 */
function retainedValueBytes(value) {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8') === value.length ? value.length : value.length * 2
  }
  if (typeof value === 'object') return 0
  if (typeof value === 'bigint') return 16
  return 8
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
