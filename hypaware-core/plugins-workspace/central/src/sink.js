// @ts-check

import { createHash } from 'node:crypto'

import { RETRY_BACKOFF_SECONDS, parseRetryAfter, abortableSleep } from './backoff.js'

/**
 * @import { ExportBatch, ExportOptions, ExportResult, PluginLogger, QueryPartition, QueryRegistry, QueryStorageService, Sink, SinkContinuation } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { SinkWatermarkKey, SinkWatermarkStore } from '../../../../src/core/sinks/types.d.ts'
 * @import { IdentityClient } from './identity_client.js'
 * @import { CentralSinkConfig } from './types.d.ts'
 */

const KNOWN_SIGNALS = new Set(['logs', 'traces', 'metrics', 'proxy'])

// Ceiling on how long one chunk POST will pace itself against the
// server's 429/503 backpressure before giving up inline. We retry the
// SAME chunk (honoring Retry-After) so delivery is correct at any volume
// — pausing whenever the server's byte-rate bucket empties — but bound
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

/**
 * Build the `forward` Sink. The sink's `exportBatch` forwards each
 * driver partition independently: it resolves the partition's ingest
 * signal (via the dataset's `sourceSignal`, defaulting to the dataset
 * name), streams the partition's rows as NDJSON in bounded chunks, and
 * POSTs each chunk to `/v1/ingest/{signal}`. One POST carries one
 * signal. Auth comes from the supplied IdentityClient.
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
 * }} args
 * @returns {Sink}
 */
export function createForwardSink(args) {
  const { config, identityClient, query, storage, watermarks, log } = args
  const fetchFn = args.fetchFn ?? fetch
  // Injectable so tests drive backpressure pacing without real waits.
  const sleepFn = args.sleepFn ?? abortableSleep

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
        const signal = signalForPartition(query, partition)
        try {
          bytesWritten += await forwardPartition({
            partition, signal, config, identityClient, storage, watermarks, fetchFn, log,
            abortSignal: abortController.signal, sleepFn,
          })
          partitionsExported += 1
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          firstError = firstError ?? message
          retry.push(partition)
          // `forwardPartition` annotates the error with the failing
          // chunk's id and the count that already landed (undefined for
          // pre-stream failures like an unknown signal).
          const e = /** @type {{ hyp_batch_id?: string, hyp_chunks_sent?: number }} */ (err ?? {})
          log.warn('central.forward.failed', {
            hyp_sink_signal: signal,
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
 * The ingest signal a partition forwards under: each dataset declares
 * its `sourceSignal`, defaulting to the dataset name.
 *
 * @param {QueryRegistry} query
 * @param {QueryPartition} partition
 * @returns {string}
 */
function signalForPartition(query, partition) {
  const dataset = query.getDataset(partition.dataset)
  return dataset?.sourceSignal ?? partition.dataset
}

/**
 * Stream one partition's rows to `/v1/ingest/{signal}` in bounded
 * chunks, never materializing the whole table. Only rows added since the
 * last durable export are read: the `(sink instance, partition)`
 * watermark is loaded up front and handed to `readRowsSince({ since })`,
 * so a tick with no new rows reads zero rows and sends zero chunks. Each
 * chunk POSTs with an `X-Hyp-Batch-Id` derived from the signal, the
 * partition identity, the chunk's position, and its bytes (see
 * {@link batchIdForChunk}): stable across retries of that exact chunk,
 * yet distinct for any other chunk — so two byte-identical chunks never
 * collide. When the driver re-hands a partition after a transport
 * failure, re-streaming from the same watermark reproduces the same chunk
 * boundaries, so the unchanged prefix chunks hash to the same ids and the
 * server's idempotency ledger (server LLP 0001) acks them `202` without
 * re-storing. The watermark advances per acked chunk (ship first, advance
 * second), so the server ledger now only backstops a bounded in-flight
 * suffix instead of the whole partition.
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
 * }} args
 * @returns {Promise<number>} bytes successfully POSTed for this partition
 */
async function forwardPartition({ partition, signal, config, identityClient, storage, watermarks, fetchFn, log, abortSignal, sleepFn }) {
  if (!KNOWN_SIGNALS.has(signal)) {
    throw new Error(`central.forward: unknown signal '${signal}' (expected logs|traces|metrics|proxy)`)
  }
  if (!partition.tablePath || !storage.tableExists(partition.tablePath)) {
    log.warn('central.forward.skip_missing_partition', { hyp_dataset: partition.dataset })
    return 0
  }
  const tablePath = partition.tablePath
  await flushPartition(storage, tablePath, 'sink_export')

  // @ref LLP 0040#watermark-contract [implements] — load the per-(sink instance, partition) watermark so this tick reads only rows added since the last durable export; a missing/unreadable watermark reads from the start (at-least-once + server dedup), never a silent skip.
  /** @type {SinkContinuation | undefined} */
  let since
  /** @type {SinkWatermarkKey | undefined} */
  let watermarkKey
  let exportedRowCount = 0
  try {
    watermarkKey = watermarks.keyFor(storage.cacheRoot, tablePath)
    const record = await watermarks.read(watermarkKey)
    since = record?.continuation
    exportedRowCount = record?.exportedRowCount ?? 0
  } catch (err) {
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

  let bytesWritten = 0
  let chunkIndex = 0
  /** @type {string[]} */
  let lines = []
  let pendingBytes = 0
  // `after` token of the most recently buffered row; at flush time it is
  // the last row in the chunk, the watermark to persist once it is acked.
  /** @type {SinkContinuation | undefined} */
  let lastAfter
  // The seq this chunk starts AFTER — the `since` watermark for the first
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
    // @ref LLP 0040#applying-it-to-both-sinks [implements] — stable per-chunk batch id keyed by the chunk's start seq, so a post-watermark-advance respool reproduces the same id and the server ledger dedupes.
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
      // name the failing chunk and how many already landed — the new
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
    // The next chunk starts after this chunk's last row, so its batch id keys
    // off this chunk's `after` — keeping ids stable whether a tick streams the
    // whole partition or a respool replays only the un-acked suffix.
    if (after) chunkStartSeq = after.seq
    lines = []
    pendingBytes = 0
    // @ref LLP 0040#watermark-contract [implements] — ship first, advance second: the chunk POST is acked, so persist this chunk's last `after`. A crash before this re-sends at most this one chunk next tick; the server ledger dedupes the redelivered prefix.
    if (watermarkKey && after) {
      exportedRowCount += rows
      await watermarks.write(watermarkKey, { continuation: after, exportedRowCount })
    }
  }

  for await (const { row, after } of storage.readRowsSince(tablePath, { since })) {
    const line = JSON.stringify(serializeRow(row))
    lines.push(line)
    lastAfter = after
    // Count UTF-8 bytes (not UTF-16 code units) so the budget bounds the
    // actual wire size for multibyte payloads, e.g. CJK `content_text`.
    pendingBytes += Buffer.byteLength(line, 'utf8') + 1
    if (lines.length >= MAX_CHUNK_ROWS || pendingBytes >= MAX_CHUNK_BYTES) {
      await flushChunk()
    }
  }
  await flushChunk()
  return bytesWritten
}

/**
 * Deterministic idempotency key for one chunk. Hashes the signal, the
 * partition identity (`tablePath`), the seq this chunk starts AFTER, and its
 * exact bytes.
 *
 * Keying on `chunkStartSeq` (the watermark the chunk resumes from) rather than a
 * per-tick ordinal is what keeps the id stable across a watermark advance: when
 * an earlier chunk is acked the watermark moves, and a respool re-reads only the
 * un-acked suffix — which reproduces the same `[startSeq, body]` and so the same
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
 * - `401` — refresh the JWT once and retry (a second `401` escalates).
 * - `429`/`503` — server backpressure. Honor `Retry-After` (falling back
 *   to the linear ladder when it is absent or garbage), sleep, and retry
 *   the same chunk. This is what makes delivery correct at any volume:
 *   the POST pauses whenever the server's byte-rate bucket empties rather
 *   than failing the partition (proto.md, "Response 429 / 503"). The
 *   inline wait is bounded by {@link MAX_BACKPRESSURE_WAIT_MS}; past it we
 *   throw and let the driver respool (the server dedupes the delivered
 *   prefix, so the next tick resumes cheaply).
 *
 * Any other non-2xx throws — `4xx` poison and other `5xx` are the
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
  if (!KNOWN_SIGNALS.has(signal)) {
    throw new Error(`central.forward: unknown signal '${signal}' (expected logs|traces|metrics|proxy)`)
  }
  const url = joinUrl(centralUrl, `/v1/ingest/${signal}`)

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

    // @ref LLP 0014#forward-sink-backpressure [implements] — 429/503 is backpressure, not failure: pace the same chunk in place, bounded inline, respool past budget.
    if (response.status === 429 || response.status === 503) {
      // Honor only a *positive* Retry-After. A legal `Retry-After: 0` or a
      // past HTTP-date parses to 0 (not undefined) and carries no useful
      // pacing — taking it verbatim would retry with zero delay, never
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
      // multi-minute pause — and every retry that piles up — would
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
      // plain text — fall through
    }
    return `${response.status} ${body.trim().slice(0, 200)}`
  }
  return `${response.status} ${response.statusText || ''}`.trim()
}

/**
 * Discard a response body we will not read — a 429/503 we are about to
 * retry past — so undici returns the socket to the pool. Cancelling is
 * best-effort: a missing or already-settled body is a no-op.
 *
 * @param {Response} response
 */
async function discardBody(response) {
  try { await response.body?.cancel() } catch { /* already settled or no body */ }
}
