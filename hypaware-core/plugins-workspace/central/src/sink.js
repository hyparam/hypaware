// @ts-check

import { createHash } from 'node:crypto'

/**
 * @import { ExportBatch, ExportOptions, ExportResult, PluginLogger, QueryPartition, QueryRegistry, QueryStorageService, Sink } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { IdentityClient } from './identity_client.js'
 * @import { CentralSinkConfig } from './types.d.ts'
 */

const KNOWN_SIGNALS = new Set(['logs', 'traces', 'metrics', 'proxy'])

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
 *   log: PluginLogger,
 *   fetchFn?: typeof fetch,
 * }} args
 * @returns {Sink}
 */
export function createForwardSink(args) {
  const { config, identityClient, query, storage, log } = args
  const fetchFn = args.fetchFn ?? fetch

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
            partition, signal, config, identityClient, storage, fetchFn, log,
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
      // (every authenticated call refreshes inside the 24h window).
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
 * chunks, never materializing the whole table. Each chunk POSTs with an
 * `X-Hyp-Batch-Id` derived from the signal, the partition identity, the
 * chunk's position, and its bytes (see {@link batchIdForChunk}): stable
 * across retries of that exact chunk, yet distinct for any other chunk —
 * so two byte-identical chunks never collide. When the driver re-hands a
 * partition after a transport failure, re-streaming reproduces the same
 * chunk boundaries, so the unchanged prefix chunks hash to the same ids
 * and the server's idempotency ledger (server LLP 0001) acks them `202`
 * without re-storing. A partial-then-retried partition thus converges to
 * exactly-once instead of duplicating every already-delivered row.
 *
 * @param {{
 *   partition: QueryPartition,
 *   signal: string,
 *   config: CentralSinkConfig,
 *   identityClient: IdentityClient,
 *   storage: QueryStorageService,
 *   fetchFn: typeof fetch,
 *   log: PluginLogger,
 * }} args
 * @returns {Promise<number>} bytes successfully POSTed for this partition
 */
async function forwardPartition({ partition, signal, config, identityClient, storage, fetchFn, log }) {
  if (!KNOWN_SIGNALS.has(signal)) {
    throw new Error(`central.forward: unknown signal '${signal}' (expected logs|traces|metrics|proxy)`)
  }
  if (!partition.tablePath || !storage.tableExists(partition.tablePath)) {
    log.warn('central.forward.skip_missing_partition', { hyp_dataset: partition.dataset })
    return 0
  }
  const tablePath = partition.tablePath
  await flushPartition(storage, tablePath, 'sink_export')

  let bytesWritten = 0
  let chunkIndex = 0
  /** @type {string[]} */
  let lines = []
  let pendingBytes = 0

  const flushChunk = async () => {
    if (lines.length === 0) return
    const body = lines.join('\n') + '\n'
    const batchId = batchIdForChunk(signal, tablePath, chunkIndex, body)
    const bytes = Buffer.byteLength(body, 'utf8')
    const rows = lines.length
    try {
      await postNdjson({ centralUrl: config.url, signal, body, batchId, identityClient, fetchFn })
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
    lines = []
    pendingBytes = 0
  }

  for await (const row of storage.readRows(tablePath)) {
    const line = JSON.stringify(serializeRow(row))
    lines.push(line)
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
 * partition identity (`tablePath`), the chunk's ordinal position, and
 * its exact bytes. Re-streaming a partition reproduces the same chunk
 * boundaries and order, so a re-sent chunk hashes to the same id (the
 * server dedupes it); two byte-identical chunks at different positions —
 * or in different partitions — get distinct ids and are both stored.
 *
 * @param {string} signal
 * @param {string} tablePath
 * @param {number} chunkIndex
 * @param {string} body
 * @returns {string}
 */
function batchIdForChunk(signal, tablePath, chunkIndex, body) {
  return createHash('sha256')
    .update(signal).update('\0')
    .update(tablePath).update('\0')
    .update(String(chunkIndex)).update('\0')
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
 * idempotency key as `X-Hyp-Batch-Id`. Refreshes the JWT and retries
 * once on 401 (re-sending the same body + key, so the retry stays
 * idempotent); throws on transport errors or non-2xx response.
 *
 * @param {{
 *   centralUrl: string,
 *   signal: string,
 *   body: string,
 *   batchId: string,
 *   identityClient: IdentityClient,
 *   fetchFn: typeof fetch,
 * }} args
 */
async function postNdjson(args) {
  const { centralUrl, signal, body, batchId, identityClient, fetchFn } = args
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

  let response = await send(await identityClient.getCurrentJwt())

  if (response.status === 401) {
    await identityClient.refresh()
    response = await send(await identityClient.getCurrentJwt())
  }

  if (response.status === 202 || response.ok) return

  const detail = await readErrorDetail(response)
  throw new Error(`central.forward POST ${url} failed: ${detail}`)
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
