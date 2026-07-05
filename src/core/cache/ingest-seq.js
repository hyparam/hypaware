// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteJson } from '../util/fs_atomic.js'

/**
 * @import { IngestSeqAllocator } from '../../../src/core/cache/types.js'
 */

/**
 * Cache-global allocator state file. Lives at the cache root (a sibling of
 * `datasets/`, never inside it) so it is invisible to `discoverCachePartitions`
 * / `discoverSpoolTables`, which only ever walk the `datasets/` subtree.
 */
const SEQ_FILE = '_hyp_ingest_seq.json'

/**
 * Default reservation block size. Each block costs one durable
 * write-rename; a crash abandons at most the unused tail of the current
 * block (a harmless gap), so the block can be generous.
 */
export const DEFAULT_SEQ_BLOCK_SIZE = 1024

/**
 * Read the persisted `nextSeq` watermark. The value is stored as a decimal
 * string so the int64 range survives JSON without bigint/precision hazards.
 * Returns `null` when the file is missing or unparseable — the caller then
 * starts from 1 (a fresh cache), which never collides with a previously
 * issued seq because a real cache always has a `nextSeq >= 1` on disk.
 *
 * @param {string} statePath
 * @returns {Promise<bigint | null>}
 */
async function readNextSeq(statePath) {
  try {
    const raw = await fs.readFile(statePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.nextSeq === 'string' && /^\d+$/.test(parsed.nextSeq)) {
      return BigInt(parsed.nextSeq)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Persist the `nextSeq` watermark with atomic write-rename — the same
 * crash-safety idiom as `writeCursor` / `writeProgress`.
 *
 * @param {string} statePath
 * @param {bigint} nextSeq
 */
async function writeNextSeq(statePath, nextSeq) {
  const payload = { v: 1, nextSeq: nextSeq.toString(), updatedAt: new Date().toISOString() }
  // Sole caller reserveBlock() mkdirs cacheRoot first, so skip the per-write mkdir.
  await atomicWriteJson(statePath, payload, { mkdir: false })
}

/**
 * Crash-safe, never-regressing monotonic int64 allocator backing the
 * `_hyp_ingest_seq` column stamped at the `decorateRow` flush chokepoint.
 *
 * **Reserve-before-stamp.** A block of `blockSize` seqs is reserved by
 * durably advancing the persisted `nextSeq` (atomic write-rename) BEFORE any
 * seq in the block is handed to a row. So a crash/resume can only re-enter at
 * or above the persisted watermark: a resumed flush never re-issues a seq
 * `<=` one already stamped (and possibly already exported). Duplicate content
 * across a crash boundary is tolerable (strict `>` watermark + row-id dedup);
 * a *regression* would let a never-exported row slip below an advanced
 * watermark and be skipped forever — which this allocator makes impossible.
 *
 * **Cache-global, not per-partition.** The chokepoint runs in the spool reader
 * before rows are grouped into `source=<...>` destination partitions, and two
 * distinct spool table paths (e.g. live capture vs. `backfill`) can feed the
 * SAME destination partition. A single cache-wide counter therefore guarantees
 * that every partition only ever observes a strictly increasing subsequence of
 * seqs — the property the sink watermark relies on — which a per-partition
 * counter (interleaving two independent sequences into one partition) would
 * break. Gaps between consecutively-appended rows in one partition are fine.
 *
 * Concurrency: in-process calls are serialized through a promise-chain mutex so
 * two concurrent flushes (different `tablePath`s share one allocator) never
 * double-reserve the same block. Cross-process concurrent flush of one cache is
 * not a supported scenario — the daemon owns the cache, matching the existing
 * single-writer write-rename idiom.
 *
 * @ref LLP 0040#seq-allocator [implements] — cache-global never-regressing reserve-before-stamp allocator
 * @param {{ cacheRoot: string, blockSize?: number }} opts
 * @returns {IngestSeqAllocator}
 */
export function createIngestSeqAllocator({ cacheRoot, blockSize = DEFAULT_SEQ_BLOCK_SIZE }) {
  if (!cacheRoot) throw new Error('createIngestSeqAllocator: cacheRoot is required')
  if (!Number.isInteger(blockSize) || blockSize < 1) {
    throw new Error('createIngestSeqAllocator: blockSize must be a positive integer')
  }
  const statePath = path.join(cacheRoot, SEQ_FILE)
  const block = BigInt(blockSize)

  /** Next seq to hand out from the in-memory reservation. */
  let cursor = 0n
  /** Exclusive upper bound of the in-memory reservation. */
  let blockEnd = 0n
  let initialized = false
  /** @type {Promise<unknown>} */
  let mutex = Promise.resolve()

  async function reserveBlock() {
    await fs.mkdir(cacheRoot, { recursive: true })
    const start = (await readNextSeq(statePath)) ?? 1n
    const end = start + block
    // Durable BEFORE any seq in [start, end) is stamped onto a row.
    await writeNextSeq(statePath, end)
    cursor = start
    blockEnd = end
    initialized = true
  }

  /** @returns {Promise<bigint>} */
  async function next() {
    const run = mutex.then(async () => {
      if (!initialized || cursor >= blockEnd) await reserveBlock()
      const seq = cursor
      cursor += 1n
      return seq
    })
    // Keep the chain alive (and serialized) even if a reservation rejects; the
    // failed caller still sees the rejection, and the next call retries.
    mutex = run.then(() => undefined, () => undefined)
    return run
  }

  return { next }
}
