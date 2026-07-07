// @ts-check

/**
 * @import { TestContext } from 'node:test'
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { querySqlVerb } from '../../src/core/query/verb.js'
import { verbToCommand } from '../../src/core/cli/verb_command.js'
import { runMcpProxy } from '../../src/core/mcp/proxy.js'
import { deriveMcpEndpoint, writeToken } from '../../src/core/remote/credentials.js'

const cmd = verbToCommand(querySqlVerb)

/**
 * Install a fetch stub that answers the MCP JSON-RPC handshake + a tool call and
 * records every POST URL, so a test can assert *where* the MCP call landed. A
 * static token means there is never an identity `/token` call, so every request
 * here is an MCP POST and routing by method alone is safe. The tool call
 * succeeds regardless of the URL path, so the only thing a wrong endpoint
 * changes is the recorded URL (not whether the call errors) - the assertion
 * isolates the derivation, not incidental failure.
 *
 * @param {TestContext} t
 * @returns {{ urls: string[] }}
 */
function stubMcp(t) {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  /** @type {string[]} */
  const urls = []
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    urls.push(String(url))
    const reply = (/** @type {any} */ obj, status = 200, ct = 'application/json') => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (/** @type {string} */ k) => k.toLowerCase() === 'content-type' ? ct : (k.toLowerCase() === 'mcp-session-id' ? 'sess-1' : null) },
      text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
    })
    const req = JSON.parse(init.body)
    if (req.method === 'initialize') return reply({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } })
    if (req.method === 'notifications/initialized') return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' }
    if (req.method === 'tools/call') return reply({ jsonrpc: '2.0', id: req.id, result: { structuredContent: { columns: ['n'], rows: [{ n: 7 }] }, isError: false } })
    return reply({ jsonrpc: '2.0', id: req.id, result: { ok: true } })
  })
  return { urls }
}

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-mcp-endpoint-'))
}

/**
 * @param {string} hypHome
 * @param {string} url the registered target URL
 */
function verbCtx(hypHome, url) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome },
    config: { version: 2, query: { remotes: { prod: { url } } } },
    query: {}, storage: {},
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

/**
 * The tools/call POST URL recorded by the stub, i.e. where the actual remote
 * verb landed (not the handshake origin, which is the same URL here anyway).
 *
 * @param {string[]} urls
 * @returns {string}
 */
function lastMcpUrl(urls) {
  return urls[urls.length - 1]
}

test('deriveMcpEndpoint: derive-from-base and back-compat forms', () => {
  // A base URL gets /v1/mcp appended.
  assert.equal(deriveMcpEndpoint('https://hypaware.hyperparam.app'), 'https://hypaware.hyperparam.app/v1/mcp')
  // A trailing slash on the base is normalized (no double slash).
  assert.equal(deriveMcpEndpoint('https://hypaware.hyperparam.app/'), 'https://hypaware.hyperparam.app/v1/mcp')
  // A base with a port.
  assert.equal(deriveMcpEndpoint('https://host:8740'), 'https://host:8740/v1/mcp')
  // A base carrying a path prefix keeps the prefix.
  assert.equal(deriveMcpEndpoint('https://host/hypaware'), 'https://host/hypaware/v1/mcp')
  assert.equal(deriveMcpEndpoint('https://host/hypaware/'), 'https://host/hypaware/v1/mcp')
  // A full /v1/mcp URL (the originally-documented form) is used verbatim.
  assert.equal(deriveMcpEndpoint('https://host:8740/v1/mcp'), 'https://host:8740/v1/mcp')
  // ...including a full URL behind a path prefix.
  assert.equal(deriveMcpEndpoint('https://host/hypaware/v1/mcp'), 'https://host/hypaware/v1/mcp')
  // A trailing slash on the full form is normalized, not double-suffixed.
  assert.equal(deriveMcpEndpoint('https://host:8740/v1/mcp/'), 'https://host:8740/v1/mcp')
  // An unparseable URL is returned unchanged (never masks a bad URL).
  assert.equal(deriveMcpEndpoint('not a url'), 'not a url')
})

test('a base-URL target sends the verb MCP call to <base>/v1/mcp', async (t) => {
  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  await writeToken(stateDir, 'prod', 'tok')
  const { urls } = stubMcp(t)

  const { ctx, out } = verbCtx(hypHome, 'https://hyp.internal')
  const code = await cmd.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], ctx)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out.join('')), [{ n: 7 }])
  // The registered base must be suffixed, not POSTed verbatim (the 404 bug).
  assert.equal(lastMcpUrl(urls), 'https://hyp.internal/v1/mcp')
})

test('a base-URL target with a trailing slash still lands on <base>/v1/mcp', async (t) => {
  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  await writeToken(stateDir, 'prod', 'tok')
  const { urls } = stubMcp(t)

  const { ctx, out } = verbCtx(hypHome, 'https://hyp.internal/')
  const code = await cmd.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], ctx)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out.join('')), [{ n: 7 }])
  assert.equal(lastMcpUrl(urls), 'https://hyp.internal/v1/mcp')
})

test('a URL that already ends in /v1/mcp is used verbatim (back-compat)', async (t) => {
  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  await writeToken(stateDir, 'prod', 'tok')
  const { urls } = stubMcp(t)

  const { ctx, out } = verbCtx(hypHome, 'https://hyp.internal:8740/v1/mcp')
  const code = await cmd.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], ctx)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out.join('')), [{ n: 7 }])
  // Not double-suffixed to /v1/mcp/v1/mcp.
  assert.equal(lastMcpUrl(urls), 'https://hyp.internal:8740/v1/mcp')
})

test('the stdio proxy forwards a base-URL target to <base>/v1/mcp', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')
  await writeToken(stateDir, 'prod', 'tok')

  /** @type {string[]} */
  const urls = []
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    urls.push(String(url))
    const body = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      headers: { get: (/** @type {string} */ k) => k.toLowerCase() === 'content-type' ? 'application/json' : null },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } }),
    }
  })

  /** @type {string[]} */ const out = []
  const stdin = Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }) + '\n'])
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome },
    config: { version: 2, query: { remotes: { prod: { url: 'https://hyp.internal' } } } },
    stdin,
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: () => {} },
  })
  const code = await runMcpProxy({ target: 'prod', ctx })
  assert.equal(code, 0)
  assert.equal(urls[urls.length - 1], 'https://hyp.internal/v1/mcp')
})
