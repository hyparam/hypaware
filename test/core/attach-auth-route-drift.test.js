// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
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
 * third alongside the endpoint (LLP 0086) and the asset set (LLP 0107): the
 * adapter reports the key it attached under, and the reconciler re-performs
 * when a later pass computes a different one.
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
