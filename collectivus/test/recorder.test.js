import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Recorder, isSseHeaders } from '../src/recorder.js'
import { FileSink } from '../src/sinks/file.js'
import { Proxy } from '../src/proxy.js'

/**
 * @import { Server, IncomingMessage, ServerResponse } from 'node:http'
 * @import { CollectingSink, MockUpstreamHandler } from './types.js'
 */

/**
 * Build an in-memory sink for unit tests so we don't pay file I/O. The shape
 * matches the file sink interface so the recorder is exercised identically.
 *
 * @returns {CollectingSink}
 */
function makeCollectingSink() {
  /** @type {any[]} */
  const rows = []
  return {
    rows,
    writeRow(obj) {
      rows.push(obj)
      return Promise.resolve()
    },
    close() {
      return Promise.resolve()
    },
  }
}

describe('Recorder: non-streaming exchange', () => {
  it('emits a single exchange row with the full request and response body', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'anthropic',
      client: { ip: '127.0.0.1', user_agent: 'claude-code/1.2.3' },
      request: {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
    })
    exchange.appendRequestChunk(Buffer.from('{"model":"claude"}'))
    exchange.setResponseStart({
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    exchange.appendResponseChunk(Buffer.from('{"id":"msg_1"}'))
    await exchange.finish()

    expect(sink.rows).toHaveLength(1)
    const row = sink.rows[0]
    expect(row.kind).toBe('exchange')
    expect(typeof row.exchange_id).toBe('string')
    expect(row.exchange_id).toMatch(/^[0-9a-f]{32}$/)
    expect(typeof row.ts_start).toBe('string')
    expect(typeof row.ts_end).toBe('string')
    expect(typeof row.duration_ms).toBe('number')
    expect(row.upstream).toBe('anthropic')
    expect(row.client).toEqual({ ip: '127.0.0.1', user_agent: 'claude-code/1.2.3' })
    expect(row.request).toEqual({
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"claude"}',
    })
    expect(row.response).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"id":"msg_1"}',
    })
    expect(row.stream_event_count).toBe(0)
    expect(row.error).toBeUndefined()
  })

  it('finish() is idempotent', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'GET', path: '/', headers: {} },
    })
    exchange.setResponseStart({ status: 204, headers: {} })
    await exchange.finish()
    await exchange.finish()
    expect(sink.rows).toHaveLength(1)
  })

  it('preserves multi-byte UTF-8 response body characters split across chunks', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'POST', path: '/', headers: {} },
    })
    const body = JSON.stringify({ text: 'hello 🚀 café' })
    const bytes = Buffer.from(body, 'utf8')
    const emojiStart = bytes.indexOf(Buffer.from('🚀', 'utf8'))
    exchange.setResponseStart({ status: 200, headers: { 'content-type': 'application/json' } })
    exchange.appendResponseChunk(bytes.subarray(0, emojiStart + 1))
    exchange.appendResponseChunk(bytes.subarray(emojiStart + 1))
    await exchange.finish()

    expect(sink.rows[0].response.body).toBe(body)
  })
})

describe('Recorder: header redaction', () => {
  it('redacts the default header set with REDACTED:<last4>', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer xyzabcd1234',
          'x-api-key': 'sk-ant-secret-9999',
          'anthropic-api-key': 'sk-ant-other-7777',
          'cookie': 'session=abcdef',
        },
      },
    })
    exchange.setResponseStart({
      status: 200,
      headers: {
        'set-cookie': 'sid=topsecret-tail',
        'x-request-id': 'req_abc',
      },
    })
    await exchange.finish()

    const row = sink.rows[0]
    expect(row.request.headers['content-type']).toBe('application/json')
    expect(row.request.headers['authorization']).toBe('REDACTED:1234')
    expect(row.request.headers['x-api-key']).toBe('REDACTED:9999')
    expect(row.request.headers['anthropic-api-key']).toBe('REDACTED:7777')
    expect(row.request.headers['cookie']).toBe('REDACTED:cdef')
    expect(row.response.headers['set-cookie']).toBe('REDACTED:tail')
    expect(row.response.headers['x-request-id']).toBe('req_abc')
  })

  it('redacts user-supplied headers in addition to the defaults', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({
      sink,
      redactHeaders: ['x-trace-token', 'X-Customer-Email'],
    })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: {
        method: 'POST',
        path: '/',
        headers: {
          'authorization': 'Bearer aaaa1234',
          'x-trace-token': 'tt-99wxyz',
          'X-Customer-Email': 'user@example.com',
          'x-keep-me': 'hello',
        },
      },
    })
    exchange.setResponseStart({ status: 200, headers: {} })
    await exchange.finish()

    const row = sink.rows[0]
    expect(row.request.headers['authorization']).toBe('REDACTED:1234')
    expect(row.request.headers['x-trace-token']).toBe('REDACTED:wxyz')
    expect(row.request.headers['X-Customer-Email']).toBe('REDACTED:.com')
    expect(row.request.headers['x-keep-me']).toBe('hello')
  })

  it('redacts each entry of an array-valued header independently', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'GET', path: '/', headers: {} },
    })
    exchange.setResponseStart({
      status: 200,
      headers: {
        'set-cookie': ['a=1234abcd', 'b=other-tail'],
      },
    })
    await exchange.finish()

    const row = sink.rows[0]
    expect(row.response.headers['set-cookie']).toEqual([
      'REDACTED:abcd',
      'REDACTED:tail',
    ])
  })

  it('never redacts request or response bodies (full visibility per design)', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({
      sink,
      redactHeaders: ['authorization', 'x-trace-token'],
    })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: {
        method: 'POST',
        path: '/',
        headers: { 'authorization': 'Bearer aaaa1234' },
      },
    })
    // Request and response bodies contain values that would be redacted as
    // headers; they must pass through verbatim.
    const sensitiveBody = '{"authorization":"Bearer aaaa1234","secret":"abc"}'
    exchange.appendRequestChunk(Buffer.from(sensitiveBody))
    exchange.setResponseStart({ status: 200, headers: {} })
    exchange.appendResponseChunk(Buffer.from(sensitiveBody))
    await exchange.finish()

    const row = sink.rows[0]
    expect(row.request.body).toBe(sensitiveBody)
    expect(row.response.body).toBe(sensitiveBody)
  })

  it('uses the whole value as tail when shorter than 4 characters', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: {
        method: 'GET',
        path: '/',
        headers: { 'authorization': 'ab' },
      },
    })
    exchange.setResponseStart({ status: 200, headers: {} })
    await exchange.finish()
    const row = sink.rows[0]
    expect(row.request.headers['authorization']).toBe('REDACTED:ab')
  })
})

describe('Recorder: streaming exchange', () => {
  it('emits stream_event rows in order, then a final exchange row with body omitted', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'anthropic',
      client: { ip: '127.0.0.1', user_agent: 'cc' },
      request: {
        method: 'POST',
        path: '/v1/messages',
        headers: { accept: 'text/event-stream' },
      },
    })
    exchange.setResponseStart({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    exchange.markStreaming()

    await exchange.consumeStreamChunk(Buffer.from(
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      'event: content_block_delta\ndata: {"text":"hello"}\n\n'
    ))
    await exchange.consumeStreamChunk(Buffer.from(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ))
    await exchange.finish()

    expect(sink.rows).toHaveLength(4)
    const events = sink.rows.slice(0, 3).map((r) => ({
      kind: r.kind, event: r.event, data: r.data, exchange_id: r.exchange_id,
    }))
    expect(events).toEqual([
      { kind: 'stream_event', event: 'message_start', data: '{"type":"message_start"}', exchange_id: exchange.id },
      { kind: 'stream_event', event: 'content_block_delta', data: '{"text":"hello"}', exchange_id: exchange.id },
      { kind: 'stream_event', event: 'message_stop', data: '{"type":"message_stop"}', exchange_id: exchange.id },
    ])
    const final = sink.rows[3]
    expect(final.kind).toBe('exchange')
    expect(final.stream_event_count).toBe(3)
    expect(final.response.body).toBeUndefined()
    expect(final.response.status).toBe(200)
    // each event row carries a monotonically non-decreasing t_ms relative to start
    for (let i = 0; i < events.length; i++) {
      const r = sink.rows[i]
      expect(typeof r.t_ms).toBe('number')
      expect(r.t_ms).toBeGreaterThanOrEqual(0)
    }
  })

  it('handles SSE events split across multiple chunks', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'POST', path: '/', headers: {} },
    })
    exchange.setResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } })
    exchange.markStreaming()

    // Split a single event across three chunks.
    await exchange.consumeStreamChunk(Buffer.from('event: deltas\nda'))
    await exchange.consumeStreamChunk(Buffer.from('ta: chunk-1\nda'))
    await exchange.consumeStreamChunk(Buffer.from('ta: chunk-2\n\n'))
    await exchange.finish()

    const eventRows = sink.rows.filter((r) => r.kind === 'stream_event')
    expect(eventRows).toHaveLength(1)
    const ev = eventRows[0]
    expect(ev.event).toBe('deltas')
    expect(ev.data).toBe('chunk-1\nchunk-2')
  })

  it('parses CRLF SSE separators alongside LF', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'POST', path: '/', headers: {} },
    })
    exchange.setResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } })
    exchange.markStreaming()

    await exchange.consumeStreamChunk(Buffer.from(
      'event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n'
    ))
    await exchange.finish()

    const events = sink.rows.filter((r) => r.kind === 'stream_event')
    expect(events.map((r) => r.event)).toEqual(['a', 'b'])
  })

  it('skips comment lines and yields no row for empty blocks', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'POST', path: '/', headers: {} },
    })
    exchange.setResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } })
    exchange.markStreaming()

    // Two comment-only blocks (heartbeats), then one real event.
    await exchange.consumeStreamChunk(Buffer.from(
      ': heartbeat\n\n: keepalive\n\nevent: real\ndata: payload\n\n'
    ))
    await exchange.finish()

    const events = sink.rows.filter((r) => r.kind === 'stream_event')
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.event).toBe('real')
    expect(ev.data).toBe('payload')
  })
})

describe('Recorder: error paths', () => {
  it('records a client-abort error string', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: '127.0.0.1', user_agent: undefined },
      request: { method: 'POST', path: '/v1/messages', headers: {} },
    })
    exchange.setResponseStart({ status: 200, headers: {} })
    exchange.appendResponseChunk(Buffer.from('partial'))
    exchange.setError(new Error('client aborted'))
    await exchange.finish()

    const row = sink.rows[0]
    expect(row.error).toBe('client aborted')
    expect(row.response.body).toBe('partial')
  })

  it('records non-Error throwables as strings', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'GET', path: '/', headers: {} },
    })
    exchange.setError('upstream timeout')
    await exchange.finish()
    const row = sink.rows[0]
    expect(row.error).toBe('upstream timeout')
  })

  it('captures error before response start (response stays undefined)', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'POST', path: '/v1/messages', headers: {} },
    })
    exchange.setError(new Error('connect ECONNREFUSED'))
    await exchange.finish()
    const row = sink.rows[0]
    expect(row.response).toBeUndefined()
    expect(row.error).toBe('connect ECONNREFUSED')
  })
})

describe('Recorder: drain', () => {
  // Mirrors the production race the gzip-decoder fix exposed: the proxy's
  // upstream connection has closed and shutdown begins, but a finalization
  // path (decoder still flushing) hasn't called finish() yet. drain() must
  // wait for that finalization before the sink is allowed to close.
  it('waits for in-flight exchanges whose finish() lands after drain begins', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: '127.0.0.1', user_agent: 'test' },
      request: { method: 'POST', path: '/v1/messages', headers: {} },
    })
    exchange.setResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } })
    exchange.markStreaming()

    const drained = recorder.drain()
    // Simulate the decoder firing 'end' a tick after drain starts.
    setImmediate(() => { exchange.finish() })
    await drained

    const exchanges = sink.rows.filter((r) => r.kind === 'exchange')
    expect(exchanges).toHaveLength(1)
    expect(recorder.active.size).toBe(0)
  })

  it('returns immediately when no exchanges are in flight', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    await recorder.drain()
    expect(sink.rows).toHaveLength(0)
  })

  it('force-finalizes exchanges that exceed the timeout so no row is lost', async () => {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink })
    recorder.startExchange({
      upstream: 'a',
      client: { ip: '127.0.0.1', user_agent: 'test' },
      request: { method: 'POST', path: '/v1/messages', headers: {} },
    })
    // Never call finish(); drain must time out and force-finalize so the
    // exchange row still lands.
    await recorder.drain(10)
    const exchanges = sink.rows.filter((r) => r.kind === 'exchange')
    expect(exchanges).toHaveLength(1)
    expect(recorder.active.size).toBe(0)
  })
})

describe('isSseHeaders', () => {
  it('detects text/event-stream content types with parameters', () => {
    expect(isSseHeaders({ 'content-type': 'text/event-stream' })).toBe(true)
    expect(isSseHeaders({ 'content-type': 'text/event-stream; charset=utf-8' })).toBe(true)
    expect(isSseHeaders({ 'Content-Type': 'TEXT/EVENT-STREAM' })).toBe(true)
  })
  it('returns false for non-SSE content types and missing headers', () => {
    expect(isSseHeaders({ 'content-type': 'application/json' })).toBe(false)
    expect(isSseHeaders({})).toBe(false)
    expect(isSseHeaders({ 'content-type': undefined })).toBe(false)
  })
})

/**
 * Spawn a mock upstream that lets each test register a per-request handler.
 *
 * @returns {Promise<{ server: Server, baseUrl: string, setHandler: (h: MockUpstreamHandler) => void }>}
 */
function createMockUpstream() {
  return new Promise((resolve) => {
    /**
     * @param {IncomingMessage} _req
     * @param {ServerResponse} res
     */
    function defaultHandler(_req, res) { res.end() }
    /** @type {MockUpstreamHandler} */
    let handler = defaultHandler
    const server = http.createServer((req, res) => {
      /** @type {Buffer[]} */
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        handler(req, res, body)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('no address')
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        setHandler: (h) => { handler = h },
      })
    })
  })
}

/**
 * @param {Proxy} proxy
 * @returns {string}
 */
function proxyOrigin(proxy) {
  const addr = proxy.server?.address()
  if (!addr || typeof addr === 'string') throw new Error('proxy not bound')
  return `http://127.0.0.1:${addr.port}`
}

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const TEST_GATEWAY_ID = 'tester'

/**
 * Read every JSONL row written by the proxy FileSink under
 * `<dir>/<gateway_id>/proxy/`. Concatenates files in lexicographic (date)
 * order so multi-day fixtures still come back in submission order.
 *
 * @param {string} dir
 * @returns {Record<string, any>[]}
 */
function readJsonl(dir) {
  const proxyDir = path.join(dir, TEST_GATEWAY_ID, 'proxy')
  if (!fs.existsSync(proxyDir)) return []
  const files = fs.readdirSync(proxyDir).filter((n) => n.endsWith('.jsonl')).sort()
  /** @type {Record<string, any>[]} */
  const rows = []
  for (const name of files) {
    const text = fs.readFileSync(path.join(proxyDir, name), 'utf8')
    if (text.length === 0) continue
    for (const line of text.split('\n')) {
      if (line.length > 0) rows.push(JSON.parse(line))
    }
  }
  return rows
}

describe('integration: Proxy + Recorder + FileSink (full round-trip)', () => {
  /** @type {Awaited<ReturnType<typeof createMockUpstream>>} */
  let upstream
  /** @type {Proxy} */
  let proxy
  /** @type {FileSink} */
  let sink
  /** @type {string} */
  let tmpDir

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-rec-'))
    upstream = await createMockUpstream()
    sink = new FileSink(tmpDir, TEST_GATEWAY_ID)
    const recorder = new Recorder({ sink })
    proxy = new Proxy({
      listen: '127.0.0.1:0',
      upstreams: [{ name: 'anthropic', base_url: upstream.baseUrl, match: { path_prefix: '/v1' } }],
    }, { recorder })
    await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
    await new Promise((r) => upstream.server.close(() => r(undefined)))
    await sink.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records a non-streaming exchange end-to-end', async () => {
    upstream.setHandler((_req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ echoed: body }))
    })

    const payload = JSON.stringify({ model: 'claude', messages: [] })
    const r = await fetch(`${proxyOrigin(proxy)}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer xyzabcd1234',
        'x-api-key': 'sk-ant-secret-9999',
      },
      body: payload,
    })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe(JSON.stringify({ echoed: payload }))

    await waitFor(() => readJsonl(tmpDir).length >= 1)
    const rows = readJsonl(tmpDir)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.kind).toBe('exchange')
    expect(row.upstream).toBe('anthropic')
    expect(row.request.method).toBe('POST')
    expect(row.request.path).toBe('/v1/messages')
    expect(row.request.headers.authorization).toBe('REDACTED:1234')
    expect(row.request.headers['x-api-key']).toBe('REDACTED:9999')
    expect(row.request.body).toBe(payload)
    expect(row.response.status).toBe(200)
    expect(row.response.body).toBe(JSON.stringify({ echoed: payload }))
    expect(row.stream_event_count).toBe(0)
    expect(row.error).toBeUndefined()
  })

  it('records SSE events as separate rows plus a final exchange row', async () => {
    upstream.setHandler((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      res.write('event: message_start\ndata: {"id":"msg_x"}\n\n')
      res.write('event: content_block_delta\ndata: {"text":"hi"}\n\n')
      res.write('event: message_stop\ndata: {}\n\n')
      res.end()
    })

    const r = await fetch(`${proxyOrigin(proxy)}/v1/messages`, {
      method: 'POST',
      headers: { 'accept': 'text/event-stream' },
      body: '{}',
    })
    // Drain the response body so the proxy sees end-of-stream.
    await r.text()
    expect(r.status).toBe(200)

    await waitFor(() => {
      const rows = readJsonl(tmpDir)
      return rows.length >= 4 && rows[rows.length - 1].kind === 'exchange'
    })
    const rows = readJsonl(tmpDir)
    const events = rows.filter((row) => row.kind === 'stream_event')
    const finals = rows.filter((row) => row.kind === 'exchange')
    expect(events).toHaveLength(3)
    expect(events.map((row) => row.event)).toEqual([
      'message_start', 'content_block_delta', 'message_stop',
    ])
    expect(finals).toHaveLength(1)
    expect(finals[0].stream_event_count).toBe(3)
    expect(finals[0].response.body).toBeUndefined()
    // All event rows share the same exchange_id with the final row.
    const id = finals[0].exchange_id
    expect(events.every((row) => row.exchange_id === id)).toBe(true)
  })

  it('records an error row when the upstream connection fails', async () => {
    // Close the upstream first so the proxied connection refuses.
    await new Promise((r) => upstream.server.close(() => r(undefined)))

    const r = await fetch(`${proxyOrigin(proxy)}/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(r.status).toBe(502)
    await r.text()

    await waitFor(() => readJsonl(tmpDir).length >= 1)
    const rows = readJsonl(tmpDir)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.kind).toBe('exchange')
    expect(row.error).toMatch(/ECONNREFUSED|connect/i)
    expect(row.response.status).toBe(502)
  })

  it('produces JSONL that can be replayed', async () => {
    upstream.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await fetch(`${proxyOrigin(proxy)}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    }).then((r) => r.text())

    await waitFor(() => readJsonl(tmpDir).length >= 1)
    // Re-read the raw file(s) and confirm each line is valid JSON. The proxy
    // sink rotates daily, so this glob covers both today's file and (in the
    // unlikely event the test straddles UTC midnight) yesterday's.
    const proxyDir = path.join(tmpDir, TEST_GATEWAY_ID, 'proxy')
    const files = fs.readdirSync(proxyDir).filter((n) => n.endsWith('.jsonl')).sort()
    const lines = files
      .flatMap((n) => fs.readFileSync(path.join(proxyDir, n), 'utf8').split('\n'))
      .filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0])).not.toThrow()
  })
})
