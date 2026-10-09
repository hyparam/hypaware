// @ts-check

/**
 * @import { TestContext } from 'node:test'
 * @import { ServerResponse } from 'node:http'
 * @import { AddressInfo } from 'node:net'
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { McpRpcError, createHttpMcpClient } from '../../src/core/mcp/client.js'

/**
 * A loopback MCP server. `onCall` answers `tools/call`; the handshake is
 * answered normally. Every request's method and whether the client hung up
 * before the server finished are recorded.
 *
 * @param {TestContext} t
 * @param {(req: any, res: ServerResponse) => void} onCall
 */
async function startServer(t, onCall) {
  /** @type {string[]} */
  const methods = []
  /** @type {Promise<void>[]} */
  const disconnects = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const msg = JSON.parse(raw)
      methods.push(msg.method)
      if (msg.method === 'initialize') return sendJson(res, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } })
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end() }
      if (msg.method === 'tools/call') {
        disconnects.push(new Promise((resolve) => {
          res.on('close', () => { if (!res.writableFinished) resolve() })
        }))
        return onCall(msg, res)
      }
      sendJson(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve(undefined))
  }))
  const { port } = /** @type {AddressInfo} */ (server.address())
  return { url: `http://127.0.0.1:${port}/mcp`, methods, disconnects }
}

/** @param {ServerResponse} res @param {unknown} body */
function sendJson(res, body) {
  res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
  res.end(JSON.stringify(body))
}

/** Hold the request open without answering. @param {any} _msg @param {ServerResponse} _res */
function hang(_msg, _res) {}

test('without a signal the client behaves as before', async (t) => {
  const { url, methods } = await startServer(t, (msg, res) => {
    sendJson(res, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } })
  })
  const client = createHttpMcpClient({ url })
  await client.initialize()
  const result = await client.callTool('query_sql', { sql: 'select 1' })
  assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] })
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call'])
})

test('abort while the server is working rejects promptly and the server sees the disconnect', async (t) => {
  const { url, disconnects } = await startServer(t, hang)
  const controller = new AbortController()
  const client = createHttpMcpClient({ url, signal: controller.signal })
  await client.initialize()
  const call = client.callTool('session_evidence', { entries: [] })
  setTimeout(() => controller.abort(new Error('budget spent')), 30)
  const start = Date.now()
  await assert.rejects(call, /budget spent/)
  assert.ok(Date.now() - start < 1000, 'rejected without waiting for the server')
  assert.equal(disconnects.length, 1)
  await disconnects[0]
})

test('abort while an SSE answer is streaming rejects and drops the connection', async (t) => {
  const { url, disconnects } = await startServer(t, (_msg, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': keep-alive\n\n')
  })
  const controller = new AbortController()
  const client = createHttpMcpClient({ url, signal: controller.signal })
  await client.initialize()
  const call = client.callTool('session_evidence', {})
  setTimeout(() => controller.abort(new Error('deadline')), 30)
  await assert.rejects(call, /deadline/)
  await disconnects[0]
})

test('an already aborted signal sends nothing', async (t) => {
  const { url, methods } = await startServer(t, hang)
  const controller = new AbortController()
  controller.abort(new Error('too late'))
  const client = createHttpMcpClient({ url, signal: controller.signal })
  await assert.rejects(client.initialize(), /too late/)
  assert.deepEqual(methods, [])
})

test('an abort between calls stops the next request before it is sent', async (t) => {
  let fetches = 0
  const controller = new AbortController()
  const { url, methods } = await startServer(t, hang)
  const client = createHttpMcpClient({
    url,
    signal: controller.signal,
    fetchImpl: (input, init) => { fetches++; return fetch(input, init) },
  })
  await client.initialize()
  controller.abort(new Error('cancelled'))
  await assert.rejects(client.callTool('session_evidence', {}), /cancelled/)
  assert.equal(fetches, 2, 'only the handshake was fetched')
  assert.deepEqual(methods, ['initialize', 'notifications/initialized'])
})

for (const [code, text] of /** @type {const} */ ([[-32601, 'Unknown tool: session_evidence'], [-32602, 'Invalid params: entries']])) {
  test(`a JSON-RPC ${code} error keeps its code beside the existing message`, async (t) => {
    const { url } = await startServer(t, (msg, res) => {
      sendJson(res, { jsonrpc: '2.0', id: msg.id, error: { code, message: text } })
    })
    const client = createHttpMcpClient({ url })
    await client.initialize()
    const err = await client.callTool('session_evidence', {}).then(
      () => assert.fail('expected a rejection'),
      (/** @type {unknown} */ e) => e,
    )
    assert.ok(err instanceof McpRpcError)
    assert.ok(err instanceof Error)
    assert.equal(err.name, 'McpRpcError')
    assert.equal(err.message, `remote tools/call error ${code}: ${text}`)
    assert.equal(err.rpcCode, code)
    assert.equal(err.rpcMessage, text)
    assert.equal(err.method, 'tools/call')
  })
}

test('a JSON-RPC error inside an SSE answer is typed the same way', async (t) => {
  const { url } = await startServer(t, (msg, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'bad' } })}\n\n`)
  })
  const client = createHttpMcpClient({ url })
  await client.initialize()
  await assert.rejects(client.callTool('session_evidence', {}), (/** @type {any} */ err) =>
    err instanceof McpRpcError && err.rpcCode === -32602)
})

test('a transport failure stays a plain Error with no rpcCode', async (t) => {
  const { url } = await startServer(t, (_msg, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('upstream broke')
  })
  const client = createHttpMcpClient({ url })
  await client.initialize()
  await assert.rejects(client.callTool('session_evidence', {}), (/** @type {any} */ err) =>
    !(err instanceof McpRpcError) && err.rpcCode === undefined &&
    err.message === 'MCP tools/call failed: HTTP 500 - upstream broke')
})

test('callTool with maxBytes reads at most that much and fails past it; without it, reading is unchanged', async (t) => {
  const big = 'y'.repeat(5000)
  const { url } = await startServer(t, (msg, res) => {
    sendJson(res, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: big }] } })
  })
  const client = createHttpMcpClient({ url })
  await client.initialize()
  await assert.rejects(client.callTool('query_sql', {}, { maxBytes: 1000 }), (/** @type {any} */ err) => err.code === 'response_too_large' && /exceeds 1000 bytes/.test(err.message))
  const whole = await client.callTool('query_sql', {}, { maxBytes: 100_000 })
  assert.equal(whole.content[0].text.length, 5000)
  const unbounded = await client.callTool('query_sql', {})
  assert.equal(unbounded.content[0].text.length, 5000)
})
