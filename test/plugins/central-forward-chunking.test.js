// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createForwardSink } from '../../hypaware-core/plugins-workspace/central/src/sink.js'

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
 * test mirrors the memory-bounded production path.
 *
 * @param {string} tablePath
 * @param {number} count
 */
function makeStorage(tablePath, count) {
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
        yield { message_id: `m${i}`, content_text: `row ${i}` }
      }
    },
  }
}

/** @param {string} signal */
function makeQuery(signal) {
  return { getDataset: () => ({ sourceSignal: signal }) }
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
 * Capturing fetch. `responder` decides the status per call; default 202.
 * @param {(call: { url: string, batchId: string, lines: string[] }) => number} [responder]
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
    const status = responder ? responder(call) : 202
    return /** @type {any} */ ({ status, ok: status >= 200 && status < 300, async text() { return '' } })
  })
  return { calls, fn }
}

const TABLE = '/cache/ai_gateway_messages/source=claude'

/** @param {{ count: number, responder?: (c: any) => number }} opts */
function buildSink({ count, responder }) {
  const storage = makeStorage(TABLE, count)
  const identityClient = makeIdentity()
  const { calls, fn } = makeFetch(responder)
  const sink = createForwardSink({
    config: /** @type {any} */ ({ url: 'http://server:8740', identity: {} }),
    identityClient: /** @type {any} */ (identityClient),
    query: /** @type {any} */ (makeQuery('logs')),
    storage: /** @type {any} */ (storage),
    log: /** @type {any} */ (makeLog()),
    fetchFn: fn,
  })
  return { sink, calls, storage, identityClient }
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
