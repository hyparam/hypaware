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
import { GREP_DATASET, SCAN_COLUMNS, SEARCHABLE_COLUMNS, sidecarPathFor } from './searchable_columns.js'

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
  // `limit` is validated here for the same reason the query is: this is the
  // wire shape a serving surface hands straight through, so an unchecked
  // value fails late and wrong instead of up front. An absent limit makes
  // the budget NaN, so the walk never stops and collects every match in the
  // cache; a negative one reaches the result trim and throws a bare
  // `RangeError: Invalid array length` from deep inside the service.
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer')
  }
  // Collect one past the limit: the overflow hit is the proof that
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
      //
      // The two lists OVERLAP by construction: a spool directory sits
      // inside the partition directory the discovery walk also returns, so
      // every already-flushed table appears in both. Deduped here rather
      // than left to `settlePendingCacheForQuery`, which is per-entry and
      // would push the debounced "last write was N minutes ago" staleness
      // line once per copy - the same seconds-old cache reported twice on
      // stderr by grep and once by sql.
      /** @type {Set<string>} */
      const settlePaths = new Set()
      try {
        for (const tablePath of await discoverSpoolTables(storage.cacheRoot)) {
          if (datasetForTablePath(storage.cacheRoot, tablePath) === DATASET) settlePaths.add(tablePath)
        }
      } catch {
        // An unreadable spool root means nothing is pending to flush.
      }
      for (const p of await storage.discoverCachePartitions({ datasets: [DATASET] })) {
        settlePaths.add(p.path)
      }
      const settleTargets = [...settlePaths].map((tablePath) => ({ tablePath }))
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
      // Equal days compare equal, like `sortHits` below: one day is many
      // files, and the early break below reads the walk as strictly
      // day-descending, so a comparator that answered -1 both ways for two
      // same-day files would leave that order to whatever the engine's sort
      // happens to do rather than to the comparator.
      files.sort((a, b) => {
        const ad = a.day ?? UNKNOWN_DAY_SORT_KEY
        const bd = b.day ?? UNKNOWN_DAY_SORT_KEY
        if (ad === bd) return 0
        return ad < bd ? 1 : -1
      })

      const { resolver: io } = await createLocalIcebergIO()
      /** @type {GrepSearchHit[]} */
      const hits = []
      let exhausted = true
      let indexedFiles = 0
      let scannedFiles = 0

      /**
       * Keep the newest `budget` hits and drop the rest. Truncation has to
       * happen in SORT order, never in walk order: rows inside one data file
       * are in write order (LLP 0022 clusters a file by session, so a
       * session's rows run oldest to newest), and one message-day is many
       * files, so cutting the tail of the walk keeps the OLDEST matches of
       * whichever file first filled the budget, the exact opposite of what
       * the limit promises. Trimming is amortized (it runs once the buffer
       * has doubled), so the walk still costs a bounded number of hits
       * rather than one per match in the cache.
       *
       * The same trim runs over the indexed tier's per-file buffer below,
       * for the same reason: a buffer that grew with the file rather than
       * with the budget would give up the memory bound this walk promises,
       * and cutting it in walk order would reintroduce the bug.
       *
       * @param {GrepSearchHit[]} list
       */
      const trimBuffer = (list) => {
        sortHits(list)
        if (list.length > budget) list.length = budget
      }
      const trimHits = () => trimBuffer(hits)
      /** @param {Record<string, unknown>} row */
      const collect = (row) => {
        hits.push(toHit(row, matcher))
        if (hits.length >= budget * 2) trimHits()
      }

      /**
       * Search one file through its sidecar. Returns false when the index
       * proved unusable, which hands that one file to the scan tier below.
       *
       * The existence probe only rules out a missing sidecar. A sidecar
       * that exists but cannot be read (a half-written index from a killed
       * build, a truncation from a full disk, a format the installed
       * hypgrep refuses) throws from inside `parquetFind`, where the footer
       * is parsed and the version checked. Left uncaught, one poisoned
       * sidecar fails every grep over the whole cache, including the
       * partitions the walk never reached, which would make index state a
       * correctness input; LLP 0264 #lifecycle says it never is, so a
       * poisoned file is brute-scanned exactly like an unindexed one.
       *
       * The attempt therefore runs into a local buffer and commits only
       * once the index tier finished. A sidecar can tear mid-read (an
       * external writer; the build's own publish is atomic), and rows
       * already pushed to the shared buffer could not be taken back, so
       * committing as it went would leave the choice between double-counting
       * them on the rescan and failing the whole query. Buffering makes
       * degrading the file a decision this function can still take at any
       * point in the read.
       *
       * An abort is the one failure that commits the buffer instead of
       * discarding it: it ends the walk rather than degrading the file, so
       * there is no rescan to double-count against and the rows the index
       * already produced belong in the partial answer.
       *
       * @param {{ filePath: string, deletedPositions: Set<bigint> | undefined }} file
       * @param {Awaited<ReturnType<typeof io.reader>>} indexFile
       * @param {string} sidecarUrl
       * @returns {Promise<boolean>}
       */
      const searchIndexed = async (file, indexFile, sidecarUrl) => {
        /** @type {GrepSearchHit[]} */
        const found = []
        let withheldHere = 0
        try {
          // No `limit` is passed down, and the generator below is drained
          // rather than broken out of at the budget. Two separate reasons,
          // both correctness: a purged or withheld row is filtered AFTER
          // parquetFind accepts it, so a passed-down limit would count rows
          // this walk then discards and under-return; and rows inside one
          // file arrive in WRITE order, not date order, so stopping at the
          // budget would keep that file's oldest matches rather than its
          // newest. `found` is trimmed in sort order instead, which is what
          // actually bounds the memory here.
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
            if (found.length >= budget * 2) trimBuffer(found)
          }
        } catch (err) {
          if (isAbort(err, signal)) {
            // Commit before the abort propagates. A deadline lands INSIDE a
            // file, not between files (hypgrep checks the signal at every
            // coalesced range boundary), and a newest-first walk makes the
            // interrupted file the newest one the caller most wants, so
            // discarding the buffer would answer zero for exactly that file
            // and lose its withheld-row count out of the report. Safe
            // precisely because an abort ends the walk: this file is never
            // rescanned, so no row can be counted twice. It still does not
            // count as indexed, because it was not served whole.
            for (const hit of found) hits.push(hit)
            localOnly.withheldRows += withheldHere
            throw err
          }
          // Both files are named, because the read that failed spans both:
          // `parquetFind` opens the source data file through the same
          // factory as the sidecar and runs the row filter per row, so a
          // torn source parquet reaches this line too and then fails the
          // rescan below. Deleting the sidecar is the usual remedy and this
          // warning is its only notice (nothing rebuilds one in place), but
          // the line must not claim to have proved which file is at fault.
          getLogger('query').warn('grep_search.indexed_read_failed', {
            [Attr.COMPONENT]: 'query',
            [Attr.OPERATION]: 'query.grep_search',
            sidecar_file: urlToPath(sidecarUrl),
            data_file: urlToPath(file.filePath),
            error_message: err instanceof Error ? err.message : String(err),
          })
          return false
        }
        indexedFiles += 1
        localOnly.withheldRows += withheldHere
        // Appended, not spread: `limit` is validated as a positive safe
        // integer but is not bounded above, so one file may fill a buffer of
        // millions, and a spread of that many arguments is an argument-count
        // overflow, not a push.
        for (const hit of found) hits.push(hit)
        if (hits.length >= budget * 2) trimHits()
        return true
      }

      /** @param {{ filePath: string, deletedPositions: Set<bigint> | undefined }} file */
      const searchFile = async (file) => {
        // Sidecar existence IS the index marker, no ledger (LLP 0264
        // #lifecycle): probe the filesystem, then degrade this one file to
        // the scan tier if the read races a delete. Results stay exact
        // either way; only the wall clock changes.
        const sidecarUrl = sidecarPathFor(file.filePath)
        /** @type {Awaited<ReturnType<typeof io.reader>> | null} */
        let indexFile = null
        if (fs.existsSync(urlToPath(sidecarUrl))) {
          try {
            indexFile = await io.reader(sidecarUrl)
          } catch (err) {
            // Every reader failure degrades, not only the delete race: an
            // unreadable sidecar is an unindexed file, and an unindexed
            // file is the scan tier's, never the caller's error.
            if (isAbort(err, signal)) throw err
            indexFile = null
          }
        }
        if (indexFile && await searchIndexed(file, indexFile, sidecarUrl)) return
        scannedFiles += 1
        const sourceFile = await io.reader(file.filePath)
        const rows = await parquetReadObjects({ file: sourceFile, columns: SCAN_COLUMNS })
        for (let i = 0; i < rows.length; i++) {
          if (i % ABORT_CHECK_ROWS === 0) signal?.throwIfAborted()
          if (file.deletedPositions?.has(BigInt(i))) continue
          const row = rows[i]
          if (!accept(row)) continue
          if (withheld?.(row)) {
            localOnly.withheldRows += 1
            continue
          }
          collect(row)
        }
      }

      try {
        for (const file of files) {
          signal?.throwIfAborted()
          if (hits.length >= budget) {
            trimHits()
            // Files are walked day-descending, so every file still ahead
            // holds rows no newer than this one's day. Once the budget is
            // full of hits strictly newer than that day, nothing left in the
            // walk can displace one and the walk stops. A same-day file (or
            // one whose day would not decode) is still read, because its
            // rows can outrank a kept hit.
            if (file.day !== null && file.day < hits[hits.length - 1].date) {
              exhausted = false
              break
            }
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
        if (!isAbort(err, signal)) throw err
        exhausted = false
      }

      trimHits()
      const truncated = hits.length > limit
      if (truncated) hits.length = limit

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
    const ap = a.partId ?? ''
    const bp = b.partId ?? ''
    // Equal keys compare equal: the walk trims in sort order and so sorts
    // the buffer repeatedly, and a comparator that never returns 0 would
    // reshuffle indistinguishable hits on every pass.
    if (ap === bp) return 0
    return ap < bp ? 1 : -1
  })
}

/**
 * Project a matched row to the shared hit shape. Matched columns come from
 * the same allowlist the row predicate tested, in the set's order, so the
 * content column leads and a column the predicate could not have matched is
 * never reported. Cells render through `cellText` first, the same coercion
 * the row predicate applied, so a row that matched always names at least one
 * matched column here rather than reporting a hit with none.
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
  if (sessionId === undefined && chainId === undefined) return () => true
  return (row) => {
    if (sessionId !== undefined && row.session_id !== sessionId) return false
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

/**
 * Did this error come from the caller's deadline rather than from the walk?
 * `throwIfAborted` rethrows `signal.reason` verbatim, and the natural
 * deadline (`AbortSignal.timeout`) makes that reason a `DOMException` named
 * `TimeoutError`, not `AbortError`, so a name check alone turns the
 * documented "partial answer, marked not exhausted" into a thrown error for
 * the one abort shape the service exists to serve. Identity against the
 * signal's own reason accepts every abort shape, a caller's custom
 * `abort(reason)` included, without swallowing an unrelated failure that
 * happens to race the deadline.
 *
 * @param {unknown} err
 * @param {AbortSignal | undefined} signal
 * @returns {boolean}
 */
function isAbort(err, signal) {
  if (signal?.aborted === true && err === signal.reason) return true
  return err instanceof Error && err.name === 'AbortError'
}
