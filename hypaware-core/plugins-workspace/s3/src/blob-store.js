// @ts-check

import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import { normalizePrefix } from './config.js'
import { classifyAwsError } from './errors.js'

/**
 * @import { BlobStore, DeleteObjectInput, GetObjectInput, GetObjectResult, ListObjectResult, ListObjectsInput, PutObjectInput, PutObjectResult } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { S3BlobStoreClientFactory, S3CommandsHandle } from './types.js'
 * @import { S3ClientConfig } from '@aws-sdk/client-s3'
 */

export const BLOB_STORE_KIND = 's3'

/**
 * A usable ranged response states the offsets it actually delivered, as
 * `bytes start-end/total` (RFC 7233 also allows `*` for an unknown total).
 * The 416 unsatisfiable form states no offsets, so it does not qualify.
 * Anything else cannot be checked against what was asked for.
 */
const RANGED_RESPONSE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/

/** The three request forms LLP 0452#range-contract admits. */
const REQUESTED_RANGE = /^bytes=(\d*)-(\d*)$/

/**
 * Report how a ranged response contradicts the range that was asked for, or
 * undefined when it does not.
 *
 * Self-consistency is not enough on its own. A store that mishandles a suffix
 * range answers `bytes=-3` with the FIRST three bytes under `bytes 0-2/16`:
 * well formed, agreeing with its own ContentLength, and wrong. Suffix ranges
 * are how a Parquet footer is read (LLP 0452#why), so that is the likely
 * defect, not an exotic one, and this provider is the only place holding both
 * the request and the response.
 *
 * Only a definite contradiction is reported. A request form this does not
 * model, or a total the response left unknown, yields undefined rather than a
 * rejection, so no response that is accepted today and actually correct starts
 * failing. Short reads stay with the consumer, as does a range narrower than
 * the one asked for.
 *
 * @param {string} range the `input.range` that was sent
 * @param {number} start first byte the response states it delivered
 * @param {number} end last byte the response states it delivered
 * @param {number | undefined} total complete length, when the response stated one
 * @returns {string | undefined}
 */
function contradictsRequest(range, start, end, total) {
  const asked = REQUESTED_RANGE.exec(range)
  if (asked === null) return undefined
  const first = asked[1] === '' ? undefined : Number(asked[1])
  const last = asked[2] === '' ? undefined : Number(asked[2])
  if (first === undefined) {
    if (last === undefined) return undefined
    if (end - start + 1 > last) return `delivers more than the ${last} bytes the suffix asked for`
    if (total !== undefined && end !== total - 1) return 'is a suffix that does not end at the object end'
    return undefined
  }
  if (start !== first) return `starts at ${start}, not the requested ${first}`
  if (last !== undefined && end > last) return `ends at ${end}, past the requested ${last}`
  return undefined
}

/**
 * Construct an S3-backed `BlobStore`. The factory is injectable so the
 * smoke and unit tests can supply a fake S3 client without spinning up
 * the AWS SDK. Production builds wire `defaultS3BlobStoreClientFactory`.
 *
 * Keys passed to put/get/delete are relative: the BlobStore prepends
 * the configured `prefix` (slash-joined) before calling into S3. `prefix`
 * is normalized at construction so callers do not have to think about
 * trailing slashes.
 *
 * @param {{
 *   bucket: string,
 *   prefix?: string,
 *   client: S3CommandsHandle,
 * }} args
 * @returns {BlobStore}
 */
export function createS3BlobStore({ bucket, prefix, client }) {
  if (typeof bucket !== 'string' || bucket.length === 0) {
    throw new Error('createS3BlobStore: bucket is required')
  }
  const normalized = normalizePrefix(prefix ?? '')

  /**
   * @param {string} key
   */
  function composeKey(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('s3 blob-store: key must be a non-empty string')
    }
    if (key.includes('\\')) {
      throw new Error(`s3 blob-store: key '${key}' contains a backslash`)
    }
    if (key.startsWith('/') || key.includes('/../') || key.startsWith('../') || key === '..') {
      throw new Error(`s3 blob-store: key '${key}' escapes the configured prefix`)
    }
    return normalized.length > 0 ? `${normalized}/${key}` : key
  }

  /**
   * @param {string} fullKey
   */
  function relativeFromFullKey(fullKey) {
    if (normalized.length === 0) return fullKey
    const head = `${normalized}/`
    return fullKey.startsWith(head) ? fullKey.slice(head.length) : fullKey
  }

  return {
    kind: BLOB_STORE_KIND,
    // `bucket` and `prefix` are surfaced on the returned BlobStore so
    // consumers that care about S3-specific telemetry (e.g. the iceberg
    // commit span) can read them without reaching back into config.
    // They are advisory: the BlobStore methods do not consult these
    // properties, the original closure values are the source of truth.
    bucket,
    prefix: normalized,

    /**
     * @param {PutObjectInput} input
     * @returns {Promise<PutObjectResult>}
     */
    async putObject(input) {
      const Key = composeKey(input.key)
      const body = await materializeBody(input.body)
      /** @type {Parameters<S3CommandsHandle['putObject']>[0]} */
      const command = {
        Bucket: bucket,
        Key,
        Body: body,
        ContentLength: body.byteLength,
      }
      if (input.contentType) command.ContentType = input.contentType
      if (input.metadata) command.Metadata = input.metadata
      // Iceberg needs ifNoneMatch=* for atomic metadata-file commits. The
      // AWS SDK forwards `IfNoneMatch` to the corresponding HTTP header;
      // S3 returns `PreconditionFailed` when the object already exists.
      if (input.ifNoneMatch === '*') command.IfNoneMatch = '*'
      try {
        const result = await client.putObject(command)
        return { key: input.key, etag: result?.ETag, versionId: result?.VersionId }
      } catch (err) {
        if (isPreconditionFailed(err)) {
          throw tagS3Error(err, 'blob_precondition_failed',
            `s3 blob-store: precondition failed (object already exists at '${input.key}')`,
            input.key)
        }
        throw tagS3Error(err, classifyAwsError(err),
          `s3 blob-store: putObject failed for '${input.key}'`, input.key)
      }
    },

    /**
     * @param {GetObjectInput} input
     * @returns {Promise<GetObjectResult | null>}
     */
    async getObject(input) {
      const Key = composeKey(input.key)
      /** @type {Awaited<ReturnType<S3CommandsHandle['getObject']>>} */
      let result
      try {
        // @ref LLP 0452#range-contract [implements]: preserve the byte range through the same credential and prefix path as whole reads
        result = await client.getObject({ Bucket: bucket, Key, ...(input.range !== undefined ? { Range: input.range } : {}) })
      } catch (err) {
        if (isNotFound(err)) return null
        throw tagS3Error(err, classifyAwsError(err),
          `s3 blob-store: getObject failed for '${input.key}'`, input.key)
      }
      if (!result || result.Body === null || result.Body === undefined) return null
      // `S3CommandsHandle` is an injectable seam, and a handle may report an
      // absent header as null or '' rather than undefined. Reduce all three
      // to one sentinel before anything branches on it.
      const contentRange = typeof result.ContentRange === 'string' && result.ContentRange !== ''
        ? result.ContentRange
        : undefined
      // Passing a whole object back as though it were the requested slice
      // would hand a Parquet reader the wrong bytes at the right offsets,
      // which reads as a decode error at best and as wrong query results at
      // worst. So a ranged read accepts only a response that states the
      // slice it delivered: a well-formed Content-Range whose span agrees
      // with ContentLength. Presence alone is not enough, on either half. A
      // header the consumer cannot parse leaves it unable to run the offset
      // check the contract assigns it, a header whose stated total does not
      // exceed the last byte it delivered describes an object that cannot
      // exist (RFC 7233 requires last-byte-pos below complete-length), and a
      // header contradicted by the declared body length is not describing
      // this body at all. Finally the stated offsets are checked against the
      // ones asked for, because a store can be self-consistent and still
      // wrong: mishandle a suffix range and `bytes=-3` comes back as
      // `bytes 0-2/16`, the first three bytes of a Parquet footer read under
      // a header with nothing visibly amiss. Counting the delivered body
      // stays with the consumer; this never reads the body.
      // @ref LLP 0452#range-contract [implements]: honor the range or fail, checked against both the response's own account of itself and the request
      if (input.range !== undefined) {
        const stated = contentRange === undefined ? null : RANGED_RESPONSE.exec(contentRange)
        const start = Number(stated?.[1])
        const end = Number(stated?.[2])
        const span = stated === null ? undefined : end - start + 1
        // '*' is a total the store declined to state. Unknown is not wrong,
        // so it leaves both the check below and the suffix end-at-EOF check
        // with nothing to compare against.
        const total = stated === null || stated[3] === '*' ? undefined : Number(stated[3])
        // ContentLength comes off the same injectable seam, where a handle
        // forwarding a raw content-length header yields the string '16'
        // rather than a number. A typeof test would skip the cross-check for
        // every such value and hand the whole object back as the slice, so
        // reduce anything the store did declare to one number, the way the
        // sentinel above reduces ContentRange. Only an undeclared length
        // skips the check; a value that will not coerce becomes NaN and
        // fails closed.
        const declared = result.ContentLength === undefined ? undefined : Number(result.ContentLength)
        /** @type {string | undefined} */
        let detail
        if (contentRange === undefined) {
          detail = 'response carried no Content-Range'
        } else if (stated === null) {
          detail = `response carried an unusable Content-Range '${contentRange}'`
        } else if (!(/** @type {number} */ (span) >= 1)) {
          detail = `response carried a reversed Content-Range '${contentRange}'`
        } else if (total !== undefined && end >= total) {
          detail = `response carried an impossible Content-Range '${contentRange}'`
        } else if (declared !== undefined && declared !== span) {
          detail = `response declared ContentLength ${result.ContentLength} against Content-Range '${contentRange}'`
        } else {
          const contradiction = contradictsRequest(input.range, start, end, total)
          if (contradiction !== undefined) {
            detail = `response Content-Range '${contentRange}' ${contradiction}`
          }
        }
        if (detail !== undefined) {
          releaseBody(result.Body)
          throw tagS3Error(undefined, 'blob_range_not_honored',
            `s3 blob-store: byte range '${input.range}' was not honored for '${input.key}' (${detail})`,
            input.key)
        }
      }
      return {
        body: toReadable(result.Body, input.key),
        contentLength: result.ContentLength,
        // Only a ranged read can carry a contentRange, and only one the
        // guard above validated. LLP 0452#range-contract makes an absent
        // contentRange mean "whole object", so forwarding a header a store
        // volunteered on a read that asked for no range would tell the
        // consumer the opposite of the truth, unchecked.
        ...(input.range !== undefined && contentRange !== undefined ? { contentRange } : {}),
        etag: result.ETag,
      }
    },

    /**
     * @param {ListObjectsInput} input
     */
    listObjects(input) {
      // When the caller asks for "everything under the configured
      // prefix" (input.prefix === ''), force a trailing slash on the
      // S3 Prefix. S3 treats Prefix as a bare string match, so
      // `Prefix: 'hyp/exports'` would list keys under the sibling
      // `hyp/exports2/...` namespace and surface them as in-scope.
      // The trailing slash narrows the match to the directory.
      let prefixComposed
      if (input.prefix && input.prefix.length > 0) {
        prefixComposed = composeKey(input.prefix)
      } else if (normalized.length > 0) {
        prefixComposed = `${normalized}/`
      } else {
        prefixComposed = ''
      }
      // Defense in depth: even if the eventual S3 Prefix expanded
      // wider than intended (e.g. caller-supplied prefix without a
      // trailing slash), refuse to yield keys that fall outside the
      // configured `normalized/` namespace. Callers iterate
      // listObjects() to delete or read objects; an out-of-scope key
      // that slipped through would be acted on as if it belonged to
      // this BlobStore.
      const scopeGuard = normalized.length > 0 ? `${normalized}/` : ''
      const initialToken = input.continuationToken
      return {
        async *[Symbol.asyncIterator]() {
          /** @type {string | undefined} */
          let token = initialToken
          while (true) {
            let page
            try {
              page = await client.listObjects({
                Bucket: bucket,
                Prefix: prefixComposed.length > 0 ? prefixComposed : undefined,
                ContinuationToken: token,
              })
            } catch (err) {
              throw tagS3Error(err, classifyAwsError(err),
                `s3 blob-store: listObjects failed for prefix '${prefixComposed}'`,
                prefixComposed)
            }
            for (const entry of page?.Contents ?? []) {
              if (typeof entry?.Key !== 'string') continue
              if (scopeGuard.length > 0 && !entry.Key.startsWith(scopeGuard)) continue
              const lastModified = entry.LastModified instanceof Date ? entry.LastModified : new Date(0)
              yield /** @type {ListObjectResult} */ ({
                key: relativeFromFullKey(entry.Key),
                size: typeof entry.Size === 'number' ? entry.Size : 0,
                lastModified,
              })
            }
            if (!page?.NextContinuationToken) return
            token = page.NextContinuationToken
          }
        },
      }
    },

    /**
     * @param {DeleteObjectInput} input
     */
    async deleteObject(input) {
      const Key = composeKey(input.key)
      try {
        await client.deleteObject({ Bucket: bucket, Key })
      } catch (err) {
        // 404 on delete is benign; AWS sometimes returns it on
        // already-deleted keys depending on bucket configuration.
        if (isNotFound(err)) return
        throw tagS3Error(err, classifyAwsError(err),
          `s3 blob-store: deleteObject failed for '${input.key}'`, input.key)
      }
    },
  }
}

/**
 * Wrap a thrown AWS SDK error with a stable `errorKind` token so callers
 * (e.g. the iceberg blob-io adapter) can branch on the kind without
 * re-classifying the SDK's error shapes themselves. Preserves the
 * original error as `cause` so deeper debugging (e.g. request ids in
 * `$metadata`) still has the raw object.
 *
 * @param {unknown} cause
 * @param {string} errorKind
 * @param {string} message
 * @param {string} key
 * @returns {Error & { errorKind: string, key: string, cause: unknown }}
 */
function tagS3Error(cause, errorKind, message, key) {
  const wrapped = /** @type {Error & { errorKind: string, key: string, cause: unknown }} */ (
    new Error(message)
  )
  wrapped.errorKind = errorKind
  wrapped.key = key
  wrapped.cause = cause
  return wrapped
}

/**
 * Lazily build a real S3 commands handle. The AWS SDK is imported on
 * first use to keep the boot path cheap when no s3 BlobStore is
 * configured.
 *
 * @type {S3BlobStoreClientFactory}
 */
export async function defaultS3BlobStoreClientFactory(opts) {
  /** @type {S3ClientConfig} */
  const clientConfig = {}
  if (opts.region) clientConfig.region = opts.region
  if (opts.endpoint_url) clientConfig.endpoint = opts.endpoint_url
  if (opts.force_path_style) clientConfig.forcePathStyle = true
  if (opts.profile) {
    const { fromIni } = await import('@aws-sdk/credential-provider-ini')
    clientConfig.credentials = fromIni({ profile: opts.profile })
  }
  const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    DeleteObjectCommand,
  } = await import('@aws-sdk/client-s3')
  const client = new S3Client(clientConfig)
  return {
    async putObject(input) {
      const result = await client.send(new PutObjectCommand(input))
      return { ETag: result.ETag, VersionId: result.VersionId }
    },
    async getObject(input) {
      const result = await client.send(new GetObjectCommand(input))
      return {
        Body: /** @type {NodeJS.ReadableStream | Uint8Array | null | undefined} */ (
          /** @type {unknown} */ (result.Body)
        ),
        ContentLength: result.ContentLength,
        ContentRange: result.ContentRange,
        ETag: result.ETag,
      }
    },
    async listObjects(input) {
      const result = await client.send(new ListObjectsV2Command(input))
      return {
        Contents: (result.Contents ?? []).map((c) => ({
          Key: c.Key,
          Size: c.Size,
          LastModified: c.LastModified,
        })),
        NextContinuationToken: result.NextContinuationToken,
      }
    },
    async deleteObject(input) {
      await client.send(new DeleteObjectCommand(input))
    },
  }
}

/**
 * Build a sentinel `BlobStore` that fails every call with a clear
 * actionable error. The s3 plugin returns this when activation runs
 * without a plugin-level bucket: the capability still resolves (so
 * downstream consumers can discover the s3 provider exists) but using
 * it without configuration is a programming error, not a silent
 * fallback.
 *
 * @returns {BlobStore}
 */
export function createUnconfiguredS3BlobStore() {
  const message =
    `@hypaware/s3 blob-store has no bucket configured. Set plugins[].config.bucket ` +
    `under the @hypaware/s3 entry in your v2 config to enable s3 BlobStore use.`
  /** @type {BlobStore} */
  return {
    kind: BLOB_STORE_KIND,
    async putObject() { throw makeErr(message) },
    async getObject() { throw makeErr(message) },
    listObjects() {
      return {
        async *[Symbol.asyncIterator]() { throw makeErr(message) },
      }
    },
    async deleteObject() { throw makeErr(message) },
  }
}

/**
 * @param {string} message
 */
function makeErr(message) {
  const err = /** @type {Error & { errorKind?: string }} */ (new Error(message))
  err.errorKind = 's3_blob_store_unconfigured'
  return err
}

/**
 * @param {PutObjectInput['body']} body
 * @returns {Promise<Uint8Array>}
 */
async function materializeBody(body) {
  if (body instanceof Uint8Array) return body
  if (body && typeof (/** @type {any} */ (body)).pipe === 'function') {
    /** @type {Uint8Array[]} */
    const chunks = []
    for await (const chunk of /** @type {NodeJS.ReadableStream} */ (body)) {
      if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
      else if (chunk instanceof Uint8Array) chunks.push(chunk)
      else chunks.push(Buffer.from(chunk))
    }
    if (chunks.length === 0) return new Uint8Array(0)
    if (chunks.length === 1) return chunks[0]
    return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
  }
  throw new Error('s3 blob-store: body must be Uint8Array or Readable stream')
}

/**
 * Present a response body as a Node readable, or refuse it.
 *
 * A WHATWG `ReadableStream` is outside the union `S3CommandsHandle`
 * declares, but the handle is an injectable public seam and
 * `@aws-sdk/client-s3` carries a fetch-based request handler whose Body is
 * one, so it is adapted rather than refused: `Readable.fromWeb` is core,
 * adds no dependency, and streams instead of buffering.
 *
 * A `string` is refused rather than decoded, and is the one shape
 * withdrawn from the union. Reading it means guessing an encoding the
 * handle has no field to state, and both guesses corrupt a real payload
 * without raising: UTF-8 re-encodes every byte above 0x7F, latin1
 * truncates every code point above U+00FF. A handle holding a string knows
 * the encoding this code cannot, so it decodes and hands over a
 * `Uint8Array`.
 *
 * Anything else throws too. An empty stream is the worst available reading
 * of "this shape is unknown", because it is byte-for-byte what a genuinely
 * empty object looks like: a caller reading a Parquet footer cannot tell a
 * body that never arrived from one that is not there, and the symptom is a
 * wrong query answer with no exception to trace it to.
 *
 * @param {NodeJS.ReadableStream | ReadableStream | Uint8Array} body
 * @param {string} key
 * @returns {NodeJS.ReadableStream}
 */
function toReadable(body, key) {
  if (body && typeof (/** @type {any} */ (body)).pipe === 'function') {
    return /** @type {NodeJS.ReadableStream} */ (body)
  }
  if (body instanceof Uint8Array) return Readable.from([body])
  /** @type {unknown} */
  let refusal
  if (body && typeof (/** @type {any} */ (body)).getReader === 'function') {
    try {
      return Readable.fromWeb(/** @type {any} */ (body))
    } catch (err) {
      // A callable `getReader` that is not a real `ReadableStream`, or one
      // already locked: fall through to the refusal below, so the caller gets
      // the same typed error as any other unusable shape rather than an
      // untagged TypeError. `releaseBody` runs and closes the first case. It
      // cannot close a locked stream: `cancel()` rejects on one, and only
      // whoever holds the reader can release it, so that body stays open
      // until the handle drops it. Which of the two happened is knowable
      // only from the adapter's own error, and a refusal reporting shape
      // `ReadableStream` otherwise reads as a bug here, that shape being the
      // one the union says is adapted. So the reason is carried into both
      // the cause and the message: the cause for a debugger, the message
      // because that is all a consumer forwards (format-iceberg's
      // `describeError` returns `err.message` and nothing else).
      refusal = err
    }
  }
  releaseBody(body)
  const shape = typeof body === 'object'
    ? (/** @type {any} */ (body).constructor?.name || 'object')
    : typeof body
  const why = refusal instanceof Error ? `: ${refusal.message}` : ''
  throw tagS3Error(refusal, 'blob_body_unusable',
    `s3 blob-store: getObject for '${key}' returned a body of an unusable shape (${shape})${why}`,
    key)
}

/**
 * Release a body this code will not read, so the connection behind it is not
 * held open. A Node stream releases through `destroy()`; a WHATWG
 * `ReadableStream` has no `destroy` and releases through `cancel()`, so a
 * destroy-only release quietly left one of those open. The caller is on its
 * way to throwing the error that matters, so the `cancel()` promise is
 * neither awaited nor allowed to surface, and nothing here throws.
 *
 * @param {unknown} body
 */
function releaseBody(body) {
  if (!body || typeof body !== 'object') return
  const handle = /** @type {{ destroy?: () => void, cancel?: () => unknown }} */ (body)
  try {
    if (typeof handle.destroy === 'function') handle.destroy()
    else if (typeof handle.cancel === 'function') Promise.resolve(handle.cancel()).catch(() => {})
  } catch {
    // A body that will not release is not worth losing the original error over.
  }
}

/**
 * @param {unknown} err
 */
function isPreconditionFailed(err) {
  if (!err || typeof err !== 'object') return false
  const obj = /** @type {{ name?: unknown, Code?: unknown, $metadata?: { httpStatusCode?: number } }} */ (err)
  if (obj.name === 'PreconditionFailed' || obj.Code === 'PreconditionFailed') return true
  if (obj.$metadata && obj.$metadata.httpStatusCode === 412) return true
  return false
}

/**
 * @param {unknown} err
 */
function isNotFound(err) {
  if (!err || typeof err !== 'object') return false
  const obj = /** @type {{ name?: unknown, Code?: unknown, $metadata?: { httpStatusCode?: number } }} */ (err)
  if (obj.name === 'NoSuchKey' || obj.Code === 'NoSuchKey') return true
  if (obj.name === 'NotFound' || obj.Code === 'NotFound') return true
  if (obj.$metadata && obj.$metadata.httpStatusCode === 404) return true
  return false
}
