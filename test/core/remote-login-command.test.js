// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runRemoteLogin, deriveIdentityBase } from '../../src/core/cli/remote_commands.js'
import { readCredentials } from '../../src/core/remote/credentials.js'

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-login-'))
}

/**
 * Build a ctx with a stub stdin (TTY by default so the browser path is the
 * default), captured streams, and a configured `prod` target written to a
 * real config file (the command resolves targets from the config file).
 *
 * @param {{ hypHome: string, stdin?: any, remotes?: any }} opts
 */
async function makeCtx({ hypHome, stdin, remotes }) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const configPath = path.join(hypHome, 'config.json')
  const resolvedRemotes = remotes ?? { prod: { url: 'https://hyp.internal/mcp' } }
  await fs.writeFile(configPath, JSON.stringify({ version: 2, query: { remotes: resolvedRemotes } }))
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome, HYP_CONFIG: configPath },
    config: { version: 2, query: { remotes: resolvedRemotes } },
    stdin: stdin ?? { isTTY: true },
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

test('deriveIdentityBase yields <origin>/v1/identity', () => {
  assert.equal(deriveIdentityBase('https://hyp.internal/mcp'), 'https://hyp.internal/v1/identity')
  assert.equal(deriveIdentityBase('https://hyp.internal:8443/a/b/mcp'), 'https://hyp.internal:8443/v1/identity')
  assert.equal(deriveIdentityBase('not a url'), null)
})

test('browser mode forwards --org and the derived identity base, then stores the session', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  /** @type {any} */ let seen
  const login = /** @type {any} */ (async (/** @type {any} */ args) => {
    seen = args
    return { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' }
  })

  const code = await runRemoteLogin(['prod', '--org', 'acme'], ctx, { login })
  assert.equal(code, 0)
  assert.equal(seen.identityBase, 'https://hyp.internal/v1/identity')
  assert.equal(seen.org, 'acme')
  assert.equal(seen.noBrowser, false)
  assert.match(out.join(''), /logged in to 'prod' as org 'acme'/)

  const stateDir = path.join(hypHome, 'hypaware')
  const creds = await readCredentials(stateDir)
  assert.equal(/** @type {any} */ (creds.prod).kind, 'oidc')
  assert.equal(/** @type {any} */ (creds.prod).refreshToken, 'rt')
})

test('--no-browser passes noBrowser through to the flow', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  /** @type {any} */ let seen
  const login = /** @type {any} */ (async (/** @type {any} */ args) => {
    seen = args
    return { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' }
  })
  await runRemoteLogin(['prod', '--no-browser'], ctx, { login })
  assert.equal(seen.noBrowser, true)
})

test('a callback error maps to a clear org-selection message', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => {
    throw Object.assign(new Error('login failed: org_selection_required'), { callbackError: 'org_selection_required' })
  })
  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 1)
  assert.match(err.join(''), /re-run with --org <name>/)
})

test('no_membership maps to its own message', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => {
    throw Object.assign(new Error('x'), { callbackError: 'no_membership' })
  })
  await runRemoteLogin(['prod'], ctx, { login })
  assert.match(err.join(''), /not a member of any org/)
})

test('browser mode on an unconfigured target refuses before any flow', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome, remotes: {} })
  let called = false
  const login = /** @type {any} */ (async () => { called = true; return {} })
  const code = await runRemoteLogin(['ghost'], ctx, { login })
  assert.equal(code, 2)
  assert.equal(called, false)
  assert.match(err.join(''), /not a configured target/)
})

test('the static --token-file path is unchanged (stores kind: static)', async () => {
  const hypHome = await tmpHome()
  const tokenFile = path.join(hypHome, 'tok.txt')
  await fs.writeFile(tokenFile, 'sk-static\n')
  const { ctx, out } = await makeCtx({ hypHome })
  let called = false
  const login = /** @type {any} */ (async () => { called = true; return {} })
  const code = await runRemoteLogin(['prod', '--token-file', tokenFile], ctx, { login })
  assert.equal(code, 0)
  assert.equal(called, false) // browser flow not entered
  assert.match(out.join(''), /stored query-scoped token for 'prod'/)
  const stateDir = path.join(hypHome, 'hypaware')
  const creds = await readCredentials(stateDir)
  assert.deepEqual(creds.prod, { kind: 'static', token: 'sk-static' })
})

test('a piped stdin token still takes the static path', async () => {
  const hypHome = await tmpHome()
  // A non-TTY stdin that yields a token, the way a piped `echo tok |` does.
  const stdin = {
    isTTY: false,
    async *[Symbol.asyncIterator]() { yield Buffer.from('piped-tok\n') },
  }
  const { ctx } = await makeCtx({ hypHome, stdin })
  let called = false
  const login = /** @type {any} */ (async () => { called = true; return {} })
  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 0)
  assert.equal(called, false)
  const stateDir = path.join(hypHome, 'hypaware')
  const creds = await readCredentials(stateDir)
  assert.deepEqual(creds.prod, { kind: 'static', token: 'piped-tok' })
})
