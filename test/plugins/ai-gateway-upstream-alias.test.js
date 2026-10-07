// @ts-check

/** @import { AddressInfo } from 'node:net' */

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { mergeUpstreams } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'
import { compileConfig } from '../../hypaware-core/plugins-workspace/ai-gateway/src/config.js'
import { compileUpstreams, matchUpstream, startProxy } from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'
import { createNullExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/recorder.js'
import { ollamaNativeRoute } from '../../hypaware-core/plugins-workspace/ollama/src/setup.js'

const route = ollamaNativeRoute()

// @ref LLP 0474#routes [tests]: resolve after operator merge and reserve the alias namespace before competing fallback
test('resolved alias uses the canonical configured transport without changing ordinary preset merge', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  assert.equal(typeof api.registerUpstreamAlias, 'function')
  api.registerUpstreamPreset({ name: 'ollama', base_url: 'http://default:11434', path_prefix: '/api/chat', match: () => false })
  api.registerUpstreamAlias('ollama-native', 'ollama', route)
  const config = compileConfig({ upstreams: [
    { name: 'ollama', base_url: 'http://custom:21500/service/', path_prefix: '/api/chat', priority: 7 },
    { name: 'catch-all', base_url: 'http://other', path_prefix: '/', priority: 999 },
  ] })
  const merged = mergeUpstreams(config.upstreams, state)
  const canonical = merged.find(u => u.name === 'ollama')
  assert.equal(canonical?.match, undefined)
  assert.equal(canonical?.rewrite, undefined)
  const compiled = compileUpstreams(merged)
  const chosen = matchUpstream(compiled, 'POST', '/ollama/api/chat', {})
  assert.equal(chosen?.name, 'ollama-native')
  assert.equal(chosen?.baseUrl.href, 'http://custom:21500/service/')
  assert.deepEqual(chosen?.rewrite, { from: '/ollama', to: '/service' })
  assert.equal(matchUpstream(compiled, 'POST', '/ollama/api/pull', {}), undefined)
  assert.equal(matchUpstream(compiled, 'GET', '/ollama/api/chat', {}), undefined)
  assert.equal(matchUpstream(compiled, 'GET', '/ollamax/api/chat', {})?.name, 'catch-all')
})

test('alias registration/resolution rejects missing targets, duplicate names, self/chains and conflicting namespace routes', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  assert.equal(typeof api.registerUpstreamAlias, 'function')
  assert.throws(() => api.registerUpstreamAlias('same', 'same', route), /self/)
  api.registerUpstreamAlias('door', 'target', route)
  assert.throws(() => api.registerUpstreamAlias('door', 'other', route), /duplicate|collision/)
  assert.throws(() => api.registerUpstreamAlias('chain', 'door', route), /chain/)
  assert.throws(() => mergeUpstreams([], state), /missing/)
  assert.throws(() => mergeUpstreams([{ name: 'door', base_url: 'http://x' }, { name: 'target', base_url: 'http://y' }], state), /collision/)
  const merged = mergeUpstreams([{ name: 'target', base_url: 'http://x' }, { name: 'conflict', base_url: 'http://y', path_prefix: '/ollama/api' }], state)
  assert.throws(() => compileUpstreams(merged), /conflict/)
})

for (const base of ['', '/', '/service', '/service/']) {
  test(`actual compiled alias forwards pathname AND query for base ${base || '(empty)'} and excludes discovery from capture`, async t => {
    const seen = []
    const upstream = http.createServer((req, res) => { seen.push([req.method, req.url]); req.resume(); res.end('ok') })
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve(undefined)))
    t.after(() => new Promise(resolve => upstream.close(resolve)))
    const address = /** @type {AddressInfo} */ (upstream.address())
    const state = createGatewayState()
    const api = createAiGatewayApi(state)
    assert.equal(typeof api.registerUpstreamAlias, 'function')
    api.registerUpstreamAlias('ollama-native', 'ollama', route)
    const upstreams = mergeUpstreams([
      { name: 'ollama', base_url: `http://127.0.0.1:${address.port}${base}`, path_prefix: '/api/chat' },
      { name: 'catch-all', base_url: `http://127.0.0.1:${address.port}`, path_prefix: '/', priority: 1000 },
    ], state)
    let captures = 0
    const proxy = await startProxy({ listen: '127.0.0.1:0', upstreams, startExchange: () => { captures++; return createNullExchange() }, onExchangeFinished() {} })
    t.after(() => proxy.stop())
    const root = `http://${proxy.host}:${proxy.port}`
    for (const [method, path] of [['HEAD', '/'], ['GET', '/api/version'], ['GET', '/api/tags'], ['POST', '/api/show'], ['POST', '/api/chat'], ['POST', '/api/generate']]) {
      const response = await fetch(`${root}/ollama${path}?x=a%2Fb&n=1`, { method })
      assert.equal(response.status, 200)
      await response.arrayBuffer()
      assert.deepEqual(seen.at(-1), [method, `${base.replace(/\/$/, '')}${path}?x=a%2Fb&n=1`])
    }
    assert.equal(captures, 2)
    const count = seen.length
    for (const [method, path] of [['POST', '/api/pull'], ['DELETE', '/api/chat'], ['GET', '/api/chat'], ['POST', '/api/chat/']]) {
      const response = await fetch(`${root}/ollama${path}`, { method })
      assert.equal(response.status, 404)
      await response.arrayBuffer()
    }
    assert.equal(seen.length, count)
    assert.equal(captures, 2)
  })
}

test('throwing or invalid alias capture predicates suppress capture while large streamed controls forward', async t => {
  const upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/x-ndjson')
      const chunk = 'x'.repeat(65536)
      let sent = 0
      function write() {
        while (sent++ < 64) if (!res.write(chunk)) return res.once('drain', write)
        res.end()
      }
      write()
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const address = /** @type {AddressInfo} */ (upstream.address())
  for (const captureMatch of [route.captureMatch, () => { throw new Error('private-token') }, /** @type {any} */ (() => 'yes')]) {
    const state = createGatewayState()
    const api = createAiGatewayApi(state)
    api.registerUpstreamAlias('ollama-native', 'ollama', { ...route, captureMatch })
    let captures = 0
    const proxy = await startProxy({ listen: '127.0.0.1:0', upstreams: mergeUpstreams([{ name: 'ollama', base_url: `http://127.0.0.1:${address.port}` }], state),
      startExchange: () => { captures++; return createNullExchange() }, onExchangeFinished() {},
    })
    try {
      const target = captureMatch === route.captureMatch ? '/api/show' : '/api/chat'
      const response = await fetch(`http://${proxy.host}:${proxy.port}/ollama${target}`, { method: 'POST', body: 'y'.repeat(2 * 1024 * 1024) })
      assert.equal(response.status, 200)
      let bytes = 0
      assert.ok(response.body)
      for await (const chunk of response.body) bytes += chunk.byteLength
      assert.equal(bytes, 4 * 1024 * 1024)
      assert.equal(captures, 0, 'no raw exchange or capture buffers for controls or failed predicates')
    } finally { await proxy.stop() }
  }
})
