/**
 * End-to-end integration test for the proxy walkthrough documented in
 * docs/walkthrough-claude-code.md and the README. This test does not import
 * the collectivus internals; it spawns the CLI as a real subprocess so the
 * exact path a `claude-code` user takes is exercised: parse config → bind
 * proxy → record SSE stream → flush JSONL on shutdown.
 *
 * The companion docs are kept in sync with this test by design; if the
 * walkthrough drifts, this test breaks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

/**
 * @import { Server, IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'node:http'
 * @import { ChildProcessWithoutNullStreams } from 'node:child_process'
 */

const cliPath = fileURLToPath(new URL('../bin/cli.js', import.meta.url))

describe('proxy walkthrough: end-to-end via CLI', () => {
  /** @type {string} */
  let tmpDir
  /** @type {Server} */
  let upstream
  /** @type {string} */
  let upstreamUrl
  /** @type {(req: IncomingMessage, res: ServerResponse, body: string) => void} */
  let upstreamHandler
  /** @type {{ method: string | undefined, url: string | undefined, headers: IncomingHttpHeaders, body: string }[]} */
  let upstreamRequests
  /** @type {ChildProcessWithoutNullStreams | undefined} */
  let child

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-int-'))
    upstreamRequests = []
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    }
    upstream = http.createServer((req, res) => {
      /** @type {Buffer[]} */
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        upstreamRequests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body })
        upstreamHandler(req, res, body)
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)))
    const addr = upstream.address()
    if (!addr || typeof addr === 'string') throw new Error('upstream did not bind')
    upstreamUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child?.once('exit', () => resolve(undefined)))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    child = undefined
    await new Promise((resolve) => upstream.close(() => resolve(undefined)))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records a streaming Messages exchange end-to-end with redaction', async () => {
    // Mock the Anthropic SSE response shape claude-code receives. We don't
    // need the full message_start/content_block_delta protocol; just enough
    // to prove the proxy tees real streamed bytes to the recorder.
    const sseEvents = [
      'event: message_start\ndata: {"type":"message_start","msg":"a"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":" world"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let i = 0
      function next() {
        if (i >= sseEvents.length) { res.end(); return }
        res.write(sseEvents[i++])
        setImmediate(next)
      }
      next()
    }

    const sinkDir = path.join(tmpDir, 'data')
    const cfgPath = writeConfig(tmpDir, {
      version: 1,
      proxy: {
        listen: '127.0.0.1:0',
        upstreams: [
          { name: 'anthropic', base_url: upstreamUrl, match: { path_prefix: '/v1/messages' } },
        ],
      },
      sink: { type: 'file', dir: sinkDir },
    })

    const proxyPort = await launchAndWaitForProxy(cfgPath)

    // 1. Client streams the request, same shape claude-code sends with
    //    ANTHROPIC_BASE_URL pointed at the proxy.
    const requestBody = JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // x-api-key is the credential Anthropic uses; the proxy must pass it
        // through to upstream verbatim AND redact it in the recorded JSONL.
        'x-api-key': 'sk-ant-test-1234567890abcd',
        'anthropic-version': '2023-06-01',
        'accept': 'text/event-stream',
      },
      body: requestBody,
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/event-stream')

    // 2. Client receives the SSE bytes byte-for-byte.
    const received = await r.text()
    expect(received).toBe(sseEvents.join(''))

    // 3. Upstream saw the verbatim x-api-key (pass-through auth).
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0].headers['x-api-key']).toBe('sk-ant-test-1234567890abcd')

    // 4. Shut down cleanly so the FileSink fsyncs before we read.
    await shutdown()

    // 5. proxy.jsonl: stream_event rows in order + one final exchange row.
    const rows = readJsonl(sinkDir)
    const events = rows.filter((row) => row.kind === 'stream_event')
    const exchanges = rows.filter((row) => row.kind === 'exchange')

    expect(exchanges).toHaveLength(1)
    expect(events).toHaveLength(sseEvents.length)
    expect(events.map((row) => row.event)).toEqual([
      'message_start',
      'content_block_delta',
      'content_block_delta',
      'message_stop',
    ])
    // All events tied to the same exchange.
    const exchangeId = exchanges[0].exchange_id
    expect(events.every((row) => row.exchange_id === exchangeId)).toBe(true)

    // 6. Final exchange row carries the request the client sent and the
    //    upstream it was routed to. Body is omitted for SSE (per design; the
    //    per-event rows carry the data instead).
    const exchange = exchanges[0]
    expect(exchange.upstream).toBe('anthropic')
    expect(exchange.request.method).toBe('POST')
    expect(exchange.request.path).toBe('/v1/messages')
    expect(exchange.request.body).toBe(requestBody)
    expect(exchange.response.status).toBe(200)
    expect(exchange.response.body).toBeUndefined()
    expect(exchange.stream_event_count).toBe(sseEvents.length)
    expect(exchange.error).toBeUndefined()

    // 7. Redaction: x-api-key MUST be redacted, content-type MUST NOT be.
    //    Walk both casings since Node lowercases on the proxy side.
    const requestHeaders = exchange.request.headers
    expect(redactedValue(requestHeaders, 'x-api-key')).toMatch(/^REDACTED:/)
    expect(redactedValue(requestHeaders, 'x-api-key')).toMatch(/abcd$/)
    expect(redactedValue(requestHeaders, 'content-type')).toBe('application/json')
  }, 15000)

  it('records a gzipped streaming exchange: Anthropic compresses SSE when the client negotiates gzip', async () => {
    // Real Anthropic responses we recorded: text/event-stream + content-encoding: gzip.
    // Without decompression the recorder feeds gzip bytes to the SSE parser,
    // which never finds an event terminator and silently drops every event.
    const sseEvents = [
      'event: message_start\ndata: {"type":"message_start","msg":"a"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":" world"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    upstreamHandler = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'content-encoding': 'gzip',
      })
      const gz = zlib.createGzip()
      gz.pipe(res)
      let i = 0
      function next() {
        if (i >= sseEvents.length) { gz.end(); return }
        gz.write(sseEvents[i++], () => gz.flush(setImmediate.bind(null, next)))
      }
      next()
    }

    const sinkDir = path.join(tmpDir, 'data')
    const cfgPath = writeConfig(tmpDir, {
      proxy: {
        listen: '127.0.0.1:0',
        upstreams: [
          { name: 'anthropic', base_url: upstreamUrl, match: { path_prefix: '/v1/messages' } },
        ],
      },
      sink: { type: 'file', dir: sinkDir },
    })

    const proxyPort = await launchAndWaitForProxy(cfgPath)
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'accept-encoding': 'gzip',
      },
      body: JSON.stringify({ model: 'claude-opus-4-7', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/event-stream')
    // fetch transparently gunzips, so the client text is the original SSE.
    // The wire still carried gzip; the proxy must not have stripped it.
    expect(r.headers.get('content-encoding')).toBe('gzip')
    expect(await r.text()).toBe(sseEvents.join(''))

    await shutdown()

    const rows = readJsonl(sinkDir)
    const events = rows.filter((row) => row.kind === 'stream_event')
    const exchanges = rows.filter((row) => row.kind === 'exchange')

    expect(exchanges).toHaveLength(1)
    expect(events).toHaveLength(sseEvents.length)
    expect(events.map((row) => row.event)).toEqual([
      'message_start',
      'content_block_delta',
      'content_block_delta',
      'message_stop',
    ])
    // The README documents this exact extractor; make sure it works.
    const deltas = events
      .filter((row) => row.event === 'content_block_delta')
      .map((row) => JSON.parse(row.data).delta.text)
    expect(deltas).toEqual(['hello', ' world'])

    expect(exchanges[0].stream_event_count).toBe(sseEvents.length)
    expect(exchanges[0].error).toBeUndefined()
  }, 15000)

  it('records a gzipped non-streaming exchange with the decoded body, not gzip mojibake', async () => {
    const responseBody = JSON.stringify({ id: 'msg_test', content: [{ type: 'text', text: 'hello' }] })
    const gzipped = zlib.gzipSync(responseBody)
    upstreamHandler = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(gzipped.length),
      })
      res.end(gzipped)
    }

    const sinkDir = path.join(tmpDir, 'data')
    const cfgPath = writeConfig(tmpDir, {
      proxy: {
        listen: '127.0.0.1:0',
        upstreams: [
          { name: 'anthropic', base_url: upstreamUrl, match: { path_prefix: '/v1/messages' } },
        ],
      },
      sink: { type: 'file', dir: sinkDir },
    })

    const proxyPort = await launchAndWaitForProxy(cfgPath)
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' },
      body: '{"model":"claude-opus-4-7","stream":false,"messages":[]}',
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-encoding')).toBe('gzip')
    expect(await r.text()).toBe(responseBody)

    await shutdown()

    const rows = readJsonl(sinkDir)
    const exchanges = rows.filter((row) => row.kind === 'exchange')
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].response.body).toBe(responseBody)
    expect(exchanges[0].error).toBeUndefined()
  }, 15000)

  it('records a non-streaming exchange with the full response body', async () => {
    const responseBody = JSON.stringify({ id: 'msg_test', content: [{ type: 'text', text: 'hello' }] })
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(responseBody)
    }

    const sinkDir = path.join(tmpDir, 'data')
    const cfgPath = writeConfig(tmpDir, {
      version: 1,
      proxy: {
        listen: '127.0.0.1:0',
        upstreams: [
          { name: 'anthropic', base_url: upstreamUrl, match: { path_prefix: '/v1/messages' } },
        ],
      },
      sink: { type: 'file', dir: sinkDir },
    })

    const proxyPort = await launchAndWaitForProxy(cfgPath)
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"claude-opus-4-7","stream":false,"messages":[]}',
    })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe(responseBody)

    await shutdown()

    const rows = readJsonl(sinkDir)
    expect(rows.filter((row) => row.kind === 'stream_event')).toHaveLength(0)
    const exchanges = rows.filter((row) => row.kind === 'exchange')
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].response.body).toBe(responseBody)
    expect(exchanges[0].stream_event_count).toBe(0)
  }, 15000)

  /**
   * Launch the CLI and resolve with the proxy's effective port (parsed from
   * its startup banner: `Proxy listener bound on 127.0.0.1:<port>, ...`).
   * The OS-assigned port is the only way the test can reach a `listen: 0`
   * proxy without races.
   *
   * @param {string} cfgPath
   * @returns {Promise<number>}
   */
  function launchAndWaitForProxy(cfgPath) {
    child = spawn(process.execPath, [cliPath, '--config', cfgPath])
    /** @type {string} */
    let stdoutBuf = ''
    /** @type {string} */
    let stderrBuf = ''
    child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString() })

    return new Promise((resolve, reject) => {
      child?.once('error', reject)
      const start = Date.now()
      const interval = setInterval(() => {
        const m = /Proxy listener bound on 127\.0\.0\.1:(\d+)/.exec(stdoutBuf)
        if (m) {
          clearInterval(interval)
          resolve(Number.parseInt(m[1], 10))
          return
        }
        if (Date.now() - start > 5000) {
          clearInterval(interval)
          reject(new Error(
            `proxy did not bind within 5s.\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`
          ))
        }
      }, 25)
    })
  }

  /**
   * Send SIGTERM to the CLI and wait for it to exit cleanly. The FileSink's
   * close() runs as part of the listener `stop`, so when this resolves the
   * proxy.jsonl file is fsynced and safe to read.
   *
   * @returns {Promise<void>}
   */
  async function shutdown() {
    if (!child) return
    const exited = new Promise((resolve) => child?.once('exit', (code) => resolve(code)))
    child.kill('SIGTERM')
    const code = await exited
    expect(code).toBe(0)
    child = undefined
  }
})

/**
 * @param {string} dir
 * @param {object} cfg
 * @returns {string}
 */
function writeConfig(dir, cfg) {
  const p = path.join(dir, 'config.json')
  // v1 schema requires a top-level `version` field.
  fs.writeFileSync(p, JSON.stringify({ version: 1, ...cfg }, null, 2))
  return p
}

/**
 * Read every proxy JSONL row written under `<sinkDir>/<id>/proxy/`. The CLI
 * runs out-of-process and resolves `gateway_id` from the OS username, so we
 * don't hardcode a value; we just walk whatever subdirectory was created.
 *
 * @param {string} sinkDir
 * @returns {any[]}
 */
function readJsonl(sinkDir) {
  /** @type {any[]} */
  const rows = []
  for (const id of fs.readdirSync(sinkDir)) {
    const proxyDir = path.join(sinkDir, id, 'proxy')
    let names
    try {
      names = fs.readdirSync(proxyDir)
    } catch {
      continue
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.jsonl')) continue
      const text = fs.readFileSync(path.join(proxyDir, name), 'utf8')
      for (const line of text.split('\n')) {
        if (line.length > 0) rows.push(JSON.parse(line))
      }
    }
  }
  return rows
}

/**
 * Look up a header value by case-insensitive name. The recorder preserves the
 * original casing of inbound headers, so tests must match on a normalized key.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} name
 * @returns {string | string[] | undefined}
 */
function redactedValue(headers, name) {
  const target = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key]
  }
  return undefined
}
