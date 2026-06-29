// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { runMcpProxy } from '../../src/core/mcp/proxy.js'
import { writeSession, readCredentials, remoteCredentialsPath } from '../../src/core/remote/credentials.js'

const MCP_URL = 'https://hyp.internal/mcp'
const TOKEN_URL = 'https://hyp.internal/v1/identity/token'
const FUTURE = '2999-01-01T00:00:00Z'

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-proxy-'))
}

/**
 * @param {any} obj
 * @param {number} status
 */
function reply(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (/** @type {string} */ k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
  }
}

/**
 * Build a ctx whose stdin yields the given JSON-RPC lines then EOFs, with
 * captured stdout/stderr and a configured `prod` target.
 *
 * @param {{ hypHome: string, lines: any[] }} opts
 */
function makeCtx({ hypHome, lines }) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const stdin = Readable.from(lines.map((m) => JSON.stringify(m) + '\n'))
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome },
    config: { version: 2, query: { remotes: { prod: { url: MCP_URL } } } },
    stdin,
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

test('proxy refreshes an oidc session on a live 401 and retries (no longer dies on a stale JWT)', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })

  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  // A non-expired record (so the startup probe does not refresh), but the MCP
  // side rejects the cached JWT: it is the live-401 path that must refresh.
  await writeSession(stateDir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-old', expiresAt: FUTURE, org: 'acme' })

  let refreshCalls = 0
  const validJwt = 'jwt-new'
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    if (url === TOKEN_URL) {
      refreshCalls += 1
      return reply({ access_jwt: validJwt, expires_at: FUTURE, org: 'acme' })
    }
    const body = JSON.parse(init.body)
    if (init.headers.authorization !== `Bearer ${validJwt}`) return reply({ jsonrpc: '2.0', id: body.id }, 401)
    return reply({ jsonrpc: '2.0', id: body.id, result: { ok: true } })
  })

  const { ctx, out } = makeCtx({ hypHome, lines: [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }] })
  const code = await runMcpProxy({ target: 'prod', ctx })

  assert.equal(code, 0)
  assert.equal(refreshCalls, 1)
  assert.match(out.join(''), /"result"/)
  assert.match(out.join(''), /"ok":\s*true/)
  // The refreshed JWT was persisted back to the 0600 store.
  const creds = await readCredentials(stateDir)
  assert.equal(/** @type {any} */ (creds.prod).accessJwt, validJwt)
})

test('a stale JWT at startup refreshes once (lazily on the first message), not twice', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })

  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  // Already-expired cached JWT: a probe that refreshed would do it once, then
  // the first message again. The probe is a presence check now, so exactly one
  // refresh happens.
  await writeSession(stateDir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-old', expiresAt: '2000-01-01T00:00:00Z', org: 'acme' })

  let refreshCalls = 0
  const validJwt = 'jwt-new'
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    if (url === TOKEN_URL) {
      refreshCalls += 1
      return reply({ access_jwt: validJwt, expires_at: FUTURE, org: 'acme' })
    }
    const body = JSON.parse(init.body)
    if (init.headers.authorization !== `Bearer ${validJwt}`) return reply({ jsonrpc: '2.0', id: body.id }, 401)
    return reply({ jsonrpc: '2.0', id: body.id, result: { ok: true } })
  })

  const { ctx, out } = makeCtx({ hypHome, lines: [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }] })
  const code = await runMcpProxy({ target: 'prod', ctx })

  assert.equal(code, 0)
  assert.equal(refreshCalls, 1)
  assert.match(out.join(''), /"ok":\s*true/)
})

test('proxy surfaces a failed forced refresh instead of a bare HTTP 401', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })

  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  // Fresh JWT (probe + first resolve succeed), but the MCP side rejects it and,
  // as a side effect, the stored record vanishes (e.g. a concurrent logout), so
  // the forced refresh returns ok:false rather than throwing.
  await writeSession(stateDir, 'prod', { refreshToken: 'rt', accessJwt: 'jwt-fresh', expiresAt: FUTURE, org: 'acme' })

  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    if (url === MCP_URL) {
      await fs.rm(remoteCredentialsPath(stateDir), { force: true })
      const body = JSON.parse(init.body)
      return reply({ jsonrpc: '2.0', id: body.id }, 401)
    }
    return reply({}, 500)
  })

  const { ctx, out } = makeCtx({ hypHome, lines: [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }] })
  const code = await runMcpProxy({ target: 'prod', ctx })
  assert.equal(code, 0)
  // The refresh failure reason rides back, not a generic "remote returned HTTP 401".
  assert.match(out.join(''), /no token for 'prod'/)
  assert.doesNotMatch(out.join(''), /remote returned HTTP 401/)
})

test('proxy surfaces re-login guidance when the refresh is rejected (invalid_grant)', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })

  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  await writeSession(stateDir, 'prod', { refreshToken: 'stale', accessJwt: 'jwt-old', expiresAt: FUTURE, org: 'acme' })

  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    if (url === TOKEN_URL) return reply({ error: 'invalid_grant' }, 401)
    const body = JSON.parse(init.body)
    return reply({ jsonrpc: '2.0', id: body.id }, 401) // always reject the cached JWT
  })

  const { ctx, out } = makeCtx({ hypHome, lines: [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }] })
  const code = await runMcpProxy({ target: 'prod', ctx })

  assert.equal(code, 0) // the proxy stays up; the error rides back as a JSON-RPC error
  assert.match(out.join(''), /re-run 'hyp remote login prod'/)
})
