// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runRemoteLogin, runRemoteRemove, waitForClientAttach } from '../../src/core/cli/remote_commands.js'
import { deriveIdentityBase, readCredentials } from '../../src/core/remote/credentials.js'

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-login-'))
}

/**
 * Build a ctx with a stub stdin (TTY by default so the browser path is the
 * default), captured streams, and a configured `prod` target written to a
 * real config file (the command resolves targets from the config file).
 * `sinks` lands in the same config file, so gateway seeding resolves it the
 * way the daemon would.
 *
 * @param {{ hypHome: string, stdin?: any, remotes?: any, sinks?: any }} opts
 */
async function makeCtx({ hypHome, stdin, remotes, sinks }) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const configPath = path.join(hypHome, 'config.json')
  const resolvedRemotes = remotes ?? { prod: { url: 'https://hyp.internal/mcp' } }
  const config = { version: 2, query: { remotes: resolvedRemotes }, ...(sinks ? { sinks } : {}) }
  await fs.writeFile(configPath, JSON.stringify(config))
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome, HYP_CONFIG: configPath },
    config,
    stdin: stdin ?? { isTTY: true },
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

/** An OidcSession carrying a login-minted gateway credential (LLP 0061). */
function gatewaySession() {
  return {
    refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme',
    gateway: { jwt: 'gw-jwt', expiresAt: 1_920_000_000, gatewayId: 'gw-1' },
  }
}

/**
 * Enroll a machine by writing a central-layer seed (what `hyp join` / an
 * enrolling login writes), so the D4 gate sees a real enrollment — as opposed
 * to a hand-authored sink in the local config, which is not an enrollment.
 * @param {string} hypHome @param {string} url
 */
async function writeCentralSeed(hypHome, url) {
  const seedPath = path.join(hypHome, 'hypaware', 'config-control', 'seed.json')
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
    sinks: { central: { plugin: '@hypaware/central', config: { url, identity: {} } } },
  }))
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

test('a login-minted gateway credential seeds the matching central sink (LLP 0061 D2/D5)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({
    hypHome,
    sinks: { fwd: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
  })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 0)
  assert.match(out.join(''), /seeded forwarding identity for sink 'fwd' \(gateway gw-1\)/)
  assert.doesNotMatch(err.join(''), /replaced/)

  // The seed is the sink's persisted identity, at the per-plugin default path.
  const persistedPath = path.join(hypHome, 'hypaware', 'plugins', '@hypaware/central', 'identity.json')
  const persisted = JSON.parse(await fs.readFile(persistedPath, 'utf8'))
  assert.deepEqual(persisted, {
    jwt: 'gw-jwt',
    expires_at: 1_920_000_000,
    gateway_id: 'gw-1',
    central_url: 'https://hyp.internal',
    origin: 'login',
  })

  // Two scopes, two stores (D1): the query record carries no gateway fields.
  const raw = await fs.readFile(path.join(hypHome, 'hypaware', 'remote-credentials.json'), 'utf8')
  assert.ok(!raw.includes('gw-jwt'))
  assert.ok(!raw.includes('gateway'))
})

test('a configured persisted_path is honored and non-matching central sinks are not seeded', async () => {
  const hypHome = await tmpHome()
  const seedPath = path.join(hypHome, 'custom-identity.json')
  const otherPath = path.join(hypHome, 'other-identity.json')
  const { ctx } = await makeCtx({
    hypHome,
    sinks: {
      fwd: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: { persisted_path: seedPath } } },
      other: { plugin: '@hypaware/central', config: { url: 'https://elsewhere.example', identity: { persisted_path: otherPath } } },
    },
  })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 0)
  const persisted = JSON.parse(await fs.readFile(seedPath, 'utf8'))
  assert.equal(persisted.central_url, 'https://hyp.internal')
  // The second central target's sink is never touched by this login.
  await assert.rejects(fs.access(otherPath))
})

test('a gateway credential with no matching central sink provisions one, forwarding from one command (LLP 0063 D2)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())

  // --no-daemon keeps the test off the real launchd/systemd install.
  const code = await runRemoteLogin(['prod', '--no-daemon'], ctx, { login })
  assert.equal(code, 0)
  assert.match(out.join(''), /forwarding logs to https:\/\/hyp\.internal/)
  // --no-daemon: there is no reconcile to wait on, so no capture line, just the
  // finish-enrolling note. The stale "nothing is captured yet" hint is gone.
  assert.match(out.join(''), /daemon install skipped \(--no-daemon\)/)
  assert.doesNotMatch(out.join(''), /nothing is captured yet/)
  assert.doesNotMatch(out.join(''), /capturing /)

  // The sink was written to the central-seed layer (not the user's local config).
  const seed = JSON.parse(await fs.readFile(path.join(hypHome, 'hypaware', 'config-control', 'seed.json'), 'utf8'))
  assert.equal(seed.sinks.central.plugin, '@hypaware/central')
  assert.equal(seed.sinks.central.config.url, 'https://hyp.internal') // origin, not the /mcp target
  assert.ok(!('bootstrap_token' in (seed.sinks.central.config.identity ?? {}))) // login-minted identity, no token

  // The login-minted gateway was seeded into the new sink's identity.
  const persisted = JSON.parse(await fs.readFile(path.join(hypHome, 'hypaware', 'plugins', '@hypaware/central', 'identity.json'), 'utf8'))
  assert.equal(persisted.jwt, 'gw-jwt')
  assert.equal(persisted.origin, 'login')
})

test('an enrolling login waits for the reconcile and reports the clients that actually attached', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  // Skip the real daemon install; the reconcile is what we simulate below.
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 0 }))
  // The daemon's first reconcile attaches both clients: the wait observes it.
  const waitForAttach = /** @type {any} */ (async () => ['@hypaware/claude', '@hypaware/codex'])

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 0)
  assert.match(out.join(''), /forwarding logs to https:\/\/hyp\.internal/)
  // Ground truth, not a guess: name the clients that captured.
  assert.match(out.join(''), /capturing @hypaware\/claude, @hypaware\/codex/)
  assert.doesNotMatch(out.join(''), /nothing is captured yet/)
  assert.doesNotMatch(out.join(''), /no clients attached yet/)
})

test('an enrolling login into an org with no config times out the wait and points at hyp status', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 0 }))
  // No client ever attaches (no org config, or a slow pull): the wait times out.
  const waitForAttach = /** @type {any} */ (async () => [])

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 0)
  assert.match(out.join(''), /forwarding logs to https:\/\/hyp\.internal/)
  assert.match(out.join(''), /no clients attached yet - check 'hyp status', or run 'hyp attach <client>' to capture/)
})

test('a failed daemon install reports it and does not wait for attach', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 3 }))
  let waited = false
  const waitForAttach = /** @type {any} */ (async () => { waited = true; return [] })

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 3)
  assert.equal(waited, false)
  assert.match(err.join(''), /the daemon install did not finish - run 'hyp daemon install'/)
  assert.doesNotMatch(out.join(''), /capturing /)
})

test('an enrolling login whose attach poll throws still reports the timeout fallback, not a failure (Major 1)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 0 }))
  // Drive the REAL waitForClientAttach, but make its per-poll probe throw a
  // transient fs error every tick (an EIO the collector's cache walk could raise
  // after the daemon is already installed). The successful enrollment must stand.
  const probe = /** @type {any} */ (async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) })
  const waitForAttach = /** @type {any} */ (
    (/** @type {any} */ opts) => waitForClientAttach({ ...opts, probe, timeoutMs: 0, intervalMs: 1, sleep: async () => {} })
  )

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 0) // the throw did not discard the enrollment
  assert.match(out.join(''), /forwarding logs to https:\/\/hyp\.internal/)
  assert.match(out.join(''), /no clients attached yet - check 'hyp status', or run 'hyp attach <client>' to capture/)
})

test('the enrolling login announces the attach wait on stderr before polling (Major 2)', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 0 }))
  // Capture stderr at the instant the wait begins: the progress line must
  // already be there, proving it was emitted before any polling.
  let errAtWait = ''
  const waitForAttach = /** @type {any} */ (async () => { errAtWait = err.join(''); return [] })

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 0)
  assert.match(errAtWait, /waiting for the daemon to attach clients/)
})

test('waitForClientAttach returns attached client names as soon as the reconcile lands', async () => {
  let calls = 0
  // Not attached on the first two polls, then both clients attach. Returned
  // unsorted so the assertion also proves waitForClientAttach orders them.
  const probe = /** @type {any} */ (async () => {
    calls += 1
    return calls >= 3 ? ['@hypaware/codex', '@hypaware/claude'] : []
  })
  let slept = 0
  const sleep = /** @type {any} */ (async () => { slept += 1 })

  const names = await waitForClientAttach({ env: {}, timeoutMs: 10_000, intervalMs: 1, probe, sleep })
  // Sorted by waitForClientAttach; both clients reported (Map keys, no dedup needed).
  assert.deepEqual(names, ['@hypaware/claude', '@hypaware/codex'])
  assert.equal(calls, 3)
  assert.equal(slept, 2) // slept between the three polls
})

test('waitForClientAttach returns empty on timeout without hanging', async () => {
  let calls = 0
  const probe = /** @type {any} */ (async () => { calls += 1; return [] })
  const sleep = /** @type {any} */ (async () => {})

  const names = await waitForClientAttach({ env: {}, timeoutMs: 0, intervalMs: 1, probe, sleep })
  assert.deepEqual(names, [])
  assert.ok(calls >= 1)
})

test('waitForClientAttach swallows a probe that throws mid-poll and still times out to empty (Major 1)', async () => {
  let calls = 0
  // A transient fs error (EMFILE/EACCES/EIO) during a poll — the exact throw the
  // full-collector cache walk could surface — must not escape as a login failure.
  const probe = /** @type {any} */ (async () => {
    calls += 1
    throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
  })
  const sleep = /** @type {any} */ (async () => {})

  const names = await waitForClientAttach({ env: {}, timeoutMs: 0, intervalMs: 1, probe, sleep })
  assert.deepEqual(names, []) // the throw was swallowed; timed out to the fallback
  assert.ok(calls >= 1)
})

test('--no-forward signs in for queries only and provisions nothing (LLP 0063 D3)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod', '--no-forward'], ctx, { login })
  assert.equal(code, 0)
  assert.match(out.join(''), /signed in for queries only/)
  assert.doesNotMatch(out.join(''), /provisioned/)
  // No sink and no forward identity were written.
  await assert.rejects(fs.access(path.join(hypHome, 'hypaware', 'config-control', 'seed.json')))
  await assert.rejects(fs.access(path.join(hypHome, 'hypaware', 'plugins', '@hypaware/central', 'identity.json')))
})

test('login to a different server than the one this machine is enrolled to is rejected before the browser (LLP 0063 D4)', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({
    hypHome,
    remotes: { prod: { url: 'https://hyp.internal/mcp' }, other: { url: 'https://elsewhere.example/mcp' } },
  })
  // Enrolled to hyp.internal via the central layer (what join/login writes).
  await writeCentralSeed(hypHome, 'https://hyp.internal')
  let called = false
  const login = /** @type {any} */ (async () => { called = true; return gatewaySession() })

  const code = await runRemoteLogin(['other'], ctx, { login })
  assert.equal(code, 2)
  assert.equal(called, false) // rejected before any auth
  assert.match(err.join(''), /this machine is connected to https:\/\/hyp\.internal/)
  assert.match(err.join(''), /'hyp leave'/)
})

test('a hand-authored LOCAL central sink is not an enrollment and does not block login to a different server (LLP 0063 D4)', async () => {
  const hypHome = await tmpHome()
  // The central sink lives in the user-owned LOCAL config (via makeCtx `sinks`),
  // not the central layer. `hyp leave` refuses to touch it, so if the D4 gate
  // counted it the user would be stuck in a loop with unactionable advice.
  const { ctx } = await makeCtx({
    hypHome,
    remotes: { prod: { url: 'https://hyp.internal/mcp' }, other: { url: 'https://elsewhere.example/mcp' } },
    sinks: { mine: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
  })
  let called = false
  // No gateway minted, so nothing is provisioned; we only assert the gate let us through.
  const login = /** @type {any} */ (async () => { called = true; return { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' } })

  const code = await runRemoteLogin(['other'], ctx, { login })
  assert.equal(code, 0)
  assert.equal(called, true) // the local sink did NOT block the login
})

test('--no-forward on an already-enrolled machine reports the truth (stays enrolled), not "not enrolled" (LLP 0063 D3)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome, remotes: { prod: { url: 'https://hyp.internal/mcp' } } })
  await writeCentralSeed(hypHome, 'https://hyp.internal') // already enrolled to prod's origin
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod', '--no-forward'], ctx, { login })
  assert.equal(code, 0)
  assert.match(out.join(''), /stays enrolled and keeps forwarding/)
  assert.doesNotMatch(out.join(''), /is not enrolled and will not forward/)
})

test('a failure seeding the identity rolls the provisioned seed back so no credential-less sink lingers (LLP 0063)', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  // Make the real seedLoginGateway's identity write fail: put a directory where
  // identity.json must be written, so the atomic rename cannot land.
  const idPath = path.join(hypHome, 'hypaware', 'plugins', '@hypaware/central', 'identity.json')
  await fs.mkdir(idPath, { recursive: true })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 1)
  assert.match(err.join(''), /enrollment failed/)
  // The seed must NOT be left committed on disk (rollback), or the daemon would
  // demand a bootstrap token the login user does not have.
  await assert.rejects(fs.access(path.join(hypHome, 'hypaware', 'config-control', 'seed.json')))
})

test('a session without a gateway credential seeds nothing and prints no forwarding output', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({
    hypHome,
    sinks: { fwd: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
  })
  const login = /** @type {any} */ (async () => ({
    refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme',
  }))

  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 0)
  // The pre-auth notice (D3) is on stderr and conditional; the point here is
  // that with no gateway minted, nothing is actually seeded or provisioned.
  assert.doesNotMatch(out.join(''), /seeded|provisioned/)
  const persistedPath = path.join(hypHome, 'hypaware', 'plugins', '@hypaware/central', 'identity.json')
  await assert.rejects(fs.access(persistedPath))
})

test('replacing a bootstrap-minted identity is reported, never silent (LLP 0061 D4)', async () => {
  const hypHome = await tmpHome()
  const persistedPath = path.join(hypHome, 'identity.json')
  await fs.writeFile(persistedPath, JSON.stringify({
    jwt: 'old-jwt', expires_at: 1_910_000_000, gateway_id: 'gw-boot',
    central_url: 'https://hyp.internal', bootstrap_token_fp: 'fp',
  }))
  const { ctx, err } = await makeCtx({
    hypHome,
    sinks: { fwd: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: { persisted_path: persistedPath } } } },
  })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 0)
  assert.match(err.join(''), /replaced a bootstrap-minted gateway identity \(was gateway gw-boot\)/)
})

test('a seed write failure reports signed-in-but-not-seeded, not a login failure', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({
    hypHome,
    sinks: { fwd: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
  })
  const login = /** @type {any} */ (async () => gatewaySession())
  const seed = /** @type {any} */ (async () => { throw new Error('disk is sad') })

  const code = await runRemoteLogin(['prod'], ctx, { login, seed })
  assert.equal(code, 1)
  assert.match(out.join(''), /logged in to 'prod'/)
  assert.match(err.join(''), /signed in, but could not seed the forwarding credential: disk is sad/)
})

test('the host label defaults to the machine hostname and --host overrides it (LLP 0061 D6)', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  /** @type {any} */ let seen
  const login = /** @type {any} */ (async (/** @type {any} */ args) => {
    seen = args
    return { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' }
  })

  await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(seen.host, os.hostname())

  await runRemoteLogin(['prod', '--host', 'lab-box'], ctx, { login })
  assert.equal(seen.host, 'lab-box')
})

test('--host as the last arg with no value is a usage error', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const code = await runRemoteLogin(['prod', '--host'], ctx, {})
  assert.equal(code, 2)
  assert.match(err.join(''), /--host expects a host label/)
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

test('a missing target name resolves the default (built-in) target; a value flag is not misread as the name', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  /** @type {any} */
  let seen = null
  const login = /** @type {any} */ (async (opts) => {
    seen = opts
    return { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' }
  })
  // `--org acme` with no positional name resolves the shipped default target
  // (the central server), and is never read as target 'acme'.
  const code = await runRemoteLogin(['--org', 'acme'], ctx, { login })
  assert.equal(code, 0)
  assert.ok(seen)
  assert.match(seen.identityBase, /hypaware\.hyperparam\.app/)
  assert.equal(seen.org, 'acme')
  assert.match(out.join(''), /logged in to 'hyperparam' as org 'acme'/)
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

/* --------------------------------------------------------------------------
 * Login-time local-only directory picker wiring (LLP 0081 T7, issue #281):
 * the picker runs once the login-minted gateway is seeded, and (after the
 * issue #281 reordering) at the point each fork's local cache is populated:
 * the fresh-enroll fork after the daemon attaches and backfills, the
 * re-login/re-seed fork against the cache a prior daemon already filled.
 * These tests inject a `picker` test double (the same pattern as
 * `login`/`seed`) rather than exercising the real interactive prompt, which
 * `test/core/local-only-command.test.js` already covers.
 * ------------------------------------------------------------------------ */

test('the local-only picker runs after enrollCentralSink provisions the sink on --no-daemon (ordering, issue #281)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  const seedPath = path.join(hypHome, 'hypaware', 'config-control', 'seed.json')

  /** @type {boolean | null} */
  let seedExistedWhenPickerRan = null
  /** @type {any} */
  let seenArgs = null
  const picker = /** @type {any} */ (async (args) => {
    seenArgs = args
    seedExistedWhenPickerRan = await fs.access(seedPath).then(() => true, () => false)
    return { outcome: 'no_candidates', candidateCount: 0, selectedCount: 0, excludedDirs: [] }
  })

  // --no-daemon keeps the test off the real launchd/systemd install; the sink
  // is still provisioned (the seed is written) before the picker runs. Because
  // no forwarding daemon exists yet on this path, the list still lands before
  // any export (R6 holds for --no-daemon).
  const code = await runRemoteLogin(['prod', '--no-daemon'], ctx, { login, picker })
  assert.equal(code, 0)
  assert.equal(seedExistedWhenPickerRan, true, 'the picker now runs after the sink is provisioned (issue #281 reordering)')
  assert.equal(seenArgs.stateDir, path.join(hypHome, 'hypaware'))
  await fs.access(seedPath)
  assert.match(out.join(''), /forwarding logs to https:\/\/hyp\.internal/)
})

test('on a fresh enroll the picker runs after attach+backfill and sees the now-populated cache, not the empty pre-enroll one (issue #281)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())

  /** @type {string[]} */
  const order = []
  // The local cache is empty until the daemon attaches and its post-attach
  // backfill (LLP 0037/0044) lands rows. Model that: the attach wait flips the
  // captured set from empty to populated, and the captured-directory wait
  // returns whatever is captured at the instant it runs.
  /** @type {any[]} */
  let captured = []
  const enroll = /** @type {any} */ (async () => { order.push('enroll'); return { provisioned: true, daemonCode: 0 } })
  const waitForAttach = /** @type {any} */ (async () => {
    order.push('attach')
    captured = [{ cwd: '/work/proj', repoRoot: '/work/proj', rows: 42, lastSeen: '2026-07-07' }]
    return ['@hypaware/claude']
  })
  const waitForCaptured = /** @type {any} */ (async () => captured)

  let pickerSawCount = -1
  const picker = /** @type {any} */ (async (/** @type {any} */ args) => {
    order.push('picker')
    const list = args.listCandidates ? await args.listCandidates() : null
    pickerSawCount = Array.isArray(list) ? list.length : 0
    return { outcome: 'none', candidateCount: pickerSawCount, selectedCount: 0, excludedDirs: [] }
  })

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach, waitForCaptured, picker })
  assert.equal(code, 0)
  // The fix: the picker runs only after enrollment and the attach/backfill
  // wait, so it enumerates the populated cache. Before the fix it ran first,
  // against the empty pre-enroll cache: the silent-skip bug of issue #281.
  assert.deepEqual(order, ['enroll', 'attach', 'picker'])
  assert.equal(pickerSawCount, 1, 'the picker must see the backfilled candidate, not an empty pre-enroll cache')
  assert.match(out.join(''), /capturing @hypaware\/claude/)
})

test('--no-forward never invokes the local-only picker', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  let pickerCalled = false
  const picker = /** @type {any} */ (async () => {
    pickerCalled = true
    return { outcome: 'no_candidates', candidateCount: 0, selectedCount: 0, excludedDirs: [] }
  })

  const code = await runRemoteLogin(['prod', '--no-forward'], ctx, { login, picker })
  assert.equal(code, 0)
  assert.equal(pickerCalled, false)
})

test('a query-only login (no gateway credential minted) never invokes the local-only picker', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => ({
    refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme',
  }))
  let pickerCalled = false
  const picker = /** @type {any} */ (async () => {
    pickerCalled = true
    return { outcome: 'no_candidates', candidateCount: 0, selectedCount: 0, excludedDirs: [] }
  })

  const code = await runRemoteLogin(['prod'], ctx, { login, picker })
  assert.equal(code, 0)
  assert.equal(pickerCalled, false)
})

test('a real (non-injected) picker on a non-TTY login completes the browser flow unchanged (LLP 0072 #tty)', async () => {
  const hypHome = await tmpHome()
  // makeCtx's stderr has no `isTTY`, so the default-wired real picker cannot
  // reach an interactive prompt here; it must resolve to a no-op.
  const { ctx, out } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())

  // No `picker` dep supplied: exercises the real `runLocalOnlyPicker` wired
  // by `runRemoteLogin`'s defaults. The login must complete exactly as it
  // did before this wiring existed.
  const code = await runRemoteLogin(['prod', '--no-daemon'], ctx, { login })
  assert.equal(code, 0)
  assert.match(out.join(''), /forwarding logs to https:\/\/hyp\.internal/)
  // --no-daemon: no reconcile to wait on, so no capture line; the stale
  // "nothing is captured yet" hint is gone under #259's attach-wait rework.
  assert.match(out.join(''), /daemon install skipped \(--no-daemon\)/)
  assert.doesNotMatch(out.join(''), /nothing is captured yet/)
  assert.doesNotMatch(out.join(''), /capturing /)
})

test('a re-login (already-enrolled, re-seed path) still shows the local-only picker', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({
    hypHome,
    sinks: { fwd: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
  })
  const login = /** @type {any} */ (async () => gatewaySession())
  let pickerCalled = false
  const picker = /** @type {any} */ (async () => {
    pickerCalled = true
    return { outcome: 'no_candidates', candidateCount: 0, selectedCount: 0, excludedDirs: [] }
  })

  const code = await runRemoteLogin(['prod'], ctx, { login, picker })
  assert.equal(code, 0)
  assert.equal(pickerCalled, true)
  assert.match(out.join(''), /seeded forwarding identity for sink 'fwd'/)
})

test('a non-cancellation picker error is warned and never breaks enrollment', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  const picker = /** @type {any} */ (async () => { throw new Error('corrupt local-only list') })

  const code = await runRemoteLogin(['prod', '--no-daemon'], ctx, { login, picker })
  assert.equal(code, 0)
  assert.match(err.join(''), /could not run the local-only directory picker.*corrupt local-only list/)
  assert.match(out.join(''), /forwarding logs to https:\/\/hyp\.internal/)
})
