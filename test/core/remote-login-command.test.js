// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { remoteLogin, runRemoteLogin, runRemoteRemove, waitForCentralConverge, waitForClientAttach } from '../../src/core/cli/remote_commands.js'
import { daemonIncompleteNote } from '../../src/core/daemon/platform.js'
import { hasAppliedCentralConfig } from '../../src/core/config/apply.js'
import { effectiveDefaultRemote } from '../../src/core/remote/builtin_remotes.js'
import { deriveIdentityBase, readCredentials } from '../../src/core/remote/credentials.js'
import { computeFirstSyncDeadline, firstSyncHoldMarkerPath, formatFirstSyncDeadline, readFirstSyncDeadline } from '../../src/core/usage-policy/first_sync_hold.js'

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
 * enrolling login writes), so the D4 gate sees a real enrollment, as opposed
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

/**
 * Enroll a machine and then corrupt the layer: the central layer file is on
 * disk (which is what `hyp leave` and the apply engine treat as enrollment)
 * but does not parse, so the D4 gate cannot read its own input.
 * @param {string} hypHome
 */
async function writeUnreadableCentralSeed(hypHome) {
  const seedPath = path.join(hypHome, 'hypaware', 'config-control', 'seed.json')
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, '{ "version": 2, "sinks": {')
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

// --- the outcome the wizard reads (LLP 0179 #outcome) ---
// @ref LLP 0179#outcome [tests]:

test('a server refusal is reported as its own reason, not just an exit code', async () => {
  for (const [callbackError, reason] of [
    ['no_membership', 'no_membership'],
    ['org_not_permitted', 'org_not_permitted'],
    ['org_selection_required', 'org_selection_required'],
    ['access_denied', 'denied'],
    // A refusal code we do not model reads as retriable: telling a user to
    // stop trying over a code we cannot interpret is the worse error.
    ['some_new_server_refusal', 'login_failed'],
  ]) {
    const { ctx, err } = await makeCtx({ hypHome: await tmpHome() })
    const login = /** @type {any} */ (async () => {
      throw Object.assign(new Error(`login failed: ${callbackError}`), { callbackError })
    })
    const outcome = await remoteLogin(['prod'], ctx, { login })
    assert.deepEqual(outcome, { exitCode: 1, reason }, callbackError)
    // The lane still explains itself in prose; the reason is additional, not a
    // replacement.
    assert.match(err.join(''), /^hyp remote login: .+$/m, callbackError)
  }
})

test('a local failure with no server code is retriable, and a success is ok', async () => {
  const { ctx: failCtx } = await makeCtx({ hypHome: await tmpHome() })
  const timeout = /** @type {any} */ (async () => { throw new Error('timed out waiting for the browser login to complete') })
  assert.deepEqual(await remoteLogin(['prod'], failCtx, { login: timeout }), { exitCode: 1, reason: 'login_failed' })

  const { ctx: okCtx } = await makeCtx({ hypHome: await tmpHome() })
  const login = /** @type {any} */ (async () => ({ refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' }))
  assert.deepEqual(await remoteLogin(['prod'], okCtx, { login }), { exitCode: 0, reason: 'ok' })
})

test('post-auth failures name their step rather than collapsing into the login failure', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  // A plain file where the state dir must be makes the session write throw.
  await fs.writeFile(path.join(hypHome, 'hypaware'), 'not a dir')
  const login = /** @type {any} */ (async () => ({ refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' }))
  assert.deepEqual(await remoteLogin(['prod'], ctx, { login }), { exitCode: 1, reason: 'store_failed' })

  // The seed, the enroll, and the daemon install are three more steps that run
  // after a sign-in that worked; each names itself rather than reporting the
  // login as the thing that failed.
  const gwLogin = /** @type {any} */ (async () => gatewaySession())
  const { ctx: seedCtx } = await makeCtx({
    hypHome: await tmpHome(),
    sinks: { fwd: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
  })
  const seed = /** @type {any} */ (async () => { throw new Error('disk is sad') })
  assert.deepEqual(await remoteLogin(['prod'], seedCtx, { login: gwLogin, seed }), { exitCode: 1, reason: 'seed_failed' })

  const { ctx: enrollCtx } = await makeCtx({ hypHome: await tmpHome() })
  const enrollThrows = /** @type {any} */ (async () => { throw new Error('server unreachable') })
  assert.deepEqual(
    await remoteLogin(['prod'], enrollCtx, { login: gwLogin, enroll: enrollThrows }),
    { exitCode: 1, reason: 'enroll_failed' }
  )

  // An incomplete daemon install carries the installer's own code out, so the
  // outcome is not `exitCode: 1` and not `'ok'` either.
  const { ctx: daemonCtx } = await makeCtx({ hypHome: await tmpHome() })
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 3 }))
  const waitForAttach = /** @type {any} */ (async () => [])
  assert.deepEqual(
    await remoteLogin(['prod'], daemonCtx, { login: gwLogin, enroll, waitForAttach }),
    { exitCode: 3, reason: 'daemon_incomplete' }
  )
})

test('a usage error and the exclusivity gate are distinguishable, both exit 2', async () => {
  const { ctx: usageCtx } = await makeCtx({ hypHome: await tmpHome() })
  assert.deepEqual(await remoteLogin(['prod', '--org'], usageCtx, {}), { exitCode: 2, reason: 'usage' })

  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  await writeCentralSeed(hypHome, 'https://elsewhere.example')
  const login = /** @type {any} */ (async () => { throw new Error('the browser must never open here') })
  assert.deepEqual(await remoteLogin(['prod'], ctx, { login }), { exitCode: 2, reason: 'connected_elsewhere' })
})

test('runRemoteLogin stays the exit-code adapter over the same run', async () => {
  const { ctx } = await makeCtx({ hypHome: await tmpHome() })
  const login = /** @type {any} */ (async () => ({ refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' }))
  assert.equal(await runRemoteLogin(['prod'], ctx, { login }), 0)
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

test('compact login (the wizard join lane) prints one line per event and no privacy block', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod', '--no-daemon'], ctx, { login, compact: true })
  assert.equal(code, 0)
  const text = out.join('') + err.join('')
  // LLP 0063 D3 mechanic 1 names what the notice must say, and asks for the
  // copy to be pinned verbatim: it is the consent surface, so compact may lose
  // the line breaks but not the hedge and not one of the three consequences
  // (forwarding, org config that attaches clients and backfills local history,
  // the background service).
  assert.match(
    text,
    /^note: if your org has enabled forwarding, signing in enrolls this machine: it forwards captured logs to the server, applies org config \(which can attach clients and backfill existing local history\), and installs a background service \(Ctrl-C to cancel\)$/m,
    'the pre-auth notice keeps its hedge and all three consequences, as one line'
  )
  assert.match(text, /✓ Signed in to 'prod' as org /)
  assert.match(text, /✓ Forwarding to the 'prod' server \(run 'hyp remote list' to see its URL\)/)
  assert.match(text, /✓ First sync no later than .+; nothing has been uploaded yet/)
  // The send-now offer (LLP 0203) runs only on an attended, uncancelled close,
  // and the deadline itself just lapses (LLP 0101 #no-release), so the line
  // must not promise a prompt.
  assert.doesNotMatch(text, /you will be asked/)
  assert.doesNotMatch(text, /PRIVACY - review before first sync/)
  assert.doesNotMatch(text, /forwarding logs to the/)
  assert.doesNotMatch(text, /tip: mark a directory local-only/)
})

test('a gateway credential with no matching central sink provisions one, forwarding from one command (LLP 0063 D2)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())

  // --no-daemon keeps the test off the real launchd/systemd install.
  const code = await runRemoteLogin(['prod', '--no-daemon'], ctx, { login })
  assert.equal(code, 0)
  assert.match(out.join(''), /forwarding logs to the 'prod' server/)
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
  assert.match(out.join(''), /forwarding logs to the 'prod' server/)
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
  assert.match(out.join(''), /forwarding logs to the 'prod' server/)
  assert.match(out.join(''), /no clients attached yet - check 'hyp status', or run 'hyp client attach <client>' to capture/)
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
  // The platform-invariant half of the note: it reports a missing background
  // service over a completed enrollment. Which remediation follows is the
  // platform's business, and daemonIncompleteNote's own tests below pin both
  // branches, so asserting one of them here would fail the suite on win32.
  assert.match(err.join(''), /note: enrolled, but /)
  assert.doesNotMatch(out.join(''), /capturing /)
})

// The note reports a missing background service, never a failed sign-in, and
// its remediation only prints where it can work: on a platform with no service
// manager no `hyp daemon install` run would finish, so naming one is advice
// that cannot help (#978).
test('daemonIncompleteNote: names the retry on a supported platform and never claims sign-in failed', () => {
  for (const platform of /** @type {const} */ (['darwin', 'linux'])) {
    const note = daemonIncompleteNote(platform, 'enrolled')
    assert.match(note, /^note: enrolled, but the daemon install did not finish - run 'hyp daemon install'\n$/)
  }
})

test('daemonIncompleteNote: a platform with no service manager is not told to retry the install', () => {
  const note = daemonIncompleteNote('win32', 'enrolled')
  assert.match(note, /^note: enrolled, but /)
  assert.doesNotMatch(note, /hyp daemon install/)
  assert.match(note, /nothing is captured on this machine/)
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
  assert.match(out.join(''), /forwarding logs to the 'prod' server/)
  assert.match(out.join(''), /no clients attached yet - check 'hyp status', or run 'hyp client attach <client>' to capture/)
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
  // A transient fs error (EMFILE/EACCES/EIO) during a poll, the exact throw the
  // full-collector cache walk could surface, must not escape as a login failure.
  const probe = /** @type {any} */ (async () => {
    calls += 1
    throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
  })
  const sleep = /** @type {any} */ (async () => {})

  const names = await waitForClientAttach({ env: {}, timeoutMs: 0, intervalMs: 1, probe, sleep })
  assert.deepEqual(names, []) // the throw was swallowed; timed out to the fallback
  assert.ok(calls >= 1)
})

// `waitForCentralConverge` (LLP 0129 #join-before-picker, LLP 0223) polls
// for the applied org-config slot, so the wizard join phase converges when
// the config lands even if it attaches no clients on this machine.
test('waitForCentralConverge: the applied slot is convergence (ok:true)', async () => {
  let calls = 0
  const probe = /** @type {any} */ (async () => { calls += 1; return calls >= 2 })
  const sleep = /** @type {any} */ (async () => {})
  const verdict = await waitForCentralConverge({ env: {}, probe, sleep }, { timeoutMs: 10_000, intervalMs: 1 })
  assert.deepEqual(verdict, { ok: true })
})

test('waitForCentralConverge: a timeout is the no-org-config steady state (ok:false)', async () => {
  const probe = /** @type {any} */ (async () => false)
  const sleep = /** @type {any} */ (async () => {})
  const verdict = await waitForCentralConverge({ env: {}, probe, sleep }, { timeoutMs: 0, intervalMs: 1 })
  assert.deepEqual(verdict, { ok: false })
})

test('waitForCentralConverge: a throwing probe is "not converged this tick", polled to timeout', async () => {
  let calls = 0
  const probe = /** @type {any} */ (async () => { calls += 1; throw new Error('EACCES') })
  const sleep = /** @type {any} */ (async () => {})
  const verdict = await waitForCentralConverge({ env: {}, probe, sleep }, { timeoutMs: 0, intervalMs: 1 })
  assert.deepEqual(verdict, { ok: false })
  assert.ok(calls >= 1)
})

// The default probe reads the real on-disk fact (LLP 0223): the active-slot
// pointer under config-control/ converges; the join seed alone does not.
test('waitForCentralConverge: default probe converges on the active slot, never the seed', async () => {
  const hypHome = await tmpHome()
  const env = { HYP_HOME: hypHome }
  const controlDir = path.join(hypHome, 'hypaware', 'config-control')

  // A host with no control directory at all (nothing enrolled yet) is a
  // clean "not converged", not a probe error the loop has to swallow.
  const neverJoined = await waitForCentralConverge({ env }, { timeoutMs: 0, intervalMs: 1 })
  assert.deepEqual(neverJoined, { ok: false })

  await fs.mkdir(controlDir, { recursive: true })

  await fs.writeFile(path.join(controlDir, 'seed.json'), '{"version": 2}\n')
  const seedOnly = await waitForCentralConverge({ env }, { timeoutMs: 0, intervalMs: 1 })
  assert.deepEqual(seedOnly, { ok: false })

  await fs.writeFile(path.join(controlDir, 'config.a.json'), '{"version": 2}\n')
  await fs.symlink('config.a.json', path.join(controlDir, 'active'))
  const applied = await waitForCentralConverge({ env }, { timeoutMs: 0, intervalMs: 1 })
  assert.deepEqual(applied, { ok: true })
})

// The probe error branch is only reachable because the default probe throws
// on a pointer it cannot read instead of folding it into "not converged".
// Without this the branch is dead code in production and a stuck host is
// indistinguishable from the no-org-config steady state.
test('waitForCentralConverge: an unreadable active pointer reaches the probe-error branch', async () => {
  const hypHome = await tmpHome()
  const env = { HYP_HOME: hypHome }
  const stateRoot = path.join(hypHome, 'hypaware')
  const controlDir = path.join(stateRoot, 'config-control')
  await fs.mkdir(controlDir, { recursive: true })

  // A control directory that simply holds nothing yet is the silent steady
  // state: not converged, nothing to report.
  assert.equal(hasAppliedCentralConfig({ stateRoot }), false)

  // An `active` that is not a symlink is a pointer this process cannot read
  // (readlink EINVAL), which the probe surfaces rather than swallows.
  await fs.writeFile(path.join(controlDir, 'active'), 'config.a.json')
  assert.throws(() => hasAppliedCentralConfig({ stateRoot }))

  // The wait still degrades to the unlocked-picker fallback, never an error.
  const verdict = await waitForCentralConverge({ env }, { timeoutMs: 0, intervalMs: 1 })
  assert.deepEqual(verdict, { ok: false })
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

// The codec accepts `--flag=true` for a boolean, so the gate blessed
// `--no-forward=true` while `argv.includes('--no-forward')` did not see it:
// the opt-out was dropped in silence and the machine enrolled for forwarding.
test('--no-forward=true is the same opt-out as the bare flag (LLP 0063 D3)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod', '--no-forward=true'], ctx, { login })
  assert.equal(code, 0)
  assert.match(out.join(''), /signed in for queries only/)
  await assert.rejects(fs.access(path.join(hypHome, 'hypaware', 'config-control', 'seed.json')))
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

test('an unreadable central layer fails the D4 gate CLOSED: login to a different server is rejected (LLP 0063 D4)', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({
    hypHome,
    remotes: { prod: { url: 'https://hyp.internal/mcp' }, other: { url: 'https://elsewhere.example/mcp' } },
  })
  // The central layer is on disk (so the machine is enrolled by every other
  // definition the codebase uses: `hyp leave` and apply.js key on the file),
  // but it does not parse, so the gate cannot read which origin it is enrolled
  // to. It must refuse, not permit a second org's enrollment.
  await writeUnreadableCentralSeed(hypHome)
  let called = false
  const login = /** @type {any} */ (async () => { called = true; return gatewaySession() })

  const code = await runRemoteLogin(['other'], ctx, { login })
  assert.equal(code, 2)
  assert.equal(called, false) // rejected before any auth
  // Name the real problem (the unreadable layer), not the misleading "not connected".
  assert.match(err.join(''), /central config layer .* cannot be read/)
  assert.match(err.join(''), /seed\.json/)
  assert.doesNotMatch(err.join(''), /this machine is connected to/)
  // And the advice is actionable: `hyp leave` keys on the file, not its contents.
  assert.match(err.join(''), /'hyp leave'/)
})

test('an unreadable central layer also refuses a same-origin re-login: the gate cannot tell it is the same (LLP 0063 D4)', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome, remotes: { prod: { url: 'https://hyp.internal/mcp' } } })
  await writeUnreadableCentralSeed(hypHome)
  let called = false
  const login = /** @type {any} */ (async () => { called = true; return gatewaySession() })

  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 2)
  assert.equal(called, false)
  assert.match(err.join(''), /cannot be read/)
})

test('an active-slot pointer naming a file that is gone is unreadable, not absent (LLP 0063 D4)', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({
    hypHome,
    remotes: { prod: { url: 'https://hyp.internal/mcp' }, other: { url: 'https://elsewhere.example/mcp' } },
  })
  // The apply engine only ever flips the pointer AFTER writing its slot file,
  // so a pointer whose slot is missing is an applied-to (enrolled) machine
  // whose layer was removed out of band, not a machine that never enrolled.
  // `hyp leave` calls it connected and tears it down; the gate must agree.
  const control = path.join(hypHome, 'hypaware', 'config-control')
  await fs.mkdir(control, { recursive: true })
  await fs.symlink('config.a.json', path.join(control, 'active'))
  let called = false
  const login = /** @type {any} */ (async () => { called = true; return gatewaySession() })

  const code = await runRemoteLogin(['other'], ctx, { login })
  assert.equal(code, 2)
  assert.equal(called, false)
  assert.match(err.join(''), /central config layer .* cannot be read/)
  assert.match(err.join(''), /config\.a\.json/)
})

test('a central layer whose PATH cannot be resolved fails the D4 gate CLOSED too (LLP 0063 D4)', async () => {
  // Round 1 closed "the layer does not load". Resolution is lossy one level
  // above that: `readActiveSlot` swallows every readlink error into null, so a
  // damaged pointer makes an enrolled machine look like it never joined even
  // though the slot file still names the org's server verbatim. Repairing the
  // pointer brings that enrollment straight back, so the gate must refuse.
  for (const [name, writePointer] of /** @type {[string, (dir: string) => Promise<unknown>][]} */ ([
    ['pointer replaced by a regular file', (dir) => fs.writeFile(path.join(dir, 'active'), 'config.a.json')],
    ['pointer naming neither slot', (dir) => fs.symlink('config.c.json', path.join(dir, 'active'))],
    ['pointer symlink loop', (dir) => fs.symlink('active', path.join(dir, 'active'))],
  ])) {
    const hypHome = await tmpHome()
    const { ctx, err } = await makeCtx({
      hypHome,
      remotes: { prod: { url: 'https://hyp.internal/mcp' }, other: { url: 'https://elsewhere.example/mcp' } },
    })
    const control = path.join(hypHome, 'hypaware', 'config-control')
    await fs.mkdir(control, { recursive: true })
    await fs.writeFile(path.join(control, 'config.a.json'), JSON.stringify({
      version: 2,
      plugins: [{ name: '@hypaware/central' }],
      sinks: { central: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
    }))
    await writePointer(control)
    let called = false
    const login = /** @type {any} */ (async () => { called = true; return gatewaySession() })

    assert.equal(await runRemoteLogin(['other'], ctx, { login }), 2, name)
    assert.equal(called, false, `${name}: rejected before any auth`)
    assert.match(err.join(''), /cannot be read/, name)
    assert.match(err.join(''), /config-control/, name)
  }
})

test('a central layer directory that cannot be listed fails the D4 gate CLOSED (LLP 0063 D4)', async () => {
  // `existsSync` reports EACCES as "not there", so an enrolled machine whose
  // state directory this process cannot read resolved to null and read as free.
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({
    hypHome,
    remotes: { prod: { url: 'https://hyp.internal/mcp' }, other: { url: 'https://elsewhere.example/mcp' } },
  })
  const control = path.join(hypHome, 'hypaware', 'config-control')
  await fs.mkdir(control, { recursive: true })
  await fs.writeFile(path.join(control, 'seed.json'), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
    sinks: { central: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
  }))
  await fs.chmod(control, 0o000)
  let called = false
  const login = /** @type {any} */ (async () => { called = true; return gatewaySession() })
  try {
    assert.equal(await runRemoteLogin(['other'], ctx, { login }), 2)
    assert.equal(called, false)
    assert.match(err.join(''), /failed to read the central config directory/)
  } finally {
    await fs.chmod(control, 0o700)
  }
})

test('an unresolvable pointer does not overshoot: control-dir residue that is not a layer still permits login (LLP 0063 D4)', async () => {
  // What `hyp leave` and `resetCentralLayerToSeed` leave behind (apply state,
  // orphan etags, an empty directory) is not an enrollment, and the widened
  // fail-closed branch must not read it as one.
  for (const [name, seedResidue] of /** @type {[string, (dir: string) => Promise<unknown>][]} */ ([
    ['empty control dir', async () => {}],
    ['apply state and an orphan etag', async (dir) => {
      await fs.writeFile(path.join(dir, 'state.json'), '{}')
      await fs.writeFile(path.join(dir, 'config.a.etag'), 'etag-1')
    }],
  ])) {
    const hypHome = await tmpHome()
    const { ctx } = await makeCtx({
      hypHome,
      remotes: { prod: { url: 'https://hyp.internal/mcp' }, other: { url: 'https://elsewhere.example/mcp' } },
    })
    const control = path.join(hypHome, 'hypaware', 'config-control')
    await fs.mkdir(control, { recursive: true })
    await seedResidue(control)
    let called = false
    const login = /** @type {any} */ (async () => { called = true; return { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' } })

    assert.equal(await runRemoteLogin(['other'], ctx, { login }), 0, name)
    assert.equal(called, true, name)
  }
})

test('an ABSENT central layer is not an enrollment and still permits login (LLP 0063 D4)', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({
    hypHome,
    remotes: { prod: { url: 'https://hyp.internal/mcp' }, other: { url: 'https://elsewhere.example/mcp' } },
  })
  // No central layer file at all: the fail-closed branch must not catch this.
  let called = false
  const login = /** @type {any} */ (async () => { called = true; return { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme' } })

  const code = await runRemoteLogin(['other'], ctx, { login })
  assert.equal(code, 0)
  assert.equal(called, true)
})

test('a PARSEABLE central layer keeps its D4 behavior: same origin re-logs in, different origin is rejected (LLP 0063 D4)', async () => {
  const hypHome = await tmpHome()
  const { ctx: sameCtx, err: sameErr } = await makeCtx({
    hypHome,
    remotes: { prod: { url: 'https://hyp.internal/mcp' }, other: { url: 'https://elsewhere.example/mcp' } },
  })
  await writeCentralSeed(hypHome, 'https://hyp.internal')
  let sameCalled = false
  const sameLogin = /** @type {any} */ (async () => { sameCalled = true; return gatewaySession() })
  assert.equal(await runRemoteLogin(['prod'], sameCtx, { login: sameLogin }), 0)
  assert.equal(sameCalled, true)
  assert.doesNotMatch(sameErr.join(''), /cannot be read/)

  const otherHome = await tmpHome()
  const { ctx: otherCtx, err: otherErr } = await makeCtx({
    hypHome: otherHome,
    remotes: { prod: { url: 'https://hyp.internal/mcp' }, other: { url: 'https://elsewhere.example/mcp' } },
  })
  await writeCentralSeed(otherHome, 'https://hyp.internal')
  let otherCalled = false
  const otherLogin = /** @type {any} */ (async () => { otherCalled = true; return gatewaySession() })
  assert.equal(await runRemoteLogin(['other'], otherCtx, { login: otherLogin }), 2)
  assert.equal(otherCalled, false)
  assert.match(otherErr.join(''), /this machine is connected to https:\/\/hyp\.internal/)
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
  const { ctx, out } = await makeCtx({
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
  // A local failure with no server callbackError (e.g. the poll timeout an
  // abandoned browser flow hits).
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
 * Enrollment-time privacy refinement after the picker's retirement (LLP 0102):
 * every login fork prints the durable-command hint (the client-independent CLI
 * floor stays discoverable) and never prompts. The in-login picker, the
 * post-backfill capture wait, and the fresh-enroll registry refresh are all
 * gone; there is no `picker`/`waitForCaptured`/`freshen` dep to inject.
 * ------------------------------------------------------------------------ */

test('a --no-daemon login prints the durable hint and provisions the sink (LLP 0102)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  const seedPath = path.join(hypHome, 'hypaware', 'config-control', 'seed.json')

  const code = await runRemoteLogin(['prod', '--no-daemon'], ctx, { login })
  assert.equal(code, 0)
  assert.match(err.join(''), /hyp privacy set \[path\] local-only/, 'the durable command stays discoverable')
  await fs.access(seedPath) // the sink is still provisioned
  assert.match(out.join(''), /forwarding logs to the 'prod' server/)
})

test('a fresh enroll prints the durable hint and never polls a capture wait (LLP 0102)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  ctx.stderr.isTTY = true
  const login = /** @type {any} */ (async () => gatewaySession())
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 0 }))
  const waitForAttach = /** @type {any} */ (async () => ['@hypaware/claude'])

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 0)
  assert.match(err.join(''), /hyp privacy set \[path\] local-only/)
  assert.match(out.join(''), /capturing @hypaware\/claude/)
})

test('a failed daemon install still prints the durable hint before returning (LLP 0102)', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 3 }))
  let waited = false
  const waitForAttach = /** @type {any} */ (async () => { waited = true; return [] })

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 3)
  assert.equal(waited, false, 'a failed install does not wait for attach')
  assert.match(err.join(''), /hyp privacy set \[path\] local-only/)
  assert.match(err.join(''), /note: enrolled, but /)
})

test('a re-login (already-enrolled, re-seed path) prints the durable hint (LLP 0102)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({
    hypHome,
    sinks: { fwd: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
  })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 0)
  assert.match(err.join(''), /hyp privacy set \[path\] local-only/)
})

test('the re-seed exit suppresses the durable hint under compact, like the enrolling exits', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({
    hypHome,
    sinks: { fwd: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
  })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod'], ctx, { login, compact: true })
  assert.equal(code, 0)
  assert.doesNotMatch(err.join(''), /hyp privacy set \[path\] local-only/)
})

/* --------------------------------------------------------------------------
 * First-sync export hold (LLP 0101): the attended enrolling login writes the
 * hold marker BEFORE enrollCentralSink (so no daemon tick beats it onto disk)
 * and never clears it (the hold runs to its absolute deadline). `hyp join` and
 * re-logins write no hold (LLP 0101 #which).
 * ------------------------------------------------------------------------ */

/** @param {string} hypHome */
function holdMarkerPathFor(hypHome) {
  return firstSyncHoldMarkerPath(path.join(hypHome, 'hypaware'))
}

/** @param {string} hypHome */
async function holdExists(hypHome) {
  return fs.access(holdMarkerPathFor(hypHome)).then(() => true, () => false)
}

test('a fresh enroll writes the first-sync hold BEFORE enrollCentralSink, with a future deadline (LLP 0101)', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  ctx.stderr.isTTY = true
  const login = /** @type {any} */ (async () => gatewaySession())

  let markerAtEnroll = /** @type {boolean} */ (false)
  const enroll = /** @type {any} */ (async () => {
    // The daemon this installs must never beat the marker onto disk: it is
    // already present by the time enrollCentralSink runs.
    markerAtEnroll = await holdExists(hypHome)
    return { provisioned: true, daemonCode: 0 }
  })
  const waitForAttach = /** @type {any} */ (async () => ['@hypaware/claude'])

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 0)
  assert.equal(markerAtEnroll, true, 'the hold marker lands before enrollCentralSink (LLP 0100 R2)')

  // The hold survives to the end of the login: there is no clear-on-exit; it
  // runs to its deadline (LLP 0101 #no-release).
  const stateDir = path.join(hypHome, 'hypaware')
  const deadline = await readFirstSyncDeadline({ stateDir })
  assert.ok(typeof deadline === 'number' && deadline > Date.now(), 'a future deadline remains after the login returns')
  // The deadline is the next local 11:59pm rule (LLP 0101 #deadline).
  assert.ok(Math.abs(deadline - computeFirstSyncDeadline(Date.now())) < 5 * 60_000)
})

/* --------------------------------------------------------------------------
 * T6: the deadline message (LLP 0100 R1) - absolute local time, the
 * backfilled-history statement, and the hypaware-privacy skill invocation
 * hint, printed to stderr the same way whether stdin is a TTY or not (LLP
 * 0063 D3 stands: this is a statement, never a prompt).
 * ------------------------------------------------------------------------ */

test('a fresh enroll on a TTY prints the deadline message on stderr (LLP 0100 R1)', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 0 }))
  const waitForAttach = /** @type {any} */ (async () => ['@hypaware/claude'])

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 0)

  const stateDir = path.join(hypHome, 'hypaware')
  const deadline = await readFirstSyncDeadline({ stateDir })
  assert.ok(typeof deadline === 'number')
  const text = err.join('')
  assert.match(text, /first sync to the 'prod' server is /)
  assert.ok(
    text.includes(formatFirstSyncDeadline(/** @type {number} */ (deadline))),
    'the message names the deadline as an absolute local time, using the same formatting hyp status will use'
  )
  assert.match(text, /includes your backfilled history/)
  assert.match(text, /open Claude or Codex and run the hypaware-privacy skill/)
})

test('a fresh enroll on non-TTY stdin prints the same deadline message on stderr (LLP 0100 R1)', async () => {
  const hypHome = await tmpHome()
  const stdin = { isTTY: false, async *[Symbol.asyncIterator]() { /* no chunks */ } }
  const { ctx, err } = await makeCtx({ hypHome, stdin })
  const login = /** @type {any} */ (async () => gatewaySession())
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 0 }))
  const waitForAttach = /** @type {any} */ (async () => ['@hypaware/claude'])

  // A non-TTY login without a token file or piped token still takes the
  // browser flow here (forceBrowser), the same fork an interactive login
  // takes - only --token-file/piped-stdin-without-a-browser-flag differ.
  const code = await runRemoteLogin(['prod', '--browser'], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 0)

  const text = err.join('')
  assert.match(text, /first sync to the 'prod' server is /)
  assert.match(text, /includes your backfilled history/)
  assert.match(text, /open Claude or Codex and run the hypaware-privacy skill/)
})

test('--no-daemon still prints the deadline message: the hold is already committed regardless of the daemon install', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod', '--no-daemon'], ctx, { login })
  assert.equal(code, 0)
  assert.match(err.join(''), /first sync to the 'prod' server is /)
  assert.match(err.join(''), /hypaware-privacy skill/)
})

test('an enrolling login names the server and prints no URL: terminals autolink one, and the server root is not browsable (#391)', async () => {
  const hypHome = await tmpHome()
  const { ctx, out, err } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 0 }))
  const waitForAttach = /** @type {any} */ (async () => ['@hypaware/claude'])

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 0)

  // Both destination surfaces - the forwarding line and the privacy block -
  // name the configured target instead of its origin. Asserted over the whole
  // login output, not per line: any new line that reintroduces a bare origin
  // reintroduces the dead click, wherever it is printed.
  const text = out.join('') + err.join('')
  assert.match(text, /forwarding logs to the 'prod' server/)
  assert.match(text, /first sync to the 'prod' server is /)
  assert.doesNotMatch(text, /https?:\/\//, 'no printed URL for a terminal to autolink into a dead page')

  // Withholding the URL is a readability choice; withholding the way to see it
  // would make a consent surface unauditable. Each stream carries its own
  // pointer, because either can be redirected away from the other.
  assert.match(out.join(''), /\(run 'hyp remote list' to see its URL\)/)
  assert.match(err.join(''), /\(run 'hyp remote list' to see that server's URL\)/)
})

test("a bare 'hyp remote login' names the default target it resolved, and that name is still recoverable", async () => {
  const hypHome = await tmpHome()
  // No positional target and no query.default_remote: the name comes from
  // effectiveDefaultRemote (the shipped built-in), so it is a name the user
  // never typed - the case that makes the lookup pointer load-bearing rather
  // than decorative.
  const { ctx, out, err } = await makeCtx({ hypHome, remotes: {} })
  const login = /** @type {any} */ (async () => gatewaySession())
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 0 }))
  const waitForAttach = /** @type {any} */ (async () => ['@hypaware/claude'])

  const code = await runRemoteLogin([], ctx, { login, enroll, waitForAttach })
  assert.equal(code, 0)

  const builtin = effectiveDefaultRemote(ctx.config)
  const text = out.join('') + err.join('')
  assert.match(text, new RegExp(`forwarding logs to the '${builtin}' server`))
  assert.match(text, new RegExp(`first sync to the '${builtin}' server is `))
  assert.doesNotMatch(text, /https?:\/\//)
  assert.match(out.join(''), /\(run 'hyp remote list' to see its URL\)/)
})

test('a re-login (already-enrolled) prints no deadline message: there is no first sync to defer', async () => {
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({
    hypHome,
    sinks: { fwd: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
  })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 0)
  assert.doesNotMatch(err.join(''), /first sync to/)
})

test('a fresh enroll whose enrollment throws still holds (the marker landed pre-enroll and is never cleared) (LLP 0101)', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())
  const enroll = /** @type {any} */ (async () => { throw new Error('server unreachable') })

  const code = await runRemoteLogin(['prod'], ctx, { login, enroll })
  assert.equal(code, 1)
  // No clear-on-exit: a hold written before a failed enroll runs to its
  // deadline rather than being rolled back (LLP 0101 #no-release). It is
  // bounded, so it cannot wedge exports past 11:59pm.
  assert.equal(await holdExists(hypHome), true, 'the pre-enroll hold is not cleared on the error path')
})

test('a re-login (already-enrolled, re-seed path) writes no first-sync hold (LLP 0101 #which)', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({
    hypHome,
    sinks: { fwd: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal', identity: {} } } },
  })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 0)
  assert.equal(await holdExists(hypHome), false, 're-logins already forward; there is no first sync to defer')
})

test('a query-only login (no gateway credential minted) writes no first-sync hold', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => ({
    refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme',
  }))

  const code = await runRemoteLogin(['prod'], ctx, { login })
  assert.equal(code, 0)
  assert.equal(await holdExists(hypHome), false)
})

test('--no-forward writes no first-sync hold (declines enrollment entirely)', async () => {
  const hypHome = await tmpHome()
  const { ctx } = await makeCtx({ hypHome })
  const login = /** @type {any} */ (async () => gatewaySession())

  const code = await runRemoteLogin(['prod', '--no-forward'], ctx, { login })
  assert.equal(code, 0)
  assert.equal(await holdExists(hypHome), false)
})
