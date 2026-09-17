// @ts-check

import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet'

import { urlToPath } from '../../../../src/core/cache/iceberg/resolver.js'
import { listLiveDataFiles } from '../../../../src/core/cache/iceberg/store.js'
import { datasetForTablePath } from '../../../../src/core/cache/paths.js'
import { discoverSpoolTables } from '../../../../src/core/cache/spool.js'
import { resolveIcebergDir } from '../../../../src/core/cache/storage.js'
import { Attr, getLogger, withSpan } from '../../../../src/core/observability/index.js'
import { settlePendingCacheForQuery } from '../../../../src/core/query/sql.js'
import {
  callerSeesEverything,
  cwdWithheldFromCaller,
  defaultQueryVisibilityResolver,
  resolveCallerClass,
} from '../../../../src/core/query/visibility.js'
import { cellText, compileMatcher, GrepQueryError, makeSnippet, MAX_MATCH_COLUMNS } from '../../../../src/core/search/matcher.js'
import { GREP_DATASET, SCAN_COLUMNS, SEARCHABLE_COLUMNS } from '../../../../src/core/search/searchable_columns.js'

/**
 * Direct local scans over the cache's live files, newest message-day first.
 * Read only SCAN_COLUMNS, one row group at a time through range reads.
 * Keep at most twice the hit budget before trimming in result order.
 * Position deletes and the local-only visibility predicate apply to every
 * row, including files left beside indexes built by an older installation.
 *
 * @ref LLP 0413#scans [implements]: local searches never read or build indexes
 * @ref LLP 0264#visibility [implements]: the local scan preserves the caller's visibility
 *
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { GrepSearchHit, GrepSearchMatcher, GrepSearchParams, GrepSearchResult } from '../../../../src/core/search/types.js'
 * @import { LocalOnlyVisibilityReport, RefreshMode } from '../../../../src/core/query/types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
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
 * freshness messages and scan counts. indexedFiles stays zero for callers
 * that consume the existing local result shape.
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
    throw new GrepQueryError('limit must be a positive integer')
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
        // Scoped to this dataset: the walk recurses into every generation's
        // `data/` directory, so an unscoped one would readdir the traces,
        // logs and metrics trees on every search to find the one dataset
        // grep covers. The dataset name IS the directory name under
        // `datasets/` (`cacheTablePath`), so the filter below is now a
        // cheap re-assertion rather than the thing doing the narrowing.
        for (const tablePath of await discoverSpoolTables(storage.cacheRoot, { datasets: [DATASET] })) {
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

      /** @type {GrepSearchHit[]} */
      const hits = []
      /**
       * Did an abort cut the walk short? This, and not the day-descending
       * early break below, is what `exhausted` reports. The break stops the
       * walk only once it has PROVED that nothing left can enter the answer,
       * so the answer it produced is the answer a full walk would have
       * produced; an abort's is not. Collapsing the two would fire the
       * verb's "results may be incomplete" notice on every ordinary capped
       * search, which is the one place it must not.
       */
      let interrupted = false
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

      /** @param {{ filePath: string, deletedPositions: Set<bigint> | undefined }} file */
      const searchFile = async (file) => {
        const sourceFile = await asyncBufferFromFile(urlToPath(file.filePath))
        // One ROW GROUP at a time, not the whole file. A compacted data
        // file runs to `target_file_bytes` (128 MiB by default) and the
        // projection's bulk column is `content_text`, so materializing it
        // whole decodes hundreds of MB of JS strings before a single row
        // is tested: `hyp query grep` could then exhaust the heap where
        // `hyp query sql` over the same partition does not, because the
        // SQL seam streams (`scanRowsFromTable`). The abort checks below
        // could not fire during that decode either, so the deadline did
        // not bound the step that dominates the wall clock.
        //
        // Splitting the DECODE is only half of it: over a whole-file
        // resident reader every slice comes out of a buffer a single read
        // already filled, so the raw bytes stayed resident however finely
        // the decode was cut, and the read itself blocked the loop.
        // `asyncBufferFromFile` above reads per slice instead, so the
        // projection's own byte ranges are all that is ever fetched:
        // strictly less IO than the whole file, and none of it synchronous.
        //
        // The row group is the unit rather than a fixed row count for a
        // reason: without the offset index hyparquet fetches and decodes a
        // whole column chunk to serve any row inside it, so an arbitrary
        // split would re-decode the same chunk once per slice and cost
        // more than it saved. Group-aligned slices read each chunk exactly
        // once, so the total decode is unchanged and only the peak drops.
        // A single-row-group file therefore reads exactly as it did.
        const metadata = await parquetMetadataAsync(sourceFile)
        const physicalColumns = new Set(parquetSchema(metadata).children.map((child) => child.element.name))
        // @ref LLP 0264#shared [constrained-by]: the scan keeps the shared narrow projection across physical schema drift
        const scanColumns = SCAN_COLUMNS.filter((column) => physicalColumns.has(column))
        let groupStart = 0
        for (const group of metadata.row_groups) {
          const groupRows = Number(group.num_rows)
          if (groupRows <= 0) continue
          signal?.throwIfAborted()
          const rows = await parquetReadObjects({
            file: sourceFile,
            metadata,
            columns: scanColumns,
            rowStart: groupStart,
            rowEnd: groupStart + groupRows,
          })
          for (let i = 0; i < rows.length; i++) {
            if (i % ABORT_CHECK_ROWS === 0) signal?.throwIfAborted()
            // Delete positions are file-absolute, so the group's own
            // offset has to ride the lookup; a group-relative index would
            // resurrect purged rows in every group after the first.
            if (file.deletedPositions?.has(BigInt(groupStart + i))) continue
            const row = rows[i]
            if (!accept(row)) continue
            if (withheld?.(row)) {
              localOnly.withheldRows += 1
              continue
            }
            collect(row)
          }
          groupStart += groupRows
        }
        scannedFiles += 1
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
            // Not an interruption: the proof above is why `exhausted`
            // stays true here. The caller still learns the answer was cut,
            // through `truncated`, which is the fact carrying the advice
            // that can act on it (narrow the window, or raise the limit).
            if (file.day !== null && file.day < hits[hits.length - 1].date) break
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
        interrupted = true
      }

      trimHits()
      const truncated = hits.length > limit
      if (truncated) hits.length = limit

      span.setAttribute('file_count', files.length)
      span.setAttribute('indexed_file_count', 0)
      span.setAttribute('scanned_file_count', scannedFiles)
      span.setAttribute('hit_count', hits.length)
      span.setAttribute('truncated', truncated)
      span.setAttribute('interrupted', interrupted)
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
        // Independent of `truncated`, deliberately. Folding truncation in
        // here (`exhausted && !truncated`) made one field carry two facts
        // the shipped skill doc teaches as separate, and a search that BOTH
        // filled its limit AND aborted mid-walk then reported only "raise
        // --limit": advice that cannot recover the files the walk never
        // reached. An MCP caller reading `exhausted` lost the same
        // distinction.
        // @ref LLP 0303#completeness-signals [implements]: truncation and walk completion are two facts, reported as two
        exhausted: !interrupted,
        localOnly,
        freshnessMessages,
        indexedFiles: 0,
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
    // V8 slices can keep the entire message alive behind a short snippet.
    // Copy only the bounded window; UTF-16 preserves every JS code unit,
    // including lone surrogates that a UTF-8 round trip would replace.
    const snippet = Buffer.from(makeSnippet(text, matcher), 'utf16le').toString('utf16le')
    matches.push({ column, snippet })
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
