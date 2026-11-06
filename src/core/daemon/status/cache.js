// @ts-check

/**
 * Cache facts for `hyp status`: flush failures, the newest client row, the
 * size on disk, and the retention in force.
 *
 * @import { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { CacheFlushFailureReport } from '../../../../src/core/daemon/types.js'
 * @import { Dirent } from 'node:fs'
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { DEFAULT_RETENTION_DAYS } from '../../cache/retention.js'
import { cacheTablePath } from '../../cache/paths.js'
import { resolveIcebergDir } from '../../cache/storage.js'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { urlToPath } from '../../cache/iceberg/resolver.js'
import { listLiveDataFiles, physicalProjection } from '../../cache/iceberg/store.js'
import { AI_GATEWAY_MESSAGES_DATASET } from '../../backfill/scan_util.js'
import { discoverSpoolTables, QUERY_FLUSH_FAILURE_COOLDOWN_MS, readFlushFailure } from '../../cache/spool.js'
import { compareStrings } from '../../util/compare_strings.js'
import { sanitizeLabel } from '../../util/json_util.js'

/**
 * Every table carrying a readable flush-failure stamp, newest failure first,
 * all of them. The eight-line cap is the text renderer's, a terminal
 * legibility bound, and `--json` is the pointer that cap's overflow line
 * names, so the collector must hand over the whole list: each entry is
 * individually bounded (a 120-character label, a 512-character message), the
 * array was always built whole in memory before any cap, and this report is
 * built per invocation and never persisted, so there is no status.json
 * growth to bound and no read-back to re-clamp, which is what forced the
 * maintenance snapshot's cap onto both planes.
 * @ref LLP 0330#count-beside-cap [implements]: the machine plane is uncapped, because it is where the text cap's pointer points
 *
 * `stillCoolingDown` is the difference between "the automatic retry is being
 * held off right now" and "an old failure that nothing has cleared", which
 * reads the same on disk and very differently to an operator.
 *
 * `total` rides beside the list even though it now always equals its length:
 * it shipped as a stable `--json` key, the text plane's overflow arithmetic
 * reads it, and the equality is an invariant a consumer may rely on.
 *
 * @param {string} cacheRoot
 * @param {number} [nowMs]
 * @returns {Promise<{ total: number, failures: CacheFlushFailureReport[] }>}
 */
export async function collectCacheFlushFailures(cacheRoot, nowMs = Date.now()) {
  /** @type {CacheFlushFailureReport[]} */
  const failures = []
  for (const tablePath of await discoverSpoolTables(cacheRoot)) {
    const failure = await readFlushFailure(tablePath)
    if (!failure) continue
    // A path, so cleaned as a name: it is filesystem-sourced and reaches a
    // TTY. Cleaned on the write side and not only on read, the rule
    // LLP 0228#last-tick-only settled for the sibling `dataset`/`partition`
    // labels; a spool path carries partition segments that came off a
    // captured row. The message is not a name - it is the payload the
    // operator asked for, and it is cleaned where the prose is assembled
    // (LLP 0225).
    //
    // Relative always, never `tablePath`: `discoverSpoolTables` only yields
    // directories under `<cacheRoot>/datasets`, so the relative form is at
    // minimum `datasets` and an absolute host path can never reach the
    // label. `sanitizeLabel` returning nothing is the only fallback needed.
    const relative = path.relative(cacheRoot, tablePath)
    failures.push({
      table: sanitizeLabel(relative) ?? 'unknown',
      failedAt: new Date(failure.failedAtMs).toISOString(),
      errorMessage: failure.errorMessage,
      stillCoolingDown: nowMs - failure.failedAtMs < QUERY_FLUSH_FAILURE_COOLDOWN_MS,
    })
  }
  failures.sort((a, b) => compareStrings(b.failedAt, a.failedAt) || compareStrings(a.table, b.table))
  return { total: failures.length, failures }
}

/**
 * The newest `message_created_at` among a client's cached
 * `ai_gateway_messages` rows, or null when it has none.
 *
 * Bounded by the newest date partition: one metadata load and the manifests
 * name the files, only that partition's delete data is read, and only its
 * timestamp column is decoded, one row group at a time. `date` is the UTC day
 * of `message_created_at`, so no older partition can hold a newer row. A raw
 * parquet read applies no deletes, so committed delete positions are skipped
 * here.
 *
 * @param {string} cacheRoot
 * @param {string} clientName
 * @returns {Promise<string | null>}
 */
export async function newestCachedClientRowAt(cacheRoot, clientName) {
  const tableDir = resolveIcebergDir(cacheTablePath(cacheRoot, AI_GATEWAY_MESSAGES_DATASET, [`source=${clientName}`]))
  let newestMs = -Infinity
  for (const file of await listLiveDataFiles(tableDir, { newestBy: 'date' })) {
    const source = await asyncBufferFromFile(urlToPath(file.filePath))
    const { metadata, columns } = await physicalProjection(source, ['message_created_at'])
    if (columns.length === 0) continue
    let start = 0
    for (const group of metadata.row_groups) {
      const end = start + Number(group.num_rows)
      const rows = await parquetReadObjects({ file: source, metadata, columns, rowStart: start, rowEnd: end })
      for (let i = 0; i < rows.length; i++) {
        if (file.deletedPositions?.has(BigInt(start + i))) continue
        const value = rows[i].message_created_at
        const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN
        if (ms > newestMs) newestMs = ms
      }
      start = end
    }
  }
  return Number.isFinite(newestMs) ? new Date(newestMs).toISOString() : null
}

/**
 * @param {string} cacheRoot
 * @returns {Promise<{ totalBytes: number, oldestDate: string|null }>}
 */
export async function measureCacheStats(cacheRoot) {
  /** @type {{ totalBytes: number, oldestMs: number|null }} */
  const acc = { totalBytes: 0, oldestMs: null }
  await walkForStats(cacheRoot, acc)
  const oldestDate = acc.oldestMs === null
    ? null
    : new Date(acc.oldestMs).toISOString().slice(0, 10)
  return { totalBytes: acc.totalBytes, oldestDate }
}

/**
 * @param {string} dir
 * @param {{ totalBytes: number, oldestMs: number|null }} acc
 */
async function walkForStats(dir, acc) {
  /** @type {Dirent[]} */
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkForStats(full, acc)
    } else if (entry.isFile()) {
      const stat = await fsp.stat(full)
      acc.totalBytes += stat.size
      if (acc.oldestMs === null || stat.mtimeMs < acc.oldestMs) acc.oldestMs = stat.mtimeMs
    }
  }
}

/**
 * @param {HypAwareV2Config|null} config
 * @returns {{ days: number, source: 'config'|'default' }}
 */
export function readRetention(config) {
  const days = config?.query?.cache?.retention?.default_days
  if (typeof days === 'number' && Number.isFinite(days) && days >= 0) {
    return { days, source: 'config' }
  }
  return { days: DEFAULT_RETENTION_DAYS, source: 'default' }
}
