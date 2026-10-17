// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import { compareStrings } from '../../src/core/util/compare_strings.js'

import {
  createS3BlobStore,
  createUnconfiguredS3BlobStore,
} from '../../hypaware-core/plugins-workspace/s3/src/blob-store.js'

/**
 * @import { BlobStore } from '../../hypaware-plugin-kernel-types.js'
 */

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
        .sort((a, b) => compareStrings(a[0], b[0]))
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

test('s3 BlobStore preserves range headers and scoped keys', async () => {
  const calls = []
  const client = {
    ...makeFakeS3Client(),
    async getObject(input) {
      calls.push(input)
      return {
        Body: Readable.from([Buffer.from('789')]),
        ContentLength: 3,
        ContentRange: 'bytes 7-9/10',
      }
    },
  }
  const store = createS3BlobStore({ bucket: 'bucket', prefix: 'org/private', client })
  for (const range of ['bytes=-3', 'bytes=7-9']) {
    const got = await store.getObject({ key: 'data.parquet', range })
    assert.ok(got)
    assert.equal(got.contentLength, 3)
    assert.equal(got.contentRange, 'bytes 7-9/10')
    const chunks = []
    for await (const chunk of got.body) chunks.push(chunk)
    assert.equal(Buffer.concat(chunks).toString(), '789')
    assert.deepEqual(calls.at(-1), { Bucket: 'bucket', Key: 'org/private/data.parquet', Range: range })
  }
})

test('s3 BlobStore rejects a response that ignored the requested range', async () => {
  // A store may legally answer a ranged GET with 200 and the whole object.
  // Handing that body back as the requested slice would feed a reader the
  // wrong bytes at the right offsets, so the provider must fail instead.
  // A seam handle may report an absent header as undefined, null or '';
  // every one of them means the body is not the slice that was asked for.
  // null is off-contract on purpose: the guard has to hold for a handle
  // that does not respect the declared shape, which is why it is cast.
  for (const ContentRange of /** @type {Array<string | undefined>} */ (
    /** @type {unknown} */ ([undefined, null, ''])
  )) {
    let destroyed = false
    const body = Readable.from([Buffer.from('0123456789')])
    body.destroy = () => { destroyed = true; return body }
    const client = {
      ...makeFakeS3Client(),
      async getObject() {
        return { Body: body, ContentLength: 10, ContentRange, ETag: '"whole"' }
      },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    await assert.rejects(
      store.getObject({ key: 'data.parquet', range: 'bytes=2-4' }),
      (err) => {
        assert.equal(/** @type {{ errorKind?: string }} */ (err).errorKind, 'blob_range_not_honored')
        assert.match(/** @type {Error} */ (err).message, /Content-Range/)
        return true
      },
    )
    assert.equal(destroyed, true, 'the unusable body is released, not leaked')
  }
})

test('s3 BlobStore rejects a Content-Range it cannot check the offsets of', async () => {
  // Presence is not enough. A store that answers 200 with the whole object
  // and a junk Content-Range corrupts exactly as silently as one that sends
  // no Content-Range at all, and a consumer cannot run the offset check the
  // contract gives it against a header that does not parse. '0' and '   '
  // are truthy non-empty strings, so the falsy-value guard alone lets them
  // through; 'bytes */16' is the 416 form and states no offsets.
  for (const ContentRange of /** @type {Array<string | undefined>} */ (/** @type {unknown} */ ([
    '0', '   ', '\t', 'garbage', 'bytes */16', 'bytes 2-4', 'bytes=2-4/16', 'bytes 4-2/16 ',
    // Non-strings: a truthiness-only guard would let these reach a consumer
    // that the contract promises a string, and String/Buffer even stringify
    // into a well-formed header, so only the typeof test rejects them.
    42, new String('bytes 2-4/16'), Buffer.from('bytes 2-4/16'), { toString: () => 'bytes 2-4/16' },
  ]))) {
    let destroyed = false
    const body = Readable.from([Buffer.from('0123456789ABCDEF')])
    body.destroy = () => { destroyed = true; return body }
    const client = {
      ...makeFakeS3Client(),
      async getObject() {
        return { Body: body, ContentLength: 16, ContentRange, ETag: '"whole"' }
      },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    await assert.rejects(
      store.getObject({ key: 'data.parquet', range: 'bytes=2-4' }),
      (err) => {
        assert.equal(/** @type {{ errorKind?: string }} */ (err).errorKind, 'blob_range_not_honored')
        // A non-string normalizes to the same sentinel as an absent header,
        // so it is reported as absent rather than as unusable. Both are the
        // same refusal: the response stated no slice this code can check.
        assert.match(/** @type {Error} */ (err).message, /(no|unusable) Content-Range/)
        return true
      },
      `Content-Range ${JSON.stringify(ContentRange)} must not pass as the requested slice`,
    )
    assert.equal(destroyed, true, 'the unusable body is released, not leaked')
  }
})

test('s3 BlobStore rejects a Content-Range its own ContentLength contradicts', async () => {
  // The header says three bytes and the response carries sixteen. Whichever
  // half is lying, the body is not the slice the header describes, and
  // forwarding it is the same wrong-bytes-at-the-right-offsets corruption
  // as forwarding one with no header at all. Both values are already in
  // hand, so this costs a subtraction and never reads the body.
  // The seam is injectable and public, so ContentLength arrives in whatever
  // shape the handle produced: a handle forwarding a raw content-length
  // header hands over the string '16', not the number. A typeof test would
  // skip this whole check for every such value and return the whole object
  // as the slice, which is the corruption the check exists to stop.
  for (const [ContentRange, ContentLength, expected] of /** @type {Array<[string, number, RegExp]>} */ (/** @type {unknown} */ ([
    ['bytes 2-4/16', 16, /ContentLength 16 against Content-Range/],
    ['bytes 2-4/16', 0, /ContentLength 0 against Content-Range/],
    ['bytes 4-2/16', 16, /reversed Content-Range/],
    // off-contract shapes the seam can still produce
    ['bytes 2-4/16', '16', /ContentLength 16 against Content-Range/],
    ['bytes 2-4/16', null, /ContentLength null against Content-Range/],
    ['bytes 2-4/16', false, /ContentLength false against Content-Range/],
    ['bytes 2-4/16', '', /ContentLength  against Content-Range/],
    ['bytes 2-4/16', 'sixteen', /ContentLength sixteen against Content-Range/],
    ['bytes 2-4/16', 16.5, /ContentLength 16.5 against Content-Range/],
  ]))) {
    let destroyed = false
    const body = Readable.from([Buffer.from('0123456789ABCDEF')])
    body.destroy = () => { destroyed = true; return body }
    const client = {
      ...makeFakeS3Client(),
      async getObject() {
        return { Body: body, ContentLength, ContentRange, ETag: '"whole"' }
      },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    await assert.rejects(
      store.getObject({ key: 'data.parquet', range: 'bytes=2-4' }),
      (err) => {
        assert.equal(/** @type {{ errorKind?: string }} */ (err).errorKind, 'blob_range_not_honored')
        assert.match(/** @type {Error} */ (err).message, expected)
        return true
      },
      `Content-Range '${ContentRange}' with ContentLength ${ContentLength} must not pass`,
    )
    assert.equal(destroyed, true, 'the unusable body is released, not leaked')
  }
})

test('s3 BlobStore rejects a Content-Range whose total does not exceed its last byte', async () => {
  // RFC 7233 requires last-byte-pos < complete-length, so `bytes 2-4/3`
  // describes an object that cannot exist, and that nonsense total is what a
  // consumer would size the object from. Every other check waves it through:
  // the span is positive, ContentLength agrees with it, and the offsets are
  // the ones that were asked for.
  for (const [range, ContentRange, payload] of /** @type {Array<[string, string, string]>} */ ([
    // last byte sits past the end of the object the response describes
    ['bytes=2-4', 'bytes 2-4/3', '234'],
    ['bytes=16-18', 'bytes 16-18/16', 'GHI'],
    ['bytes=0-9', 'bytes 0-9/9', '0123456789'],
    // last byte exactly at the total, one past the last addressable byte
    ['bytes=5-5', 'bytes 5-5/5', '5'],
    ['bytes=0-0', 'bytes 0-0/0', '0'],
  ])) {
    let destroyed = false
    const body = Readable.from([Buffer.from(payload)])
    body.destroy = () => { destroyed = true; return body }
    const client = {
      ...makeFakeS3Client(),
      async getObject() {
        return { Body: body, ContentLength: payload.length, ContentRange, ETag: '"part"' }
      },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    await assert.rejects(
      store.getObject({ key: 'data.parquet', range }),
      err => {
        assert.equal(/** @type {{ errorKind?: string }} */ (err).errorKind, 'blob_range_not_honored')
        assert.match(/** @type {Error} */ (err).message, /impossible Content-Range/)
        return true
      },
      `'${ContentRange}' states a total its own last byte is not below`,
    )
    assert.ok(destroyed, `unusable body for '${ContentRange}' must be destroyed`)
  }
})

test('s3 BlobStore rejects a self-consistent response for a different range', async () => {
  // A store can agree with itself and still answer the wrong question. The
  // suffix case is the one that matters: mishandle `bytes=-3` as "the first
  // three bytes" and a Parquet footer read comes back as the file header,
  // under a Content-Range that is well formed and matches its own
  // ContentLength. Self-consistency cannot catch that, and this provider is
  // the only place holding both the request and the response.
  for (const [range, ContentRange, payload] of /** @type {Array<[string, string, string]>} */ ([
    // suffix read answered with the head of the object
    ['bytes=-3', 'bytes 0-2/16', '012'],
    ['bytes=-8', 'bytes 0-7/16', '01234567'],
    // suffix read that does not reach the end of the object
    ['bytes=-3', 'bytes 5-7/16', '567'],
    // suffix read handed more bytes than it asked for
    ['bytes=-3', 'bytes 12-15/16', '3456'],
    // explicit range answered one byte to the left
    ['bytes=2-4', 'bytes 1-3/16', '123'],
    // explicit range answered with the whole object
    ['bytes=2-4', 'bytes 0-15/16', '0123456789ABCDEF'],
    // open range answered from the wrong offset
    ['bytes=8-', 'bytes 7-15/16', '789ABCDEF'],
    // response reaches past the last byte asked for
    ['bytes=2-4', 'bytes 2-6/16', '23456'],
  ])) {
    let destroyed = false
    const body = Readable.from([Buffer.from(payload)])
    body.destroy = () => { destroyed = true; return body }
    const client = {
      ...makeFakeS3Client(),
      async getObject() {
        return { Body: body, ContentLength: payload.length, ContentRange, ETag: '"part"' }
      },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    await assert.rejects(
      store.getObject({ key: 'data.parquet', range }),
      err => {
        assert.equal(/** @type {{ errorKind?: string }} */ (err).errorKind, 'blob_range_not_honored')
        assert.match(/** @type {Error} */ (err).message, /Content-Range/)
        return true
      },
      `'${ContentRange}' must not pass as the answer to '${range}'`,
    )
    assert.ok(destroyed, `unusable body for '${range}' must be destroyed`)
  }
})

test('s3 BlobStore passes through a well-formed Content-Range', async () => {
  // The rejections above must not have made honored ranges unreachable. Each
  // case states a slice, delivers exactly that slice, and answers the range
  // that was asked for. The unknown-total and clamped-at-EOF forms are legal
  // answers a conforming store gives, so they must still pass.
  for (const [range, ContentRange, payload] of /** @type {Array<[string, string, string]>} */ ([
    ['bytes=2-4', 'bytes 2-4/16', '234'],
    ['bytes=2-4', 'bytes 2-4/*', '234'],
    // whole object as one range: last byte one below the total
    ['bytes=0-9', 'bytes 0-9/10', '0123456789'],
    // end clamped to the last byte of the object
    ['bytes=8-99', 'bytes 8-15/16', '89ABCDEF'],
    ['bytes=8-', 'bytes 8-15/16', '89ABCDEF'],
    // suffix reads, including one longer than the object
    ['bytes=-3', 'bytes 13-15/16', 'DEF'],
    ['bytes=-99', 'bytes 0-15/16', '0123456789ABCDEF'],
    // a suffix whose total the store declined to state
    ['bytes=-3', 'bytes 13-15/*', 'DEF'],
    // a range the provider does not model is not second-guessed
    ['bytes=0-1, 4-5', 'bytes 0-1/16', '01'],
  ])) {
    const client = {
      ...makeFakeS3Client(),
      async getObject() {
        return {
          Body: Readable.from([Buffer.from(payload)]),
          ContentLength: payload.length,
          ContentRange,
          ETag: '"part"',
        }
      },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    const got = await store.getObject({ key: 'data.parquet', range })
    assert.ok(got, `'${ContentRange}' must still answer '${range}'`)
    assert.equal(got.contentRange, ContentRange)
    assert.equal(got.contentLength, payload.length)
  }
})

test('s3 BlobStore accepts a ranged response that omits ContentLength', async () => {
  // ContentLength is optional on the seam, so the cross-check must skip
  // rather than reject when the store does not declare one.
  const client = {
    ...makeFakeS3Client(),
    async getObject() {
      return { Body: Readable.from([Buffer.from('234')]), ContentRange: 'bytes 2-4/16', ETag: '"part"' }
    },
  }
  const store = createS3BlobStore({ bucket: 'bucket', client })
  const got = await store.getObject({ key: 'data.parquet', range: 'bytes=2-4' })
  assert.ok(got)
  assert.equal(got.contentRange, 'bytes 2-4/16')
  assert.equal(got.contentLength, undefined)
})

test('s3 BlobStore surfaces a 416 as blob_range_unsatisfiable, not a put failure', async () => {
  // A range the object cannot satisfy is the one read failure a ranged
  // consumer can act on, by refetching the object whole. Every shape S3
  // raises it in has to land on the same kind local-fs raises, and none of
  // them may keep the 's3_put_failed' default, which names a write.
  for (const fault of /** @type {Array<Record<string, unknown>>} */ ([
    { name: 'InvalidRange', Code: 'InvalidRange', $metadata: { httpStatusCode: 416 } },
    // status only: a handle that surfaces the HTTP status and no error code
    { name: 'S3ServiceException', $metadata: { httpStatusCode: 416 } },
    // code only: the SDK shape that mirrors the code onto .Code alone
    { Code: 'InvalidRange' },
  ])) {
    const client = {
      ...makeFakeS3Client(),
      async getObject() {
        throw Object.assign(new Error('The requested range is not satisfiable'), fault)
      },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    await assert.rejects(
      store.getObject({ key: 'data.parquet', range: 'bytes=200-299' }),
      err => {
        assert.equal(/** @type {{ errorKind?: string }} */ (err).errorKind, 'blob_range_unsatisfiable')
        assert.match(/** @type {Error} */ (err).message, /byte range 'bytes=200-299' is unsatisfiable/)
        return true
      },
      `416 shape ${JSON.stringify(fault)} must be named as an unsatisfiable range`,
    )
  }
})

test('s3 BlobStore leaves an unranged failure to the AWS classifier', async () => {
  // The 416 branch is reachable only from a ranged read: a whole-object read
  // cannot draw one, so a store that raised it anyway is failing, not
  // answering, and must keep the classifier's kind.
  const client = {
    ...makeFakeS3Client(),
    async getObject() {
      throw Object.assign(new Error('confused store'), {
        name: 'InvalidRange',
        $metadata: { httpStatusCode: 416 },
      })
    },
  }
  const store = createS3BlobStore({ bucket: 'bucket', client })
  await assert.rejects(
    store.getObject({ key: 'whole.bin' }),
    err => /** @type {{ errorKind?: string }} */ (err).errorKind === 's3_put_failed',
  )
})

test('s3 BlobStore leaves whole-object reads without a contentRange key', async () => {
  const client = makeFakeS3Client()
  const store = createS3BlobStore({ bucket: 'bucket', client })
  await store.putObject({ key: 'whole.bin', body: Buffer.from('payload') })
  const got = await store.getObject({ key: 'whole.bin' })
  assert.ok(got)
  assert.equal('contentRange' in got, false)
  assert.deepEqual(client.calls.at(-1)?.input, { Bucket: 'bucket', Key: 'whole.bin' })
})

test('s3 BlobStore drops a contentRange volunteered on a whole-object read', async () => {
  // The guard only runs for a ranged read, so a header a store volunteers on
  // a read that asked for no range would reach the consumer unchecked. LLP
  // 0452#range-contract makes an absent contentRange mean "whole object", so
  // forwarding one here states the opposite of the truth.
  for (const ContentRange of ['bytes 0-2/3', 'garbage', 'bytes 0-15/16']) {
    const client = {
      ...makeFakeS3Client(),
      async getObject() {
        return { Body: Readable.from([Buffer.from('0123456789ABCDEF')]), ContentLength: 16, ContentRange, ETag: '"whole"' }
      },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    const got = await store.getObject({ key: 'whole.bin' })
    assert.ok(got)
    assert.equal('contentRange' in got, false, `volunteered '${ContentRange}' must not reach a whole-object result`)
  }
})

test('s3 BlobStore reads a web ReadableStream body instead of reporting it empty', async () => {
  // The handle is an injectable public seam and @aws-sdk/client-s3 ships a
  // fetch-based request handler whose Body is a WHATWG ReadableStream, which
  // has no `pipe`. Falling through to an empty stream would answer a footer
  // read with zero bytes beside a contentLength that says otherwise, and no
  // caller can tell that from an object that really is empty.
  for (const range of /** @type {Array<string | undefined>} */ ([undefined, 'bytes=0-15'])) {
    const client = {
      ...makeFakeS3Client(),
      async getObject() {
        return {
          Body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('0123456789'))
              controller.enqueue(new TextEncoder().encode('ABCDEF'))
              controller.close()
            },
          }),
          ContentLength: 16,
          ...(range !== undefined ? { ContentRange: 'bytes 0-15/16' } : {}),
          ETag: '"web"',
        }
      },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    const got = await store.getObject({ key: 'data.parquet', ...(range !== undefined ? { range } : {}) })
    assert.ok(got)
    const chunks = []
    for await (const chunk of got.body) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString('utf8'), '0123456789ABCDEF')
    assert.equal(got.contentLength, 16)
  }
})

test('s3 BlobStore refuses a body shape it cannot read rather than calling it empty', async () => {
  // Zero bytes is the worst reading of "this shape is unknown": it is exactly
  // what a genuinely empty object looks like, so the caller cannot tell a
  // lost body from real data. Every shape outside the declared union throws.
  for (const [what, Body] of /** @type {Array<[string, any]>} */ ([
    ['async iterable without pipe', { async *[Symbol.asyncIterator]() { yield Buffer.from('0123456789ABCDEF') } }],
    ['plain object', { bytes: '0123456789ABCDEF' }],
    ['Blob', new Blob(['0123456789ABCDEF'])],
    ['number', 42],
    ['boolean', true],
    ['array of chunks', [Buffer.from('0123456789ABCDEF')]],
    // `getReader` is the web-stream probe, so a body that only looks like one
    // must not escape as the untagged TypeError `Readable.fromWeb` raises.
    ['callable getReader that is not a ReadableStream', { getReader() { return { read: async () => ({ done: true }) } } }],
    ['web ReadableStream already locked', lockedWebStream()],
  ])) {
    const client = {
      ...makeFakeS3Client(),
      async getObject() { return { Body, ContentLength: 16, ETag: '"odd"' } },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    await assert.rejects(
      store.getObject({ key: 'data.parquet' }),
      (err) => {
        assert.equal(/** @type {{ errorKind?: string }} */ (err).errorKind, 'blob_body_unusable')
        assert.match(/** @type {Error} */ (err).message, /unusable shape/)
        return true
      },
      `${what} must not pass as an empty object`,
    )
  }
  // A body `Readable.fromWeb` will not take is still released, not held: the
  // refusal path must not reintroduce the leak `releaseBody` exists to close.
  let released = 0
  const notAStream = /** @type {any} */ ({ getReader() { return { read: async () => ({ done: true }) } }, cancel() { released += 1 } })
  const store = createS3BlobStore({
    bucket: 'bucket',
    client: { ...makeFakeS3Client(), async getObject() { return { Body: notAStream, ContentLength: 16, ETag: '"odd"' } } },
  })
  await assert.rejects(store.getObject({ key: 'data.parquet' }), { errorKind: 'blob_body_unusable' })
  assert.equal(released, 1, 'a body the adapter refused is released exactly once')
  // The adapter's own error is what says whether the body was not a stream or
  // was a stream someone else already holds. A refusal reported as shape
  // `ReadableStream` is unreadable without it, since that shape is the one
  // the union says is adapted. It has to reach the message and not only the
  // cause, because a consumer forwards the message alone: format-iceberg's
  // `describeError` returns `err.message`.
  for (const [what, body, reason] of /** @type {Array<[string, any, RegExp]>} */ ([
    ['a callable getReader that is not a stream', notAStream, /must be an instance of ReadableStream/],
    ['a locked ReadableStream', lockedWebStream(), /locked/],
  ])) {
    const refused = createS3BlobStore({
      bucket: 'bucket',
      client: { ...makeFakeS3Client(), async getObject() { return { Body: body, ContentLength: 16, ETag: '"odd"' } } },
    })
    const err = await refusalError(refused)
    assert.ok(err.cause instanceof Error, `${what} keeps the adapter's error as cause`)
    assert.match(err.message, reason, `${what} names the reason in the message a consumer forwards`)
  }
})

/**
 * Read back the error `getObject` throws for a body it will not read.
 *
 * @param {BlobStore} store
 * @returns {Promise<Error & { cause?: unknown }>}
 */
async function refusalError(store) {
  try {
    await store.getObject({ key: 'data.parquet' })
  } catch (err) {
    return /** @type {Error & { cause?: unknown }} */ (err)
  }
  throw new Error('getObject resolved where it had to throw')
}

/** A web stream whose reader is already held, which `Readable.fromWeb` rejects. */
function lockedWebStream() {
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('0123456789ABCDEF')); c.close() } })
  stream.getReader()
  return stream
}

/** Byte sequences a blob store has to deliver exactly or not at all. */
const BINARY_FIXTURES = /** @type {Array<[string, Buffer]>} */ ([
  // The Parquet-shaped payload from #2324: reading it as UTF-8 turns its
  // three bytes above 0x7F into six and delivers 17 bytes under a
  // ContentLength of 14.
  ['a Parquet header with bytes above 0x7F', Buffer.from('50415231007f80ffc32850415231', 'hex')],
  ['every one of the 256 byte values', Buffer.from(Array.from({ length: 256 }, (_, i) => i))],
  ['a lone 0x80, which is not valid UTF-8 alone', Buffer.from([0x80])],
  // Bytes that are valid UTF-8 must survive too: a fix that swapped UTF-8
  // for another single guess would corrupt these instead.
  ['a valid multi-byte UTF-8 sequence', Buffer.from('PAR1 € 中 é', 'utf8')],
  ['no bytes at all', Buffer.alloc(0)],
])

test('s3 BlobStore delivers a binary body byte for byte', async () => {
  // contentLength is the store's account of the body, and nothing
  // downstream compares the two, so a body that disagrees with it is not
  // caught later. Every shape the union declares has to hand back the exact
  // bytes it was given.
  for (const [what, payload] of BINARY_FIXTURES) {
    for (const [shape, make] of /** @type {Array<[string, () => any]>} */ ([
      ['node stream', () => Readable.from([payload])],
      ['Uint8Array', () => new Uint8Array(payload)],
      ['Buffer', () => Buffer.from(payload)],
      ['web ReadableStream', () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(payload)); c.close() } })],
    ])) {
      const client = {
        ...makeFakeS3Client(),
        async getObject() { return { Body: make(), ContentLength: payload.byteLength, ETag: '"bin"' } },
      }
      const store = createS3BlobStore({ bucket: 'bucket', client })
      const got = await store.getObject({ key: 'data.parquet' })
      assert.ok(got)
      const chunks = []
      for await (const chunk of got.body) chunks.push(Buffer.from(chunk))
      const delivered = Buffer.concat(chunks)
      assert.equal(delivered.toString('hex'), payload.toString('hex'),
        `${shape} must deliver ${what} unchanged`)
      assert.equal(got.contentLength, delivered.byteLength,
        `${shape} must deliver as many bytes as contentLength declares for ${what}`)
    }
  }
})

test('s3 BlobStore refuses a string body rather than guessing its encoding', async () => {
  // A string is the one shape withdrawn from the declared union. It carries
  // no encoding, so reading it means guessing one, and both guesses corrupt
  // real payloads without raising: UTF-8 re-encodes every byte above 0x7F,
  // and latin1 truncates every code point above U+00FF. Refusing is the
  // only answer that never hands back bytes the store did not send.
  for (const [what, payload] of BINARY_FIXTURES) {
    // `any`, because the union no longer admits a string: the compiler now
    // rejects one at this seam, which is half of what this change is for,
    // and the test still has to hand the provider what a handle might.
    for (const [encoding, asString] of /** @type {Array<[BufferEncoding, any]>} */ ([
      ['latin1', payload.toString('latin1')],
      ['utf8', payload.toString('utf8')],
    ])) {
      const client = {
        ...makeFakeS3Client(),
        async getObject() { return { Body: asString, ContentLength: payload.byteLength, ETag: '"str"' } },
      }
      const store = createS3BlobStore({ bucket: 'bucket', client })
      await assert.rejects(
        store.getObject({ key: 'data.parquet' }),
        (err) => {
          assert.equal(/** @type {{ errorKind?: string }} */ (err).errorKind, 'blob_body_unusable')
          assert.match(/** @type {Error} */ (err).message, /unusable shape \(string\)/)
          // A string holds nothing to close and nothing to adapt, so the
          // release the refusal runs has to pass over it rather than throw
          // on a missing destroy and replace the typed error with a
          // TypeError, and no adapter failure stands behind it.
          assert.equal(/** @type {{ cause?: unknown }} */ (err).cause, undefined)
          return true
        },
        `${what} stringified as ${encoding} must not resolve`,
      )
    }
  }
})

test('s3 BlobStore still reads a genuinely empty object as empty', async () => {
  // The refusal above must not have made emptiness unreportable. Every
  // in-contract shape of a zero-byte body still succeeds with zero bytes.
  // A zero-length string is not one: admitting the single string whose
  // encoding cannot matter would make the contract depend on body length.
  for (const [what, Body] of /** @type {Array<[string, any]>} */ ([
    ['node stream', Readable.from([])],
    ['node stream of one empty chunk', Readable.from([Buffer.alloc(0)])],
    ['Uint8Array', new Uint8Array(0)],
    ['web ReadableStream', new ReadableStream({ start(c) { c.close() } })],
  ])) {
    const client = {
      ...makeFakeS3Client(),
      async getObject() { return { Body, ContentLength: 0, ETag: '"empty"' } },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    const got = await store.getObject({ key: 'empty.bin' })
    assert.ok(got, `an empty ${what} body is an empty object, not a missing one`)
    const chunks = []
    for await (const chunk of got.body) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).byteLength, 0)
    assert.equal(got.contentLength, 0)
  }
})

test('s3 BlobStore releases a web ReadableStream body on the rejection path', async () => {
  // The range guard releases the body it refuses so the connection is not
  // held. A web stream has no destroy(), so a destroy-only release left it
  // open, and the cancel() that does release it returns a promise whose
  // rejection must not surface as an unhandled rejection or replace the
  // typed error the caller is waiting for.
  for (const cancel of /** @type {Array<() => void | Promise<void>>} */ ([
    () => {},
    () => Promise.reject(new Error('cancel failed')),
  ])) {
    let cancelled = false
    const body = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('0123456789ABCDEF')); c.close() },
      cancel() { cancelled = true; return cancel() },
    })
    const client = {
      ...makeFakeS3Client(),
      async getObject() { return { Body: body, ContentLength: 16, ETag: '"web"' } },
    }
    const store = createS3BlobStore({ bucket: 'bucket', client })
    await assert.rejects(
      store.getObject({ key: 'data.parquet', range: 'bytes=2-4' }),
      (err) => {
        assert.equal(/** @type {{ errorKind?: string }} */ (err).errorKind, 'blob_range_not_honored')
        return true
      },
    )
    assert.equal(cancelled, true, 'a cancel-only body is released, not leaked')
  }
  // A settled microtask turn: a swallowed cancel() rejection would surface
  // as an unhandled rejection by now if it were not absorbed.
  await new Promise((resolve) => setImmediate(resolve))
})

test('s3 BlobStore getObject returns null when AWS reports NotFound', async () => {
  const client = makeFakeS3Client()
  const store = createS3BlobStore({ bucket: 'my-bucket', client })
  const got = await store.getObject({ key: 'does/not/exist' })
  assert.equal(got, null)
})

test('the fake S3 client returns keys in byte order, the way ListObjectsV2 does', async () => {
  // The BlobStore hands its caller whatever order the client answered in, so
  // every listing test above is only as faithful as this double's sort. Sorted
  // by the characters it is the service; sorted by the host collation it is
  // the box the suite ran on, and nothing in the tree could tell the two apart
  // until this.
  //
  // Four keys chosen so byte order and collation disagree twice over, on the
  // two pairs `compare-strings.test.js` names: the characters put `B` before
  // `a` and `-` before `_`, and every collation probed (`en-US`, `de-DE`,
  // `lt-LT`, `az`, `tr-TR`) reverses both. So this listing tells a
  // byte-ordered double from a collated one on any box with ICU data, which is
  // the fidelity no assertion in the tree made when the doubles moved to
  // `compareStrings` (#1148 item 3). A bucket really does answer in this
  // order: for a general-purpose bucket S3 returns keys sorted by UTF-8 byte
  // value, and for these keys that is the same as UTF-16 code unit order.
  const client = makeFakeS3Client()
  const store = createS3BlobStore({ bucket: 'my-bucket', prefix: 'hyp/exports', client })
  for (const key of ['ds/x_1.parquet', 'ds/a.parquet', 'ds/x-1.parquet', 'ds/B.parquet']) {
    await store.putObject({ key, body: new Uint8Array([1]) })
  }
  const seen = []
  for await (const entry of store.listObjects({ prefix: '' })) seen.push(entry.key)
  assert.deepEqual(seen, ['ds/B.parquet', 'ds/a.parquet', 'ds/x-1.parquet', 'ds/x_1.parquet'])
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
  // BlobStore-level prefix actually reached S3, and it MUST carry a
  // trailing slash so a sibling namespace like `hyp/exports2/...` does
  // not match as a string prefix.
  const listCall = client.calls.find((c) => c.command === 'listObjects')
  assert.ok(listCall)
  assert.equal(listCall.input.Prefix, 'hyp/exports/')
})

test('s3 BlobStore listObjects does not leak into sibling-namespace keys (hyp/exports vs hyp/exports2)', async () => {
  // Regression for the codex prefix-scope leak: S3's ListObjectsV2 is a
  // bare string-prefix match, so `Prefix: 'hyp/exports'` will return
  // keys under `hyp/exports2/...` too. The BlobStore must (1) send a
  // trailing-slash prefix to S3 and (2) refuse to yield any key that
  // does not start with `${normalized}/`, so cleanup/delete loops
  // cannot touch out-of-scope objects.
  const client = makeFakeS3Client()
  // Pre-populate the fake bucket directly to bypass composeKey's path
  // safety check: we want sibling-namespace keys to exist in the
  // backing store so the test can confirm they are NOT surfaced.
  client.objects.set('hyp/exports/datasets/foo.parquet',
    { bytes: new Uint8Array([1]), lastModified: new Date(0) })
  client.objects.set('hyp/exports/datasets/sub/bar.parquet',
    { bytes: new Uint8Array([2]), lastModified: new Date(0) })
  // Sibling namespace: must never be reported through this BlobStore.
  client.objects.set('hyp/exports2/datasets/leak.parquet',
    { bytes: new Uint8Array([9]), lastModified: new Date(0) })
  client.objects.set('hyp/exports-other/leak2.parquet',
    { bytes: new Uint8Array([9]), lastModified: new Date(0) })

  const store = createS3BlobStore({ bucket: 'my-bucket', prefix: 'hyp/exports', client })

  /** @type {string[]} */
  const seen = []
  for await (const entry of store.listObjects({ prefix: '' })) seen.push(entry.key)
  assert.deepEqual(seen.sort(), ['datasets/foo.parquet', 'datasets/sub/bar.parquet'])

  // S3 Prefix must terminate at a slash so the sibling-namespace match
  // never happens at the AWS layer either.
  const listCall = client.calls.find((c) => c.command === 'listObjects')
  assert.ok(listCall)
  assert.equal(listCall.input.Prefix, 'hyp/exports/')

  // Defense in depth: even if a future caller passed a non-empty
  // `input.prefix` without a trailing slash (which S3 would still
  // string-prefix match), the yielded keys must stay inside scope.
  // Simulate that by directly invoking the fake to bypass the BlobStore
  // composeKey trailing-slash logic.
  client.calls.length = 0
  const seenScoped = []
  for await (const entry of store.listObjects({ prefix: 'datasets' })) seenScoped.push(entry.key)
  // The sibling `hyp/exports2/...` key shares no `hyp/exports/datasets`
  // prefix, but a buggy implementation could surface it via the
  // wider sibling match. We assert ONLY the in-scope datasets are
  // visible.
  assert.deepEqual(seenScoped.sort(), ['datasets/foo.parquet', 'datasets/sub/bar.parquet'])
})

test('s3 BlobStore listObjects empty-prefix without a configured prefix lists the whole bucket', async () => {
  // No configured prefix means there is no scope to leak into; the
  // BlobStore should not append a trailing slash that would needlessly
  // narrow the S3 query.
  const client = makeFakeS3Client()
  client.objects.set('a.bin', { bytes: new Uint8Array([1]), lastModified: new Date(0) })
  client.objects.set('nested/b.bin', { bytes: new Uint8Array([2]), lastModified: new Date(0) })
  const store = createS3BlobStore({ bucket: 'my-bucket', client })
  /** @type {string[]} */
  const seen = []
  for await (const entry of store.listObjects({ prefix: '' })) seen.push(entry.key)
  assert.deepEqual(seen.sort(), ['a.bin', 'nested/b.bin'])
  const listCall = client.calls.find((c) => c.command === 'listObjects')
  assert.ok(listCall)
  // No Prefix passed to S3: entire bucket is in scope by design.
  assert.equal(listCall.input.Prefix, undefined)
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
  const store = /** @type {BlobStore & { bucket?: string, prefix?: string }} */ (
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
  assert.ok(store.deleteObject, 'store exposes deleteObject')
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
