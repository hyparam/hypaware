// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { IdentityClient } from '../../hypaware-core/plugins-workspace/central/src/identity_client.js'

const DAY = 24 * 60 * 60

/** Fixed wall clock so JWT lifetime math is deterministic. */
const NOW_SEC = 1_900_000_000
const now = () => NOW_SEC * 1000

/**
 * Minimal unsigned JWT carrying a `sub` claim — the client decodes (does
 * not verify) it to recover the gateway id.
 * @param {string} sub
 */
function fakeJwt(sub) {
  const b64 = (/** @type {object} */ obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64({ sub })}.sig`
}

/**
 * Fake central server that mints a fresh gateway id on each bootstrap and
 * counts how many times bootstrap/refresh were hit.
 */
function makeFetch() {
  const calls = { bootstrap: 0, refresh: 0 }
  /** @type {typeof fetch} */
  const fetchFn = async (url) => {
    const u = String(url)
    if (u.endsWith('/v1/identity/bootstrap')) {
      calls.bootstrap += 1
      return new Response(
        JSON.stringify({ jwt: fakeJwt(`gw-${calls.bootstrap}`), expires_at: NOW_SEC + 30 * DAY }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (u.endsWith('/v1/identity/refresh')) {
      calls.refresh += 1
      return new Response(
        JSON.stringify({ jwt: fakeJwt(`gw-refresh-${calls.refresh}`), expires_at: NOW_SEC + 60 * DAY }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    return new Response('{"error":"not_found"}', { status: 404 })
  }
  return { fetchFn, calls }
}

function tmpIdentityPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-identity-'))
  return path.join(dir, 'identity.json')
}

test('first join bootstraps and stamps the minting url + token fingerprint', async () => {
  const persistedPath = tmpIdentityPath()
  const { fetchFn, calls } = makeFetch()
  const client = new IdentityClient({
    centralUrl: 'https://central-a.example',
    bootstrapToken: 'token-a',
    persistedPath,
    fetchFn,
    now,
  })
  const source = await client.acquire()
  assert.equal(source, 'bootstrapped')
  assert.equal(calls.bootstrap, 1)
  const persisted = JSON.parse(fs.readFileSync(persistedPath, 'utf8'))
  assert.equal(persisted.gateway_id, 'gw-1')
  assert.equal(persisted.central_url, 'https://central-a.example')
  assert.equal(typeof persisted.bootstrap_token_fp, 'string')
  // Fingerprint, never the raw token.
  assert.ok(!JSON.stringify(persisted).includes('token-a'))
})

test('reboot with the same mint reuses the persisted identity (no re-bootstrap)', async () => {
  const persistedPath = tmpIdentityPath()
  const first = makeFetch()
  await new IdentityClient({
    centralUrl: 'https://central-a.example', bootstrapToken: 'token-a', persistedPath, fetchFn: first.fetchFn, now,
  }).acquire()

  // Steady state: the seed is retired, so no bootstrap token is configured.
  const second = makeFetch()
  const source = await new IdentityClient({
    centralUrl: 'https://central-a.example', persistedPath, fetchFn: second.fetchFn, now,
  }).acquire()
  assert.equal(source, 'loaded')
  assert.equal(second.calls.bootstrap, 0)
})

test('re-join with a different token re-bootstraps a fresh gateway identity', async () => {
  const persistedPath = tmpIdentityPath()
  const first = makeFetch()
  await new IdentityClient({
    centralUrl: 'https://central-a.example', bootstrapToken: 'token-a', persistedPath, fetchFn: first.fetchFn, now,
  }).acquire()
  const before = JSON.parse(fs.readFileSync(persistedPath, 'utf8'))
  assert.equal(before.gateway_id, 'gw-1')

  // `hyp join` re-run with a new token (the persisted JWT is still valid).
  const second = makeFetch()
  const source = await new IdentityClient({
    centralUrl: 'https://central-a.example', bootstrapToken: 'token-B', persistedPath, fetchFn: second.fetchFn, now,
  }).acquire()
  assert.equal(source, 'bootstrapped')
  assert.equal(second.calls.bootstrap, 1)
  const after = JSON.parse(fs.readFileSync(persistedPath, 'utf8'))
  assert.equal(after.gateway_id, 'gw-1') // fresh mint from `second`'s server, counter restarted
  assert.notEqual(after.bootstrap_token_fp, before.bootstrap_token_fp)
})

test('re-join pointed at a different central URL re-bootstraps', async () => {
  const persistedPath = tmpIdentityPath()
  const first = makeFetch()
  await new IdentityClient({
    centralUrl: 'https://central-a.example', bootstrapToken: 'token-a', persistedPath, fetchFn: first.fetchFn, now,
  }).acquire()

  const second = makeFetch()
  const source = await new IdentityClient({
    centralUrl: 'https://central-b.example', bootstrapToken: 'token-a', persistedPath, fetchFn: second.fetchFn, now,
  }).acquire()
  assert.equal(source, 'bootstrapped')
  assert.equal(second.calls.bootstrap, 1)
  const after = JSON.parse(fs.readFileSync(persistedPath, 'utf8'))
  assert.equal(after.central_url, 'https://central-b.example')
})

test('an identity from an older build (no mint stamp) re-bootstraps when a token is set', async () => {
  const persistedPath = tmpIdentityPath()
  fs.mkdirSync(path.dirname(persistedPath), { recursive: true })
  // Legacy file: jwt + expires_at + gateway_id only, no mint provenance.
  fs.writeFileSync(persistedPath, JSON.stringify({
    jwt: fakeJwt('gw-legacy'), expires_at: NOW_SEC + 30 * DAY, gateway_id: 'gw-legacy',
  }))

  const { fetchFn, calls } = makeFetch()
  const source = await new IdentityClient({
    centralUrl: 'https://central-a.example', bootstrapToken: 'token-a', persistedPath, fetchFn, now,
  }).acquire()
  assert.equal(source, 'bootstrapped')
  assert.equal(calls.bootstrap, 1)
})
