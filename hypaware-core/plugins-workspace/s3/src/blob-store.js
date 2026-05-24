// @ts-check

import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import { normalizePrefix } from './config.js'
import { classifyAwsError } from './errors.js'

/**
 * @import { BlobStore, DeleteObjectInput, GetObjectInput, GetObjectResult, ListObjectResult, ListObjectsInput, PutObjectInput, PutObjectResult } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { S3BlobStoreClientFactory, S3CommandsHandle } from './types.d.ts'
 * @import { S3ClientConfig } from '@aws-sdk/client-s3'
 */

export const BLOB_STORE_KIND = 's3'

/**
 * Construct an S3-backed `BlobStore`. The factory is injectable so the
 * smoke and unit tests can supply a fake S3 client without spinning up
 * the AWS SDK. Production builds wire `defaultS3BlobStoreClientFactory`.
 *
 * Keys passed to put/get/delete are relative — the BlobStore prepends
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
    // They are advisory — the BlobStore methods do not consult these
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
      try {
        const result = await client.getObject({ Bucket: bucket, Key })
        if (!result || result.Body === null || result.Body === undefined) return null
        return {
          body: toReadable(result.Body),
          contentLength: result.ContentLength,
          etag: result.ETag,
        }
      } catch (err) {
        if (isNotFound(err)) return null
        throw tagS3Error(err, classifyAwsError(err),
          `s3 blob-store: getObject failed for '${input.key}'`, input.key)
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
        Body: /** @type {NodeJS.ReadableStream | Uint8Array | string | null | undefined} */ (
          /** @type {unknown} */ (result.Body)
        ),
        ContentLength: result.ContentLength,
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
 * without a plugin-level bucket — the capability still resolves (so
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
 * @param {NodeJS.ReadableStream | Uint8Array | string} body
 * @returns {NodeJS.ReadableStream}
 */
function toReadable(body) {
  if (body && typeof (/** @type {any} */ (body)).pipe === 'function') {
    return /** @type {NodeJS.ReadableStream} */ (body)
  }
  if (body instanceof Uint8Array) return Readable.from([body])
  if (typeof body === 'string') return Readable.from([Buffer.from(body)])
  return Readable.from([])
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
