import fs from 'node:fs'

/**
 * @import { JsonlEntry, JsonlReadOptions, JsonlReadResult } from './types.d.ts'
 */

const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d
const DEFAULT_BATCH_ROWS = 5_000
const DEFAULT_BATCH_BYTES = 16 * 1024 * 1024
const STREAM_HIGH_WATER_MARK = 1024 * 1024

/**
 * Stream complete JSONL lines after a byte cursor. A trailing partial line is
 * deliberately left unread so refresh can retry it once the writer appends
 * its newline.
 *
 * `onBatch` is called only for batches containing parsed object entries. The
 * returned cursor still advances across empty or malformed complete lines.
 *
 * @param {string} filePath
 * @param {JsonlReadOptions} options
 * @param {(batch: JsonlReadResult) => void | Promise<void>} onBatch
 * @returns {Promise<JsonlReadResult>}
 */
export async function readJsonlEntryBatches(filePath, options = {}, onBatch = () => {}) {
  const {
    startByteOffset = 0,
    startLineNumber = 0,
    endByteOffset,
    batchRows = DEFAULT_BATCH_ROWS,
    batchBytes = DEFAULT_BATCH_BYTES,
  } = options
  const stat = fs.statSync(filePath)
  if (startByteOffset > stat.size) {
    throw new Error(`source JSONL was truncated: ${filePath}`)
  }
  const readEndOffset = endByteOffset === undefined
    ? stat.size
    : Math.max(startByteOffset, Math.min(endByteOffset, stat.size))

  /** @type {JsonlEntry[]} */
  let entries = []
  let entriesBytes = 0
  /** @type {Buffer<ArrayBufferLike>} */
  let pending = Buffer.alloc(0)
  let currentLineOffset = startByteOffset
  let nextByteOffset = startByteOffset
  let nextLineNumber = startLineNumber

  /** @returns {Promise<void>} */
  async function flush() {
    if (entries.length === 0) return
    const batch = {
      entries,
      nextByteOffset,
      nextLineNumber,
      fileSize: stat.size,
      fileMtimeMs: stat.mtimeMs,
    }
    entries = []
    entriesBytes = 0
    await onBatch(batch)
  }

  if (startByteOffset < readEndOffset) {
    const stream = fs.createReadStream(filePath, {
      start: startByteOffset,
      end: readEndOffset - 1,
      highWaterMark: STREAM_HIGH_WATER_MARK,
    })
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error(`expected Buffer chunk while reading ${filePath}`)
      const buf = pending.byteLength === 0
        ? chunk
        : Buffer.concat([pending, chunk])
      let scanStart = 0
      let newlineIndex = buf.indexOf(NEWLINE, scanStart)
      while (newlineIndex !== -1) {
        const rawLine = buf.subarray(scanStart, newlineIndex)
        const lineBytes = newlineIndex - scanStart + 1
        const lineOffset = currentLineOffset
        const lineNextOffset = currentLineOffset + lineBytes
        currentLineOffset = lineNextOffset
        nextByteOffset = lineNextOffset
        nextLineNumber++

        const line = rawLine.byteLength > 0 && rawLine[rawLine.byteLength - 1] === CARRIAGE_RETURN
          ? rawLine.subarray(0, rawLine.byteLength - 1)
          : rawLine
        if (line.byteLength > 0) {
          const parsed = parseJsonlObject(filePath, nextLineNumber, line)
          if (parsed) {
            entries.push({
              lineNumber: nextLineNumber,
              byteOffset: lineOffset,
              nextByteOffset: lineNextOffset,
              raw: parsed,
            })
            entriesBytes += lineBytes
            if (entries.length >= batchRows || entriesBytes >= batchBytes) {
              await flush()
            }
          }
        }

        scanStart = newlineIndex + 1
        newlineIndex = buf.indexOf(NEWLINE, scanStart)
      }
      pending = scanStart < buf.byteLength ? buf.subarray(scanStart) : Buffer.alloc(0)
    }
  }

  await flush()
  return {
    entries: [],
    nextByteOffset,
    nextLineNumber,
    fileSize: stat.size,
    fileMtimeMs: stat.mtimeMs,
  }
}

/**
 * Read complete JSONL lines into memory. Prefer `readJsonlEntryBatches` for
 * refresh paths that can process rows incrementally.
 *
 * @param {string} filePath
 * @param {number} startByteOffset
 * @param {number} startLineNumber
 * @returns {Promise<JsonlReadResult>}
 */
export async function readJsonlEntries(filePath, startByteOffset = 0, startLineNumber = 0) {
  /** @type {JsonlEntry[]} */
  const entries = []
  const result = await readJsonlEntryBatches(
    filePath,
    { startByteOffset, startLineNumber },
    (batch) => {
      entries.push(...batch.entries)
    }
  )
  return { ...result, entries }
}

/**
 * @param {string} filePath
 * @param {number} lineNumber
 * @param {Buffer} line
 * @returns {Record<string, unknown> | undefined}
 */
function parseJsonlObject(filePath, lineNumber, line) {
  try {
    const parsed = JSON.parse(line.toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = /** @type {Record<string, unknown>} */ (parsed)
      return row
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[collectivus] skipping malformed JSONL line ${filePath}:${lineNumber}: ${message}`)
  }
  return undefined
}
