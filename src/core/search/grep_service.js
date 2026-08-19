// @ts-check

import fs from 'node:fs'

import { parquetReadObjects } from 'hyparquet'
import { parquetFind } from 'hypgrep'

import { createLocalIcebergIO, urlToPath } from '../cache/iceberg/resolver.js'
import { listLiveDataFiles } from '../cache/iceberg/store.js'
import { datasetForTablePath } from '../cache/paths.js'
import { discoverSpoolTables } from '../cache/spool.js'
import { resolveIcebergDir } from '../cache/storage.js'
import { Attr, getLogger, withSpan } from '../observability/index.js'
import { settlePendingCacheForQuery } from '../query/sql.js'
import {
  callerSeesEverything,
  cwdWithheldFromCaller,
  defaultQueryVisibilityResolver,
  resolveCallerClass,
} from '../query/visibility.js'
import { cellText, compileMatcher, makeSnippet, MAX_MATCH_COLUMNS } from './matcher.js'
import { GREP_DATASET, SCAN_COLUMNS, SEARCHABLE_COLUMNS } from './searchable_columns.js'

/**
 * The local grep-search service: the client half of LLP 0264, mirroring the
 * server's `src/search/grep-search.js` tier for tier. One walk over the
 * cache's live data files, newest message-day first; a file with a hypgrep
 * sidecar is searched through `parquetFind` (the index proposes candidate
 * blocks, the shared matcher confirms), a file without one is brute-scanned
 * under the narrow `SCAN_COLUMNS` projection. Files are processed strictly
 * sequentially, so the request's memory bound is one data file plus its
 * index, never a day's worth. No sidecar anywhere (the tree before T6 of
 * LLP 0265 runs) means every file takes the scan tier: slower, never wrong.
 *
 * Unlike the server there is no cross-tier day exclusion: a client row lives
 * in exactly one data file, and each file is served by exactly one tier, so
 * a row cannot be counted twice by construction.
 *
 * Two client-side row gates the server does not have:
 *
 * - **Purge.** A raw file read does not apply Iceberg position deletes, so
 *   every tier filters rows through the file's committed delete positions
 *   (`listLiveDataFiles`); a purged row can neither match nor surface, even
 *   when a stale sidecar still proposes it (LLP 0104).
 * - **Visibility.** Every surfaced row passes the LLP 0105 lattice check via
 *   the same `cwdWithheldFromCaller` predicate the SQL read path applies.
 *   The check runs AFTER the match predicate, so `localOnly.withheldRows`
 *   counts hits the caller was not allowed to see - the number the verb
 *   renders as actionable guidance - and an out-of-rank row consumes no
 *   result budget.
 *
 * @ref LLP 0264#decision [implements]: the client mirror of the server's two-tier grep, cache scan beside sidecar-indexed files
 * @ref LLP 0264#visibility [implements]: the local scan enforces LLP 0105 with the caller's cwd; --remote inherits the server's own gate instead
 *
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { GrepSearchHit, GrepSearchMatcher, GrepSearchParams, GrepSearchResult } from '../../../src/core/search/types.js'
 * @import { LocalOnlyVisibilityReport, RefreshMode } from '../../../src/core/query/types.js'
 * @import { UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 */

const DATASET = GREP_DATASET

/**
 * Rows between abort checks inside one brute-scanned file. The deadline has
 * to be able to land in the middle of a file, not only between files: a
 * compacted file holds many sessions' rows, and the per-row predicate is
 * where a large scan actually spends its wall clock.
 */
const ABORT_CHECK_ROWS = 256

/**
 * A file whose partition day could not be decoded sorts as newest and is
 * never day-pruned: pruning must prove a file out of the window before
 * skipping it, and walking it early keeps the "newest first" promise
 * conservative rather than wrong.
 */
const UNKNOWN_DAY_SORT_KEY = '￿'

/**
 * Run one grep search over the local cache.
 *
 * `params` is the shared wire shape (`GrepSearchParams`); the rest is the
 * client seam: the storage service for discovery and spool freshness, the
 * LLP 0105 caller identity, and the abort signal. The result extends the
 * shared `GrepSearchResult` with the local-only visibility report, the
 * freshness messages the spool debounce produced, and per-tier file counts
 * so surfaces (and smokes) can prove which path served the answer.
 *
 * @param {GrepSearchParams & {
 *   storage: ExtendedQueryStorageService,
 *   includeLocalOnly?: boolean,
 *   callerCwd?: string | null,
 *   usagePolicyResolver?: UsagePolicyResolver,
 *   refresh?: RefreshMode,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<GrepSearchResult & {
 *   localOnly: LocalOnlyVisibilityReport,
 *   freshnessMessages: string[],
 *   indexedFiles: number,
 *   scannedFiles: number,
 * }>}
 */
export async function executeGrepSearch(args) {
  const { storage, signal } = args
  const limit = args.limit
  // Collect one past the limit: the overflow row is the proof that
  // `truncated` is true, and is never returned.
  const budget = limit + 1
  const matcher = compileMatcher(args.query, args.regex === true)
  const chainPred = compileChainPredicate(args)
  const rowFrom = args.from
  const rowTo = args.to
  /** @param {Record<string, unknown>} row */
  const dayPred = (row) => {
    const day = typeof row.date === 'string' ? row.date.slice(0, 10) : null
    if (day === null) return rowFrom === undefined && rowTo === undefined
    if (rowFrom !== undefined && day < rowFrom) return false
    if (rowTo !== undefined && day > rowTo) return false
    return true
  }
  /** @param {Record<string, unknown>} row */
  const accept = (row) => chainPred(row) && dayPred(row) && matcher.rowTest(row)

  /** @type {LocalOnlyVisibilityReport} */
  const localOnly = { callerClass: 'unknown', filtered: false, withheldRows: 0, suppressedRows: 0 }
  /** @type {((row: Record<string, unknown>) => boolean) | null} */
  let withheld = null
  if (args.includeLocalOnly !== true) {
    const resolver = args.usagePolicyResolver ?? defaultQueryVisibilityResolver(storage)
    const { callerClass, callerRank } = resolveCallerClass(resolver, args.callerCwd)
    localOnly.callerClass = callerClass
    if (!callerSeesEverything(callerRank)) {
      localOnly.filtered = true
      withheld = (row) => cwdWithheldFromCaller(resolver, callerRank, row.cwd)
    }
  }

  return withSpan(
    'query.grep_search',
    {
      [Attr.COMPONENT]: 'query',
      [Attr.OPERATION]: 'query.grep_search',
      [Attr.DATASET]: DATASET,
      // The pattern itself is user search text and may name a secret;
      // record its shape, never its content.
      query_length: args.query.length,
      regex_mode: args.regex === true,
      status: 'ok',
    },
    async (span) => {
      // The settle list is spool tables PLUS committed partitions: the
      // gateway's live rows spool under a label table (proxy_messages_v5)
      // that has no cursor until its first flush, so partition discovery
      // alone would never flush - and never find - a row captured seconds
      // ago. The SQL seam reaches those tables through the dataset's own
      // discoverParts; this service enumerates them from the spool itself
      // to the same effect.
      /** @type {{ tablePath: string }[]} */
      const settleTargets = []
      try {
        for (const tablePath of await discoverSpoolTables(storage.cacheRoot)) {
          if (datasetForTablePath(storage.cacheRoot, tablePath) === DATASET) settleTargets.push({ tablePath })
        }
      } catch {
        // An unreadable spool root means nothing is pending to flush.
      }
      for (const p of await storage.discoverCachePartitions({ datasets: [DATASET] })) {
        settleTargets.push({ tablePath: p.path })
      }
      /** @type {string[]} */
      const freshnessMessages = []
      await settlePendingCacheForQuery({
        partitions: settleTargets,
        storage,
        refresh: args.refresh ?? 'auto',
        messages: freshnessMessages,
      })
      // Re-discover after the flush: a first flush mints the source
      // partition directories the walk below reads (the same re-discovery
      // the dataset's createDataSource performs on the SQL path).
      const partitions = await storage.discoverCachePartitions({ datasets: [DATASET] })

      /** @type {{ filePath: string, day: string | null, deletedPositions: Set<bigint> | undefined }[]} */
      const files = []
      for (const partition of partitions) {
        for (const file of await listLiveDataFiles(resolveIcebergDir(partition.path))) {
          files.push({
            filePath: file.filePath,
            day: toDayString(file.partition.date),
            deletedPositions: file.deletedPositions,
          })
        }
      }
      // Newest message-day first, across every source partition at once, so
      // a truncated answer keeps the newest matches whichever client wrote
      // them (the server's walk order, applied to the client's layout).
      files.sort((a, b) => ((a.day ?? UNKNOWN_DAY_SORT_KEY) < (b.day ?? UNKNOWN_DAY_SORT_KEY) ? 1 : -1))

      const { resolver: io } = await createLocalIcebergIO()
      /** @type {GrepSearchHit[]} */
      const hits = []
      let exhausted = true
      let indexedFiles = 0
      let scannedFiles = 0

      /** @param {{ filePath: string, deletedPositions: Set<bigint> | undefined }} file */
      const searchFile = async (file) => {
        // Sidecar existence IS the index marker, no ledger (LLP 0264
        // #lifecycle): probe the filesystem, then degrade this one file to
        // the scan tier if the read races a delete. Results stay exact
        // either way; only the wall clock changes.
        const sidecarUrl = file.filePath.replace(/\.parquet$/i, '.index.parquet')
        /** @type {Awaited<ReturnType<typeof io.reader>> | null} */
        let indexFile = null
        if (fs.existsSync(urlToPath(sidecarUrl))) {
          try {
            indexFile = await io.reader(sidecarUrl)
          } catch (err) {
            if (/** @type {Error & { code?: string }} */ (err)?.code !== 'ENOENT') throw err
          }
        }
        if (indexFile) {
          // The attempt runs into local buffers and commits only when the
          // index tier finished (or the budget stopped it): a sidecar that
          // turns out to be unreadable mid-read (torn by an external
          // writer; the build's own publish is atomic) must degrade this
          // one file to the scan tier below without double-counting the
          // rows the broken attempt already saw.
          /** @type {GrepSearchHit[]} */
          const found = []
          let withheldHere = 0
          try {
            // No `limit` is passed down: a purged or withheld row is
            // filtered AFTER parquetFind accepts it, so a passed-down limit
            // would count rows this walk then discards and under-return.
            // The generator is simply not pulled past the budget instead.
            const rows = parquetFind({
              query: matcher.hypQuery,
              url: file.filePath,
              indexFile,
              asyncBufferFactory: async ({ url }) => await io.reader(url),
              rowFilter: accept,
              signal,
            })
            for await (const row of rows) {
              if (file.deletedPositions?.has(BigInt(/** @type {number} */ (row.__index__)))) continue
              if (withheld?.(row)) {
                withheldHere += 1
                continue
              }
              found.push(toHit(row, matcher))
              if (hits.length + found.length >= budget) break
            }
            indexedFiles += 1
            localOnly.withheldRows += withheldHere
            hits.push(...found)
            return
          } catch (err) {
            if (isAbort(err)) throw err
            getLogger('query').warn('grep_search.sidecar_unreadable', {
              [Attr.COMPONENT]: 'query',
              error_message: err instanceof Error ? err.message : String(err),
            })
          }
        }
        scannedFiles += 1
        const sourceFile = await io.reader(file.filePath)
        const rows = await parquetReadObjects({ file: sourceFile, columns: SCAN_COLUMNS })
        for (let i = 0; i < rows.length; i++) {
          if (i % ABORT_CHECK_ROWS === 0) signal?.throwIfAborted()
          if (hits.length >= budget) return
          if (file.deletedPositions?.has(BigInt(i))) continue
          const row = rows[i]
          if (!accept(row)) continue
          if (withheld?.(row)) {
            localOnly.withheldRows += 1
            continue
          }
          hits.push(toHit(row, matcher))
        }
      }

      try {
        for (const file of files) {
          signal?.throwIfAborted()
          if (hits.length >= budget) {
            exhausted = false
            break
          }
          if (file.day !== null
            && ((rowFrom !== undefined && file.day < rowFrom) || (rowTo !== undefined && file.day > rowTo))) {
            continue
          }
          await searchFile(file)
        }
      } catch (err) {
        // The caller aborting mid-walk keeps what was found: a partial
        // answer marked not exhausted, never an error.
        if (!isAbort(err)) throw err
        exhausted = false
      }

      const truncated = hits.length > limit
      if (truncated) hits.length = limit
      sortHits(hits)

      span.setAttribute('file_count', files.length)
      span.setAttribute('indexed_file_count', indexedFiles)
      span.setAttribute('scanned_file_count', scannedFiles)
      span.setAttribute('hit_count', hits.length)
      span.setAttribute('truncated', truncated)
      span.setAttribute('caller_usage_class', localOnly.callerClass)
      span.setAttribute('local_only_withheld_rows', localOnly.withheldRows)
      // Counts only, never content or raw paths, matching the SQL seam's
      // `usage_policy.query_withhold` discipline (LLP 0080 #telemetry).
      if (localOnly.withheldRows > 0) {
        getLogger('query').debug('usage_policy.query_withhold', {
          [Attr.COMPONENT]: 'query',
          caller_usage_class: localOnly.callerClass,
          withheld_row_count: localOnly.withheldRows,
          suppressed_row_count: 0,
        })
      }

      return {
        hits,
        truncated,
        exhausted: exhausted && !truncated,
        localOnly,
        freshnessMessages,
        indexedFiles,
        scannedFiles,
      }
    },
    { component: 'query' }
  )
}

/**
 * Newest first: intrinsic day, then creation time, then part id for a
 * stable order within a message. Identical to the server's ordering, so a
 * local answer and a `--remote` answer to the same query read the same.
 *
 * @param {GrepSearchHit[]} hits
 */
function sortHits(hits) {
  hits.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    const at = a.messageCreatedAt ?? ''
    const bt = b.messageCreatedAt ?? ''
    if (at !== bt) return at < bt ? 1 : -1
    return (a.partId ?? '') < (b.partId ?? '') ? 1 : -1
  })
}

/**
 * Project a matched row to the shared hit shape. Matched columns come from
 * the same allowlist the row predicate tested, in the set's order, so the
 * content column leads and a column the predicate could not have matched is
 * never reported. Cells render through `cellText` first, so the JSON column
 * (`tool_args`) that produced a `rowTest` match also produces the matched
 * column and its snippet here rather than being skipped as a non-string.
 *
 * @param {Record<string, unknown>} row
 * @param {GrepSearchMatcher} matcher
 * @returns {GrepSearchHit}
 */
function toHit(row, matcher) {
  /** @type {{ column: string, snippet: string }[]} */
  const matches = []
  for (const column of SEARCHABLE_COLUMNS) {
    const text = cellText(row[column])
    if (text === '' || !matcher.test(text)) continue
    matches.push({ column, snippet: makeSnippet(text, matcher) })
    if (matches.length >= MAX_MATCH_COLUMNS) break
  }
  return {
    date: typeof row.date === 'string' ? row.date.slice(0, 10) : '',
    sessionId: typeof row.session_id === 'string' ? row.session_id : '',
    agentId: stringOrNull(row.agent_id),
    conversationId: stringOrNull(row.conversation_id),
    partId: stringOrNull(row.part_id),
    messageId: stringOrNull(row.message_id),
    messageCreatedAt: stringOrNull(row.message_created_at),
    matches,
  }
}

/**
 * @param {GrepSearchParams} params
 * @returns {(row: Record<string, unknown>) => boolean}
 */
function compileChainPredicate(params) {
  const { sessionId, chainId } = params
  if (sessionId === undefined) return () => true
  return (row) => {
    if (row.session_id !== sessionId) return false
    if (chainId === undefined) return true
    // A chain id names either side of the pair, the same matching rule the
    // server applies (its LLP 0117 locator query).
    return row.agent_id === chainId || row.conversation_id === chainId
  }
}

/** @param {unknown} value */
function stringOrNull(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/** A partition or timestamp value as a YYYY-MM-DD day, however it materializes. */
/** @param {unknown} value */
function toDayString(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10)
  return null
}

/** @param {unknown} err */
function isAbort(err) {
  return err instanceof Error && err.name === 'AbortError'
}
