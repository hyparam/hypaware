// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { activate } from '../../hypaware-core/plugins-workspace/s3/src/index.js'

const CACHE_ROOT = '/cache'

/** @returns {Promise<string>} */
async function tmpStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-s3-export-'))
}

/**
 * A storage mock whose `readRowsSince` yields the rows registered for each
 * logical table path, honouring the `seq > since` filter and emitting the
 * monotonic high-water `after` token the real kernel produces. Rows are
 * `{ _seq, ...payload }`; `_seq` is stripped before the row is yielded.
 *
 * @param {Record<string, Array<{ _seq: number } & Record<string, unknown>>>} [rowsByTable]
 */
function makeStorage(rowsByTable = {}) {
  return {
    cacheRoot: CACHE_ROOT,
    /** @param {string} tp */
    tableExists: (tp) => Boolean(tp) && tp in rowsByTable,
    /** @param {string} tablePath @param {{ since?: { seq: string } }} [opts] */
    readRowsSince(tablePath, opts) {
      const rows = rowsByTable[tablePath] ?? []
      const sinceSeq = opts?.since ? BigInt(opts.since.seq) : 0n
      return {
        async *[Symbol.asyncIterator]() {
          let high = sinceSeq
          for (const r of rows) {
            const seq = BigInt(r._seq)
            if (seq <= sinceSeq) continue
            if (seq > high) high = seq
            const { _seq, ...row } = r
            yield { row, after: { v: 1, seq: high.toString() } }
          }
        },
      }
    },
    readRows() {
      return { async *[Symbol.asyncIterator]() {} }
    },
  }
}

/** A fake encoder that drains `ctx.rows` (as every real encoder must). */
function makeEncoder(format = 'jsonl') {
  return {
    format,
    extension: format,
    supports: ['queryable'],
    /** @param {any} partition @param {any} ctx */
    async encodePartition(partition, ctx) {
      let rowCount = 0
      for await (const _row of ctx.rows ?? []) rowCount++
      const bytes = new TextEncoder().encode('{}\n')
      return {
        filename: `${partition.dataset}.${format}`,
        bytes,
        bytesWritten: bytes.byteLength,
        rowCount,
      }
    },
  }
}

/**
 * Activate the s3 plugin against a captured context backed by `storage`,
 * returning the registered sink descriptor.
 *
 * @param {ReturnType<typeof makeStorage>} storage
 * @param {{ query?: any }} [opts]
 */
async function activatePlugin(storage, opts = {}) {
  /** @type {any} */
  let registered
  /** @type {any} */
  const ctx = {
    provideCapability() {},
    sinks: { register(/** @type {any} */ d) { registered = d } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    query: opts.query ?? { getDataset: () => undefined, listDatasets: () => [] },
    storage,
  }
  await activate(ctx)
  if (!registered) throw new Error('plugin did not register a sink')
  return registered
}

/**
 * @param {{ clientFactory: any, stateDir: string, encoder?: any }} args
 */
function makeSinkCtx({ clientFactory, stateDir, encoder }) {
  return {
    name: 'test',
    config: {
      bucket: 'test-bucket',
      prefix: 'p',
      __clientFactory: clientFactory,
    },
    encoder: encoder ?? makeEncoder(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    paths: { tempDir: '/tmp', stateDir },
  }
}

/** A partition whose logical path sits under the cache datasets root. */
function partitionFor(dataset) {
  return { dataset, partition: {}, tablePath: `${CACHE_ROOT}/datasets/${dataset}/source=x` }
}

test('exportBatch terminal failure: retryPartitions excludes already-uploaded partitions', async (t) => {
  const stateDir = await tmpStateDir()
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const storage = makeStorage({
    [`${CACHE_ROOT}/datasets/p1/source=x`]: [{ _seq: 1, id: 1 }],
    [`${CACHE_ROOT}/datasets/p2/source=x`]: [{ _seq: 1, id: 1 }],
  })
  const registration = await activatePlugin(storage)
  /** @type {Array<{ Key: string }>} */
  const putCalls = []
  const fakeClient = {
    async putObject(/** @type {any} */ input) {
      putCalls.push({ Key: input.Key })
      if (putCalls.length === 1) return {} // p1 succeeds
      const err = Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      })
      throw err
    },
    destroy() {},
  }
  const clientFactory = async () => ({ client: fakeClient, credential_source_kind: 'injected' })

  const sink = await registration.create(makeSinkCtx({ clientFactory, stateDir }))
  const result = await sink.exportBatch(
    { batchId: 'b1', partitions: [partitionFor('p1'), partitionFor('p2')] },
    {}
  )

  assert.equal(result.status, 'failed', 'terminal failure must produce failed status')
  assert.equal(result.partitionsExported, 1, 'p1 was uploaded successfully')
  assert.ok(Array.isArray(result.retryPartitions), 'retryPartitions must be set on terminal failure')
  assert.equal(result.retryPartitions.length, 1, 'only the failed partition should be retried')
  assert.equal(result.retryPartitions[0].dataset, 'p2', 'the failed partition is p2')
  assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error description present')

  await sink.close()
})

test('exportBatch partial failure: retryPartitions has only the failed partition', async (t) => {
  const stateDir = await tmpStateDir()
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const storage = makeStorage({
    [`${CACHE_ROOT}/datasets/p1/source=x`]: [{ _seq: 1, id: 1 }],
    [`${CACHE_ROOT}/datasets/p2/source=x`]: [{ _seq: 1, id: 1 }],
  })
  const registration = await activatePlugin(storage)
  let call = 0
  const fakeClient = {
    async putObject() {
      call += 1
      if (call === 1) return {} // p1 succeeds
      throw Object.assign(new Error('slow down'), { name: 'SlowDown' })
    },
    destroy() {},
  }
  const clientFactory = async () => ({ client: fakeClient, credential_source_kind: 'injected' })

  const sink = await registration.create(makeSinkCtx({ clientFactory, stateDir }))
  const result = await sink.exportBatch(
    { batchId: 'b1', partitions: [partitionFor('p1'), partitionFor('p2')] },
    {}
  )

  assert.equal(result.status, 'partial')
  assert.equal(result.partitionsExported, 1)
  assert.ok(Array.isArray(result.retryPartitions))
  assert.equal(result.retryPartitions.length, 1)
  assert.equal(result.retryPartitions[0].dataset, 'p2')

  await sink.close()
})

test('exportBatch forwards dataset cluster columns to the encoder', async (t) => {
  const stateDir = await tmpStateDir()
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const storage = makeStorage({
    [`${CACHE_ROOT}/datasets/ai_gateway_messages/source=x`]: [{ _seq: 1, id: 1 }],
  })
  const query = {
    getDataset: (/** @type {string} */ name) =>
      name === 'ai_gateway_messages'
        ? { cachePartitioning: { iceberg: { fields: [{ column: 'conversation_id' }, { column: 'date' }] } } }
        : undefined,
    listDatasets: () => [],
  }
  const registration = await activatePlugin(storage, { query })

  /** @type {any} */
  let seenCtx
  const spyEncoder = {
    format: 'parquet',
    extension: 'parquet',
    supports: ['queryable'],
    async encodePartition(/** @type {any} */ _p, /** @type {any} */ encodeCtx) {
      seenCtx = encodeCtx
      let rowCount = 0
      for await (const _row of encodeCtx.rows ?? []) rowCount++
      const bytes = new TextEncoder().encode('x')
      return { filename: 'f.parquet', bytes, bytesWritten: 1, rowCount }
    },
  }
  const fakeClient = { async putObject() { return {} }, destroy() {} }
  const sink = await registration.create(
    makeSinkCtx({
      clientFactory: async () => ({ client: fakeClient, credential_source_kind: 'injected' }),
      stateDir,
      encoder: spyEncoder,
    })
  )
  await sink.exportBatch(
    { batchId: 'b1', partitions: [partitionFor('ai_gateway_messages')] },
    {}
  )
  assert.deepEqual(seenCtx?.clusterColumns, ['conversation_id', 'date'],
    's3 sink must forward derived cluster columns to the encoder')
  await sink.close()
})

test('exportBatch all-success: no retryPartitions field', async (t) => {
  const stateDir = await tmpStateDir()
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const storage = makeStorage({ [`${CACHE_ROOT}/datasets/p1/source=x`]: [{ _seq: 1, id: 1 }] })
  const registration = await activatePlugin(storage)
  const fakeClient = { async putObject() { return {} }, destroy() {} }
  const clientFactory = async () => ({ client: fakeClient, credential_source_kind: 'injected' })

  const sink = await registration.create(makeSinkCtx({ clientFactory, stateDir }))
  const result = await sink.exportBatch({ batchId: 'b1', partitions: [partitionFor('p1')] }, {})

  assert.equal(result.status, 'exported')
  assert.equal(result.partitionsExported, 1)
  assert.equal(result.retryPartitions, undefined)

  await sink.close()
})

test('exportBatch skips a partition with no new rows: no PUT, no blob', async (t) => {
  // @ref LLP 0040 §5 acceptance 1 — empty new-row set writes ≈0 bytes.
  const stateDir = await tmpStateDir()
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  // Registered table, but readRowsSince yields nothing.
  const storage = makeStorage({ [`${CACHE_ROOT}/datasets/p1/source=x`]: [] })
  const registration = await activatePlugin(storage)
  let puts = 0
  const fakeClient = { async putObject() { puts++; return {} }, destroy() {} }
  const sink = await registration.create(
    makeSinkCtx({ clientFactory: async () => ({ client: fakeClient, credential_source_kind: 'injected' }), stateDir })
  )
  const result = await sink.exportBatch({ batchId: 'b1', partitions: [partitionFor('p1')] }, {})

  assert.equal(puts, 0, 'no object is PUT when there are no new rows')
  assert.equal(result.status, 'exported')
  assert.equal(result.partitionsExported, 0, 'nothing exported on an empty new-row set')
  assert.equal(result.bytesWritten, 0)
  assert.equal(result.retryPartitions, undefined)
  await sink.close()
})

test('exportBatch embeds the [sinceSeq,lastSeq] range in the object key and advances the watermark', async (t) => {
  // @ref LLP 0040 §4 — [sinceSeq,lastSeq] filename + watermark advance.
  const stateDir = await tmpStateDir()
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const tablePath = `${CACHE_ROOT}/datasets/p1/source=x`
  const storage = makeStorage({ tablePath: [] }) // placeholder, replaced below
  // @ts-ignore — install two rows with seqs 5 and 7 under the real key.
  storage.tableExists = (tp) => tp === tablePath
  // @ts-ignore
  storage.readRowsSince = (tp, opts) => {
    const rows = tp === tablePath ? [{ _seq: 5, id: 'a' }, { _seq: 7, id: 'b' }] : []
    const sinceSeq = opts?.since ? BigInt(opts.since.seq) : 0n
    return {
      async *[Symbol.asyncIterator]() {
        let high = sinceSeq
        for (const r of rows) {
          const seq = BigInt(r._seq)
          if (seq <= sinceSeq) continue
          if (seq > high) high = seq
          const { _seq, ...row } = r
          yield { row, after: { v: 1, seq: high.toString() } }
        }
      },
    }
  }
  const registration = await activatePlugin(storage)
  /** @type {string[]} */
  const keys = []
  const fakeClient = { async putObject(/** @type {any} */ i) { keys.push(i.Key); return {} }, destroy() {} }
  const sink = await registration.create(
    makeSinkCtx({ clientFactory: async () => ({ client: fakeClient, credential_source_kind: 'injected' }), stateDir })
  )

  const first = await sink.exportBatch({ batchId: 'b1', partitions: [partitionFor('p1')] }, {})
  assert.equal(first.partitionsExported, 1)
  assert.equal(keys.length, 1)
  assert.ok(/\/p1\.0-7\.jsonl$/.test(keys[0]), `object key embeds [0,7]: ${keys[0]}`)

  // Watermark persisted at seq 7.
  const wmFile = path.join(stateDir, 'sink-instances', 'test', 'watermarks', 'p1', 'source=x.json')
  const wm = JSON.parse(await fs.readFile(wmFile, 'utf8'))
  assert.equal(wm.continuation.seq, '7', 'watermark advanced to the max exported seq')
  assert.equal(wm.exportedRowCount, 2)

  // Second tick with no new rows ⇒ skip, no extra PUT.
  const second = await sink.exportBatch({ batchId: 'b2', partitions: [partitionFor('p1')] }, {})
  assert.equal(second.partitionsExported, 0, 'no new rows ⇒ nothing exported on the second tick')
  assert.equal(keys.length, 1, 'no second PUT when the watermark already covers every row')

  await sink.close()
})

test('exportBatch re-PUTs the same object key when the watermark is lost (idempotent crash retry)', async (t) => {
  // @ref LLP 0040 §5 acceptance 4 — a crash before the watermark write re-PUTs
  // the same key (same since ⇒ same rows ⇒ same [sinceSeq,lastSeq] filename).
  const stateDir = await tmpStateDir()
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const storage = makeStorage({ [`${CACHE_ROOT}/datasets/p1/source=x`]: [{ _seq: 3, id: 'a' }] })
  const registration = await activatePlugin(storage)
  /** @type {string[]} */
  const keys = []
  const fakeClient = { async putObject(/** @type {any} */ i) { keys.push(i.Key); return {} }, destroy() {} }
  const sink = await registration.create(
    makeSinkCtx({ clientFactory: async () => ({ client: fakeClient, credential_source_kind: 'injected' }), stateDir })
  )

  await sink.exportBatch({ batchId: 'b1', partitions: [partitionFor('p1')] }, {})
  assert.equal(keys.length, 1)
  // Simulate the watermark write being lost (crash between PUT and advance).
  await fs.rm(path.join(stateDir, 'sink-instances', 'test', 'watermarks', 'p1', 'source=x.json'), { force: true })
  await sink.exportBatch({ batchId: 'b2', partitions: [partitionFor('p1')] }, {})

  assert.equal(keys.length, 2, 'the row is re-PUT after a lost watermark')
  assert.equal(keys[0], keys[1], 'the re-PUT targets the same object key (idempotent overwrite)')
  await sink.close()
})
