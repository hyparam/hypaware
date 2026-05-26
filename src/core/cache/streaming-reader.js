// @ts-check

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'

/**
 * @import { ColumnSpec } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * @typedef {{
 *   columns: readonly ColumnSpec[],
 *   rows: Record<string, unknown>[],
 * }} FlushChunk
 */

/**
 * @typedef {{
 *   byteOffset: number,
 *   updatedAt: string,
 * }} ProgressState
 */

export const BATCH_BYTE_LIMIT = 128 * 1024 * 1024
export const BATCH_ROW_LIMIT = 100_000

/**
 * Read a rotated spool file as a stream, yielding batches of rows that
 * respect both a byte-size ceiling and a row-count ceiling. Partial
 * trailing lines are left in the buffer — the caller should treat them
 * as data for the next read cycle (in practice the spool writer always
 * ends lines with `\n`, so a partial line means the file was truncated
 * or is still being written).
 *
 * Each emitted row is decorated with:
 * - `_hyp_cache_row_id`  — SHA-256 of the serialized row (stable dedup key)
 * - `_hyp_cache_batch_id` — caller-supplied batch identifier
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
  let batchStartOffset = absoluteOffset

  /**
   * @returns {FlushChunk | null}
   */
  function sealBatch() {
    if (!currentColumns || currentRows.length === 0) return null
    const chunk = { columns: currentColumns, rows: currentRows }
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
          const resumeOffset = batchStartOffset + batchByteLen(sealed)
          yield { chunk: sealed, resumeOffset: absoluteOffset - lineByteLen, malformedCount }
          malformedCount = 0
          batchStartOffset = absoluteOffset - lineByteLen
        }
      }

      currentColumns = envelope.columns
      currentSignature = signature

      for (const row of envelope.rows) {
        const decorated = decorateRow(row, batchId)
        const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
        currentRows.push(decorated)
        currentBatchBytes += rowBytes

        if (currentRows.length >= batchRowLimit || currentBatchBytes >= batchByteLimit) {
          const sealed = sealBatch()
          if (sealed) {
            yield { chunk: sealed, resumeOffset: absoluteOffset, malformedCount }
            malformedCount = 0
            batchStartOffset = absoluteOffset
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
 * @returns {Record<string, unknown>}
 */
function decorateRow(row, batchId) {
  const serialized = JSON.stringify(row, stableReplacer)
  const hash = createHash('sha256').update(serialized).digest('hex')
  return {
    ...row,
    _hyp_cache_row_id: hash,
    _hyp_cache_batch_id: batchId,
  }
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
 * Dead-simple byte estimate for a sealed batch (used only as a fallback
 * when we need to compute a resume offset from a batch object rather than
 * tracking offsets inline). In normal flow the inline `absoluteOffset`
 * tracking makes this unnecessary — the function exists for completeness.
 *
 * @param {FlushChunk} _chunk
 * @returns {number}
 */
function batchByteLen(_chunk) {
  return 0
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
 * Internal-field names that should be hidden from query output.
 */
export const INTERNAL_FIELDS = ['_hyp_cache_row_id', '_hyp_cache_batch_id']
