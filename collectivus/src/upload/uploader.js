import { appendLedger, isCommitted, readLedger } from './ledger.js'
import fs from 'node:fs'
import path from 'node:path'
import { loadClaudeContextLookup, sessionIdsFromExchanges } from '../cli/claude-transcripts.js'
import { messageRowsToParquet } from '../cli/messages-parquet.js'
import { walkExchanges } from '../cli/messages-walker.js'
import { reconstructAssistantMessage } from '../cli/stream-reconstruct.js'
import { rowsToParquet } from './parquet.js'
import { iterExchangesWithStreamEvents, readPartitionRows, walkPartitionFiles } from './reader.js'

/**
 * @import { LedgerEntry, ResolvedUploadOptions, StorageConnector, UploadDeps, UploadJob, UploadResult } from './upload.d.ts'
 */

const SIGNALS = /** @type {const} */ (['logs', 'traces', 'metrics', 'proxy'])
const DATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_INITIAL_BACKOFF_MS = 1000

/**
 * Find every JSONL file under `outputDir` whose date is older than
 * `today` (UTC) and within the catch-up window, filtered to the
 * configured signal allowlist.
 *
 * Walks `<outputDir>/<dim1>/<dim2>/.../<date>.jsonl`, where each
 * directory level corresponds to one entry in `options.partitionDimensions`
 * and the leaf filename is the plain UTC date. Standalone and server modes
 * both use `['gateway_id', 'signal']` to match the layout written by the
 * standalone Collector and the server's NDJSON ingest endpoint.
 *
 * @param {string} outputDir
 * @param {string} today YYYY-MM-DD UTC
 * @param {ResolvedUploadOptions} options
 * @returns {UploadJob[]}
 */
export function discoverJobs(outputDir, today, options) {
  const allowedSignals = new Set(options.signals)
  const minDate = subtractDays(today, options.catchupDays)
  const dimensions = options.partitionDimensions ?? ['gateway_id', 'signal']

  /** @type {UploadJob[]} */
  const jobs = []
  for (const file of walkPartitionFiles(outputDir, dimensions)) {
    if (!allowedSignals.has(file.signal)) continue
    if (file.date >= today) continue
    if (file.date < minDate) continue
    // First-dimension value is the per-job identifier kept under
    // `service` so the ledger key, object key, and log lines built
    // around `(service, signal, date)` remain unique per file.
    const primary = file.partition[dimensions[0]]
    jobs.push({
      service: primary,
      signal: file.signal,
      date: file.date,
      jsonlPath: file.filePath,
      partition: file.partition,
    })
  }
  jobs.sort(jobCompare)
  return jobs
}

/**
 * Upload one (service, signal, date) JSONL file as a Parquet object.
 * Idempotent: skips if the ledger or a HEAD on the destination shows the
 * upload already happened. Connector calls are retried with exponential
 * backoff on transient failures (network errors, 5xx, 429).
 *
 * @param {UploadJob} job
 * @param {ResolvedUploadOptions} options
 * @param {StorageConnector} connector
 * @param {string} outputDir
 * @param {Set<string>} committed In-memory ledger snapshot (mutated on success).
 * @param {UploaderDeps} [deps]
 * @returns {Promise<{ uploaded: boolean, key: string, rows: number, size: number }>}
 */
export async function uploadJob(job, options, connector, outputDir, committed, deps = {}) {
  const key = objectKey(options.prefix, job)
  const resolved = resolveDeps(deps)

  if (isCommitted(committed, job.service, job.signal, job.date)) {
    return { uploaded: false, key, rows: 0, size: 0 }
  }

  // Fallback existence check protects us if the ledger was lost.
  const head = await withRetry(() => connector.headObject(key), resolved)
  if (head !== undefined) {
    /** @type {LedgerEntry} */
    const entry = {
      service: job.service,
      signal: job.signal,
      date: job.date,
      status: 'committed',
      key,
      size: head.size,
      rows: 0,
      committedAt: new Date().toISOString(),
    }
    appendLedger(outputDir, entry)
    committed.add(`${job.service} ${job.signal} ${job.date}`)
    return { uploaded: false, key, rows: 0, size: head.size }
  }

  const { rows: rowCount, parquet } = job.signal === 'proxy'
    ? await proxyJobToParquet(job, deps.claudeContextLookup)
    : await otlpJobToParquet(job, options)
  if (rowCount === 0) return { uploaded: false, key, rows: 0, size: 0 }

  await withRetry(() => connector.putObject(key, parquet, 'application/octet-stream'), resolved)

  /** @type {LedgerEntry} */
  const entry = {
    service: job.service,
    signal: job.signal,
    date: job.date,
    status: 'committed',
    key,
    size: parquet.byteLength,
    rows: rowCount,
    committedAt: new Date().toISOString(),
  }
  appendLedger(outputDir, entry)
  committed.add(`${job.service} ${job.signal} ${job.date}`)

  return { uploaded: true, key, rows: rowCount, size: parquet.byteLength }
}

/**
 * Upload every eligible job, used both by the daily timer and by
 * startup catch-up. Each job's connector calls are retried with
 * backoff; per-job failures (exhausted retries, permanent 4xx,
 * malformed JSONL, etc.) are logged and isolated so one bad file does
 * not abort the whole run, and the next tick will try again.
 *
 * @param {ResolvedUploadOptions} options
 * @param {StorageConnector} connector
 * @param {string} outputDir
 * @param {string} today YYYY-MM-DD UTC
 * @param {UploaderDeps} [deps]
 * @returns {Promise<UploadResult[]>}
 */
export async function uploadPending(options, connector, outputDir, today, deps = {}) {
  const committed = readLedger(outputDir)
  const jobs = discoverJobs(outputDir, today, options)
  const claudeContextLookup = deps.claudeContextLookup
  /** @type {UploadResult[]} */
  const results = []
  for (const job of jobs) {
    try {
      const result = await uploadJob(job, options, connector, outputDir, committed, { ...deps, claudeContextLookup })
      results.push({ job, ...result })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      console.error(`[collectivus] upload failed for ${job.service}/${job.signal}/${job.date}: ${error.message}`)
      const retryable = /** @type {{ transient?: unknown }} */ (error).transient === true
      results.push({ job, uploaded: false, key: '', rows: 0, size: 0, error, retryable })
    }
  }
  return results
}

/**
 * @param {UploadJob} job
 * @param {ResolvedUploadOptions} options
 * @returns {Promise<{ rows: number, parquet: Uint8Array }>}
 */
async function otlpJobToParquet(job, options) {
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for await (const row of readPartitionRows(job.jsonlPath, job.partition)) {
    rows.push(row)
  }
  if (rows.length === 0) return { rows: 0, parquet: new Uint8Array() }
  const parquet = await rowsToParquet(/** @type {import('./upload.d.ts').Signal} */ (job.signal), rows, options.partitionDimensions)
  return { rows: rows.length, parquet }
}

/**
 * @param {UploadJob} job
 * @param {ClaudeContextLookup | undefined} contextLookup
 * @returns {Promise<{ rows: number, parquet: Uint8Array }>}
 */
async function proxyJobToParquet(job, contextLookup) {
  const gatewayId = job.partition.gateway_id ?? job.service
  const currentBundles = await iterExchangesWithStreamEvents(job.jsonlPath)
  const exchanges = currentBundles.map((bundle) => bundle.exchange)
  const jobContextLookup = contextLookup ?? await loadClaudeContextLookup({
    sessionIds: sessionIdsFromExchanges(exchanges),
  })
  const { seen, toolLookup } = await loadPriorProxyState(job, gatewayId)
  const rows = await materializeProxyBundles(currentBundles, gatewayId, jobContextLookup, seen)
  backfillToolNames(rows, toolLookup)
  if (rows.length === 0) return { rows: 0, parquet: new Uint8Array() }
  const parquet = await messageRowsToParquet(rows, ['gateway_id'])
  if (!parquet) throw new Error('failed to encode proxy_messages partition')
  return { rows: rows.length, parquet }
}

/**
 * @param {UploadJob} job
 * @param {string} gatewayId
 * @returns {Promise<{
 *   seen: Map<string, { conversation_id: string, message_index: number }>,
 *   toolLookup: Map<string, string>,
 * }>}
 */
async function loadPriorProxyState(job, gatewayId) {
  /** @type {Map<string, { conversation_id: string, message_index: number }>} */
  const seen = new Map()
  /** @type {Map<string, string>} */
  const toolLookup = new Map()
  const dir = path.dirname(job.jsonlPath)
  /** @type {string[]} */
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { seen, toolLookup }
  }
  const priorFiles = names
    .map((name) => ({ name, match: DATE_FILE_PATTERN.exec(name) }))
    .filter((entry) => entry.match && entry.match[1] < job.date)
    .sort((a, b) => /** @type {RegExpExecArray} */ (a.match)[1] < /** @type {RegExpExecArray} */ (b.match)[1] ? -1 : 1)

  for (const entry of priorFiles) {
    const rows = await materializeProxyFile(path.join(dir, entry.name), gatewayId, undefined, seen)
    for (const row of rows) {
      const messageId = row.message_id
      const conversationId = row.conversation_id
      const messageIndex = row.message_index
      if (typeof messageId === 'string' && typeof conversationId === 'string' && typeof messageIndex === 'number') {
        if (!seen.has(messageId)) seen.set(messageId, { conversation_id: conversationId, message_index: messageIndex })
      }
      if (
        row.part_type === 'tool_call' &&
        typeof row.tool_call_id === 'string' &&
        typeof row.tool_name === 'string' &&
        !toolLookup.has(row.tool_call_id)
      ) {
        toolLookup.set(row.tool_call_id, row.tool_name)
      }
    }
  }
  return { seen, toolLookup }
}

/**
 * @param {string} jsonlPath
 * @param {string} gatewayId
 * @param {ClaudeContextLookup | undefined} contextLookup
 * @param {Map<string, { conversation_id: string, message_index: number }>} [priorSeen]
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function materializeProxyFile(jsonlPath, gatewayId, contextLookup, priorSeen) {
  const bundles = await iterExchangesWithStreamEvents(jsonlPath)
  return materializeProxyBundles(bundles, gatewayId, contextLookup, priorSeen)
}

/**
 * @param {Array<{ exchange: Record<string, unknown>, streamEvents: Record<string, unknown>[] }>} bundles
 * @param {string} gatewayId
 * @param {ClaudeContextLookup | undefined} contextLookup
 * @param {Map<string, { conversation_id: string, message_index: number }>} [priorSeen]
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function materializeProxyBundles(bundles, gatewayId, contextLookup, priorSeen) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const streamEventsByExchange = new Map()
  for (const bundle of bundles) {
    const exchangeId = bundle.exchange.exchange_id
    if (typeof exchangeId === 'string') {
      streamEventsByExchange.set(exchangeId, bundle.streamEvents)
    }
  }
  const walked = walkExchanges(bundles.map((bundle) => bundle.exchange), {
    priorSeen,
    gateway_id: gatewayId,
    contextLookup,
    reconstructAssistantMessage: (exchange) => {
      const exchangeId = exchange.exchange_id
      if (typeof exchangeId !== 'string') return null
      const events = streamEventsByExchange.get(exchangeId)
      if (!events) return null
      return reconstructAssistantMessage(/** @type {import('../cli/stream-reconstruct.js').StreamEventRow[]} */ (events))
    },
  })
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for await (const row of walked) rows.push(row)
  return rows
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {Map<string, string>} toolLookup
 * @returns {void}
 */
function backfillToolNames(rows, toolLookup) {
  if (toolLookup.size === 0) return
  for (const row of rows) {
    if (row.part_type !== 'tool_result') continue
    if (typeof row.tool_name === 'string' && row.tool_name.length > 0) continue
    const toolCallId = row.tool_call_id
    if (typeof toolCallId !== 'string') continue
    const name = toolLookup.get(toolCallId)
    if (name) row.tool_name = name
  }
}

/**
 * Retry a connector op on transient failures with exponential backoff.
 * An error is treated as transient unless it carries a non-429 4xx
 * `statusCode`. Network errors, 5xx, and 429 are retried; permanent
 * 4xx (auth, malformed request) bail immediately.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {Required<UploadDeps>} deps
 * @returns {Promise<T>}
 */
async function withRetry(fn, deps) {
  let lastErr
  for (let attempt = 0; attempt < deps.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransient(err)) throw err
      if (attempt === deps.maxAttempts - 1) break
      await deps.sleep(deps.initialBackoffMs * 4 ** attempt)
    }
  }
  // Exhausted retries on a transient connector error: tag it so the
  // outer catch in uploadPending knows the scheduler should fast-retry.
  // Errors thrown elsewhere in uploadJob (bad JSONL, encoding bugs, fs)
  // are never tagged and therefore never classified as retryable.
  if (lastErr && typeof lastErr === 'object') {
    /** @type {{ transient?: boolean }} */ (lastErr).transient = true
  }
  throw lastErr
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransient(err) {
  const status = /** @type {{ statusCode?: unknown }} */ (err)?.statusCode
  if (typeof status === 'number') {
    if (status === 429) return true
    return status >= 500 && status < 600
  }
  return true
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @param {UploadDeps} deps
 * @returns {Required<UploadDeps>}
 */
function resolveDeps(deps) {
  return {
    maxAttempts: deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    initialBackoffMs: deps.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
    sleep: deps.sleep ?? defaultSleep,
  }
}

/**
 * Build the destination object key.
 *
 * @param {string} prefix
 * @param {UploadJob} job
 * @returns {string}
 */
function objectKey(prefix, job) {
  const head = prefix.replace(/^\/+|\/+$/g, '')
  const signalSegment = job.signal === 'proxy' ? 'proxy_messages' : job.signal
  const segments = [job.service, signalSegment, `date=${job.date}`, 'data.parquet']
  return head ? `${head}/${segments.join('/')}` : segments.join('/')
}

/**
 * @typedef {(sessionId: string | undefined, timestamp: unknown) => ({ cwd?: string, git_branch?: string, claude_version?: string } | undefined)} ClaudeContextLookup
 */

/**
 * @typedef {UploadDeps & { claudeContextLookup?: ClaudeContextLookup }} UploaderDeps
 */

/**
 * @param {UploadJob} a
 * @param {UploadJob} b
 * @returns {number}
 */
function jobCompare(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.service !== b.service) return a.service < b.service ? -1 : 1
  return SIGNALS.indexOf(a.signal) - SIGNALS.indexOf(b.signal)
}

/**
 * Subtract `days` from a YYYY-MM-DD UTC date string.
 *
 * @param {string} date
 * @param {number} days
 * @returns {string}
 */
function subtractDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}
