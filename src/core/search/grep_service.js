// @ts-check

import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet'
import { parquetFind, queryIndex } from 'hypgrep'

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
import { LocalOnlyListUnreadableError } from '../usage-policy/local_only.js'
import { cellText, compileMatcher, GrepQueryError, makeSnippet, MAX_MATCH_COLUMNS } from './matcher.js'
import { GREP_DATASET, SCAN_COLUMNS, SEARCHABLE_COLUMNS, sidecarPathFor } from './searchable_columns.js'

/**
 * The local grep-search service: the client half of LLP 0264, mirroring the
 * server's `src/search/grep-search.js` tier for tier. One walk over the
 * cache's live data files, newest message-day first; a file with a hypgrep
 * sidecar is searched through `parquetFind` (the index proposes candidate
 * blocks, the shared matcher confirms), a file without one is brute-scanned.
 * Both tiers read under the narrow `SCAN_COLUMNS` projection, so the index
 * changes which rows are decoded and never how wide. Files are processed
 * strictly sequentially and each is read one ROW GROUP at a time, over a
 * file-handle-backed `AsyncBuffer` that fetches only the byte ranges the
 * projection needs. Both halves are load-bearing: the row-group split
 * bounds the DECODED rows, and the handle-backed buffer bounds the RAW
 * bytes. The cache's own `resolver.reader` cannot do the second (it is
 * `readFileSync` of the whole file, which would leave a 128 MiB
 * `target_file_bytes` data file resident behind a walk that reads it a row
 * group at a time, and would block the loop for the read).
 *
 * That makes the SCAN tier's bound one row group, decoded and raw. The
 * INDEXED tier's is looser, and it is hypgrep's to set rather than this
 * module's: `parquetFind` wraps whatever buffer it is handed in
 * hyparquet's `cachedAsyncBuffer`, which memoizes every slice for the life
 * of one file's search. Its raw residency is therefore the UNION of the
 * candidate ranges it read, which approaches the projected bytes of the
 * whole file for a query the index cannot prune (a literal shorter than
 * hypgrep's n-gram length prunes to nothing at all). The handle-backed
 * buffer is still strictly better there than the whole-file resident
 * reader it replaced; it just does not make that tier's bound a row group,
 * and claiming it did would be a bound no call path holds. Either way the
 * bound is PER FILE: the walk is sequential and nothing survives a file
 * but the trimmed hit buffer.
 *
 * No sidecar anywhere (the tree before T6 of LLP 0265 runs) means every
 * file takes the scan tier: slower, never wrong.
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
 * @ref LLP 0304#indexed-tier-residency [constrained-by]: hypgrep caches the slices it reads, so the indexed tier's raw bound is the candidate ranges, not one row group
 *
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { GrepSearchHit, GrepSearchMatcher, GrepSearchParams, GrepSearchResult } from '../../../src/core/search/types.js'
 * @import { LocalOnlyVisibilityReport, RefreshMode } from '../../../src/core/query/types.js'
 * @import { UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 * @import { AsyncBuffer, FileMetaData } from 'hyparquet'
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

      const { resolver: io } = await createLocalIcebergIO()
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
       * Ask the sidecar whether this file can hold a match at all, before
       * anything opens the source. Returns the sidecar footer alongside, so
       * the answer costs one index-footer parse rather than two.
       *
       * `parquetFind` runs the same `queryIndex` internally and takes no way
       * to be handed the result, so a file that DOES have candidate blocks
       * decodes its posting bitsets twice. That is CPU over a buffer
       * `io.reader` already made resident, no second read, and it is what
       * buys a PRUNED file a source it never opens.
       *
       * Only a definite "no blocks" shortcuts. Every other outcome, a
       * failure included, falls through to the path below, so an unreadable
       * or poisoned sidecar still degrades exactly where it did before, with
       * the same warning naming both files. This function therefore cannot
       * change an answer; it can only decline to read.
       *
       * @param {Awaited<ReturnType<typeof io.reader>>} indexFile
       * @returns {Promise<{ empty: boolean, indexMetadata: FileMetaData | undefined }>}
       */
      const pruneWithIndex = async (indexFile) => {
        try {
          signal?.throwIfAborted()
          const indexMetadata = await parquetMetadataAsync(indexFile)
          const pruned = await queryIndex({ query: matcher.hypQuery, indexFile, indexMetadata })
          // `undefined` is an empty query, not an empty result: it means the
          // index was never consulted, so it is not a prune.
          return { empty: pruned?.blocks.length === 0, indexMetadata }
        } catch (err) {
          if (isAbort(err, signal)) throw err
          return { empty: false, indexMetadata: undefined }
        }
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
       * @param {FileMetaData | undefined} indexMetadata the sidecar footer
       *   `pruneWithIndex` already parsed, so `parquetFind` does not parse it
       *   a second time
       * @param {string} sidecarUrl
       * @param {AsyncBuffer} sourceFile
       * @param {FileMetaData} sourceMetadata
       * @param {string[]} scanColumns
       * @returns {Promise<boolean>}
       */
      const searchIndexed = async (file, indexFile, indexMetadata, sidecarUrl, sourceFile, sourceMetadata, scanColumns) => {
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
          // `columns` rides through `parquetFind` into its own
          // `parquetReadObjects` call, so the same narrow projection bounds
          // BOTH tiers. Without it the indexed tier decodes every column of
          // every candidate range, `system_text` and `raw_frame` included,
          // and a candidate range is a whole coalesced run of blocks capped
          // only at row-group boundaries: an indexed file could decode more
          // bytes than the brute scan reads for the same file, which is the
          // one cost this tier exists to remove (LLP 0264 #shared, and the
          // 90.8% measurement `SCAN_COLUMNS` cites). Safe because every
          // reader downstream of here - `accept`, the `withheld` predicate's
          // `cwd`, and `toHit`'s locators - names only columns inside the
          // projection. `scanColumns` intersects that shared projection with
          // this file's physical schema because hyparquet >= 1.29 rejects an
          // absent projected name.
          const rows = parquetFind({
            query: matcher.hypQuery,
            url: file.filePath,
            indexFile,
            indexMetadata,
            // The SOURCE data file is handle-backed, so a candidate range
            // fetches the byte ranges its row group needs rather than coming
            // out of a whole-file resident buffer. hypgrep then wraps it in
            // its own
            // `cachedAsyncBuffer`, which holds every slice for the life of
            // this generator, so the residency here is the union of the
            // candidate ranges and NOT one row group: strictly less than
            // the whole file the cache's resident reader would have held,
            // and not the same bound the scan tier below gets. The sidecar
            // is deliberately NOT read this way (see `searchFile`).
            // @ref LLP 0303#memory-bound [implements]: the source is opened per slice rather than read whole
            // @ref LLP 0304#indexed-tier-residency [constrained-by]: hypgrep memoizes the slices, so this tier's raw bound is the candidate ranges
            sourceFile,
            sourceMetadata,
            columns: scanColumns,
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
          // A corrupt machine-local list is the other failure this block can
          // see, because the `withheld` predicate runs inside the loop above:
          // `resolver.resolve` throws `LocalOnlyListUnreadableError`, which
          // the SQL wrapper and `cwdWithheldFromCaller` both let propagate so
          // the read fails loudly rather than resolving to "nothing withheld"
          // (LLP 0080 #fail-safe). Degrading it here would blame a sidecar
          // that is fine, advise deleting it, re-read every candidate file
          // from scratch on the scan tier, and only then raise the identical
          // error. Index state is never a correctness input; this is not
          // index state.
          if (err instanceof LocalOnlyListUnreadableError) throw err
          // Both files are named, because the read that failed spans both:
          // `parquetFind` reads the source data file alongside the sidecar
          // and runs the row filter per row, so a torn source parquet reaches
          // this line too and then fails the rescan below. Deleting the
          // sidecar is the usual remedy and this warning is its only notice
          // (nothing rebuilds one in place), but the line must not claim to
          // have proved which file is at fault.
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
        try {
          // No `existsSync` probe ahead of this: a missing sidecar throws
          // ENOENT from the open, which is the same degrade this catch
          // already performs for every other reader failure, so the probe
          // only added a synchronous stat per data file to an otherwise
          // fully async walk. Degrading on ANY failure, not only the delete
          // race, is the rule: an unreadable sidecar is an unindexed file,
          // and an unindexed file is the scan tier's problem, never the
          // caller's error.
          //
          // The sidecar alone stays on the cache's resident reader. It is
          // the pruning structure, read in many small random ranges by
          // `queryIndex`, and a fraction of the data file it indexes; the
          // 128 MiB file the memory bound is about is the source, and that
          // one is handle-backed on both tiers.
          indexFile = await io.reader(sidecarUrl)
        } catch (err) {
          if (isAbort(err, signal)) throw err
          indexFile = null
        }
        // The sidecar decides before the source is touched. hyparquet >= 1.29
        // rejects a projected column a file does not carry, so `scanColumns`
        // below has to be intersected with THIS file's physical schema, and
        // that needs its footer: which is how opening the source ended up
        // ahead of the index in the first place. For a file the index prunes
        // to nothing that footer read is pure waste, and it is not a cheap
        // waste - `parquetMetadataAsync` slices the last 512 KiB of a file
        // that turned out to have no candidate rows at all. Pruning to
        // nothing is the COMMON case for the selective query this tier exists
        // to make fast, so the projection is computed only once a candidate
        // block has survived.
        //
        // It also keeps those files out of the ENOENT window: a compaction or
        // a purge that unlinks a data file mid-walk cannot fail a query that
        // never needed to read it.
        /** @type {FileMetaData | undefined} */
        let indexMetadata
        if (indexFile) {
          const pruned = await pruneWithIndex(indexFile)
          if (pruned.empty) {
            // Counted for the same reason `searchIndexed` counts: the index
            // served this file WHOLE, and answering "no rows here" out of the
            // sidecar alone is the tier working, not degrading.
            indexedFiles += 1
            return
          }
          indexMetadata = pruned.indexMetadata
        }
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
        // Splitting the DECODE is only half of it: over the cache's own
        // `resolver.reader` every slice comes out of a buffer that
        // `readFileSync` already filled with the whole file, so the raw
        // bytes stayed resident however finely the decode was cut, and the
        // read itself blocked the loop. `asyncBufferFromFile` above reads
        // per slice instead, so the projection's own byte ranges are all
        // that is ever fetched: strictly less IO than the whole file, and
        // none of it synchronous.
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
        // @ref LLP 0264#shared [constrained-by]: both tiers keep the shared narrow projection across physical schema drift
        const scanColumns = SCAN_COLUMNS.filter((column) => physicalColumns.has(column))
        if (indexFile && await searchIndexed(
          file,
          indexFile,
          indexMetadata,
          sidecarUrl,
          sourceFile,
          metadata,
          scanColumns
        )) return
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
        // Counted here, not before the read, so the two tier counters mean
        // the same thing: `indexedFiles` counts a file the indexed tier
        // served WHOLE (its abort path commits its buffer without
        // counting), and an abort mid-scan throws out of the loop above
        // before this line. A counter that included interrupted files on
        // one tier and not the other made the pair unusable for exactly
        // the comparison it exists for.
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
      span.setAttribute('indexed_file_count', indexedFiles)
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
