// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseConfigShape } from '../../src/core/config/schema.js'

/** @param {any} q */
const withQuery = (q) => parseConfigShape({ version: 2, query: q })

test('valid query.remotes + default_remote parses through', () => {
  const r = withQuery({ remotes: { prod: { url: 'https://hyp.internal/mcp' } }, default_remote: 'prod' })
  assert.equal(r.ok, true)
  assert.deepEqual(/** @type {any} */ (r).config.query, {
    remotes: { prod: { url: 'https://hyp.internal/mcp' } },
    default_remote: 'prod',
  })
})

test('remotes coexists with cache in the same query block', () => {
  const r = withQuery({ cache: { dir: '/tmp/c' }, remotes: { prod: { url: 'http://localhost:8080/mcp' } } })
  assert.equal(r.ok, true)
  assert.equal(/** @type {any} */ (r).config.query.cache.dir, '/tmp/c')
  assert.equal(/** @type {any} */ (r).config.query.remotes.prod.url, 'http://localhost:8080/mcp')
})

test('a non-http(s) url is rejected', () => {
  const r = withQuery({ remotes: { prod: { url: 'ftp://x/mcp' } } })
  assert.equal(r.ok, false)
  assert.match(/** @type {any} */ (r).errors[0].message, /http\(s\) URL/)
})

test('a remote target without a url is rejected', () => {
  const r = withQuery({ remotes: { prod: {} } })
  assert.equal(r.ok, false)
  assert.match(/** @type {any} */ (r).errors[0].message, /url is required/)
})

test('default_remote must name a defined target', () => {
  const r = withQuery({ remotes: { prod: { url: 'https://x/mcp' } }, default_remote: 'staging' })
  assert.equal(r.ok, false)
  assert.match(/** @type {any} */ (r).errors[0].message, /default_remote 'staging' is not a defined remote target/)
})
