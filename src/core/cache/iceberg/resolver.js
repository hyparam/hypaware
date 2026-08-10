// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * @import { AsyncBuffer } from 'hyparquet'
 * @import { Writer } from 'hyparquet-writer/src/types.js'
 * @import { Lister, Resolver, WriterOptions } from 'icebird/src/types.js'
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
 * Build a `hyparquet-writer` Writer that finalizes onto the local
 * filesystem with an atomic rename. `ifNoneMatch === '*'` is honored
 * to surface `412` collisions on concurrent commits, matching the
 * conditional-write semantics `icebird`'s file catalog expects.
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
 * @ref LLP 0206#row-groups [implements]: flush-per-row-group is what keeps
 *   a large output file from becoming a large allocation.
 * @param {new (initialSize?: number) => Writer} ByteWriter
 * @param {string} filePath
 * @param {WriterOptions | undefined} options
 * @returns {Writer}
 */
function localWriter(ByteWriter, filePath, options) {
  /** @type {Writer & { index?: number }} */
  const writer = new ByteWriter()
  /** @type {number | null} */
  let fd = null
  /** @type {string | null} */
  let tmp = null

  const openTmp = () => {
    if (fd !== null) return
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    fd = fs.openSync(tmp, 'w')
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

  writer.flush = function () {
    if (!writer.index) return
    openTmp()
    fs.writeSync(/** @type {number} */ (fd), writer.getBytes())
    writer.index = 0
  }

  writer.finish = async function () {
    if (options?.ifNoneMatch === '*' && fs.existsSync(filePath)) {
      if (fd !== null) {
        fs.closeSync(fd)
        fs.rmSync(/** @type {string} */ (tmp), { force: true })
        fd = null
      }
      throw collision(filePath)
    }
    openTmp()
    if (writer.index) fs.writeSync(/** @type {number} */ (fd), writer.getBytes())
    fs.closeSync(/** @type {number} */ (fd))
    fd = null
    writer.index = 0
    if (options?.ifNoneMatch === '*' && fs.existsSync(filePath)) {
      fs.rmSync(/** @type {string} */ (tmp), { force: true })
      throw collision(filePath)
    }
    fs.renameSync(/** @type {string} */ (tmp), filePath)
  }
  return writer
}
