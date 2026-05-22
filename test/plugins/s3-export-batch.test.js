// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { activate } from '../../hypaware-core/plugins-workspace/s3/src/index.js'

/**
 * Drive the s3 plugin's `activate` against a captured kernel context and
 * return the sink-registration descriptor it registers. Each test gets a
 * fresh activation so the captured `create` is independent. `activate`
 * is async (it resolves the plugin-level BlobStore before registering
 * the sink), so this helper must await it before reading `registered`.
 */
async function activatePlugin() {
  /** @type {any} */
  let registered
  /** @type {any} */
  const ctx = {
    provideCapability() {},
    sinks: {
      register(descriptor) {
        registered = descriptor
      },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    query: { getDataset: () => undefined, listDatasets: () => [] },
    storage: {
      tableExists: () => false,
      readRows: () => ({ async *[Symbol.asyncIterator]() {} }),
    },
  }
  await activate(ctx)
  if (!registered) throw new Error('plugin did not register a sink')
  return registered
}

function makeEncoder() {
  return {
    format: 'jsonl',
    extension: 'jsonl',
    supports: ['queryable'],
    async encodePartition(partition) {
      const bytes = new TextEncoder().encode('{}\n')
      return {
        filename: `${partition.dataset}.jsonl`,
        bytes,
        bytesWritten: bytes.byteLength,
        rowCount: 0,
      }
    },
  }
}

function makeSinkCtx({ clientFactory }) {
  return {
    name: 'test',
    config: {
      bucket: 'test-bucket',
      prefix: 'p',
      __clientFactory: clientFactory,
    },
    encoder: makeEncoder(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    paths: { tempDir: '/tmp' },
  }
}

test('exportBatch terminal failure: retryPartitions excludes already-uploaded partitions', async () => {
  const registration = await activatePlugin()
  /** @type {Array<{ Key: string }>} */
  const putCalls = []
  const fakeClient = {
    async putObject(input) {
      putCalls.push({ Key: input.Key })
      if (putCalls.length === 1) return {} // p1 succeeds
      // p2 hits a terminal config error (s3_access_denied)
      const err = Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      })
      throw err
    },
    destroy() {},
  }
  const clientFactory = async () => ({ client: fakeClient, credential_source_kind: 'injected' })

  const sink = await registration.create(makeSinkCtx({ clientFactory }))

  const p1 = { dataset: 'p1', partition: {}, tablePath: '' }
  const p2 = { dataset: 'p2', partition: {}, tablePath: '' }
  const result = await sink.exportBatch({ batchId: 'b1', partitions: [p1, p2] }, {})

  assert.equal(result.status, 'failed', 'terminal failure must produce failed status')
  assert.equal(result.partitionsExported, 1, 'p1 was uploaded successfully')
  assert.ok(Array.isArray(result.retryPartitions), 'retryPartitions must be set on terminal failure so the driver does not outbox successful uploads')
  assert.equal(result.retryPartitions.length, 1, 'only the failed partition should be retried')
  assert.equal(result.retryPartitions[0].dataset, 'p2', 'the failed partition is p2, not the already-uploaded p1')
  assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error description present')

  await sink.close()
})

test('exportBatch partial failure: retryPartitions has only the failed partition', async () => {
  const registration = await activatePlugin()
  let call = 0
  const fakeClient = {
    async putObject() {
      call += 1
      if (call === 1) return {} // p1 succeeds
      // Non-terminal error — driver expects to retry just p2.
      const err = Object.assign(new Error('slow down'), { name: 'SlowDown' })
      throw err
    },
    destroy() {},
  }
  const clientFactory = async () => ({ client: fakeClient, credential_source_kind: 'injected' })

  const sink = await registration.create(makeSinkCtx({ clientFactory }))

  const p1 = { dataset: 'p1', partition: {}, tablePath: '' }
  const p2 = { dataset: 'p2', partition: {}, tablePath: '' }
  const result = await sink.exportBatch({ batchId: 'b1', partitions: [p1, p2] }, {})

  assert.equal(result.status, 'partial')
  assert.equal(result.partitionsExported, 1)
  assert.ok(Array.isArray(result.retryPartitions))
  assert.equal(result.retryPartitions.length, 1)
  assert.equal(result.retryPartitions[0].dataset, 'p2')

  await sink.close()
})

test('exportBatch all-success: no retryPartitions field', async () => {
  const registration = await activatePlugin()
  const fakeClient = {
    async putObject() { return {} },
    destroy() {},
  }
  const clientFactory = async () => ({ client: fakeClient, credential_source_kind: 'injected' })

  const sink = await registration.create(makeSinkCtx({ clientFactory }))

  const p1 = { dataset: 'p1', partition: {}, tablePath: '' }
  const result = await sink.exportBatch({ batchId: 'b1', partitions: [p1] }, {})

  assert.equal(result.status, 'exported')
  assert.equal(result.partitionsExported, 1)
  assert.equal(result.retryPartitions, undefined)

  await sink.close()
})
