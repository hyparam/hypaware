// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import {
  createS3BlobStore,
  createUnconfiguredS3BlobStore,
} from '../../hypaware-core/plugins-workspace/s3/src/blob-store.js'

/**
 * Build an in-memory S3 client handle that mimics the AWS SDK shape
 * the BlobStore expects. Used to drive every put/get/list/delete path
 * without spinning up real S3.
 */
function makeFakeS3Client() {
  /** @type {Map<string, { bytes: Uint8Array, lastModified: Date }>} */
  const objects = new Map()
  /** @type {Array<{ command: string, input: any }>} */
  const calls = []
  return {
    objects,
    calls,
    async putObject(input) {
      calls.push({ command: 'putObject', input })
      if (input.IfNoneMatch === '*' && objects.has(input.Key)) {
        const err = /** @type {Error & { name?: string, $metadata?: { httpStatusCode?: number } }} */ (
          new Error(`object already exists at '${input.Key}'`)
        )
        err.name = 'PreconditionFailed'
        err.$metadata = { httpStatusCode: 412 }
        throw err
      }
      const bytes = input.Body instanceof Uint8Array ? input.Body : Buffer.from(input.Body)
      objects.set(input.Key, { bytes, lastModified: new Date('2026-05-21T00:00:00Z') })
      return { ETag: '"fake-etag"', VersionId: 'v1' }
    },
    async getObject(input) {
      calls.push({ command: 'getObject', input })
      const obj = objects.get(input.Key)
      if (!obj) {
        const err = /** @type {Error & { name?: string, $metadata?: { httpStatusCode?: number } }} */ (
          new Error(`no such key '${input.Key}'`)
        )
        err.name = 'NoSuchKey'
        err.$metadata = { httpStatusCode: 404 }
        throw err
      }
      return {
        Body: Readable.from([obj.bytes]),
        ContentLength: obj.bytes.byteLength,
        ETag: '"fake-etag"',
      }
    },
    async listObjects(input) {
      calls.push({ command: 'listObjects', input })
      const prefix = typeof input.Prefix === 'string' ? input.Prefix : ''
      const contents = Array.from(objects.entries())
        .filter(([k]) => prefix.length === 0 || k.startsWith(prefix))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, { bytes, lastModified }]) => ({ Key: key, Size: bytes.byteLength, LastModified: lastModified }))
      return { Contents: contents }
    },
    async deleteObject(input) {
      calls.push({ command: 'deleteObject', input })
      objects.delete(input.Key)
    },
  }
}

test('s3 BlobStore puts and gets a round-trip object honouring prefix', async () => {
  const client = makeFakeS3Client()
  const store = createS3BlobStore({ bucket: 'my-bucket', prefix: 'hyp/exports', client })

  const payload = new TextEncoder().encode('payload-bytes')
  const result = await store.putObject({ key: 'datasets/foo/file.parquet', body: payload })
  assert.equal(result.key, 'datasets/foo/file.parquet')
  assert.equal(result.etag, '"fake-etag"')

  // Confirm the underlying S3 call composed the full key with prefix.
  const putCall = client.calls.find((c) => c.command === 'putObject')
  assert.ok(putCall)
  assert.equal(putCall.input.Key, 'hyp/exports/datasets/foo/file.parquet')
  assert.equal(putCall.input.ContentLength, payload.byteLength)

  const got = await store.getObject({ key: 'datasets/foo/file.parquet' })
  assert.ok(got)
  /** @type {Uint8Array[]} */
  const chunks = []
  for await (const chunk of got.body) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    else chunks.push(chunk)
  }
  const collected = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
  assert.equal(collected.toString('utf8'), 'payload-bytes')
})

test('s3 BlobStore getObject returns null when AWS reports NotFound', async () => {
  const client = makeFakeS3Client()
  const store = createS3BlobStore({ bucket: 'my-bucket', client })
  const got = await store.getObject({ key: 'does/not/exist' })
  assert.equal(got, null)
})

test('s3 BlobStore listObjects strips the prefix from emitted keys', async () => {
  const client = makeFakeS3Client()
  const store = createS3BlobStore({ bucket: 'my-bucket', prefix: 'hyp/exports', client })
  await store.putObject({ key: 'a.bin', body: new Uint8Array([1]) })
  await store.putObject({ key: 'sub/b.bin', body: new Uint8Array([2, 2]) })

  const seen = []
  for await (const entry of store.listObjects({ prefix: '' })) seen.push(entry.key)
  assert.deepEqual(seen.sort(), ['a.bin', 'sub/b.bin'])

  // The fake captured the composed-with-prefix Prefix argument so the
  // BlobStore-level prefix actually reached S3.
  const listCall = client.calls.find((c) => c.command === 'listObjects')
  assert.ok(listCall)
  assert.equal(listCall.input.Prefix, 'hyp/exports')
})

test('s3 BlobStore putObject ifNoneMatch="*" surfaces blob_precondition_failed on conflict', async () => {
  const client = makeFakeS3Client()
  const store = createS3BlobStore({ bucket: 'my-bucket', client })
  await store.putObject({ key: 'iceberg/metadata/v1.json', body: new Uint8Array([1]) })
  await assert.rejects(
    () =>
      store.putObject({
        key: 'iceberg/metadata/v1.json',
        body: new Uint8Array([2]),
        ifNoneMatch: '*',
      }),
    (err) => {
      assert.ok(err instanceof Error)
      assert.equal(/** @type {any} */ (err).errorKind, 'blob_precondition_failed')
      return true
    },
  )
})

test('s3 BlobStore rejects keys that try to escape the configured prefix', async () => {
  const client = makeFakeS3Client()
  const store = createS3BlobStore({ bucket: 'my-bucket', prefix: 'hyp/exports', client })
  await assert.rejects(
    () => store.putObject({ key: '../escape.bin', body: new Uint8Array([1]) }),
    /escapes the configured prefix/,
  )
  await assert.rejects(
    () => store.putObject({ key: '/abs/path.bin', body: new Uint8Array([1]) }),
    /escapes the configured prefix/,
  )
})

test('s3 BlobStore exposes bucket and prefix for downstream telemetry', () => {
  const client = makeFakeS3Client()
  const store = /** @type {import('../../collectivus-plugin-kernel-types').BlobStore & { bucket?: string, prefix?: string }} */ (
    createS3BlobStore({ bucket: 'my-bucket', prefix: 'hyp/exports/', client })
  )
  assert.equal(store.kind, 's3')
  assert.equal(store.bucket, 'my-bucket')
  // Prefix is normalized (trailing slash stripped) at construction.
  assert.equal(store.prefix, 'hyp/exports')
})

test('s3 BlobStore tags AccessDenied with errorKind=s3_access_denied', async () => {
  const client = makeFakeS3Client()
  // Override putObject to simulate an AWS AccessDenied response.
  client.putObject = async () => {
    const err = /** @type {Error & { name: string, $metadata: { httpStatusCode: number } }} */ (
      new Error('Access Denied')
    )
    err.name = 'AccessDenied'
    err.$metadata = { httpStatusCode: 403 }
    throw err
  }
  const store = createS3BlobStore({ bucket: 'my-bucket', client })
  await assert.rejects(
    () => store.putObject({ key: 'iceberg/metadata/v1.json', body: new Uint8Array([1]) }),
    (err) => /** @type {any} */ (err).errorKind === 's3_access_denied'
  )
})

test('s3 BlobStore tags NoSuchBucket on listObjects with errorKind=s3_bucket_missing', async () => {
  const client = makeFakeS3Client()
  client.listObjects = async () => {
    const err = /** @type {Error & { name: string, $metadata: { httpStatusCode: number } }} */ (
      new Error('bucket does not exist')
    )
    err.name = 'NoSuchBucket'
    err.$metadata = { httpStatusCode: 404 }
    throw err
  }
  const store = createS3BlobStore({ bucket: 'my-bucket', client })
  await assert.rejects(
    async () => {
      for await (const _ of store.listObjects({ prefix: '' })) { /* drain */ }
    },
    (err) => /** @type {any} */ (err).errorKind === 's3_bucket_missing'
  )
})

test('s3 BlobStore tags getObject errors that are not NotFound', async () => {
  const client = makeFakeS3Client()
  client.getObject = async () => {
    const err = /** @type {Error & { name: string, $metadata: { httpStatusCode: number } }} */ (
      new Error('Throttled')
    )
    err.name = 'SlowDown'
    err.$metadata = { httpStatusCode: 503 }
    throw err
  }
  const store = createS3BlobStore({ bucket: 'my-bucket', client })
  await assert.rejects(
    () => store.getObject({ key: 'iceberg/metadata/v1.json' }),
    (err) => /** @type {any} */ (err).errorKind === 's3_throttled'
  )
})

test('s3 BlobStore deleteObject treats NotFound as benign and returns', async () => {
  const client = makeFakeS3Client()
  client.deleteObject = async () => {
    const err = /** @type {Error & { name: string, $metadata: { httpStatusCode: number } }} */ (
      new Error('No such key')
    )
    err.name = 'NoSuchKey'
    err.$metadata = { httpStatusCode: 404 }
    throw err
  }
  const store = createS3BlobStore({ bucket: 'my-bucket', client })
  await store.deleteObject({ key: 'missing/file.bin' })
})

test('createUnconfiguredS3BlobStore throws actionable s3_blob_store_unconfigured on use', async () => {
  const store = createUnconfiguredS3BlobStore()
  assert.equal(store.kind, 's3')
  await assert.rejects(
    () => store.putObject({ key: 'a', body: new Uint8Array() }),
    (err) => {
      assert.equal(/** @type {any} */ (err).errorKind, 's3_blob_store_unconfigured')
      return true
    },
  )
  await assert.rejects(
    () => store.getObject({ key: 'a' }),
    /no bucket configured/i,
  )
})
