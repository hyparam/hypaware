// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { serverDisplayName } from '../../src/core/remote/builtin_remotes.js'

// @ref LLP 0437#server-name [tests]: the hosted default reads as HypAware Cloud, any other server by its host
test('serverDisplayName names the built-in server HypAware Cloud, under its current or previous host', () => {
  assert.equal(serverDisplayName('https://api.hypaware.ai'), 'HypAware Cloud')
  assert.equal(serverDisplayName('https://api.hypaware.ai/v1/ingest'), 'HypAware Cloud')
  assert.equal(serverDisplayName('https://hypaware.hyperparam.app'), 'HypAware Cloud')
})

test('serverDisplayName names any other server by its host, never its URL', () => {
  assert.equal(serverDisplayName('https://hyp.acme.dev/'), 'hyp.acme.dev')
  assert.equal(serverDisplayName('http://10.0.0.5:8443/api'), '10.0.0.5:8443')
})
