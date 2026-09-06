// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createForwardSink, initializeOpenDatasetRollouts } from '../../hypaware-core/plugins-workspace/central/src/sink.js'
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
 * Storage whose table yields `count` rows one at a time: a stand-in for
 * the streaming Iceberg scan. Never builds an array of all rows, so the
 * test mirrors the memory-bounded production path. `rowFactory` lets a
 * test shape the rows (wide payloads, byte-identical rows); the default
 * is a small distinct row per index.
 *
 * @param {string} tablePath
 * @param {number | (() => number)} count
 * @param {(i: number) => Record<string, unknown>} [rowFactory]
 * @param {(i: number) => boolean} [dropRow]
 */
function makeStorage(tablePath, count, rowFactory, dropRow) {
  const factory = rowFactory ?? ((i) => ({ message_id: `m${i}`, content_text: `row ${i}` }))
  const currentCount = () => typeof count === 'function' ? count() : count
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
      for (let i = 0; i < currentCount(); i += 1) {
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
      for (let i = 0; i < currentCount(); i += 1) {
        const seq = BigInt(i + 1)
        if (seq <= since) continue
        if (dropRow?.(i)) {
          yield { dropped: true, after: { v: /** @type {const} */ (1), seq: seq.toString() } }
          continue
        }
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
 * `filePath` is a real seam: the sink stats it to tell "no watermark yet" from
 * "watermark present but unreadable", which `read()` collapses into `null`.
 *
 * @param {{ v: 1, continuation: { v: 1, seq: string }, exportedRowCount: number, updatedAt: string } | null} [initial]
 * @param {string} [filePath]
 */
function makeWatermarks(initial, filePath) {
  let record = initial ?? null
  /** @type {Array<{ v: 1, continuation: { v: 1, seq: string }, exportedRowCount: number, updatedAt: string }>} */
  const writes = []
  return {
    get record() { return record },
    get writes() { return writes },
    keyFor: () => ({ dataset: 'ai_gateway_messages', partitionKey: 'source=claude' }),
    /** @param {any} _key */
    filePath: (_key) => filePath ?? '/state/watermarks/ai_gateway_messages/source=claude.json',
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
 * In-memory stand-in for the durable open-dataset rollout manifest.
 *
 * @param {{ v: 1, partitions: string[], initializedAt: string, updatedAt: string } | null} [initial]
 */
function makeRollouts(initial) {
  let record = initial ?? null
  /** @type {Array<{ v: 1, partitions: string[], initializedAt: string, updatedAt: string }>} */
  const writes = []
  return {
    get record() { return record },
    get writes() { return writes },
    filePath: () => '/state/open-dataset-rollouts/claude_telemetry_events.json',
    async read() { return record },
    /**
     * @param {string} _dataset
     * @param {string[]} partitionKeys
     * @param {any} previous
     */
    async write(_dataset, partitionKeys, previous) {
      record = {
        v: 1,
        partitions: [...new Set(partitionKeys)].sort(),
        initializedAt: previous?.initializedAt ?? '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      }
      writes.push(record)
      return record
    },
  }
}

/**
 * A query registry whose dataset resolves to `signal`. Pass `null` to
 * model a plugin dataset that relies on the dataset-name default.
 *
 * @param {string | null} signal
 */
function makeQuery(signal) {
  return {
    /** @param {string} name */
    getDataset: (name) => ({
      name,
      plugin: '@hypaware/test',
      schema: {
        columns: [
          { name: 'message_id', type: 'STRING', nullable: false },
          { name: 'content_text', type: 'STRING', nullable: true },
        ],
      },
      ...(signal === null ? {} : { sourceSignal: signal }),
    }),
  }
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
 * @param {(call: { url: string, method: string, batchId: string | undefined, lines: string[] }) => (number | { status: number, retryAfter?: number } | Promise<number | { status: number, retryAfter?: number }>)} [responder]
 */
function makeFetch(responder) {
  /** @type {Array<{ url: string, method: string, batchId: string | undefined, lines: string[], rowCount: number }>} */
  const calls = []
  // Count of response bodies the sink cancelled (drained) before parking on
  // backpressure: proves it releases the socket rather than leaking it.
  let bodyCancels = 0
  /** @type {typeof fetch} */
  const fn = /** @type {any} */ (async (url, init) => {
    const headers = /** @type {Record<string, string>} */ (init?.headers ?? {})
    const body = String(init?.body ?? '')
    const lines = body.split('\n').filter((l) => l.length > 0)
    const call = {
      url: String(url),
      method: String(init?.method ?? 'GET'),
      batchId: headers['x-hyp-batch-id'],
      lines,
      rowCount: lines.length,
    }
    calls.push(call)
    const result = responder ? await responder(call) : 202
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
 *   count: number | (() => number),
 *   responder?: (c: any) => (number | { status: number, retryAfter?: number } | Promise<number | { status: number, retryAfter?: number }>),
 *   rowFactory?: (i: number) => Record<string, unknown>,
 *   dropRow?: (i: number) => boolean,
 *   signal?: string | null,
 *   query?: { getDataset: (name: string) => unknown },
 *   sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   watermark?: { v: 1, continuation: { v: 1, seq: string }, exportedRowCount: number, updatedAt: string } | null,
 *   rollout?: { v: 1, partitions: string[], initializedAt: string, updatedAt: string } | null,
 *   nowFn?: () => number,
 *   watermarkFilePath?: string,
 * }} opts
 */
function buildSink({ count, responder, rowFactory, dropRow, signal = 'logs', query, sleepFn, watermark, rollout, nowFn, watermarkFilePath }) {
  const storage = makeStorage(TABLE, count, rowFactory, dropRow)
  const identityClient = makeIdentity()
  const { calls, fn, drains } = makeFetch(responder)
  const log = makeLog()
  const watermarks = makeWatermarks(watermark, watermarkFilePath)
  const rollouts = makeRollouts(rollout)
  // Default sleep records the requested delay and returns instantly, so
  // backpressure pacing is asserted without real waits; a test can pass
  // the real abortableSleep to exercise close()-driven abort.
  /** @type {number[]} */
  const sleeps = []
  const recordingSleep = async (/** @type {number} */ ms) => { sleeps.push(ms) }
  const sink = createForwardSink({
    config: /** @type {any} */ ({ url: 'http://server:8740', identity: {} }),
    identityClient: /** @type {any} */ (identityClient),
    query: /** @type {any} */ (query ?? makeQuery(signal)),
    storage: /** @type {any} */ (storage),
    watermarks: /** @type {any} */ (watermarks),
    rollouts: /** @type {any} */ (rollouts),
    log: /** @type {any} */ (log),
    fetchFn: fn,
    sleepFn: sleepFn ?? recordingSleep,
    nowFn,
  })
  return { sink, calls, storage, identityClient, log, sleeps, drains, watermarks, rollouts }
}

const batch = { partitions: [{ dataset: 'ai_gateway_messages', tablePath: TABLE }] }
const ZERO_WATERMARK = {
  v: /** @type {const} */ (1),
  continuation: { v: /** @type {const} */ (1), seq: '0' },
  exportedRowCount: 0,
  updatedAt: '2026-06-25T00:00:00.000Z',
}
const INITIALIZED_EMPTY_ROLLOUT = {
  v: /** @type {const} */ (1),
  partitions: [],
  initializedAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}
const INITIALIZED_CLAUDE_ROLLOUT = {
  ...INITIALIZED_EMPTY_ROLLOUT,
  partitions: ['source=claude'],
}

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
    assert.ok(c.batchId)
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

// @ref LLP 0345#central [tests]: retained source history is previewed and
// replayed without rewinding or advancing the ordinary incremental cursor.
test('client history replay filters by attribution and leaves the watermark untouched', async () => {
  const dataset = {
    name: 'ai_gateway_messages',
    plugin: '@hypaware/ai-gateway',
    schema: { columns: [] },
    sourceSignal: 'proxy',
    async discoverPartitions() {
      return [{ dataset: 'ai_gateway_messages', partition: { source: 'claude' }, tablePath: TABLE }]
    },
  }
  const query = {
    getDataset: (/** @type {string} */ name) => name === 'ai_gateway_messages' ? dataset : undefined,
  }
  const initial = {
    v: /** @type {const} */ (1),
    continuation: { v: /** @type {const} */ (1), seq: '3' },
    exportedRowCount: 3,
    updatedAt: '2026-08-31T00:00:00.000Z',
  }
  const { sink, calls, watermarks } = buildSink({
    count: 4,
    query: /** @type {any} */ (query),
    watermark: initial,
    dropRow: (i) => i === 3,
    rowFactory: (i) => ({
      message_id: `m${i}`,
      part_id: `p${i}`,
      client_name: i === 1 ? 'codex' : 'claude',
      content_text: `row ${i}`,
    }),
  })

  const preview = await sink.previewSourceHistory?.({ source: 'claude' })
  assert.deepEqual(preview, { rows: 2, withheldRows: 1 })
  assert.equal(calls.length, 0, 'preview is read-only')

  const result = await sink.replaySourceHistory?.({ source: 'claude' })
  assert.equal(result?.status, 'exported')
  assert.equal(result?.rowsReplayed, 2)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://server:8740/v1/ingest/proxy')
  assert.deepEqual(calls[0].lines.map((line) => JSON.parse(line).client_name), ['claude', 'claude'])
  assert.deepEqual(watermarks.record, initial)
  assert.equal(watermarks.writes.length, 0)
})

test('client history replay reports only chunks acknowledged before a failure', async () => {
  const dataset = {
    name: 'ai_gateway_messages',
    plugin: '@hypaware/ai-gateway',
    schema: { columns: [] },
    sourceSignal: 'proxy',
    async discoverPartitions() {
      return [{ dataset: 'ai_gateway_messages', partition: { source: 'claude' }, tablePath: TABLE }]
    },
  }
  const query = {
    getDataset: (/** @type {string} */ name) => name === 'ai_gateway_messages' ? dataset : undefined,
  }
  let response = 0
  const { sink, calls, watermarks } = buildSink({
    count: 6_000,
    query: /** @type {any} */ (query),
    responder: () => (++response === 1 ? 202 : 400),
    rowFactory: (i) => ({
      message_id: `m${i}`,
      part_id: `p${i}`,
      client_name: 'claude',
      content_text: `row ${i}`,
    }),
  })

  const result = await sink.replaySourceHistory?.({ source: 'claude' })

  assert.equal(result?.status, 'failed')
  assert.equal(result?.rowsReplayed, 5_000)
  assert.ok((result?.bytesWritten ?? 0) > 0)
  assert.deepEqual(calls.map((call) => call.rowCount), [5_000, 1_000])
  assert.equal(watermarks.writes.length, 0)
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

test('a dataset with no sourceSignal registers and forwards under its dataset name', async () => {
  const { sink, calls } = buildSink({ count: 10, signal: null, watermark: ZERO_WATERMARK })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].url, 'http://server:8740/v1/datasets/ai_gateway_messages')
  assert.deepEqual(JSON.parse(calls[0].lines[0]), {
    schema: {
      columns: [
        { name: 'message_id', type: 'STRING', nullable: false },
        { name: 'content_text', type: 'STRING', nullable: true },
      ],
    },
  })
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].url, 'http://server:8740/v1/ingest/ai_gateway_messages')
  assert.equal(calls[1].rowCount, 10)
})

test('claude telemetry registers its schema before forwarding under its dataset name', async () => {
  const { sink, calls } = buildSink({
    count: 10,
    signal: 'claude_telemetry',
    watermark: ZERO_WATERMARK,
  })
  const result = await sink.exportBatch(
    /** @type {any} */ ({
      partitions: [{ dataset: 'claude_telemetry_events', tablePath: TABLE }],
    }),
    /** @type {any} */ ({})
  )

  assert.equal(result.status, 'exported')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].url, 'http://server:8740/v1/datasets/claude_telemetry_events')
  assert.equal(JSON.parse(calls[0].lines[0]).sourceSignal, 'claude_telemetry')
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].url, 'http://server:8740/v1/ingest/claude_telemetry_events')
  assert.equal(calls[1].rowCount, 10)
})

const TELEMETRY_BATCH = {
  partitions: [{ dataset: 'claude_telemetry_events', tablePath: TABLE }],
}

test('a dataset schema announces once per sink instance, not once per tick', async () => {
  const { sink, calls } = buildSink({ count: 10, signal: 'claude_telemetry' })

  const first = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  const second = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))

  assert.equal(first.status, 'exported')
  assert.equal(second.status, 'exported')
  // The bound the sink claims: the announce is remembered for the sink's
  // lifetime, so a second tick over the same dataset re-announces nothing.
  // (A new sink instance - a daemon restart - starts a fresh memory and may
  // announce again, which is why the server side has to stay idempotent.)
  assert.deepEqual(calls.filter((c) => c.method === 'PUT').length, 1)
})

test('a newly forwardable open dataset starts after its existing local history', async () => {
  let count = 10
  const { sink, calls, watermarks, log } = buildSink({
    count: () => count,
    signal: 'claude_telemetry',
  })

  const first = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  assert.equal(first.status, 'exported')
  assert.deepEqual(calls.map((c) => c.method), ['PUT'])
  assert.equal(watermarks.record?.continuation.seq, '10')
  assert.equal(watermarks.record?.exportedRowCount, 0)
  assert.equal(
    log.rows.find((r) => r.message === 'central.forward.initial_history_skipped')?.fields.skipped_row_count,
    10
  )

  count = 12
  const second = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  assert.equal(second.status, 'exported')
  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'POST'])
  assert.deepEqual(calls[1].lines.map((line) => JSON.parse(line).message_id), ['m10', 'm11'])
  assert.equal(watermarks.record?.continuation.seq, '12')
  assert.equal(watermarks.record?.exportedRowCount, 2)
})

test('a new remote destination forwards retained open-dataset history from sequence zero', async () => {
  const { sink, calls, watermarks, rollouts, log, storage } = buildSink({
    count: 3,
    signal: 'claude_telemetry',
  })
  const dataset = {
    ...makeQuery('claude_telemetry').getDataset('claude_telemetry_events'),
    discoverPartitions: async () => TELEMETRY_BATCH.partitions,
  }

  await initializeOpenDatasetRollouts({
    query: /** @type {any} */ ({ listDatasets: () => [dataset] }),
    storage: /** @type {any} */ (storage),
    watermarks: /** @type {any} */ (watermarks),
    rollouts: /** @type {any} */ (rollouts),
    log: /** @type {any} */ (log),
    replayRetainedHistory: true,
  })

  assert.equal(watermarks.record?.continuation.seq, '0')
  assert.deepEqual(rollouts.record?.partitions, ['source=claude'])
  const result = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.deepEqual(calls.map((call) => call.method), ['PUT', 'POST'])
  assert.deepEqual(calls[1].lines.map((line) => JSON.parse(line).message_id), ['m0', 'm1', 'm2'])
  assert.equal(watermarks.record?.continuation.seq, '3')
})

test('a cold open dataset forwards the first partition created after rollout initialization', async () => {
  let count = 0
  const { sink, calls, watermarks, rollouts, log, storage } = buildSink({
    count: () => count,
    signal: 'claude_telemetry',
  })
  const dataset = {
    ...makeQuery('claude_telemetry').getDataset('claude_telemetry_events'),
    discoverPartitions: async () => [],
  }
  await initializeOpenDatasetRollouts({
    query: /** @type {any} */ ({ listDatasets: () => [dataset] }),
    storage: /** @type {any} */ (storage),
    watermarks: /** @type {any} */ (watermarks),
    rollouts: /** @type {any} */ (rollouts),
    log: /** @type {any} */ (log),
  })
  assert.deepEqual(rollouts.record?.partitions, [])

  count = 2
  const result = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))

  assert.equal(result.status, 'exported')
  assert.deepEqual(calls.map((call) => call.method), ['PUT', 'POST'])
  assert.deepEqual(calls[1].lines.map((line) => JSON.parse(line).message_id), ['m0', 'm1'])
  assert.equal(watermarks.writes[0].continuation.seq, '0')
  assert.equal(watermarks.record?.continuation.seq, '2')
  assert.deepEqual(rollouts.record?.partitions, ['source=claude'])
})

test('rollout initialization baselines the source=unknown partition created by flushing Claude all', async () => {
  const spoolPath = '/cache/claude_telemetry_events/all'
  const committedPath = '/cache/claude_telemetry_events/source=unknown'
  let pending = true
  let committed = false
  const storage = {
    cacheRoot: '/cache',
    tableExists(path) {
      return path === spoolPath ? pending : path === committedPath && committed
    },
    hasPendingSync: (path) => path === spoolPath && pending,
    async flushTable(path) {
      assert.equal(path, spoolPath)
      pending = false
      committed = true
    },
    async *readRowsSince(path) {
      assert.equal(path, committedPath)
      for (let i = 1; i <= 3; i += 1) {
        yield { row: { event_name: `event_${i}` }, after: { v: 1, seq: String(i) } }
      }
    },
  }
  const records = new Map()
  const watermarks = {
    keyFor(_cacheRoot, path) {
      return {
        dataset: 'claude_telemetry_events',
        partitionKey: path === committedPath ? 'source=unknown' : 'all',
      }
    },
    filePath: (key) => `/state/watermarks/${key.partitionKey}.json`,
    async read(key) { return records.get(key.partitionKey) ?? null },
    async write(key, update) {
      const record = { v: 1, continuation: update.continuation, exportedRowCount: update.exportedRowCount ?? 0, updatedAt: '' }
      records.set(key.partitionKey, record)
      return record
    },
  }
  const dataset = {
    ...makeQuery('claude_telemetry').getDataset('claude_telemetry_events'),
    async discoverPartitions() {
      return pending
        ? [{ dataset: 'claude_telemetry_events', tablePath: spoolPath }]
        : [
            { dataset: 'claude_telemetry_events', tablePath: spoolPath },
            { dataset: 'claude_telemetry_events', tablePath: committedPath },
          ]
    },
  }
  const rollouts = makeRollouts()

  await initializeOpenDatasetRollouts({
    query: /** @type {any} */ ({ listDatasets: () => [dataset] }),
    storage: /** @type {any} */ (storage),
    watermarks: /** @type {any} */ (watermarks),
    rollouts: /** @type {any} */ (rollouts),
    log: /** @type {any} */ (makeLog()),
  })

  assert.equal(records.get('source=unknown')?.continuation.seq, '3')
  assert.equal(records.has('all'), false)
  assert.deepEqual(rollouts.record?.partitions, ['source=unknown'])
})

test('a future open-dataset partition starts at zero instead of inheriting rollout history rules', async () => {
  const { sink, calls, watermarks, rollouts } = buildSink({
    count: 2,
    signal: 'claude_telemetry',
    rollout: { ...INITIALIZED_EMPTY_ROLLOUT, partitions: ['source=older'] },
  })

  const result = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))

  assert.equal(result.status, 'exported')
  assert.equal(calls.filter((call) => call.method === 'POST')[0].rowCount, 2)
  assert.equal(watermarks.writes[0].continuation.seq, '0')
  assert.deepEqual(rollouts.record?.partitions, ['source=claude', 'source=older'])
})

test('an established open partition with missing progress fails closed', async () => {
  const { sink, calls } = buildSink({
    count: 2,
    signal: 'claude_telemetry',
    rollout: INITIALIZED_CLAUDE_ROLLOUT,
  })

  const result = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))

  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /rollout progress .* missing or invalid/)
  assert.equal(calls.length, 0)
})

test('a restarted sink preserves the rollout manifest and resumes its persisted progress', async () => {
  const { sink, calls, watermarks, rollouts } = buildSink({
    count: 12,
    signal: 'claude_telemetry',
    rollout: INITIALIZED_CLAUDE_ROLLOUT,
    watermark: {
      v: 1,
      continuation: { v: 1, seq: '10' },
      exportedRowCount: 0,
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
  })

  const result = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))

  assert.equal(result.status, 'exported')
  assert.deepEqual(calls.filter((call) => call.method === 'POST')[0].lines.map((line) => JSON.parse(line).message_id), ['m10', 'm11'])
  assert.equal(rollouts.writes.length, 0)
  assert.equal(watermarks.record?.continuation.seq, '12')
})

test('overlapping ticks admit a future partition once and forward it once', async () => {
  const { sink, calls, watermarks, rollouts } = buildSink({
    count: 2,
    signal: 'claude_telemetry',
    rollout: INITIALIZED_EMPTY_ROLLOUT,
  })

  const results = await Promise.all([
    sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({})),
    sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({})),
  ])

  assert.deepEqual(results.map((result) => result.status), ['exported', 'exported'])
  assert.equal(rollouts.writes.length, 1)
  assert.equal(watermarks.writes.filter((record) => record.continuation.seq === '0').length, 1)
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
})

test('an open-dataset baseline failure never falls back to historical ingest', async () => {
  const { sink, calls, watermarks } = buildSink({
    count: 10,
    signal: 'claude_telemetry',
  })
  watermarks.write = async () => { throw new Error('watermark disk unavailable') }

  const result = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))

  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /watermark disk unavailable/)
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0)
  // The baseline now precedes registration, so a local state failure makes no
  // remote call at all and the partition can retry without duplicate history.
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0)
})

test('an open-dataset registration outage does not move the local rollout baseline', async () => {
  let count = 10
  let putStatus = 500
  const { sink, calls, watermarks } = buildSink({
    count: () => count,
    signal: 'claude_telemetry',
    responder: (c) => (c.method === 'PUT' ? putStatus : 202),
  })

  const failed = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  assert.equal(failed.status, 'failed')
  assert.equal(watermarks.record?.continuation.seq, '10')

  count = 12
  putStatus = 202
  const retried = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  assert.equal(retried.status, 'exported')
  assert.deepEqual(calls.filter((c) => c.method === 'POST')[0].lines.map((line) => JSON.parse(line).message_id), ['m10', 'm11'])
})

test('overlapping first ticks share one open-dataset history baseline', async () => {
  const { sink, calls, watermarks, log } = buildSink({
    count: 10,
    signal: 'claude_telemetry',
  })

  const [first, second] = await Promise.all([
    sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({})),
    sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({})),
  ])

  assert.equal(first.status, 'exported')
  assert.equal(second.status, 'exported')
  assert.equal(watermarks.record?.continuation.seq, '10')
  assert.equal(
    log.rows.filter((r) => r.message === 'central.forward.initial_history_skipped').length,
    1
  )
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1)
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0)
})

test('overlapping ticks serialize one partition export', async () => {
  /** @type {() => void} */
  let releasePost = () => {}
  const postGate = new Promise((resolve) => { releasePost = () => resolve(undefined) })
  /** @type {() => void} */
  let postStartedResolve = () => {}
  const postStarted = new Promise((resolve) => { postStartedResolve = () => resolve(undefined) })
  const { sink, calls, watermarks } = buildSink({
    count: 10,
    signal: 'claude_telemetry',
    watermark: ZERO_WATERMARK,
    responder: async (call) => {
      if (call.method === 'POST') {
        postStartedResolve()
        await postGate
      }
      return 202
    },
  })

  const first = sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  await postStarted
  const second = sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  releasePost()
  const results = await Promise.all([first, second])

  assert.deepEqual(results.map((r) => r.status), ['exported', 'exported'])
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1)
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
  assert.equal(watermarks.writes.length, 1)
  assert.equal(watermarks.record?.continuation.seq, '10')
})

test('a missing open-dataset partition does not register a remote dataset', async () => {
  const { sink, calls, watermarks } = buildSink({
    count: 10,
    signal: 'claude_telemetry',
  })

  const result = await sink.exportBatch(
    /** @type {any} */ ({
      partitions: [{ dataset: 'claude_telemetry_events', tablePath: '/cache/missing' }],
    }),
    /** @type {any} */ ({})
  )

  assert.equal(result.status, 'exported')
  assert.equal(result.partitionsExported, 1)
  assert.equal(calls.length, 0)
  assert.equal(watermarks.record, null)
})

test('a rejected schema announce fails the partition and never reaches ingest', async () => {
  let putStatus = 500
  const { sink, calls } = buildSink({
    count: 10,
    signal: 'claude_telemetry',
    watermark: ZERO_WATERMARK,
    responder: (c) => (c.method === 'PUT' ? putStatus : 202),
  })

  const failed = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  assert.equal(failed.status, 'failed')
  assert.equal(failed.partitionsExported, 0)
  assert.equal(failed.retryPartitions?.length, 1)
  assert.match(String(failed.error), /PUT http:\/\/server:8740\/v1\/datasets\/claude_telemetry_events/)
  // Registration gates ingest: no rows go to a dataset the server has not
  // been told the schema of.
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0)

  // A failed announce is not remembered, so the driver's next tick retries it
  // rather than POSTing into an unregistered dataset forever.
  putStatus = 200
  const ok = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  assert.equal(ok.status, 'exported')
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 2)
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
})

test('a schema announce 401 refreshes once and retries the same registration', async () => {
  let putCalls = 0
  const { sink, calls, identityClient } = buildSink({
    count: 10,
    signal: 'claude_telemetry',
    watermark: ZERO_WATERMARK,
    responder: (c) => c.method === 'PUT' && ++putCalls === 1 ? 401 : 202,
  })

  const result = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))

  assert.equal(result.status, 'exported')
  assert.equal(identityClient.refreshes, 1)
  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'PUT', 'POST'])
  assert.deepEqual(calls[0].lines, calls[1].lines)
})

test('an older server holds an open dataset locally and re-probes slowly', async () => {
  let count = 10
  let now = 0
  let supportsRegistration = false
  const { sink, calls } = buildSink({
    count: () => count,
    signal: 'claude_telemetry',
    nowFn: () => now,
    responder: (c) => c.method === 'PUT' && !supportsRegistration ? 404 : 202,
  })

  const first = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  assert.equal(first.status, 'exported')
  assert.deepEqual(calls.map((c) => c.method), ['PUT'])

  count = 12
  now = 60_000
  await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  assert.deepEqual(calls.map((c) => c.method), ['PUT'])

  supportsRegistration = true
  now = 5 * 60_000 + 1
  await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))
  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'PUT', 'POST'])
  assert.deepEqual(calls[2].lines.map((line) => JSON.parse(line).message_id), ['m10', 'm11'])
})

test('an unresolvable dataset fails only its own partition', async () => {
  // The per-partition isolation the sink documents: resolving the wire target
  // can throw, and a throw that escapes `exportBatch` costs the whole batch
  // (the driver respools every partition and reports zero exported).
  const query = {
    /** @param {string} name */
    getDataset: (name) => (name === 'ghost_dataset'
      ? undefined
      : { name, plugin: '@hypaware/test', schema: { columns: [] }, sourceSignal: 'logs' }),
  }
  const { sink, calls } = buildSink({ count: 10, query })

  const result = await sink.exportBatch(
    /** @type {any} */ ({
      partitions: [
        { dataset: 'ghost_dataset', tablePath: TABLE },
        { dataset: 'ai_gateway_messages', tablePath: TABLE },
      ],
    }),
    /** @type {any} */ ({})
  )

  assert.equal(result.status, 'partial')
  assert.equal(result.partitionsExported, 1)
  assert.deepEqual(result.retryPartitions?.map((p) => p.dataset), ['ghost_dataset'])
  assert.match(String(result.error), /not registered locally/)
  // the healthy partition still shipped
  assert.deepEqual(calls.map((c) => c.url), ['http://server:8740/v1/ingest/logs'])
})

test('an open dataset with local-only content columns is withheld, not retried', async () => {
  // Ineligibility is a permanent verdict, so it must never reach
  // `retryPartitions`: the driver writes one outbox file per non-ok result and
  // nothing drains it, so retrying it is unbounded state growth plus a sink
  // stuck at `partial` for a condition LLP 0305 calls correct.
  const query = makeQuery(null)
  const { sink, calls, log } = buildSink({
    count: 10,
    query: {
      getDataset(name) {
        return { ...query.getDataset(name), localOnlyContentColumns: ['content_text'] }
      },
    },
  })

  const first = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  const second = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))

  assert.equal(first.status, 'exported')
  assert.equal(first.partitionsExported, 0)
  assert.equal(first.retryPartitions, undefined)
  assert.equal(second.status, 'exported')
  assert.equal(calls.length, 0, 'neither announced nor ingested')

  const withheld = log.rows.filter((r) => r.message === 'central.forward.dataset_withheld')
  assert.equal(withheld.length, 1, 'stated once per sink instance, not once per tick')
  assert.equal(withheld[0].level, 'info')
  assert.match(String(withheld[0].fields.reason), /local-only content columns/)
})

test('a withheld dataset does not stop a sibling partition from shipping', async () => {
  const base = makeQuery('logs')
  const { sink, calls } = buildSink({
    count: 10,
    query: {
      getDataset(name) {
        const dataset = /** @type {Record<string, unknown>} */ (base.getDataset(name))
        return name === 'node'
          ? { ...dataset, sourceSignal: undefined, localOnlyContentColumns: ['label'] }
          : dataset
      },
    },
  })

  const result = await sink.exportBatch(
    /** @type {any} */ ({
      partitions: [
        { dataset: 'node', tablePath: TABLE },
        { dataset: 'ai_gateway_messages', tablePath: TABLE },
      ],
    }),
    /** @type {any} */ ({})
  )

  assert.equal(result.status, 'exported')
  assert.equal(result.partitionsExported, 1)
  assert.deepEqual(calls.map((c) => c.url), ['http://server:8740/v1/ingest/logs'])
})

test('a present-but-unreadable watermark fails the open-dataset partition instead of re-baselining', async () => {
  // `SinkWatermarkStore.read` returns null for a corrupt watermark exactly as it
  // does for a missing one, and never throws, so the caller's catch cannot tell
  // them apart. Baselining there would jump the cursor to the current high-water
  // and permanently drop every row this sink still owes central: silent
  // at-most-once loss where LLP 0040 promises at-least-once.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-watermark-'))
  const watermarkFilePath = path.join(dir, 'source=claude.json')
  await fsp.writeFile(watermarkFilePath, '{ "continuation": ', 'utf8')
  try {
    const { sink, calls, watermarks } = buildSink({
      count: 10,
      signal: 'claude_telemetry',
      rollout: INITIALIZED_CLAUDE_ROLLOUT,
      watermarkFilePath,
    })

    const result = await sink.exportBatch(/** @type {any} */ (TELEMETRY_BATCH), /** @type {any} */ ({}))

    assert.equal(result.status, 'failed')
    assert.deepEqual(result.retryPartitions?.map((p) => p.dataset), ['claude_telemetry_events'])
    assert.match(String(result.error), /rollout progress .* missing or invalid/)
    assert.equal(watermarks.record, null, 'the watermark is not jumped forward')
    assert.equal(calls.length, 0, 'nothing announced, nothing ingested')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('an open dataset cannot claim a reserved legacy ingest path', async () => {
  const query = {
    getDataset: () => ({
      name: 'proxy',
      plugin: '@hypaware/test',
      schema: { columns: [] },
      sourceSignal: 'custom',
    }),
  }
  const { sink, calls, log } = buildSink({ count: 10, query })

  const result = await sink.exportBatch(
    /** @type {any} */ ({ partitions: [{ dataset: 'proxy', tablePath: TABLE }] }),
    /** @type {any} */ ({})
  )

  // Permanent like the local-only withhold, so it is skipped rather than
  // retried, but it is a plugin bug rather than a policy outcome: warn, not info.
  assert.equal(result.status, 'exported')
  assert.equal(result.partitionsExported, 0)
  assert.equal(result.retryPartitions, undefined)
  assert.equal(calls.length, 0)
  const withheld = log.rows.filter((r) => r.message === 'central.forward.dataset_withheld')
  assert.equal(withheld.length, 1)
  assert.equal(withheld[0].level, 'warn')
  assert.match(String(withheld[0].fields.reason), /reserved by a legacy ingest path/)
})

test('a reserved dataset name with no sourceSignal is withheld before it can impersonate a legacy path', async () => {
  const query = {
    getDataset: () => ({
      name: 'proxy',
      plugin: '@hypaware/test',
      schema: { columns: [] },
    }),
  }
  const { sink, calls, log } = buildSink({ count: 10, query })

  const result = await sink.exportBatch(
    /** @type {any} */ ({ partitions: [{ dataset: 'proxy', tablePath: TABLE }] }),
    /** @type {any} */ ({})
  )

  assert.equal(result.status, 'exported')
  assert.equal(result.partitionsExported, 0)
  assert.equal(result.retryPartitions, undefined)
  assert.equal(calls.length, 0)
  const withheld = log.rows.filter((row) => row.message === 'central.forward.dataset_withheld')
  assert.equal(withheld.length, 1)
  assert.equal(withheld[0].level, 'warn')
  assert.match(String(withheld[0].fields.reason), /reserved by a legacy ingest path/)
})

// Mirrors MAX_CHUNK_BYTES in sink.js; the byte budget is otherwise
// module-internal.
const MAX_CHUNK_BYTES = 4 * 1024 * 1024

test('the byte budget splits wide rows even when the row count is tiny', async () => {
  // 10 rows of ~1 MiB each: MAX_CHUNK_ROWS (5000) never trips, so only
  // the byte budget governs. This is the bound that actually prevents
  // the OOM/oversized-body for wide `content_text`: the row-count tests
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
  // two waits (240s) fit and the third would cross it: the chunk throws
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
  assert.equal(calls[0].rowCount, 3) // not 10 - the prefix is skipped
  // watermark advanced to the last row's seq, count carried forward
  assert.equal(watermarks.record?.continuation.seq, '10')
  assert.equal(watermarks.record?.exportedRowCount, 10)
})

test('the watermark advances once, at end-of-partition, to the high-water after', async () => {
  // 12000 rows -> chunks of 5000,5000,2000. The watermark is NOT advanced per
  // chunk (that would be unsafe under an unordered scan: a chunk's running-max
  // `after` could skip lower-seq rows in a later chunk, LLP 0040 §4 risk #3).
  // It advances exactly once, after every chunk acks, to the partition max.
  const { sink, watermarks } = buildSink({ count: 12_000 })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(watermarks.writes.length, 1, 'one watermark write per partition, not per chunk')
  assert.equal(watermarks.writes[0].continuation.seq, '12000')
  assert.equal(watermarks.writes[0].exportedRowCount, 12_000)
  assert.equal(watermarks.record?.continuation.seq, '12000')
})

test('a mid-partition failure leaves the watermark unadvanced (no partial checkpoint)', async () => {
  // Fail the 2nd chunk: chunk 0 acked but chunk 1 did not. Because the watermark
  // advances only at end-of-partition, a partial partition NEVER checkpoints, so
  // the next tick re-reads the whole partition (the server ledger dedupes the
  // already-acked prefix). Advancing to chunk 0's running-max `after` here would
  // risk skipping lower-seq rows in the un-acked chunk 1 forever.
  let n = 0
  const { sink, watermarks } = buildSink({ count: 12_000, responder: () => (++n === 2 ? 500 : 202) })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'failed')
  assert.equal(watermarks.writes.length, 0, 'no checkpoint past an un-acked chunk')
  assert.equal(watermarks.record, null)
})

test('a respool re-reads the whole partition with STABLE batch-ids (ledger-dedups the acked prefix)', async () => {
  // Cross-tick idempotency: tick 1 acks chunk 0 (seq 5000) then chunk 1 fails
  // AFTER the server may have committed it. Because the partition did not
  // complete, the watermark is NOT advanced, so tick 2 re-reads the whole
  // partition. The re-sent prefix chunks MUST carry the batch-ids they had in
  // tick 1 so the server ledger drops the redelivery; an id keyed on the
  // per-tick chunk ordinal would still be stable here, but keying on the chunk
  // start seq keeps it stable even when the watermark DOES advance elsewhere.
  let n = 0
  const built = buildSink({ count: 12_000, responder: () => (++n === 2 ? 500 : 202) })
  const r1 = await built.sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(r1.status, 'failed')
  assert.equal(built.calls.length, 2) // chunk 0 (202) + chunk 1 (500), then stop
  assert.equal(built.watermarks.writes.length, 0, 'partial partition does not checkpoint')
  const tick1Chunk0BatchId = built.calls[0].batchId
  const tick1Chunk1BatchId = built.calls[1].batchId

  // Tick 2: same sink, server now healthy. The respool re-reads the whole
  // partition (no advanced watermark) and replays every chunk.
  const r2 = await built.sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(r2.status, 'exported')
  const tick2 = built.calls.slice(2)
  assert.deepEqual(tick2.map((c) => c.rowCount), [5000, 5000, 2000], 'whole partition re-read')
  assert.equal(
    tick2[0].batchId,
    tick1Chunk0BatchId,
    'acked prefix chunk re-sends with its tick-1 batch-id (server dedupes the redelivery)'
  )
  assert.equal(
    tick2[1].batchId,
    tick1Chunk1BatchId,
    'the previously-failed chunk re-sends with a stable batch-id too'
  )
  assert.equal(built.watermarks.record?.continuation.seq, '12000')
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

test('an unordered scan never skips a lower-seq row when a later chunk fails (BLOCKER, LLP 0040 §4 risk #3)', async () => {
  // The scan is NOT seq-ordered: a high-seq row leads the partition, so the
  // running-max `after` saturates inside chunk 0 while chunk 1 holds LOWER seqs.
  // Per-chunk advance would jump the watermark past chunk 1's rows on the
  // chunk-0 ack; a chunk-1 failure would then strip them from every future
  // `seq > watermark` read: silent permanent data loss. End-of-partition advance
  // refuses to checkpoint a partial partition, so the next tick re-reads them.
  const TOTAL = 5006 // chunk 0 = 5000 rows (MAX_CHUNK_ROWS), chunk 1 = 6 rows
  /** @type {{ id: number, seq: bigint }[]} */
  const physical = [{ id: 0, seq: 1_000_000n }] // high seq first -> running max saturates
  for (let i = 1; i < 5000; i += 1) physical.push({ id: i, seq: BigInt(i) })
  for (let i = 5000; i < TOTAL; i += 1) physical.push({ id: i, seq: BigInt(i) }) // chunk 1: low seqs

  const storage = {
    cacheRoot: '/cache',
    /** @param {string} p */
    tableExists: (p) => p === TABLE,
    async flushTable() {},
    /**
     * @param {string} _p
     * @param {{ since?: { v: 1, seq: string } }} [opts]
     */
    async *readRowsSince(_p, opts) {
      const since = opts?.since ? BigInt(opts.since.seq) : 0n
      let high = since
      for (const { id, seq } of physical) {
        if (seq <= since) continue // mirrors the real since-filter
        if (seq > high) high = seq // `after` is a RUNNING MAX, not the row's own seq
        yield { row: { id }, after: { v: 1, seq: high.toString() } }
      }
    },
  }

  // Fail chunk 1 the FIRST time it is POSTed (tick 1); accept it on the retry.
  let chunk1Failed = false
  /** @type {number[]} */
  const acked = []
  /** @type {typeof fetch} */
  const fetchFn = /** @type {any} */ (async (_url, init) => {
    const body = String(init?.body ?? '')
    const ids = body.split('\n').filter((l) => l.length > 0).map((l) => Number(JSON.parse(l).id))
    const isChunk1 = ids.includes(5000)
    let status = 202
    if (isChunk1 && !chunk1Failed) { chunk1Failed = true; status = 500 }
    if (status === 202) acked.push(...ids)
    return /** @type {any} */ ({
      status, ok: status >= 200 && status < 300,
      headers: { get: () => null }, async text() { return '' }, body: { cancel: async () => {} },
    })
  })

  const watermarks = makeWatermarks(null)
  const sink = createForwardSink({
    config: /** @type {any} */ ({ url: 'http://server:8740', identity: {} }),
    identityClient: /** @type {any} */ (makeIdentity()),
    query: /** @type {any} */ (makeQuery('logs')),
    storage: /** @type {any} */ (storage),
    watermarks: /** @type {any} */ (watermarks),
    rollouts: /** @type {any} */ (makeRollouts()),
    log: /** @type {any} */ (makeLog()),
    fetchFn,
    sleepFn: async () => {},
  })

  // Tick 1: chunk 0 acks, chunk 1 fails -> partition fails.
  const r1 = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(r1.status, 'failed')

  // Tick 2: server healthy. The whole partition re-reads (watermark unadvanced),
  // so the low-seq chunk-1 rows are delivered, never skipped.
  const r2 = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(r2.status, 'exported')

  for (let i = 5000; i < TOTAL; i += 1) {
    assert.ok(acked.includes(i), `low-seq row ${i} from the previously-failed chunk was delivered (no skip)`)
  }
  assert.equal(new Set(acked).size, TOTAL, 'every row delivered exactly once across the retry')
  assert.equal(watermarks.record?.continuation.seq, '1000000', 'watermark advances only after the whole partition acks')
})
