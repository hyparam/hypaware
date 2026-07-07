// @ts-check

// The central forward sink honours the export-seam `local-only` drop
// (LLP 0070/0080, task T3): a withheld row is never POSTed, but its `after`
// still advances the per-(sink, partition) watermark so the tail is durably
// passed — not re-scanned each tick, not re-sent if the directory is later
// un-excluded. A failed chunk still never checkpoints, even amid drops.

import test from 'node:test'
import assert from 'node:assert/strict'

import { createForwardSink } from '../../hypaware-core/plugins-workspace/central/src/sink.js'

const TABLE = '/cache/ai_gateway_messages/source=claude'
const batch = { partitions: [{ dataset: 'ai_gateway_messages', tablePath: TABLE }] }

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
 * Storage stub whose `readRowsSince` yields a described entry sequence honouring
 * `seq > since`: a payload row `{ seq, id }` or a drop `{ seq, drop: true }`
 * carrying only the advancing `after`. `throwImmediately` models a corrupt
 * local-only list: the first resolve throws and fails the partition read.
 *
 * @param {Array<{ seq: number, id?: string, drop?: boolean }>} entries
 * @param {{ throwImmediately?: boolean }} [opts]
 */
function makeStorage(entries, { throwImmediately = false } = {}) {
  return {
    cacheRoot: '/cache',
    /** @param {string} p */
    tableExists: (p) => p === TABLE,
    async flushTable() {},
    /** @param {string} _p @param {{ since?: { v: 1, seq: string } }} [opts] */
    readRowsSince(_p, opts) {
      const since = opts?.since ? BigInt(opts.since.seq) : 0n
      return {
        async *[Symbol.asyncIterator]() {
          if (throwImmediately) {
            throw new Error("local-only list at '/state/usage-policy/local-only.json' is unreadable or malformed")
          }
          let high = since
          for (const e of entries) {
            const seq = BigInt(e.seq)
            if (seq <= since) continue
            if (seq > high) high = seq
            const after = { v: 1, seq: high.toString() }
            if (e.drop) yield { after, dropped: true }
            else yield { row: { id: e.id, content_text: e.id }, after }
          }
        },
      }
    },
  }
}

/** @param {{ v: 1, continuation: { v: 1, seq: string }, exportedRowCount: number, updatedAt: string } | null} [initial] */
function makeWatermarks(initial) {
  let record = initial ?? null
  /** @type {Array<{ continuation: { v: 1, seq: string }, exportedRowCount: number }>} */
  const writes = []
  return {
    get record() { return record },
    get writes() { return writes },
    keyFor: () => ({ dataset: 'ai_gateway_messages', partitionKey: 'source=claude' }),
    filePath: () => '/state/watermarks/ai_gateway_messages/source=claude.json',
    async read() { return record },
    /** @param {any} _key @param {{ continuation: { v: 1, seq: string }, exportedRowCount?: number }} update */
    async write(_key, update) {
      record = { v: 1, continuation: update.continuation, exportedRowCount: update.exportedRowCount ?? 0, updatedAt: '' }
      writes.push({ continuation: update.continuation, exportedRowCount: update.exportedRowCount ?? 0 })
      return record
    },
  }
}

/**
 * @param {{ storage: any, watermarks: any, responder?: (c: { ids: string[] }) => number }} deps
 */
function makeSink({ storage, watermarks, responder }) {
  const log = makeLog()
  /** @type {Array<{ ids: string[] }>} */
  const calls = []
  /** @type {typeof fetch} */
  const fetchFn = /** @type {any} */ (async (_url, init) => {
    const body = String(init?.body ?? '')
    const ids = body.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l).id)
    const call = { ids }
    calls.push(call)
    const status = responder ? responder(call) : 202
    return /** @type {any} */ ({
      status, ok: status >= 200 && status < 300,
      headers: { get: () => null }, async text() { return '' }, body: { cancel: async () => {} },
    })
  })
  const sink = createForwardSink({
    config: /** @type {any} */ ({ url: 'http://server:8740', identity: {} }),
    identityClient: /** @type {any} */ ({ async getCurrentJwt() { return 'jwt' }, async refresh() {} }),
    query: /** @type {any} */ ({ getDataset: () => ({ sourceSignal: 'logs' }) }),
    storage: /** @type {any} */ (storage),
    watermarks: /** @type {any} */ (watermarks),
    log: /** @type {any} */ (log),
    fetchFn,
    sleepFn: async () => {},
  })
  return { sink, calls, log, watermarks }
}

test('a drop-only tick POSTs nothing yet checkpoints past the withheld rows', async () => {
  const storage = makeStorage([
    { seq: 1, drop: true },
    { seq: 2, drop: true },
  ])
  const watermarks = makeWatermarks(null)
  const { sink, calls, log } = makeSink({ storage, watermarks })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))

  assert.equal(result.status, 'exported')
  assert.equal(result.bytesWritten, 0)
  assert.equal(calls.length, 0, 'a withheld row never reaches the wire')
  // ship-nothing/advance-anyway: the watermark moves past the local-only tail.
  assert.equal(watermarks.writes.length, 1, 'the drop-only tick still checkpoints')
  assert.equal(watermarks.record?.continuation.seq, '2')
  assert.equal(watermarks.record?.exportedRowCount, 0, 'a dropped row is never counted as exported')
  assert.ok(log.rows.some((r) => r.message === 'central.forward.dropped' && r.fields.dropped_row_count === 2))
})

test('a mixed tick ships only the full rows and advances to the partition high-water', async () => {
  const storage = makeStorage([
    { seq: 1, id: 'a' }, // full
    { seq: 2, drop: true }, // local-only
    { seq: 3, id: 'c' }, // full
  ])
  const watermarks = makeWatermarks(null)
  const { sink, calls } = makeSink({ storage, watermarks })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))

  assert.equal(result.status, 'exported')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].ids, ['a', 'c'], 'the withheld row is absent from the forward payload')
  assert.equal(watermarks.record?.continuation.seq, '3', 'watermark reaches the high-water, across the drop')
  assert.equal(watermarks.record?.exportedRowCount, 2, 'only the two shipped rows count as exported')
})

test('a directory un-excluded AFTER a drop-only checkpoint is not re-sent (durably passed)', async () => {
  // Tick 1: both rows are local-only ⇒ dropped, watermark advances to seq 2.
  const watermarks = makeWatermarks(null)
  const s1 = makeStorage([{ seq: 1, drop: true }, { seq: 2, drop: true }])
  const t1 = makeSink({ storage: s1, watermarks })
  await t1.sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(watermarks.record?.continuation.seq, '2')

  // Tick 2: the same two rows are now `full` (directory un-excluded). Because the
  // watermark already advanced past them, `readRowsSince({ since })` never re-reads
  // them, so they are not re-sent — LLP 0069 non-goal 1 (no re-send of passed history).
  const s2 = makeStorage([{ seq: 1, id: 'a' }, { seq: 2, id: 'b' }])
  const t2 = makeSink({ storage: s2, watermarks })
  const result = await t2.sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(t2.calls.length, 0, 'already-passed rows are not resurfaced on un-exclusion')
  assert.equal(watermarks.record?.continuation.seq, '2', 'watermark unchanged: nothing new to read')
})

test('a failed chunk never checkpoints, even when the partition also dropped rows', async () => {
  // A drop precedes two full rows; the single chunk POST fails. The watermark
  // write is after the loop and after every chunk acks, so a failed chunk throws
  // before it — no checkpoint, despite the earlier drop having advanced lastAfter.
  const storage = makeStorage([
    { seq: 1, drop: true },
    { seq: 2, id: 'a' },
    { seq: 3, id: 'b' },
  ])
  const watermarks = makeWatermarks(null)
  const { sink, calls } = makeSink({ storage, watermarks, responder: () => 500 })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))

  assert.equal(result.status, 'failed')
  assert.equal(result.retryPartitions?.length, 1)
  assert.equal(calls.length, 1, 'the one chunk was attempted and failed')
  assert.equal(watermarks.writes.length, 0, 'a failed chunk never advances the watermark')
  assert.equal(watermarks.record, null)
})

test('a corrupt local-only list fails the tick with the watermark untouched', async () => {
  const storage = makeStorage([{ seq: 1, id: 'a' }], { throwImmediately: true })
  const watermarks = makeWatermarks(null)
  const { sink, calls } = makeSink({ storage, watermarks })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))

  assert.equal(result.status, 'failed', 'an uninterpretable privacy signal fails the partition read')
  assert.equal(result.retryPartitions?.length, 1)
  assert.equal(calls.length, 0)
  assert.equal(watermarks.writes.length, 0, 'the watermark is untouched: the next tick retries after the fix')
})

test('cwd-less datasets are unaffected: a partition with no drops ships and advances exactly as before', async () => {
  const storage = makeStorage([{ seq: 1, id: 'a' }, { seq: 2, id: 'b' }])
  const watermarks = makeWatermarks(null)
  const { sink, calls } = makeSink({ storage, watermarks })
  const result = await sink.exportBatch(/** @type {any} */ (batch), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].ids, ['a', 'b'])
  assert.equal(watermarks.record?.continuation.seq, '2')
  assert.equal(watermarks.record?.exportedRowCount, 2)
})
