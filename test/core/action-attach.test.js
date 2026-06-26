// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createAttachHandler, attachHandler } from '../../src/core/config/action_attach.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'

/**
 * T6 (LLP 0044/0045/0046): the attach action handler — the reversible
 * instance of the client-action reconciler, the `action_backfill.js` twin.
 * These tests drive the handler hooks directly with injected fake
 * `clientDescriptors` + `clients` + filesystem, the way the plan prescribes;
 * the reconciler's generic gap loop is covered by `action-reconciler.test.js`.
 *
 * @import { ActionContext, ActionHandler } from '../../src/core/config/types.d.ts'
 * @import { ClientDescriptor } from '../../src/core/plugin_catalog.js'
 */

/**
 * Narrow the optional `reverse?` hook to a defined function (attach is the
 * reversible handler, so it always implements it).
 * @param {ActionHandler} handler
 * @returns {NonNullable<ActionHandler['reverse']>}
 */
function reverseOf(handler) {
  assert.ok(handler.reverse, 'attach handler must implement reverse()')
  return handler.reverse
}

/** A quiet logger so tests don't spam stderr. */
const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} }

const FIXED_NOW = Date.parse('2026-06-25T00:00:00.000Z')
const ENDPOINT = 'http://127.0.0.1:4123'

/** @type {ClientDescriptor} */
const CLAUDE_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/claude'),
  name: 'claude',
  skillDir: 'skills/claude',
  attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' },
}

/** @type {ClientDescriptor} */
const CODEX_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/codex'),
  name: 'codex',
  skillDir: 'skills/codex',
  attachProbe: { format: 'toml', settings_file: '.codex/config.toml', marker_header: '[model_providers.hypaware]' },
}

/**
 * @param {ClientDescriptor[]} list
 * @returns {Map<string, ClientDescriptor>}
 */
function descriptorMap(list) {
  return new Map(list.map((d) => [d.name, d]))
}

/**
 * A fake gateway registry over a fixed set of registered client adapters. Only
 * `getClient` / `listClients` are exercised; the rest satisfy the shape.
 * @param {Record<string, any>} registrations  client name -> registration
 * @returns {any}
 */
function clientsWith(registrations) {
  const map = new Map(Object.entries(registrations))
  return {
    getClient(/** @type {string} */ name) { return map.get(name) },
    listClients() { return [...map.values()] },
    registerClient() {},
    registerUpstreamPreset() {},
    registerExchangeProjector() {},
    registerSettlementEnricher() {},
    localEndpoint() { return ENDPOINT },
  }
}

/**
 * A fake client registration whose `attach()` writes the adapter's one-line
 * `json: true` payload (or throws / emits prose, per opts).
 * @param {string} name
 * @param {{ payload?: any, prose?: string, throws?: Error, onAttach?: (ctx: any) => void }} [opts]
 * @returns {any}
 */
function attachRegistration(name, opts = {}) {
  return {
    name,
    defaultUpstream: 'anthropic',
    /** @param {any} ctx */
    async attach(ctx) {
      opts.onAttach?.(ctx)
      if (opts.throws) throw opts.throws
      if (typeof opts.prose === 'string') {
        ctx.stdout.write(opts.prose)
        return
      }
      const payload = opts.payload ?? {
        status: 'attached', action: 'attach', client: name, dry_run: false, changed: true,
      }
      ctx.stdout.write(JSON.stringify(payload))
    },
  }
}

/**
 * Build the ActionContext a handler hook receives.
 * @param {{
 *   plugins?: any[],
 *   descriptors?: Map<string, ClientDescriptor>,
 *   clients?: any,
 *   endpoint?: string | undefined,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {ActionContext}
 */
function makeCtx(opts = {}) {
  return {
    config: /** @type {any} */ ({ version: 2, plugins: opts.plugins ?? [] }),
    backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
    env: opts.env ?? { ...process.env },
    clientDescriptors: opts.descriptors,
    clients: /** @type {any} */ (opts.clients),
    endpoint: 'endpoint' in opts ? opts.endpoint : ENDPOINT,
    now: () => FIXED_NOW,
    log: NOOP_LOG,
  }
}

/* -------------------------------- shape --------------------------------- */

test('the default attachHandler is an attach-kind, reversible ActionHandler', () => {
  assert.equal(attachHandler.kind, 'attach')
  assert.equal(typeof attachHandler.desired, 'function')
  assert.equal(typeof attachHandler.perform, 'function')
  // Unlike backfill (run-once), attach implements reverse().
  assert.equal(typeof attachHandler.reverse, 'function')
})

/* ------------------------------- desired() ------------------------------- */

test('desired() emits one action per enabled client descriptor with a registered client', () => {
  const handler = createAttachHandler()
  const desired = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(desired, [
    { requestKey: 'claude', params: { client: 'claude', plugin: '@hypaware/claude' } },
  ])
})

test('desired() emits an action per enabled descriptor across two client plugins', () => {
  const handler = createAttachHandler()
  const desired = handler.desired(makeCtx({
    plugins: [
      { name: '@hypaware/claude', enabled: true, config: {} },
      { name: '@hypaware/codex', enabled: true, config: {} },
    ],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR, CODEX_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude'), codex: attachRegistration('codex') }),
  }))
  assert.deepEqual(desired.map((d) => d.requestKey).sort(), ['claude', 'codex'])
})

test('desired() excludes a descriptor whose owning plugin is disabled or absent', () => {
  const handler = createAttachHandler()
  const disabled = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: false, config: {} }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(disabled, [])
  const absent = handler.desired(makeCtx({
    plugins: [],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(absent, [])
})

test('desired() honors an explicit attach.on_join:false opt-out (no action)', () => {
  const handler = createAttachHandler()
  const desired = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: { attach: { on_join: false } } }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(desired, [])
})

test('desired() does not fail open on a non-boolean on_join (treats it as opt-out)', () => {
  const handler = createAttachHandler()
  // The typo'd JSON string `"false"` is not a boolean; it must suppress, not
  // fall through to default-on and silently edit the user's settings file.
  const stringFalse = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: { attach: { on_join: 'false' } } }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(stringFalse, [], 'on_join:"false" (string) must not attach')
})

test('desired() guards on the runtime registry actually having the client', () => {
  const handler = createAttachHandler()
  // Enabled plugin + descriptor, but the gateway registered no such client →
  // never name a client `perform()` cannot reach.
  const desired = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({}),
  }))
  assert.deepEqual(desired, [])
})

test('desired() is daemon-only: inert with no clientDescriptors and with no clients (a plain CLI boot)', () => {
  const handler = createAttachHandler()
  // No client catalog at all.
  assert.deepEqual(handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }],
    descriptors: undefined,
    clients: clientsWith({ claude: attachRegistration('claude') }),
  })), [])
  // Descriptors but no gateway registry (gateway capability absent).
  assert.deepEqual(handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: undefined,
  })), [])
})

/* ------------------------------- perform() ------------------------------- */

test('perform() attaches via the registry (endpoint + json mode) and records settings_path + prev_value', async () => {
  /** @type {any} */
  let attachCtx
  const registration = attachRegistration('claude', {
    onAttach: (ctx) => { attachCtx = ctx },
    payload: {
      status: 'attached', action: 'attach', client: 'claude', dry_run: false,
      changed: true, settings_path: '/home/u/.claude/settings.json', port: 4123,
      prev_value: 'https://foreign.example/api',
    },
  })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude', plugin: '@hypaware/claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.deepEqual(outcome, {
    status: 'done',
    detail: { settings_path: '/home/u/.claude/settings.json', prev_value: 'https://foreign.example/api' },
  })
  // The adapter was invoked with the gateway endpoint, an empty config, and
  // the machine-readable json flag.
  assert.equal(attachCtx.endpoint, ENDPOINT)
  assert.equal(attachCtx.json, true)
  assert.deepEqual(attachCtx.config, {})
})

test('perform() records done with only settings_path when the attach had no prior value to back up', async () => {
  const registration = attachRegistration('claude', {
    payload: {
      status: 'attached', action: 'attach', client: 'claude', dry_run: false,
      changed: true, settings_path: '/home/u/.claude/settings.json',
    },
  })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.deepEqual(outcome, { status: 'done', detail: { settings_path: '/home/u/.claude/settings.json' } })
})

test('perform() records done (no detail) on an idempotent re-attach (changed:false)', async () => {
  const registration = attachRegistration('claude', {
    payload: { status: 'noop', action: 'attach', client: 'claude', dry_run: false, changed: false },
  })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.deepEqual(outcome, { status: 'done' })
})

test('perform() records done (no detail) when the adapter emits an unparseable payload', async () => {
  const registration = attachRegistration('claude', { prose: 'attached claude (human prose)\n' })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.deepEqual(outcome, { status: 'done' })
})

test('perform() parses the last non-empty line when prose precedes the JSON', async () => {
  const registration = attachRegistration('claude', {
    onAttach: (ctx) => {
      ctx.stdout.write('Attaching claude...\n')
      ctx.stdout.write(JSON.stringify({ status: 'attached', client: 'claude', settings_path: '/p' }) + '\n')
    },
    prose: '',
  })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.deepEqual(outcome, { status: 'done', detail: { settings_path: '/p' } })
})

test('perform() returns failed when the adapter throws (file not writable)', async () => {
  const registration = attachRegistration('claude', { throws: new Error('EACCES: permission denied') })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /EACCES/)
})

test('perform() returns failed when the registry has no such client', async () => {
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({}) }),
  )
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /no registered client/)
})

test('perform() returns failed when no gateway endpoint is set', async () => {
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: attachRegistration('claude') }), endpoint: undefined }),
  )
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /endpoint/)
})

test('perform() guards against a missing client name', async () => {
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: '', params: {} },
    makeCtx({ clients: clientsWith({}) }),
  )
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /missing client name/)
})

/* ------------------------------- reverse() ------------------------------- */

test('reverse() invokes the disk-driven undo once and never consults ctx.clients', async () => {
  /** @type {any[]} */
  const calls = []
  // A registry that explodes if the handler ever touches it — proving reverse
  // is adapter-independent (the dropped client is gone after the restart).
  const poisonClients = {
    getClient() { throw new Error('reverse() must not consult ctx.clients') },
    listClients() { throw new Error('reverse() must not consult ctx.clients') },
  }
  const handler = createAttachHandler({
    detach: async (args) => {
      calls.push(args)
      return { changed: true, settingsPath: '/home/u/.claude/settings.json', restoredValue: 'https://foreign.example/api' }
    },
  })
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: poisonClients,
  }))
  assert.deepEqual(outcome, { status: 'done' })
  assert.equal(calls.length, 1)
  // The T4 undo got the descriptor (its attachProbe is what the undo replays).
  assert.equal(calls[0].descriptor, CLAUDE_DESCRIPTOR)
})

test('reverse() replays the real core undo from disk with no adapter loaded (fs round-trip)', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-action-attach-'))
  try {
    const settingsPath = path.join(home, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    // A hand-written self-describing marker — what claude `attach()` records:
    // the managed env value plus the prior base URL to restore (LLP 0045 §Part 3).
    const original = JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: ENDPOINT },
      _hypaware: {
        prev_base_url: 'https://foreign.example/api',
        managed: { env: { ANTHROPIC_BASE_URL: ENDPOINT }, hooks: [] },
      },
    }, null, 2) + '\n'
    await fs.writeFile(settingsPath, original)

    // No ctx.clients at all — the adapter is unloaded post-restart. Bind the
    // fixture home through the injected (real) detach.
    const handler = createAttachHandler({
      detach: ({ descriptor }) => detachClientFromDisk({ descriptor, homeDir: home }),
    })
    const outcome = await reverseOf(handler)('claude', makeCtx({
      descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
      clients: undefined,
    }))
    assert.deepEqual(outcome, { status: 'done' })

    const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal('_hypaware' in after, false, 'marker stripped')
    assert.equal(after.env.ANTHROPIC_BASE_URL, 'https://foreign.example/api', 'prior base URL restored')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('reverse() returns failed (retry next pass) when the descriptor is gone from the catalog', async () => {
  const handler = createAttachHandler({
    detach: async () => { throw new Error('detach should not be called without a descriptor') },
  })
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([]),
    clients: undefined,
  }))
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /no client descriptor/)
})

test('reverse() returns failed when the disk undo throws (concurrent edit)', async () => {
  const handler = createAttachHandler({
    detach: async () => { throw new Error('CONCURRENT_EDIT') },
  })
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: undefined,
  }))
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /CONCURRENT_EDIT/)
})

/* ---------------------- desired/reverse compose (gap) -------------------- */

test('the reverse-gap contract: a dropped client falls out of desired() and reverse() then undoes it', async () => {
  /** @type {any[]} */
  const calls = []
  const handler = createAttachHandler({
    detach: async (args) => { calls.push(args); return { changed: true, settingsPath: '/p' } },
  })
  // Joined + enabled → named by desired() (the reconciler would perform it).
  const named = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(named.map((d) => d.requestKey), ['claude'])

  // Central config drops the plugin → desired() omits it; the descriptor stays
  // in the catalog, so the reconciler's reverse gap fires for the marker key.
  const dropped = handler.desired(makeCtx({
    plugins: [],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(dropped, [])

  // reverse() undoes it from disk.
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: undefined,
  }))
  assert.deepEqual(outcome, { status: 'done' })
  assert.equal(calls.length, 1)
})
