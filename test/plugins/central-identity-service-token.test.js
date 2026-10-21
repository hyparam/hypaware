// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { IdentityClient, ServiceCredentialStopped } from '../../hypaware-core/plugins-workspace/central/src/identity_client.js'
import { keptServiceToken, readKeptServiceToken, serviceTokenPath, writeKeptServiceToken } from '../../src/core/remote/service_token.js'
import { sha256Hex } from '../../src/core/util/json_util.js'

const DAY = 24 * 60 * 60
const NOW_SEC = 1_900_000_000
const now = () => NOW_SEC * 1000

const URL_A = 'https://central-a.example'
const URL_B = 'https://central-b.example'
const SECRET = `hsa_0123456789abcdef_${'A'.repeat(43)}`
const OTHER_SECRET = `hsa_fedcba9876543210_${'B'.repeat(43)}`

/** @param {string} sub */
function fakeJwt(sub) {
  const b64 = (/** @type {object} */ obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64({ sub })}.sig`
}

/**
 * Fake central that records every request. `routes` overrides a path's
 * answer; the default bootstrap mints `gw-<n>` and refresh extends it.
 *
 * @param {Record<string, (body: any) => Response>} [routes]
 */
function makeFetch(routes = {}) {
  /** @type {Array<{ url: string, body: string, auth: string | null }>} */
  const requests = []
  let minted = 0
  /** @type {typeof fetch} */
  const fetchFn = async (url, init) => {
    const u = String(url)
    const body = typeof init?.body === 'string' ? init.body : ''
    const headers = new Headers(init?.headers)
    requests.push({ url: u, body, auth: headers.get('authorization') })
    const route = Object.keys(routes).find((p) => u.endsWith(p))
    if (route) return routes[route](body ? JSON.parse(body) : undefined)
    if (u.endsWith('/v1/identity/bootstrap')) {
      minted += 1
      return json(200, { jwt: fakeJwt(`gw-${minted}`), expires_at: NOW_SEC + 30 * DAY })
    }
    if (u.endsWith('/v1/identity/refresh')) {
      return json(200, { jwt: fakeJwt('gw-1'), expires_at: NOW_SEC + 60 * DAY })
    }
    return json(404, { error: 'not_found' })
  }
  return { fetchFn, requests }
}

/**
 * @param {number} status
 * @param {object} body
 */
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** @param {string} code */
const refused = (code) => () => json(403, { error: code })

function tmpIdentityPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-svc-identity-'))
  return path.join(dir, 'identity.json')
}

/**
 * @param {string} identityPath
 * @param {{ secret?: string, centralUrl?: string, stopped_code?: string }} [opts]
 */
async function keep(identityPath, { secret = SECRET, centralUrl = URL_A, stopped_code } = {}) {
  const record = keptServiceToken({ secret, centralUrl, now: now() })
  if (stopped_code) record.stopped_code = stopped_code
  const wrote = await writeKeptServiceToken(serviceTokenPath(identityPath), record)
  assert.equal(wrote.outcome, 'written')
}

/**
 * @param {string} identityPath
 * @param {{ centralUrl?: string, secret?: string, expiresIn?: number, origin?: 'login', gatewayId?: string }} [opts]
 */
function writeIdentity(identityPath, { centralUrl = URL_A, secret = SECRET, expiresIn = 30 * DAY, origin, gatewayId = 'gw-kept' } = {}) {
  /** @type {Record<string, unknown>} */
  const identity = {
    jwt: fakeJwt(gatewayId),
    expires_at: NOW_SEC + expiresIn,
    gateway_id: gatewayId,
    central_url: centralUrl,
  }
  if (origin) identity.origin = origin
  else identity.bootstrap_token_fp = sha256Hex(secret)
  fs.writeFileSync(identityPath, JSON.stringify(identity))
}

function makeLog() {
  /** @type {Array<{ level: string, event: string, attrs: Record<string, unknown> }>} */
  const entries = []
  const at = (/** @type {string} */ level) => (/** @type {string} */ event, /** @type {Record<string, unknown>} */ attrs = {}) => {
    entries.push({ level, event, attrs })
  }
  const log = /** @type {any} */ ({ debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') })
  return { log, entries }
}

/**
 * @param {string} persistedPath
 * @param {typeof fetch} fetchFn
 * @param {{ centralUrl?: string, bootstrapToken?: string, log?: any, fs?: typeof fsp }} [opts]
 */
function client(persistedPath, fetchFn, { centralUrl = URL_A, bootstrapToken, log, fs: keptFs } = {}) {
  return new IdentityClient({ centralUrl, bootstrapToken, persistedPath, fetchFn, now, log, fs: keptFs })
}

/** @param {Promise<unknown>} promise @param {string} code */
async function rejectsStopped(promise, code) {
  await assert.rejects(promise, (err) => err instanceof ServiceCredentialStopped && err.code === code)
}

/** @param {string} identityPath */
async function storedStop(identityPath) {
  const read = await readKeptServiceToken(serviceTokenPath(identityPath))
  assert.equal(read.state, 'ok')
  return read.state === 'ok' ? read.record.stopped_code : undefined
}

test('destination binding: a record bound to A sends nothing to B, with or without identity.json', async () => {
  // identity.json bound to A: today's URL-mismatch refusal, byte for byte.
  const control = tmpIdentityPath()
  writeIdentity(control)
  const controlFetch = makeFetch()
  const controlErr = await client(control, controlFetch.fetchFn, { centralUrl: URL_B }).acquire().catch((e) => e)

  const withIdentity = tmpIdentityPath()
  writeIdentity(withIdentity)
  await keep(withIdentity)
  const a = makeFetch()
  const err = await client(withIdentity, a.fetchFn, { centralUrl: URL_B }).acquire().catch((e) => e)
  assert.equal(err.message, controlErr.message)
  assert.equal(a.requests.length, 0)

  // No identity.json: the error names A and the join remedy for B.
  const bare = tmpIdentityPath()
  await keep(bare)
  const b = makeFetch()
  const bareErr = await client(bare, b.fetchFn, { centralUrl: URL_B }).acquire().catch((e) => e)
  assert.match(bareErr.message, /enrolled with https:\/\/central-a\.example/)
  assert.match(bareErr.message, /hyp join https:\/\/central-b\.example/)
  assert.equal(b.requests.length, 0)
})

test('destination binding: a configured seed for a changed URL takes the seed path and never sends the kept secret', async () => {
  const p = tmpIdentityPath()
  writeIdentity(p)
  await keep(p)
  const { fetchFn, requests } = makeFetch()
  assert.equal(await client(p, fetchFn, { centralUrl: URL_B, bootstrapToken: 'ci-token-b' }).acquire(), 'bootstrapped')
  assert.equal(requests.length, 1)
  assert.ok(requests[0].url.startsWith(URL_B))
  assert.ok(!requests[0].body.includes(SECRET))
})

test('same-destination recovery: no identity.json bootstraps once with the kept secret', async () => {
  const p = tmpIdentityPath()
  await keep(p)
  const { log, entries } = makeLog()
  const { fetchFn, requests } = makeFetch()
  assert.equal(await client(p, fetchFn, { log }).acquire(), 'bootstrapped')
  assert.equal(requests.length, 1)
  assert.equal(JSON.parse(requests[0].body).bootstrap_token, SECRET)
  const persisted = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.equal(persisted.bootstrap_token_fp, sha256Hex(SECRET))
  assert.equal(persisted.central_url, URL_A)
  assert.ok(!JSON.stringify(entries).includes(SECRET))
})

test('same-destination recovery: a refresh 401 re-bootstraps once only for the identity the record enrolled', async () => {
  const matching = tmpIdentityPath()
  writeIdentity(matching)
  await keep(matching)
  const ok = makeFetch({ '/v1/identity/refresh': () => json(401, { error: 'invalid_grant' }) })
  const c = client(matching, ok.fetchFn)
  assert.equal(await c.acquire(), 'loaded')
  await c.refresh()
  assert.deepEqual(ok.requests.map((r) => new URL(r.url).pathname), ['/v1/identity/refresh', '/v1/identity/bootstrap'])
  assert.equal(JSON.parse(ok.requests[1].body).bootstrap_token, SECRET)

  for (const identity of [{ secret: OTHER_SECRET }, { origin: /** @type {const} */ ('login') }]) {
    const p = tmpIdentityPath()
    writeIdentity(p, identity)
    await keep(p)
    const f = makeFetch({ '/v1/identity/refresh': () => json(401, { error: 'invalid_grant' }) })
    const other = client(p, f.fetchFn)
    await other.acquire()
    await assert.rejects(other.refresh(), /identity refresh failed: HTTP 401/)
    assert.deepEqual(f.requests.map((r) => new URL(r.url).pathname), ['/v1/identity/refresh'])
  }
})

test('permanent refusal from bootstrap, refresh and upload stops at once and persists the stop', async () => {
  for (const code of ['service_token_revoked', 'service_account_disabled']) {
    // Bootstrap from the record.
    const boot = tmpIdentityPath()
    await keep(boot)
    const b = makeFetch({ '/v1/identity/bootstrap': refused(code) })
    const bc = client(boot, b.fetchFn)
    await rejectsStopped(bc.acquire(), code)
    await rejectsStopped(bc.getCurrentJwt(), code)
    await rejectsStopped(bc.refresh(), code)
    assert.equal(b.requests.length, 1)
    assert.equal(await storedStop(boot), code)

    // Refresh of an identity the record enrolled.
    const ref = tmpIdentityPath()
    writeIdentity(ref, { expiresIn: 60 })
    await keep(ref)
    const r = makeFetch({ '/v1/identity/refresh': refused(code) })
    const rc = client(ref, r.fetchFn)
    await rejectsStopped(rc.acquire(), code)
    await rejectsStopped(rc.getCurrentJwt(), code)
    assert.equal(r.requests.length, 1)
    assert.equal(await storedStop(ref), code)

    // Upload: the sink hands the code to stopCurrent.
    const up = tmpIdentityPath()
    writeIdentity(up)
    await keep(up)
    const u = makeFetch()
    const uc = client(up, u.fetchFn)
    await uc.acquire()
    const err = await uc.stopCurrent(code)
    assert.ok(err instanceof ServiceCredentialStopped)
    await rejectsStopped(uc.getCurrentJwt(), code)
    assert.equal(u.requests.length, 0)
    assert.equal(await storedStop(up), code)
  }
})

test('a stored stop refuses after restart with zero requests: fresh, stale, no identity, same-secret seed', async () => {
  const cases = [
    { identity: { expiresIn: 30 * DAY } },
    { identity: { expiresIn: 60 } },
    { identity: undefined },
    { identity: { expiresIn: 30 * DAY }, bootstrapToken: SECRET },
  ]
  for (const { identity, bootstrapToken } of cases) {
    const p = tmpIdentityPath()
    if (identity) writeIdentity(p, identity)
    await keep(p, { stopped_code: 'service_token_revoked' })
    const { fetchFn, requests } = makeFetch()
    const err = await client(p, fetchFn, { bootstrapToken }).acquire().catch((e) => e)
    assert.ok(err instanceof ServiceCredentialStopped)
    assert.equal(err.code, 'service_token_revoked')
    assert.match(err.message, /hyp join/)
    assert.ok(!err.message.includes(SECRET))
    assert.equal(requests.length, 0)
  }
})

test('unrelated-record controls: a stop for another secret or destination does not stop this credential', async () => {
  // A fresh identity another secret enrolled loads.
  const other = tmpIdentityPath()
  writeIdentity(other, { secret: OTHER_SECRET })
  await keep(other, { stopped_code: 'service_token_revoked' })
  assert.equal(await client(other, makeFetch().fetchFn).acquire(), 'loaded')

  // A login identity loads.
  const login = tmpIdentityPath()
  writeIdentity(login, { origin: 'login' })
  await keep(login, { stopped_code: 'service_token_revoked' })
  assert.equal(await client(login, makeFetch().fetchFn).acquire(), 'loaded')

  // A seed with a different secret bootstraps once.
  const seeded = tmpIdentityPath()
  await keep(seeded, { stopped_code: 'service_token_revoked' })
  const s = makeFetch()
  assert.equal(await client(seeded, s.fetchFn, { bootstrapToken: OTHER_SECRET }).acquire(), 'bootstrapped')
  assert.equal(s.requests.length, 1)
  assert.equal(JSON.parse(s.requests[0].body).bootstrap_token, OTHER_SECRET)

  // A record bound to another destination does not stop a seed for this one.
  const elsewhere = tmpIdentityPath()
  await keep(elsewhere, { centralUrl: URL_B, stopped_code: 'service_token_revoked' })
  assert.equal(await client(elsewhere, makeFetch().fetchFn, { bootstrapToken: SECRET }).acquire(), 'bootstrapped')
})

test('a stop the record cannot hold is held in memory and logged; a visible stop counts as persisted', async () => {
  // Rename fails before anything is visible: in memory only.
  const p = tmpIdentityPath()
  writeIdentity(p)
  await keep(p)
  const failRename = /** @type {typeof fsp} */ ({ ...fsp, rename: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) } })
  const { log, entries } = makeLog()
  const f = makeFetch({ '/v1/identity/refresh': refused('service_token_revoked') })
  const c = client(p, f.fetchFn, { log, fs: failRename })
  await c.acquire()
  await rejectsStopped(c.refresh(), 'service_token_revoked')
  await rejectsStopped(c.getCurrentJwt(), 'service_token_revoked')
  assert.equal(f.requests.length, 1)
  assert.equal(await storedStop(p), undefined)
  const notPersisted = entries.find((e) => e.attrs.error_kind === 'service_stop_not_persisted')
  assert.ok(notPersisted)
  assert.equal(notPersisted.attrs.credential_kind, 'service_token')
  for (const e of entries) {
    const text = JSON.stringify(e)
    assert.ok(!text.includes(SECRET))
    assert.ok(!text.includes(sha256Hex(SECRET)))
  }

  // After a restart: at most one request before the stop is reached again.
  const again = makeFetch({ '/v1/identity/refresh': refused('service_token_revoked') })
  const restarted = client(p, again.fetchFn)
  await restarted.acquire()
  await rejectsStopped(restarted.refresh(), 'service_token_revoked')
  await rejectsStopped(restarted.getCurrentJwt(), 'service_token_revoked')
  assert.equal(again.requests.length, 1)

  // The directory sync fails after the rename: the stop is visible, so it is persisted.
  const v = tmpIdentityPath()
  writeIdentity(v)
  await keep(v)
  const failDirSync = /** @type {typeof fsp} */ ({
    ...fsp,
    open: async (/** @type {any} */ target, /** @type {any} */ flags, /** @type {any} */ mode) => {
      if (flags === 'r') throw Object.assign(new Error('EIO'), { code: 'EIO' })
      return fsp.open(target, flags, mode)
    },
  })
  const vc = client(v, makeFetch({ '/v1/identity/refresh': refused('service_account_disabled') }).fetchFn, { fs: failDirSync })
  await vc.acquire()
  await rejectsStopped(vc.refresh(), 'service_account_disabled')
  assert.equal(await storedStop(v), 'service_account_disabled')
})

test('an unreadable record refuses activation with zero requests and never prints the secret', async () => {
  /** @type {Array<[string, (recordPath: string) => void | Promise<void>, typeof fsp | undefined]>} */
  const cases = [
    ['EACCES', () => {}, /** @type {typeof fsp} */ ({ ...fsp, readFile: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } })],
    ['EISDIR', (r) => { fs.rmSync(r); fs.mkdirSync(r) }, undefined],
    ['bad JSON', (r) => fs.writeFileSync(r, `{"secret":"${SECRET}"`), undefined],
    ['unknown version', (r) => rewrite(r, { version: 2 }), undefined],
    ['bad shape', (r) => rewrite(r, { secret: 'hsa_short', fingerprint: sha256Hex('hsa_short') }), undefined],
    ['fingerprint mismatch', (r) => rewrite(r, { fingerprint: sha256Hex(OTHER_SECRET) }), undefined],
  ]
  for (const [name, corrupt, keptFs] of cases) {
    const p = tmpIdentityPath()
    writeIdentity(p)
    await keep(p)
    await corrupt(serviceTokenPath(p))
    const { log, entries } = makeLog()
    const { fetchFn, requests } = makeFetch()
    const err = await client(p, fetchFn, { log, fs: keptFs }).acquire().catch((e) => e)
    assert.ok(err instanceof ServiceCredentialStopped, name)
    assert.equal(err.code, 'service_token_unreadable', name)
    assert.ok(!err.message.includes(SECRET), name)
    assert.ok(!JSON.stringify(entries).includes(SECRET), name)
    assert.equal(requests.length, 0, name)
  }
})

test('a 403 with any other body keeps the ordinary error path and stores no stop', async () => {
  const p = tmpIdentityPath()
  await keep(p)
  const f = makeFetch({ '/v1/identity/bootstrap': () => json(403, { error: 'forbidden' }) })
  const c = client(p, f.fetchFn)
  await assert.rejects(c.acquire(), (err) => !(err instanceof ServiceCredentialStopped) && /HTTP 403/.test(String(/** @type {Error} */ (err).message)))
  assert.equal(await storedStop(p), undefined)
  assert.equal(c.stopped, undefined)
})

/**
 * @param {string} recordPath
 * @param {Record<string, unknown>} patch
 */
function rewrite(recordPath, patch) {
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
  fs.writeFileSync(recordPath, JSON.stringify({ ...record, ...patch }))
}
