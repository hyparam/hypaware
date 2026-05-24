// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createBlobStoreIO } from '../../hypaware-core/plugins-workspace/format-iceberg/src/blob-io.js'

/**
 * @import { BlobStore, HypError } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Build a BlobStore stub whose putObject/getObject/listObjects throw a
 * pre-tagged error matching what the real `@hypaware/s3` BlobStore would
 * surface when AWS classifies the call against `classifyAwsError`.
 *
 * @param {{ errorKind: string, operation?: 'put' | 'get' | 'list' }} args
 */
function failingBlobStore({ errorKind, operation = 'put' }) {
  /** @returns {Error & { errorKind: string }} */
  function makeErr() {
    const err = /** @type {Error & { errorKind: string }} */ (new Error(`s3: ${errorKind}`))
    err.errorKind = errorKind
    return err
  }
  return /** @type {BlobStore} */ ({
    kind: 's3',
    async putObject(input) {
      if (operation === 'put') throw makeErr()
      return { key: input.key }
    },
    async getObject(_input) {
      if (operation === 'get') throw makeErr()
      return null
    },
    listObjects(_input) {
      return {
        async *[Symbol.asyncIterator]() {
          if (operation === 'list') throw makeErr()
        },
      }
    },
    async deleteObject() {},
  })
}

const KEY = 'iceberg/datasets/foo/metadata/v1.metadata.json'

/**
 * Pin the AWS-error → iceberg-error mapping. The spec calls out:
 *  - `PreconditionFailed` (ifNoneMatch failed) → `iceberg_commit_conflict`
 *  - `AccessDenied` on metadata writes → `iceberg_blob_store_missing`
 *  - transient/other → `iceberg_data_write_failed`
 *
 * The set of BLOB_STORE_FATAL_KINDS lives in `format-iceberg/src/blob-io.js`;
 * this table enumerates which inputs land on each output kind so a future
 * change cannot silently re-map a permission failure to a transient one.
 */
const WRITE_MAPPING = /** @type {const} */ ([
  { input: 'blob_precondition_failed', expected: 'iceberg_commit_conflict' },
  { input: 's3_access_denied', expected: 'iceberg_blob_store_missing' },
  { input: 's3_bucket_missing', expected: 'iceberg_blob_store_missing' },
  { input: 's3_credentials_missing', expected: 'iceberg_blob_store_missing' },
  { input: 's3_region_mismatch', expected: 'iceberg_blob_store_missing' },
  { input: 's3_config_invalid', expected: 'iceberg_blob_store_missing' },
  { input: 's3_blob_store_unconfigured', expected: 'iceberg_blob_store_missing' },
  { input: 's3_put_failed', expected: 'iceberg_data_write_failed' },
  { input: 's3_throttled', expected: 'iceberg_data_write_failed' },
])

for (const { input, expected } of WRITE_MAPPING) {
  test(`writer maps s3 errorKind=${input} -> iceberg ${expected}`, async () => {
    const blobStore = failingBlobStore({ errorKind: input, operation: 'put' })
    const { resolver } = await createBlobStoreIO(blobStore)
    if (!resolver.writer) throw new Error('writer required')
    const writer = resolver.writer(`blob://${KEY}`, { ifNoneMatch: '*' })
    writer.appendBytes(new Uint8Array([1, 2, 3]))
    await assert.rejects(
      () => writer.finish(),
      (err) => /** @type {HypError} */ (err).hypErrorKind === expected,
    )
  })
}

/**
 * Reads should follow the same fatal-vs-transient split: permission and
 * bucket-shape errors surface as `iceberg_blob_store_missing` so the
 * caller sees "addressing/permissions issue" rather than blaming an
 * Iceberg-internal metadata-read failure.
 */
const READ_MAPPING = /** @type {const} */ ([
  { input: 's3_access_denied', expected: 'iceberg_blob_store_missing' },
  { input: 's3_bucket_missing', expected: 'iceberg_blob_store_missing' },
  { input: 's3_credentials_missing', expected: 'iceberg_blob_store_missing' },
  { input: 's3_put_failed', expected: 'iceberg_metadata_read_failed' },
  { input: 's3_throttled', expected: 'iceberg_metadata_read_failed' },
])

for (const { input, expected } of READ_MAPPING) {
  test(`reader maps s3 errorKind=${input} -> iceberg ${expected}`, async () => {
    const blobStore = failingBlobStore({ errorKind: input, operation: 'get' })
    const { resolver } = await createBlobStoreIO(blobStore)
    await assert.rejects(
      () => resolver.reader(`blob://${KEY}`),
      (err) => /** @type {HypError} */ (err).hypErrorKind === expected,
    )
  })
}

const LIST_MAPPING = /** @type {const} */ ([
  { input: 's3_access_denied', expected: 'iceberg_blob_store_missing' },
  { input: 's3_bucket_missing', expected: 'iceberg_blob_store_missing' },
  { input: 's3_put_failed', expected: 'iceberg_blob_io_list_failed' },
])

for (const { input, expected } of LIST_MAPPING) {
  test(`lister maps s3 errorKind=${input} -> iceberg ${expected}`, async () => {
    const blobStore = failingBlobStore({ errorKind: input, operation: 'list' })
    const { lister } = await createBlobStoreIO(blobStore)
    await assert.rejects(
      () => lister(`blob://iceberg/datasets/foo/metadata`),
      (err) => /** @type {HypError} */ (err).hypErrorKind === expected,
    )
  })
}

test('writer onWrite observer fires with key + etag for successful puts', async () => {
  /** @type {Array<{ key: string, etag: string | undefined, ifNoneMatch: string | undefined }>} */
  const events = []
  /** @type {BlobStore} */
  const blobStore = {
    kind: 's3',
    async putObject(input) {
      return { key: input.key, etag: '"abc123"' }
    },
    async getObject() { return null },
    listObjects() {
      return { async *[Symbol.asyncIterator]() {} }
    },
    async deleteObject() {},
  }
  const { resolver } = await createBlobStoreIO(blobStore, {
    onWrite(event) { events.push(event) },
  })
  if (!resolver.writer) throw new Error('writer required')
  const writer = resolver.writer(`blob://${KEY}`, { ifNoneMatch: '*' })
  writer.appendBytes(new Uint8Array([7, 8, 9]))
  await writer.finish()
  assert.equal(events.length, 1)
  assert.equal(events[0].key, KEY)
  assert.equal(events[0].etag, '"abc123"')
  assert.equal(events[0].ifNoneMatch, '*')
})

test('writer onWrite observer that throws does not break the commit', async () => {
  /** @type {BlobStore} */
  const blobStore = {
    kind: 's3',
    async putObject(input) { return { key: input.key, etag: '"abc"' } },
    async getObject() { return null },
    listObjects() { return { async *[Symbol.asyncIterator]() {} } },
    async deleteObject() {},
  }
  const { resolver } = await createBlobStoreIO(blobStore, {
    onWrite() { throw new Error('observer is buggy') },
  })
  if (!resolver.writer) throw new Error('writer required')
  const writer = resolver.writer(`blob://${KEY}`, { ifNoneMatch: '*' })
  writer.appendBytes(new Uint8Array([1]))
  // Must not throw — observer failures are best-effort.
  await writer.finish()
})
