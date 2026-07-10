// @ts-check

import { Attr, getLogger, getMeter, withSpan } from '../observability/index.js'
import {
  dataSourceForTable,
  scanRowsFromTable,
  seqValue,
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
import { createCacheSpool, discoverSpoolTables, DEFAULT_SPOOL_BYTES_THRESHOLD } from './spool.js'
import { INGEST_SEQ_COLUMN, INTERNAL_FIELDS } from './streaming-reader.js'

import { createHash } from 'node:crypto'
import path from 'node:path'

/**
 * @import { ColumnSpec, QueryScope, QueryStorageService, SinkContinuation } from '../../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration, ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 * @import { AsyncDataSource } from 'squirreling'
 */

/**
 * Short, one-way digest of a `cwd` for the `usage_policy.export_drop`
 * aggregate: dev telemetry must never carry a raw local path, only a stable
 * token to count distinct withheld directories (LLP 0080 #telemetry).
 *
 * @param {string} cwd
 * @returns {string}
 */
function hashCwd(cwd) {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16)
}

/**
 * Decode a persisted `SinkContinuation` into its int64 `_hyp_ingest_seq`
 * watermark. Absent ⇒ `0n` ("exported nothing"): the allocator starts seqs at
 * 1, so `0` is strictly below every real row and a fresh sink reads the whole
 * table. The token is opaque + versioned so the watermark mechanism can change
 * later without invalidating persisted watermarks (LLP 0040 §2).
 *
 * @param {SinkContinuation | undefined} since
 * @returns {bigint}
 */
function continuationToSeq(since) {
  if (since === undefined || since === null) return 0n
  if (since.v !== 1 || typeof since.seq !== 'string' || !/^\d+$/.test(since.seq)) {
    throw new Error(`readRows: invalid SinkContinuation ${JSON.stringify(since)}`)
  }
  return BigInt(since.seq)
}

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
 * `hyp_dataset`, `row_count`, and `bytes_written` - the contract the
 * Phase 4 smoke (and the SQL assertion in the implementation plan)
 * exercise.
 *
 * @param {{
 *   cacheRoot: string,
 *   getDeclaration?: (dataset: string) => CachePartitioningDeclaration | undefined,
 *   getSettleHook?: (dataset: string) => ((rows: Record<string, unknown>[], ctx: { storage: ExtendedQueryStorageService }) => Promise<Record<string, unknown>[]>) | undefined,
 *   usagePolicyResolver?: UsagePolicyResolver,
 * }} args
 * @returns {ExtendedQueryStorageService}
 * @ref LLP 0013#write-path-and-query [implements]: kernel-owned cache write path; every source row lands here
 */
export function createQueryStorageService({ cacheRoot, getDeclaration, getSettleHook, usagePolicyResolver }) {
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
      // @ref LLP 0027#decision: flush-time settlement: the owning dataset
      // may upgrade provisional (fallback) row identity and dedupe before
      // the batch is committed. Generic and optional; the hook itself
      // short-circuits cheaply when a batch has nothing to settle.
      const settle = getSettleHook?.(dataset)
      if (settle) {
        rows = await settle(rows, { storage: service })
      }
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

    hasPendingSync(tablePath) {
      return spool.hasPendingSync(tablePath)
    },

    tableUrl(tablePath) {
      return icebergTableUrl(resolveIcebergDir(tablePath))
    },

    // @ref LLP 0040#storage-api-extension [implements] — back-compatible
    // `opts.since`: absent ⇒ byte-for-byte the pre-existing full scan, so every
    // current caller is untouched until it opts in. When set, the scan yields
    // only rows newer than the watermark (null-seq legacy rows always yielded).
    async *readRows(tablePath, columns, opts) {
      const since = opts?.since !== undefined ? continuationToSeq(opts.since) : undefined
      const projected = columns?.filter((c) => !INTERNAL_FIELDS.includes(c))
      const scanOpts = since !== undefined ? { since, includeLegacy: opts?.includeLegacy } : undefined
      for await (const row of scanRowsFromTable(resolveIcebergDir(tablePath), projected, scanOpts)) {
        for (const f of INTERNAL_FIELDS) delete row[f]
        yield row
      }
    },

    // @ref LLP 0040#storage-api-extension [implements] — cursor-aware sibling
    // for sinks that advance a per-(sink, partition) watermark. `_hyp_ingest_seq`
    // is an INTERNAL_FIELD stripped from the row, so a sink reading `readRows`
    // can't learn the high-water seq; `readRowsSince` reads it to derive the
    // `after` token, then strips it so the seq never reaches the wire payload.
    // `includeLegacy` (default true) governs pre-upgrade null-seq rows: a sink
    // with no durable watermark passes true (export the backlog once); once it
    // has a watermark it passes false (the backlog is already shipped), so the
    // one-time migration never re-exports on every tick (LLP 0040 §6 risk #1).
    async *readRowsSince(tablePath, opts = {}) {
      const since = continuationToSeq(opts.since)
      const projected = opts.columns?.filter((c) => !INTERNAL_FIELDS.includes(c))
      // @ref LLP 0070#enforce [constrained-by]: withholding must not depend on
      // the caller's projection. The filter reads each row's own `cwd`; a
      // `columns` projection that omits `cwd` would leave the projected row
      // cwd-less, the filter would treat it as cwd-less, and a local-only row
      // would be FORWARDED. So when a resolver is configured, force `cwd` into
      // the scan regardless of `columns`, then strip it back off the yielded row
      // if the caller didn't ask for it — the projection contract is honored,
      // but the guarantee never rides on callers remembering to include `cwd`.
      // (`projected === undefined` means "all columns", which already carries
      // `cwd`; no forcing and no stripping needed.)
      const forceCwd = usagePolicyResolver !== undefined && projected !== undefined && !projected.includes('cwd')
      const scanColumns = forceCwd ? [...projected, 'cwd'] : projected
      // Running high-water of REAL (non-null) seqs seen so far, seeded with the
      // incoming watermark. `after` is this monotonic max, so a null-seq legacy
      // row never advances the watermark and progress never regresses even when
      // the scan visits seqs out of order (interleaved sources; LLP 0040 risk #3).
      let high = since
      let droppedRowCount = 0
      /** @type {Set<string>} */
      const droppedCwdHashes = new Set()
      for await (const row of scanRowsFromTable(resolveIcebergDir(tablePath), scanColumns, { since, includeLegacy: opts.includeLegacy })) {
        const seq = seqValue(row[INGEST_SEQ_COLUMN.name])
        if (seq !== null && seq > high) high = seq
        for (const f of INTERNAL_FIELDS) delete row[f]
        /** @type {SinkContinuation} */
        const after = { v: 1, seq: high.toString() }
        // @ref LLP 0070#enforce [implements]: per-row export filter, derived from the row's own `cwd` at export time — no cache-schema marker, retroactive over already-cached rows; `cwd` is forced into the scan above so a caller's `columns` projection can't bypass this filter
        // @ref LLP 0069#enforce [implements]: the export-seam half of the local-only directory withholding
        // @ref LLP 0070#incremental [constrained-by]: a withheld row is dropped from the payload but its `after` still advances the cursor across it (drop-but-advance)
        // A corrupt/unreadable list makes `resolve` throw; we let it propagate
        // so the partition read fails and the sink's per-partition retry leaves
        // the watermark untouched (LLP 0080 #fail-safe) — never a silent skip.
        const cwd = row.cwd
        if (usagePolicyResolver && typeof cwd === 'string' && cwd !== '' && usagePolicyResolver.resolve(cwd).class !== 'full') {
          droppedRowCount += 1
          droppedCwdHashes.add(hashCwd(cwd))
          yield { after, dropped: true }
          continue
        }
        // We forced `cwd` in for the filter only; don't leak it into a payload
        // the caller's projection didn't ask for.
        if (forceCwd) delete row.cwd
        yield { row, after }
      }
      // Per-partition aggregate on the export read; cwds are hashed, never raw
      // paths in dev telemetry (LLP 0080 #telemetry). Emitted only when the scan
      // completes normally, so a corrupt-list throw reports no partial drop.
      if (droppedRowCount > 0) {
        logger.debug('usage_policy.export_drop', {
          [Attr.COMPONENT]: 'cache',
          [Attr.DATASET]: datasetForTablePath(cacheRoot, tablePath) ?? 'unknown',
          dropped_row_count: droppedRowCount,
          distinct_cwd_count: droppedCwdHashes.size,
        })
      }
    },

    async dataSourceForTable(tablePath) {
      const source = await dataSourceForTable(resolveIcebergDir(tablePath))
      if (!source) return null
      const publicColumns = source.columns.filter((c) => !INTERNAL_FIELDS.includes(c))
      /** @type {AsyncDataSource} */
      const wrapped = {
        numRows: source.numRows,
        columns: publicColumns,
        scan(options) {
          // Internal fields are hidden by PROJECTION, not by rebuilding every
          // row: the inner scan is always given an explicit column list with
          // the internal fields already stripped (the advertised public set
          // when the caller asked for everything), so the rows it yields never
          // carry an internal column and can be passed through untouched. The
          // previous per-row rebuild (filter columns, re-key cells, re-spread
          // resolved) allocated ~5 objects per row on every query, which
          // dominated scan-side garbage on large datasets.
          const requested = options?.columns
          const columns = requested
            ? requested.filter((c) => !INTERNAL_FIELDS.includes(c))
            : publicColumns
          const inner = source.scan({ ...options, columns })
          return {
            appliedWhere: inner.appliedWhere,
            appliedLimitOffset: inner.appliedLimitOffset,
            rows: () => inner.rows(),
          }
        },
      }
      // @ref LLP 0055 [implements]: forward the column-stream hook so the
      // engine's streaming-aggregate fast path stays lit through the storage
      // wrapper; internal fields are not advertised, so the engine can never
      // request one here.
      if (typeof source.scanColumn === 'function') {
        wrapped.scanColumn = (options) => /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (source.scanColumn)(options)
      }
      return wrapped
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

    // @ref LLP 0027#open-questions [implements]: read-only spool surface so
    // `hyp backfill` can dedupe against rows captured live but not yet flushed,
    // which the committed-partition scan cannot see. Inspection-only: never
    // rotates or advances flush progress, so it is safe alongside live capture.
    async *readSpooledRows(dataset, columns) {
      if (!dataset) return
      /** @type {string[]} */
      let tables = []
      try {
        tables = await discoverSpoolTables(cacheRoot)
      } catch {
        return
      }
      for (const tablePath of tables) {
        if (datasetForTablePath(cacheRoot, tablePath) !== dataset) continue
        for await (const row of spool.readSpooledRows(tablePath)) {
          for (const f of INTERNAL_FIELDS) delete row[f]
          yield columns ? projectRow(row, columns) : row
        }
      }
    },

    pendingInfo(tablePath) {
      return spool.pendingInfo(tablePath)
    },
  }
  return service
}

/**
 * Narrow a spooled row to the requested columns. Keeps the spool reader
 * parity with `readRows`, which projects committed rows to the same
 * column subset, so a caller folding both into one seen-set compares
 * like-for-like keys.
 *
 * @param {Record<string, unknown>} row
 * @param {string[]} columns
 * @returns {Record<string, unknown>}
 */
function projectRow(row, columns) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const col of columns) {
    if (col in row) out[col] = row[col]
  }
  return out
}
