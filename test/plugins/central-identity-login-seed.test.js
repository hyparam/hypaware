// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { IdentityClient } from '../../hypaware-core/plugins-workspace/central/src/identity_client.js'
import { writeLoginSeed } from '../../src/core/remote/gateway_seed.js'

const DAY = 24 * 60 * 60

/** Fixed wall clock so JWT lifetime math is deterministic. */
const NOW_SEC = 1_900_000_000
const now = () => NOW_SEC * 1000

/**
 * Minimal unsigned JWT carrying a `sub` claim, matching what the client
 * decodes (never verifies) to recover the gateway id.
 * @param {string} sub
 */
function fakeJwt(sub) {
  const b64 = (/** @type {object} */ obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64({ sub })}.sig`
}

/** Fake central server counting bootstrap/refresh hits. */
function makeFetch() {
  const calls = { bootstrap: 0, refresh: 0 }
  /** @type {typeof fetch} */
  const fetchFn = async (url) => {
    const u = String(url)
    if (u.endsWith('/v1/identity/bootstrap')) {
      calls.bootstrap += 1
      return new Response(
        JSON.stringify({ jwt: fakeJwt(`gw-boot-${calls.bootstrap}`), expires_at: NOW_SEC + 30 * DAY }),
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-login-seed-'))
  return path.join(dir, 'identity.json')
}

/** @param {string} persistedPath */
function seedArgs(persistedPath) {
  return {
    persistedPath,
    centralUrl: 'https://central-a.example',
    jwt: fakeJwt('gw-login'),
    expiresAt: NOW_SEC + 30 * DAY,
    gatewayId: 'gw-login',
  }
}

test('writeLoginSeed writes a 0600 login-origin identity stamped with the central URL', () => {
  const persistedPath = tmpIdentityPath()
  const { replaced } = writeLoginSeed(seedArgs(persistedPath))
  assert.equal(replaced, undefined)
  const persisted = JSON.parse(fs.readFileSync(persistedPath, 'utf8'))
  assert.equal(persisted.origin, 'login')
  assert.equal(persisted.central_url, 'https://central-a.example')
  assert.equal(persisted.gateway_id, 'gw-login')
  assert.equal(persisted.expires_at, NOW_SEC + 30 * DAY)
  assert.equal(persisted.bootstrap_token_fp, undefined)
  assert.equal(fs.statSync(persistedPath).mode & 0o777, 0o600)
})

test('writeLoginSeed returns the identity it displaced', () => {
  const persistedPath = tmpIdentityPath()
  writeLoginSeed(seedArgs(persistedPath))
  const again = writeLoginSeed({ ...seedArgs(persistedPath), gatewayId: 'gw-login-2', jwt: fakeJwt('gw-login-2') })
  assert.equal(again.replaced?.gateway_id, 'gw-login')
  assert.equal(again.replaced?.origin, 'login')
})

test('acquire() loads a login seed with no bootstrap token configured (LLP 0061 D2/D3)', async () => {
  const persistedPath = tmpIdentityPath()
  writeLoginSeed(seedArgs(persistedPath))
  const { fetchFn, calls } = makeFetch()
  const client = new IdentityClient({
    centralUrl: 'https://central-a.example', persistedPath, fetchFn, now,
  })
  const source = await client.acquire()
  assert.equal(source, 'loaded')
  assert.equal(calls.bootstrap, 0)
  assert.equal(await client.getCurrentJwt(), seedArgs(persistedPath).jwt)
})

test('a configured bootstrap token does not re-bootstrap over a same-URL login seed (LLP 0061 D3)', async () => {
  // The login seed has no bootstrap_token_fp; without the origin exemption the
  // mint-changed guard would read that as a swapped token and clobber the seed
  // on every daemon start.
  const persistedPath = tmpIdentityPath()
  writeLoginSeed(seedArgs(persistedPath))
  const { fetchFn, calls } = makeFetch()
  const source = await new IdentityClient({
    centralUrl: 'https://central-a.example', bootstrapToken: 'token-a', persistedPath, fetchFn, now,
  }).acquire()
  assert.equal(source, 'loaded')
  assert.equal(calls.bootstrap, 0)
})

test('a login seed for a different URL still re-bootstraps when a token is configured (LLP 0061 D4)', async () => {
  const persistedPath = tmpIdentityPath()
  writeLoginSeed(seedArgs(persistedPath))
  const { fetchFn, calls } = makeFetch()
  const source = await new IdentityClient({
    centralUrl: 'https://central-b.example', bootstrapToken: 'token-b', persistedPath, fetchFn, now,
  }).acquire()
  assert.equal(source, 'bootstrapped')
  assert.equal(calls.bootstrap, 1)
})

test('a re-point with no token refuses a login seed and points at re-login, not hyp join', async () => {
  const persistedPath = tmpIdentityPath()
  writeLoginSeed(seedArgs(persistedPath))
  const { fetchFn, calls } = makeFetch()
  await assert.rejects(
    new IdentityClient({ centralUrl: 'https://central-b.example', persistedPath, fetchFn, now }).acquire(),
    /central URL mismatch.*hyp remote login/s
  )
  assert.equal(calls.bootstrap, 0)
  assert.equal(calls.refresh, 0)
})

test('refresh preserves the login origin and central_url on the persisted identity', async () => {
  const persistedPath = tmpIdentityPath()
  // Expires inside the 24h refresh window, so acquire() refreshes immediately.
  writeLoginSeed({ ...seedArgs(persistedPath), expiresAt: NOW_SEC + 60 * 60 })
  const { fetchFn, calls } = makeFetch()
  const source = await new IdentityClient({
    centralUrl: 'https://central-a.example', persistedPath, fetchFn, now,
  }).acquire()
  assert.equal(source, 'refreshed')
  assert.equal(calls.refresh, 1)
  const persisted = JSON.parse(fs.readFileSync(persistedPath, 'utf8'))
  assert.equal(persisted.origin, 'login')
  assert.equal(persisted.central_url, 'https://central-a.example')
  assert.equal(persisted.gateway_id, 'gw-refresh-1')
})
