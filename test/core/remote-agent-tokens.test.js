// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runRemoteMint, runRemoteTokens, runRemoteTokensRevoke } from '../../src/core/cli/remote_commands.js'
import { writeSession, writeToken } from '../../src/core/remote/credentials.js'

const FUTURE = '2999-01-01T00:00:00Z'
const ENDPOINT = 'https://hyp.internal/v1/org/tokens/mine'

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agent-tok-'))
}

/**
 * A ctx with captured streams and the targets written to a real config file
 * (the remote family resolves targets from the file).
 *
 * @param {{ hypHome: string, remotes?: any, defaultRemote?: string }} opts
 */
async function makeCtx({ hypHome, remotes, defaultRemote }) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const configPath = path.join(hypHome, 'config.json')
  const query = { remotes: remotes ?? { prod: { url: 'https://hyp.internal' } }, ...(defaultRemote ? { default_remote: defaultRemote } : {}) }
  const config = { version: 2, query }
  await fs.writeFile(configPath, JSON.stringify(config))
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome, HYP_CONFIG: configPath },
    config,
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

/** @param {string} hypHome */
function stateDirOf(hypHome) {
  return path.join(hypHome, 'hypaware')
}

/** Seed a fresh (non-expiring) session so no refresh runs. @param {string} hypHome */
async function seedSession(hypHome) {
  await writeSession(stateDirOf(hypHome), 'prod', { refreshToken: 'rt', accessJwt: 'jwt-1', expiresAt: FUTURE, org: 'acme' })
}

/**
 * Every file under `dir` with its size, mode, mtime and content hash, so a
 * write anywhere in the tree (a new file, a rewrite, a chmod) shows.
 *
 * @param {string} dir
 * @returns {Promise<Record<string, string>>}
 */
async function snapshot(dir) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const rel of await fs.readdir(dir, { recursive: true })) {
    const abs = path.join(dir, rel)
    const st = await fs.stat(abs)
    const hash = st.isFile() ? crypto.createHash('sha256').update(await fs.readFile(abs)).digest('hex') : 'dir'
    out[rel] = `${st.size} ${st.mode} ${st.mtimeMs} ${hash}`
  }
  return out
}

/**
 * A fetch stub that records requests and replies from a script of responses.
 * @param {Array<{ status: number, body?: any, headers?: Record<string, string> }>} script
 */
function fetchStub(script) {
  /** @type {Array<{ url: string, init: any }>} */
  const calls = []
  const impl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), init })
    const step = script[Math.min(calls.length - 1, script.length - 1)]
    const text = step.body === undefined ? '' : JSON.stringify(step.body)
    const headers = step.headers ?? {}
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: (/** @type {string} */ k) => headers[k.toLowerCase()] ?? null },
      text: async () => text,
    }
  }))
  return { impl, calls }
}

const MINTED = { token: 'agent-tok-1', jti: 'rt-0123456789abcdef', scope: 'read report-publish', label: 'nightly', expires_at: 1798761600, org: 'acme', ttl_seconds: 1814400 }

test('mint --scope query posts {} to the API base with the session bearer and prints the token alone', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const before = await snapshot(hypHome)
  const { impl, calls } = fetchStub([{ status: 201, body: MINTED }])
  const code = await runRemoteMint(['prod', '--scope', 'query'], ctx, { fetchImpl: impl })
  assert.equal(code, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, ENDPOINT)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer jwt-1')
  // No lifetime asked, none sent: the server's default applies, not the
  // enrollment mint's 365 days.
  assert.deepEqual(JSON.parse(calls[0].init.body), {})
  assert.equal(out.join(''), 'agent-tok-1\n')
  const text = err.join('')
  assert.match(text, /minted agent token for hyp\.internal \('prod'\) \(jti rt-0123456789abcdef, label nightly, expires 2027-01-01T00:00:00.000Z\)/)
  assert.match(text, /reads the org's recorded history/)
  assert.match(text, /mark recommendations/)
  assert.match(text, /publish reports/)
  assert.match(text, /delete reports/)
  assert.match(text, /until it expires or is revoked with 'hyp remote tokens revoke rt-0123456789abcdef --remote prod'/)
  assert.match(text, /hyp mcp serve --remote prod/)
  assert.doesNotMatch(text, /agent-tok-1/)
  // Nothing kept client-side: no token, no jti, no rewrite of the session.
  assert.deepEqual(await snapshot(hypHome), before)
})

test('mint --scope query sends ttl_seconds and label only when given', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl, calls } = fetchStub([{ status: 201, body: MINTED }])
  assert.equal(await runRemoteMint(['prod', '--scope', 'query', '--expires-days', '30'], ctx, { fetchImpl: impl }), 0)
  assert.equal(await runRemoteMint(['prod', '--scope', 'query', '--label', 'nightly'], ctx, { fetchImpl: impl }), 0)
  assert.equal(await runRemoteMint(['prod', '--scope=query', '--label=ci one', '--expires-days=7'], ctx, { fetchImpl: impl }), 0)
  assert.deepEqual(calls.map((c) => JSON.parse(c.init.body)), [
    { ttl_seconds: 30 * 86400 },
    { label: 'nightly' },
    { ttl_seconds: 7 * 86400, label: 'ci one' },
  ])
})

test('mint --scope query leaves its ceiling to the server, even past the enrollment 3650', async () => {
  // The agent ceiling is per deployment with no upper bound, so the enrollment
  // branch's 3650-day check must not refuse a value that server accepts.
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl, calls } = fetchStub([{ status: 201, body: MINTED }])
  assert.equal(await runRemoteMint(['prod', '--scope', 'query', '--expires-days', '4000'], ctx, { fetchImpl: impl }), 0)
  assert.deepEqual(JSON.parse(calls[0].init.body), { ttl_seconds: 4000 * 86400 })
})

test('a bare mint still sends the enrollment default of 365 days', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl, calls } = fetchStub([{ status: 200, body: { token: 'ci-tok' } }])
  assert.equal(await runRemoteMint(['prod'], ctx, { fetchImpl: impl }), 0)
  assert.equal(calls[0].url, 'https://hyp.internal/v1/identity/mint')
  assert.deepEqual(JSON.parse(calls[0].init.body), { expires_days: 365 })
})

test('an unknown --scope exits 2 at the gate without a request', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl, calls } = fetchStub([{ status: 201, body: MINTED }])
  for (const bad of ['admin', 'read', 'report-publish', '']) {
    assert.equal(await runRemoteMint(['prod', '--scope', bad], ctx, { fetchImpl: impl }), 2, bad)
  }
  assert.equal(calls.length, 0)
  assert.match(err.join(''), /usage: hyp remote mint/)
})

test('a /v1/mcp target mints against its API base, and the default target drops --remote', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome, remotes: { prod: { url: 'https://hyp.internal/base/v1/mcp/' } }, defaultRemote: 'prod' })
  await seedSession(hypHome)
  const { impl, calls } = fetchStub([{ status: 201, body: MINTED }])
  assert.equal(await runRemoteMint(['--scope', 'query'], ctx, { fetchImpl: impl }), 0)
  assert.equal(calls[0].url, 'https://hyp.internal/base/v1/org/tokens/mine')
  assert.match(err.join(''), /revoked with 'hyp remote tokens revoke rt-0123456789abcdef'\n/)
})

test('a 401 is retried once after a forced refresh, then names sign-in', async () => {
  const hypHome = await tmpHome()
  const { ctx, err, out } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  /** @type {Array<{ url: string, auth?: string }>} */ const seen = []
  const impl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    seen.push({ url: String(url), auth: init.headers?.authorization })
    if (String(url).endsWith('/v1/identity/token')) {
      const body = { refresh_token: 'rt-2', access_jwt: 'jwt-2', expires_at: 32503680000, org: 'acme' }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }
    }
    return { ok: false, status: 401, headers: { get: () => null }, text: async () => JSON.stringify({ error: 'unauthorized' }) }
  }))
  const code = await runRemoteMint(['prod', '--scope', 'query'], ctx, { fetchImpl: impl })
  assert.equal(code, 1)
  assert.deepEqual(seen.map((s) => s.url), [ENDPOINT, 'https://hyp.internal/v1/identity/token', ENDPOINT])
  assert.equal(seen[2].auth, 'Bearer jwt-2')
  assert.equal(out.join(''), '')
  assert.match(err.join(''), /sign in again with 'hyp remote login prod'/)
})

test('a 401 on a refreshed retry that succeeds mints normally', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  let mints = 0
  const impl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {any} */ url) => {
    if (String(url).endsWith('/v1/identity/token')) {
      const body = { refresh_token: 'rt-2', access_jwt: 'jwt-2', expires_at: 32503680000, org: 'acme' }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }
    }
    mints++
    if (mints === 1) return { ok: false, status: 401, headers: { get: () => null }, text: async () => '' }
    return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify(MINTED) }
  }))
  assert.equal(await runRemoteMint(['prod', '--scope', 'query'], ctx, { fetchImpl: impl }), 0)
  assert.equal(out.join(''), 'agent-tok-1\n')
})

test('a static token file gets one 401 and a line naming the browser sign-in', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  await writeToken(stateDirOf(hypHome), 'prod', 'rt-static')
  const { impl, calls } = fetchStub([{ status: 401, body: { error: 'unauthorized' } }])
  assert.equal(await runRemoteMint(['prod', '--scope', 'query'], ctx, { fetchImpl: impl }), 1)
  assert.equal(calls.length, 1)
  assert.match(err.join(''), /static token.*need a session.*browser: 'hyp remote login prod'/)
})

/** @type {Array<{ name: string, status: number, body?: any, headers?: Record<string, string>, line: RegExp }>} */
const MINT_REFUSALS = [
  { name: 'browser session', status: 403, body: { error: 'browser_session' }, line: /credential stored for 'prod' is a browser session - run 'hyp remote login prod' from the CLI/ },
  { name: 'read-only session', status: 403, body: { error: 'read_only_session' }, line: /this session cannot mint agent tokens \(it is read-only or an impersonation\)/ },
  {
    name: 'bad label',
    status: 400,
    body: { error: 'invalid_label', detail: 'label must be 1 to 64 letters, digits, spaces, ".", "_" or "-"' },
    line: /the label must be 1 to 64 letters, digits, spaces, '\.', '_' or '-' \(label must be/,
  },
  { name: 'bad ttl', status: 400, body: { error: 'invalid_ttl', detail: 'ttl_seconds must be a positive integer no greater than 7776000' }, line: /hyp remote mint: ttl_seconds must be a positive integer no greater than 7776000\n/ },
  { name: 'ten live', status: 429, body: { error: 'token_limit', detail: 'at most 10 live agent tokens per person' }, line: /ten live agent tokens on hyp\.internal \('prod'\) - list them with 'hyp remote tokens prod' and revoke one/ },
  {
    name: 'retained cap',
    status: 429,
    headers: { 'retry-after': '3600' },
    body: { error: 'token_limit', detail: 'at most 30 unexpired agent tokens per person, revoked included; the earliest expires in 1 hour' },
    line: /at most 30 unexpired agent tokens .* \(retry after 3600s\)/,
  },
  { name: 'old server 404', status: 404, body: { error: 'not_found' }, line: /'prod' does not serve agent tokens yet \(HTTP 404\)/ },
  { name: 'old server member', status: 403, body: { error: 'role_required' }, line: /'prod' does not serve agent tokens yet \(HTTP 403\)/ },
  { name: 'write capacity', status: 429, body: { error: 'org_write_capacity' }, line: /mint failed \(HTTP 429 org_write_capacity\)/ },
  { name: 'server error', status: 500, body: undefined, line: /mint failed \(HTTP 500\)/ },
]

for (const r of MINT_REFUSALS) {
  test(`mint --scope query refusal: ${r.name} maps to its line and exits 1`, async () => {
    const hypHome = await tmpHome()
    const { ctx, out, err } = await makeCtx({ hypHome })
    await seedSession(hypHome)
    const before = await snapshot(hypHome)
    const { impl, calls } = fetchStub([{ status: r.status, body: r.body, headers: r.headers }])
    assert.equal(await runRemoteMint(['prod', '--scope', 'query'], ctx, { fetchImpl: impl }), 1)
    assert.equal(calls.length, 1)
    assert.equal(out.join(''), '')
    assert.match(err.join(''), r.line)
    assert.deepEqual(await snapshot(hypHome), before)
  })
}

test('a 201 without a token is an error, not a blank print', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl } = fetchStub([{ status: 201, body: { jti: 'rt-0123456789abcdef' } }])
  assert.equal(await runRemoteMint(['prod', '--scope', 'query'], ctx, { fetchImpl: impl }), 1)
  assert.equal(out.join(''), '')
  assert.match(err.join(''), /carried no token/)
})

const LIST = {
  tokens: [
    { jti: 'rt-aaaaaaaaaaaaaaaa', scope: 'agent', label: 'nightly', mintedAt: '2026-10-01T00:00:00.000Z', exp: 1798761600, revoked: false, revokedAt: null, token: 'planted-secret' },
    { jti: 'rt-bbbbbbbbbbbbbbbb', scope: 'agent', mintedAt: '2026-10-02T00:00:00.000Z', exp: 1798848000, revoked: true, revokedAt: '2026-10-03T00:00:00.000Z' },
  ],
}

test('tokens lists jti, label, created, expires and revoked, never a value', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const before = await snapshot(hypHome)
  const { impl, calls } = fetchStub([{ status: 200, body: LIST }])
  assert.equal(await runRemoteTokens(['prod'], ctx, { fetchImpl: impl }), 0)
  assert.equal(calls[0].url, ENDPOINT)
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.authorization, 'Bearer jwt-1')
  assert.equal(calls[0].init.body, undefined)
  assert.equal(
    out.join(''),
    'jti\tlabel\tcreated\texpires\trevoked\n' +
      'rt-aaaaaaaaaaaaaaaa\tnightly\t2026-10-01T00:00:00.000Z\t2027-01-01T00:00:00.000Z\tno\n' +
      'rt-bbbbbbbbbbbbbbbb\t-\t2026-10-02T00:00:00.000Z\t2027-01-02T00:00:00.000Z\t2026-10-03T00:00:00.000Z\n',
  )
  assert.deepEqual(await snapshot(hypHome), before)
})

test('tokens --json prints the named fields only', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl } = fetchStub([{ status: 200, body: LIST }])
  assert.equal(await runRemoteTokens(['prod', '--json'], ctx, { fetchImpl: impl }), 0)
  const text = out.join('')
  assert.doesNotMatch(text, /planted-secret/)
  assert.deepEqual(JSON.parse(text), {
    tokens: [
      { jti: 'rt-aaaaaaaaaaaaaaaa', label: 'nightly', mintedAt: '2026-10-01T00:00:00.000Z', exp: 1798761600, revoked: false, revokedAt: null },
      { jti: 'rt-bbbbbbbbbbbbbbbb', mintedAt: '2026-10-02T00:00:00.000Z', exp: 1798848000, revoked: true, revokedAt: '2026-10-03T00:00:00.000Z' },
    ],
    connections: [],
  })
})

/** An unsigned JWT-shaped bearer naming `org`, as the server's access JWT does. @param {string} org */
function jwtFor(org) {
  return `h.${Buffer.from(JSON.stringify({ sub: 'alex', org })).toString('base64url')}.sig`
}

/** Seed a fresh session whose bearer names `org`; the record's own org differs. @param {string} hypHome @param {string} org */
async function seedSessionFor(hypHome, org) {
  await writeSession(stateDirOf(hypHome), 'prod', { refreshToken: 'rt', accessJwt: jwtFor(org), expiresAt: FUTURE, org: 'stored-org' })
}

const CONNECTIONS = [
  {
    id: 'oauth-0123456789abcdef',
    client_name: 'Claude\u001b[31m',
    redirect_host: 'claude.ai',
    scope: 'read',
    created_at: '2026-10-20T00:00:00.000Z',
    last_used_at: null,
    expires_at: '2026-11-19T00:00:00.000Z',
    refresh_token: 'planted-refresh',
  },
  { id: 'oauth-fedcba9876543210', redirect_host: 'chatgpt.com', created_at: '2026-10-21T00:00:00.000Z', expires_at: '2026-11-20T00:00:00.000Z' },
]

test('tokens lists MCP connections with client, the bearer org, created and expires', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  await seedSessionFor(hypHome, 'acme')
  const before = await snapshot(hypHome)
  const { impl, calls } = fetchStub([{ status: 200, body: { tokens: [], connections: CONNECTIONS } }])
  assert.equal(await runRemoteTokens(['prod'], ctx, { fetchImpl: impl }), 0)
  assert.equal(calls.length, 1)
  const text = out.join('')
  assert.equal(
    text,
    "no agent tokens on hyp.internal ('prod') - mint one with 'hyp remote mint prod --scope query'\n" +
      "\nMCP connections on hyp.internal ('prod'):\n" +
      'id\tclient\torg\tcreated\texpires\n' +
      'oauth-0123456789abcdef\tClaude\\u001b[31m\tacme\t2026-10-20T00:00:00.000Z\t2026-11-19T00:00:00.000Z\n' +
      'oauth-fedcba9876543210\tchatgpt.com\tacme\t2026-10-21T00:00:00.000Z\t2026-11-20T00:00:00.000Z\n',
  )
  assert.doesNotMatch(text, /planted-refresh/)
  assert.deepEqual(await snapshot(hypHome), before)
})

test('tokens --json carries the connections beside the tokens', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  await seedSessionFor(hypHome, 'acme')
  const { impl } = fetchStub([{ status: 200, body: { tokens: [], connections: CONNECTIONS } }])
  assert.equal(await runRemoteTokens(['prod', '--json'], ctx, { fetchImpl: impl }), 0)
  const text = out.join('')
  assert.doesNotMatch(text, /planted-refresh/)
  assert.deepEqual(JSON.parse(text), {
    tokens: [],
    connections: [
      { id: 'oauth-0123456789abcdef', client: 'Claude\u001b[31m', org: 'acme', createdAt: '2026-10-20T00:00:00.000Z', expiresAt: '2026-11-19T00:00:00.000Z' },
      { id: 'oauth-fedcba9876543210', client: 'chatgpt.com', org: 'acme', createdAt: '2026-10-21T00:00:00.000Z', expiresAt: '2026-11-20T00:00:00.000Z' },
    ],
  })
})

test('the connection org is the answering bearer, not the stored record or a later file', async () => {
  // The org shown must be the one the server scoped the answer by: the
  // claims of the bearer that got it. A refresh retry and an env override
  // each answer for their own bearer.
  const reply = { tokens: [], connections: [CONNECTIONS[1]] }
  const orgOf = (/** @type {string[]} */ out) => JSON.parse(out.join('')).connections[0].org

  const retried = await tmpHome()
  {
    const { ctx, out } = await makeCtx({ hypHome: retried })
    await seedSessionFor(retried, 'alpha')
    let gets = 0
    const impl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {any} */ url) => {
      if (String(url).endsWith('/v1/identity/token')) {
        const body = { refresh_token: 'rt-2', access_jwt: jwtFor('beta'), expires_at: 32503680000, org: 'beta' }
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }
      }
      gets++
      if (gets === 1) return { ok: false, status: 401, headers: { get: () => null }, text: async () => '' }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(reply) }
    }))
    assert.equal(await runRemoteTokens(['prod', '--json'], ctx, { fetchImpl: impl }), 0)
    assert.equal(orgOf(out), 'beta')
  }

  const overridden = await tmpHome()
  {
    const { ctx, out } = await makeCtx({ hypHome: overridden })
    await seedSessionFor(overridden, 'alpha')
    ctx.env.HYP_REMOTE_TOKEN_PROD = jwtFor('gamma')
    const { impl, calls } = fetchStub([{ status: 200, body: reply }])
    assert.equal(await runRemoteTokens(['prod', '--json'], ctx, { fetchImpl: impl }), 0)
    assert.equal(calls[0].init.headers.authorization, `Bearer ${jwtFor('gamma')}`)
    assert.equal(orgOf(out), 'gamma')
  }

  const opaque = await tmpHome()
  {
    const { ctx, out } = await makeCtx({ hypHome: opaque })
    await seedSession(opaque)
    const { impl } = fetchStub([{ status: 200, body: reply }])
    assert.equal(await runRemoteTokens(['prod'], ctx, { fetchImpl: impl }), 0)
    assert.match(out.join(''), /\noauth-fedcba9876543210\tchatgpt\.com\t-\t/)
  }
})

test('tokens against a server without connections prints the token table alone', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl } = fetchStub([{ status: 200, body: LIST }])
  assert.equal(await runRemoteTokens(['prod'], ctx, { fetchImpl: impl }), 0)
  assert.doesNotMatch(out.join(''), /MCP connections/)
})

test('tokens and revoke with no session name the client-only connection case', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const { impl, calls } = fetchStub([{ status: 200, body: {} }])
  assert.equal(await runRemoteTokens(['prod'], ctx, { fetchImpl: impl }), 2)
  assert.equal(await runRemoteTokensRevoke(['oauth-0123456789abcdef', '--remote', 'prod'], ctx, { fetchImpl: impl }), 2)
  assert.equal(calls.length, 0)
  const text = err.join('')
  assert.equal(text.match(/made only through a client such as Claude has no session on this computer: sign in with 'hyp remote login prod'/g)?.length, 2)
  assert.match(text, /remove HypAware from the client's connectors/)
})

test('mint with no session keeps its own line', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const { impl } = fetchStub([{ status: 201, body: MINTED }])
  assert.equal(await runRemoteMint(['prod', '--scope', 'query'], ctx, { fetchImpl: impl }), 2)
  assert.doesNotMatch(err.join(''), /client such as Claude/)
})

test('tokens with none says how to mint one', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl } = fetchStub([{ status: 200, body: { tokens: [] } }])
  assert.equal(await runRemoteTokens(['prod'], ctx, { fetchImpl: impl }), 0)
  assert.match(out.join(''), /no agent tokens on hyp\.internal \('prod'\) - mint one with 'hyp remote mint prod --scope query'/)
})

test('tokens maps the shared refusals', async () => {
  for (const [status, body, line] of /** @type {Array<[number, any, RegExp]>} */ ([
    [403, { error: 'read_only_session' }, /cannot manage agent tokens/],
    [403, { error: 'browser_session' }, /is a browser session/],
    [404, undefined, /does not serve agent tokens yet/],
    [429, { error: 'org_read_capacity' }, /listing failed \(HTTP 429 org_read_capacity\)/],
  ])) {
    const hypHome = await tmpHome()
    const { ctx, err } = await makeCtx({ hypHome })
    await seedSession(hypHome)
    const { impl } = fetchStub([{ status, body }])
    assert.equal(await runRemoteTokens(['prod'], ctx, { fetchImpl: impl }), 1, String(status))
    assert.match(err.join(''), line)
  }
})

test('tokens revoke sends DELETE for the jti and writes nothing locally', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome, defaultRemote: 'prod' })
  await seedSession(hypHome)
  const before = await snapshot(hypHome)
  const { impl, calls } = fetchStub([{ status: 200, body: { jti: 'rt-aaaaaaaaaaaaaaaa', revoked: true } }])
  assert.equal(await runRemoteTokensRevoke(['rt-aaaaaaaaaaaaaaaa'], ctx, { fetchImpl: impl }), 0)
  assert.equal(calls[0].url, `${ENDPOINT}/rt-aaaaaaaaaaaaaaaa`)
  assert.equal(calls[0].init.method, 'DELETE')
  assert.equal(calls[0].init.headers.authorization, 'Bearer jwt-1')
  assert.equal(calls[0].init.body, undefined)
  assert.equal(out.join(''), "revoked agent token rt-aaaaaaaaaaaaaaaa on hyp.internal ('prod')\n")
  assert.deepEqual(await snapshot(hypHome), before)
})

test('tokens revoke of an MCP connection id names it as a connection', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome, defaultRemote: 'prod' })
  await seedSession(hypHome)
  const { impl, calls } = fetchStub([{ status: 200, body: { id: 'oauth-0123456789abcdef', revoked: true } }])
  assert.equal(await runRemoteTokensRevoke(['oauth-0123456789abcdef'], ctx, { fetchImpl: impl }), 0)
  assert.equal(calls[0].url, `${ENDPOINT}/oauth-0123456789abcdef`)
  assert.equal(calls[0].init.method, 'DELETE')
  assert.equal(out.join(''), "revoked connection oauth-0123456789abcdef on hyp.internal ('prod')\n")
})

test('tokens revoke takes --remote and encodes the jti into one path segment', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl, calls } = fetchStub([{ status: 200, body: { revoked: true } }])
  assert.equal(await runRemoteTokensRevoke(['../x?y', '--remote', 'prod'], ctx, { fetchImpl: impl }), 0)
  assert.equal(calls[0].url, `${ENDPOINT}/..%2Fx%3Fy`)
})

test('tokens revoke of a jti that is not yours names the list command', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl } = fetchStub([{ status: 404, body: { error: 'unknown_org_token' } }])
  assert.equal(await runRemoteTokensRevoke(['rt-cccccccccccccccc', '--remote', 'prod'], ctx, { fetchImpl: impl }), 1)
  const text = err.join('')
  assert.match(text, /hyp\.internal \('prod'\) has no agent token or MCP connection rt-cccccccccccccccc of yours - list them with 'hyp remote tokens prod'/)
  assert.doesNotMatch(text, /does not serve agent tokens/)
})

test('tokens revoke needs a jti', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const { impl, calls } = fetchStub([{ status: 200, body: {} }])
  assert.equal(await runRemoteTokensRevoke([], ctx, { fetchImpl: impl }), 2)
  assert.equal(calls.length, 0)
  assert.match(err.join(''), /usage: hyp remote tokens revoke/)
})

test('the agent-token commands refuse an unknown target before any request', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const { impl, calls } = fetchStub([{ status: 200, body: {} }])
  assert.equal(await runRemoteMint(['nowhere', '--scope', 'query'], ctx, { fetchImpl: impl }), 2)
  assert.equal(await runRemoteTokens(['nowhere'], ctx, { fetchImpl: impl }), 2)
  assert.equal(await runRemoteTokensRevoke(['rt-x', '--remote', 'nowhere'], ctx, { fetchImpl: impl }), 2)
  assert.equal(calls.length, 0)
  assert.equal(err.join('').match(/unknown remote target 'nowhere'/g)?.length, 3)
})
