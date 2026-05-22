// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import {
  collectStream,
  createLocalFsBlobStore,
  resolveExportsBaseDir,
} from '../../hypaware-core/plugins-workspace/local-fs/src/blob-store.js'

/**
 * @returns {Promise<string>}
 */
async function makeTempBase() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'blobstore-test-'))
}

test('resolveExportsBaseDir prefers explicit pluginConfig.exports_dir', () => {
  const resolved = resolveExportsBaseDir({
    pluginConfig: { exports_dir: '/tmp/custom-exports' },
    env: { HYP_HOME: '/tmp/hyp-home' },
  })
  assert.equal(resolved, '/tmp/custom-exports')
})

test('resolveExportsBaseDir falls back to HYP_HOME', () => {
  const resolved = resolveExportsBaseDir({
    env: { HYP_HOME: '/tmp/hyp-home' },
  })
  assert.equal(resolved, '/tmp/hyp-home/exports')
})

test('resolveExportsBaseDir falls back to homedir/.hyp when HYP_HOME unset', () => {
  const resolved = resolveExportsBaseDir({ env: {} })
  assert.equal(resolved, path.join(os.homedir(), '.hyp', 'exports'))
})

test('local-fs BlobStore puts and gets bytes by key', async () => {
  const base = await makeTempBase()
  try {
    const store = createLocalFsBlobStore({ baseDir: base })
    const payload = new TextEncoder().encode('hello world')
    const result = await store.putObject({ key: 'datasets/foo/bar.bin', body: payload })
    assert.equal(result.key, 'datasets/foo/bar.bin')

    const got = await store.getObject({ key: 'datasets/foo/bar.bin' })
    assert.ok(got, 'getObject should resolve when the key exists')
    assert.equal(got.contentLength, payload.byteLength)
    const bytes = await collectStream(got.body)
    assert.deepEqual(Array.from(bytes), Array.from(payload))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('local-fs BlobStore getObject returns null for missing keys', async () => {
  const base = await makeTempBase()
  try {
    const store = createLocalFsBlobStore({ baseDir: base })
    const got = await store.getObject({ key: 'missing/file.bin' })
    assert.equal(got, null)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('local-fs BlobStore lists objects under a prefix in deterministic order', async () => {
  const base = await makeTempBase()
  try {
    const store = createLocalFsBlobStore({ baseDir: base })
    // Insert in a deliberately unsorted order so the listing's sort
    // contract is observable.
    await store.putObject({ key: 'metrics/2025-01-02/file-b.bin', body: new Uint8Array([1, 2]) })
    await store.putObject({ key: 'metrics/2025-01-01/file-a.bin', body: new Uint8Array([3, 4, 5]) })
    await store.putObject({ key: 'logs/2025-01-01/file-x.bin', body: new Uint8Array([6]) })

    /** @type {Array<{ key: string, size: number }>} */
    const seen = []
    for await (const entry of store.listObjects({ prefix: 'metrics/' })) {
      seen.push({ key: entry.key, size: entry.size })
    }
    assert.deepEqual(
      seen,
      [
        { key: 'metrics/2025-01-01/file-a.bin', size: 3 },
        { key: 'metrics/2025-01-02/file-b.bin', size: 2 },
      ],
    )
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('local-fs BlobStore listObjects with empty prefix returns all entries', async () => {
  const base = await makeTempBase()
  try {
    const store = createLocalFsBlobStore({ baseDir: base })
    await store.putObject({ key: 'a/one.bin', body: new Uint8Array([1]) })
    await store.putObject({ key: 'b/two.bin', body: new Uint8Array([2]) })
    const keys = []
    for await (const entry of store.listObjects({ prefix: '' })) keys.push(entry.key)
    assert.deepEqual(keys.sort(), ['a/one.bin', 'b/two.bin'])
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('local-fs BlobStore deleteObject removes the key and is idempotent', async () => {
  const base = await makeTempBase()
  try {
    const store = createLocalFsBlobStore({ baseDir: base })
    await store.putObject({ key: 'a/one.bin', body: new Uint8Array([1]) })
    const got = await store.getObject({ key: 'a/one.bin' })
    assert.ok(got)
    // Drain the body so the held FileHandle is released; tests that
    // discard the body would leak a handle into the next iteration.
    await collectStream(got.body)
    assert.ok(store.deleteObject)
    await store.deleteObject({ key: 'a/one.bin' })
    assert.equal(await store.getObject({ key: 'a/one.bin' }), null)
    // Idempotent — deleting a missing key is not an error.
    await store.deleteObject({ key: 'a/one.bin' })
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('local-fs BlobStore getObject body survives a concurrent unlink', async () => {
  // Regression: the pre-fix impl used createReadStream(path), which
  // opens the underlying file asynchronously. A consumer that called
  // getObject and then deleted the file before consuming the body
  // raced the lazy open and produced an unhandled ENOENT in the
  // stream's error event. Holding a FileHandle inside getObject means
  // the open is settled before getObject returns and the unlink is
  // benign. Use a sync unlink so the race window is forced on every
  // platform (Linux exposed it under CI but macOS scheduling hid it).
  const base = await makeTempBase()
  try {
    const store = createLocalFsBlobStore({ baseDir: base })
    await store.putObject({ key: 'race/key.bin', body: new Uint8Array([1, 2, 3]) })
    const got = await store.getObject({ key: 'race/key.bin' })
    assert.ok(got, 'getObject must return a result for an existing key')
    unlinkSync(path.join(base, 'race', 'key.bin'))
    const bytes = await collectStream(got.body)
    assert.deepEqual(Array.from(bytes), [1, 2, 3])
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('local-fs BlobStore putObject honours ifNoneMatch="*" by failing on existing keys', async () => {
  const base = await makeTempBase()
  try {
    const store = createLocalFsBlobStore({ baseDir: base })
    await store.putObject({ key: 'iceberg/metadata/v1.json', body: new Uint8Array([0xfa]) })
    await assert.rejects(
      () =>
        store.putObject({
          key: 'iceberg/metadata/v1.json',
          body: new Uint8Array([0xfb]),
          ifNoneMatch: '*',
        }),
      (err) => {
        // Stable errorKind keeps the iceberg adapter's translation from
        // depending on the local-fs error MESSAGE.
        assert.equal(/** @type {any} */ (err).errorKind, 'blob_precondition_failed')
        assert.match(err.message, /precondition failed/i)
        return true
      },
    )
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('local-fs BlobStore ifNoneMatch="*" succeeds when the key is new', async () => {
  const base = await makeTempBase()
  try {
    const store = createLocalFsBlobStore({ baseDir: base })
    const result = await store.putObject({
      key: 'iceberg/metadata/v3.json',
      body: new Uint8Array([1, 2, 3]),
      ifNoneMatch: '*',
    })
    assert.equal(result.key, 'iceberg/metadata/v3.json')
    const got = await store.getObject({ key: 'iceberg/metadata/v3.json' })
    assert.ok(got)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('local-fs BlobStore rejects keys that escape the configured root', async () => {
  const base = await makeTempBase()
  try {
    const store = createLocalFsBlobStore({ baseDir: base })
    await assert.rejects(
      () => store.putObject({ key: '../escape.bin', body: new Uint8Array([1]) }),
      /escapes the blob-store root/,
    )
    await assert.rejects(
      () => store.putObject({ key: '/abs/path.bin', body: new Uint8Array([1]) }),
      /escapes the blob-store root/,
    )
    await assert.rejects(
      () => store.putObject({ key: 'mixed/../../../escape.bin', body: new Uint8Array([1]) }),
      /escapes the blob-store root/,
    )
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('local-fs BlobStore accepts a Readable stream as body', async () => {
  const base = await makeTempBase()
  try {
    const store = createLocalFsBlobStore({ baseDir: base })
    const stream = Readable.from([Buffer.from('chunk-one-'), Buffer.from('chunk-two')])
    await store.putObject({ key: 'streamed/file.bin', body: stream })
    const got = await store.getObject({ key: 'streamed/file.bin' })
    assert.ok(got)
    const bytes = await collectStream(got.body)
    assert.equal(Buffer.from(bytes).toString('utf8'), 'chunk-one-chunk-two')
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

/**
 * Build a minimal in-memory `BlobStore` fixture used to exercise the
 * BlobStore contract from the consumer side (e.g. a future
 * format-iceberg plugin). The fixture is intentionally simple — a Map
 * keyed by object key — but honours every contract bit the surface
 * needs: kind, ordering, prefix filtering, ifNoneMatch, return shape.
 *
 * @returns {import('../../collectivus-plugin-kernel-types').BlobStore}
 */
function createInMemoryBlobStore() {
  /** @type {Map<string, { bytes: Uint8Array, lastModified: Date }>} */
  const objects = new Map()
  return {
    kind: 'memory',
    async putObject(input) {
      if (input.ifNoneMatch === '*' && objects.has(input.key)) {
        const err = /** @type {Error & { errorKind?: string }} */ (
          new Error(`memory blob-store: precondition failed at '${input.key}'`)
        )
        err.errorKind = 'blob_precondition_failed'
        throw err
      }
      const bytes = input.body instanceof Uint8Array ? input.body : await drain(input.body)
      objects.set(input.key, { bytes, lastModified: new Date() })
      return { key: input.key }
    },
    async getObject(input) {
      const obj = objects.get(input.key)
      if (!obj) return null
      return { body: Readable.from([obj.bytes]), contentLength: obj.bytes.byteLength }
    },
    listObjects(input) {
      const prefix = input.prefix
      return {
        async *[Symbol.asyncIterator]() {
          const entries = Array.from(objects.entries())
            .filter(([k]) => prefix.length === 0 || k.startsWith(prefix))
            .sort((a, b) => a[0].localeCompare(b[0]))
          for (const [key, { bytes, lastModified }] of entries) {
            yield { key, size: bytes.byteLength, lastModified }
          }
        },
      }
    },
    async deleteObject(input) {
      objects.delete(input.key)
    },
  }
}

/**
 * @param {NodeJS.ReadableStream | Uint8Array} body
 */
async function drain(body) {
  if (body instanceof Uint8Array) return body
  /** @type {Uint8Array[]} */
  const chunks = []
  for await (const chunk of /** @type {NodeJS.ReadableStream} */ (body)) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    else chunks.push(chunk)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
}

test('in-memory BlobStore satisfies the BlobStore contract end-to-end', async () => {
  const store = createInMemoryBlobStore()
  assert.equal(store.kind, 'memory')

  await store.putObject({ key: 'a/1', body: new Uint8Array([1]) })
  await store.putObject({ key: 'a/2', body: new Uint8Array([2, 2]) })
  await store.putObject({ key: 'b/1', body: new Uint8Array([3, 3, 3]) })

  const found = []
  for await (const entry of store.listObjects({ prefix: 'a/' })) found.push(entry.key)
  assert.deepEqual(found, ['a/1', 'a/2'])

  const got = await store.getObject({ key: 'a/2' })
  assert.ok(got)
  const bytes = await collectStream(got.body)
  assert.deepEqual(Array.from(bytes), [2, 2])

  assert.ok(store.deleteObject)
  await store.deleteObject({ key: 'a/1' })
  const found2 = []
  for await (const entry of store.listObjects({ prefix: 'a/' })) found2.push(entry.key)
  assert.deepEqual(found2, ['a/2'])

  await assert.rejects(
    () => store.putObject({ key: 'a/2', body: new Uint8Array([9]), ifNoneMatch: '*' }),
    /precondition failed/i,
  )
})
