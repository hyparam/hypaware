// @ts-check

import http from 'node:http'
import process from 'node:process'

import { installObservability } from '../../../src/core/observability/index.js'
import { loginWithBrowser } from '../../../src/core/remote/oidc_login.js'
import {
  readCredentials,
  writeSession,
} from '../../../src/core/remote/credentials.js'
import { querySqlVerb } from '../../../src/core/query/verb.js'
import { verbToCommand } from '../../../src/core/cli/verb_command.js'

/**
 * @import { AddressInfo } from 'node:net'
 * @import { IncomingMessage } from 'node:http'
 */

/**
 * Hermetic smoke for the multi-tenant OIDC client login (LLP 0046-0048). One
 * in-process server plays both roles against a single origin:
 *
 *  - the identity surface `<origin>/v1/identity/{login/start,token}` (signs
 *    real per-call tokens), and
 *  - the MCP endpoint `<origin>/mcp` (accepts only the current access JWT).
 *
 * The flow drives the full chunk-2 path in a temp HYP_HOME:
 *
 *   browser login (scripted opener -> loopback redirect) -> session stored as
 *   kind: 'oidc' -> query attaches the access JWT -> a forced expiry drives a
 *   silent refresh + persist -> a revoked refresh row drives the re-login
 *   message.
 *
 * Asserts both the user-visible result and the `smoke_step` telemetry the
 * remote-oidc modules emit (Log-Driven Development).
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0046#d5 [tests]: silent refresh + re-login on the attach path, end to end against a stub identity server
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('remote_oidc_login: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')
  }

  const server = await startStubServer()
  const origin = `http://127.0.0.1:${server.port}`
  const mcpUrl = `${origin}/mcp`
  const identityBase = `${origin}/v1/identity`
  const stateDir = harness.stateDir

  try {
    // ----- smoke_step: browser_login -----
    // A scripted opener: instead of launching a browser, GET the start URL.
    // The stub 302s to the loopback redirect_uri with a code, which the real
    // loopback receiver catches.
    const openBrowser = (/** @type {string} */ url) => {
      fetch(url).catch(() => {})
      return true
    }
    const session = await loginWithBrowser({ identityBase, org: 'acme', openBrowser })
    await writeSession(stateDir, 'prod', session)

    const afterLogin = await readCredentials(stateDir)
    expect.that('login: session stored as kind oidc', afterLogin.prod?.kind, (v) => v === 'oidc')
    expect.that('login: resolved org is acme', session.org, (v) => v === 'acme')
    expect.that('login: a refresh token was issued', session.refreshToken, (v) => typeof v === 'string' && v.length > 0)

    // ----- smoke_step: attach_query -----
    const cmd = verbToCommand(querySqlVerb)
    const first = runQuery(mcpUrl)
    let code = await cmd.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], first.ctx)
    expect.that('attach: query exits 0 with the access JWT', code, (v) => v === 0)
    expect.that('attach: rows returned', first.out.join(''), (s) => s.includes('"n": 1') || s.includes('"n":1'))
    expect.that('attach: no refresh needed on a fresh session', server.state.refreshCalls, (v) => v === 0)

    // ----- smoke_step: silent_refresh -----
    // Force the stored access JWT to look expired; the next query must refresh.
    await forceExpiry(stateDir, 'prod')
    const second = runQuery(mcpUrl)
    code = await cmd.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], second.ctx)
    expect.that('refresh: query still exits 0 after silent refresh', code, (v) => v === 0)
    expect.that('refresh: exactly one refresh happened', server.state.refreshCalls, (v) => v === 1)
    const afterRefresh = await readCredentials(stateDir)
    expect.that('refresh: a new access JWT was persisted', afterRefresh.prod?.kind === 'oidc' && /** @type {any} */ (afterRefresh.prod).accessJwt !== /** @type {any} */ (afterLogin.prod).accessJwt, (v) => v === true)

    // ----- smoke_step: revoked_refresh -----
    // Revoke the refresh row and force expiry again: the attach path must
    // surface the re-login guidance, not a generic error.
    server.state.refreshRevoked = true
    await forceExpiry(stateDir, 'prod')
    const third = runQuery(mcpUrl)
    code = await cmd.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], third.ctx)
    expect.that('revoked: query exits nonzero', code, (v) => v !== 0)
    expect.that('revoked: re-login guidance surfaced', third.err.join(''), (s) => /re-run 'hyp remote login prod'/.test(s))
  } finally {
    // Force-close keep-alive sockets so close() does not wait on idle timeouts,
    // then flush telemetry even if an assertion above threw.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    await obs.shutdown()
  }

  // ----- telemetry: the remote-oidc path emitted its smoke_step markers -----
  const logs = await expect.logs()
  const oidcLogs = logs.filter((l) => l.attributes?.hyp_component === 'remote-oidc')
  expect.that('telemetry: remote-oidc logs were emitted', oidcLogs, (rows) => rows.length > 0)
  const steps = new Set(oidcLogs.map((l) => l.attributes?.smoke_step).filter(Boolean))
  expect.that('telemetry: login_complete step present', steps.has('login_complete'), (v) => v === true)
  expect.that('telemetry: loopback_bind step present', steps.has('loopback_bind'), (v) => v === true)
}

/**
 * Build a ctx for the query verb against `mcpUrl`, with captured streams and a
 * configured `prod` target. The credential resolves from HYP_HOME's state dir.
 *
 * @param {string} mcpUrl
 */
function runQuery(mcpUrl) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: process.env.HYP_HOME },
    config: { version: 2, query: { remotes: { prod: { url: mcpUrl } } } },
    query: {}, storage: {},
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

/**
 * Rewrite a target's stored OIDC record so its access JWT reads as expired,
 * forcing the next resolve to refresh.
 *
 * @param {string} stateDir
 * @param {string} target
 */
async function forceExpiry(stateDir, target) {
  const creds = await readCredentials(stateDir)
  const rec = /** @type {any} */ (creds[target])
  // Write through writeSession (not a raw fs.writeFile) so the credential
  // module's parse cache is invalidated. A raw same-size rewrite landing within
  // one mtime tick would be hidden behind that cache, and the next resolve would
  // read the pre-expiry record, skip the refresh, and flake this smoke.
  await writeSession(stateDir, target, {
    refreshToken: rec.refreshToken,
    accessJwt: rec.accessJwt,
    expiresAt: '2000-01-01T00:00:00Z',
    org: rec.org,
  })
}

/**
 * Start the combined identity + MCP stub server. Signs a fresh access JWT on
 * each grant; the MCP side accepts only the latest one.
 *
 * @returns {Promise<{ port: number, state: any, close: (cb: () => void) => void, closeAllConnections: () => void }>}
 */
function startStubServer() {
  const state = { jwtSeq: 0, validJwt: '', refreshToken: 'rt-smoke', refreshRevoked: false, refreshCalls: 0 }
  const mint = () => {
    state.jwtSeq += 1
    state.validJwt = `jwt-${state.jwtSeq}`
    return state.validJwt
  }
  const FUTURE = '2999-01-01T00:00:00Z'

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (/** @type {any} */ obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }

    // Identity: browser start -> 302 to the loopback redirect with a code.
    if (req.method === 'GET' && url.pathname === '/v1/identity/login/start') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const stateParam = url.searchParams.get('state') ?? ''
      const loc = `${redirectUri}?code=auth-code&state=${encodeURIComponent(stateParam)}`
      res.writeHead(302, { location: loc })
      res.end()
      return
    }

    // Identity: token endpoint (authorization_code + refresh_token grants).
    if (req.method === 'POST' && url.pathname === '/v1/identity/token') {
      readBody(req).then((body) => {
        const grant = body.grant_type
        if (grant === 'authorization_code') {
          return json({ session_id: 'sess-1', refresh_token: state.refreshToken, access_jwt: mint(), expires_at: FUTURE, org: 'acme' })
        }
        if (grant === 'refresh_token') {
          state.refreshCalls += 1
          if (state.refreshRevoked) return json({ error: 'invalid_grant' }, 401)
          return json({ access_jwt: mint(), expires_at: FUTURE, org: 'acme' })
        }
        return json({ error: 'unsupported_grant_type' }, 400)
      })
      return
    }

    // MCP: accept only the current access JWT.
    if (req.method === 'POST' && url.pathname === '/mcp') {
      readBody(req).then((rpc) => {
        if (rpc.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mcp-1' })
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18' } }))
        }
        if (rpc.method === 'notifications/initialized') {
          res.writeHead(202)
          return res.end()
        }
        if (rpc.method === 'tools/call') {
          const auth = req.headers['authorization']
          if (auth !== `Bearer ${state.validJwt}`) return json({ jsonrpc: '2.0', id: rpc.id }, 401)
          return json({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { columns: ['n'], rows: [{ n: 1 }] }, isError: false } })
        }
        return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'no' } })
      })
      return
    }

    json({ error: 'not_found' }, 404)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {AddressInfo} */ (server.address())
      resolve({
        port: addr.port,
        state,
        close: (/** @type {() => void} */ cb) => server.close(cb),
        closeAllConnections: () => server.closeAllConnections?.(),
      })
    })
  })
}

/**
 * @param {IncomingMessage} req
 * @returns {Promise<any>}
 */
function readBody(req) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */ const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch {
        resolve({})
      }
    })
  })
}
