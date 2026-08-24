// @ts-check

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

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
 * How long an abandoned publish scratch file is left alone before it is
 * reclaimed. The publish is write-then-rename, and the failure path unlinks
 * its own scratch, but a SIGKILL between the two (a shut-down daemon, an OOM
 * kill) leaves an index-sized file behind. Nothing else would ever remove it:
 * the scratch name is outside `.parquet` precisely so it joins no data-file
 * count, which also means `measureDataDir` does not bill its bytes and
 * `hyp cache status` under-reports the partition, and the random token means
 * each crash leaks a NEW file rather than reusing one. So it is swept, but
 * only past a grace window: a build takes seconds, and a second writer over
 * the same cache (the daemon's tick and a hand-run `hyp`) must never have
 * its in-flight scratch pulled out from under it.
 *
 * @ref LLP 0303#scratch-sweep [implements]: nothing else bills or removes an abandoned scratch, so maintenance reclaims it
 */
const SCRATCH_GRACE_MS = 60 * 60 * 1000

/**
 * The data files in this directory, split into indexed, missing, and of the
 * missing, still buildable. A pure directory read and deliberately a
 * SUPERSET of the live file set: a dereferenced file still on disk counts
 * as missing, which at worst costs the pass one metadata load. `null` for
 * an unreadable directory, which is not proof of no work.
 *
 * A path form this function and `urlToPath` spell differently would make
 * the quarantine lookup miss and count the file buildable, which is again
 * the safe direction: the full pass runs and re-derives the same answer.
 *
 * @param {string} dataDir
 * @param {ReturnType<typeof createIndexQuarantine>} quarantine
 * @returns {{ present: number, missing: number, buildable: number } | null}
 */
function scanForBuildable(dataDir, quarantine) {
  /** @type {Set<string>} */
  let names
  try {
    names = new Set(fs.readdirSync(dataDir))
  } catch {
    return null
  }
  const out = { present: 0, missing: 0, buildable: 0 }
  for (const name of names) {
    if (!name.endsWith('.parquet')) continue
    if (name.endsWith('.index.parquet') || name.endsWith('-deletes.parquet')) continue
    if (names.has(sidecarPathFor(name))) {
      out.present += 1
      continue
    }
    out.missing += 1
    if (!quarantine.isQuarantined(path.join(dataDir, name))) out.buildable += 1
  }
  return out
}

/**
 * Remove publish scratch files old enough that no live build can own them.
 * Synchronous and best effort: one directory read, and a scratch that races
 * the unlink is one a crash would have left for the next tick regardless.
 *
 * Deliberately outside `buildSidecarsForTable`, and deliberately gated on
 * nothing. The crash this reclaims after leaves the sidecar UNPUBLISHED, so
 * the next tick rebuilds it and the partition returns to complete coverage
 * well inside the grace window - before the scratch is old enough to sweep.
 * A sweep that ran only when there was a build to do would therefore never
 * run again for that generation, and the leak the grace window was supposed
 * to merely delay would last until the generation retired. The caller runs
 * this on every tick over a table that carries sidecars, whatever its
 * coverage.
 *
 * @ref LLP 0304#scratch-sweep-site [implements]: the sweep has to run on coverage-complete ticks too, because the republished sidecar is what hides the scratch
 * @param {string} tableDir
 * @param {{ warn(msg: string, fields?: object): void }} [log]
 * @returns {void}
 */
export function sweepIndexScratch(tableDir, log) {
  const logger = log ?? getLogger('cache')
  const dataDir = path.join(tableDir, 'data')
  const cutoff = Date.now() - SCRATCH_GRACE_MS
  /** @type {string[]} */
  let names
  try {
    names = fs.readdirSync(dataDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.tmp') || !name.includes('.index.parquet')) continue
    const full = path.join(dataDir, name)
    try {
      if (fs.statSync(full).mtimeMs > cutoff) continue
      fs.rmSync(full, { force: true })
    } catch {
      continue
    }
    logger.warn('grep_index.scratch_swept', {
      [Attr.COMPONENT]: 'cache',
      [Attr.OPERATION]: 'maintenance.grep_index',
      scratch_file: full,
    })
  }
}

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
  const dataDir = path.join(tableDir, 'data')
  // The publish scratch is swept by `sweepIndexScratch`, which the caller
  // runs whether or not this pass has anything to build (see its comment).
  // Ahead of `listLiveDataFiles`, which is a metadata plus manifest load.
  // A file that needs a build is always ON DISK in this directory, so
  // "every missing sidecar is quarantined" can never hide a build the pass
  // would have made, and it is the one answer the caller's coverage gate
  // cannot give: that gate counts files, and a quarantined file keeps
  // coverage permanently short, so without this a single poisoned file
  // bought a metadata load every tick for the life of its generation just
  // to rediscover there was nothing to do.
  //
  // Only the all-quarantined case short-circuits. Complete coverage runs
  // the full pass, because there the metadata load is what makes `present`
  // a count of LIVE files rather than of whatever is still on disk.
  const scan = scanForBuildable(dataDir, quarantine)
  if (scan && scan.missing > 0 && scan.buildable === 0) {
    report.present = scan.present
    report.quarantined = scan.missing
    return report
  }
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
