// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runRemoteMint } from '../../src/core/cli/remote_commands.js'
import { writeSession, writeToken } from '../../src/core/remote/credentials.js'

const FUTURE = '2999-01-01T00:00:00Z'

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-mint-'))
}

/**
 * Build a ctx with captured streams and a configured `prod` target written to
 * a real config file (the remote family resolves targets from the file).
 *
 * @param {{ hypHome: string, remotes?: any }} opts
 */
async function makeCtx({ hypHome, remotes }) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const configPath = path.join(hypHome, 'config.json')
  const resolvedRemotes = remotes ?? { prod: { url: 'https://hyp.internal' } }
  const config = { version: 2, query: { remotes: resolvedRemotes } }
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

/** Seed a fresh (non-expiring) oidc session so no refresh runs. @param {string} hypHome */
async function seedSession(hypHome) {
  await writeSession(stateDirOf(hypHome), 'prod', { refreshToken: 'rt', accessJwt: 'jwt-1', expiresAt: FUTURE, org: 'acme' })
}

/**
 * A fetch stub that records requests and replies from a script of responses.
 * @param {Array<{ status: number, body?: any }>} script
 */
function fetchStub(script) {
  /** @type {Array<{ url: string, init: any }>} */
  const calls = []
  const impl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), init })
    const step = script[Math.min(calls.length - 1, script.length - 1)]
    const text = step.body === undefined ? '' : JSON.stringify(step.body)
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      text: async () => text,
    }
  }))
  return { impl, calls }
}

test('mint posts to the identity mint endpoint and prints the token once', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl, calls } = fetchStub([
    { status: 200, body: { token: 'ci-tok-1', gateway_id: 'gw-ci', expires_at: '2027-08-20T00:00:00Z' } },
  ])
  const code = await runRemoteMint(['prod'], ctx, { fetchImpl: impl })
  assert.equal(code, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://hyp.internal/v1/identity/mint')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer jwt-1')
  assert.deepEqual(JSON.parse(calls[0].init.body), { expires_days: 365 })
  // stdout carries the secret and nothing else, so `hyp remote mint > ci.token`
  // stores a usable token rather than a banner wrapped around one.
  assert.equal(out.join(''), 'ci-tok-1\n')
  const advice = err.join('')
  assert.match(advice, /minted CI token for 'prod' \(gateway gw-ci, expires 2027-08-20T00:00:00Z\)/)
  assert.match(advice, /not shown again/)
  assert.match(advice, /hyp join https:\/\/hyp\.internal --no-daemon/)
  assert.match(advice, /hyp sync --yes/)
})

test('the recipe pipes the token to hyp join instead of passing it as argv', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl } = fetchStub([{ status: 200, body: { token: 'ci-tok-1' } }])
  assert.equal(await runRemoteMint(['prod'], ctx, { fetchImpl: impl }), 0)
  const advice = err.join('')
  // A positional token lands in shell history and in `ps` on a shared runner,
  // which is why `hyp join`'s own help steers scripts to stdin or --token-file.
  assert.match(advice, /printf '%s' "\$HYP_CI_TOKEN" \| hyp join https:\/\/hyp\.internal --no-daemon/)
  assert.doesNotMatch(advice, /hyp join \S+ "\$HYP_CI_TOKEN"/)
})

test('an epoch-second expires_at is rendered, not silently dropped', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  // The identity plane's wire shape for `expires_at` is a Unix epoch-second,
  // the same as /token's; reading only strings would drop the one line that
  // tells the user when their never-re-shown CI credential dies.
  const { impl } = fetchStub([{ status: 200, body: { token: 't', gateway_id: 'gw', expires_at: 1789000000 } }])
  assert.equal(await runRemoteMint(['prod'], ctx, { fetchImpl: impl }), 0)
  assert.equal(out.join(''), 't\n')
  assert.match(err.join(''), /expires 2026-09-10T00:26:40\.000Z/)
})

test('an unreadable expires_at drops the detail but still prints the token', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl } = fetchStub([{ status: 200, body: { token: 't', gateway_id: 'gw', expires_at: 'whenever' } }])
  assert.equal(await runRemoteMint(['prod'], ctx, { fetchImpl: impl }), 0)
  assert.equal(out.join(''), 't\n')
  assert.match(err.join(''), /\(gateway gw\)/)
  assert.doesNotMatch(err.join(''), /expires/)
})

test('mint forwards --label and --expires-days', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl, calls } = fetchStub([{ status: 200, body: { token: 't' } }])
  const code = await runRemoteMint(['prod', '--label', 'repo-ci', '--expires-days', '30'], ctx, { fetchImpl: impl })
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(calls[0].init.body), { expires_days: 30, label: 'repo-ci' })
})

test('mint rejects an --expires-days the schema bound refuses', async () => {
  for (const bad of ['soon', '0', '-5', '1.5']) {
    const hypHome = await tmpHome()
    const { ctx, err } = await makeCtx({ hypHome })
    const { impl, calls } = fetchStub([{ status: 200, body: { token: 't' } }])
    const code = await runRemoteMint(['prod', '--expires-days', bad], ctx, { fetchImpl: impl })
    assert.equal(code, 2, bad)
    assert.equal(calls.length, 0, bad)
    // The gate owns the bound, so the refusal also prints the usage line.
    assert.match(err.join(''), /--expires-days expects a positive integer/)
    assert.match(err.join(''), /usage: hyp remote mint/)
  }
})

test('mint refuses an unknown target with remote add guidance', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const code = await runRemoteMint(['nowhere'], ctx, {})
  assert.equal(code, 2)
  assert.match(err.join(''), /unknown remote target 'nowhere'.*hyp remote add nowhere/)
})

test('mint without a stored credential points at remote login', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const { impl, calls } = fetchStub([{ status: 200, body: { token: 't' } }])
  const code = await runRemoteMint(['prod'], ctx, { fetchImpl: impl })
  assert.equal(code, 2)
  assert.equal(calls.length, 0)
  assert.match(err.join(''), /hyp remote login/)
})

test('a 401 on a static token maps to re-login guidance without a retry', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  await writeToken(stateDirOf(hypHome), 'prod', 'static-tok')
  const { impl, calls } = fetchStub([{ status: 401 }])
  const code = await runRemoteMint(['prod'], ctx, { fetchImpl: impl })
  assert.equal(code, 1)
  assert.equal(calls.length, 1)
  assert.match(err.join(''), /re-run 'hyp remote login prod'/)
})

test('the printed recipe joins the server base, not a /v1/mcp target URL', async () => {
  const hypHome = await tmpHome()
  // A target registered as `<base>/v1/mcp` is a supported shape (LLP 0084 D2).
  // `hyp join` stores its url argument verbatim, so pasting the registered URL
  // into the recipe would 404 every CI run on /v1/identity/bootstrap.
  const { ctx, err } = await makeCtx({ hypHome, remotes: { prod: { url: 'https://hyp.internal/v1/mcp' } } })
  await seedSession(hypHome)
  const { impl, calls } = fetchStub([{ status: 200, body: { token: 'ci-tok-1' } }])
  const code = await runRemoteMint(['prod'], ctx, { fetchImpl: impl })
  assert.equal(code, 0)
  assert.equal(calls[0].url, 'https://hyp.internal/v1/identity/mint')
  const text = err.join('')
  assert.match(text, /hyp join https:\/\/hyp\.internal --no-daemon/)
  assert.doesNotMatch(text, /hyp join \S*\/v1\/mcp/)
})

test('a 401 that survives the refresh names both expiry and missing permission', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  // This server answers 401, not 403, to a live session lacking a scope
  // (LLP 0155 #write-401), so the expiry-only wording would loop the user
  // through re-login forever. The refresh succeeds, so the second 401 is the
  // one that survives the one-shot retry.
  /** @type {string[]} */ const seen = []
  const impl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    seen.push(String(url))
    if (String(url).endsWith('/token')) {
      const body = { refresh_token: 'rt-2', access_jwt: 'jwt-2', expires_at: 32503680000, org: 'acme' }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }
    return { ok: false, status: 401, text: async () => '' }
  }))
  const code = await runRemoteMint(['prod'], ctx, { fetchImpl: impl })
  assert.deepEqual(seen, [
    'https://hyp.internal/v1/identity/mint',
    'https://hyp.internal/v1/identity/token',
    'https://hyp.internal/v1/identity/mint',
  ])
  assert.equal(code, 1)
  const text = err.join('')
  assert.match(text, /session may have expired/)
  assert.match(text, /not be permitted to mint CI tokens/)
})
test('a 403 names the missing mint permission', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl } = fetchStub([{ status: 403 }])
  const code = await runRemoteMint(['prod'], ctx, { fetchImpl: impl })
  assert.equal(code, 1)
  assert.match(err.join(''), /not be permitted to mint/)
})

test('a 404 says the server predates minting', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl } = fetchStub([{ status: 404 }])
  const code = await runRemoteMint(['prod'], ctx, { fetchImpl: impl })
  assert.equal(code, 1)
  assert.match(err.join(''), /predate this feature/)
})

test('a success response without a token is an error, not a blank print', async () => {
  const hypHome = await tmpHome()
  const { ctx, err, out } = await makeCtx({ hypHome })
  await seedSession(hypHome)
  const { impl } = fetchStub([{ status: 200, body: { gateway_id: 'gw' } }])
  const code = await runRemoteMint(['prod'], ctx, { fetchImpl: impl })
  assert.equal(code, 1)
  assert.equal(out.join(''), '')
  assert.match(err.join(''), /carried no token/)
})
