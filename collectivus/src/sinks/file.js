import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * @import { FileHandle } from 'node:fs/promises'
 */

/**
 * JSONL file sink for the proxy recorder. Writes rows to
 * `<dir>/<gatewayId>/proxy/<UTC-date>.jsonl` so the standalone proxy
 * layout matches the server-mode `proxy` ingest signal exactly:
 * `<sink_dir>/<gateway_id>/<signal>/<YYYY-MM-DD>.jsonl`.
 *
 * The file rotates daily on UTC midnight: a write whose `Date.toISOString()`
 * date prefix differs from the currently-open file's flushes the previous
 * handle and opens a new one. Directories are created lazily on the first
 * write so a sink can be constructed eagerly without side effects.
 *
 * Writes are serialized so rows land in submission order even under
 * concurrent callers.
 */
export class FileSink {
  /**
   * @param {string} dir Sink root from `config.sink.dir`.
   * @param {string} gatewayId First-level partition; standalone uses the
   *   resolved standalone gateway_id, gateway role uses its JWT-issued id.
   */
  constructor(dir, gatewayId) {
    if (typeof gatewayId !== 'string' || gatewayId.length === 0) {
      throw new Error('FileSink: gatewayId is required')
    }
    /** @type {string} */
    this.dir = dir
    /** @type {string} */
    this.gatewayId = gatewayId
    /** @type {string} */
    this.proxyDir = path.join(dir, gatewayId, 'proxy')
    /** @type {boolean} */
    this.dirEnsured = false
    /** @type {FileHandle | undefined} */
    this.fh = undefined
    /** @type {string | undefined} */
    this.openDate = undefined
    /** @type {Promise<void>} */
    this.queue = Promise.resolve()
    /** @type {boolean} */
    this.closed = false
  }

  /**
   * Append one JSONL row. Resolves after the row has been written to the
   * underlying file (kernel-side; not yet fsynced).
   *
   * @param {unknown} obj
   * @returns {Promise<void>}
   */
  writeRow(obj) {
    if (this.closed) return Promise.reject(new Error('FileSink: writeRow after close'))
    const line = JSON.stringify(obj) + '\n'
    const result = this.queue.then(
      () => writeLine(this, line),
      () => writeLine(this, line)
    )
    // Detach the chain head from the caller-visible promise so a failure on
    // one row does not surface as an unhandled rejection on the next.
    this.queue = result.catch(() => {})
    return result
  }

  /**
   * Flush, fsync, and close the underlying file. Idempotent: subsequent
   * calls resolve immediately and additional writes throw.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.closed) return
    this.closed = true
    try {
      await this.queue
    } catch {
      // surfaced to the caller of writeRow already
    }
    if (this.fh !== undefined) {
      const { fh } = this
      this.fh = undefined
      this.openDate = undefined
      try {
        await fh.sync()
      } finally {
        await fh.close()
      }
    }
  }
}

/**
 * @returns {string}
 */
function todayUtc() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * @param {FileSink} sink
 * @param {string} line
 * @returns {Promise<void>}
 */
async function writeLine(sink, line) {
  const date = todayUtc()
  if (sink.fh === undefined || sink.openDate !== date) {
    if (sink.fh !== undefined) {
      const { fh } = sink
      sink.fh = undefined
      try {
        await fh.sync()
      } finally {
        await fh.close()
      }
    }
    if (!sink.dirEnsured) {
      await fs.mkdir(sink.proxyDir, { recursive: true })
      sink.dirEnsured = true
    }
    sink.fh = await fs.open(path.join(sink.proxyDir, `${date}.jsonl`), 'a')
    sink.openDate = date
  }
  await sink.fh.write(line)
}
