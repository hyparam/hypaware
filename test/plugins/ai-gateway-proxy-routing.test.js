// @ts-check

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createControlHandler } from '../../hypaware-core/plugins-workspace/ai-gateway/src/control.js'
import {
  compileUpstreams,
  matchUpstream,
  pathMatchesPrefix,
  startProxy,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'

test('compileUpstreams sorts by descending priority, then longer prefix, then registration order', () => {
  const compiled = compileUpstreams([
    { name: 'short-default', base_url: 'http://a', path_prefix: '/' },
    { name: 'specific-low-pri', base_url: 'http://b', path_prefix: '/v1/foo', priority: 1 },
    { name: 'specific-high-pri', base_url: 'http://c', path_prefix: '/v1/foo', priority: 5 },
    { name: 'wider-high-pri', base_url: 'http://d', path_prefix: '/v1', priority: 5 },
  ])
  assert.deepEqual(
    compiled.map((u) => u.name),
    ['specific-high-pri', 'wider-high-pri', 'specific-low-pri', 'short-default'],
  )
})

test('compileUpstreams rejects non-http(s) base_url', () => {
  assert.throws(
    () => compileUpstreams([{ name: 'bad', base_url: 'ftp://x/', path_prefix: '/' }]),
    /must use http:\/\/ or https:\/\//,
  )
})

test('compileUpstreams rejects unparseable base_url', () => {
  assert.throws(
    () => compileUpstreams([{ name: 'bad', base_url: 'not a url', path_prefix: '/' }]),
    /invalid base_url for upstream "bad"/,
  )
})

test('matchUpstream invokes match() and returns the first upstream whose match() is true', () => {
  /** @type {string[]} */
  const calls = []
  const compiled = compileUpstreams([
    {
      name: 'anthropic-like',
      base_url: 'http://a',
      priority: 10,
      match: (input) => {
        calls.push(`anthropic:${input.path}`)
        return input.path.startsWith('/v1/messages')
      },
    },
    {
      name: 'codex-like',
      base_url: 'http://b',
      priority: 5,
      match: (input) => {
        calls.push(`codex:${input.path}`)
        return input.path.startsWith('/v1/responses')
      },
    },
  ])
  const chosen = matchUpstream(compiled, 'POST', '/v1/responses', {})
  assert.equal(chosen?.name, 'codex-like')
  assert.deepEqual(calls, ['anthropic:/v1/responses', 'codex:/v1/responses'])
})

test('matchUpstream short-circuits on the first match - lower-priority match() is not called', () => {
  let lowCalled = false
  const compiled = compileUpstreams([
    {
      name: 'always',
      base_url: 'http://a',
      priority: 10,
      match: () => true,
    },
    {
      name: 'never-reached',
      base_url: 'http://b',
      priority: 5,
      match: () => {
        lowCalled = true
        return true
      },
    },
  ])
  const chosen = matchUpstream(compiled, 'GET', '/anything', {})
  assert.equal(chosen?.name, 'always')
  assert.equal(lowCalled, false)
})

test('matchUpstream ties on priority are broken by registration order', () => {
  const compiled = compileUpstreams([
    { name: 'first',  base_url: 'http://a', priority: 10, match: () => true },
    { name: 'second', base_url: 'http://b', priority: 10, match: () => true },
  ])
  const chosen = matchUpstream(compiled, 'GET', '/x', {})
  assert.equal(chosen?.name, 'first')
})

test('matchUpstream falls back to path-prefix when no match() is supplied', () => {
  const compiled = compileUpstreams([
    { name: 'echo', base_url: 'http://a', path_prefix: '/v1/echo' },
    { name: 'all',  base_url: 'http://b', path_prefix: '/' },
  ])
  assert.equal(matchUpstream(compiled, 'GET', '/v1/echo/x', {})?.name, 'echo')
  assert.equal(matchUpstream(compiled, 'GET', '/other', {})?.name, 'all')
})

test('matchUpstream treats a throwing match() as a non-match and continues to the next upstream', () => {
  const compiled = compileUpstreams([
    {
      name: 'boom',
      base_url: 'http://a',
      priority: 10,
      match: () => { throw new Error('boom') },
    },
    { name: 'fallback', base_url: 'http://b', priority: 5, path_prefix: '/' },
  ])
  assert.equal(matchUpstream(compiled, 'GET', '/x', {})?.name, 'fallback')
})

test('matchUpstream returns undefined when nothing matches', () => {
  const compiled = compileUpstreams([
    { name: 'codex', base_url: 'http://a', path_prefix: '/v1/responses' },
  ])
  assert.equal(matchUpstream(compiled, 'GET', '/v1/messages', {}), undefined)
})

test('matchUpstream hands match() a lowercased, array-valued header view', () => {
  /** @type {Record<string, string[]> | undefined} */
  let received
  const compiled = compileUpstreams([
    {
      name: 'capture',
      base_url: 'http://a',
      match: (input) => {
        received = input.headers
        return true
      },
    },
  ])
  matchUpstream(compiled, 'POST', '/x', { 'Content-Type': 'text/plain', 'X-Multi': ['a', 'b'] })
  assert.ok(received, 'match() should have been invoked')
  assert.deepEqual(received['content-type'], ['text/plain'])
  assert.deepEqual(received['x-multi'], ['a', 'b'])
})

test('pathMatchesPrefix: catch-all root, exact, segment, and non-match', () => {
  assert.equal(pathMatchesPrefix('/anything', '/'), true)
  assert.equal(pathMatchesPrefix('/v1/messages', '/v1/messages'), true)
  assert.equal(pathMatchesPrefix('/v1/messages/foo', '/v1/messages'), true)
  assert.equal(pathMatchesPrefix('/v1/messagesfoo', '/v1/messages'), false)
  assert.equal(pathMatchesPrefix('/v2/messages', '/v1/messages'), false)
})

test('a /_hypaware/* control request is handled locally: not forwarded to a catch-all upstream and starts no exchange (R2)', async () => {
  // @ref LLP 0066#control-path [tests] — the control short-circuit runs BEFORE
  // matchUpstream, so even a catch-all (`/`) upstream cannot leak a control
  // request to a provider, and no exchange is recorded for it.
  let upstreamHit = false
  const upstream = http.createServer((req, res) => {
    upstreamHit = true
    req.resume()
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('upstream')
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const upstreamAddr = upstream.address()
  assert.ok(upstreamAddr && typeof upstreamAddr === 'object')
  const upstreamUrl = `http://127.0.0.1:${upstreamAddr.port}`

  const ignoredSessions = /** @type {Set<string>} */ (new Set())
  let startExchangeCalls = 0
  const proxy = await startProxy({
    listen: '127.0.0.1:0',
    upstreams: [{ name: 'catch-all', base_url: upstreamUrl, path_prefix: '/' }],
    startExchange: () => {
      startExchangeCalls++
      // Minimal Exchange stub: enough surface for the proxy to forward a
      // normal request through it (a control request never reaches here).
      return /** @type {any} */ ({
        isSse: false,
        response: undefined,
        setResponseStart() {},
        appendResponseChunk() {},
        appendRequestChunk() {},
        consumeStreamChunk() {},
        setError() {},
      })
    },
    onExchangeFinished: () => {},
    onControlRequest: createControlHandler({ ignoredSessions }),
  })

  try {
    // The control request is served locally over the ignored-session set.
    const controlRes = await fetch(`http://${proxy.host}:${proxy.port}/_hypaware/ignore/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-control' }),
    })
    const controlBody = await controlRes.json()
    assert.equal(controlRes.status, 200)
    assert.deepEqual(controlBody, { session_id: 'sess-control', ignored: true, total: 1 })
    assert.ok(ignoredSessions.has('sess-control'), 'the control request updated the set locally')
    assert.equal(startExchangeCalls, 0, 'a control request starts no exchange')
    assert.equal(upstreamHit, false, 'a control request is never forwarded to the catch-all upstream')

    // A normal request under the same catch-all IS forwarded and DOES record.
    const proxied = await fetch(`http://${proxy.host}:${proxy.port}/v1/anything`)
    assert.equal(await proxied.text(), 'upstream')
    assert.equal(upstreamHit, true, 'a non-control request still reaches the catch-all upstream')
    assert.equal(startExchangeCalls, 1, 'a non-control request records exactly one exchange')
  } finally {
    await proxy.stop()
    await new Promise((resolve, reject) => {
      upstream.close((err) => (err ? reject(err) : resolve(undefined)))
    })
  }
})

test('an unknown /_hypaware/* path with no control handler is 404ed locally, not proxied', async () => {
  // With no onControlRequest wired, the proxy still short-circuits the reserved
  // prefix to a local 404 rather than forwarding it to the catch-all upstream.
  let upstreamHit = false
  const upstream = http.createServer((req, res) => {
    upstreamHit = true
    req.resume()
    res.writeHead(200)
    res.end('upstream')
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const upstreamAddr = upstream.address()
  assert.ok(upstreamAddr && typeof upstreamAddr === 'object')

  const proxy = await startProxy({
    listen: '127.0.0.1:0',
    upstreams: [{ name: 'catch-all', base_url: `http://127.0.0.1:${upstreamAddr.port}`, path_prefix: '/' }],
    startExchange: () => /** @type {any} */ ({}),
    onExchangeFinished: () => {},
  })

  try {
    const res = await fetch(`http://${proxy.host}:${proxy.port}/_hypaware/ignore/session`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 404)
    assert.equal(upstreamHit, false, 'the reserved prefix is never proxied even without a handler')
  } finally {
    await proxy.stop()
    await new Promise((resolve, reject) => {
      upstream.close((err) => (err ? reject(err) : resolve(undefined)))
    })
  }
})
