// @ts-check

import { Buffer } from 'node:buffer'

/**
 * @import { BlobStore } from '../../../../collectivus-plugin-kernel-types'
 * @import { BlobIOWriteEvent, BlobIOWriteObserver } from './types.d.ts'
 */

const TABLE_URL_SCHEME = 'blob://'

/**
 * Stable error kinds the iceberg adapter treats as "the destination
 * itself is unusable" rather than a transient data-write failure. These
 * come from the s3 BlobStore's `classifyAwsError` taxonomy plus the
 * sentinel s3_blob_store_unconfigured kind. Mapped to
 * `iceberg_blob_store_missing` so the sink driver does not retry a
 * permission/addressing problem partition-by-partition.
 */
const BLOB_STORE_FATAL_KINDS = new Set([
  's3_access_denied',
  's3_bucket_missing',
  's3_credentials_missing',
  's3_region_mismatch',
  's3_config_invalid',
  's3_blob_store_unconfigured',
])

/**
 * Construct the table URL the table-format sink hands to `icebird` for
 * a given dataset prefix. The URL embeds the BlobStore key prefix so
 * `pathToKey` can split it back out without keeping a separate table.
 *
 * Example: `tableUrlForBlobPrefix('iceberg/datasets/foo')` →
 *   `blob://iceberg/datasets/foo`
 *
 * @param {string} blobPrefix
 * @returns {string}
 */
export function tableUrlForBlobPrefix(blobPrefix) {
  const normalized = stripLeadingAndTrailingSlash(blobPrefix)
  return `${TABLE_URL_SCHEME}${normalized}`
}

/**
 * Inverse of `tableUrlForBlobPrefix`: take whatever absolute path
 * `icebird` synthesized (table URL + suffix) and project it onto a
 * BlobStore key. Accepts both the full `blob://...` URL form and bare
 * relative paths (the latter never appears in practice but keeps the
 * adapter defensive).
 *
 * @param {string} url
 * @returns {string}
 */
export function pathToKey(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw newError(
      'iceberg_blob_io_invalid_url',
      `iceberg-format: blob path must be a non-empty string (got ${typeof url})`
    )
  }
  let raw = url
  if (raw.startsWith(TABLE_URL_SCHEME)) {
    raw = raw.slice(TABLE_URL_SCHEME.length)
  }
  raw = stripLeadingAndTrailingSlash(raw)
  if (raw.length === 0) {
    throw newError(
      'iceberg_blob_io_invalid_url',
      `iceberg-format: empty blob key from url '${url}'`
    )
  }
  return raw
}

/**
 * Adapt a `BlobStore` into the `Resolver` / `Lister` pair `icebird`
 * speaks. The adapter lets the table-format sink write metadata + data
 * files through any blob destination (local-fs in V1, S3 next) without
 * forking icebird IO per backend.
 *
 * Behavior:
 * - `reader(url)` issues `getObject`, materializes the body, and returns
 *   an `AsyncBuffer` over the bytes. Missing objects throw with
 *   `iceberg_metadata_read_failed` and `code='ENOENT'` so icebird's
 *   metadata-discovery probes can fall through.
 * - `writer(url, options)` collects bytes into a fresh `ByteWriter`
 *   (the same in-memory writer the local-fs resolver uses) and flushes
 *   via `putObject` on `finish()`. When `options.ifNoneMatch === '*'`
 *   the writer surfaces a 412 on collision so icebird's
 *   `fileCatalogCommit` retry path triggers.
 * - `deleter(url)` issues `deleteObject` and tolerates ENOENT-style
 *   misses silently.
 * - `lister(url)` walks `listObjects` for the directory prefix and
 *   returns the *basenames* (icebird wants bare filenames, not paths).
 *
 * The optional `onWrite` observer is invoked after every successful
 * metadata/data write. The caller uses it to stash S3-specific telemetry
 * (e.g. the ETag of the most recent metadata commit) without coupling
 * the icebird writer surface to the sink's span attributes.
 *
 * @param {BlobStore} blobStore
 * @param {{ onWrite?: BlobIOWriteObserver }} [options]
 * @returns {Promise<{
 *   resolver: import('icebird/src/types.js').Resolver,
 *   lister: import('icebird/src/types.js').Lister
 * }>}
 */
export async function createBlobStoreIO(blobStore, options) {
  if (!blobStore || typeof blobStore.putObject !== 'function') {
    throw newError(
      'iceberg_blob_store_missing',
      'iceberg-format: createBlobStoreIO requires a BlobStore with putObject()'
    )
  }
  const onWrite = options?.onWrite
  // Reuse the same `ByteWriter` the intrinsic local-fs cache uses.
  // Mirroring the implementation here keeps the writer surface
  // (`appendUint8`/`appendVarInt`/etc.) byte-for-byte identical with the
  // intrinsic path and lets icebird's parquet writer stay oblivious to
  // whether bytes will land on disk or in S3.
  const { ByteWriter } = await import('hyparquet-writer')

  /** @type {import('icebird/src/types.js').Resolver} */
  const resolver = {
    async reader(url) {
      const key = pathToKey(url)
      let result
      try {
        result = await blobStore.getObject({ key })
      } catch (err) {
        if (BLOB_STORE_FATAL_KINDS.has(/** @type {string} */ (readErrorKind(err)))) {
          throw newError(
            'iceberg_blob_store_missing',
            `iceberg-format: blob-store read rejected at '${key}' (error_kind=${readErrorKind(err)}): ${describeError(err)}`
          )
        }
        throw newError(
          'iceberg_metadata_read_failed',
          `iceberg-format: blob-store read failed for '${key}': ${describeError(err)}`
        )
      }
      if (!result) {
        const err = newError(
          'iceberg_metadata_read_failed',
          `iceberg-format: blob '${key}' not found`
        )
        // ENOENT-style code so icebird's metadata-version probe treats
        // this as "no successor yet" rather than a real IO failure.
        err.code = 'ENOENT'
        throw err
      }
      const bytes = await collectStream(result.body)
      return {
        byteLength: bytes.byteLength,
        slice(start, end) {
          const sliced = bytes.subarray(start, end)
          const out = new ArrayBuffer(sliced.byteLength)
          new Uint8Array(out).set(sliced)
          return out
        },
      }
    },
    writer(url, options) {
      const key = pathToKey(url)
      /** @type {import('hyparquet-writer/src/types.js').Writer} */
      const writer = new ByteWriter()
      writer.finish = async function () {
        const bytes = writer.getBytes().slice()
        /** @type {{ key: string, body: Uint8Array, ifNoneMatch?: string }} */
        const put = { key, body: bytes }
        if (options?.ifNoneMatch === '*') put.ifNoneMatch = '*'
        try {
          const result = await blobStore.putObject(put)
          if (typeof onWrite === 'function') {
            try { onWrite({ key, etag: result?.etag, ifNoneMatch: put.ifNoneMatch }) } catch { /* observer must not break commits */ }
          }
        } catch (err) {
          const inner = readErrorKind(err)
          if (inner === 'blob_precondition_failed') {
            const wrapped = newError(
              'iceberg_commit_conflict',
              `iceberg-format: conditional write collision at '${key}'`
            )
            wrapped.status = 412
            wrapped.statusCode = 412
            throw wrapped
          }
          // Map permission/bucket-shape failures to iceberg_blob_store_missing
          // so callers see "permissions / addressing issue" instead of an
          // iceberg-internal write error_kind. Anything else (transient,
          // throttled, unknown SDK error) surfaces as iceberg_data_write_failed
          // so the sink driver retries the partition.
          if (BLOB_STORE_FATAL_KINDS.has(/** @type {string} */ (inner))) {
            throw newError(
              'iceberg_blob_store_missing',
              `iceberg-format: blob-store write rejected at '${key}' (error_kind=${inner}): ${describeError(err)}`
            )
          }
          throw newError(
            'iceberg_data_write_failed',
            `iceberg-format: blob-store write failed for '${key}': ${describeError(err)}`
          )
        }
      }
      return writer
    },
    async deleter(url) {
      const key = pathToKey(url)
      if (typeof blobStore.deleteObject !== 'function') return
      try {
        await blobStore.deleteObject({ key })
      } catch (err) {
        // ENOENT-equivalents are tolerated; the catalog uses delete to
        // clean up failed commits and a missing object simply means
        // someone else already cleaned it up.
        if (isNotFoundError(err)) return
        throw newError(
          'iceberg_blob_io_delete_failed',
          `iceberg-format: blob-store delete failed for '${key}': ${describeError(err)}`
        )
      }
    },
  }

  /** @type {import('icebird/src/types.js').Lister} */
  async function lister(url) {
    const prefix = ensureTrailingSlash(pathToKey(url))
    /** @type {string[]} */
    const names = []
    try {
      for await (const entry of blobStore.listObjects({ prefix })) {
        const rel = entry.key.startsWith(prefix) ? entry.key.slice(prefix.length) : entry.key
        // Skip nested entries; icebird only asks for the immediate
        // metadata directory.
        if (rel.length === 0 || rel.includes('/')) continue
        names.push(rel)
      }
    } catch (err) {
      if (BLOB_STORE_FATAL_KINDS.has(/** @type {string} */ (readErrorKind(err)))) {
        throw newError(
          'iceberg_blob_store_missing',
          `iceberg-format: blob-store list rejected at '${prefix}' (error_kind=${readErrorKind(err)}): ${describeError(err)}`
        )
      }
      throw newError(
        'iceberg_blob_io_list_failed',
        `iceberg-format: blob-store list failed for '${prefix}': ${describeError(err)}`
      )
    }
    names.sort()
    return names
  }

  return { resolver, lister }
}

/**
 * Drain a `GetObjectResult.body` (Uint8Array or Node stream) into a
 * single contiguous `Uint8Array`. Tolerant of both shapes because the
 * BlobStore contract returns a Node stream from `getObject`, but tests
 * sometimes hand back raw bytes.
 *
 * @param {NodeJS.ReadableStream | Uint8Array | undefined} body
 * @returns {Promise<Uint8Array>}
 */
export async function collectStream(body) {
  if (!body) return new Uint8Array(0)
  if (body instanceof Uint8Array) return body
  /** @type {Uint8Array[]} */
  const chunks = []
  for await (const chunk of /** @type {AsyncIterable<unknown>} */ (body)) {
    if (chunk instanceof Uint8Array) chunks.push(chunk)
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    else chunks.push(Buffer.from(/** @type {ArrayBufferLike} */ (chunk)))
  }
  return concatChunks(chunks)
}

/**
 * @param {Uint8Array[]} chunks
 * @returns {Uint8Array}
 */
function concatChunks(chunks) {
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0]
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * @param {string} prefix
 */
function ensureTrailingSlash(prefix) {
  return prefix.endsWith('/') ? prefix : `${prefix}/`
}

/**
 * @param {string} prefix
 */
function stripLeadingAndTrailingSlash(prefix) {
  let p = prefix
  while (p.startsWith('/')) p = p.slice(1)
  while (p.endsWith('/')) p = p.slice(0, -1)
  return p
}

/**
 * @param {unknown} err
 */
function readErrorKind(err) {
  if (!err || typeof err !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (err)
  if (typeof record.errorKind === 'string') return record.errorKind
  if (typeof record.hypErrorKind === 'string') return record.hypErrorKind
  return undefined
}

/**
 * @param {unknown} err
 */
function isNotFoundError(err) {
  if (!err || typeof err !== 'object') return false
  const record = /** @type {Record<string, unknown>} */ (err)
  if (record.code === 'ENOENT' || record.code === 'NoSuchKey') return true
  if (typeof record.statusCode === 'number' && record.statusCode === 404) return true
  return false
}

/**
 * @param {unknown} err
 */
function describeError(err) {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * @param {string} kind
 * @param {string} message
 * @returns {Error & { hypErrorKind: string, code?: string, status?: number, statusCode?: number }}
 */
function newError(kind, message) {
  const err = /** @type {Error & { hypErrorKind: string, code?: string, status?: number, statusCode?: number }} */ (
    new Error(message)
  )
  err.hypErrorKind = kind
  return err
}
