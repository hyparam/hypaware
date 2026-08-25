// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readObservabilityEnv } from '../../src/core/observability/env.js'
import { createActionReconciler } from '../../src/core/config/action_reconciler.js'
import { createAttachHandler } from '../../src/core/config/action_attach.js'
import { activate as activateCodex } from '../../hypaware-core/plugins-workspace/codex/src/index.js'

/**
 * Issue #996: `hyp attach codex` picks the gateway route from `auth.json` at
 * attach time (LLP 0099). Switching Codex between a ChatGPT subscription and
 * an API key changes which route is correct, but the daemon's attach marker
 * only recorded the endpoint and the asset set, so `isCurrent()` called the
 * `done` marker fresh forever and `config.toml` kept naming the *old* route.
 * Every Codex turn then carried a credential to an upstream not scoped for it,
 * until the user re-attached by hand.
 *
 * The fix makes the attach route an attach-marker freshness key of its own, the
 * fourth alongside the endpoint (LLP 0086), Claude's mode constant (LLP 0262),
 * and the asset set (LLP 0107): the adapter reports the key it attached under,
 * and the reconciler re-performs when a later pass computes a different one.
 *
 * @import { ClientDescriptor } from '../../src/core/types.js'
 */

const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} }

/** @type {ClientDescriptor} */
const CODEX_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/codex'),
  name: 'codex',
  skillDir: '.codex/skills',
  attachProbe: {
    format: 'toml',
    settings_file: '.codex/config.toml',
    marker_header: '[model_providers.hypaware]',
  },
}

/**
 * A subscription login as newer Codex writes it: OAuth tokens, no API key,
 * and no explicit `auth_mode` (LLP 0099's inference case).
 */
const SUBSCRIPTION_AUTH = {
  OPENAI_API_KEY: null,
  tokens: { id_token: 'i', access_token: 'a', refresh_token: 'r', account_id: 'acct' },
  last_refresh: '2026-08-25T00:00:00Z',
}

const API_KEY_AUTH = { OPENAI_API_KEY: 'sk-test-key' }

async function stage() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-route-drift-'))
  const homeDir = path.join(root, 'home')
  const codexHome = path.join(homeDir, '.codex')
  const hypHome = path.join(root, 'hyp-home')
  const env = /** @type {NodeJS.ProcessEnv} */ ({ HOME: homeDir, HYP_HOME: hypHome, CODEX_HOME: codexHome })
  const stateRoot = readObservabilityEnv(env).stateDir
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.mkdir(path.join(stateRoot, 'plugins', '@hypaware/codex'), { recursive: true })
  return {
    root,
    homeDir,
    codexHome,
    env,
    stateRoot,
    configPath: path.join(codexHome, 'config.toml'),
    authPath: path.join(codexHome, 'auth.json'),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

/**
 * Drive the real `@hypaware/codex` `activate(ctx)` and return the client
 * registration it puts on the gateway, so the reconciler exercises the
 * adapter's own route choice rather than a stand-in.
 *
 * @param {{ env: NodeJS.ProcessEnv, stateRoot: string }} staged
 */
async function codexRegistrationViaActivate(staged) {
  /** @type {any} */ let registration
  const gateway = {
    registerUpstreamPreset() {},
    registerExchangeProjector() {},
    registerSettlementEnricher() {},
    registerClient(/** @type {any} */ client) { registration = client },
  }
  const ctx = /** @type {any} */ ({
    env: staged.env,
    paths: { stateDir: path.join(staged.stateRoot, 'plugins', '@hypaware/codex') },
    plugin: { version: '0.0.0-test' },
    configRegistry: { registerSection() {} },
    requireCapability: () => gateway,
    backfills: { register() {} },
    commands: { register() {} },
    skills: { register() {} },
    agents: { register() {} },
  })
  await activateCodex(ctx)
  assert.ok(registration, 'codex activate() registered a client')
  return registration
}

/** @param {any} registration */
function clientsWith(registration) {
  return {
    getClient(/** @type {string} */ name) { return name === 'codex' ? registration : undefined },
    listClients() { return [registration] },
    registerClient() {}, registerUpstreamPreset() {},
    registerExchangeProjector() {}, registerSettlementEnricher() {},
  }
}

/**
 * @param {{ endpoint: string, clients: any, homeDir: string }} opts
 */
function reconcileInput({ endpoint, clients, homeDir }) {
  return {
    config: /** @type {any} */ ({
      version: 2,
      plugins: [{ name: '@hypaware/codex', enabled: true, config: {} }],
    }),
    backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
    env: /** @type {NodeJS.ProcessEnv} */ ({ HOME: homeDir }),
    clientDescriptors: new Map([[CODEX_DESCRIPTOR.name, CODEX_DESCRIPTOR]]),
    clients,
    endpoint,
  }
}

test('switching Codex auth modes re-attaches: the managed base_url follows auth.json (#996)', async () => {
  const staged = await stage()
  try {
    await fsp.writeFile(staged.authPath, JSON.stringify(SUBSCRIPTION_AUTH))
    const registration = await codexRegistrationViaActivate(staged)
    const clients = clientsWith(registration)
    const reconciler = createActionReconciler({
      stateRoot: staged.stateRoot,
      handlers: [createAttachHandler()],
      now: () => Date.parse('2026-08-25T00:00:00.000Z'),
      log: NOOP_LOG,
    })
    const input = reconcileInput({
      endpoint: 'http://127.0.0.1:40000',
      clients,
      homeDir: staged.homeDir,
    })

    // Pass 1: a subscription login routes to the ChatGPT upstream path.
    const first = await reconciler.reconcile(input)
    assert.deepEqual(first.results.map((r) => r.outcome), ['done'])
    const afterFirst = await fsp.readFile(staged.configPath, 'utf8')
    assert.match(
      afterFirst,
      /base_url = "http:\/\/127\.0\.0\.1:40000\/backend-api\/codex"/,
      'a subscription login attaches to the ChatGPT route'
    )

    // The user runs `codex login` with an API key. Nothing else changes: same
    // daemon, same port, same plugin set, so neither existing freshness key
    // moves.
    await fsp.writeFile(staged.authPath, JSON.stringify(API_KEY_AUTH))

    const second = await reconciler.reconcile(input)
    assert.deepEqual(
      second.results.map((r) => r.outcome),
      ['done'],
      'the auth-mode switch is a forward gap the reconciler closes, not a skip'
    )
    const afterSecond = await fsp.readFile(staged.configPath, 'utf8')
    assert.match(
      afterSecond,
      /base_url = "http:\/\/127\.0\.0\.1:40000\/v1"/,
      'after the switch the managed base_url names the OpenAI route'
    )
    assert.doesNotMatch(
      afterSecond,
      /backend-api\/codex/,
      'the stale ChatGPT route must not survive the re-attach'
    )

    // Idempotent once settled: a third pass at the same auth mode is a skip.
    const third = await reconciler.reconcile(input)
    assert.deepEqual(
      third.results.map((r) => r.outcome),
      ['skipped'],
      'an unchanged auth mode leaves the done marker current'
    )
  } finally {
    await staged.cleanup()
  }
})

test('a half-written auth.json is not drift: the key says "cannot tell" and the marker stands', async () => {
  const staged = await stage()
  try {
    await fsp.writeFile(staged.authPath, JSON.stringify(SUBSCRIPTION_AUTH))
    const registration = await codexRegistrationViaActivate(staged)
    const reconciler = createActionReconciler({
      stateRoot: staged.stateRoot,
      handlers: [createAttachHandler()],
      now: () => Date.parse('2026-08-25T00:00:00.000Z'),
      log: NOOP_LOG,
    })
    const input = reconcileInput({
      endpoint: 'http://127.0.0.1:40000',
      clients: clientsWith(registration),
      homeDir: staged.homeDir,
    })
    const first = await reconciler.reconcile(input)
    assert.deepEqual(first.results.map((r) => r.outcome), ['done'])

    // `codex login` and a token refresh both rewrite `auth.json`, and a
    // reconcile pass can catch the file truncated. `readCodexAuthMode` reports
    // that the same way it reports "no mode in a readable file", which
    // `attach()` resolves to the /v1 default. The freshness key must NOT: a
    // re-attach here would move a working subscription onto the route its
    // OAuth token is not scoped for, which is the harm this whole change
    // exists to prevent.
    await fsp.writeFile(staged.authPath, '{"tokens": {"access_to')
    const second = await reconciler.reconcile(input)
    assert.deepEqual(
      second.results.map((r) => r.outcome),
      ['skipped'],
      'an unreadable auth.json is "cannot tell", not "the user switched to an API key"'
    )
    assert.match(
      await fsp.readFile(staged.configPath, 'utf8'),
      /base_url = "http:\/\/127\.0\.0\.1:40000\/backend-api\/codex"/,
      'the subscription route survives a read this pass could not make sense of'
    )
    assert.equal(
      await registration.attachKey(),
      undefined,
      'the adapter reports undefined rather than keying an unreadable file to /v1'
    )

    // And the file coming back readable at the SAME mode is still not drift.
    await fsp.writeFile(staged.authPath, JSON.stringify(SUBSCRIPTION_AUTH))
    const third = await reconciler.reconcile(input)
    assert.deepEqual(third.results.map((r) => r.outcome), ['skipped'])
  } finally {
    await staged.cleanup()
  }
})

/**
 * A fake client whose `attachKey()` is whatever the test's `key` box currently
 * holds, so the core half of LLP 0308 can be exercised without a real adapter:
 * the degenerate returns the contract promises are all "leave the marker
 * alone", and only a *different* string is drift. The box is swapped by the
 * test between passes rather than by counting calls, so these assertions cannot
 * accidentally depend on how many times either hook ran.
 *
 * @param {{ key: { get: () => any }, calls: string[] }} script
 */
function scriptedClient({ key, calls }) {
  const registration = {
    name: 'claude',
    attachKey() {
      calls.push('attachKey')
      return key.get()
    },
    /** @param {{ endpoint: string, stdout: any }} attachCtx */
    async attach(attachCtx) {
      calls.push('attach')
      attachCtx.stdout.write(
        JSON.stringify({
          status: 'attached', action: 'attach', client: 'claude', dry_run: false,
          changed: true, settings_path: '/home/u/.claude/settings.json',
          port: Number(new URL(attachCtx.endpoint).port), mode: 'otel',
        }) + '\n'
      )
    },
  }
  return {
    getClient(/** @type {string} */ name) { return name === 'claude' ? registration : undefined },
    listClients() { return [registration] },
    registerClient() {}, registerUpstreamPreset() {},
    registerExchangeProjector() {}, registerSettlementEnricher() {},
  }
}

/** @type {ClientDescriptor} */
const CLAUDE_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/claude'),
  name: 'claude',
  skillDir: 'skills/claude',
  attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' },
}

/**
 * @param {{ key: { get: () => any }, calls: string[], attachKeyTimeoutMs?: number }} script
 */
async function runScripted(script) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-attach-key-core-'))
  const stateRoot = path.join(root, 'hypaware')
  const reconciler = createActionReconciler({
    stateRoot,
    handlers: [createAttachHandler({ attachKeyTimeoutMs: script.attachKeyTimeoutMs })],
    now: () => Date.parse('2026-08-25T00:00:00.000Z'),
    log: NOOP_LOG,
  })
  const input = {
    config: /** @type {any} */ ({
      version: 2,
      plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }],
    }),
    backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
    env: /** @type {NodeJS.ProcessEnv} */ ({ HOME: path.join(root, 'home') }),
    clientDescriptors: new Map([[CLAUDE_DESCRIPTOR.name, CLAUDE_DESCRIPTOR]]),
    clients: /** @type {any} */ (scriptedClient(script)),
    endpoint: 'http://127.0.0.1:40000',
  }
  const markerFile = path.join(stateRoot, 'config-control', 'client-actions.json')
  return {
    reconciler,
    input,
    marker: () => JSON.parse(fs.readFileSync(markerFile, 'utf8')).attach.claude,
    writeMarker: (/** @type {any} */ m) => {
      fs.writeFileSync(markerFile, JSON.stringify({ attach: { claude: m } }))
    },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

test('a throwing or absent attachKey leaves a settled attach marker alone (LLP 0308)', async () => {
  for (const [label, key] of /** @type {[string, () => any][]} */ ([
    ['throws', () => { throw new Error('auth.json unreadable') }],
    ['rejects', () => Promise.reject(new Error('auth.json unreadable'))],
    ['returns undefined', () => undefined],
    ['returns a non-string', () => 42],
    ['returns an empty string', () => ''],
  ])) {
    const calls = /** @type {string[]} */ ([])
    /** @type {{ get: () => any }} */
    const box = { get: () => '/backend-api/codex' }
    const harness = await runScripted({ key: box, calls })
    try {
      // Pass 1 settles under a real key.
      const first = await harness.reconciler.reconcile(harness.input)
      assert.deepEqual(first.results.map((r) => r.outcome), ['done'], label)
      assert.equal(harness.marker().attach_key, '/backend-api/codex', label)

      // The adapter then degenerates: the box, not a call count, decides.
      box.get = key
      const second = await harness.reconciler.reconcile(harness.input)
      assert.deepEqual(
        second.results.map((r) => r.outcome),
        ['skipped'],
        `a key that ${label} is "cannot tell", so the settled attach stands`
      )
      // And it did not churn the recorded key away either.
      assert.equal(harness.marker().attach_key, '/backend-api/codex', label)
      assert.equal(calls.filter((c) => c === 'attach').length, 1, label)
    } finally {
      await harness.cleanup()
    }
  }
})

test('perform() reads the adapter key BEFORE it applies the attach (LLP 0308)', async () => {
  // Order is load-bearing. Reading after the effect would record a key newer
  // than the settings that landed, and `isCurrent()` would then match it
  // forever over a config naming the wrong route: #996 again, unreachable by
  // any later pass. Reading first fails the other way, toward one redundant
  // re-attach that settles.
  const calls = /** @type {string[]} */ ([])
  const harness = await runScripted({ key: { get: () => '/backend-api/codex' }, calls })
  try {
    await harness.reconciler.reconcile(harness.input)
    assert.deepEqual(calls, ['attachKey', 'attach'])
  } finally {
    await harness.cleanup()
  }
})

test('a pre-LLP-0308 marker is stale exactly once, then settles', async () => {
  const calls = /** @type {string[]} */ ([])
  const harness = await runScripted({ key: { get: () => '/v1' }, calls })
  try {
    // Seed the shape an upgrade finds on disk: a `done` marker at the live
    // endpoint carrying no `attach_key` at all.
    await harness.reconciler.reconcile(harness.input)
    const seeded = harness.marker()
    delete seeded.attach_key
    harness.writeMarker(seeded)
    calls.length = 0

    const upgrade = await harness.reconciler.reconcile(harness.input)
    assert.deepEqual(
      upgrade.results.map((r) => r.outcome),
      ['done'],
      'a marker with no recorded key re-attaches once, which records one'
    )
    assert.equal(harness.marker().attach_key, '/v1')

    const settled = await harness.reconciler.reconcile(harness.input)
    assert.deepEqual(
      settled.results.map((r) => r.outcome),
      ['skipped'],
      'and every pass after it is current: the migration does not repeat'
    )
    assert.equal(calls.filter((c) => c === 'attach').length, 1)
  } finally {
    await harness.cleanup()
  }
})

test('an attachKey that never answers is bounded, not a wedged reconcile pass (LLP 0308)', async () => {
  // The one broken-hook mode the `try` in `readAttachKey` cannot catch. It is
  // also the worst one: `isCurrent()` runs on the SETTLED path, so a hook that
  // hangs stops every later pass over every action, not just this attach. The
  // deadline maps it onto "cannot tell", which the marker already survives.
  // A real 2s bound is shrunk here only so the test need not spend it.
  const calls = /** @type {string[]} */ ([])
  /** @type {{ get: () => any }} */
  const box = { get: () => '/backend-api/codex' }
  const harness = await runScripted({ key: box, calls, attachKeyTimeoutMs: 25 })
  try {
    const first = await harness.reconciler.reconcile(harness.input)
    assert.deepEqual(first.results.map((r) => r.outcome), ['done'])
    assert.equal(harness.marker().attach_key, '/backend-api/codex')

    // The hook stops answering. Without a deadline this await never returns and
    // the test times out; with one it reads as "cannot tell".
    box.get = () => new Promise(() => {})
    const second = await harness.reconciler.reconcile(harness.input)
    assert.deepEqual(
      second.results.map((r) => r.outcome),
      ['skipped'],
      'a hook that never answers leaves the settled attach alone rather than stopping the pass'
    )
    assert.equal(harness.marker().attach_key, '/backend-api/codex')
    assert.equal(calls.filter((c) => c === 'attach').length, 1)

    // And perform()'s half is bounded too: a pass that has drifted for another
    // reason still applies its attach, recording no key rather than hanging.
    harness.input.endpoint = 'http://127.0.0.1:40001'
    const rebound = await harness.reconciler.reconcile(harness.input)
    assert.deepEqual(rebound.results.map((r) => r.outcome), ['done'])
    assert.equal(harness.marker().attach_key, undefined)
    assert.equal(calls.filter((c) => c === 'attach').length, 2)
  } finally {
    await harness.cleanup()
  }
})
