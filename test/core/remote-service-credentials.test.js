// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runRemoteLogin, runRemoteMint } from '../../src/core/cli/remote_commands.js'
import {
  isRefreshable,
  readCredentials,
  remoteCredentialsPath,
  resolveAccessJwt,
  writeServiceRecord,
} from '../../src/core/remote/credentials.js'

/**
 * The `kind: 'service'` record `hyp remote login --token-file` stores for an
 * org service secret, and its re-exchange (LLP 0547 D4).
 */

const SECRET = `hsa_0123456789abcdef_${'A'.repeat(43)}`
const FUTURE = '2999-01-01T00:00:00Z'
const PAST = '2000-01-01T00:00:00Z'
const IDENTITY = 'https://h/v1/identity'

async function tmpState() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-svc-creds-'))
}

/**
 * @param {number} status
 * @param {object} body
 */
function tokenEndpoint(status, body) {
  /** @type {Array<{ url: string, body: any }>} */
  const calls = []
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
  })
  return { fetchImpl, calls }
}

/** @param {string} hypHome */
async function makeCtx(hypHome) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const configPath = path.join(hypHome, 'config.json')
  const config = { version: 2, query: { remotes: { prod: { url: 'https://hyp.internal/mcp' } } } }
  await fs.writeFile(configPath, JSON.stringify(config))
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome, HYP_CONFIG: configPath },
    config,
    stdin: { isTTY: true },
    stdout: { write: (/** @type {string} */ s) => { out.push(s) } },
    stderr: { write: (/** @type {string} */ s) => { err.push(s) } },
  })
  return { ctx, out, err }
}

test('a service record round-trips as kind: service, and a malformed secret is no credential', async () => {
  const dir = await tmpState()
  await writeServiceRecord(dir, 'prod', { secret: SECRET, accessJwt: 'jwt', expiresAt: FUTURE, org: 'acme' })
  assert.deepEqual((await readCredentials(dir)).prod, { kind: 'service', secret: SECRET, accessJwt: 'jwt', expiresAt: FUTURE, org: 'acme' })
  assert.equal((await fs.stat(remoteCredentialsPath(dir))).mode & 0o777, 0o600)

  // A clipped secret is dropped, and is never read as a static `token`.
  await fs.writeFile(remoteCredentialsPath(dir), JSON.stringify({ prod: { kind: 'service', secret: 'hsa_clipped', token: 'hsa_clipped' } }))
  assert.equal((await readCredentials(dir)).prod, undefined)
})

test('a service record read from the file is refreshable', () => {
  assert.equal(isRefreshable({ kind: 'service', source: 'file' }), true)
})

test('a fresh service JWT is used as-is; a stale one is re-exchanged from the secret and persisted', async () => {
  const dir = await tmpState()
  await writeServiceRecord(dir, 'prod', { secret: SECRET, accessJwt: 'jwt-fresh', expiresAt: FUTURE, org: 'acme' })
  const idle = tokenEndpoint(200, {})
  const fresh = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: IDENTITY, fetchImpl: idle.fetchImpl })
  assert.deepEqual(fresh, { ok: true, token: 'jwt-fresh', source: 'file', kind: 'service' })
  assert.equal(idle.calls.length, 0)

  await writeServiceRecord(dir, 'prod', { secret: SECRET, accessJwt: 'jwt-old', expiresAt: PAST, org: 'acme' })
  const live = tokenEndpoint(200, { access_jwt: 'jwt-new', expires_at: FUTURE, org: 'acme' })
  const stale = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: IDENTITY, fetchImpl: live.fetchImpl })
  assert.equal(/** @type {any} */ (stale).token, 'jwt-new')
  assert.deepEqual(live.calls.map((c) => c.body), [{ grant_type: 'service_token', service_token: SECRET }])
  assert.equal(live.calls[0].url, `${IDENTITY}/token`)
  assert.deepEqual((await readCredentials(dir)).prod, { kind: 'service', secret: SECRET, accessJwt: 'jwt-new', expiresAt: FUTURE, org: 'acme' })
})

test('a permanent 403 or invalid_grant names the code and the re-login, never the secret', async () => {
  for (const [status, code] of /** @type {const} */ ([[403, 'service_token_revoked'], [403, 'service_account_disabled'], [401, 'invalid_grant']])) {
    const dir = await tmpState()
    await writeServiceRecord(dir, 'prod', { secret: SECRET, accessJwt: 'jwt-old', expiresAt: PAST, org: 'acme' })
    const { fetchImpl } = tokenEndpoint(status, { error: code })
    const r = await resolveAccessJwt({ target: 'prod', env: {}, stateDir: dir, identityBase: IDENTITY, fetchImpl })
    assert.equal(r.ok, false)
    const error = /** @type {any} */ (r).error
    assert.match(error, new RegExp(`refused the service token \\(${code}\\)`))
    assert.match(error, /hyp remote login prod --token-file/)
    assert.ok(!error.includes(SECRET))
  }
})

test('a service secret in the env override is refused, not sent as a bearer', async () => {
  const dir = await tmpState()
  const r = await resolveAccessJwt({ target: 'prod', env: { HYP_REMOTE_TOKEN_PROD: SECRET }, stateDir: dir, identityBase: IDENTITY })
  assert.equal(r.ok, false)
  assert.match(/** @type {any} */ (r).error, /HYP_REMOTE_TOKEN_PROD holds a service token; store it with 'hyp remote login prod --token-file <path>'/)
})

test('remote login --token-file with a service secret exchanges once, then stores kind: service', async () => {
  const hypHome = await tmpState()
  const tokenFile = path.join(hypHome, 'tok.txt')
  await fs.writeFile(tokenFile, `${SECRET}\n`)
  const { ctx, out, err } = await makeCtx(hypHome)
  const { fetchImpl, calls } = tokenEndpoint(200, { access_jwt: 'jwt-1', expires_at: FUTURE, org: 'acme' })
  assert.equal(await runRemoteLogin(['prod', '--token-file', tokenFile], ctx, { fetchImpl }), 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://hyp.internal/v1/identity/token')
  assert.match(out.join(''), /stored service token for 'prod' \(org acme\)/)
  assert.ok(!out.join('').includes(SECRET) && !err.join('').includes(SECRET))
  const creds = await readCredentials(path.join(hypHome, 'hypaware'))
  assert.deepEqual(creds.prod, { kind: 'service', secret: SECRET, accessJwt: 'jwt-1', expiresAt: FUTURE, org: 'acme' })
})

test('remote login refuses a revoked secret at login and stores nothing', async () => {
  const hypHome = await tmpState()
  const tokenFile = path.join(hypHome, 'tok.txt')
  await fs.writeFile(tokenFile, SECRET)
  const { ctx, err } = await makeCtx(hypHome)
  const { fetchImpl } = tokenEndpoint(403, { error: 'service_token_revoked' })
  assert.equal(await runRemoteLogin(['prod', '--token-file', tokenFile], ctx, { fetchImpl }), 1)
  assert.match(err.join(''), /refused the service token \(service_token_revoked\)/)
  assert.equal((await readCredentials(path.join(hypHome, 'hypaware'))).prod, undefined)
})

test('remote login refuses a clipped secret and an unconfigured target locally, with no request', async () => {
  const hypHome = await tmpState()
  const { fetchImpl, calls } = tokenEndpoint(200, {})
  const clipped = path.join(hypHome, 'clipped.txt')
  await fs.writeFile(clipped, 'hsa_0123456789abcdef_short')
  const a = await makeCtx(hypHome)
  assert.equal(await runRemoteLogin(['prod', '--token-file', clipped], a.ctx, { fetchImpl }), 2)
  assert.match(a.err.join(''), /starts with 'hsa_' but is not a whole service token/)

  const whole = path.join(hypHome, 'tok.txt')
  await fs.writeFile(whole, SECRET)
  const b = await makeCtx(hypHome)
  assert.equal(await runRemoteLogin(['staging', '--token-file', whole], b.ctx, { fetchImpl }), 2)
  assert.match(b.err.join(''), /'staging' is not a configured target/)
  assert.equal(calls.length, 0)
})

test('mint refuses a service record before any request', async () => {
  const hypHome = await tmpState()
  await writeServiceRecord(path.join(hypHome, 'hypaware'), 'prod', { secret: SECRET, accessJwt: 'jwt', expiresAt: FUTURE, org: 'acme' })
  const { ctx, err } = await makeCtx(hypHome)
  const { fetchImpl, calls } = tokenEndpoint(200, {})
  assert.equal(await runRemoteMint(['prod'], ctx, { fetchImpl }), 2)
  assert.match(err.join(''), /holds a service token, which cannot mint/)
  assert.equal(calls.length, 0)
})
