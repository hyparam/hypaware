// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { createPkcePair } from '../../src/core/remote/pkce.js'

/** base64url with no padding, the encoding RFC 7636 mandates. */
function base64url(/** @type {Buffer} */ buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

test('challenge is the base64url SHA-256 of the verifier', () => {
  const { verifier, challenge } = createPkcePair()
  const expected = base64url(crypto.createHash('sha256').update(verifier).digest())
  assert.equal(challenge, expected)
})

test('verifier and challenge are base64url (no +/= padding chars)', () => {
  const { verifier, challenge } = createPkcePair()
  assert.match(verifier, /^[A-Za-z0-9_-]+$/)
  assert.match(challenge, /^[A-Za-z0-9_-]+$/)
})

test('two pairs differ (fresh randomness per flow)', () => {
  const a = createPkcePair()
  const b = createPkcePair()
  assert.notEqual(a.verifier, b.verifier)
  assert.notEqual(a.challenge, b.challenge)
})
