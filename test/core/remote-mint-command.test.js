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
  const { ctx, out } = await makeCtx({ hypHome })
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
  const text = out.join('')
  assert.match(text, /minted CI token for 'prod' \(gateway gw-ci, expires 2027-08-20T00:00:00Z\)/)
  assert.match(text, /^ci-tok-1$/m)
  assert.match(text, /not shown again/)
  assert.match(text, /hyp join https:\/\/hyp\.internal "\$HYP_CI_TOKEN" --no-daemon/)
  assert.match(text, /hyp sync --yes/)
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

test('mint rejects a non-integer --expires-days', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const { impl, calls } = fetchStub([{ status: 200, body: { token: 't' } }])
  const code = await runRemoteMint(['prod', '--expires-days', 'soon'], ctx, { fetchImpl: impl })
  assert.equal(code, 2)
  assert.equal(calls.length, 0)
  assert.match(err.join(''), /--expires-days expects a positive integer/)
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
