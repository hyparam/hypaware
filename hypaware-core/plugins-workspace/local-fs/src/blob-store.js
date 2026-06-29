// @ts-check

import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

/**
 * @import { BlobStore, DeleteObjectInput, GetObjectInput, GetObjectResult, ListObjectResult, ListObjectsInput, PutObjectInput, PutObjectResult } from '../../../../collectivus-plugin-kernel-types.js'
 */

export const BLOB_STORE_KIND = 'local-fs'

/**
 * Resolve the BlobStore base directory at activation time.
 *
 * Precedence:
 *  1. `pluginConfig.exports_dir` (when the user pins it under the
 *     `@hypaware/local-fs` plugin section).
 *  2. `<env.HYP_HOME>/exports`.
 *  3. `<os.homedir()>/.hyp/exports`.
 *
 * The BlobStore's base is intentionally independent of any sink
 * instance's `dir` setting; sink instances configure their own
 * encode-and-write target directly through the sink contribution.
 *
 * @param {{ pluginConfig?: { exports_dir?: unknown }, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string}
 */
export function resolveExportsBaseDir(opts = {}) {
  const explicit = opts.pluginConfig?.exports_dir
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const env = opts.env ?? process.env
  const home = typeof env.HYP_HOME === 'string' && env.HYP_HOME.length > 0
    ? env.HYP_HOME
    : path.join(os.homedir(), '.hyp')
  return path.join(home, 'exports')
}

/**
 * Construct a local-filesystem `BlobStore` rooted at `baseDir`. Keys
 * map to relative paths under `baseDir`; the store rejects keys that
 * escape the root via `..` segments, leading slashes, or platform
 * path separators on Windows.
 *
 * @param {{ baseDir: string }} args
 * @returns {BlobStore}
 */
export function createLocalFsBlobStore({ baseDir }) {
  if (typeof baseDir !== 'string' || baseDir.length === 0) {
    throw new Error('createLocalFsBlobStore: baseDir is required')
  }
  const root = path.resolve(baseDir)

  /**
   * @param {string} key
   */
  function resolveSafePath(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('local-fs blob-store: key must be a non-empty string')
    }
    // Reject backslashes outright so a Windows-style key cannot land on
    // a POSIX host with an unexpected segmentation interpretation.
    if (key.includes('\\')) {
      throw new Error(`local-fs blob-store: key '${key}' contains a backslash`)
    }
    const normalized = path.posix.normalize(key)
    if (normalized.startsWith('..') || normalized === '..' || normalized.startsWith('/')) {
      throw new Error(`local-fs blob-store: key '${key}' escapes the blob-store root`)
    }
    const resolved = path.resolve(root, normalized)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`local-fs blob-store: key '${key}' escapes the blob-store root`)
    }
    return resolved
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
    throw new Error('local-fs blob-store: body must be Uint8Array or Readable stream')
  }

  return {
    kind: BLOB_STORE_KIND,

    /**
     * @param {PutObjectInput} input
     * @returns {Promise<PutObjectResult>}
     */
    async putObject(input) {
      const dest = resolveSafePath(input.key)
      const dir = path.dirname(dest)
      await fs.mkdir(dir, { recursive: true })
      const bytes = await materializeBody(input.body)
      if (input.ifNoneMatch === '*') {
        // Conditional create: use O_EXCL so a concurrent writer cannot
        // race past us. node:fs/promises maps O_EXCL via `flag: 'wx'`.
        try {
          const handle = await fs.open(dest, 'wx')
          try {
            await handle.writeFile(bytes)
          } finally {
            await handle.close()
          }
        } catch (err) {
          if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') {
            const wrapped = /** @type {Error & { errorKind?: string, key?: string }} */ (
              new Error(`local-fs blob-store: precondition failed (object already exists at '${input.key}')`)
            )
            wrapped.errorKind = 'blob_precondition_failed'
            wrapped.key = input.key
            throw wrapped
          }
          throw err
        }
      } else {
        await fs.writeFile(dest, bytes)
      }
      return { key: input.key }
    },

    /**
     * @param {GetObjectInput} input
     * @returns {Promise<GetObjectResult | null>}
     */
    async getObject(input) {
      const src = resolveSafePath(input.key)
      let handle
      try {
        handle = await fs.open(src, 'r')
      } catch (err) {
        if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
        throw err
      }
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) {
          await handle.close()
          return null
        }
        // Stream off the held FileHandle so the read uses an already-open
        // fd. The lazy `createReadStream(src)` form races a concurrent
        // unlink: the stream's async open can fire after the file is
        // gone, raising an unhandled ENOENT on consumers that discard the
        // body. With a handle the open is settled at await time and the
        // unlink-after-open is benign on POSIX.
        const stream = handle.createReadStream({ autoClose: true })
        return {
          body: stream,
          contentLength: stat.size,
        }
      } catch (err) {
        await handle.close().catch(() => {})
        throw err
      }
    },

    /**
     * Walk `baseDir/prefix` and yield every regular file. Listings are
     * not paginated; `continuationToken` is accepted to satisfy the
     * BlobStore signature but is otherwise ignored. Listings are
     * stable-sorted by key so consumers get deterministic order.
     *
     * @param {ListObjectsInput} input
     * @returns {AsyncIterable<ListObjectResult>}
     */
    listObjects(input) {
      const prefix = typeof input.prefix === 'string' ? input.prefix : ''
      // Listing starts at the directory the prefix points into. For an
      // empty prefix we walk the entire root; otherwise we normalize
      // through the same safety check that put/get/delete use.
      const start = prefix.length === 0 ? root : resolveSafePath(prefix)
      return {
        async *[Symbol.asyncIterator]() {
          /** @type {Array<ListObjectResult>} */
          const results = []
          await walk(start)
          results.sort((a, b) => a.key.localeCompare(b.key))
          for (const r of results) yield r

          /**
           * @param {string} dir
           */
          async function walk(dir) {
            let entries
            try {
              entries = await fs.readdir(dir, { withFileTypes: true })
            } catch (err) {
              if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
              throw err
            }
            for (const entry of entries) {
              const full = path.join(dir, entry.name)
              if (entry.isDirectory()) {
                await walk(full)
                continue
              }
              if (!entry.isFile()) continue
              const stat = await fs.stat(full)
              const rel = path.relative(root, full).split(path.sep).join('/')
              if (prefix.length > 0 && !rel.startsWith(stripTrailingSlash(prefix))) continue
              results.push({
                key: rel,
                size: stat.size,
                lastModified: stat.mtime,
              })
            }
          }
        },
      }
    },

    /**
     * @param {DeleteObjectInput} input
     * @returns {Promise<void>}
     */
    async deleteObject(input) {
      const target = resolveSafePath(input.key)
      try {
        await fs.unlink(target)
      } catch (err) {
        if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
        throw err
      }
    },
  }
}

/**
 * Drain a `GetObjectResult.body` into a single `Uint8Array`. Tests and
 * smokes use this to assert byte-identity without re-implementing the
 * stream-collect dance.
 *
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<Uint8Array>}
 */
export async function collectStream(stream) {
  /** @type {Uint8Array[]} */
  const chunks = []
  const readable = stream instanceof Readable ? stream : Readable.from(stream)
  for await (const chunk of readable) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    else if (chunk instanceof Uint8Array) chunks.push(chunk)
    else chunks.push(Buffer.from(chunk))
  }
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0]
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
}

/**
 * @param {string} prefix
 */
function stripTrailingSlash(prefix) {
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
}
