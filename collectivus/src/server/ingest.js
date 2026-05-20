import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GATEWAY_ID_PATTERN } from '../gateway_id.js'
import { getClaims } from './auth.js'
import { parseContentType, readTextBody, writeError, writeJson, writeRetryAfterJson } from './http.js'
import { TokenBucket } from './rate_limit.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 * @import { IngestSignal, ThrottleEvent } from './types.d.ts'
 */

/**
 * Maximum NDJSON request body size accepted by the ingest endpoint.
 *
 * The gateway-side batcher (epic C.3) caps batches at 1 MB; we permit a
 * generous 16x headroom so older clients or experimental tooling don't
 * 413 on lightly-larger batches. C.2 introduces explicit backpressure
 * (queue-depth driven 429s) — this byte cap is just a hard upper bound
 * to prevent a single misbehaving client from monopolizing memory.
 */
const MAX_INGEST_BODY_BYTES = 16 * 1024 * 1024

/** Allowed signal kinds on `POST /v1/ingest/:signal`. */
const SIGNALS = new Set(['logs', 'traces', 'metrics', 'proxy'])

/** Default backpressure thresholds, mirroring the C.2 spec. */
const DEFAULT_MAX_PENDING_ROWS = 50_000
const DEFAULT_HIGH_WATER_PCT = 80
const DEFAULT_RETRY_AFTER_SECONDS = 5

/**
 * Default sink directory when `config.server.sink_dir` is absent.
 *
 * @returns {string}
 */
export function defaultSinkDir() {
  return path.join(os.homedir(), '.hyp', 'collectivus', 'server-data', 'ingested')
}

/**
 * Server-side NDJSON ingest endpoint. Persists each row into a per-gateway,
 * per-signal, per-day JSONL file:
 *
 *     <sink_dir>/<gateway_id>/<signal>/<YYYY-MM-DD>.jsonl
 *
 * Every persisted row gains an `_ingest: { gateway_id, received_at }` tag so
 * downstream consumers (parquet drain, multi-tenant readers) can attribute
 * the row without trusting any client-supplied fields. The gateway_id comes
 * from the JWT claim, never the request body — a JWT for gateway A cannot
 * be used to ship rows tagged as gateway B.
 *
 * ## Backpressure (epic C.2)
 *
 * The endpoint emits 429 with `Retry-After` once the in-flight pending-row
 * count crosses `maxPendingRows * highWaterPct%`, and 503 (with the same
 * `Retry-After`) once it hits `maxPendingRows`. A separate token-bucket
 * cap on bytes-per-second triggers the same 429 path when configured. All
 * three rejections cover the full batch — the gateway batcher (C.3) retries
 * the entire NDJSON payload after the suggested delay.
 */
export class Ingest {
  /**
   * @param {{
   *   sinkDir: string,
   *   now?: () => number,
   *   maxPendingRows?: number,
   *   highWaterPct?: number,
   *   retryAfterSeconds?: number,
   *   maxBytesPerSecond?: number,
   *   onThrottle?: (info: ThrottleEvent) => void,
   * }} opts
   */
  constructor(opts) {
    if (typeof opts?.sinkDir !== 'string' || opts.sinkDir.length === 0) {
      throw new Error('Ingest: sinkDir is required')
    }
    /** @type {string} */
    this.sinkDir = opts.sinkDir
    /** @type {() => number} */
    this.now = opts.now ?? Date.now

    /** @type {number} */
    this.maxPendingRows = opts.maxPendingRows ?? DEFAULT_MAX_PENDING_ROWS
    if (!Number.isInteger(this.maxPendingRows) || this.maxPendingRows < 1) {
      throw new Error('Ingest: maxPendingRows must be a positive integer')
    }
    /** @type {number} */
    this.highWaterPct = opts.highWaterPct ?? DEFAULT_HIGH_WATER_PCT
    if (!Number.isInteger(this.highWaterPct)
        || this.highWaterPct < 1
        || this.highWaterPct > 100) {
      throw new Error('Ingest: highWaterPct must be an integer in [1,100]')
    }
    /** @type {number} */
    this.retryAfterSeconds = opts.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS
    if (!Number.isInteger(this.retryAfterSeconds) || this.retryAfterSeconds < 1) {
      throw new Error('Ingest: retryAfterSeconds must be a positive integer')
    }
    /** @type {number | undefined} */
    this.maxBytesPerSecond = opts.maxBytesPerSecond
    if (this.maxBytesPerSecond !== undefined
        && (!Number.isInteger(this.maxBytesPerSecond) || this.maxBytesPerSecond < 1)) {
      throw new Error('Ingest: maxBytesPerSecond must be a positive integer when set')
    }

    /**
     * High-water row threshold, pre-computed because it's read on every
     * request and the inputs never change after construction.
     * @type {number}
     */
    this.highWaterRows = Math.floor(this.maxPendingRows * this.highWaterPct / 100)

    /**
     * Token bucket for the disk-rate ceiling. Capacity equals
     * `maxBytesPerSecond` (one second of headroom) and the refill rate is
     * the same value per second — bursts up to one second's worth are
     * allowed, sustained throughput is capped at the configured ceiling.
     * `undefined` means rate-limiting is disabled.
     * @type {TokenBucket | undefined}
     */
    this.byteBudget = this.maxBytesPerSecond === undefined
      ? undefined
      : new TokenBucket({
        capacity: this.maxBytesPerSecond,
        refillPerSecond: this.maxBytesPerSecond,
        now: this.now,
      })

    /**
     * Rows currently sitting in the per-file write chains, awaiting fsync.
     * Incremented when a batch joins its chain, decremented when its
     * `writeOnce` resolves (success or failure).
     * @type {number}
     */
    this.pendingRows = 0

    /**
     * Per-rejection-kind counters. Surfaced for ops scrapers and the test
     * suite — both want to assert backpressure triggered for the right
     * reason.
     * @type {{ pendingHighWater: number, pendingAtCapacity: number, byteRate: number }}
     */
    this.throttleStats = {
      pendingHighWater: 0,
      pendingAtCapacity: 0,
      byteRate: 0,
    }

    /**
     * Per-event hook fired alongside each backpressure rejection. Defaults
     * to a stderr line that ops can grep for; tests can swap in a capturing
     * function (or a no-op) to keep test output quiet.
     * @type {(info: ThrottleEvent) => void}
     */
    this.onThrottle = opts.onThrottle ?? defaultOnThrottle

    /**
     * Per-file write chains. Concurrent batches that target the same
     * (gateway, signal, day) file are queued so we never interleave two
     * writes on the same descriptor — POSIX `O_APPEND` is only atomic for
     * writes ≤ PIPE_BUF, and a single batch can be multi-MB. Cross-process
     * concurrency is out of scope: a v0 server is a single process.
     *
     * @type {Map<string, Promise<void>>}
     */
    this.fileChains = new Map()
  }

  /**
   * Handle a `POST /v1/ingest/:signal` request. Caller (the control plane)
   * has already authenticated the request via `createBearerAuth` and stashed
   * the verified claims for `getClaims(req)`.
   *
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {string} signalParam - The path segment after `/v1/ingest/`.
   * @returns {Promise<void>}
   */
  async handleRequest(req, res, signalParam) {
    if (!SIGNALS.has(signalParam)) {
      writeError(res, 404, 'unknown signal')
      return
    }
    /** @type {IngestSignal} */
    // eslint-disable-next-line no-extra-parens -- JSDoc cast needs the parens
    const signal = /** @type {IngestSignal} */ (signalParam)

    const claims = getClaims(req)
    if (!claims) {
      // Defense in depth — the control plane only routes here after
      // `authorize()` returns true, so missing claims means a wiring bug.
      writeError(res, 500, 'auth claims missing after authorize')
      return
    }
    const gatewayId = claims.sub
    if (!GATEWAY_ID_PATTERN.test(gatewayId)) {
      // Bootstrap-time validation should have prevented this; treating it
      // as a 500 surfaces the misconfiguration rather than silently
      // accepting a path-traversal attempt as 400-bad-request.
      writeError(res, 500, 'invalid gateway_id in JWT')
      return
    }

    const ct = parseContentType(req.headers['content-type'])
    if (ct !== 'application/x-ndjson' && ct !== 'application/jsonl') {
      writeError(res, 415, 'expected application/x-ndjson or application/jsonl')
      return
    }

    // Pending-row backpressure runs BEFORE we read the body so a saturated
    // server doesn't waste bandwidth pulling NDJSON it's about to reject.
    if (this.pendingRows >= this.maxPendingRows) {
      this.throttleStats.pendingAtCapacity += 1
      this.fireThrottle({
        kind: 'capacity',
        gatewayId,
        signal,
        pendingRows: this.pendingRows,
        maxPendingRows: this.maxPendingRows,
      })
      writeBackpressure(res, 503, 'ingest at capacity', this.retryAfterSeconds)
      return
    }
    if (this.pendingRows >= this.highWaterRows) {
      this.throttleStats.pendingHighWater += 1
      this.fireThrottle({
        kind: 'high_water',
        gatewayId,
        signal,
        pendingRows: this.pendingRows,
        highWaterRows: this.highWaterRows,
      })
      writeBackpressure(res, 429, 'ingest backpressure', this.retryAfterSeconds)
      return
    }

    const body = await readTextBody(req, MAX_INGEST_BODY_BYTES)
    if (body.error) {
      writeError(res, body.status, body.error)
      return
    }

    const receivedAtMs = this.now()
    const receivedAt = new Date(receivedAtMs).toISOString()
    // YYYY-MM-DD slice of an ISO-8601 string is unambiguously UTC because
    // `Date.toISOString()` always emits the `Z` suffix.
    const day = receivedAt.slice(0, 10)

    const lines = body.value.split('\n')
    /** @type {string[]} */
    const tagged = []
    let rejectedAtLine = -1
    let rejectError = ''
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Skip blank lines (including the trailing newline produced by `split`
      // on a body that ends with `\n`). They're idiomatic in NDJSON and not
      // a parse error.
      if (line.length === 0) continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch (err) {
        rejectedAtLine = i + 1
        rejectError = err instanceof Error ? err.message : String(err)
        break
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        rejectedAtLine = i + 1
        rejectError = 'row is not a JSON object'
        break
      }
      // Always overwrite any client-supplied `_ingest` field — clients must
      // not be able to forge attribution metadata.
      parsed._ingest = { gateway_id: gatewayId, received_at: receivedAt }
      tagged.push(JSON.stringify(parsed))
    }

    // Disk-rate throttle runs after parsing so we know the actual on-disk
    // byte count (NDJSON, including newlines). Zero-row batches skip this
    // — they don't touch disk and shouldn't drain the budget.
    if (tagged.length > 0 && this.byteBudget !== undefined) {
      const cost = computeBatchBytes(tagged)
      if (!this.byteBudget.tryConsume(cost)) {
        this.throttleStats.byteRate += 1
        this.fireThrottle({
          kind: 'byte_rate',
          gatewayId,
          signal,
          batchBytes: cost,
          // eslint-disable-next-line no-extra-parens -- JSDoc cast needs the parens
          maxBytesPerSecond: /** @type {number} */ (this.maxBytesPerSecond),
        })
        writeBackpressure(res, 429, 'ingest disk-rate throttled', this.retryAfterSeconds)
        return
      }
    }

    if (tagged.length > 0) {
      try {
        await this.appendBatch({ gatewayId, signal, day, lines: tagged })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        writeError(res, 500, `ingest write failed: ${msg}`)
        return
      }
    }

    if (rejectedAtLine !== -1) {
      writeJson(res, 400, {
        accepted: tagged.length,
        rejected_at_line: rejectedAtLine,
        error: rejectError,
      })
      return
    }

    writeJson(res, 202, { accepted: tagged.length })
  }

  /**
   * Invoke the throttle hook with a full event record. Wrapped so individual
   * call sites stay terse and so a misbehaving hook can't crash the request
   * handler.
   *
   * @param {ThrottleEvent} info
   */
  fireThrottle(info) {
    try {
      this.onThrottle(info)
    } catch {
      // Hook errors are intentionally swallowed — observability must never
      // turn a 429 into a 500.
    }
  }

  /**
   * Append a batch of pre-validated lines to the on-disk file. Per-file
   * serialization keeps concurrent batches for the same target file from
   * interleaving at the syscall level. The pending-row counter is bumped
   * for the duration of the chained write so concurrent requests see this
   * batch's contribution to backpressure even before fsync returns.
   *
   * @param {{ gatewayId: string, signal: string, day: string, lines: string[] }} args
   * @returns {Promise<void>}
   */
  async appendBatch(args) {
    const { gatewayId, signal, day, lines } = args
    const dir = path.join(this.sinkDir, gatewayId, signal)
    const file = path.join(dir, `${day}.jsonl`)

    this.pendingRows += lines.length
    const previous = this.fileChains.get(file) ?? Promise.resolve()
    const next = previous.then(() => writeOnce(dir, file, lines))
    // Park a swallowed copy on the chain so the next caller can `then` off
    // it without inheriting our rejection. The original `next` still rejects
    // for our caller via the `await` below.
    this.fileChains.set(file, next.catch(() => {}))
    try {
      await next
    } finally {
      this.pendingRows -= lines.length
    }
  }
}

/**
 * Default `onThrottle` hook: emit a single stderr line per rejection so ops
 * can grep for it without standing up a metrics pipeline. The line is
 * deliberately terse and key=value so it tails well in operator terminals.
 *
 * @param {ThrottleEvent} info
 */
function defaultOnThrottle(info) {
  if (info.kind === 'high_water') {
    process.stderr.write(`[ingest] backpressure kind=high_water gateway_id=${info.gatewayId} signal=${info.signal} pending_rows=${info.pendingRows}/${info.highWaterRows}\n`)
  } else if (info.kind === 'capacity') {
    process.stderr.write(`[ingest] backpressure kind=capacity gateway_id=${info.gatewayId} signal=${info.signal} pending_rows=${info.pendingRows}/${info.maxPendingRows}\n`)
  } else {
    process.stderr.write(`[ingest] backpressure kind=byte_rate gateway_id=${info.gatewayId} signal=${info.signal} batch_bytes=${info.batchBytes} max_bytes_per_second=${info.maxBytesPerSecond}\n`)
  }
}

/**
 * Compute the on-disk byte cost of a tagged batch. Mirrors `writeOnce` exactly:
 * lines joined by `\n`, plus the trailing newline that closes the batch.
 *
 * @param {string[]} lines
 * @returns {number}
 */
function computeBatchBytes(lines) {
  if (lines.length === 0) return 0
  let total = 0
  for (const line of lines) total += Buffer.byteLength(line, 'utf8')
  // (lines.length - 1) interior newlines + 1 trailing newline = lines.length
  total += lines.length
  return total
}

/**
 * Open the target file with `O_APPEND`, write the joined batch in a single
 * `write()`, fsync, then close. Per-batch fsync trades throughput for
 * crash-safety: rows acknowledged with 202 are durable.
 *
 * @param {string} dir
 * @param {string} file
 * @param {string[]} lines
 * @returns {Promise<void>}
 */
async function writeOnce(dir, file, lines) {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const handle = await fs.promises.open(file, 'a', 0o600)
  try {
    const buf = Buffer.from(lines.join('\n') + '\n', 'utf8')
    await handle.write(buf)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Backpressure response shape: status + `Retry-After` header + a body that
 * also reports the suggested wait. Same envelope for 429 and 503 so the
 * gateway-side retry loop (epic C.4) handles them with one branch.
 *
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @param {number} retryAfterSeconds
 */
function writeBackpressure(res, status, message, retryAfterSeconds) {
  writeRetryAfterJson(
    res,
    status,
    { error: message, retry_after_seconds: retryAfterSeconds },
    retryAfterSeconds
  )
}
