// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createForwardSink } from '../../hypaware-core/plugins-workspace/central/src/sink.js'
import { abortableSleep } from '../../hypaware-core/plugins-workspace/central/src/backoff.js'

function makeLog() {
  /** @type {Array<{ level: string, message: string, fields: Record<string, unknown> }>} */
  const rows = []
  /** @param {string} level */
  const emit = (level) =>
    /** @param {string} message @param {Record<string, unknown>} [fields] */
    (message, fields) => { rows.push({ level, message, fields: fields ?? {} }) }
  return { rows, debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}

/**
 * Storage whose table yields `count` rows one at a time — a stand-in for
 * the streaming Iceberg scan. Never builds an array of all rows, so the
 * test mirrors the memory-bounded production path. `rowFactory` lets a
 * test shape the rows (wide payloads, byte-identical rows); the default
 * is a small distinct row per index.
 *
 * @param {string} tablePath
 * @param {number} count
 * @param {(i: number) => Record<string, unknown>} [rowFactory]
 */
function makeStorage(tablePath, count, rowFactory) {
  const factory = rowFactory ?? ((i) => ({ message_id: `m${i}`, content_text: `row ${i}` }))
  let flushes = 0
  return {
    cacheRoot: '/cache',
    get flushes() { return flushes },
    /** @param {string} p */
    tableExists: (p) => p === tablePath,
    /** @param {string} _p */
    async flushTable(_p) { flushes += 1 },
    /** @param {string} _p */
    async *readRows(_p) {
      for (let i = 0; i < count; i += 1) {
        yield factory(i)
      }
    },
    // Cursor-aware sibling: row `i` carries `_hyp_ingest_seq = i + 1`, so a
    // `since` watermark of seq K skips the first K rows. `after` is the
    // running high-water as a decimal string, mirroring storage.js.
    /**
     * @param {string} _p
     * @param {{ since?: { v: 1, seq: string } }} [opts]
     */
    async *readRowsSince(_p, opts) {
      const since = opts?.since ? BigInt(opts.since.seq) : 0n
      for (let i = 0; i < count; i += 1) {
        const seq = BigInt(i + 1)
        if (seq <= since) continue
        yield { row: factory(i), after: { v: 1, seq: seq.toString() } }
      }
    },
  }
}

/**
 * In-memory stand-in for the per-(sink instance, partition) watermark store.
 * `keyFor` collapses to a single key (these tests forward one partition), and
 * `write` records every advance so a test can assert per-chunk progress and the
 * ship-first/advance-second ordering.
 *
 * @param {{ v: 1, continuation: { v: 1, seq: string }, exportedRowCount: number, updatedAt: string } | null} [initial]
 */
function makeWatermarks(initial) {
  let record = initial ?? null
  /** @type {Array<{ v: 1, continuation: { v: 1, seq: string }, exportedRowCount: number, updatedAt: string }>} */
  const writes = []
  return {
    get record() { return record },
    get writes() { return writes },
    keyFor: () => ({ dataset: 'ai_gateway_messages', partitionKey: 'source=claude' }),
    /** @param {any} _key */
    filePath: (_key) => '/state/watermarks/ai_gateway_messages/source=claude.json',
    async read() { return record },
    /**
     * @param {any} _key
     * @param {{ continuation: { v: 1, seq: string }, exportedRowCount?: number }} update
     */
    async write(_key, update) {
      record = {
        v: 1,
        continuation: update.continuation,
        exportedRowCount: update.exportedRowCount ?? 0,
        updatedAt: '2026-06-25T00:00:00.000Z',
      }
      writes.push(record)
      return record
    },
  }
}

/**
 * A query registry whose dataset resolves to `signal`. Pass `null` to
 * model a dataset with **no** `sourceSignal` — the failure mode bug #2
 * fixed, where the sink falls back to the (unknown) dataset name.
 *
 * @param {string | null} signal
 */
function makeQuery(signal) {
  return { getDataset: () => (signal === null ? {} : { sourceSignal: signal }) }
}

function makeIdentity() {
  let refreshes = 0
  return {
    get refreshes() { return refreshes },
    async getCurrentJwt() { return 'jwt-test' },
    async refresh() { refreshes += 1 },
  }
}

/**
 * Capturing fetch. `responder` returns either a bare status number or
 * `{ status, retryAfter }` so a test can attach a `Retry-After` header to
 * a 429/503. Default 202. The response exposes a real `headers.get` so
 * the sink's header read is exercised.
 *
 * @param {(call: { url: string, batchId: string, lines: string[] }) => (number | { status: number, retryAfter?: number })} [responder]
 */
function makeFetch(responder) {
  /** @type {Array<{ url: string, batchId: string, lines: string[], rowCount: number }>} */
  const calls = []
  // Count of response bodies the sink cancelled (drained) before parking on
  // backpressure — proves it releases the socket rather than leaking it.
  let bodyCancels = 0
  /** @type {typeof fetch} */
  const fn = /** @type {any} */ (async (url, init) => {
    const headers = /** @type {Record<string, string>} */ (init?.headers ?? {})
    const body = String(init?.body ?? '')
    const lines = body.split('\n').filter((l) => l.length > 0)
    const call = { url: String(url), batchId: headers['x-hyp-batch-id'], lines, rowCount: lines.length }
    calls.push(call)
    const result = responder ? responder(call) : 202
    const status = typeof result === 'number' ? result : result.status
    const retryAfter = typeof result === 'object' ? result.retryAfter : undefined
    return /** @type {any} */ ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (/** @type {string} */ n) => (n.toLowerCase() === 'retry-after' && retryAfter != null ? String(retryAfter) : null) },
      // A real ReadableStream in production; here a spy so a test can prove
      // the sink cancels a throttle body before its backpressure pause.
      body: { cancel: async () => { bodyCancels += 1 } },
      async text() { return '' },
    })
  })
  return { calls, fn, drains: () => bodyCancels }
}

const TABLE = '/cache/ai_gateway_messages/source=claude'

/**
 * @param {{
 *   count: number,
 *   responder?: (c: any) => (number | { status: number, retryAfter?: number }),
 *   rowFactory?: (i: number) => Record<string, unknown>,
 *   signal?: string | null,
 *   sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   watermark?: { v: 1, continuation: { v: 1, seq: string }, exportedRowCount: number, updatedAt: string } | null,
 * }} opts
 */
function buildSink({ count, responder, rowFactory, signal = 'logs', sleepFn, watermark }) {
  const storage = makeStorage(TABLE, count, rowFactory)
  const identityClient = makeIdentity()
  const { calls, fn, drains } = makeFetch(responder)
  const log = makeLog()
  const watermarks = makeWatermarks(watermark)
  // Default sleep records the requested delay and returns instantly, so
  // backpressure pacing is asserted without real waits; a test can pass
  // the real abortableSleep to exercise close()-driven abort.
  /** @type {number[]} */
  const sleeps = []
  const recordingSleep = async (/** @type {number} */ ms) => { sleeps.push(ms) }
  const sink = createForwardSink({
    config: /** @type {any} */ ({ url: 'http://server:8740', identity: {} }),
    identityClient: /** @type {any} */ (identityClient),
    query: /** @type {any} */ (makeQuery(signal)),
    storage: /** @type {any} */ (storage),
    watermarks: /** @type {any} */ (watermarks),
    log: /** @type {any} */ (log),
    fetchFn: fn,
    sleepFn: sleepFn ?? recordingSleep,
  })
  return { sink, calls, storage, identityClient, log, sleeps, drains, watermarks }
}

const batch = { partitions: [{ dataset: 'ai_gateway_messages', tablePath: TABLE }] }

test('forward sink chunks a large partition into bounded POSTs', async () => {
  const { sink, calls } = buildSink({ count: 12_000 })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))

  assert.equal(result.status, 'exported')
  assert.equal(result.partitionsExported, 1)
  // 12000 rows / 5000 per chunk -> 5000, 5000, 2000
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map((c) => c.rowCount), [5000, 5000, 2000])
  assert.equal(calls.reduce((n, c) => n + c.rowCount, 0), 12_000)
  // every chunk goes to the resolved signal endpoint with an idempotency key
  for (const c of calls) {
    assert.equal(c.url, 'http://server:8740/v1/ingest/logs')
    assert.match(c.batchId, /^[0-9a-f]{32}$/)
  }
})

test('a partition that fits in one chunk makes exactly one POST', async () => {
  const { sink, calls } = buildSink({ count: 10 })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].rowCount, 10)
})

test('chunk batch-ids are deterministic across re-exports (idempotent retry)', async () => {
  const first = buildSink({ count: 12_000 })
  await first.sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  const second = buildSink({ count: 12_000 })
  await second.sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.deepEqual(first.calls.map((c) => c.batchId), second.calls.map((c) => c.batchId))
  // distinct chunk contents must not collide
  assert.equal(new Set(first.calls.map((c) => c.batchId)).size, 3)
})

test('a transport failure marks the partition for retry, not the whole batch', async () => {
  // Fail the 2nd chunk; the partition should be reported for retry.
  let n = 0
  const { sink, calls } = buildSink({ count: 12_000, responder: () => (++n === 2 ? 500 : 202) })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'failed')
  assert.equal(result.partitionsExported, 0)
  assert.equal(result.retryPartitions?.length, 1)
  // it stopped streaming the partition at the failing chunk
  assert.equal(calls.length, 2)
})

test('empty batch is a no-op success', async () => {
  const { sink, calls } = buildSink({ count: 0 })
  const result = await sink.exportBatch(/** @type {any} */ ({ partitions: [] }), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(result.partitionsExported, 0)
  assert.equal(calls.length, 0)
})

test('byte-identical chunks get distinct batch-ids (no ledger collision)', async () => {
  // 10000 identical rows -> two byte-identical 5000-row chunks. Keying
  // the idempotency id on content alone would alias them onto one ledger
  // entry and the server would silently drop the second chunk; keying on
  // chunk position too keeps them distinct. (Codex finding.)
  const { sink, calls } = buildSink({
    count: 10_000,
    rowFactory: () => ({ message_id: 'same', content_text: 'identical' }),
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(calls.length, 2)
  // the two chunks really are byte-for-byte identical...
  assert.deepEqual(calls[0].lines, calls[1].lines)
  assert.equal(calls[0].rowCount, 5000)
  // ...yet their idempotency keys differ, so neither is dedup-dropped.
  assert.notEqual(calls[0].batchId, calls[1].batchId)
})

test('a dataset with no sourceSignal fails the partition for retry (unknown signal)', async () => {
  // Bug #2: deleting `sourceSignal: 'proxy'` makes the sink fall back to
  // the dataset name, which is not a known ingest signal. Guard the
  // load-bearing fix so a regression is loud, not silent.
  const { sink, calls } = buildSink({ count: 10, signal: null })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'failed')
  assert.equal(result.partitionsExported, 0)
  assert.equal(result.retryPartitions?.length, 1)
  assert.match(String(result.error), /unknown signal/)
  // it never reached the wire — the signal is rejected before streaming
  assert.equal(calls.length, 0)
})

// Mirrors MAX_CHUNK_BYTES in sink.js; the byte budget is otherwise
// module-internal.
const MAX_CHUNK_BYTES = 4 * 1024 * 1024

test('the byte budget splits wide rows even when the row count is tiny', async () => {
  // 10 rows of ~1 MiB each: MAX_CHUNK_ROWS (5000) never trips, so only
  // the byte budget governs. This is the bound that actually prevents
  // the OOM/oversized-body for wide `content_text` — the row-count tests
  // above never exercise it.
  const wide = 'x'.repeat(1 << 20)
  const { sink, calls } = buildSink({
    count: 10,
    rowFactory: (i) => ({ message_id: `m${i}`, content_text: wide }),
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')

  const oneRowBytes = Buffer.byteLength(JSON.stringify({ message_id: 'm0', content_text: wide }), 'utf8') + 1
  assert.ok(calls.length >= 2, 'wide rows split into multiple POSTs')
  assert.equal(calls.reduce((n, c) => n + c.rowCount, 0), 10)
  for (const c of calls) {
    // bytes, not the row count, caused the split
    assert.ok(c.rowCount < 5000)
    const bodyBytes = Buffer.byteLength(c.lines.join('\n') + '\n', 'utf8')
    // each chunk stays under the budget plus the single row that tripped it
    assert.ok(bodyBytes <= MAX_CHUNK_BYTES + oneRowBytes, `chunk ${bodyBytes}B within budget+1row`)
  }
})

test('a 401 re-sends the same body + batch-id after one refresh', async () => {
  // postNdjson refreshes the JWT and retries once on 401; the retry must
  // carry the identical body and X-Hyp-Batch-Id so it stays idempotent.
  let n = 0
  const { sink, calls, identityClient } = buildSink({
    count: 10,
    responder: () => (++n === 1 ? 401 : 202),
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(identityClient.refreshes, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].batchId, calls[1].batchId)
  assert.deepEqual(calls[0].lines, calls[1].lines)
})

test('each chunk emits central.forward.chunk telemetry', async () => {
  const { sink, calls, log } = buildSink({ count: 12_000 })
  await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  const chunkLogs = log.rows.filter((r) => r.message === 'central.forward.chunk')
  assert.equal(chunkLogs.length, 3)
  chunkLogs.forEach((entry, i) => {
    assert.equal(entry.level, 'debug')
    assert.equal(entry.fields.hyp_sink_signal, 'logs')
    assert.equal(entry.fields.hyp_dataset, 'ai_gateway_messages')
    assert.equal(entry.fields.chunk_index, i)
    assert.equal(entry.fields.batch_id, calls[i].batchId)
    assert.equal(entry.fields.rows, calls[i].rowCount)
    assert.ok(typeof entry.fields.bytes === 'number' && entry.fields.bytes > 0)
  })
})

test('central.forward.failed names the failing chunk and how many landed', async () => {
  let n = 0
  const { sink, calls, log } = buildSink({ count: 12_000, responder: () => (++n === 2 ? 500 : 202) })
  await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  const failed = log.rows.filter((r) => r.message === 'central.forward.failed')
  assert.equal(failed.length, 1)
  // the failing chunk is the 2nd POST; one chunk landed before it
  assert.equal(failed[0].fields.batch_id, calls[1].batchId)
  assert.equal(failed[0].fields.chunks_sent, 1)
})

// ---- Backpressure: honor Retry-After and resume the same chunk (issue #118) ----

test('429 honors Retry-After and retries the same chunk to success', async () => {
  // First POST is throttled with Retry-After: 7; the chunk must pause for
  // exactly that long (not the ladder default) and re-send byte-identical.
  let n = 0
  const { sink, calls, sleeps } = buildSink({
    count: 10,
    responder: () => (++n === 1 ? { status: 429, retryAfter: 7 } : 202),
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(result.partitionsExported, 1)
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [7000])
  // the retry is the same chunk: identical body + idempotency key
  assert.equal(calls[0].batchId, calls[1].batchId)
  assert.deepEqual(calls[0].lines, calls[1].lines)
})

test('429 without Retry-After falls back to the backoff ladder', async () => {
  let n = 0
  const { sink, sleeps } = buildSink({
    count: 10,
    responder: () => (++n === 1 ? 429 : 202), // no retryAfter header
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.deepEqual(sleeps, [30_000]) // RETRY_BACKOFF_SECONDS[0]
})

test('503 is backpressure (retried), not a hard failure', async () => {
  let n = 0
  const { sink, calls, sleeps } = buildSink({
    count: 10,
    responder: () => (++n === 1 ? { status: 503, retryAfter: 3 } : 202),
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [3000])
})

test('repeated 429s walk the ladder before succeeding', async () => {
  // Three throttles with no Retry-After, then accept: the inline waits
  // climb the ladder by attempt index.
  let n = 0
  const { sink, calls, sleeps } = buildSink({
    count: 10,
    responder: () => (++n <= 3 ? 429 : 202),
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(calls.length, 4)
  assert.deepEqual(sleeps, [30_000, 60_000, 120_000])
})

test('backpressure beyond the inline budget fails the partition for retry', async () => {
  // Persistent 429 with Retry-After: 120. The inline budget is 5 min, so
  // two waits (240s) fit and the third would cross it — the chunk throws
  // and the partition is handed back for the next tick (cheap: the server
  // dedupes the delivered prefix).
  const { sink, calls, sleeps } = buildSink({
    count: 10,
    responder: () => ({ status: 429, retryAfter: 120 }),
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'failed')
  assert.equal(result.partitionsExported, 0)
  assert.equal(result.retryPartitions?.length, 1)
  assert.match(String(result.error), /backpressure exceeded/)
  assert.deepEqual(sleeps, [120_000, 120_000])
  assert.equal(calls.length, 3) // initial + 2 retries, all the same chunk
})

test('a non-positive Retry-After (0 / past date) uses the ladder, never a zero-delay spin', async () => {
  // A legal `Retry-After: 0` (and a past HTTP-date) parses to 0. Taking it
  // verbatim would retry with no delay, never advance the inline budget,
  // and spin forever. The sink must treat it as "no pacing" and climb the
  // ladder, so the budget still bounds the loop and respools the partition.
  const { sink, calls, sleeps } = buildSink({
    count: 10,
    responder: () => ({ status: 429, retryAfter: 0 }),
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'failed')
  assert.equal(result.retryPartitions?.length, 1)
  assert.match(String(result.error), /backpressure exceeded/)
  // Ladder values, not [0, 0, 0]: every wait advances and bounds the loop.
  assert.deepEqual(sleeps, [30_000, 60_000, 120_000])
  assert.equal(calls.length, 4)
  assert.ok(!sleeps.includes(0))
})

test('backpressure drains the throttle response body before parking', async () => {
  // undici pins the socket until the body is read or cancelled; the sink
  // must release each 429/503 body it is about to retry past.
  let n = 0
  const { sink, drains } = buildSink({
    count: 10,
    responder: () => (++n <= 2 ? { status: 503, retryAfter: 1 } : 202),
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(drains(), 2) // both throttle bodies cancelled; the 202 returns without draining
})

test('each backpressure wait emits central.forward.backpressure telemetry', async () => {
  let n = 0
  const { sink, calls, log } = buildSink({
    count: 10,
    responder: () => (++n === 1 ? { status: 429, retryAfter: 9 } : 202),
  })
  await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  const bp = log.rows.filter((r) => r.message === 'central.forward.backpressure')
  assert.equal(bp.length, 1)
  assert.equal(bp[0].level, 'debug')
  assert.equal(bp[0].fields.http_status, 429)
  assert.equal(bp[0].fields.retry_after_seconds, 9)
  assert.equal(bp[0].fields.batch_id, calls[0].batchId)
  assert.equal(bp[0].fields.hyp_sink_signal, 'logs')
})

test('close() aborts a chunk paused on backpressure (no shutdown wedge)', async () => {
  // Use the real abortableSleep so the chunk genuinely parks on the wait;
  // close() must abort it and the partition reports for retry promptly.
  const { sink, calls } = buildSink({
    count: 10,
    responder: () => ({ status: 429, retryAfter: 300 }),
    sleepFn: abortableSleep,
  })
  const pending = sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  // Let the first POST land and the wait start before closing.
  await new Promise((r) => setTimeout(r, 15))
  await sink.close()
  const result = await pending
  assert.equal(result.status, 'failed')
  assert.equal(result.retryPartitions?.length, 1)
  assert.match(String(result.error), /closed/)
  assert.equal(calls.length, 1) // never got past the first throttled POST
})

// ---- Incremental reads: per-(sink, partition) watermark (LLP 0040, T4) ----

test('a tick with no new rows transmits zero bytes and zero chunks', async () => {
  // Watermark already at the partition's max seq (10 rows -> seq 10): the
  // since-filtered read yields nothing, so the sink POSTs nothing.
  const { sink, calls, watermarks } = buildSink({
    count: 10,
    watermark: { v: 1, continuation: { v: 1, seq: '10' }, exportedRowCount: 10, updatedAt: '' },
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(result.partitionsExported, 1)
  assert.equal(result.bytesWritten, 0)
  assert.equal(calls.length, 0)
  // nothing acked -> watermark untouched
  assert.equal(watermarks.writes.length, 0)
  assert.equal(watermarks.record?.continuation.seq, '10')
})

test('a tick after N new rows reads/sends only the new suffix and advances the watermark', async () => {
  // 10 rows total, watermark at seq 7: only rows 8,9,10 are new.
  const { sink, calls, watermarks } = buildSink({
    count: 10,
    watermark: { v: 1, continuation: { v: 1, seq: '7' }, exportedRowCount: 7, updatedAt: '' },
  })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].rowCount, 3) // not 10 — the prefix is skipped
  // watermark advanced to the last row's seq, count carried forward
  assert.equal(watermarks.record?.continuation.seq, '10')
  assert.equal(watermarks.record?.exportedRowCount, 10)
})

test('the watermark advances per acked chunk to that chunk’s last after', async () => {
  // 12000 rows -> chunks of 5000,5000,2000 -> last seqs 5000,10000,12000.
  const { sink, watermarks } = buildSink({ count: 12_000 })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.deepEqual(watermarks.writes.map((w) => w.continuation.seq), ['5000', '10000', '12000'])
  assert.deepEqual(watermarks.writes.map((w) => w.exportedRowCount), [5000, 10000, 12000])
  assert.equal(watermarks.record?.continuation.seq, '12000')
})

test('a mid-partition failure leaves the watermark at the last acked chunk', async () => {
  // Fail the 2nd chunk: only chunk 1 acked, so the watermark advances to
  // seq 5000 and no further — the un-acked suffix re-sends next tick.
  let n = 0
  const { sink, watermarks } = buildSink({ count: 12_000, responder: () => (++n === 2 ? 500 : 202) })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'failed')
  assert.equal(watermarks.writes.length, 1)
  assert.equal(watermarks.record?.continuation.seq, '5000')
})

test('a fresh partition (no watermark) reads from the start and advances', async () => {
  // No persisted watermark -> since undefined -> full read (the safe
  // at-least-once direction), then the watermark is created.
  const { sink, calls, watermarks } = buildSink({ count: 10 })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].rowCount, 10)
  assert.equal(watermarks.record?.continuation.seq, '10')
})
