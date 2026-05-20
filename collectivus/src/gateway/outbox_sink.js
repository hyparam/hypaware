import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_PERSISTED_PATH } from './identity.js'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROWS,
  DEFAULT_MAX_SECONDS,
} from './shipping_sink.js'

/**
 * @import { Sink } from '../types.js'
 * @import { IngestSignal } from '../server/types.d.ts'
 * @import { OutboxSinkOptions } from './types.d.ts'
 */

const SIGNALS = new Set(['logs', 'traces', 'metrics', 'proxy'])
const MAX_RETRY_SECONDS = 300
const DEFAULT_INITIAL_RETRY_SECONDS = 1

/**
 * Derive the gateway outbox directory from `central_server.identity` when
 * `central_server.outbox_dir` is omitted. The default intentionally follows
 * the persisted JWT so operators can relocate all gateway-local credentials
 * and delivery spool state together.
 *
 * @param {{ url?: string, outbox_dir?: string, identity: { persisted_path?: string } }} config
 * @returns {string}
 */
export function defaultOutboxDir(config) {
  if (typeof config.outbox_dir === 'string' && config.outbox_dir.length > 0) {
    return config.outbox_dir
  }
  const persistedPath = config.identity.persisted_path ?? DEFAULT_PERSISTED_PATH
  return path.join(path.dirname(persistedPath), 'outbox')
}

/**
 * Durable gateway-side sink. `writeRow()` fsyncs each row into a local
 * per-signal outbox before returning; a background loop rotates completed
 * NDJSON batches through `.sending` and posts them to Central server ingest.
 *
 * @implements {Sink}
 */
export class OutboxSink {
  /**
   * @param {OutboxSinkOptions & {
   *   fetchFn?: typeof fetch,
   *   setTimeoutFn?: (handler: () => void, ms: number) => unknown,
   *   clearTimeoutFn?: (handle: unknown) => void,
   *   now?: () => number,
   *   stderr?: { write: (s: string) => void },
   * }} opts
   */
  constructor(opts) {
    if (!opts || typeof opts.outboxDir !== 'string' || opts.outboxDir.length === 0) {
      throw new Error('OutboxSink: outboxDir is required')
    }
    if (typeof opts.centralUrl !== 'string' || opts.centralUrl.length === 0) {
      throw new Error('OutboxSink: centralUrl is required')
    }
    if (!opts.identityClient) {
      throw new Error('OutboxSink: identityClient is required')
    }
    if (!SIGNALS.has(opts.signal)) {
      throw new Error(`OutboxSink: unsupported signal ${JSON.stringify(opts.signal)}`)
    }

    /** @type {string} */
    this.outboxDir = opts.outboxDir
    /** @type {string} */
    this.centralUrl = opts.centralUrl
    /** @type {{ getCurrentJwt(): Promise<string>, refresh(): Promise<void> }} */
    this.identityClient = opts.identityClient
    /** @type {IngestSignal} */
    this.signal = opts.signal
    const batch = opts.batch ?? {}
    /** @type {number} */
    this.maxRows = batch.maxRows ?? DEFAULT_MAX_ROWS
    /** @type {number} */
    this.maxBytes = batch.maxBytes ?? DEFAULT_MAX_BYTES
    /** @type {number} */
    this.maxSeconds = batch.maxSeconds ?? DEFAULT_MAX_SECONDS
    /** @type {typeof fetch} */
    this.fetchFn = opts.fetchFn ?? fetch
    /** @type {(handler: () => void, ms: number) => unknown} */
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout
    /** @type {(handle: unknown) => void} */
    // eslint-disable-next-line no-extra-parens -- JSDoc cast widens Node's timer handle union for test fakes.
    const defaultClearTimeout = /** @type {(handle: unknown) => void} */ (clearTimeout)
    this.clearTimeoutFn = opts.clearTimeoutFn ?? defaultClearTimeout
    /** @type {() => number} */
    this.now = opts.now ?? Date.now
    /** @type {{ write: (s: string) => void }} */
    this.stderr = opts.stderr ?? process.stderr

    /** @type {string} */
    this.signalDir = path.join(this.outboxDir, this.signal)
    /** @type {import('node:fs/promises').FileHandle | undefined} */
    this.openHandle = undefined
    /** @type {string | undefined} */
    this.openPath = undefined
    /** @type {number} */
    this.openRows = 0
    /** @type {number} */
    this.openBytes = 0
    /** @type {unknown} */
    this.rotateTimer = undefined
    /** @type {number} */
    this.sequence = 0
    /** @type {Promise<void>} */
    this.queue = Promise.resolve()
    /** @type {Promise<void> | undefined} */
    this.sender = undefined
    /** @type {boolean} */
    this.closed = false
    /** @type {Promise<void>} */
    this.ready = this.recover()

    this.ready.then(() => {
      this.startSender()
    }).catch((err) => {
      this.log(`recovery failed: ${formatError(err)}`)
    })
  }

  /**
   * Append one row to the local outbox and fsync it before resolving.
   *
   * @param {unknown} obj
   * @returns {Promise<void>}
   */
  async writeRow(obj) {
    if (this.closed) throw new Error('OutboxSink: writeRow after close')
    const json = JSON.stringify(obj)
    if (typeof json !== 'string') {
      throw new Error('OutboxSink: writeRow value is not JSON-serializable')
    }
    const line = Buffer.from(json + '\n', 'utf8')
    await this.ready
    if (this.closed) throw new Error('OutboxSink: writeRow after close')

    const result = this.queue.then(
      () => this.appendLine(line),
      () => this.appendLine(line)
    )
    this.queue = result.catch(() => {})
    return result
  }

  /**
   * Recover incomplete files left by a prior process. `.open` and `.sending`
   * files are moved back to `.ndjson` so the sender can retry them.
   *
   * @returns {Promise<void>}
   */
  async recover() {
    await fs.mkdir(this.signalDir, { recursive: true, mode: 0o700 })
    const entries = await fs.readdir(this.signalDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.open') && !entry.name.endsWith('.sending')) continue
      const from = path.join(this.signalDir, entry.name)
      const targetName = entry.name.replace(/\.(open|sending)$/, '.ndjson')
      const to = await uniquePath(path.join(this.signalDir, targetName))
      await fs.rename(from, to)
    }
  }

  /**
   * Flush the active `.open` file into the send queue and release the file
   * handle. Does not wait for Central server delivery; unsent `.ndjson` or
   * `.sending` files are recovered on the next process start.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.closed) return
    this.closed = true
    await this.ready.catch(() => {})
    await this.queue.catch(() => {})
    await this.rotateOpen()
  }

  /**
   * Test/helper hook: wait until queued local writes and the current send loop
   * have drained. Do not use this during a long Central outage because the
   * sender intentionally retries forever.
   *
   * @returns {Promise<void>}
   */
  async whenIdle() {
    await this.ready
    await this.queue
    while (this.sender) {
      const current = this.sender
      await current
      if (this.sender === current) break
    }
  }

  /**
   * @param {Buffer} line
   * @returns {Promise<void>}
   */
  async appendLine(line) {
    if (this.closed) throw new Error('OutboxSink: writeRow after close')
    await this.ensureOpen()
    if (!this.openHandle) throw new Error('OutboxSink: active file did not open')
    await this.openHandle.write(line)
    await this.openHandle.sync()
    this.openRows += 1
    this.openBytes += line.length
    if (this.openRows === 1) this.scheduleRotateTimer()
    if (this.openRows >= this.maxRows || this.openBytes >= this.maxBytes) {
      await this.rotateOpen()
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async ensureOpen() {
    if (this.openHandle) return
    await fs.mkdir(this.signalDir, { recursive: true, mode: 0o700 })
    const base = this.nextBatchBase()
    this.openPath = path.join(this.signalDir, `${base}.open`)
    this.openRows = 0
    this.openBytes = 0
    this.openHandle = await fs.open(this.openPath, 'a', 0o600)
  }

  /**
   * @returns {void}
   */
  scheduleRotateTimer() {
    if (this.rotateTimer !== undefined) return
    const handle = this.setTimeoutFn(() => {
      this.rotateTimer = undefined
      const rotation = this.queue.then(
        () => this.rotateOpen(),
        () => this.rotateOpen()
      )
      this.queue = rotation.catch(() => {})
      rotation.then(() => {
        this.startSender()
      }).catch((err) => {
        this.log(`rotate failed: ${formatError(err)}`)
      })
    }, this.maxSeconds * 1000)
    if (handle && typeof handle === 'object' && 'unref' in handle && typeof handle.unref === 'function') {
      handle.unref()
    }
    this.rotateTimer = handle
  }

  /**
   * @returns {Promise<void>}
   */
  async rotateOpen() {
    if (this.rotateTimer !== undefined) {
      this.clearTimeoutFn(this.rotateTimer)
      this.rotateTimer = undefined
    }
    const handle = this.openHandle
    const { openPath } = this
    const rows = this.openRows
    if (!handle || !openPath) return

    this.openHandle = undefined
    this.openPath = undefined
    this.openRows = 0
    this.openBytes = 0

    try {
      await handle.sync()
    } finally {
      await handle.close()
    }

    if (rows === 0) {
      await unlinkIfExists(openPath)
      return
    }

    const readyPath = await uniquePath(openPath.replace(/\.open$/, '.ndjson'))
    await fs.rename(openPath, readyPath)
    this.startSender()
  }

  /**
   * @returns {void}
   */
  startSender() {
    if (this.closed || this.sender) return
    this.sender = this.runSender().catch((err) => {
      this.log(`sender failed: ${formatError(err)}`)
    }).finally(() => {
      this.sender = undefined
    })
  }

  /**
   * @returns {Promise<void>}
   */
  async runSender() {
    await this.ready
    while (!this.closed) {
      const sendingPath = await this.claimNextReadyFile()
      if (!sendingPath) return
      await this.sendClaimedFile(sendingPath)
    }
  }

  /**
   * @returns {Promise<string | undefined>}
   */
  async claimNextReadyFile() {
    while (!this.closed) {
      const entries = await fs.readdir(this.signalDir, { withFileTypes: true })
      const names = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ndjson'))
        .map((entry) => entry.name)
        .sort()
      if (names.length === 0) return undefined

      const readyPath = path.join(this.signalDir, names[0])
      const sendingPath = readyPath.replace(/\.ndjson$/, '.sending')
      try {
        await fs.rename(readyPath, sendingPath)
      } catch (err) {
        if (isErrno(err, 'ENOENT')) continue
        if (isErrno(err, 'EEXIST')) {
          const alt = await uniquePath(sendingPath)
          await fs.rename(readyPath, alt)
          return alt
        }
        throw err
      }
      return sendingPath
    }
    return undefined
  }

  /**
   * @param {string} sendingPath
   * @returns {Promise<void>}
   */
  async sendClaimedFile(sendingPath) {
    const body = await fs.readFile(sendingPath, 'utf8')
    if (body.length === 0) {
      await unlinkIfExists(sendingPath)
      return
    }

    let retrySeconds = DEFAULT_INITIAL_RETRY_SECONDS
    while (!this.closed) {
      const result = await this.postBody(body)
      if (result.kind === 'accepted') {
        await unlinkIfExists(sendingPath)
        return
      }
      if (result.kind === 'failed') {
        await this.moveToFailed(sendingPath)
        this.log(`moved poison batch to failed: status=${result.status} detail=${result.detail}`)
        return
      }

      const delaySeconds = result.retryAfterSeconds ?? retrySeconds
      if (result.retryAfterSeconds === undefined) {
        retrySeconds = Math.min(retrySeconds * 2, MAX_RETRY_SECONDS)
      }
      await this.sleep(delaySeconds)
    }
  }

  /**
   * @param {string} body
   * @returns {Promise<
   *   | { kind: 'accepted' }
   *   | { kind: 'failed', status: number, detail: string }
   *   | { kind: 'retry', retryAfterSeconds?: number }
   * >}
   */
  async postBody(body) {
    const url = joinUrl(this.centralUrl, `/v1/ingest/${this.signal}`)
    let jwt = await this.identityClient.getCurrentJwt()
    let response
    try {
      response = await this.postBatch(url, jwt, body)
    } catch (err) {
      this.log(`post failed; retrying: ${formatError(err)}`)
      return { kind: 'retry' }
    }

    if (response.status === 401) {
      try {
        await this.identityClient.refresh()
        jwt = await this.identityClient.getCurrentJwt()
        response = await this.postBatch(url, jwt, body)
      } catch (err) {
        this.log(`jwt refresh failed; retrying: ${formatError(err)}`)
        return { kind: 'retry' }
      }
    }

    if (response.status === 202 || response.ok) {
      return { kind: 'accepted' }
    }
    if (response.status === 429 || response.status === 503) {
      return { kind: 'retry', retryAfterSeconds: retryAfterSeconds(response) }
    }
    if (response.status >= 500) {
      return { kind: 'retry' }
    }
    if (response.status >= 400) {
      return {
        kind: 'failed',
        status: response.status,
        detail: await readErrorDetail(response),
      }
    }
    return { kind: 'retry' }
  }

  /**
   * @param {string} url
   * @param {string} jwt
   * @param {string} body
   * @returns {Promise<Response>}
   */
  postBatch(url, jwt, body) {
    return this.fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/x-ndjson',
      },
      body,
    })
  }

  /**
   * @param {string} sendingPath
   * @returns {Promise<void>}
   */
  async moveToFailed(sendingPath) {
    const failedDir = path.join(this.signalDir, 'failed')
    await fs.mkdir(failedDir, { recursive: true, mode: 0o700 })
    const targetName = path.basename(sendingPath).replace(/\.sending$/, '.ndjson')
    const target = await uniquePath(path.join(failedDir, targetName))
    await fs.rename(sendingPath, target)
  }

  /**
   * @param {number} seconds
   * @returns {Promise<void>}
   */
  sleep(seconds) {
    if (this.closed || seconds <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const handle = this.setTimeoutFn(resolve, seconds * 1000)
      if (handle && typeof handle === 'object' && 'unref' in handle && typeof handle.unref === 'function') {
        handle.unref()
      }
    })
  }

  /**
   * @returns {string}
   */
  nextBatchBase() {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
    const seq = this.sequence++
    return `${stamp}-${process.pid}-${seq}`
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  log(message) {
    try {
      this.stderr.write(`[outbox] signal=${this.signal} ${message}\n`)
    } catch {
      // Logging must never break recording.
    }
  }
}

/**
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
function joinUrl(base, suffix) {
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}

/**
 * @param {Response} response
 * @returns {number}
 */
function retryAfterSeconds(response) {
  const value = response.headers.get('retry-after')
  if (!value) return DEFAULT_INITIAL_RETRY_SECONDS
  const seconds = Number.parseInt(value, 10)
  if (Number.isFinite(seconds) && seconds >= 0 && String(seconds) === value.trim()) {
    return seconds
  }
  const dateMs = Date.parse(value)
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000))
  }
  return DEFAULT_INITIAL_RETRY_SECONDS
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readErrorDetail(response) {
  let body
  try {
    body = await response.text()
  } catch {
    body = ''
  }
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const error = typeof parsed.error === 'string' ? parsed.error : undefined
        if (error) return `${response.status} ${error}`
      }
    } catch {
      // Plain-text or non-JSON body; fall through.
    }
    return `${response.status} ${body.trim().slice(0, 200)}`
  }
  return `${response.status} ${response.statusText || ''}`.trim()
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function uniquePath(filePath) {
  let candidate = filePath
  for (let i = 1; ; i++) {
    try {
      await fs.access(candidate)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return candidate
      throw err
    }
    const ext = path.extname(filePath)
    const stem = filePath.slice(0, -ext.length)
    candidate = `${stem}.${i}${ext}`
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function unlinkIfExists(filePath) {
  try {
    await fs.unlink(filePath)
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err
  }
}

/**
 * @param {unknown} err
 * @param {string} code
 * @returns {boolean}
 */
function isErrno(err, code) {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === code)
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
