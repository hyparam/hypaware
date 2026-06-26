// @ts-check

import path from 'node:path'

import { createSinkWatermarkStore } from './watermarks.js'

/**
 * @import {
 *   PluginPaths,
 *   QueryPartition,
 *   QueryStorageService,
 *   SinkContinuation,
 * } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { IncrementalRowReader, SinkWatermarkKey, SinkWatermarkStore } from './types.d.ts'
 */

/**
 * Sub-directory under a destination plugin's `stateDir` that namespaces one
 * sink instance's watermarks. See {@link createInstanceWatermarkStore}.
 */
const INSTANCE_DIR = 'sink-instances'

/**
 * Build a watermark store scoped to a single sink instance.
 *
 * `PluginPaths.stateDir` is per-**plugin** (`<state>/plugins/<plugin>`), not per
 * sink **instance** — but the design's watermark contract is one watermark per
 * `(sink instance, partition)`. Two instances of one destination plugin (e.g.
 * dual-writing the same dataset to two buckets) would otherwise share — and
 * clobber — a single watermark file, silently skipping rows the other instance
 * exported. The wiring layer is the only place that knows the instance name, so
 * it scopes the store here, satisfying `watermarks.js`'s documented precondition
 * that the `stateDir` it receives is already instance-scoped.
 *
 * @ref LLP 0040#watermark-contract [implements] — one watermark per (sink instance, partition)
 * @param {{ paths: PluginPaths, instanceName: string }} opts
 * @returns {SinkWatermarkStore}
 */
export function createInstanceWatermarkStore({ paths, instanceName }) {
  if (!paths?.stateDir) {
    throw new Error('createInstanceWatermarkStore: paths.stateDir is required')
  }
  if (!instanceName) {
    throw new Error('createInstanceWatermarkStore: instanceName is required')
  }
  const stateDir = path.join(paths.stateDir, INSTANCE_DIR, sanitizeInstance(instanceName))
  return createSinkWatermarkStore({ stateDir })
}

/**
 * Restrict a user-chosen sink instance name to a safe directory segment so it
 * cannot escape the plugin state directory.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeInstance(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned.length > 0 ? cleaned : '_instance'
}

/** @returns {AsyncIterable<Record<string, unknown>>} */
function emptyAsyncIterable() {
  return { async *[Symbol.asyncIterator]() {} }
}

/**
 * Derive the stable logical watermark key for a partition, or `null` when the
 * partition has no `tablePath` (registered-but-not-materialized) so the caller
 * exports without persisting a watermark. A `tablePath` that is set but not
 * under the cache datasets root throws via `keyFor` — a genuine misconfiguration
 * the per-partition error path should surface, not silently ignore.
 *
 * @param {SinkWatermarkStore} watermarks
 * @param {QueryStorageService} storage
 * @param {QueryPartition} partition
 * @returns {SinkWatermarkKey | null}
 */
export function watermarkKeyFor(watermarks, storage, partition) {
  if (!partition.tablePath) return null
  return watermarks.keyFor(storage.cacheRoot, partition.tablePath)
}

/**
 * Open a partition's **new** rows (those with `_hyp_ingest_seq > since`) as a
 * single-use, self-tracking row stream for a blob destination.
 *
 * The returned reader:
 *
 * - decides emptiness up front by **peeking** the first row, so the skip-empty
 *   decision never depends on the encoder actually draining the stream;
 * - exposes `rows` — the clean (internal-stripped) rows to feed straight into
 *   the unchanged `encoder.encodePartition` contract;
 * - tracks `rowCount` and the high-water `lastAfter` continuation as the encoder
 *   consumes `rows` (both are final once the encoder has drained the stream,
 *   which it must to encode them).
 *
 * A partition with no `tablePath`, or whose table does not exist on disk yet, is
 * reported `empty` (yield nothing) rather than throwing — the caller writes no
 * blob, exactly as for a partition with no new rows.
 *
 * @ref LLP 0040#storage-api-extension [implements] — feed readRowsSince into the unchanged encoder; empty new-row set ⇒ no blob
 * @param {QueryStorageService} storage
 * @param {QueryPartition} partition
 * @param {SinkContinuation | undefined} since
 * @returns {Promise<IncrementalRowReader>}
 */
export async function openIncrementalRows(storage, partition, since) {
  const sinceSeq = since?.seq ?? '0'
  const state = {
    rowCount: 0,
    /** @type {SinkContinuation} */
    lastAfter: since ?? { v: 1, seq: sinceSeq },
  }

  const tablePath = partition.tablePath
  const iterator = tablePath && storage.tableExists(tablePath)
    ? storage.readRowsSince(tablePath, { since })[Symbol.asyncIterator]()
    : null

  /** @type {IteratorResult<{ row: Record<string, unknown>, after: SinkContinuation }> | null} */
  let first = null
  if (iterator) {
    first = await iterator.next()
    if (first.done) {
      // Release the underlying scan immediately — nothing new to export.
      await iterator.return?.()
    }
  }
  const empty = iterator === null || first === null || first.done === true

  async function* rows() {
    if (empty || iterator === null || first === null) return
    try {
      let entry = first
      while (!entry.done) {
        state.rowCount += 1
        state.lastAfter = entry.value.after
        yield entry.value.row
        entry = await iterator.next()
      }
    } finally {
      // Release the scan if the consumer stopped early (e.g. encoder threw).
      await iterator.return?.()
    }
  }

  return {
    empty,
    sinceSeq,
    rows: empty ? emptyAsyncIterable() : { [Symbol.asyncIterator]: rows },
    get rowCount() {
      return state.rowCount
    },
    get lastAfter() {
      return state.lastAfter
    },
  }
}

/**
 * Embed an incremental export's `[sinceSeq, lastSeq]` range in the encoder's
 * filename, inserted before the final extension:
 * `all.parquet` → `all.<sinceSeq>-<lastSeq>.parquet`.
 *
 * The range is a deterministic function of the watermark and the rows read, so a
 * crash-retry (watermark not yet advanced) reproduces the **same** filename and
 * thus the same object key — an idempotent overwrite. This is the blob sink's
 * stand-in for the central sink's server-side idempotency ledger.
 *
 * @ref LLP 0040#applying-it-to-both-sinks [implements] — [sinceSeq,lastSeq] filename ⇒ idempotent re-PUT
 * @param {string} filename
 * @param {string} sinceSeq
 * @param {string} lastSeq
 * @returns {string}
 */
export function withSeqRangeFilename(filename, sinceSeq, lastSeq) {
  const range = `${sinceSeq}-${lastSeq}`
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return `${filename}.${range}`
  return `${filename.slice(0, dot)}.${range}${filename.slice(dot)}`
}
