// @ts-check

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'

/**
 * @import { ColumnSpec } from '../../../collectivus-plugin-kernel-types.js'
 * @import { FlushChunk, ProgressState } from '../../../src/core/cache/types.js'
 */

export const BATCH_BYTE_LIMIT = 128 * 1024 * 1024
export const BATCH_ROW_LIMIT = 100_000

/**
 * Internal append-monotonic ingest sequence column. Hidden, nullable, and
 * additive: it is stamped on every flushed row at the `decorateRow`
 * chokepoint, carried verbatim through compaction (it is a row-resident
 * value, so a generation-swap rewrite copies it into the new table), and
 * stripped from every query/`readRows` consumer via `INTERNAL_FIELDS`.
 *
 * Nullable so it rides existing tables as an additive schema change — rows
 * written before the column existed read back as `null`.
 *
 * @ref LLP 0040#ingest-seq-column [implements] — row-resident monotonic int64 watermark column
 * @type {ColumnSpec}
 */
export const INGEST_SEQ_COLUMN = { name: '_hyp_ingest_seq', type: 'INT64', nullable: true }

/**
 * Read a rotated spool file as a stream, yielding batches of rows that
 * respect both a byte-size ceiling and a row-count ceiling. Partial
 * trailing lines are left in the buffer: the caller should treat them
 * as data for the next read cycle (in practice the spool writer always
 * ends lines with `\n`, so a partial line means the file was truncated
 * or is still being written).
 *
 * Each emitted row is decorated with:
 * - `_hyp_cache_row_id`  — SHA-256 of the serialized row (stable dedup key)
 * - `_hyp_cache_batch_id` — caller-supplied batch identifier
 * - `_hyp_ingest_seq`     — monotonic int64 from `nextSeq` (null when absent)
 *
 * The decorated chunk's `columns` carry an extra nullable `_hyp_ingest_seq`
 * `ColumnSpec` so the value lands in the Iceberg schema (additive, never
 * required). The `_hyp_cache_row_id` hash is computed over the ORIGINAL row,
 * before any decoration, so the seq does not perturb the dedup identity.
 *
 * Resume support: if `startOffset` > 0 the reader seeks past already-
 * flushed bytes and continues from there. After each yielded batch the
 * caller should persist `batch.resumeOffset` so a crash-restart picks
 * up where we left off.
 *
 * @param {{
 *   filePath: string,
 *   batchId: string,
 *   startOffset?: number,
 *   batchByteLimit?: number,
 *   batchRowLimit?: number,
 *   nextSeq?: () => Promise<bigint>,
 * }} opts
 * @returns {AsyncGenerator<{
 *   chunk: FlushChunk,
 *   resumeOffset: number,
 *   malformedCount: number,
 * }>}
 */
export async function* streamFlushFile(opts) {
  const {
    filePath,
    batchId,
    startOffset = 0,
    batchByteLimit = BATCH_BYTE_LIMIT,
    batchRowLimit = BATCH_ROW_LIMIT,
    nextSeq,
  } = opts

  const stream = createReadStream(filePath, {
    start: startOffset,
    encoding: 'utf8',
    highWaterMark: 64 * 1024,
  })

  let tail = ''
  let absoluteOffset = startOffset
  /** @type {readonly ColumnSpec[] | null} */
  let currentColumns = null
  let currentSignature = ''
  /** @type {Record<string, unknown>[]} */
  let currentRows = []
  let currentBatchBytes = 0
  let malformedCount = 0

  /**
   * @returns {FlushChunk | null}
   */
  function sealBatch() {
    if (!currentColumns || currentRows.length === 0) return null
    const chunk = { columns: withIngestSeqColumn(currentColumns), rows: currentRows }
    currentColumns = null
    currentSignature = ''
    currentRows = []
    currentBatchBytes = 0
    return chunk
  }

  for await (const data of stream) {
    const text = /** @type {string} */ (data)
    tail += text

    let newlineIdx
    while ((newlineIdx = tail.indexOf('\n')) !== -1) {
      const line = tail.slice(0, newlineIdx)
      const lineByteLen = Buffer.byteLength(line, 'utf8') + 1
      const lineStartOffset = absoluteOffset
      tail = tail.slice(newlineIdx + 1)
      absoluteOffset += lineByteLen

      if (line.length === 0) continue

      /** @type {{ version?: number, columns?: readonly ColumnSpec[], rows?: Record<string, unknown>[] } | null} */
      let envelope = null
      try {
        envelope = JSON.parse(line)
      } catch {
        malformedCount++
        continue
      }

      if (
        !envelope ||
        envelope.version !== 1 ||
        !Array.isArray(envelope.columns) ||
        !Array.isArray(envelope.rows)
      ) {
        malformedCount++
        continue
      }

      const signature = JSON.stringify(envelope.columns)
      if (currentColumns && signature !== currentSignature) {
        const sealed = sealBatch()
        if (sealed) {
          yield { chunk: sealed, resumeOffset: absoluteOffset - lineByteLen, malformedCount }
          malformedCount = 0
        }
      }

      currentColumns = envelope.columns
      currentSignature = signature

      for (let idx = 0; idx < envelope.rows.length; idx++) {
        const row = envelope.rows[idx]
        // Reserve-before-stamp: each seq is durably reserved (allocator
        // advances the persisted nextSeq one block ahead) before it reaches
        // a row, so a resumed flush never re-issues a seq it already stamped.
        const seq = nextSeq ? await nextSeq() : null
        const decorated = decorateRow(row, batchId, seq)
        const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
        currentRows.push(decorated)
        currentBatchBytes += rowBytes

        if (currentRows.length >= batchRowLimit || currentBatchBytes >= batchByteLimit) {
          const sealed = sealBatch()
          if (sealed) {
            const endedOnLineBoundary = idx === envelope.rows.length - 1
            yield {
              chunk: sealed,
              resumeOffset: endedOnLineBoundary ? absoluteOffset : lineStartOffset,
              malformedCount,
            }
            malformedCount = 0
          }
          if (!currentColumns) {
            currentColumns = envelope.columns
            currentSignature = signature
          }
        }
      }
    }
  }

  const sealed = sealBatch()
  if (sealed) {
    yield { chunk: sealed, resumeOffset: absoluteOffset, malformedCount }
  }
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} batchId
 * @param {bigint | null} seq monotonic ingest sequence, or `null` when no
 *   allocator is wired (the seq is then absent and reads back as null)
 * @returns {Record<string, unknown>}
 */
function decorateRow(row, batchId, seq) {
  const serialized = JSON.stringify(row, stableReplacer)
  const hash = createHash('sha256').update(serialized).digest('hex')
  return {
    ...row,
    _hyp_cache_row_id: hash,
    _hyp_cache_batch_id: batchId,
    [INGEST_SEQ_COLUMN.name]: seq,
  }
}

/**
 * Append the nullable `_hyp_ingest_seq` column to a chunk's column list so the
 * stamped value lands in the Iceberg schema. Idempotent — never double-adds.
 *
 * @param {readonly ColumnSpec[]} columns
 * @returns {ColumnSpec[]}
 */
function withIngestSeqColumn(columns) {
  if (columns.some((c) => c.name === INGEST_SEQ_COLUMN.name)) return [...columns]
  return [...columns, INGEST_SEQ_COLUMN]
}

/**
 * Stable JSON key ordering for deterministic hashes.
 *
 * @param {string} _key
 * @param {unknown} value
 * @returns {unknown}
 */
function stableReplacer(_key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    /** @type {Record<string, unknown>} */
    const sorted = {}
    for (const k of Object.keys(value).sort()) {
      sorted[k] = /** @type {Record<string, unknown>} */ (value)[k]
    }
    return sorted
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

/**
 * Read persisted progress for a spool file.
 *
 * @param {string} spoolFilePath
 * @returns {Promise<ProgressState | null>}
 */
export async function readProgress(spoolFilePath) {
  try {
    const raw = await fs.readFile(progressPath(spoolFilePath), 'utf8')
    const parsed = /** @type {ProgressState} */ (JSON.parse(raw))
    if (typeof parsed.byteOffset !== 'number' || !Number.isFinite(parsed.byteOffset)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Persist flush progress for a spool file. Uses atomic write-rename.
 *
 * @param {string} spoolFilePath
 * @param {number} byteOffset
 */
export async function writeProgress(spoolFilePath, byteOffset) {
  const dest = progressPath(spoolFilePath)
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`
  /** @type {ProgressState} */
  const state = { byteOffset, updatedAt: new Date().toISOString() }
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(tmp, dest)
}

/**
 * Remove the progress file for a spool file.
 *
 * @param {string} spoolFilePath
 */
export async function removeProgress(spoolFilePath) {
  await fs.rm(progressPath(spoolFilePath), { force: true })
}

/**
 * @param {string} spoolFilePath
 * @returns {string}
 */
function progressPath(spoolFilePath) {
  return `${spoolFilePath}.progress.json`
}

/**
 * Internal-field names that should be hidden from query output and from every
 * `readRows` consumer (forward/blob sinks, query, projectors). `_hyp_ingest_seq`
 * is included so the sink-read watermark column never leaks to the wire payload
 * or query results — `readRowsSince` (T2) re-exposes it as an opaque token only.
 *
 * @ref LLP 0040#storage-api-extension [constrained-by] — internal, stripped on read
 */
export const INTERNAL_FIELDS = ['_hyp_cache_row_id', '_hyp_cache_batch_id', INGEST_SEQ_COLUMN.name]
