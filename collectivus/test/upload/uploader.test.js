import { parquetReadObjects } from 'hyparquet'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryConnector } from '../../src/upload/connectors/memory.js'
import { uploadPending } from '../../src/upload/uploader.js'

/**
 * @import { StorageConnector } from '../../src/upload/upload.js'
 */

/** @type {string} */
let outputDir

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-upload-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

/**
 * Write rows under the unified `<outputDir>/<gateway_id>/<signal>/<date>.jsonl`
 * layout that both standalone and server modes drain. The gateway_id arg is
 * called `gatewayId` here but most fixtures pass the legacy service name so
 * existing assertions stay legible without renames.
 *
 * @param {string} gatewayId
 * @param {'logs' | 'traces' | 'metrics'} signal
 * @param {string} date
 * @param {object[]} rows
 * @returns {void}
 */
function writeJsonl(gatewayId, signal, date, rows) {
  const dir = path.join(outputDir, gatewayId, signal)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${date}.jsonl`)
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

/**
 * @param {string} gatewayId
 * @param {string} date
 * @param {Record<string, unknown>[]} rows
 * @returns {void}
 */
function writeProxyJsonl(gatewayId, date, rows) {
  const dir = path.join(outputDir, gatewayId, 'proxy')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${date}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

/**
 * @param {Partial<Record<string, unknown>>} [overrides]
 * @returns {Record<string, unknown>}
 */
function proxyExchange(overrides = {}) {
  return {
    exchange_id: 'ex-proxy-1',
    kind: 'exchange',
    ts_start: `${yesterday}T00:00:00.000Z`,
    ts_end: `${yesterday}T00:00:00.100Z`,
    duration_ms: 100,
    upstream: 'anthropic',
    client: { ip: '127.0.0.1', user_agent: 'claude-cli/2.1.141' },
    cwd: '/repo/app',
    git_branch: 'main',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { user_id: JSON.stringify({ session_id: 'sess-upload', account_uuid: 'acct' }) },
      }),
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'msg-upload',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
      }),
    },
    stream_event_count: 0,
    ...overrides,
  }
}

/**
 * @returns {undefined}
 */
function noClaudeContext() {
  return undefined
}

const yesterday = '2026-05-06'
const today = '2026-05-07'

describe('uploadPending', () => {
  it('uploads one parquet per service-signal-day to the configured prefix', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', timestamp: `${yesterday}T00:00:00Z`, body: 'hi', resource: {}, scope: { attributes: {} }, attributes: {} },
      { serviceName: 'svc-a', timestamp: `${yesterday}T00:00:01Z`, body: 'bye', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    writeJsonl('svc-b', 'metrics', yesterday, [
      { serviceName: 'svc-b', metricType: 'gauge', metricName: 'cpu', value: 0.5, valueType: 'double', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today
    )

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.uploaded)).toBe(true)
    expect([...connector.store.keys()].sort()).toEqual([
      `collectivus/svc-a/logs/date=${yesterday}/data.parquet`,
      `collectivus/svc-b/metrics/date=${yesterday}/data.parquet`,
    ])

    const logsBuf = connector.store.get(`collectivus/svc-a/logs/date=${yesterday}/data.parquet`)
    const ab = new Uint8Array(logsBuf).buffer
    const logsRows = await parquetReadObjects({ file: ab })
    expect(logsRows).toHaveLength(2)
    expect(logsRows[0].serviceName).toBe('svc-a')
  })

  it('skips today and files outside the catch-up window', async () => {
    writeJsonl('svc-a', 'logs', today, [
      { serviceName: 'svc-a', body: 'now', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const oldDate = '2026-04-01'
    writeJsonl('svc-a', 'logs', oldDate, [
      { serviceName: 'svc-a', body: 'old', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today
    )

    expect(results).toEqual([])
    expect(connector.store.size).toBe(0)
  })

  it('respects the signals allowlist', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    writeJsonl('svc-a', 'traces', yesterday, [
      { serviceName: 'svc-a', traceId: 't', spanId: 's', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today
    )

    expect([...connector.store.keys()]).toEqual([
      `collectivus/svc-a/logs/date=${yesterday}/data.parquet`,
    ])
  })

  it('uploads proxy JSONL as proxy_messages parquet with Claude local context', async () => {
    writeProxyJsonl('gw-proxy', yesterday, [proxyExchange()])

    const connector = memoryConnector()
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['proxy'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today,
      /** @type {any} */ ({ claudeContextLookup: noClaudeContext })
    )

    expect(results).toHaveLength(1)
    expect(results[0].uploaded).toBe(true)
    const key = `collectivus/gw-proxy/proxy_messages/date=${yesterday}/data.parquet`
    expect([...connector.store.keys()]).toEqual([key])

    const buf = connector.store.get(key)
    expect(buf).toBeDefined()
    const view = /** @type {Uint8Array} */ (buf)
    const file = /** @type {ArrayBuffer} */ (view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
    const rows = await parquetReadObjects({ file })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      gateway_id: 'gw-proxy',
      cwd: '/repo/app',
      git_branch: 'main',
      attributes: { client: { claude_version: '2.1.141' } },
    })
  })

  it('isolates per-job failures so one bad object does not abort the run', async () => {
    writeJsonl('svc-bad', 'logs', yesterday, [
      { serviceName: 'svc-bad', body: 'x', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    writeJsonl('svc-good', 'logs', yesterday, [
      { serviceName: 'svc-good', body: 'y', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const memory = memoryConnector()
    /** @type {StorageConnector} */
    const connector = {
      scheme: 'flaky',
      async putObject(key, body, contentType) {
        await memory.putObject(key, body, contentType)
      },
      headObject(key) {
        if (key.includes('svc-bad')) {
          const err = /** @type {Error & { statusCode: number }} */ (new Error('s3 HEAD returned 503'))
          err.statusCode = 503
          return Promise.reject(err)
        }
        return memory.headObject(key)
      },
    }

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today,
      { sleep: async () => {} }
    )
    errSpy.mockRestore()

    expect(results).toHaveLength(2)
    const bad = results.find((r) => r.job.service === 'svc-bad')
    const good = results.find((r) => r.job.service === 'svc-good')
    expect(bad?.uploaded).toBe(false)
    expect(bad?.error?.message).toMatch(/503/)
    expect(good?.uploaded).toBe(true)
    expect([...memory.store.keys()]).toEqual([
      `collectivus/svc-good/logs/date=${yesterday}/data.parquet`,
    ])
  })

  it('retries transient connector failures with backoff and succeeds', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const memory = memoryConnector()
    let putAttempts = 0
    /** @type {number[]} */
    const sleeps = []
    /** @type {StorageConnector} */
    const connector = {
      scheme: 'flaky',
      async putObject(key, body, contentType) {
        putAttempts++
        if (putAttempts < 3) {
          const err = /** @type {Error & { statusCode: number }} */ (new Error('s3 PUT returned 503'))
          err.statusCode = 503
          throw err
        }
        await memory.putObject(key, body, contentType)
      },
      headObject(key) { return memory.headObject(key) },
    }

    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today,
      { sleep: (ms) => { sleeps.push(ms); return Promise.resolve() }, initialBackoffMs: 1000 }
    )

    expect(putAttempts).toBe(3)
    expect(sleeps).toEqual([1000, 4000])
    expect(results).toHaveLength(1)
    expect(results[0].uploaded).toBe(true)
    expect(memory.store.size).toBe(1)
  })

  it('does not retry on permanent (4xx) connector errors', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    let putAttempts = 0
    /** @type {StorageConnector} */
    const connector = {
      scheme: 'flaky',
      putObject() {
        putAttempts++
        const err = /** @type {Error & { statusCode: number }} */ (new Error('s3 PUT returned 403'))
        err.statusCode = 403
        return Promise.reject(err)
      },
      headObject() { return Promise.resolve(undefined) },
    }

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today,
      { sleep: async () => {} }
    )
    errSpy.mockRestore()

    expect(putAttempts).toBe(1)
    expect(results[0].uploaded).toBe(false)
    expect(results[0].error?.message).toMatch(/403/)
    expect(results[0].retryable).toBe(false)
  })

  it('flags exhausted transient connector retries as retryable', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    /** @type {StorageConnector} */
    const connector = {
      scheme: 'flaky',
      putObject() {
        const err = /** @type {Error & { statusCode: number }} */ (new Error('s3 PUT returned 503'))
        err.statusCode = 503
        return Promise.reject(err)
      },
      headObject() { return Promise.resolve(undefined) },
    }

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today,
      { sleep: async () => {} }
    )
    errSpy.mockRestore()

    expect(results[0].uploaded).toBe(false)
    expect(results[0].retryable).toBe(true)
  })

  it('does not flag non-connector errors as retryable', async () => {
    // Stage a real JSONL file and then strip its read permission so
    // readJsonlRows hits EACCES, a non-connector error with no statusCode.
    // Pre-fix, the outer catch ran isTransient on it and incorrectly flagged
    // it retryable, putting the scheduler into a fast-retry loop.
    writeJsonl('svc-bad', 'logs', yesterday, [
      { serviceName: 'svc-bad', body: 'x', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const filePath = path.join(outputDir, 'svc-bad', 'logs', `${yesterday}.jsonl`)
    fs.chmodSync(filePath, 0o000)

    const connector = memoryConnector()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today,
      { sleep: async () => {} }
    )
    errSpy.mockRestore()

    expect(results).toHaveLength(1)
    expect(results[0].uploaded).toBe(false)
    expect(results[0].error).toBeDefined()
    expect(results[0].retryable).toBe(false)
    // Restore perms so afterEach's rmSync can clean up the tmpDir.
    fs.chmodSync(filePath, 0o600)
  })

  it('writes a ledger entry per uploaded file', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today
    )

    const ledgerText = fs.readFileSync(path.join(outputDir, '.upload-ledger.jsonl'), 'utf8')
    const lines = ledgerText.trim().split('\n')
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0])
    expect(entry.service).toBe('svc-a')
    expect(entry.signal).toBe('logs')
    expect(entry.date).toBe(yesterday)
    expect(entry.status).toBe('committed')
    expect(entry.rows).toBe(1)
    expect(entry.size).toBeGreaterThan(0)
  })
})

describe('uploadPending (server-mode partition)', () => {
  /**
   * Mirror what the server NDJSON ingest endpoint writes:
   * `<outputDir>/<gateway_id>/<signal>/<YYYY-MM-DD>.jsonl`.
   *
   * @param {string} gatewayId
   * @param {'logs' | 'traces' | 'metrics'} signal
   * @param {string} date
   * @param {object[]} rows
   */
  function writeIngested(gatewayId, signal, date, rows) {
    const dir = path.join(outputDir, gatewayId, signal)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${date}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
    )
  }

  it('uploads one parquet per gateway-signal-day with a gateway-prefixed object key', async () => {
    writeIngested('gw-prod-1', 'logs', yesterday, [
      { serviceName: 'svc-x', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    writeIngested('gw-prod-2', 'logs', yesterday, [
      { serviceName: 'svc-y', body: 'b', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    const results = await uploadPending(
      {
        bucket: 'b',
        prefix: 'collectivus',
        time: '00:10',
        signals: ['logs', 'traces', 'metrics'],
        catchupDays: 7,
        region: 'us-east-1',
        partitionDimensions: ['gateway_id', 'signal'],
      },
      connector,
      outputDir,
      today
    )

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.uploaded)).toBe(true)
    expect([...connector.store.keys()].sort()).toEqual([
      `collectivus/gw-prod-1/logs/date=${yesterday}/data.parquet`,
      `collectivus/gw-prod-2/logs/date=${yesterday}/data.parquet`,
    ])
  })

  it('skips empty gateway directories silently', async () => {
    fs.mkdirSync(path.join(outputDir, 'gw-empty'), { recursive: true })
    fs.mkdirSync(path.join(outputDir, 'gw-half', 'logs'), { recursive: true })
    writeIngested('gw-real', 'logs', yesterday, [
      { serviceName: 'svc-x', body: 'r', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    const results = await uploadPending(
      {
        bucket: 'b',
        prefix: 'collectivus',
        time: '00:10',
        signals: ['logs', 'traces', 'metrics'],
        catchupDays: 7,
        region: 'us-east-1',
        partitionDimensions: ['gateway_id', 'signal'],
      },
      connector,
      outputDir,
      today
    )

    expect(results).toHaveLength(1)
    expect(results[0].uploaded).toBe(true)
    expect([...connector.store.keys()]).toEqual([
      `collectivus/gw-real/logs/date=${yesterday}/data.parquet`,
    ])
  })

  it('keeps gateway_id on each job for downstream callers (ledger, logs)', async () => {
    writeIngested('gw-x', 'logs', yesterday, [
      { serviceName: 'svc', body: '1', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    const results = await uploadPending(
      {
        bucket: 'b',
        prefix: 'collectivus',
        time: '00:10',
        signals: ['logs', 'traces', 'metrics'],
        catchupDays: 7,
        region: 'us-east-1',
        partitionDimensions: ['gateway_id', 'signal'],
      },
      connector,
      outputDir,
      today
    )

    expect(results[0].job.partition).toEqual({ gateway_id: 'gw-x', signal: 'logs' })
    // First-dimension value is mirrored to `service` so the ledger/key/log
    // code can keep treating the (service, signal, date) triple as unique.
    expect(results[0].job.service).toBe('gw-x')

    const ledgerText = fs.readFileSync(path.join(outputDir, '.upload-ledger.jsonl'), 'utf8')
    const entry = JSON.parse(ledgerText.trim())
    expect(entry.service).toBe('gw-x')
    expect(entry.signal).toBe('logs')
  })
})
