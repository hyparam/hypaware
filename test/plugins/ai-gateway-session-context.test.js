// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { startProxy } from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'
import { createRecorder } from '../../hypaware-core/plugins-workspace/ai-gateway/src/recorder.js'

test('AI gateway stamps Claude hook session cwd onto projected message rows', async () => {
  const upstream = await startAnthropicUpstream()
  const recorder = createRecorder()
  const projector = createAiGatewayMessageProjector({ gatewayId: 'gw-test' })
  /** @type {Record<string, unknown>[]} */
  const rows = []
  let stopped = false
  const proxy = await startProxy({
    listen: '127.0.0.1:0',
    upstreams: [{
      name: 'anthropic',
      base_url: upstream.url,
      path_prefix: '/',
      provider: 'anthropic',
    }],
    startExchange: (init) => recorder.startExchange(init),
    async onExchangeFinished(exchange) {
      rows.push(...await projector.projectExchange(
        /** @type {Record<string, unknown>} */ (exchange.finalize())
      ))
    },
  })

  try {
    const baseUrl = `http://${proxy.host}:${proxy.port}`
    const contextRes = await fetch(`${baseUrl}/_hypaware/session-context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'sess-hook',
        cwd: '/repo/app',
        git_branch: 'main',
      }),
    })
    assert.equal(contextRes.status, 200)

    const body = JSON.stringify({
      model: 'claude-test',
      metadata: {
        user_id: JSON.stringify({ session_id: 'sess-hook', account_uuid: 'acct-1' }),
      },
      messages: [{ role: 'user', content: 'hello' }],
    })
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    assert.equal(response.status, 200)
    await response.text()

    await proxy.stop()
    stopped = true

    assert.equal(upstream.requests.length, 1)
    assert.ok(rows.length >= 2)
    assert.ok(rows.every((row) => row.cwd === '/repo/app'))
    assert.ok(rows.every((row) => row.git_branch === 'main'))
  } finally {
    if (!stopped) await proxy.stop().catch(() => undefined)
    await upstream.close()
  }
})

test('AI gateway session-context endpoint validates method and JSON body', async () => {
  const upstream = await startAnthropicUpstream()
  const recorder = createRecorder()
  let stopped = false
  const proxy = await startProxy({
    listen: '127.0.0.1:0',
    upstreams: [{
      name: 'anthropic',
      base_url: upstream.url,
      path_prefix: '/',
      provider: 'anthropic',
    }],
    startExchange: (init) => recorder.startExchange(init),
    onExchangeFinished() {},
  })

  try {
    const baseUrl = `http://${proxy.host}:${proxy.port}`
    const getRes = await fetch(`${baseUrl}/_hypaware/session-context`)
    assert.equal(getRes.status, 405)

    const invalidRes = await fetch(`${baseUrl}/_hypaware/session-context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(invalidRes.status, 400)
    assert.equal(upstream.requests.length, 0)

    await proxy.stop()
    stopped = true
  } finally {
    if (!stopped) await proxy.stop().catch(() => undefined)
    await upstream.close()
  }
})

/**
 * @returns {Promise<{ url: string, requests: Array<{ url: string | undefined, body: string }>, close: () => Promise<void> }>}
 */
function startAnthropicUpstream() {
  return new Promise((resolve) => {
    /** @type {Array<{ url: string | undefined, body: string }>} */
    const requests = []
    const server = http.createServer((req, res) => {
      /** @type {Buffer[]} */
      const chunks = []
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        requests.push({
          url: req.url,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: 'hi there' }],
          stop_reason: 'end_turn',
        }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      assert.ok(addr && typeof addr === 'object')
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => closeServer(server),
      })
    })
  })
}

/**
 * @param {http.Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}
