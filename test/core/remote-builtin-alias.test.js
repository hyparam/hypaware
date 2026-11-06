// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  BUILTIN_DEFAULT_REMOTE,
  canonicalRemoteName,
  effectiveDefaultRemote,
  effectiveRemotes,
  legacyCredentialName,
} from '../../src/core/remote/builtin_remotes.js'
import { readCredentials, resolveAccessJwt, resolveToken, writeSession } from '../../src/core/remote/credentials.js'
import { parseConfigShape } from '../../src/core/config/schema.js'
import { runRemoteList, runRemoteMint, runRemoteRemove, runRemoteTokens, runRemoteTokensRevoke } from '../../src/core/cli/remote_commands.js'
import { runRemoteVerb } from '../../src/core/mcp/remote_verb.js'

const FUTURE = '2999-01-01T00:00:00Z'

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-builtin-alias-'))
}

/**
 * @param {string} hypHome
 * @param {any} [query]
 */
async function makeCtx(hypHome, query = {}) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const configPath = path.join(hypHome, 'config.json')
  const config = { version: 2, query }
  await fs.writeFile(configPath, JSON.stringify(config))
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome, HYP_CONFIG: configPath },
    config,
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err, stateDir: path.join(hypHome, 'hypaware') }
}

/** @param {Array<{ status: number, body?: any }>} script */
function fetchStub(script) {
  /** @type {Array<{ url: string, init: any }>} */
  const calls = []
  const impl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), init })
    const step = script[Math.min(calls.length - 1, script.length - 1)]
    const text = step.body === undefined ? '' : JSON.stringify(step.body)
    return { ok: step.status >= 200 && step.status < 300, status: step.status, headers: { get: () => null }, text: async () => text }
  }))
  return { impl, calls }
}

test('the built-in is hypaware and the old name is not a second entry', () => {
  assert.equal(BUILTIN_DEFAULT_REMOTE, 'hypaware')
  assert.deepEqual(Object.keys(effectiveRemotes(undefined)), ['hypaware'])
})

test('the old name resolves to the built-in unless the user defines it', () => {
  assert.equal(canonicalRemoteName('hyperparam', undefined), 'hypaware')
  assert.equal(canonicalRemoteName('prod', undefined), 'prod')
  const own = /** @type {any} */ ({ query: { remotes: { hyperparam: { url: 'https://mine.example' } } } })
  assert.equal(canonicalRemoteName('hyperparam', own), 'hyperparam')
  assert.equal(effectiveDefaultRemote(/** @type {any} */ ({ query: { default_remote: 'hyperparam' } })), 'hypaware')
  assert.equal(effectiveDefaultRemote({ ...own, query: { ...own.query, default_remote: 'hyperparam' } }), 'hyperparam')
})

test('--remote hyperparam reaches the built-in target', async () => {
  const { ctx } = await makeCtx(await tmpHome())
  const r = await runRemoteVerb({ verb: /** @type {any} */ ({ name: 'sql' }), params: {}, target: 'hyperparam', ctx })
  assert.equal(r.ok, false)
  assert.doesNotMatch(r.ok === false ? r.error : '', /unknown remote target/)
  assert.match(r.ok === false ? r.error : '', /no token for 'hypaware'/)
})

test('a default_remote naming the old built-in validates', () => {
  assert.equal(parseConfigShape({ version: 2, query: { default_remote: 'hyperparam' } }).ok, true)
  assert.equal(parseConfigShape({ version: 2, query: { default_remote: 'hypaware' } }).ok, true)
})

test('the legacy credential name applies only while neither name is the user\'s own', () => {
  assert.equal(legacyCredentialName('hypaware', undefined), 'hyperparam')
  assert.equal(legacyCredentialName('prod', undefined), undefined)
  const url = { url: 'https://mine.example' }
  assert.equal(legacyCredentialName('hypaware', /** @type {any} */ ({ query: { remotes: { hyperparam: url } } })), undefined)
  assert.equal(legacyCredentialName('hypaware', /** @type {any} */ ({ query: { remotes: { hypaware: url } } })), undefined)
})

test('a session and env override under the old name serve the built-in, and its own name wins', async () => {
  const { stateDir } = await makeCtx(await tmpHome())
  await writeSession(stateDir, 'hyperparam', { refreshToken: 'rt', accessJwt: 'jwt-old', expiresAt: FUTURE, org: 'acme' })
  const legacyTarget = 'hyperparam'
  assert.equal(/** @type {any} */ (await resolveAccessJwt({ target: 'hypaware', legacyTarget, env: {}, stateDir })).token, 'jwt-old')
  assert.equal(/** @type {any} */ (await resolveToken({ target: 'hypaware', legacyTarget, env: {}, stateDir })).token, 'jwt-old')
  assert.equal((await resolveAccessJwt({ target: 'hypaware', env: {}, stateDir })).ok, false)
  const env = { HYP_REMOTE_TOKEN_HYPERPARAM: 'env-old' }
  assert.equal(/** @type {any} */ (await resolveAccessJwt({ target: 'hypaware', legacyTarget, env, stateDir })).token, 'env-old')
  await writeSession(stateDir, 'hypaware', { refreshToken: 'rt2', accessJwt: 'jwt-new', expiresAt: FUTURE, org: 'acme' })
  assert.equal(/** @type {any} */ (await resolveAccessJwt({ target: 'hypaware', legacyTarget, env: {}, stateDir })).token, 'jwt-new')
})

test('a refresh of a session stored under the old name commits back to that name', async () => {
  const { stateDir } = await makeCtx(await tmpHome())
  const now = Date.parse('2026-10-21T12:00:00Z')
  await writeSession(stateDir, 'hyperparam', { refreshToken: 'rt', accessJwt: 'jwt-stale', expiresAt: new Date(now - 1000).toISOString(), org: 'acme' })
  const fetchImpl = /** @type {any} */ (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_jwt: 'jwt-fresh', expires_at: FUTURE, org: 'acme' }) }))
  const r = await resolveAccessJwt({ target: 'hypaware', legacyTarget: 'hyperparam', env: {}, stateDir, identityBase: 'https://h/v1/identity', now, fetchImpl })
  assert.equal(/** @type {any} */ (r).token, 'jwt-fresh')
  const creds = await readCredentials(stateDir)
  assert.deepEqual(Object.keys(creds), ['hyperparam'])
  assert.equal(/** @type {any} */ (creds.hyperparam).accessJwt, 'jwt-fresh')
})

test('remote list shows hypaware once, with an old-name session as stored', async () => {
  const { ctx, out, stateDir } = await makeCtx(await tmpHome())
  await writeSession(stateDir, 'hyperparam', { refreshToken: 'rt', accessJwt: 'jwt-old', expiresAt: FUTURE, org: 'acme' })
  assert.equal(await runRemoteList(['--json'], ctx), 0)
  assert.deepEqual(JSON.parse(out.join('')), [{ name: 'hypaware', url: 'https://api.hypaware.ai', token: 'stored' }])
})

test('remote remove of the old name clears the session under both names', async () => {
  const { ctx, out, stateDir } = await makeCtx(await tmpHome())
  await writeSession(stateDir, 'hyperparam', { refreshToken: 'rt', accessJwt: 'a', expiresAt: FUTURE, org: 'acme' })
  await writeSession(stateDir, 'hypaware', { refreshToken: 'rt', accessJwt: 'b', expiresAt: FUTURE, org: 'acme' })
  assert.equal(await runRemoteRemove(['hyperparam'], ctx), 0)
  assert.match(out.join(''), /removed remote 'hypaware' \(config \+ token\)/)
  assert.deepEqual(await readCredentials(stateDir), {})
})

test('with only the built-in configured, the messages name HypAware Cloud alone', async () => {
  const { ctx, out, stateDir } = await makeCtx(await tmpHome())
  await writeSession(stateDir, 'hyperparam', { refreshToken: 'rt', accessJwt: 'jwt-old', expiresAt: FUTURE, org: 'acme' })
  const { impl, calls } = fetchStub([{ status: 200, body: { tokens: [] } }])
  assert.equal(await runRemoteTokens(['hyperparam'], ctx, { fetchImpl: impl }), 0)
  assert.equal(calls[0].url, 'https://api.hypaware.ai/v1/org/tokens/mine')
  assert.equal(calls[0].init.headers.authorization, 'Bearer jwt-old')
  assert.match(out.join(''), /^no agent tokens on HypAware Cloud - mint one with 'hyp remote mint hypaware --scope query'\n/)
})

test('a revoke of an oauth- id says revoked connection', async () => {
  const { ctx, out, stateDir } = await makeCtx(await tmpHome())
  await writeSession(stateDir, 'hypaware', { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: FUTURE, org: 'acme' })
  const { impl } = fetchStub([{ status: 200, body: { revoked: true } }])
  assert.equal(await runRemoteTokensRevoke(['oauth-0123456789abcdef'], ctx, { fetchImpl: impl }), 0)
  assert.equal(out.join(''), 'revoked connection oauth-0123456789abcdef on HypAware Cloud\n')
})

test('an own remote written after the command loaded its config never receives the old-name credential', async () => {
  for (const own of ['hypaware', 'hyperparam']) {
    const hypHome = await tmpHome()
    const { ctx, stateDir } = await makeCtx(hypHome)
    await writeSession(stateDir, 'hyperparam', { refreshToken: 'rt', accessJwt: 'jwt-old-cloud', expiresAt: FUTURE, org: 'acme' })
    await fs.writeFile(path.join(hypHome, 'config.json'), JSON.stringify({ version: 2, query: { remotes: { [own]: { url: 'https://other.example' } } } }))
    const { impl, calls } = fetchStub([{ status: 200, body: { tokens: [] } }])
    await runRemoteTokens([], ctx, { fetchImpl: impl })
    await runRemoteMint(['--scope', 'query'], ctx, { fetchImpl: impl })
    for (const call of calls) assert.notEqual(call.init?.headers?.authorization, 'Bearer jwt-old-cloud', `${own}: ${call.url}`)
  }
})

test('the old env override still wins over a session stored under the new name', async () => {
  const { stateDir } = await makeCtx(await tmpHome())
  await writeSession(stateDir, 'hypaware', { refreshToken: 'rt', accessJwt: 'jwt-new', expiresAt: FUTURE, org: 'acme' })
  const args = { target: 'hypaware', legacyTarget: 'hyperparam', env: { HYP_REMOTE_TOKEN_HYPERPARAM: 'env-old' }, stateDir }
  assert.equal(/** @type {any} */ (await resolveAccessJwt(args)).token, 'env-old')
  assert.equal(/** @type {any} */ (await resolveToken(args)).token, 'env-old')
  const both = { ...args, env: { ...args.env, HYP_REMOTE_TOKEN_HYPAWARE: 'env-new' } }
  assert.equal(/** @type {any} */ (await resolveAccessJwt(both)).token, 'env-new')
})

test('a name typed after an own hyperparam was written means that remote, not the built-in', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, stateDir } = await makeCtx(hypHome)
  await writeSession(stateDir, 'hypaware', { refreshToken: 'rt', accessJwt: 'jwt-cloud', expiresAt: FUTURE, org: 'acme' })
  await writeSession(stateDir, 'hyperparam', { refreshToken: 'rt', accessJwt: 'jwt-other', expiresAt: FUTURE, org: 'acme' })
  await fs.writeFile(path.join(hypHome, 'config.json'), JSON.stringify({ version: 2, query: { remotes: { hyperparam: { url: 'https://other.example' } } } }))
  const { impl, calls } = fetchStub([{ status: 200, body: { tokens: [] } }])
  assert.equal(await runRemoteTokens(['hyperparam'], ctx, { fetchImpl: impl }), 0)
  assert.equal(calls[0].url, 'https://other.example/v1/org/tokens/mine')
  assert.equal(calls[0].init.headers.authorization, 'Bearer jwt-other')
  assert.equal(await runRemoteRemove(['hyperparam'], ctx), 0)
  assert.match(out.join(''), /removed remote 'hyperparam' \(config \+ token\)/)
  assert.deepEqual(Object.keys(await readCredentials(stateDir)), ['hypaware'])
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(hypHome, 'config.json'), 'utf8')).query.remotes, {})
})
