import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * @import { AsyncBuffer } from 'hyparquet'
 * @import { Writer } from 'hyparquet-writer/src/types.js'
 * @import { Lister, Resolver, WriterOptions } from 'icebird/src/types.js'
 */

/**
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
        return fs.readdirSync(dir, { withFileTypes: true })
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
 * @param {string} dir
 * @returns {string}
 */
export function tableUrlForDir(dir) {
  return pathToFileURL(dir).href.replace(/\/$/, '')
}

/**
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
 * @param {new (initialSize?: number) => Writer} ByteWriter
 * @param {string} filePath
 * @param {WriterOptions | undefined} options
 * @returns {Writer}
 */
function localWriter(ByteWriter, filePath, options) {
  /** @type {Writer} */
  const writer = new ByteWriter()
  writer.finish = async function() {
    if (options?.ifNoneMatch === '*' && fs.existsSync(filePath)) {
      const err = /** @type {Error & { status?: number, statusCode?: number }} */ (
        new Error(`local iceberg write collision: ${filePath}`)
      )
      err.status = 412
      err.statusCode = 412
      throw err
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, writer.getBytes().slice())
    if (options?.ifNoneMatch === '*' && fs.existsSync(filePath)) {
      fs.rmSync(tmp, { force: true })
      const err = /** @type {Error & { status?: number, statusCode?: number }} */ (
        new Error(`local iceberg write collision: ${filePath}`)
      )
      err.status = 412
      err.statusCode = 412
      throw err
    }
    fs.renameSync(tmp, filePath)
  }
  return writer
}
