// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  readCredentials,
  remoteCredentialsPath,
  removeToken,
  resolveAccessJwt,
  resolveToken,
  writeSession,
  writeToken,
} from '../../src/core/remote/credentials.js'

async function tmpState() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-oidc-creds-'))
}

const FUTURE = '2999-01-01T00:00:00Z'
const PAST = '2000-01-01T00:00:00Z'

test('an oidc session round-trips with kind: oidc', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: FUTURE, org: 'acme' })
  const creds = await readCredentials(dir)
  assert.deepEqual(creds.prod, { kind: 'oidc', refreshToken: 'rt', accessJwt: 'jwt', expiresAt: FUTURE, org: 'acme' })
  const st = await fs.stat(remoteCredentialsPath(dir))
  assert.equal(st.mode & 0o777, 0o600)
})

test('a record with a refreshToken but no accessJwt still yields its usable static token', async () => {
  const dir = await tmpState()
  // A corrupt/hand-edited record: an incomplete oidc shape that also carries a
  // working static token. The token must not be silently dropped.
  await fs.writeFile(remoteCredentialsPath(dir), JSON.stringify({ prod: { refreshToken: 'rt', token: 'still-good' } }))
  const creds = await readCredentials(dir)
  assert.deepEqual(creds.prod, { kind: 'static', token: 'still-good' })
})

test('a malformed oidc record (no accessJwt, no token) is dropped on read', async () => {
  const dir = await tmpState()
  await fs.writeFile(remoteCredentialsPath(dir), JSON.stringify({ prod: { kind: 'oidc', refreshToken: 'rt' } }))
  assert.deepEqual(await readCredentials(dir), {})
})

test('resolveToken returns an oidc record cached access JWT as-is', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-cached', expiresAt: FUTURE, org: 'acme' })
  const r = await resolveToken({ target: 'prod', env: {}, stateDir: dir })
  assert.deepEqual(r, { ok: true, token: 'jwt-cached', source: 'file' })
})

test('resolveAccessJwt refreshes a JWT inside the skew window (not yet past)', async () => {
  const dir = await tmpState()
  // Expiry 30s in the future, inside the 60s skew window: must refresh.
  const now = Date.parse('2026-06-29T12:00:00Z')
  const soon = new Date(now + 30 * 1000).toISOString()
  await writeSession(dir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-soon', expiresAt: soon, org: 'acme' })
  let refreshed = false
  const fetchImpl = /** @type {any} */ (async () => {
    refreshed = true
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_jwt: 'jwt-new', expires_at: FUTURE, org: 'acme' }) }
  })
  const r = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', now, fetchImpl })
  assert.equal(refreshed, true)
  assert.equal(/** @type {any} */ (r).token, 'jwt-new')
})

test('a legacy token-only record reads as kind: static', async () => {
  const dir = await tmpState()
  // Write the pre-kind on-disk shape directly.
  await fs.writeFile(remoteCredentialsPath(dir), JSON.stringify({ prod: { token: 'legacy' } }))
  const creds = await readCredentials(dir)
  assert.deepEqual(creds.prod, { kind: 'static', token: 'legacy' })
})

test('writeToken now stamps kind: static', async () => {
  const dir = await tmpState()
  await writeToken(dir, 'prod', 'sk-1')
  const creds = await readCredentials(dir)
  assert.deepEqual(creds.prod, { kind: 'static', token: 'sk-1' })
})

test('removeToken clears an oidc record too', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: FUTURE, org: 'acme' })
  assert.equal(await removeToken(dir, 'prod'), true)
  assert.deepEqual(await readCredentials(dir), {})
})

test('resolveAccessJwt returns a static token unchanged', async () => {
  const dir = await tmpState()
  await writeToken(dir, 'prod', 'sk-1')
  const r = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir })
  assert.deepEqual(r, { ok: true, token: 'sk-1', source: 'file', kind: 'static' })
})

test('resolveAccessJwt honors the per-target env override over the file', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: FUTURE, org: 'acme' })
  const r = await resolveAccessJwt({ target: 'prod', env: { HYP_REMOTE_TOKEN_PROD: 'env-tok' }, stateDir: dir })
  assert.deepEqual(r, { ok: true, token: 'env-tok', source: 'env', kind: 'static' })
})

test('resolveAccessJwt returns a fresh oidc JWT without calling refresh', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-fresh', expiresAt: FUTURE, org: 'acme' })
  let called = false
  const fetchImpl = /** @type {any} */ (async () => { called = true; return { ok: true, status: 200, text: async () => '{}' } })
  const r = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', fetchImpl })
  assert.equal(/** @type {any} */ (r).token, 'jwt-fresh')
  assert.equal(called, false)
})

test('resolveAccessJwt refreshes a stale oidc JWT and persists the new one', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-old', expiresAt: PAST, org: 'acme' })
  const fetchImpl = /** @type {any} */ (async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ access_jwt: 'jwt-new', expires_at: FUTURE, org: 'acme' }),
  }))
  const r = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', fetchImpl })
  assert.equal(/** @type {any} */ (r).token, 'jwt-new')
  // The new JWT + expiry were persisted.
  const creds = await readCredentials(dir)
  assert.equal(/** @type {any} */ (creds.prod).accessJwt, 'jwt-new')
  assert.equal(/** @type {any} */ (creds.prod).expiresAt, FUTURE)
})

test('resolveAccessJwt persists a rotated refresh token from the refresh response', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'rt-old', accessJwt: 'jwt-old', expiresAt: PAST, org: 'acme' })
  // A one-time-use server rotates the refresh token on each refresh.
  const fetchImpl = /** @type {any} */ (async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ access_jwt: 'jwt-new', expires_at: FUTURE, org: 'acme', refresh_token: 'rt-new' }),
  }))
  await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', fetchImpl })
  const creds = await readCredentials(dir)
  // The consumed token must be replaced; storing rt-old would 401 next refresh.
  assert.equal(/** @type {any} */ (creds.prod).refreshToken, 'rt-new')
})

test('resolveAccessJwt keeps the stored refresh token when the server does not rotate', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'rt-stable', accessJwt: 'jwt-old', expiresAt: PAST, org: 'acme' })
  const fetchImpl = /** @type {any} */ (async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ access_jwt: 'jwt-new', expires_at: FUTURE, org: 'acme' }),
  }))
  await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', fetchImpl })
  const creds = await readCredentials(dir)
  assert.equal(/** @type {any} */ (creds.prod).refreshToken, 'rt-stable')
})

test('resolveAccessJwt keeps the stored org when a refresh response omits it', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-old', expiresAt: PAST, org: 'acme' })
  // A refresh grant that re-mints only the access JWT (no org field) must not
  // wipe the stored org or fail; org is fixed for the refresh token's life.
  const fetchImpl = /** @type {any} */ (async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ access_jwt: 'jwt-new', expires_at: FUTURE }),
  }))
  const r = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', fetchImpl })
  assert.equal(/** @type {any} */ (r).token, 'jwt-new')
  const creds = await readCredentials(dir)
  assert.equal(/** @type {any} */ (creds.prod).org, 'acme')
})

test('resolveAccessJwt errors with login guidance when no record exists', async () => {
  const dir = await tmpState()
  const r = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir })
  assert.equal(r.ok, false)
  assert.match(/** @type {any} */ (r).error, /no token for 'prod' - run 'hyp remote login prod'/)
})

test('resolveAccessJwt propagates a refresh failure (invalid_grant)', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'stale', accessJwt: 'jwt-old', expiresAt: PAST, org: 'acme' })
  const fetchImpl = /** @type {any} */ (async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_grant' }) }))
  await assert.rejects(
    () => resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', fetchImpl }),
    (err) => { assert.equal(/** @type {any} */ (err).code, 'invalid_grant'); return true },
  )
})
