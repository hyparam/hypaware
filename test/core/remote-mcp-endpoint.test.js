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

import { graphNeighborsVerb } from '../../hypaware-core/plugins-workspace/context-graph/src/verb.js'
import { querySqlVerb } from '../../src/core/query/verb.js'
import { verbToCommand } from '../../src/core/cli/verb_command.js'
import { runMcp } from '../../src/core/commands/mcp.js'
import { runMcpProxy } from '../../src/core/mcp/proxy.js'
import { deriveMcpEndpoint, writeSession, writeToken } from '../../src/core/remote/credentials.js'

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


test('operator org selector reaches every remote SQL request on the URL', async (t) => {
  const hypHome = await tmpHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await writeToken(path.join(hypHome, 'hypaware'), 'prod', 'tok')
  const { urls } = stubMcp(t)
  const { ctx } = verbCtx(hypHome, 'https://hyp.internal/prefix?existing=1')
  assert.equal(await cmd.run(['--remote', 'prod', '--org', '*', 'SELECT 1'], ctx), 0)
  assert.ok(urls.length > 1)
  assert.ok(urls.every((url) => url === 'https://hyp.internal/prefix/v1/mcp?existing=1&org=*'))
  assert.equal(deriveMcpEndpoint('https://host/v1/mcp?org=old', 'acme.test'), 'https://host/v1/mcp?org=acme.test')
})

test('org selector requires remote and a value before executing a verb', async () => {
  const { ctx, err } = verbCtx('/unused', 'https://hyp.internal')
  assert.equal(await cmd.run(['SELECT 1', '--org', '*'], ctx), 2)
  assert.match(err.join(''), /--org requires --remote/)
  assert.equal(await cmd.run(['SELECT 1', '--remote', 'prod', '--org'], ctx), 2)
  assert.match(err.join(''), /--org expects/)
  assert.equal(await runMcp(['--org', '*'], ctx), 2)
})

test('MCP proxy parses org and preserves it on forwarded requests', async (t) => {
  const hypHome = await tmpHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await writeToken(path.join(hypHome, 'hypaware'), 'prod', 'tok')
  const { urls } = stubMcp(t)
  const { ctx } = verbCtx(hypHome, 'https://hyp.internal')
  ctx.stdin = Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'])
  assert.equal(await runMcp(['--remote', 'prod', '--org=acme.test'], ctx), 0)
  assert.deepEqual(urls, ['https://hyp.internal/v1/mcp?org=acme.test'])
})


test('graph neighbors carries the operator selector as a transport flag', async (t) => {
  const hypHome = await tmpHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await writeToken(path.join(hypHome, 'hypaware'), 'prod', 'tok')
  const { urls } = stubMcp(t)
  const { ctx } = verbCtx(hypHome, 'https://hyp.internal')
  const graph = verbToCommand({ ...graphNeighborsVerb, render: () => ({ stdout: 'graph' }) })
  assert.equal(await graph.run(['seed-node', '--remote', 'prod', '--org=*'], ctx), 0)
  assert.ok(urls.every((url) => url === 'https://hyp.internal/v1/mcp?org=*'))
})

test('adding the org selector leaves the target\'s own query parameters byte-identical', () => {
  // URL.searchParams.set re-serializes the whole query as form encoding, so a
  // registered `%20`/`~`/valueless param would change shape the moment an
  // operator passed --org. Everything but the appended selector must be untouched.
  const registered = 'https://host/base?a=x%20y&b=~z&flag'
  assert.equal(deriveMcpEndpoint(registered), 'https://host/base/v1/mcp?a=x%20y&b=~z&flag')
  assert.equal(deriveMcpEndpoint(registered, '*'), 'https://host/base/v1/mcp?a=x%20y&b=~z&flag&org=*')
  // A base with no query of its own carries the selector alone.
  assert.equal(deriveMcpEndpoint('https://host', 'acme.test'), 'https://host/v1/mcp?org=acme.test')
})

test('a 403 on an --org read is terminal: no refresh, no re-send, no re-login advice', async (t) => {
  const hypHome = await tmpHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  // A refreshable oidc session: pre-fix, its 403 forced a token refresh and a
  // second (audited) send of the read the server had already denied.
  await writeSession(path.join(hypHome, 'hypaware'), 'prod', {
    refreshToken: 'rt',
    accessJwt: 'jwt',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    org: 'acme',
  })
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  /** @type {string[]} */
  const posts = []
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => {
    posts.push(String(url))
    return { ok: false, status: 403, headers: { get: () => null }, text: async () => 'forbidden' }
  })

  const { ctx, err } = verbCtx(hypHome, 'https://hyp.internal')
  assert.equal(await cmd.run(['SELECT 1', '--remote', 'prod', '--org', 'other.test'], ctx), 1)
  // Exactly one send, and no identity /token call to refresh a live credential.
  assert.deepEqual(posts, ['https://hyp.internal/v1/mcp?org=other.test'])
  assert.match(err.join(''), /refused the read for --org 'other\.test'/)
  assert.doesNotMatch(err.join(''), /session has expired|remote login/)
})

test('the stdio proxy reports a 403 on an --org read as a refused org read', async (t) => {
  const hypHome = await tmpHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await writeSession(path.join(hypHome, 'hypaware'), 'prod', {
    refreshToken: 'rt',
    accessJwt: 'jwt',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    org: 'acme',
  })
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  /** @type {string[]} */
  const posts = []
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => {
    posts.push(String(url))
    return { ok: false, status: 403, headers: { get: () => null }, text: async () => 'forbidden' }
  })

  const { ctx, out } = verbCtx(hypHome, 'https://hyp.internal')
  ctx.stdin = Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'])
  assert.equal(await runMcpProxy({ target: 'prod', org: '*', ctx }), 0)
  assert.deepEqual(posts, ['https://hyp.internal/v1/mcp?org=*'])
  assert.match(JSON.parse(out.join('')).error.message, /refused the read for --org '\*'/)
})

test('the stdio proxy resolves the built-in target the verb path already accepts', async (t) => {
  const hypHome = await tmpHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await writeToken(path.join(hypHome, 'hypaware'), 'hyperparam', 'tok')
  const { urls } = stubMcp(t)
  const { ctx } = verbCtx(hypHome, 'https://hyp.internal')
  ctx.stdin = Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'])
  assert.equal(await runMcp(['--remote', 'hyperparam', '--org', '*'], ctx), 0)
  assert.deepEqual(urls, ['https://hypaware.hyperparam.app/v1/mcp?org=*'])
})

test('an empty org value is named as such even with no --remote', async () => {
  const { ctx, err } = verbCtx('/unused', 'https://hyp.internal')
  assert.equal(await runMcp(['--org='], ctx), 2)
  assert.match(err.join(''), /--org expects an org label or \*/)
})

test('a non-object rejection on an --org read is reported, not replaced by a TypeError', async (t) => {
  const hypHome = await tmpHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await writeToken(path.join(hypHome, 'hypaware'), 'prod', 'tok')
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  // A rejection that is not an object: the org-403 check reads `.status` off it
  // before isAuthError's own guard runs, so an unguarded read would throw from
  // inside the catch block and bury the real failure.
  globalThis.fetch = /** @type {any} */ (async () => { throw undefined })

  const { ctx, err } = verbCtx(hypHome, 'https://hyp.internal')
  assert.equal(await cmd.run(['SELECT 1', '--remote', 'prod', '--org', '*'], ctx), 1)
  assert.doesNotMatch(err.join(''), /Cannot read properties/)
})
