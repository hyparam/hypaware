// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { querySqlVerb } from '../../src/core/query/verb.js'
import { verbToCommand } from '../../src/core/cli/verb_command.js'

const cmd = verbToCommand(querySqlVerb)

/**
 * Install a fake MCP-over-HTTP server as `globalThis.fetch` for the
 * duration of `t`. `toolResult` is what `tools/call` returns.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ token?: string, toolResult?: any }} [opts]
 */
function stubServer(t, opts = {}) {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    const req = JSON.parse(init.body)
    const json = (/** @type {any} */ obj, status = 200, ct = 'application/json') => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (/** @type {string} */ k) => k.toLowerCase() === 'content-type' ? ct : (k.toLowerCase() === 'mcp-session-id' ? 'sess-1' : null) },
      text: async () => JSON.stringify(obj),
    })
    if (req.method === 'initialize') return json({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'srv' } } })
    if (req.method === 'notifications/initialized') return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' }
    if (req.method === 'tools/call') {
      if (opts.token && init.headers.authorization !== `Bearer ${opts.token}`) return json({}, 401)
      return json({ jsonrpc: '2.0', id: req.id, result: opts.toolResult })
    }
    return json({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no' } })
  })
}

/** @param {object} env */
function ctxWith(env) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const ctx = /** @type {any} */ ({
    env,
    config: { version: 2, query: { remotes: { prod: { url: 'https://hyp.internal/mcp' } } } },
    query: {}, storage: {},
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

test('--remote runs the remote tool and renders with the same render path', async (t) => {
  stubServer(t, { token: 'tok', toolResult: {
    content: [{ type: 'text', text: JSON.stringify({ columns: ['n'], rows: [{ n: 5 }] }) }],
    structuredContent: { columns: ['n'], rows: [{ n: 5 }] },
    isError: false,
  } })
  const { ctx, out, err } = ctxWith({ HYP_HOME: '/tmp/none', HYP_REMOTE_TOKEN_PROD: 'tok' })
  const code = await cmd.run(['SELECT count(*)', '--remote', 'prod', '--format', 'json'], ctx)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out.join('')), [{ n: 5 }])
  assert.equal(err.join(''), '')
})

test('server-cap truncation is surfaced as its own stderr line', async (t) => {
  stubServer(t, { token: 'tok', toolResult: {
    structuredContent: { columns: ['n'], rows: [{ n: 1 }], truncated: true, server_cap: { rows: 10000 } },
    isError: false,
  } })
  const { ctx, err } = ctxWith({ HYP_HOME: '/tmp/none', HYP_REMOTE_TOKEN_PROD: 'tok' })
  await cmd.run(['SELECT *', '--remote', 'prod', '--format', 'json'], ctx)
  assert.match(err.join(''), /remote: showing first 1 rows \(server cap rows:10000\)/)
})

test('--remote with --refresh is a hard error (server owns its freshness)', async (t) => {
  stubServer(t, { toolResult: {} })
  const { ctx, err } = ctxWith({ HYP_HOME: '/tmp/none', HYP_REMOTE_TOKEN_PROD: 'tok' })
  const code = await cmd.run(['SELECT 1', '--remote', 'prod', '--refresh', 'always'], ctx)
  assert.equal(code, 2)
  assert.match(err.join(''), /--refresh is a local cache control and cannot be combined with --remote/)
})

test('an unknown remote target is rejected before any network call', async (t) => {
  stubServer(t)
  const { ctx, err } = ctxWith({ HYP_HOME: '/tmp/none' })
  const code = await cmd.run(['SELECT 1', '--remote', 'staging'], ctx)
  assert.equal(code, 2)
  assert.match(err.join(''), /unknown remote target 'staging'/)
})

test('a missing token errors with login guidance', async (t) => {
  stubServer(t)
  const { ctx, err } = ctxWith({ HYP_HOME: '/tmp/none-missing' })
  const code = await cmd.run(['SELECT 1', '--remote', 'prod'], ctx)
  assert.equal(code, 2)
  assert.match(err.join(''), /no token for 'prod' — run 'hyp remote login prod'/)
})

test('a remote isError result maps to a nonzero exit with the message', async (t) => {
  stubServer(t, { token: 'tok', toolResult: { content: [{ type: 'text', text: 'unknown dataset: foo' }], isError: true } })
  const { ctx, err } = ctxWith({ HYP_HOME: '/tmp/none', HYP_REMOTE_TOKEN_PROD: 'tok' })
  const code = await cmd.run(['SELECT * FROM foo', '--remote', 'prod'], ctx)
  assert.equal(code, 1)
  assert.match(err.join(''), /unknown dataset: foo/)
})
