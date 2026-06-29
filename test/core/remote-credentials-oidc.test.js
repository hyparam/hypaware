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
