// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { runMcpProxy } from '../../src/core/mcp/proxy.js'
import { writeSession, readCredentials } from '../../src/core/remote/credentials.js'

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
