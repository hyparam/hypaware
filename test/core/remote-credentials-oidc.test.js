// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  isRefreshable,
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

test('a second read with no change skips re-reading the file (parse cache)', async (t) => {
  const dir = await tmpState()
  await writeToken(dir, 'prod', 'sk-1') // creates the file and busts the cache
  const spy = t.mock.method(fsp, 'readFile')
  const isCredFile = (/** @type {any} */ c) => String(c.arguments[0]).endsWith('remote-credentials.json')

  await readCredentials(dir) // miss: reads + parses once
  await readCredentials(dir) // hit: served from cache, no read
  assert.equal(spy.mock.calls.filter(isCredFile).length, 1)
})

test('a write is visible to the very next read (cache is busted on write)', async (t) => {
  const dir = await tmpState()
  await writeToken(dir, 'prod', 'sk-1')
  assert.deepEqual((await readCredentials(dir)).prod, { kind: 'static', token: 'sk-1' })
  // Overwrite through the module; the next read must see the new value, not the
  // cached one.
  await writeToken(dir, 'prod', 'sk-2')
  assert.deepEqual((await readCredentials(dir)).prod, { kind: 'static', token: 'sk-2' })
})

test('isRefreshable is true only for an oidc record read from the file', () => {
  assert.equal(isRefreshable({ kind: 'oidc', source: 'file' }), true)
  assert.equal(isRefreshable({ kind: 'oidc', source: 'env' }), false) // env override never refreshes
  assert.equal(isRefreshable({ kind: 'static', source: 'file' }), false)
})

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

test('an oidc record with a refresh token but no cached accessJwt is kept (refreshable)', async () => {
  const dir = await tmpState()
  // A partial write / interrupted refresh: the refresh token survives but the
  // cached JWT does not. The record is still usable - resolveAccessJwt can mint
  // a fresh JWT - so it must be kept (with an empty accessJwt), not dropped.
  await fs.writeFile(remoteCredentialsPath(dir), JSON.stringify({ prod: { kind: 'oidc', refreshToken: 'rt' } }))
  assert.deepEqual((await readCredentials(dir)).prod, { kind: 'oidc', refreshToken: 'rt', accessJwt: '', expiresAt: '', org: '' })
})

test('a static record with an empty token is dropped on read (not reported as stored)', async () => {
  const dir = await tmpState()
  // A hand-edited / partially-written record with no usable token. It must read
  // as absent so `remote list` and the resolvers agree it is logged out.
  await fs.writeFile(remoteCredentialsPath(dir), JSON.stringify({ prod: { token: '' } }))
  assert.deepEqual(await readCredentials(dir), {})
  const r = await resolveToken({ target: 'prod', env: {}, stateDir: dir })
  assert.equal(r.ok, false)
})

test('an oidc record with neither a refresh token nor a static token is dropped on read', async () => {
  const dir = await tmpState()
  await fs.writeFile(remoteCredentialsPath(dir), JSON.stringify({ prod: { kind: 'oidc', accessJwt: 'orphan-jwt' } }))
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

test('writing one target preserves a sibling record that does not normalize', async () => {
  const dir = await tmpState()
  // A valid sibling we understand, plus a record from a hypothetical newer
  // version that normalizeRecord would drop on read.
  await fs.writeFile(remoteCredentialsPath(dir), JSON.stringify({
    future: { kind: 'webauthn', handle: 'abc' },
  }))
  await writeToken(dir, 'prod', 'sk-1')
  // The future record must still be on disk after an unrelated login.
  const raw = JSON.parse(await fs.readFile(remoteCredentialsPath(dir), 'utf8'))
  assert.deepEqual(raw.future, { kind: 'webauthn', handle: 'abc' })
  assert.deepEqual(raw.prod, { kind: 'static', token: 'sk-1' })
})

test('removeToken drops a record that does not normalize and keeps the rest', async () => {
  const dir = await tmpState()
  await fs.writeFile(remoteCredentialsPath(dir), JSON.stringify({
    ghost: { kind: 'webauthn', handle: 'abc' },
    keep: { kind: 'static', token: 'sk-keep' },
  }))
  // removeToken must find and remove the un-normalizable record...
  assert.equal(await removeToken(dir, 'ghost'), true)
  const raw = JSON.parse(await fs.readFile(remoteCredentialsPath(dir), 'utf8'))
  assert.equal(raw.ghost, undefined)
  // ...without disturbing the sibling.
  assert.deepEqual(raw.keep, { kind: 'static', token: 'sk-keep' })
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

test('concurrent resolveAccessJwt is single-flight: the loser adopts the winner with no second token call', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'rt-old', accessJwt: 'jwt-old', expiresAt: PAST, org: 'acme' })
  let calls = 0
  // Two `hyp` processes resolve the same stale session at once. The write lock
  // serializes them: the winner refreshes once under the lock and commits; the
  // loser then acquires the lock, sees the fresh JWT, and adopts it without a
  // second token-endpoint call. No lost-refresh-race, no double-spend.
  const fetchImpl = /** @type {any} */ (async () => {
    calls++
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_jwt: 'jwt-new', expires_at: FUTURE, org: 'acme', refresh_token: 'rt-new' }) }
  })
  const both = await Promise.all([
    resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', fetchImpl }),
    resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', fetchImpl }),
  ])
  assert.equal(/** @type {any} */ (both[0]).token, 'jwt-new')
  assert.equal(/** @type {any} */ (both[1]).token, 'jwt-new')
  assert.equal(calls, 1) // only one process hit the token endpoint
  assert.equal(/** @type {any} */ ((await readCredentials(dir)).prod).refreshToken, 'rt-new')
})

test('resolveAccessJwt does not resurrect a session removed before the refresh', async () => {
  const dir = await tmpState()
  await writeSession(dir, 'prod', { refreshToken: 'rt-old', accessJwt: 'jwt-old', expiresAt: PAST, org: 'acme' })
  // A concurrent `hyp remote remove prod` deletes the row. removeToken and the
  // single-flight refresh share the write lock, so the removal lands fully before
  // the refresher re-reads under the lock; it then finds nothing and declines to
  // write a refreshed session back.
  assert.equal(await removeToken(dir, 'prod'), true)
  const fetchImpl = /** @type {any} */ (async () => { throw new Error('must not refresh a removed session') })
  const r = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', fetchImpl })
  assert.equal(r.ok, false)
  assert.match(/** @type {any} */ (r).error, /no token for 'prod' - run 'hyp remote login prod'/)
  // The removed session stays removed; nothing was written back.
  assert.equal(/** @type {any} */ ((await readCredentials(dir)).prod), undefined)
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

test('resolveAccessJwt with forceRefresh refreshes even when the cached JWT is still clock-fresh', async () => {
  const dir = await tmpState()
  // The stored JWT is nowhere near expiry, but a live request just got a 401, so
  // the attach path forces a refresh. forceRefresh must bypass the fresh-cache
  // fast path and the under-lock adopt-guard (which compares against the same
  // failing JWT) and actually mint a new token.
  await writeSession(dir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-fresh', expiresAt: FUTURE, org: 'acme' })
  let calls = 0
  const fetchImpl = /** @type {any} */ (async () => {
    calls++
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_jwt: 'jwt-forced', expires_at: FUTURE, org: 'acme', refresh_token: 'rt2' }) }
  })
  const r = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', fetchImpl, forceRefresh: true })
  assert.equal(/** @type {any} */ (r).token, 'jwt-forced')
  assert.equal(calls, 1)
})

test('resolveAccessJwt refreshes with the freshest stored refresh token in one shot', async () => {
  const dir = await tmpState()
  // A sibling rotated the refresh token to rt-new but its JWT is itself already
  // stale (e.g. clock skew or an immediately-expiring grant). Single-flight reads
  // the rotated token under the lock and refreshes from it once - no retry loop.
  await writeSession(dir, 'prod', { refreshToken: 'rt-new', accessJwt: 'jwt-mid', expiresAt: PAST, org: 'acme' })
  let calls = 0
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ opts) => {
    calls++
    assert.equal(JSON.parse(opts.body).refresh_token, 'rt-new') // refreshed from the freshest stored token
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_jwt: 'jwt-final', expires_at: FUTURE, org: 'acme', refresh_token: 'rt-final' }) }
  })
  const r = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: 'https://h/v1/identity', fetchImpl })
  assert.equal(/** @type {any} */ (r).token, 'jwt-final')
  assert.equal(calls, 1)
  assert.equal(/** @type {any} */ ((await readCredentials(dir)).prod).refreshToken, 'rt-final')
})

test('a write breaks a lock left stale by a crashed holder', async () => {
  const dir = await tmpState()
  await writeToken(dir, 'prod', 'sk-1') // creates the store
  const lockPath = `${remoteCredentialsPath(dir)}.lock`
  // Simulate a crashed holder: a leftover lock file, back-dated well past the
  // stale age so it reads as abandoned (LLP 0049 D1 - age, not liveness).
  await fs.writeFile(lockPath, 'crashed-holder-nonce')
  const stale = new Date(Date.now() - 5 * 60 * 1000)
  await fs.utimes(lockPath, stale, stale)
  // The next write must break the stale lock by age and succeed, not time out.
  await writeToken(dir, 'prod', 'sk-2')
  assert.deepEqual((await readCredentials(dir)).prod, { kind: 'static', token: 'sk-2' })
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
