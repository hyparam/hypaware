// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileUpstreams,
  matchUpstream,
  pathMatchesPrefix,
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
