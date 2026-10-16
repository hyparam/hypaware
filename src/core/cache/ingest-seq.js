// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteJson } from '../util/fs_atomic.js'
import { isPartitionMutationBusy, withPartitionMutationLock } from './partition.js'

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
 * How long one reservation waits for another process to let go of the
 * counter. A holder keeps it for one read and one write-rename, so a few
 * short retries cover any live contention; a dead holder is reclaimed by
 * the guard itself on the first retry.
 */
const RESERVE_RETRY_LIMIT = 200
const RESERVE_RETRY_DELAY_MS = 25

/**
 * Read the persisted `nextSeq` watermark. The value is stored as a decimal
 * string so the int64 range survives JSON without bigint/precision hazards.
 * Returns `null` when the file is missing or unparseable: the caller then
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
 * Persist the `nextSeq` watermark with atomic write-rename: the same
 * crash-safety idiom as `writeCursor` / `writeProgress`.
 *
 * @param {string} statePath
 * @param {bigint} nextSeq
 */
async function writeNextSeq(statePath, nextSeq) {
  const payload = { v: 1, nextSeq: nextSeq.toString(), updatedAt: new Date().toISOString() }
  // Sole caller reserve() mkdirs cacheRoot first, so skip the per-write mkdir.
  await atomicWriteJson(statePath, payload, { mkdir: false })
}

/**
 * Crash-safe, never-regressing monotonic int64 allocator backing the
 * `_hyp_ingest_seq` column stamped on every row as it is committed.
 *
 * **Reserve-before-stamp.** A run of `count` seqs is reserved by durably
 * advancing the persisted `nextSeq` (atomic write-rename) BEFORE any seq in
 * the run is handed to a row. So a crash/resume can only re-enter at or above
 * the persisted watermark: a resumed flush never re-issues a seq `<=` one
 * already stamped (and possibly already exported). Duplicate content across a
 * crash boundary is tolerable (strict `>` watermark + row-id dedup); a
 * *regression* would let a never-exported row slip below an advanced
 * watermark and be skipped forever.
 *
 * **Reserved at commit, never ahead of it.** Nothing is held back in memory
 * between reservations: every call reads the counter from disk under a
 * cross-process guard and returns exactly what the caller commits right now.
 * Callers reserve inside the partition mutation guard, so within one
 * partition seqs rise in commit order no matter how many processes flush the
 * cache. The earlier design reserved a block of 1024 per process and handed
 * them out from memory, which put a daemon's rows below the seqs a `hyp
 * query` flush had already committed (and the sink had already forwarded);
 * those rows sat under the watermark for good (issue #2578).
 *
 * **Cache-global, not per-partition.** Two distinct spool table paths (e.g.
 * live capture vs. `backfill`) can feed the SAME destination partition. A
 * single cache-wide counter therefore guarantees that every partition only
 * ever observes a strictly increasing subsequence of seqs, the property the
 * sink watermark relies on, which a per-partition counter (interleaving two
 * independent sequences into one partition) would break. Gaps between
 * consecutively-appended rows in one partition are fine.
 *
 * @ref LLP 0040#seq-allocator [implements]: cache-global never-regressing reserve-before-stamp allocator
 * @ref LLP 0492#reserve-at-commit [implements]: reserved per commit under the partition guard, then the counter guard
 * @ref LLP 0492#contention [implements]: bounded retry on a busy counter, then the chunk waits in the spool
 * @param {{ cacheRoot: string }} opts
 * @returns {IngestSeqAllocator}
 */
export function createIngestSeqAllocator({ cacheRoot }) {
  if (!cacheRoot) throw new Error('createIngestSeqAllocator: cacheRoot is required')
  const statePath = path.join(cacheRoot, SEQ_FILE)

  /** @param {number} count */
  async function reserve(count) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error('IngestSeqAllocator.reserve: count must be a positive integer')
    }
    await fs.mkdir(cacheRoot, { recursive: true })
    // The partition mutation guard is a general cross-process lock with
    // dead-owner recovery; keyed on the counter file it serializes every
    // process's read-modify-write of `nextSeq`. It fails fast on contention,
    // and a holder is gone again within a few milliseconds, so wait briefly
    // rather than send a whole chunk back to the spool for the next tick.
    for (let attempt = 0; ; attempt++) {
      try {
        return await withPartitionMutationLock(statePath, async () => {
          const start = (await readNextSeq(statePath)) ?? 1n
          // Durable BEFORE any seq in [start, start + count) is stamped onto a row.
          await writeNextSeq(statePath, start + BigInt(count))
          return start
        })
      } catch (error) {
        if (!isPartitionMutationBusy(error) || attempt >= RESERVE_RETRY_LIMIT) throw error
        await new Promise(resolve => setTimeout(resolve, RESERVE_RETRY_DELAY_MS))
      }
    }
  }

  return { reserve }
}
