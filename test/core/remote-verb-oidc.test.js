// @ts-check

/**
 * @import { TestContext } from 'node:test'
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { querySqlVerb } from '../../src/core/query/verb.js'
import { verbToCommand } from '../../src/core/cli/verb_command.js'
import { readCredentials, writeSession } from '../../src/core/remote/credentials.js'

const cmd = verbToCommand(querySqlVerb)
const MCP_URL = 'https://hyp.internal/mcp'
const FUTURE = '2999-01-01T00:00:00Z'
const PAST = '2000-01-01T00:00:00Z'

/**
 * Install a combined fetch stub that routes the identity `/token` refresh and
 * the MCP JSON-RPC against the same origin. The MCP side accepts only
 * `validJwt`; anything else gets a 401, simulating a stale/revoked access JWT.
 *
 * @param {TestContext} t
 * @param {{ validJwt: string, refreshTo?: string, refreshInvalid?: boolean, notificationAuthStatus?: 401 | 403 }} opts
 */
function stubServers(t, opts) {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const state = { validJwt: opts.validJwt, refreshCalls: 0 }

  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    const reply = (/** @type {any} */ obj, status = 200, ct = 'application/json') => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (/** @type {string} */ k) => k.toLowerCase() === 'content-type' ? ct : (k.toLowerCase() === 'mcp-session-id' ? 'sess-1' : null) },
      text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
    })

    // Identity refresh endpoint.
    if (String(url).includes('/v1/identity/token')) {
      state.refreshCalls++
      if (opts.refreshInvalid) return reply({ error: 'invalid_grant' }, 401)
      state.validJwt = opts.refreshTo ?? state.validJwt
      return reply({ access_jwt: state.validJwt, expires_at: FUTURE, org: 'acme' })
    }

    // MCP JSON-RPC.
    const req = JSON.parse(init.body)
    if (req.method === 'initialize') return reply({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } })
    if (req.method === 'notifications/initialized') {
      if (opts.notificationAuthStatus && init.headers.authorization !== `Bearer ${state.validJwt}`) return reply({}, opts.notificationAuthStatus)
      return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' }
    }
    if (req.method === 'tools/call') {
      if (init.headers.authorization !== `Bearer ${state.validJwt}`) return reply({}, 401)
      return reply({ jsonrpc: '2.0', id: req.id, result: { structuredContent: { columns: ['n'], rows: [{ n: 7 }] }, isError: false } })
    }
    return reply({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no' } })
  })
  return state
}

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-attach-'))
}

/** @param {string} hypHome */
function ctxWith(hypHome) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome },
    config: { version: 2, query: { remotes: { prod: { url: MCP_URL } } } },
    query: {}, storage: {},
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

test('a stale stored JWT is refreshed and persisted before the call', async (t) => {
  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  await writeSession(stateDir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-old', expiresAt: PAST, org: 'acme' })
  const state = stubServers(t, { validJwt: 'jwt-new', refreshTo: 'jwt-new' })

  const { ctx, out } = ctxWith(hypHome)
  const code = await cmd.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], ctx)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out.join('')), [{ n: 7 }])
  // Refreshed exactly once (pre-call, because the stored JWT was stale).
  assert.equal(state.refreshCalls, 1)
  // The new JWT was persisted.
  const creds = await readCredentials(stateDir)
  assert.equal(/** @type {any} */ (creds.prod).accessJwt, 'jwt-new')
})

test('a 401 mid-flight triggers exactly one refresh + retry', async (t) => {
  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  // Fresh-looking stored JWT, but the server rejects it (early revocation).
  await writeSession(stateDir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-revoked', expiresAt: FUTURE, org: 'acme' })
  const state = stubServers(t, { validJwt: 'jwt-fresh', refreshTo: 'jwt-fresh' })

  const { ctx, out } = ctxWith(hypHome)
  const code = await cmd.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], ctx)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out.join('')), [{ n: 7 }])
  assert.equal(state.refreshCalls, 1)
})

test('a notification 401 or 403 during handshake triggers exactly one refresh + retry', async (t) => {
  for (const status of /** @type {const} */ ([401, 403])) {
    await t.test(`HTTP ${status}`, async (t) => {
      const hypHome = await tmpHome()
      const stateDir = path.join(hypHome, 'hypaware')
      // Fresh-looking stored JWT, but the server accepts initialize and rejects
      // the initialized notification before tools/call can run.
      await writeSession(stateDir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-revoked', expiresAt: FUTURE, org: 'acme' })
      const state = stubServers(t, { validJwt: 'jwt-fresh', refreshTo: 'jwt-fresh', notificationAuthStatus: status })

      const { ctx, out } = ctxWith(hypHome)
      const code = await cmd.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], ctx)
      assert.equal(code, 0)
      assert.deepEqual(JSON.parse(out.join('')), [{ n: 7 }])
      assert.equal(state.refreshCalls, 1)
    })
  }
})

test('a refresh that fails invalid_grant surfaces the re-login guidance', async (t) => {
  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  await writeSession(stateDir, 'prod', { refreshToken: 'stale', accessJwt: 'jwt-revoked', expiresAt: FUTURE, org: 'acme' })
  stubServers(t, { validJwt: 'jwt-never', refreshInvalid: true })

  const { ctx, err } = ctxWith(hypHome)
  const code = await cmd.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], ctx)
  assert.equal(code, 2)
  assert.match(err.join(''), /remote session expired - re-run 'hyp remote login prod'/)
})

test('a stale JWT whose pre-call refresh fails maps to re-login (not an unhandled throw)', async (t) => {
  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  // Stale stored JWT: the initial resolve refreshes before the call, and that
  // refresh is the one that fails invalid_grant.
  await writeSession(stateDir, 'prod', { refreshToken: 'stale', accessJwt: 'jwt-old', expiresAt: PAST, org: 'acme' })
  stubServers(t, { validJwt: 'jwt-never', refreshInvalid: true })

  const { ctx, err } = ctxWith(hypHome)
  const code = await cmd.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], ctx)
  assert.equal(code, 2)
  assert.match(err.join(''), /remote session expired - re-run 'hyp remote login prod'/)
})

test('a static token that 401s is not retried (cannot refresh)', async (t) => {
  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  // A static token the server rejects; there is nothing to refresh.
  await fs.mkdir(stateDir, { recursive: true })
  const { writeToken } = await import('../../src/core/remote/credentials.js')
  await writeToken(stateDir, 'prod', 'static-bad')
  const state = stubServers(t, { validJwt: 'something-else' })

  const { ctx, err } = ctxWith(hypHome)
  const code = await cmd.run(['SELECT 1', '--remote', 'prod'], ctx)
  assert.equal(code, 1)
  assert.equal(state.refreshCalls, 0)
  assert.match(err.join(''), /re-run 'hyp remote login prod'/)
})

test('an env-override token that 401s does not advise a re-login it cannot fix', async (t) => {
  const hypHome = await tmpHome()
  // The env override wins and is never read from the store, so re-login cannot
  // fix it. The verb must point at the env var, not tell the user to re-login
  // (matching the stdio proxy, LLP 0058 D5).
  const state = stubServers(t, { validJwt: 'something-else' })
  const { ctx, err } = ctxWith(hypHome)
  ctx.env.HYP_REMOTE_TOKEN_PROD = 'env-bad'
  const code = await cmd.run(['SELECT 1', '--remote', 'prod'], ctx)
  assert.equal(code, 1)
  assert.equal(state.refreshCalls, 0)
  const joined = err.join('')
  assert.match(joined, /HYP_REMOTE_TOKEN_PROD/)
  assert.doesNotMatch(joined, /re-run 'hyp remote login/)
})

test('an oidc session whose freshly-refreshed JWT is still rejected gets re-login guidance (exit 2)', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  await writeSession(stateDir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-old', expiresAt: FUTURE, org: 'acme' })

  // The refresh succeeds (mints jwt-new), but the MCP side rejects every JWT
  // (server-side clock skew, or a revocation independent of the refresh row).
  // The surviving 401 is a dead session: re-login guidance, exit 2.
  let refreshCalls = 0
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    const reply = (/** @type {any} */ obj, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (/** @type {string} */ k) => k.toLowerCase() === 'content-type' ? 'application/json' : null },
      text: async () => JSON.stringify(obj),
    })
    if (String(url).includes('/v1/identity/token')) {
      refreshCalls++
      return reply({ access_jwt: 'jwt-new', expires_at: FUTURE, org: 'acme' })
    }
    const req = JSON.parse(init.body)
    if (req.method === 'initialize') return reply({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } })
    return reply({ jsonrpc: '2.0', id: req.id }, 401)
  })

  const { ctx, err } = ctxWith(hypHome)
  const code = await cmd.run(['SELECT 1', '--remote', 'prod'], ctx)
  assert.equal(code, 2)
  assert.equal(refreshCalls, 1)
  assert.match(err.join(''), /remote session expired - re-run 'hyp remote login prod'/)
})
