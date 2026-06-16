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
      async text() { return '' },
    })
  })
  return { calls, fn }
}

const TABLE = '/cache/ai_gateway_messages/source=claude'

/**
 * @param {{
 *   count: number,
 *   responder?: (c: any) => (number | { status: number, retryAfter?: number }),
 *   rowFactory?: (i: number) => Record<string, unknown>,
 *   signal?: string | null,
 *   sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>,
 * }} opts
 */
function buildSink({ count, responder, rowFactory, signal = 'logs', sleepFn }) {
  const storage = makeStorage(TABLE, count, rowFactory)
  const identityClient = makeIdentity()
  const { calls, fn } = makeFetch(responder)
  const log = makeLog()
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
    log: /** @type {any} */ (log),
    fetchFn: fn,
    sleepFn: sleepFn ?? recordingSleep,
  })
  return { sink, calls, storage, identityClient, log, sleeps }
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
