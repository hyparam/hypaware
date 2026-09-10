// @ts-check

// The consumer layer of the defect #1609 fixed in the `remote` command family:
// `hyp report list --remote <name>`, the `--remote` verb attach path, the
// `hyp mcp serve` stdio proxy and the 0600 credential store all key a plain
// object by the target name the operator types, so `constructor`, `toString`,
// `valueOf`, `hasOwnProperty` and `__proto__` resolved an inherited
// `Object.prototype` member instead of missing and walked past every
// `if (!entry)` refusal; the write side ran the inherited `__proto__` setter,
// so `hyp remote login --name=__proto__` reported a token the store never took.
//
// Each case pins what was observed on `origin/master`, which differs per route:
// `report list` threw an unhandled `TypeError`, `mcp serve` printed a raw
// TypeError *message* in place of its signpost (its probe already catches), and
// the verb attach path never threw at all - it answered `cannot refresh` where
// an ordinary unknown name gets `unknown remote target`.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runReportList } from '../../src/core/cli/report_commands.js'
import { runRemoteVerb } from '../../src/core/mcp/remote_verb.js'
import { runMcpProxy } from '../../src/core/mcp/proxy.js'
import {
  readCredentials,
  remoteCredentialsPath,
  removeToken,
  resolveAccessJwt,
  resolveToken,
  writeSession,
  writeToken,
} from '../../src/core/remote/credentials.js'

const PROTO_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']

async function tmpHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-remote-consumer-'))
  await fs.mkdir(path.join(home, 'hypaware'), { recursive: true })
  return home
}

/**
 * A ctx with captured streams over one ordinary configured target, the shape
 * every `--remote` consumer resolves against.
 *
 * @param {string} hypHome
 */
function makeCtx(hypHome) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const config = { version: 2, query: { remotes: { prod: { url: 'https://prod.example' } } } }
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome },
    config,
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

/** A verb whose operation and render must never run: `--remote` never reaches them. */
const NEVER_RUN_VERB = /** @type {any} */ ({
  name: 'sql',
  inputSchema: { type: 'object', properties: {} },
  operation: () => {
    throw new Error('the local operation must not run on the --remote path')
  },
  render: () => {
    throw new Error('render must not run for a refused target')
  },
})

test('report list signposts a prototype-named target instead of throwing a TypeError', async () => {
  const hypHome = await tmpHome()
  for (const name of PROTO_NAMES) {
    const { ctx, err } = makeCtx(hypHome)
    const code = await runReportList(['--remote', name], ctx)
    assert.equal(code, 2, `${name} should be a usage miss`)
    assert.match(err.join(''), new RegExp(`unknown remote target '${name}'`))
    assert.doesNotMatch(err.join(''), /Cannot read properties/)
  }
})

test('the remote verb attach path names a prototype-named target as unknown, not unrefreshable', async () => {
  const hypHome = await tmpHome()
  for (const name of PROTO_NAMES) {
    const { ctx } = makeCtx(hypHome)
    const remote = await runRemoteVerb({ verb: NEVER_RUN_VERB, params: {}, target: name, ctx })
    assert.deepEqual(remote, {
      ok: false,
      error: `unknown remote target '${name}' - add it with 'hyp remote add ${name} <url>'`,
      exitCode: 2,
    })
  }
})

test('mcp serve signposts a prototype-named target instead of reporting a raw TypeError message', async () => {
  const hypHome = await tmpHome()
  for (const name of PROTO_NAMES) {
    const { ctx, err } = makeCtx(hypHome)
    const code = await runMcpProxy({ target: name, ctx })
    assert.equal(code, 2, `${name} should be a usage miss`)
    assert.match(err.join(''), new RegExp(`unknown remote target '${name}'`))
    assert.doesNotMatch(err.join(''), /Cannot read properties/)
  }
})

test('the credential resolvers report a prototype-named target as logged out', async () => {
  const stateDir = path.join(await tmpHome(), 'hypaware')
  for (const name of PROTO_NAMES) {
    // resolveToken is the `hyp mcp serve` fail-fast probe: it used to throw
    // `Cannot read properties of undefined (reading 'length')` out of bearerOf.
    assert.deepEqual(await resolveToken({ target: name, env: {}, stateDir }), {
      ok: false,
      error: `no token for '${name}' - run 'hyp remote login ${name}' (or set HYP_REMOTE_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')})`,
    })
    // resolveAccessJwt is the query attach path: it never threw, but an
    // inherited member is truthy, so it answered `cannot refresh` for a target
    // that simply has no credential.
    const jwt = await resolveAccessJwt({ target: name, env: {}, stateDir })
    assert.equal(jwt.ok, false)
    assert.match(jwt.ok === false ? jwt.error : '', new RegExp(`no token for '${name}'`))
    assert.doesNotMatch(jwt.ok === false ? jwt.error : '', /cannot refresh/)
  }
})

test('remote login stores a __proto__ target token instead of reporting a phantom success', async () => {
  const stateDir = path.join(await tmpHome(), 'hypaware')
  await writeToken(stateDir, '__proto__', 'tok-abc')
  const onDisk = JSON.parse(await fs.readFile(remoteCredentialsPath(stateDir), 'utf8'))
  assert.ok(Object.hasOwn(onDisk, '__proto__'), 'the record must be an own key of the store, not its prototype')
  assert.deepEqual(await resolveToken({ target: '__proto__', env: {}, stateDir }), {
    ok: true,
    token: 'tok-abc',
    source: 'file',
  })
  assert.equal(await removeToken(stateDir, '__proto__'), true)
  assert.deepEqual(JSON.parse(await fs.readFile(remoteCredentialsPath(stateDir), 'utf8')), {})
})

test('a browser sign-in keeps the session it obtained for a __proto__ target', async () => {
  const stateDir = path.join(await tmpHome(), 'hypaware')
  const expiresAt = new Date(Date.now() + 3600_000).toISOString()
  await writeSession(stateDir, '__proto__', { refreshToken: 'r-1', accessJwt: 'jwt-1', expiresAt, org: 'acme' })
  const resolved = await resolveAccessJwt({ target: '__proto__', env: {}, stateDir })
  assert.deepEqual(resolved, { ok: true, token: 'jwt-1', source: 'file', kind: 'oidc' })
})

test('a __proto__ record on disk is read back, not dropped into the map prototype', async () => {
  // Written as raw JSON on purpose: in an object literal `__proto__:` is the
  // prototype-setter syntax and creates no own key at all, so a fixture built
  // that way would not reach the code under test. JSON.parse defines it.
  const stateDir = path.join(await tmpHome(), 'hypaware')
  await fs.writeFile(
    remoteCredentialsPath(stateDir),
    '{"__proto__":{"kind":"static","token":"poison"},"prod":{"kind":"static","token":"real"}}',
    { mode: 0o600 }
  )
  const creds = await readCredentials(stateDir)
  assert.deepEqual(Object.keys(creds).sort(), ['__proto__', 'prod'])
  // The dropped record used to become the map's prototype, so a target named
  // after one of its fields resolved that other target's credential.
  assert.equal(Object.hasOwn(creds, 'token'), false)
  assert.equal(creds['token'], undefined)
  assert.equal(creds['kind'], undefined)
})

test('an ordinary target name still resolves through every consumer and round-trips its token', async () => {
  // The guards must not turn every lookup into a miss, least of all in a
  // credential store.
  const hypHome = await tmpHome()
  const stateDir = path.join(hypHome, 'hypaware')

  await writeToken(stateDir, 'prod', 'tok-prod')
  assert.deepEqual(await resolveToken({ target: 'prod', env: {}, stateDir }), {
    ok: true,
    token: 'tok-prod',
    source: 'file',
  })
  assert.deepEqual(await resolveAccessJwt({ target: 'prod', env: {}, stateDir }), {
    ok: true,
    token: 'tok-prod',
    source: 'file',
    kind: 'static',
  })
  assert.deepEqual(Object.keys(await readCredentials(stateDir)), ['prod'])

  // A second target neither replaces nor drops the first.
  await writeToken(stateDir, 'staging', 'tok-staging')
  assert.deepEqual(Object.keys(await readCredentials(stateDir)).sort(), ['prod', 'staging'])
  // Re-login replaces in place rather than appending a duplicate.
  await writeToken(stateDir, 'prod', 'tok-prod-2')
  assert.deepEqual(Object.keys(await readCredentials(stateDir)).sort(), ['prod', 'staging'])
  assert.deepEqual(await resolveToken({ target: 'prod', env: {}, stateDir }), {
    ok: true,
    token: 'tok-prod-2',
    source: 'file',
  })

  assert.equal(await removeToken(stateDir, 'prod'), true)
  assert.equal(await removeToken(stateDir, 'prod'), false)
  assert.deepEqual(Object.keys(await readCredentials(stateDir)), ['staging'])

  // With 'prod' logged out again, each consumer resolving it stops at the
  // credential rather than at the registry: that is the proof the guarded
  // lookup still finds a configured target (and it reaches no network).
  const listed = makeCtx(hypHome)
  assert.equal(await runReportList(['--remote', 'prod'], listed.ctx), 2)
  assert.match(listed.err.join(''), /no token for 'prod'/)

  const verbed = makeCtx(hypHome)
  const remote = await runRemoteVerb({ verb: NEVER_RUN_VERB, params: {}, target: 'prod', ctx: verbed.ctx })
  assert.equal(remote.ok, false)
  assert.match(remote.ok === false ? remote.error : '', /no token for 'prod'/)

  const proxied = makeCtx(hypHome)
  assert.equal(await runMcpProxy({ target: 'prod', ctx: proxied.ctx }), 2)
  assert.match(proxied.err.join(''), /no token for 'prod'/)

  // And an ordinary unknown name still gets the ordinary signpost.
  const missed = makeCtx(hypHome)
  assert.equal(await runReportList(['--remote', 'nosuchremote'], missed.ctx), 2)
  assert.match(missed.err.join(''), /unknown remote target 'nosuchremote'/)
})
