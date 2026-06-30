// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runRemoteLogin, runRemoteRemove } from '../../src/core/cli/remote_commands.js'
import { deriveIdentityBase, readCredentials } from '../../src/core/remote/credentials.js'

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

test('a successful sign-in whose session write fails reports a store failure, not a login failure', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  // Make the session write fail: put a plain file where the state dir must be,
  // so withCredentialsLock's mkdir throws. The single-use code is already spent.
  await fs.writeFile(path.join(hypHome, 'hypaware'), 'not a dir')
  const login = /** @type {any} */ (async () => ({
    refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme',
  }))

  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 1)
  // The browser flow itself worked, so do not blame it or print the headless hint.
  assert.match(err.join(''), /signed in but could not store the session/)
  assert.doesNotMatch(err.join(''), /machine with no browser/)
  assert.equal(out.join(''), '')
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

test('--no-browser still uses browser mode when stdin is non-TTY', async () => {
  const hypHome = await tmpHome()
  const stdin = {
    isTTY: false,
    async *[Symbol.asyncIterator]() { /* no chunks */ },
  }
  const { ctx } = await makeCtx({ hypHome, stdin })
  /** @type {any} */ let seen
  const login = /** @type {any} */ (async (/** @type {any} */ args) => {
    seen = args
    return { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' }
  })
  const code = await runRemoteLogin(['prod', '--no-browser'], ctx, { login })
  assert.equal(code, 0)
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

test('a browser login timeout points at the headless escape hatches', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  // A local failure with no server callbackError (e.g. the loopback timeout a
  // headless box hits when the opener silently fails).
  const login = /** @type {any} */ (async () => {
    throw new Error('timed out waiting for the browser login to complete')
  })
  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 1)
  assert.match(err.join(''), /timed out/)
  assert.match(err.join(''), /--token-file <path> or pipe it on stdin/)
})

test('a server callback error does not append the headless hint (it is already actionable)', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => {
    throw Object.assign(new Error('x'), { callbackError: 'org_selection_required' })
  })
  await runRemoteLogin(['prod'], ctx, { login })
  assert.doesNotMatch(err.join(''), /--token-file <path> or pipe it on stdin/)
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

test('a static login write failure keeps the friendly hyp remote login: message', async () => {
  const hypHome = await tmpHome()
  // Put a file where the state dir must be created, so writeToken's lock setup
  // (mkdir) fails like a contended lock would, surfacing a thrown error.
  await fs.writeFile(path.join(hypHome, 'hypaware'), 'not a dir')
  const tokenFile = path.join(hypHome, 'tok.txt')
  await fs.writeFile(tokenFile, 'sk-static\n')
  const { ctx, err } = await makeCtx({ hypHome })
  const code = await runRemoteLogin(['prod', '--token-file', tokenFile], ctx, {})
  assert.equal(code, 1)
  assert.match(err.join(''), /^hyp remote login: /m)
})

test('a remove whose token removal fails reports the partial state, not a raw throw', async () => {
  const hypHome = await tmpHome()
  await fs.writeFile(path.join(hypHome, 'hypaware'), 'not a dir')
  const { ctx, err } = await makeCtx({ hypHome })
  const code = await runRemoteRemove(['prod'], ctx)
  assert.equal(code, 1)
  assert.match(err.join(''), /^hyp remote remove: /m)
  // The config edit already landed, so the user is told the token lingered.
  assert.match(err.join(''), /removed 'prod' from config; its stored token could not be removed/)
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

test('an empty piped stdin (no token) points at --browser instead of just "empty token"', async () => {
  const hypHome = await tmpHome()
  // Non-TTY stdin that yields nothing, the way `< /dev/null` or some wrappers do.
  const stdin = {
    isTTY: false,
    async *[Symbol.asyncIterator]() { /* no chunks */ },
  }
  const { ctx, err } = await makeCtx({ hypHome, stdin })
  const code = await runRemoteLogin(['prod'], ctx, {})
  assert.equal(code, 2)
  assert.match(err.join(''), /empty token/)
  assert.match(err.join(''), /re-run with --browser/)
})

test('--no-browser takes the browser flow even with a piped token (the flag wins)', async () => {
  const hypHome = await tmpHome()
  const stdin = {
    isTTY: false,
    async *[Symbol.asyncIterator]() { yield Buffer.from('piped-tok\n') },
  }
  const { ctx } = await makeCtx({ hypHome, stdin })
  /** @type {any} */ let seen
  const login = /** @type {any} */ (async (/** @type {any} */ args) => {
    seen = args
    return { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' }
  })
  const code = await runRemoteLogin(['prod', '--no-browser'], ctx, { login })
  assert.equal(code, 0)
  // The flag selects the browser flow (which prints the URL); the pipe is not
  // read as a static token. A piped token without --no-browser still takes the
  // static path (covered above), so a token is only ignored when --no-browser
  // is given explicitly.
  assert.equal(seen.noBrowser, true)
})

test('--browser overrides a piped stdin token and takes the browser flow', async () => {
  const hypHome = await tmpHome()
  const stdin = {
    isTTY: false,
    async *[Symbol.asyncIterator]() { yield Buffer.from('piped-tok\n') },
  }
  const { ctx } = await makeCtx({ hypHome, stdin })
  let called = false
  const login = /** @type {any} */ (async () => {
    called = true
    return { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' }
  })
  const code = await runRemoteLogin(['prod', '--browser'], ctx, { login })
  assert.equal(code, 0)
  assert.equal(called, true)
})

test('a missing target name (only flags) is a usage error, not a flag value misread as the name', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  let called = false
  const login = /** @type {any} */ (async () => { called = true; return {} })
  // `--org acme` with no positional name must not be read as target 'acme'.
  const code = await runRemoteLogin(['--org', 'acme'], ctx, { login })
  assert.equal(code, 2)
  assert.equal(called, false)
  assert.match(err.join(''), /usage: hyp remote login <name>/)
})

test('--org as the last arg with no value is a usage error', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const code = await runRemoteLogin(['prod', '--org'], ctx, {})
  assert.equal(code, 2)
  assert.match(err.join(''), /--org expects an org name/)
})

test('--org is noted as ignored when a static token forces the static path', async () => {
  const hypHome = await tmpHome()
  const tokenFile = path.join(hypHome, 'tok.txt')
  await fs.writeFile(tokenFile, 'sk-static\n')
  const { ctx, err } = await makeCtx({ hypHome })
  const code = await runRemoteLogin(['prod', '--token-file', tokenFile, '--org', 'acme'], ctx, {})
  assert.equal(code, 0)
  assert.match(err.join(''), /--org is ignored with a static token/)
})

test('--org=acme (equals form) is honored, not silently dropped', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  /** @type {any} */ let seen
  const login = /** @type {any} */ (async (/** @type {any} */ args) => {
    seen = args
    return { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' }
  })
  const code = await runRemoteLogin(['prod', '--org=acme'], ctx, { login })
  assert.equal(code, 0)
  assert.equal(seen.org, 'acme') // not undefined, which would run a no-org browser flow
})

test('--token-file=path (equals form) takes the static path, not the browser flow', async () => {
  const hypHome = await tmpHome()
  const tokenFile = path.join(hypHome, 'tok.txt')
  await fs.writeFile(tokenFile, 'sk-static\n')
  const { ctx } = await makeCtx({ hypHome })
  let called = false
  const login = /** @type {any} */ (async () => { called = true; return {} })
  const code = await runRemoteLogin(['prod', `--token-file=${tokenFile}`], ctx, { login })
  assert.equal(code, 0)
  assert.equal(called, false) // equals form must not fall through to the browser flow
  const creds = await readCredentials(path.join(hypHome, 'hypaware'))
  assert.deepEqual(creds.prod, { kind: 'static', token: 'sk-static' })
})

test('--org= (equals form, empty value) is a usage error', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const code = await runRemoteLogin(['prod', '--org='], ctx, {})
  assert.equal(code, 2)
  assert.match(err.join(''), /--org expects an org name/)
})
