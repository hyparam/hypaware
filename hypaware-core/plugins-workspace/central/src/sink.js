// @ts-check

import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'

import { RETRY_BACKOFF_SECONDS, parseRetryAfter, abortableSleep } from './backoff.js'

/**
 * @import { DatasetRegistration, ExportBatch, ExportOptions, ExportResult, PluginLogger, QueryPartition, QueryRegistry, QueryStorageService, Sink, SinkContinuation } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { SinkWatermarkKey, SinkWatermarkStore } from '../../../../src/core/sinks/types.js'
 * @import { IdentityClient } from './identity_client.js'
 * @import { CentralSinkConfig } from './types.js'
 */

const KNOWN_SIGNALS = new Set(['logs', 'traces', 'metrics', 'proxy'])

// Ceiling on how long one chunk POST will pace itself against the
// server's 429/503 backpressure before giving up inline. We retry the
// SAME chunk (honoring Retry-After) so delivery is correct at any volume
// (pausing whenever the server's byte-rate bucket empties), but bound
// the inline wait so one throttled partition can't wedge a sink tick.
// On exceeding it we throw: the driver respools the partition and the
// next tick resumes, which is cheap because the server dedupes the
// already-delivered prefix (server LLP 0001#idempotency-before-backpressure).
const MAX_BACKPRESSURE_WAIT_MS = 5 * 60_000

// A partition is streamed to the server in bounded chunks so a large
// backlog never materializes in memory (a gateway joining with months
// of cache would otherwise OOM serializing the whole table into one
// NDJSON string). Flush a chunk when either bound trips; both stay far
// under the server's default 64 MB max body.
const MAX_CHUNK_ROWS = 5000
const MAX_CHUNK_BYTES = 4 * 1024 * 1024

// An older server answers the additive registration route with 404/405. Hold
// the dataset locally and probe infrequently so normal client-before-server
// version skew does not create an outbox and warning every sink tick.
const DATASET_REGISTRATION_REPROBE_MS = 5 * 60_000

/**
 * Build the `forward` Sink. The sink's `exportBatch` forwards each
 * driver partition independently. Legacy datasets resolve their fixed ingest
 * signal from `sourceSignal`; eligible open datasets register their schema and
 * ingest under the dataset name. Each partition's rows stream as NDJSON in
 * bounded chunks to `/v1/ingest/{signal}`. One POST carries one signal. Auth
 * comes from the supplied IdentityClient.
 *
 * The kernel's sink driver owns retry-via-outbox; this sink reports
 * `failed` / `retryPartitions` on transport failure and the driver
 * spools the batch for the next tick.
 *
 * @param {{
 *   config: CentralSinkConfig,
 *   identityClient: IdentityClient,
 *   query: QueryRegistry,
 *   storage: QueryStorageService,
 *   watermarks: SinkWatermarkStore,
 *   log: PluginLogger,
 *   fetchFn?: typeof fetch,
 *   sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   nowFn?: () => number,
 * }} args
 * @returns {Sink}
 */
export function createForwardSink(args) {
  const { config, identityClient, query, storage, watermarks, log } = args
  const fetchFn = args.fetchFn ?? fetch
  // Injectable so tests drive backpressure pacing without real waits.
  const sleepFn = args.sleepFn ?? abortableSleep
  const nowFn = args.nowFn ?? Date.now
  const registeredDatasets = new Set()
  // Datasets this sink instance has already reported as ineligible, so a
  // permanent verdict is stated once rather than once per tick forever.
  const withheldDatasets = new Set()
  /** @type {Map<string, Promise<void>>} */
  const datasetRegistrations = new Map()
  /** @type {Map<string, number>} */
  const unsupportedDatasetsUntil = new Map()
  /** @type {Map<string, Promise<SinkContinuation>>} */
  const initialHistoryBaselines = new Map()
  /** @type {Map<string, Promise<number>>} */
  const partitionExports = new Map()

  // Aborts an in-flight backpressure wait when the sink is closed, so a
  // chunk paused on `Retry-After` cannot wedge daemon shutdown.
  const abortController = new AbortController()

  return {
    /**
     * @param {ExportBatch} batch
     * @param {ExportOptions} _opts
     * @returns {Promise<ExportResult>}
     */
    async exportBatch(batch, _opts) {
      if (!Array.isArray(batch?.partitions) || batch.partitions.length === 0) {
        return { status: 'exported', partitionsExported: 0, bytesWritten: 0 }
      }

      let bytesWritten = 0
      let partitionsExported = 0
      /** @type {QueryPartition[]} */
      const retry = []
      /** @type {string | undefined} */
      let firstError

      // Each partition is forwarded independently so one transport
      // failure retries just that partition, matching the driver's
      // partition-granular outbox. Streaming-per-partition (rather than
      // grouping every partition's rows up front) is what keeps memory
      // bounded on a large backlog.
      for (const partition of batch.partitions) {
        // Resolved INSIDE the try: `forwardingTarget` throws for a partition
        // whose dataset the local registry cannot resolve, and a throw that
        // escapes `exportBatch` costs the whole batch (the driver respools
        // every partition, including the ones already POSTed, and reports
        // zero exported). Per-partition isolation is the contract above.
        /** @type {{ ingestName: string, registration?: DatasetRegistration } | undefined} */
        let target
        try {
          const resolved = forwardingTarget(query, partition)
          // A withheld dataset is a settled verdict, not a transport failure: it
          // can never succeed, so routing it through `retry` would write one
          // outbox file per tick forever (the driver writes one on every non-ok
          // result and nothing drains it, src/core/sinks/driver.js persistOutbox)
          // and hold the sink at `partial` for a condition LLP 0305 calls
          // correct. `@hypaware/context-graph` is default-bundled, so on a joined
          // machine that is every tick. Skip the partition, say so once, and
          // leave the batch's health signal honest.
          // @ref LLP 0305#eligibility [implements]: an ineligible dataset is withheld, never announced, never ingested, and never retried
          if ('withheld' in resolved) {
            if (!withheldDatasets.has(partition.dataset)) {
              withheldDatasets.add(partition.dataset)
              const fields = { hyp_dataset: partition.dataset, reason: resolved.withheld }
              if (resolved.level === 'warn') log.warn('central.forward.dataset_withheld', fields)
              else log.info('central.forward.dataset_withheld', fields)
            }
            continue
          }
          target = resolved
          // Scheduled ticks may overlap. Serialize one logical partition so two
          // scans cannot POST the same suffix concurrently or race a later
          // watermark backward over an earlier write.
          // @ref LLP 0040#watermark-contract [constrained-by]: a partition has one ordered ship-then-advance sequence even when daemon ticks overlap.
          const exportKey = partition.tablePath ?? `${partition.dataset}:${JSON.stringify(partition.partition ?? {})}`
          const previous = partitionExports.get(exportKey) ?? Promise.resolve(0)
          const pending = previous.catch(() => 0).then(() => forwardPartition({
            partition, signal: resolved.ingestName, config, identityClient, storage, watermarks, fetchFn, log,
            abortSignal: abortController.signal, sleepFn,
            registration: resolved.registration,
            registeredDatasets,
            datasetRegistrations,
            unsupportedDatasetsUntil,
            nowFn,
            skipInitialHistory: resolved.registration !== undefined,
            initialHistoryBaselines,
          }))
          partitionExports.set(exportKey, pending)
          try {
            bytesWritten += await pending
          } finally {
            if (partitionExports.get(exportKey) === pending) partitionExports.delete(exportKey)
          }
          partitionsExported += 1
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          firstError = firstError ?? message
          retry.push(partition)
          // `forwardPartition` annotates the error with the failing
          // chunk's id and the count that already landed (undefined for
          // pre-stream failures like an unresolvable dataset or a rejected
          // schema registration, which throw before any chunk is built).
          const e = /** @type {{ hyp_batch_id?: string, hyp_chunks_sent?: number }} */ (err ?? {})
          log.warn('central.forward.failed', {
            hyp_sink_signal: target?.ingestName ?? partition.dataset,
            hyp_dataset: partition.dataset,
            message,
            batch_id: e.hyp_batch_id,
            chunks_sent: e.hyp_chunks_sent,
          })
        }
      }

      if (retry.length === 0) {
        return { status: 'exported', partitionsExported, bytesWritten }
      }
      if (partitionsExported === 0) {
        return {
          status: 'failed',
          partitionsExported: 0,
          bytesWritten,
          retryPartitions: retry,
          error: firstError,
        }
      }
      return {
        status: 'partial',
        partitionsExported,
        bytesWritten,
        retryPartitions: retry,
        error: firstError,
      }
    },

    async close() {
      // No background loops to stop here: the config pull loop wraps
      // this sink's close() in index.js, and identity refresh is lazy
      // (every authenticated call refreshes inside the 24h window). The
      // one thing to interrupt is a chunk paused on server backpressure.
      abortController.abort(new Error('central.forward sink closed'))
    },
  }
}

/**
 * Resolve the wire target for a partition. The four legacy signals keep their
 * stable `/v1/ingest/{signal}` paths. Every other eligible dataset uses the
 * open-dataset protocol: announce its schema, then POST under the dataset name
 * so the server's catalog can resolve it. A dataset declaring local-only
 * content columns cannot safely use this raw-row protocol and is withheld, as
 * is one whose name a legacy ingest path has reserved.
 *
 * Throws only for a partition whose dataset the local registry cannot resolve,
 * which is a real and retryable inconsistency. A permanent verdict is RETURNED
 * instead: the caller skips it rather than retrying it forever.
 *
 * @param {QueryRegistry} query
 * @param {QueryPartition} partition
 * @returns {{ ingestName: string, registration?: DatasetRegistration } | { withheld: string, level: 'info' | 'warn' }}
 */
// @ref LLP 0305#routing [implements]: legacy signals keep fixed paths while eligible open datasets register and ingest under their dataset name.
function forwardingTarget(query, partition) {
  const dataset = query.getDataset(partition.dataset)
  if (!dataset) {
    throw new Error(`central.forward: dataset '${partition.dataset}' is not registered locally`)
  }
  const signal = dataset.sourceSignal ?? partition.dataset
  if (KNOWN_SIGNALS.has(signal)) return { ingestName: signal }
  // @ref LLP 0305#eligibility [implements]: fail closed when a dataset declares unprovenanced local-only content that this raw-row protocol cannot suppress.
  // @ref LLP 0105#graph-provenance [constrained-by]: unprovenanced derived content cannot leave through a raw-row export path that has no column-suppression seam.
  if ((dataset.localOnlyContentColumns?.length ?? 0) > 0) {
    // Expected and correct, not a fault: LLP 0305 names this outcome, so it
    // reports at info.
    return { withheld: 'declares local-only content columns', level: 'info' }
  }
  if (KNOWN_SIGNALS.has(partition.dataset)) {
    // A plugin bug rather than a policy outcome, so it reports at warn: the
    // dataset silently forwards nothing until the name is changed.
    return { withheld: 'name is reserved by a legacy ingest path', level: 'warn' }
  }
  return { ingestName: partition.dataset, registration: dataset }
}

/**
 * Stream one partition's rows to `/v1/ingest/{signal}` in bounded
 * chunks, never materializing the whole table. Only rows added since the
 * last durable export are read: the `(sink instance, partition)`
 * watermark is loaded up front and handed to `readRowsSince({ since })`.
 * A newly eligible open dataset first baselines that watermark at the current
 * high-water, while a legacy signal keeps LLP 0040's full first export. A tick
 * with no new rows reads zero rows and sends zero chunks. Each
 * chunk POSTs with an `X-Hyp-Batch-Id` derived from the signal, the
 * partition identity, the chunk's position, and its bytes (see
 * {@link batchIdForChunk}): stable across retries of that exact chunk,
 * yet distinct for any other chunk, so two byte-identical chunks never
 * collide. When the driver re-hands a partition after a transport
 * failure, re-streaming from the same watermark reproduces the same chunk
 * boundaries, so the unchanged prefix chunks hash to the same ids and the
 * server's idempotency ledger (server LLP 0001) acks them `202` without
 * re-storing. The watermark advances ONCE, after the whole partition's chunks
 * are acked (ship first, advance second), to the partition's high-water `after`,
 * never mid-partition. A partial partition (an early chunk acked, a later one
 * failed) therefore never checkpoints, so a crash/failure re-reads the whole
 * partition next tick and the server ledger dedupes the already-acked prefix.
 * Mid-partition advance is unsafe because the scan is NOT seq-ordered (LLP 0040
 * §4 risk #3): `after` is a running max, so a chunk that physically precedes a
 * lower-seq chunk would advance the watermark past rows still un-acked in a
 * later chunk, silently skipping them forever on a between-chunk failure.
 *
 * @param {{
 *   partition: QueryPartition,
 *   signal: string,
 *   config: CentralSinkConfig,
 *   identityClient: IdentityClient,
 *   storage: QueryStorageService,
 *   watermarks: SinkWatermarkStore,
 *   fetchFn: typeof fetch,
 *   log: PluginLogger,
 *   abortSignal: AbortSignal,
 *   sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   registration?: DatasetRegistration,
 *   registeredDatasets: Set<string>,
 *   datasetRegistrations: Map<string, Promise<void>>,
 *   unsupportedDatasetsUntil: Map<string, number>,
 *   nowFn: () => number,
 *   skipInitialHistory: boolean,
 *   initialHistoryBaselines: Map<string, Promise<SinkContinuation>>,
 * }} args
 * @returns {Promise<number>} bytes successfully POSTed for this partition
 */
async function forwardPartition({ partition, signal, config, identityClient, storage, watermarks, fetchFn, log, abortSignal, sleepFn, registration, registeredDatasets, datasetRegistrations, unsupportedDatasetsUntil, nowFn, skipInitialHistory, initialHistoryBaselines }) {
  if (!partition.tablePath || !storage.tableExists(partition.tablePath)) {
    log.warn('central.forward.skip_missing_partition', { hyp_dataset: partition.dataset })
    return 0
  }
  const tablePath = partition.tablePath
  await flushPartition(storage, tablePath, 'sink_export')

  // @ref LLP 0040#watermark-contract [implements]: load the per-(sink instance, partition) watermark so this tick reads only rows added since the last durable export; for a LEGACY signal a missing/unreadable watermark reads from the start (at-least-once + server dedup), never a silent skip. An open dataset takes neither fallback: it baselines only when no watermark was ever written, and fails the partition otherwise (LLP 0305#start-now).
  /** @type {SinkContinuation | undefined} */
  let since
  /** @type {SinkWatermarkKey | undefined} */
  let watermarkKey
  let exportedRowCount = 0
  try {
    watermarkKey = watermarks.keyFor(storage.cacheRoot, tablePath)
    const record = await watermarks.read(watermarkKey)
    if (record) {
      since = record.continuation
      exportedRowCount = record.exportedRowCount
    } else if (skipInitialHistory) {
      const baselineKey = watermarks.filePath(watermarkKey)
      let baseline = initialHistoryBaselines.get(baselineKey)
      if (!baseline) {
        baseline = writeInitialHistoryBaseline({
          partition,
          tablePath,
          storage,
          watermarks,
          watermarkKey,
          baselineKey,
          log,
        }).catch((err) => {
          initialHistoryBaselines.delete(baselineKey)
          throw err
        })
        initialHistoryBaselines.set(baselineKey, baseline)
      }
      since = await baseline
    }
  } catch (err) {
    // A newly eligible open dataset must never turn an initialization failure
    // into the legacy full-scan fallback. Keep the partition retryable until
    // its start-now watermark is durable; otherwise a disk/read error here
    // replays exactly the history LLP 0305 excludes.
    if (skipInitialHistory) {
      log.warn('central.forward.initial_history_baseline_failed', {
        hyp_dataset: partition.dataset,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
    // An underivable key or unreadable watermark must not wedge the sink:
    // fall back to a full scan (the server ledger dedupes the redelivery)
    // and skip watermark writes for this partition this tick.
    watermarkKey = undefined
    since = undefined
    exportedRowCount = 0
    log.warn('central.forward.watermark_read_failed', {
      hyp_dataset: partition.dataset,
      message: err instanceof Error ? err.message : String(err),
    })
  }

  // Establish the local start-now boundary before the remote capability
  // handshake. If registration is temporarily unavailable, rows arriving
  // after this durable baseline remain pending and forward on the retry rather
  // than being absorbed into a later baseline.
  if (registration) {
    const supported = await ensureDatasetRegistered({
      centralUrl: config.url,
      dataset: registration,
      registeredDatasets,
      datasetRegistrations,
      unsupportedDatasetsUntil,
      identityClient,
      fetchFn,
      log,
      nowFn,
    })
    if (!supported) return 0
  }

  let bytesWritten = 0
  let chunkIndex = 0
  // Rows acked across THIS partition's chunks. Accumulated as each chunk POSTs
  // so the single end-of-partition watermark write carries an accurate count.
  let shippedRowCount = 0
  /** @type {string[]} */
  let lines = []
  let pendingBytes = 0
  // `after` token of the most recently buffered row; after the loop it is the
  // partition's high-water `after`, the watermark to persist once every chunk
  // is acked.
  /** @type {SinkContinuation | undefined} */
  let lastAfter
  // The seq this chunk starts AFTER: the `since` watermark for the first
  // chunk, then the previous chunk's last `after` seq. The idempotency key is
  // derived from THIS (not the per-tick `chunkIndex`) so a chunk's id is stable
  // across watermark advances: once an earlier chunk is acked and the watermark
  // moves, a respool re-reads the un-acked suffix from that same watermark, the
  // re-streamed chunk reproduces the same `[startSeq, body]`, and the server
  // ledger dedupes the redelivery. Keying on `chunkIndex` would re-number the
  // suffix from 0 and mint a NEW id for an already-committed-but-unacked chunk,
  // double-storing it on the server.
  let chunkStartSeq = since?.seq ?? '0'

  const flushChunk = async () => {
    if (lines.length === 0) return
    const body = lines.join('\n') + '\n'
    // @ref LLP 0040#applying-it-to-both-sinks [implements]: stable per-chunk batch id keyed by the chunk's start seq, so a post-watermark-advance respool reproduces the same id and the server ledger dedupes.
    const batchId = batchIdForChunk(signal, tablePath, chunkStartSeq, body)
    const bytes = Buffer.byteLength(body, 'utf8')
    const rows = lines.length
    const after = lastAfter
    try {
      await postNdjson({
        centralUrl: config.url, signal, body, batchId, identityClient, fetchFn, log, abortSignal, sleepFn,
        hyp_dataset: partition.dataset, chunkIndex,
      })
    } catch (err) {
      // Annotate so the partition-level failure log (exportBatch) can
      // name the failing chunk and how many already landed: the new
      // chunk loop is otherwise invisible against the server ledger.
      if (err && typeof err === 'object') {
        const e = /** @type {{ hyp_batch_id?: string, hyp_chunks_sent?: number }} */ (err)
        e.hyp_batch_id = batchId
        e.hyp_chunks_sent = chunkIndex
      }
      throw err
    }
    log.debug('central.forward.chunk', {
      hyp_sink_signal: signal,
      hyp_dataset: partition.dataset,
      batch_id: batchId,
      chunk_index: chunkIndex,
      rows,
      bytes,
    })
    bytesWritten += bytes
    chunkIndex += 1
    shippedRowCount += rows
    // The next chunk starts after this chunk's last row, so its batch id keys
    // off this chunk's `after`: keeping ids stable whether a tick streams the
    // whole partition or a respool replays only the un-acked suffix.
    if (after) chunkStartSeq = after.seq
    lines = []
    pendingBytes = 0
  }

  // @ref LLP 0040#storage-api-extension [implements]: pre-upgrade null-seq rows
  // are "new" only on a sink with no durable watermark (export the backlog once);
  // once a watermark exists they are already shipped, so exclude them and the
  // legacy backlog never re-exports every tick (LLP 0040 §6 risk #1).
  const includeLegacy = since === undefined
  // Rows the export seam withheld as `local-only` (LLP 0070): never buffered,
  // never shipped, but each still advances `lastAfter` so the watermark moves
  // across them.
  let droppedRowCount = 0
  for await (const entry of storage.readRowsSince(tablePath, { since, includeLegacy })) {
    // @ref LLP 0070#incremental [constrained-by]: advance the cursor across every
    // entry, including a dropped (withheld) row, so a partition tail of
    // local-only rows checkpoints once and is durably passed (not re-scanned, not
    // re-sent on un-exclusion). Ship-first/advance-second is unchanged: a dropped
    // row is never shipped, so moving past it needs no ack.
    lastAfter = entry.after
    if (entry.dropped) {
      droppedRowCount += 1
      continue
    }
    const line = JSON.stringify(serializeRow(entry.row))
    lines.push(line)
    // Count UTF-8 bytes (not UTF-16 code units) so the budget bounds the
    // actual wire size for multibyte payloads, e.g. CJK `content_text`.
    pendingBytes += Buffer.byteLength(line, 'utf8') + 1
    if (lines.length >= MAX_CHUNK_ROWS || pendingBytes >= MAX_CHUNK_BYTES) {
      await flushChunk()
    }
  }
  await flushChunk()

  // @ref LLP 0040#watermark-contract [implements]: ship first, advance second,
  // but advance ONLY at end-of-partition (like the blob sink). Every chunk is
  // acked by the time we reach here (a failed POST throws out of flushChunk
  // before this), so persisting the partition's high-water `after` can never
  // checkpoint past an un-acked row. A between-chunk failure leaves the
  // watermark untouched: the next tick re-reads the whole partition and the
  // server ledger dedupes the already-acked prefix. Advancing per chunk to the
  // running-max `after` would skip lower-seq rows in a later un-acked chunk
  // whenever the scan is not seq-ordered (LLP 0040 §4 risk #3).
  // @ref LLP 0070#incremental [constrained-by]: widen the gate so a tick that
  // only dropped rows (shipped nothing) still checkpoints: otherwise a partition
  // ending in a run of local-only rows would never advance past them and every
  // tick would re-scan-and-re-drop the same tail forever. `exportedRowCount`
  // still counts only rows actually shipped: a dropped row was never exported.
  if (watermarkKey && lastAfter && (shippedRowCount > 0 || droppedRowCount > 0)) {
    await watermarks.write(watermarkKey, {
      continuation: lastAfter,
      exportedRowCount: exportedRowCount + shippedRowCount,
    })
  }
  if (droppedRowCount > 0) {
    log.debug('central.forward.dropped', {
      hyp_sink_signal: signal,
      hyp_dataset: partition.dataset,
      dropped_row_count: droppedRowCount,
    })
  }
  return bytesWritten
}

/**
 * Start a newly forwardable open dataset at the current high-water instead of
 * replaying its local history. The resolved promise stays in the sink-instance
 * map so overlapping ticks cannot race two baselines and skip rows that arrive
 * between them. Legacy signals keep LLP 0040's full first export unchanged.
 *
 * Refuses when a watermark file is already on disk. `SinkWatermarkStore.read`
 * returns `null` for BOTH "no watermark has ever been written" and "a watermark
 * is there but could not be read or parsed" (src/core/sinks/watermarks.js
 * swallows the read error, and `parseRecord` returns null on a malformed
 * record), so `read()` never throws and the caller's catch cannot tell them
 * apart. Only the first may baseline: treating a corrupt or transiently
 * unreadable watermark as "never forwarded" would jump the cursor to the current
 * high-water and permanently drop every row this sink still owes central,
 * turning LLP 0040's at-least-once degradation into silent at-most-once loss.
 * The refusal throws, so it fails only this partition and the next tick retries.
 *
 * @param {{
 *   partition: QueryPartition,
 *   tablePath: string,
 *   storage: QueryStorageService,
 *   watermarks: SinkWatermarkStore,
 *   watermarkKey: SinkWatermarkKey,
 *   baselineKey: string,
 *   log: PluginLogger,
 * }} args
 * @returns {Promise<SinkContinuation>}
 */
// @ref LLP 0305#start-now [implements]: first support for an open dataset checkpoints existing rows without sending them, then forwards only later seqs; only the genuine absence of a watermark qualifies.
async function writeInitialHistoryBaseline({ partition, tablePath, storage, watermarks, watermarkKey, baselineKey, log }) {
  if (await pathExists(baselineKey)) {
    throw new Error(
      `central.forward: watermark ${baselineKey} for dataset '${partition.dataset}' exists but could not be read; ` +
      'refusing to re-baseline past rows it may still owe'
    )
  }
  /** @type {SinkContinuation} */
  let continuation = { v: 1, seq: '0' }
  let skippedRowCount = 0
  for await (const entry of storage.readRowsSince(tablePath, { includeLegacy: false })) {
    continuation = entry.after
    skippedRowCount += 1
  }
  await watermarks.write(watermarkKey, { continuation, exportedRowCount: 0 })
  log.info('central.forward.initial_history_skipped', {
    hyp_dataset: partition.dataset,
    skipped_row_count: skippedRowCount,
    baseline_seq: continuation.seq,
  })
  return continuation
}

/**
 * True when something is at `filePath`. Used to tell "no watermark yet" from
 * "watermark present but unreadable", a distinction `SinkWatermarkStore.read`
 * collapses into `null`.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Deterministic idempotency key for one chunk. Hashes the signal, the
 * partition identity (`tablePath`), the seq this chunk starts AFTER, and its
 * exact bytes.
 *
 * Keying on `chunkStartSeq` (the watermark the chunk resumes from) rather than a
 * per-tick ordinal is what keeps the id stable across a watermark advance: when
 * an earlier chunk is acked the watermark moves, and a respool re-reads only the
 * un-acked suffix, which reproduces the same `[startSeq, body]` and so the same
 * id, letting the server ledger dedupe a chunk that committed but whose ack was
 * lost. (An ordinal would re-number the suffix from 0 and mint a fresh id for an
 * already-stored chunk, double-storing it.) Two byte-identical chunks at
 * different positions still get distinct ids because a row's `_hyp_ingest_seq`
 * is unique, so their start seqs differ; chunks in different partitions differ
 * on `tablePath`.
 *
 * @param {string} signal
 * @param {string} tablePath
 * @param {string} chunkStartSeq decimal `_hyp_ingest_seq` the chunk starts after
 * @param {string} body
 * @returns {string}
 */
function batchIdForChunk(signal, tablePath, chunkStartSeq, body) {
  return createHash('sha256')
    .update(signal).update('\0')
    .update(tablePath).update('\0')
    .update(chunkStartSeq).update('\0')
    .update(body)
    .digest('hex').slice(0, 32)
}

/**
 * @param {QueryStorageService} storage
 * @param {string} tablePath
 * @param {string} reason
 */
async function flushPartition(storage, tablePath, reason) {
  const extended = /** @type {QueryStorageService & { flushTable?: (tablePath: string, opts?: { reason?: string, force?: boolean }) => Promise<unknown> }} */ (storage)
  if (typeof extended.flushTable === 'function') {
    await extended.flushTable(tablePath, { force: true, reason })
  }
}

/**
 * BigInt and other non-JSON-native values come back from the Iceberg
 * cache as BigInt / Date instances. Convert them to wire-safe types so
 * `JSON.stringify` doesn't throw. The server is expected to coerce on
 * its side per dataset schema.
 *
 * @param {Record<string, unknown>} row
 */
function serializeRow(row) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeValue(value)
  }
  return out
}

/** @param {unknown} value */
function serializeValue(value) {
  if (typeof value === 'bigint') {
    // Numbers <= 2^53-1 are safe; larger BigInts go to string to avoid
    // silent precision loss. The server reads the schema to decide.
    return value <= Number.MAX_SAFE_INTEGER && value >= -Number.MAX_SAFE_INTEGER
      ? Number(value)
      : value.toString()
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(serializeValue)
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const o = {}
    for (const [k, v] of Object.entries(value)) o[k] = serializeValue(v)
    return o
  }
  return value
}

/**
 * POST one NDJSON chunk to `/v1/ingest/{signal}`, carrying its
 * idempotency key as `X-Hyp-Batch-Id`. Re-sends the *same* body + key on
 * two transient conditions, so every retry stays idempotent:
 *
 * - `401`: refresh the JWT once and retry (a second `401` escalates).
 * - `429`/`503`: server backpressure. Honor `Retry-After` (falling back
 *   to the linear ladder when it is absent or garbage), sleep, and retry
 *   the same chunk. This is what makes delivery correct at any volume:
 *   the POST pauses whenever the server's byte-rate bucket empties rather
 *   than failing the partition (proto.md, "Response 429 / 503"). The
 *   inline wait is bounded by {@link MAX_BACKPRESSURE_WAIT_MS}; past it we
 *   throw and let the driver respool (the server dedupes the delivered
 *   prefix, so the next tick resumes cheaply).
 *
 * Any other non-2xx throws: `4xx` poison and other `5xx` are the
 * driver's to classify (outbox respool); narrowing poison-drop is a
 * separate follow-up (hypaware #118).
 *
 * @param {{
 *   centralUrl: string,
 *   signal: string,
 *   body: string,
 *   batchId: string,
 *   identityClient: IdentityClient,
 *   fetchFn: typeof fetch,
 *   log: PluginLogger,
 *   abortSignal: AbortSignal,
 *   sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   hyp_dataset: string,
 *   chunkIndex: number,
 * }} args
 */
async function postNdjson(args) {
  const { centralUrl, signal, body, batchId, identityClient, fetchFn, log, abortSignal, sleepFn, hyp_dataset, chunkIndex } = args
  // Escaped the same way `ensureDatasetRegistered` escapes the registration
  // path: since the open-dataset protocol puts an arbitrary dataset name here
  // (not one of the four fixed signals), the two paths would otherwise be able
  // to name different resources, and `joinUrl`'s `new URL()` would normalize a
  // `..` segment out of the ingest path. The four legacy signals are
  // encode-invariant, so their URLs are byte-identical to before.
  const url = joinUrl(centralUrl, `/v1/ingest/${encodeURIComponent(signal)}`)

  /** @param {string} jwt */
  const send = (jwt) => fetchFn(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/x-ndjson',
      'x-hyp-batch-id': batchId,
    },
    body,
  })

  let refreshed = false
  let waitedMs = 0
  let backpressureRetries = 0
  for (;;) {
    const response = await send(await identityClient.getCurrentJwt())

    if (response.status === 202 || response.ok) return

    // One-shot refresh + retry on the first 401; a second falls through
    // to the throw below as an auth failure (proto.md "Refresh window").
    if (response.status === 401 && !refreshed) {
      refreshed = true
      await identityClient.refresh()
      continue
    }

    // @ref LLP 0014#forward-sink-backpressure [implements]: 429/503 is backpressure, not failure: pace the same chunk in place, bounded inline, respool past budget.
    if (response.status === 429 || response.status === 503) {
      // Honor only a *positive* Retry-After. A legal `Retry-After: 0` or a
      // past HTTP-date parses to 0 (not undefined) and carries no useful
      // pacing: taking it verbatim would retry with zero delay, never
      // advance `waitedMs`, and spin this loop forever. `||` (not `??`)
      // falls a zero through to the ladder, so every wait progresses and
      // the inline budget can bound the retries.
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
      const delaySeconds = retryAfter || RETRY_BACKOFF_SECONDS[
        Math.min(backpressureRetries, RETRY_BACKOFF_SECONDS.length - 1)
      ]
      const delayMs = delaySeconds * 1000
      if (waitedMs + delayMs > MAX_BACKPRESSURE_WAIT_MS) {
        const detail = await readErrorDetail(response)
        throw new Error(`central.forward POST ${url} backpressure exceeded ${MAX_BACKPRESSURE_WAIT_MS / 1000}s inline: ${detail}`)
      }
      log.debug('central.forward.backpressure', {
        hyp_sink_signal: signal,
        hyp_dataset,
        batch_id: batchId,
        chunk_index: chunkIndex,
        http_status: response.status,
        retry_after_seconds: delaySeconds,
        retry: backpressureRetries + 1,
      })
      // Release the throttle response before parking: undici keeps the
      // socket out of the pool until the body is read or cancelled, so a
      // multi-minute pause (and every retry that piles up) would
      // otherwise pin it.
      await discardBody(response)
      await sleepFn(delayMs, abortSignal)
      waitedMs += delayMs
      backpressureRetries += 1
      continue
    }

    const detail = await readErrorDetail(response)
    throw new Error(`central.forward POST ${url} failed: ${detail}`)
  }
}

/**
 * Announce one non-legacy dataset before its first ingest on this sink
 * instance. Registration is idempotent server-side, so a daemon restart may
 * announce it again. A 401 refreshes once through the same identity seam as
 * ingest; any other failure leaves the partition retryable in the outbox.
 *
 * @param {{
 *   centralUrl: string,
 *   dataset: DatasetRegistration,
 *   registeredDatasets: Set<string>,
 *   datasetRegistrations: Map<string, Promise<void>>,
 *   unsupportedDatasetsUntil: Map<string, number>,
 *   identityClient: IdentityClient,
 *   fetchFn: typeof fetch,
 *   log: PluginLogger,
 *   nowFn: () => number,
 * }} args
 * @returns {Promise<boolean>}
 */
async function ensureDatasetRegistered(args) {
  const { centralUrl, dataset, registeredDatasets, datasetRegistrations, unsupportedDatasetsUntil, identityClient, fetchFn, log, nowFn } = args
  if (registeredDatasets.has(dataset.name)) return true
  if ((unsupportedDatasetsUntil.get(dataset.name) ?? 0) > nowFn()) return false

  let pending = datasetRegistrations.get(dataset.name)
  if (!pending) {
    pending = registerDataset({
      centralUrl,
      dataset,
      registeredDatasets,
      unsupportedDatasetsUntil,
      identityClient,
      fetchFn,
      log,
      nowFn,
    })
      .catch((err) => {
        datasetRegistrations.delete(dataset.name)
        throw err
      })
    datasetRegistrations.set(dataset.name, pending)
  }
  await pending
  const supported = registeredDatasets.has(dataset.name)
  if (!supported && datasetRegistrations.get(dataset.name) === pending) {
    datasetRegistrations.delete(dataset.name)
  }
  return supported
}

/**
 * @param {{
 *   centralUrl: string,
 *   dataset: DatasetRegistration,
 *   registeredDatasets: Set<string>,
 *   unsupportedDatasetsUntil: Map<string, number>,
 *   identityClient: IdentityClient,
 *   fetchFn: typeof fetch,
 *   log: PluginLogger,
 *   nowFn: () => number,
 * }} args
 */
async function registerDataset(args) {
  const { centralUrl, dataset, registeredDatasets, unsupportedDatasetsUntil, identityClient, fetchFn, log, nowFn } = args

  const body = {
    schema: dataset.schema,
    ...(dataset.sourceSignal ? { sourceSignal: dataset.sourceSignal } : {}),
    ...(dataset.primaryTimestampColumn
      ? { primaryTimestampColumn: dataset.primaryTimestampColumn }
      : {}),
  }
  const url = joinUrl(centralUrl, `/v1/datasets/${encodeURIComponent(dataset.name)}`)
  const send = (jwt) => fetchFn(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  let response = await send(await identityClient.getCurrentJwt())
  if (response.status === 401) {
    await discardBody(response)
    await identityClient.refresh()
    response = await send(await identityClient.getCurrentJwt())
  }
  if (response.status === 404 || response.status === 405) {
    await discardBody(response)
    unsupportedDatasetsUntil.set(dataset.name, nowFn() + DATASET_REGISTRATION_REPROBE_MS)
    log.warn('central.forward.dataset_unsupported', {
      hyp_dataset: dataset.name,
      http_status: response.status,
      reprobe_after_ms: DATASET_REGISTRATION_REPROBE_MS,
    })
    return
  }
  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(`central.forward PUT ${url} failed: ${detail}`)
  }
  unsupportedDatasetsUntil.delete(dataset.name)
  registeredDatasets.add(dataset.name)
  log.info('central.forward.dataset_registered', {
    hyp_dataset: dataset.name,
    hyp_sink_signal: dataset.sourceSignal ?? dataset.name,
  })
}

/**
 * @param {string} base
 * @param {string} suffix
 */
function joinUrl(base, suffix) {
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}

/** @param {Response} response */
async function readErrorDetail(response) {
  let body
  try { body = await response.text() } catch { body = '' }
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const error = typeof /** @type {Record<string, unknown>} */ (parsed).error === 'string'
          ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (parsed).error)
          : undefined
        if (error) return `${response.status} ${error}`
      }
    } catch {
      // plain text: fall through
    }
    return `${response.status} ${body.trim().slice(0, 200)}`
  }
  return `${response.status} ${response.statusText || ''}`.trim()
}

/**
 * Discard a response body we will not read (a 429/503 we are about to
 * retry past), so undici returns the socket to the pool. Cancelling is
 * best-effort: a missing or already-settled body is a no-op.
 *
 * @param {Response} response
 */
async function discardBody(response) {
  try { await response.body?.cancel() } catch { /* already settled or no body */ }
}
