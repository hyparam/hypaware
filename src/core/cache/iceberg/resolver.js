// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * @import { AsyncBuffer } from 'hyparquet'
 * @import { Writer } from 'hyparquet-writer/src/types.js'
 * @import { Lister, Resolver, WriterOptions } from 'icebird/src/types.js'
 * @import { AbortableWriter } from '../../../../src/core/cache/types.js'
 */

/**
 * Build a Resolver/Lister pair that drives `icebird` against the local
 * filesystem. The kernel's intrinsic cache lives under
 * `<HYP_HOME>/hypaware/cache`; this is the only IO surface the cache
 * uses to read and write Iceberg tables.
 *
 * @returns {Promise<{ resolver: Resolver, lister: Lister }>}
 */
export async function createLocalIcebergIO() {
  const { ByteWriter } = await import('hyparquet-writer')
  return {
    resolver: {
      reader(url) {
        const bytes = fs.readFileSync(urlToPath(url))
        return asyncBufferFromBytes(bytes)
      },
      writer(url, options) {
        return localWriter(ByteWriter, urlToPath(url), options)
      },
      async deleter(url) {
        fs.rmSync(urlToPath(url), { force: true })
      },
    },
    async lister(url) {
      const dir = urlToPath(url)
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort()
      } catch {
        return []
      }
    },
  }
}

/**
 * Convert a filesystem directory into the `file://` URL that
 * `icebird` uses as a table identifier.
 *
 * @param {string} dir
 * @returns {string}
 */
export function tableUrlForDir(dir) {
  return pathToFileURL(dir).href.replace(/\/$/, '')
}

/**
 * Inverse of `tableUrlForDir` - resolves a `file://` URL or a relative
 * path back into an absolute filesystem path.
 *
 * @param {string} url
 * @returns {string}
 */
export function urlToPath(url) {
  if (url.startsWith('file://')) return fileURLToPath(url)
  return path.resolve(url)
}

/**
 * @param {Uint8Array} bytes
 * @returns {AsyncBuffer}
 */
function asyncBufferFromBytes(bytes) {
  return {
    byteLength: bytes.byteLength,
    slice(start, end) {
      const sliced = bytes.subarray(start, end)
      const out = new ArrayBuffer(sliced.byteLength)
      new Uint8Array(out).set(sliced)
      return out
    },
  }
}

/**
 * Build a `hyparquet-writer` Writer that publishes onto the local
 * filesystem in one syscall. `ifNoneMatch === '*'` is honored to surface
 * `412` collisions on concurrent commits, matching the conditional-write
 * semantics `icebird`'s file catalog expects.
 *
 * The writer implements the optional `flush()` hook, which
 * `hyparquet-writer` calls after every row group: buffered bytes are
 * appended to the temp file and the in-memory buffer index resets to
 * zero. Without it a data file is fully materialized in memory before it
 * lands, which caps how large a file a streaming writer may build. With
 * it, peak buffer is one row group regardless of final file size.
 * `ByteWriter.offset` stays the cumulative byte count, so every parquet
 * offset recorded in the footer remains file-absolute.
 *
 * It also implements `abort()`, which `finish()` is not: a streaming
 * append may hold this writer open across many row groups, and if the
 * append fails part-way there is no `finish()` coming to close the
 * descriptor or unlink the temp file. Without it a repeatedly failing
 * compaction leaks one fd and one `.tmp.*` file per attempt.
 *
 * And it implements `park()`: flush, give the descriptor back, and drop
 * the auto-expanding buffer to nothing, while keeping the temp file and
 * the byte offset so a later write reopens it in append mode. A parked
 * writer costs a directory entry and a few small objects, not a
 * descriptor and not a row group's worth of buffer, which is what lets a
 * streaming append keep one output file per partition tuple open across
 * a whole rewrite without one descriptor per tuple.
 *
 * @ref LLP 0209#row-groups [implements]: flush-per-row-group is what keeps
 *   a large output file from becoming a large allocation.
 * @ref LLP 0209#descriptor-parking [implements]: the descriptor is
 *   reclaimable; the open file is not the thing being capped.
 * @param {new (initialSize?: number) => Writer} ByteWriter
 * @param {string} filePath
 * @param {WriterOptions | undefined} options
 * @returns {AbortableWriter}
 */
function localWriter(ByteWriter, filePath, options) {
  /** @type {AbortableWriter & { index?: number, buffer?: ArrayBuffer, view?: DataView }} */
  const writer = new ByteWriter()
  /** @type {number | null} */
  let fd = null
  /** @type {string | null} */
  let tmp = null

  const openTmp = () => {
    if (fd !== null) return
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    if (tmp === null) {
      tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
      fd = fs.openSync(tmp, 'w')
      return
    }
    // Reopening a parked writer: append, never truncate. Every parquet
    // offset already recorded in the footer is file-absolute, so the
    // bytes have to continue exactly where the park left them.
    fd = fs.openSync(tmp, 'a')
  }

  /** @param {string} label */
  const collision = (label) => {
    const err = /** @type {Error & { status?: number, statusCode?: number }} */ (
      new Error(`local iceberg write collision: ${label}`)
    )
    err.status = 412
    err.statusCode = 412
    return err
  }

  writer.abort = function () {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Already closed; the temp file still needs to go.
      }
      fd = null
    }
    if (tmp !== null) {
      fs.rmSync(tmp, { force: true })
      tmp = null
    }
    writer.index = 0
  }

  writer.flush = function () {
    if (!writer.index) return
    openTmp()
    fs.writeSync(/** @type {number} */ (fd), writer.getBytes())
    writer.index = 0
  }

  writer.park = function () {
    if (fd === null && !writer.index) return
    writer.flush?.()
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Already closed: the temp file and the offset are what matter.
      }
      fd = null
    }
    // `ByteWriter`'s buffer auto-expands to the largest row group it ever
    // held and never shrinks, so a parked writer would otherwise retain
    // that allocation for the rest of the rewrite - once per open file,
    // which is the term that would make holding many files open costly.
    // `index` is zero after the flush, so nothing live is discarded.
    writer.buffer = new ArrayBuffer(1024)
    writer.view = new DataView(writer.buffer)
    writer.index = 0
  }

  writer.finish = async function () {
    openTmp()
    if (writer.index) fs.writeSync(/** @type {number} */ (fd), writer.getBytes())
    fs.closeSync(/** @type {number} */ (fd))
    fd = null
    writer.index = 0
    const staged = /** @type {string} */ (tmp)
    if (options?.ifNoneMatch !== '*') {
      fs.renameSync(staged, filePath)
      tmp = null
      return
    }
    // `ifNoneMatch: '*'` is a create-only precondition, so the publish
    // itself has to be the thing that refuses to overwrite. `rename`
    // cannot be: POSIX rename replaces the destination silently, so an
    // `existsSync` in front of it is check-then-act and two committers
    // racing the same `v(N+1).metadata.json` can both find it absent,
    // both publish, and the loser's snapshot is lost with no error for
    // the retry loop to catch. `link` fails with EEXIST when the
    // destination exists, atomically and with no window, which is
    // exactly the guarantee the precondition promises. The cache has no
    // external catalog to arbitrate for it, so this one call is the whole
    // of its concurrency control.
    try {
      fs.linkSync(staged, filePath)
    } catch (err) {
      fs.rmSync(staged, { force: true })
      tmp = null
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') throw collision(filePath)
      throw err
    }
    fs.rmSync(staged, { force: true })
    tmp = null
  }
  return writer
}
