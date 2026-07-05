// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { datasetsRoot } from '../cache/paths.js'
import { atomicWriteJson } from '../util/fs_atomic.js'

/**
 * @import { SinkContinuation } from '../../../collectivus-plugin-kernel-types.js'
 * @import { SinkWatermarkKey, SinkWatermarkRecord, SinkWatermarkStore } from '../../../src/core/sinks/types.js'
 */

/**
 * Sub-directory, under a sink plugin's `PluginPaths.stateDir`, that holds the
 * per-`(sink instance, partition)` incremental-read watermarks. The `stateDir`
 * is already scoped to one sink instance, so the instance dimension is implicit
 * in the root; only `<dataset>/<partition-key>` discriminates within it.
 */
const WATERMARKS_DIR = 'watermarks'

const RECORD_VERSION = 1

/**
 * Restrict a path segment to a safe character class so a stray dataset or
 * source name like `foo/../bar` cannot escape the watermarks prefix. Mirrors
 * `format-iceberg/src/state.js`'s `sanitizeSegment` (the design names it as the
 * reference) and, deliberately, keeps `=` / `,` so `source=<source>` partition
 * segments stay legible on disk.
 *
 * @param {string} value
 * @param {string} field
 * @returns {string}
 */
function sanitizeSegment(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`sink-watermark: ${field} must be a non-empty string`)
  }
  const cleaned = value.replace(/[^A-Za-z0-9._=,-]/g, '_')
  if (cleaned.length === 0) {
    throw new Error(`sink-watermark: ${field} sanitized to empty string from '${value}'`)
  }
  return cleaned
}

/**
 * Derive the **stable logical** watermark key for a partition.
 *
 * The key is the partition's logical identity — its directory relative to
 * `<cacheRoot>/datasets/` — NOT the physical `tableDir` inside it. This is the
 * hinge of design constraint (B): retention rewrites the table on the same
 * lineage and compaction swaps in a brand-new `table-<seq>/` directory, but the
 * logical partition directory (`datasets/<dataset>/source=<source>/`) is stable
 * across both, so a watermark keyed by it reads straight through either rewrite.
 * Keying by `tableDir` would reset the watermark on every compaction.
 *
 * The first segment under `datasets/` is the dataset; the remaining segments are
 * the partition path. Each segment is sanitized; the partition segments are
 * re-joined with `/` so the key reconstructs a (possibly nested) on-disk path
 * deterministically. A partition with no segments below the dataset falls back
 * to the `_partition` sentinel so it still gets a single stable file.
 *
 * @ref LLP 0040#watermark-contract [implements] — key by stable logical partition path, never tableDir
 * @param {string} cacheRoot
 * @param {string} tablePath logical partition path (`partition.tablePath`)
 * @returns {SinkWatermarkKey}
 */
export function deriveWatermarkKey(cacheRoot, tablePath) {
  if (!cacheRoot) throw new Error('deriveWatermarkKey: cacheRoot is required')
  if (!tablePath) throw new Error('deriveWatermarkKey: tablePath is required')
  const rel = path.relative(datasetsRoot(cacheRoot), tablePath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `deriveWatermarkKey: tablePath '${tablePath}' is not under the cache datasets root`
    )
  }
  const [dataset, ...rest] = rel.split(path.sep).filter((s) => s.length > 0)
  if (!dataset) {
    throw new Error(`deriveWatermarkKey: tablePath '${tablePath}' has no dataset segment`)
  }
  const partitionSegments = rest.length > 0 ? rest : ['_partition']
  const partitionKey = partitionSegments
    .map((seg) => sanitizeSegment(seg, 'partition-segment'))
    .join('/')
  return { dataset: sanitizeSegment(dataset, 'dataset'), partitionKey }
}

/**
 * Validate a `SinkContinuation` before it is persisted, so a malformed token can
 * never reach disk and silently corrupt a watermark. Same shape the storage
 * read API enforces: `{ v: 1, seq: <decimal string> }`.
 *
 * @param {SinkContinuation} continuation
 * @returns {SinkContinuation}
 */
function validateContinuation(continuation) {
  if (
    !continuation ||
    continuation.v !== 1 ||
    typeof continuation.seq !== 'string' ||
    !/^\d+$/.test(continuation.seq)
  ) {
    throw new Error(
      `sink-watermark: invalid SinkContinuation ${JSON.stringify(continuation)}`
    )
  }
  return { v: 1, seq: continuation.seq }
}

/**
 * Parse a persisted record, returning `null` for anything that is missing,
 * unparseable, or structurally wrong. A `null` read means "no durable
 * watermark", so the sink re-exports from the start of the partition — the safe
 * direction (at-least-once + downstream dedup), never a silent skip. This mirrors
 * the null-seq migration default and `ingest-seq.js`'s tolerant `readNextSeq`.
 *
 * @param {string} raw
 * @returns {SinkWatermarkRecord | null}
 */
function parseRecord(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const continuation = parsed?.continuation
  if (
    !continuation ||
    continuation.v !== 1 ||
    typeof continuation.seq !== 'string' ||
    !/^\d+$/.test(continuation.seq)
  ) {
    return null
  }
  return {
    v: RECORD_VERSION,
    continuation: { v: 1, seq: continuation.seq },
    exportedRowCount:
      typeof parsed.exportedRowCount === 'number' && Number.isFinite(parsed.exportedRowCount)
        ? parsed.exportedRowCount
        : 0,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  }
}

/**
 * A persisted per-`(sink instance, partition)` watermark store.
 *
 * One store instance is scoped to one sink instance via its `stateDir` (the
 * kernel threads `ctx.paths.stateDir` to request sinks and to the blob
 * destination ctx). Files live at:
 *
 *   `<stateDir>/watermarks/<dataset>/<partition-key>.json`
 *   `{ v, continuation: { v, seq }, exportedRowCount, updatedAt }`
 *
 * `write` is atomic write-rename (the `writeCursor` / `writeProgress` /
 * `ingest-seq.js` idiom) so a crash never leaves a torn watermark; the design's
 * **ship/PUT first, advance watermark second** invariant lives in the sink
 * wiring (T4/T5), where a crash between the two re-exports a bounded suffix.
 *
 * @ref LLP 0040#watermark-contract [implements] — persisted per-(sink, partition) watermark, atomic write-rename
 * @param {{ stateDir: string }} opts
 * @returns {SinkWatermarkStore}
 */
export function createSinkWatermarkStore({ stateDir }) {
  if (!stateDir) throw new Error('createSinkWatermarkStore: stateDir is required')
  const root = path.join(stateDir, WATERMARKS_DIR)

  /**
   * @param {SinkWatermarkKey} key
   * @returns {string}
   */
  function filePath(key) {
    const segments = key.partitionKey.split('/').filter((s) => s.length > 0)
    return `${path.join(root, key.dataset, ...segments)}.json`
  }

  return {
    keyFor(cacheRoot, tablePath) {
      return deriveWatermarkKey(cacheRoot, tablePath)
    },

    filePath,

    async read(key) {
      let raw
      try {
        raw = await fs.readFile(filePath(key), 'utf8')
      } catch {
        return null
      }
      return parseRecord(raw)
    },

    async write(key, update) {
      const continuation = validateContinuation(update.continuation)
      /** @type {SinkWatermarkRecord} */
      const record = {
        v: RECORD_VERSION,
        continuation,
        exportedRowCount:
          typeof update.exportedRowCount === 'number' && Number.isFinite(update.exportedRowCount)
            ? update.exportedRowCount
            : 0,
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(filePath(key), record)
      return record
    },
  }
}
