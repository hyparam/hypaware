// @ts-check

import assert from 'node:assert/strict'
import path from 'node:path'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { createSinkWatermarkStore } from '../../src/core/sinks/watermarks.js'
import { createForwardSink } from '../../hypaware-core/plugins-workspace/central/src/sink.js'
import { readRequestBody } from './request_body.js'

const root = process.argv[2]
const tablePath = path.join(root, 'datasets/ai_gateway_messages/source=claude')
const storage = createQueryStorageService({
  cacheRoot: root,
  usagePolicyResolver: /** @type {any} */ ({ resolve: (/** @type {string} */ cwd) => ({ class: cwd === '/private' ? 'local-only' : 'full' }) }),
})
const watermarks = createSinkWatermarkStore({ stateDir: path.join(root, 'state') })
const key = watermarks.keyFor(root, tablePath)
const expectedDescription = '界'.repeat(4096)
const persisted = new Set()
const acknowledged = new Set()
const events = []
let requests = 0
let retries = 0
let replayed = 0
let fail = true
let peakHeap = 0
let decodedDescriptions = 0
const started = performance.now()
const decode = TextDecoder.prototype.decode
TextDecoder.prototype.decode = function (input, options) {
  // Each synthetic description is exactly 12 KiB of UTF-8. Count work at
  // the real decoder to catch repeatedly expanding an entire group per window.
  if (input?.byteLength === 4096 * 3) decodedDescriptions++
  return decode.call(this, input, options)
}

const sink = createForwardSink({
  config: /** @type {any} */ ({ url: 'http://fixture' }),
  identityClient: /** @type {any} */ ({ async getCurrentJwt() { return 'synthetic' } }),
  query: /** @type {any} */ ({ getDataset: () => ({ sourceSignal: 'proxy' }) }),
  storage,
  watermarks,
  rollouts: /** @type {any} */ ({}), // Legacy proxy signal has no rollout.
  log: /** @type {any} */ ({
    info() {}, warn() {}, error() {},
    debug(/** @type {string} */ event) {
      events.push(event)
      if (event === 'central.forward.chunk') {
        global.gc?.()
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
      }
    },
  }),
  sleepFn: async () => { retries++ },
  fetchFn: /** @type {typeof fetch} */ (async (_url, init) => {
    requests++
    const body = await readRequestBody(init?.body)
    if (requests <= 2) return new Response('', { status: requests === 1 ? 503 : 429, headers: { 'retry-after': '1' } })
    if (fail && acknowledged.size === 3) return new Response('', { status: 500 })
    const batchId = new Headers(init?.headers).get('x-hyp-batch-id')
    if (acknowledged.has(batchId)) {
      replayed++
      return new Response('', { status: 202 })
    }
    for (const line of body.trimEnd().split('\n')) {
      const row = JSON.parse(line)
      const id = Number(row.message_id)
      assert.equal(row.cwd, '/shared')
      assert.notEqual(id % 17, 0)
      assert.notEqual(id, 4095)
      assert.equal(row.tools.length, 8)
      assert.equal(row.tools[0].description, expectedDescription)
      assert.equal(row.tools[7].input_schema.properties.value.type, 'string')
      assert.equal(row._hyp_ingest_seq, undefined)
      assert.ok(!persisted.has(id), `duplicate persisted row ${id}`)
      persisted.add(id)
    }
    acknowledged.add(batchId)
    return new Response('', { status: 202 })
  }),
})

try {
  const found = []
  assert.ok(storage.readRowsWhere)
  for await (const row of storage.readRowsWhere(tablePath, ['message_id', 'tools'], { message_id: ['1', '2048', '4080'] })) {
    assert.ok(Array.isArray(row.tools))
    assert.equal(row.tools[0].description, expectedDescription)
    found.push(row.message_id)
  }
  assert.deepEqual(found, ['1', '2048', '4080'], 'sparse selections retain their physical row positions')
  const batch = { batchId: 'memory-fixture', partitions: [{ dataset: 'ai_gateway_messages', tablePath, partition: {} }] }
  const failed = await sink.exportBatch(batch, /** @type {any} */ ({}))
  assert.equal(failed.status, 'failed')
  assert.equal(await watermarks.read(key), null, 'partial partition must not checkpoint')
  assert.equal(acknowledged.size, 3)
  fail = false
  const completed = await sink.exportBatch(batch, /** @type {any} */ ({}))
  assert.equal(completed.status, 'exported')
  assert.equal(replayed, 3, 'retry must reuse the acknowledged prefix batch IDs')
  const record = await watermarks.read(key)
  assert.equal(record?.continuation.seq, '4096')
  assert.equal(record?.exportedRowCount, persisted.size)
  for (let i = 0; i < 4096; i++) assert.equal(persisted.has(i), i % 17 !== 0 && i !== 4095)
  const before = requests
  await sink.exportBatch(batch, /** @type {any} */ ({}))
  assert.equal(requests, before, 'completed partition must not send again')
  assert.equal(retries, 2)
  assert.equal(events.filter(e => e === 'central.forward.backpressure').length, 2)
  assert.ok(events.includes('central.forward.dropped'))
  assert.ok(decodedDescriptions < 4096 * 8 * 2, `expanded descriptions ${decodedDescriptions} must stay proportional to rows`)
  console.log(JSON.stringify({ status: 'ok', rows: persisted.size, peakHeap, requests, replayed, retries, decodedDescriptions, elapsedMs: performance.now() - started }))
} finally {
  TextDecoder.prototype.decode = decode
  await sink.close()
}
