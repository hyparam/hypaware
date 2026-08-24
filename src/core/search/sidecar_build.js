// @ts-check

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'

import { urlToPath } from '../cache/iceberg/resolver.js'
import { listLiveDataFiles } from '../cache/iceberg/store.js'
import { Attr, getLogger } from '../observability/index.js'
import { createIndexWorker } from './index_worker.js'
import { sidecarPathFor } from './searchable_columns.js'

/**
 * The sidecar build pass: give every live data file of a just-compacted
 * table a hypgrep `.index.parquet` beside it, so the grep service's
 * indexed tier serves the partition's history instead of brute-scanning
 * it. Runs at maintenance, after the compaction that finalized the files
 * (LLP 0264 #lifecycle): compaction is the moment a file stops changing,
 * so its index can never go stale against its own rows (purge is handled
 * at read time by position, not by rebuild).
 *
 * Sidecar existence IS the completion marker: there is no ledger to
 * drift, a killed daemon leaves nothing half-claimed (the publish is a
 * write-then-rename, all or nothing), and a pass over a generation
 * rebuilds whatever that generation is missing. A file that cannot be
 * indexed is quarantined after a bounded number of attempts and served by
 * the scan tier: index presence is purely a performance property, never a
 * correctness one.
 *
 * Because existence is the marker, a pass is also resumable: one cut short
 * by `deadlineMs` leaves every sidecar it did publish and the next pass
 * picks up the files it never reached. That is what lets the maintenance
 * caller run this on any generation with missing coverage rather than only
 * behind a committed compaction, and what bounds the tick when a partition
 * carries more unindexed files than one tick's budget can build
 * (LLP 0302 #build-site).
 *
 * A file this pass FAILED on is retried by the next pass, up to the poison
 * bound below, which is the retry the quarantine exists to bound. What no
 * pass ever does is rebuild a sidecar that already exists: a stale index is
 * impossible by construction, because a committed data file never changes
 * its rows.
 *
 * A sidecar also freezes the allowlist it was built over. hypgrep records
 * the indexed columns in the index itself (`hypgrep.text_columns`) and
 * prunes candidate blocks to them, and nothing on the read side compares
 * that stamp against today's `SEARCHABLE_COLUMNS`. So ADDING a column to
 * the allowlist does not reach a file that is already indexed, and under
 * the no-retry lifecycle above it never will while that generation lives:
 * the new column answers on the scan tier and zero on the indexed one,
 * which is the tier disagreement the shared allowlist exists to prevent.
 * Any change to the set (hyparam/hypaware#977 is the first one queued) has
 * to invalidate the existing sidecars, not merely start building new ones.
 * Recorded here rather than left to be rediscovered, in the same spirit as
 * the column note in `searchable_columns.js`.
 *
 * @ref LLP 0264#lifecycle [implements]: sidecar existence is the idempotency marker, no ledger; an unindexed or poisoned file is brute-scanned, so index state is never a correctness input
 */

/**
 * How many failed builds one file may cost before the pass stops
 * attempting it. Three, because the two failure families this counter
 * separates are cheap to tell apart: a transient one (a worker killed by
 * shutdown) clears well inside three passes, while a deterministic one
 * (the file hypgrep cannot index) costs three builds to prove and then
 * costs nothing. The ledger is in-memory and process-lifetime on purpose:
 * a persisted poison list would outlive the bug it recorded. It bites where
 * one path is offered to more than one pass, which is every tick over a
 * generation the maintenance caller keeps revisiting: without it a file
 * hypgrep cannot index would cost a build on every tick for the life of its
 * generation, and its warning would repeat forever in the log.
 */
const MAX_INDEX_ATTEMPTS = 3

/**
 * @param {{ maxAttempts?: number }} [args]
 */
export function createIndexQuarantine({ maxAttempts = MAX_INDEX_ATTEMPTS } = {}) {
  /** @type {Map<string, number>} */
  const failures = new Map()
  return {
    /** @param {string} key */
    isQuarantined(key) {
      return (failures.get(key) ?? 0) >= maxAttempts
    },
    /** @param {string} key */
    recordFailure(key) {
      const attempts = (failures.get(key) ?? 0) + 1
      failures.set(key, attempts)
      return { attempts, quarantined: attempts >= maxAttempts }
    },
    /** @param {string} key */
    clear(key) {
      failures.delete(key)
    },
  }
}

/** The ledger every pass in this process shares unless a caller injects its own (tests do). */
const processQuarantine = createIndexQuarantine()

/**
 * Build the missing sidecars for one Iceberg table directory, one file at
 * a time (the pass's memory bound is one data file plus its index). Files
 * whose sidecar already exists are skipped by the existence marker;
 * quarantined files are skipped without spending a build. A failure is
 * recorded, logged, and isolated to its file: the rest of the pass runs.
 *
 * `deadlineMs` is an absolute `Date.now()` instant the pass stops at,
 * reported as `deferred`. Indexing is seconds of CPU per file and a
 * partition can hold far more unindexed files than one maintenance tick
 * should spend, so an unbounded pass would run the tick's own budget out
 * from under it - the budget's job is to leave the daemon responsive, and a
 * build pass appended after the cutoff undoes exactly that. The first
 * missing file is always attempted, for the reason `maintainCache` always
 * works one partition: a pass that could build nothing on an
 * already-exhausted tick would never index anything on a busy cache.
 *
 * @param {{
 *   tableDir: string,
 *   quarantine?: ReturnType<typeof createIndexQuarantine>,
 *   worker?: ReturnType<typeof createIndexWorker>,
 *   deadlineMs?: number,
 *   log?: { info(msg: string, fields?: object): void, warn(msg: string, fields?: object): void },
 * }} args
 * @returns {Promise<{ built: number, present: number, failed: number, quarantined: number, deferred: number }>}
 * @ref LLP 0302#build-site [implements]: the build pass is budgeted and resumable, so it can run on coverage rather than only behind a compaction
 */
export async function buildSidecarsForTable({ tableDir, quarantine = processQuarantine, worker, deadlineMs, log }) {
  const logger = log ?? getLogger('cache')
  const report = { built: 0, present: 0, failed: 0, quarantined: 0, deferred: 0 }
  const files = await listLiveDataFiles(tableDir)
  if (files.length === 0) return report
  const ownWorker = worker ?? createIndexWorker({ log: logger })
  let attempted = 0
  try {
    for (const file of files) {
      const sourcePath = urlToPath(file.filePath)
      const sidecarPath = sidecarPathFor(sourcePath)
      if (fs.existsSync(sidecarPath)) {
        report.present += 1
        continue
      }
      if (quarantine.isQuarantined(sourcePath)) {
        report.quarantined += 1
        continue
      }
      // Checked after the two cheap skips, so a table whose coverage is
      // already complete costs the same directory walk it always did even
      // on an exhausted tick, and `deferred` counts only files that really
      // still need a build.
      if (attempted > 0 && deadlineMs !== undefined && Date.now() > deadlineMs) {
        report.deferred += 1
        continue
      }
      attempted += 1
      // Publish atomically: rename is the only step that makes the
      // sidecar exist, so a crash mid-write can never leave a partial file
      // that lists as a finished index. The scratch name carries a random
      // token because a fixed `<sidecar>.tmp` is only safe for one writer:
      // the daemon's tick and a hand-run `hyp` sharing a cache would
      // interleave their writes into the same scratch file and then rename
      // the mixture into place as a finished sidecar. It also ends outside
      // `.parquet`, so an in-flight or abandoned file joins no data-file
      // count, and it is removed on the failure path rather than left to
      // wait for the generation's retirement.
      const tmpPath = `${sidecarPath}.${randomUUID()}.tmp`
      try {
        const bytes = await fsPromises.readFile(sourcePath)
        const index = await ownWorker.build(bytes)
        await fsPromises.writeFile(tmpPath, index)
        await fsPromises.rename(tmpPath, sidecarPath)
        quarantine.clear(sourcePath)
        report.built += 1
      } catch (err) {
        await fsPromises.rm(tmpPath, { force: true }).catch(() => {})
        const { attempts, quarantined } = quarantine.recordFailure(sourcePath)
        report.failed += 1
        const message = err instanceof Error ? err.message : String(err)
        // The data file is named on every line: with one warning per failed
        // build and a per-file attempt budget, an operator who cannot tell
        // three retries of one poisoned file from three distinct failures
        // cannot act on either.
        logger.warn('grep_index.build_failed', {
          [Attr.COMPONENT]: 'cache',
          [Attr.OPERATION]: 'maintenance.grep_index',
          data_file: sourcePath,
          attempts,
          quarantined,
          error_message: message,
        })
        if (quarantined) {
          logger.warn('grep_index.file_quarantined', {
            [Attr.COMPONENT]: 'cache',
            [Attr.OPERATION]: 'maintenance.grep_index',
            data_file: sourcePath,
            attempts,
          })
        }
      }
    }
  } finally {
    // A caller-provided worker outlives the pass (the caller owns its
    // lifecycle); one created here is closed with it.
    if (!worker) await ownWorker.close()
  }
  return report
}
