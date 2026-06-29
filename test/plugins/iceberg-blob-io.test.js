// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  collectStream,
  createBlobStoreIO,
  pathToKey,
  tableUrlForBlobPrefix,
} from '../../hypaware-core/plugins-workspace/format-iceberg/src/blob-io.js'

/**
 * @import { BlobStore, HypError } from '../../collectivus-plugin-kernel-types.js'
 */

/**
 * In-memory `BlobStore` fixture. The test rig records every put so we
 * can assert on key layout, body bytes, and `ifNoneMatch` semantics.
 */
function makeBlobStore() {
  /** @type {Map<string, Uint8Array>} */
  const objects = new Map()
  /** @type {Array<{ op: string, key: string, ifNoneMatch?: string }>} */
  const ops = []
  return {
    objects,
    ops,
    /** @type {BlobStore} */
    blobStore: {
      kind: 'memory',
      async putObject(input) {
        ops.push({ op: 'put', key: input.key, ifNoneMatch: input.ifNoneMatch })
        if (input.ifNoneMatch === '*' && objects.has(input.key)) {
          const err = /** @type {Error & { errorKind?: string }} */ (
            new Error(`precondition failed at ${input.key}`)
          )
          err.errorKind = 'blob_precondition_failed'
          throw err
        }
        const bytes = input.body instanceof Uint8Array ? input.body : new Uint8Array()
        objects.set(input.key, bytes)
        return { key: input.key }
      },
      async getObject(input) {
        ops.push({ op: 'get', key: input.key })
        const bytes = objects.get(input.key)
        if (!bytes) return null
        return { body: Readable.from([bytes]), contentLength: bytes.byteLength }
      },
      listObjects(input) {
        ops.push({ op: 'list', key: input.prefix })
        return {
          async *[Symbol.asyncIterator]() {
            for (const [key, value] of objects) {
              if (input.prefix && !key.startsWith(input.prefix)) continue
              yield { key, size: value.byteLength, lastModified: new Date() }
            }
          },
        }
      },
      async deleteObject(input) {
        ops.push({ op: 'delete', key: input.key })
        objects.delete(input.key)
      },
    },
  }
}

test('tableUrlForBlobPrefix normalises slashes and emits blob:// scheme', () => {
  assert.equal(tableUrlForBlobPrefix('iceberg/datasets/foo'), 'blob://iceberg/datasets/foo')
  assert.equal(tableUrlForBlobPrefix('/iceberg/datasets/foo/'), 'blob://iceberg/datasets/foo')
})

test('pathToKey reverses the table URL and accepts subpaths', () => {
  assert.equal(pathToKey('blob://iceberg/datasets/foo/metadata/v1.metadata.json'),
    'iceberg/datasets/foo/metadata/v1.metadata.json')
  assert.equal(pathToKey('iceberg/datasets/foo/data/x.parquet'),
    'iceberg/datasets/foo/data/x.parquet')
})

test('pathToKey rejects empty input', () => {
  assert.throws(() => pathToKey(''), (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_blob_io_invalid_url')
  assert.throws(() => pathToKey('blob:///'), (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_blob_io_invalid_url')
})

test('createBlobStoreIO writer flushes via putObject and applies ifNoneMatch', async () => {
  const fixture = makeBlobStore()
  const { resolver } = await createBlobStoreIO(fixture.blobStore)
  if (!resolver.writer) throw new Error('writer required')

  const writer = resolver.writer('blob://iceberg/datasets/foo/metadata/v1.metadata.json', { ifNoneMatch: '*' })
  writer.appendBytes(new Uint8Array([1, 2, 3, 4]))
  await writer.finish()
  assert.deepEqual(Array.from(fixture.objects.get('iceberg/datasets/foo/metadata/v1.metadata.json') ?? []), [1, 2, 3, 4])
  assert.equal(fixture.ops.find((op) => op.op === 'put')?.ifNoneMatch, '*')

  // Second conditional write surfaces iceberg_commit_conflict with 412.
  const collision = resolver.writer('blob://iceberg/datasets/foo/metadata/v1.metadata.json', { ifNoneMatch: '*' })
  collision.appendBytes(new Uint8Array([5]))
  await assert.rejects(
    async () => collision.finish(),
    (/** @type {any} */ err) => err.hypErrorKind === 'iceberg_commit_conflict' && err.status === 412
  )
})

test('createBlobStoreIO reader returns AsyncBuffer with byte-faithful slice', async () => {
  const fixture = makeBlobStore()
  fixture.objects.set('iceberg/datasets/foo/metadata/v1.metadata.json', new Uint8Array([10, 20, 30, 40, 50]))
  const { resolver } = await createBlobStoreIO(fixture.blobStore)
  const buf = await resolver.reader('blob://iceberg/datasets/foo/metadata/v1.metadata.json')
  assert.equal(buf.byteLength, 5)
  const slice = await buf.slice(1, 4)
  assert.deepEqual(Array.from(new Uint8Array(slice)), [20, 30, 40])
})

test('createBlobStoreIO reader surfaces ENOENT for missing objects', async () => {
  const fixture = makeBlobStore()
  const { resolver } = await createBlobStoreIO(fixture.blobStore)
  await assert.rejects(
    async () => resolver.reader('blob://iceberg/datasets/foo/metadata/v1.metadata.json'),
    (/** @type {any} */ err) => err.hypErrorKind === 'iceberg_metadata_read_failed' && err.code === 'ENOENT'
  )
})

test('createBlobStoreIO lister returns immediate basenames sorted', async () => {
  const fixture = makeBlobStore()
  fixture.objects.set('iceberg/datasets/foo/metadata/v1.metadata.json', new Uint8Array())
  fixture.objects.set('iceberg/datasets/foo/metadata/v2.metadata.json', new Uint8Array())
  fixture.objects.set('iceberg/datasets/foo/metadata/version-hint.text', new Uint8Array())
  fixture.objects.set('iceberg/datasets/foo/metadata/subdir/should-not-appear.json', new Uint8Array())
  // Other-dataset key must be ignored.
  fixture.objects.set('iceberg/datasets/other/metadata/v1.metadata.json', new Uint8Array())

  const { lister } = await createBlobStoreIO(fixture.blobStore)
  const files = await lister('blob://iceberg/datasets/foo/metadata')
  assert.deepEqual(files, ['v1.metadata.json', 'v2.metadata.json', 'version-hint.text'])
})

test('collectStream concatenates Node-stream chunks deterministically', async () => {
  const stream = Readable.from([
    new Uint8Array([1, 2]),
    new Uint8Array([3, 4, 5]),
    new Uint8Array([6]),
  ])
  const all = await collectStream(stream)
  assert.deepEqual(Array.from(all), [1, 2, 3, 4, 5, 6])
})

test('createBlobStoreIO refuses BlobStores without putObject', async () => {
  await assert.rejects(
    () => createBlobStoreIO(/** @type {any} */ ({ kind: 'broken' })),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_blob_store_missing'
  )
})
