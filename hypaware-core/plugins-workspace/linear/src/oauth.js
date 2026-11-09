// @ts-check

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { createPkcePair } from '../../../../src/core/remote/pkce.js'
import { isLoopbackRedirect } from './config.js'
import { linearError, linearJson, linearGraphql } from './http.js'

/** @import { LinearIdentity, LinearTokens, LoginOptions, RequestOptions } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */

/** @param {string} token @param {RequestOptions} [opts] @returns {Promise<LinearIdentity>} */
export async function linearIdentity(token, opts = {}) {
  const data = await linearGraphql(token, 'query HypAwareIdentity { viewer { id } organization { id urlKey } }', {}, opts)
  if (!uuid(data.viewer?.id) || !uuid(data.organization?.id) || typeof data.organization?.urlKey !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(data.organization.urlKey)) {
    throw linearError('identity', 'could not verify the signed-in workspace')
  }
  return { user_id: data.viewer.id, workspace_id: data.organization.id, workspace: data.organization.urlKey }
}

/** @param {unknown} value @returns {value is string} */
export function uuid(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
}

/** @param {Record<string, string>} fields @param {RequestOptions} opts @returns {Promise<LinearTokens>} */
async function tokens(fields, opts) {
  const data = await linearJson('https://api.linear.app/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
  }, opts)
  const validToken = t => typeof t === 'string' && t.length > 0 && t.length <= 4096 && !/\s/.test(t)
  const scopes = typeof data.scope === 'string' ? data.scope.split(/[ ,]+/) : data.scope
  if (data.error || !validToken(data.access_token) || !validToken(data.refresh_token) ||
      String(data.token_type).toLowerCase() !== 'bearer' || !Array.isArray(scopes) || !scopes.includes('read') ||
      !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 366 * 86400) {
    throw linearError('oauth', 'OAuth authorization expired, was refused or returned an invalid grant; run `hyp linear login` again')
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: (opts.now ?? Date.now)() + data.expires_in * 1000 }
}

/** @param {string} refreshToken @param {string} clientId @param {RequestOptions} [opts] */
export function refreshLinearToken(refreshToken, clientId, opts = {}) {
  return tokens({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken }, opts)
}

/** @param {LoginOptions} opts */
// @ref LLP 0592#authentication [implements]: read-only public-client PKCE with a bounded loopback listener and state-bound callback
export async function browserLogin(opts) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(opts.clientId) || /^lin_/i.test(opts.clientId)) {
    throw linearError('client_id', 'set linear.client_id or LINEAR_CLIENT_ID to the public ID of a registered Linear OAuth app')
  }
  if (!isLoopbackRedirect(opts.redirectUri)) throw linearError('callback', 'invalid loopback redirect URI')
  const redirect = new URL(opts.redirectUri)
  const attempt = createPkcePair()
  const state = randomBytes(32).toString('hex')
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 5 * 60000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  signal.throwIfAborted()
  /** @type {(code: string) => void} */
  let accept
  /** @type {(error: Error) => void} */
  let reject
  /** @type {Promise<string>} */
  const received = new Promise((resolve, fail) => {
    accept = resolve
    reject = fail
  })
  // The callback can fail while onUrl is still opening the browser.
  received.catch(() => {})
  let consumed = false
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    let url
    try { url = new URL(req.url ?? '/', redirect.origin) }
    catch {
      res.writeHead(400).end('Invalid callback')
      return
    }
    if (req.method !== 'GET' || url.pathname !== redirect.pathname || req.headers.host !== redirect.host || consumed) {
      res.writeHead(404).end('Not found')
      return
    }
    if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state ||
        url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1) {
      res.writeHead(400).end('Invalid callback. Return to the terminal.')
      return
    }
    if (url.searchParams.has('error')) {
      consumed = true
      res.writeHead(400).end('Authorization declined. Return to the terminal.')
      reject(linearError('denied', 'authorization declined; run `hyp linear login` to try again'))
      return
    }
    const code = url.searchParams.get('code')
    if (!code || code.length > 4096 || /\s/.test(code)) {
      res.writeHead(400).end('Invalid callback')
      return
    }
    consumed = true
    res.end('Authorization received. Return to the terminal to finish sign-in.')
    accept(code)
  })
  server.maxConnections = 8
  const abort = () => reject(linearError(timeout.aborted ? 'login_timeout' : 'cancelled', timeout.aborted ? 'browser sign-in timed out; try again' : 'login cancelled'))
  signal.addEventListener('abort', abort, { once: true })
  try {
    await new Promise((resolve, fail) => {
      server.once('error', () => fail(linearError('callback', 'cannot listen on the registered callback port; close the other login or change redirect_uri')))
      // localhost is a registered name, but the listener is strictly IPv4 loopback.
      server.listen(Number(redirect.port), '127.0.0.1', () => resolve(undefined))
    })
    signal.throwIfAborted()
    const url = new URL('https://linear.app/oauth/authorize')
    for (const [key, value] of Object.entries({ client_id: opts.clientId, redirect_uri: opts.redirectUri,
      response_type: 'code', scope: 'read', state, code_challenge: attempt.challenge, code_challenge_method: 'S256', prompt: 'consent' })) url.searchParams.set(key, value)
    await opts.onUrl(url.href)
    const code = await received
    const grant = await tokens({ grant_type: 'authorization_code', client_id: opts.clientId, redirect_uri: opts.redirectUri,
      code, code_verifier: attempt.verifier }, { ...opts, signal })
    const account = await linearIdentity(`Bearer ${grant.access_token}`, { ...opts, signal })
    return { ...grant, account }
  } finally {
    signal.removeEventListener('abort', abort)
    server.closeAllConnections()
    await new Promise(resolve => server.close(() => resolve(undefined)))
  }
}
