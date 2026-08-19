// @ts-check

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'

import { urlToPath } from '../cache/iceberg/resolver.js'
import { listLiveDataFiles } from '../cache/iceberg/store.js'
import { getLogger } from '../observability/index.js'
import { createIndexWorker } from './index_worker.js'

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
 * write-then-rename, all or nothing), and the next pass simply rebuilds
 * whatever is missing. A file that cannot be indexed is quarantined after
 * a bounded number of attempts and served by the scan tier forever after:
 * index presence is purely a performance property, never a correctness
 * one.
 */

/**
 * How many failed builds one file may cost before the pass stops
 * attempting it. Three, because the two failure families this counter
 * separates are cheap to tell apart: a transient one (a worker killed by
 * shutdown) clears well inside three passes, while a deterministic one
 * (the file hypgrep cannot index) costs three builds to prove and then
 * costs nothing. The ledger is in-memory and process-lifetime on purpose:
 * a daemon restart is the retry, and a persisted poison list would
 * outlive the bug it recorded.
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
 * The sidecar path beside a data file: hypgrep's own default, which is a
 * contract: any reader with byte access to the cache can search it with
 * the stock hypgrep CLI, no daemon involved. The grep service probes
 * exactly this path.
 *
 * @param {string} dataFilePath
 * @returns {string}
 */
export function sidecarPathFor(dataFilePath) {
  return dataFilePath.replace(/\.parquet$/i, '.index.parquet')
}

/**
 * Build the missing sidecars for one Iceberg table directory, one file at
 * a time (the pass's memory bound is one data file plus its index). Files
 * whose sidecar already exists are skipped by the existence marker;
 * quarantined files are skipped without spending a build. A failure is
 * recorded, logged, and isolated to its file: the rest of the pass runs.
 *
 * @param {{
 *   tableDir: string,
 *   quarantine?: ReturnType<typeof createIndexQuarantine>,
 *   worker?: ReturnType<typeof createIndexWorker>,
 *   log?: { info(msg: string, fields?: object): void, warn(msg: string, fields?: object): void },
 * }} args
 * @returns {Promise<{ built: number, present: number, failed: number, quarantined: number }>}
 */
export async function buildSidecarsForTable({ tableDir, quarantine = processQuarantine, worker, log }) {
  const logger = log ?? getLogger('cache')
  const report = { built: 0, present: 0, failed: 0, quarantined: 0 }
  const files = await listLiveDataFiles(tableDir)
  if (files.length === 0) return report
  const ownWorker = worker ?? createIndexWorker({ log: logger })
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
      try {
        const bytes = await fsPromises.readFile(sourcePath)
        const index = await ownWorker.build(bytes)
        // Publish atomically: rename is the only step that makes the
        // sidecar exist, so a crash mid-write can never leave a partial
        // file that lists as a finished index. The `.tmp` suffix also
        // keeps the in-flight file out of every `*.parquet` count.
        const tmpPath = `${sidecarPath}.tmp`
        await fsPromises.writeFile(tmpPath, index)
        await fsPromises.rename(tmpPath, sidecarPath)
        quarantine.clear(sourcePath)
        report.built += 1
      } catch (err) {
        const { attempts, quarantined } = quarantine.recordFailure(sourcePath)
        report.failed += 1
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('grep_index.build_failed', { attempts, quarantined, error_message: message })
        if (quarantined) {
          logger.warn('grep_index.file_quarantined', { attempts })
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
