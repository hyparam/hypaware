// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createActionReconciler } from '../../src/core/config/action_reconciler.js'
import { createAttachHandler, telemetryListenPorts } from '../../src/core/config/action_attach.js'
import { CLAUDE_SETTINGS_MARKER_SCHEMA } from '../../src/core/config/client_detach_disk.js'

/**
 * LLP 0577 moved Claude's default telemetry port per OS user. An attach that
 * wrote 4319 into Claude's settings keeps naming 4319 after the daemon starts
 * binding the per-uid port, so the claude attach marker records the port it
 * wrote, and a marker whose port differs from the port this boot's listener
 * bound is a forward gap the reconciler closes by re-attaching.
 *
 * @import { ClientDescriptor } from '../../src/core/types.js'
 * @import { SourceSnapshot } from '../../src/core/daemon/types.js'
 */

const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} }
const ENDPOINT = 'http://127.0.0.1:55555'
const PLUGIN = '@hypaware/claude'

/** @type {ClientDescriptor} */
const CLAUDE_DESCRIPTOR = {
  plugin: /** @type {any} */ (PLUGIN),
  name: 'claude',
  skillDir: 'skills/claude',
  attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' },
}

async function makeFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-attach-telemetry-port-'))
  return { tmp, stateRoot: path.join(tmp, 'hypaware') }
}

/** @param {string} stateRoot */
function markerPath(stateRoot) {
  return path.join(stateRoot, 'config-control', 'client-actions.json')
}

/** @param {string} stateRoot */
function readMarker(stateRoot) {
  return JSON.parse(fs.readFileSync(markerPath(stateRoot), 'utf8')).attach.claude
}

/**
 * Seed a done, otherwise current claude attach marker.
 * @param {string} stateRoot
 * @param {number | undefined} telemetryPort
 */
function seedMarker(stateRoot, telemetryPort) {
  fs.mkdirSync(path.join(stateRoot, 'config-control'), { recursive: true })
  const marker = {
    status: 'done',
    request_key: 'claude',
    at: '2026-11-01T00:00:00.000Z',
    endpoint: ENDPOINT,
    mode: 'otel',
    settings_schema: CLAUDE_SETTINGS_MARKER_SCHEMA,
    ...(telemetryPort !== undefined ? { telemetry_port: telemetryPort } : {}),
  }
  fs.writeFileSync(markerPath(stateRoot), JSON.stringify({ attach: { claude: marker } }, null, 2) + '\n')
}

/**
 * A fake registry whose claude `attach()` reports the telemetry port it
 * wrote (what `resolveAttachTelemetryPort` resolves), or prints nothing.
 * @param {{ calls: number[], port: () => number | undefined, silent?: boolean }} opts
 */
function clientsWith({ calls, port, silent }) {
  const registration = {
    name: 'claude',
    /** @param {{ endpoint: string, json?: boolean, stdout: any }} ctx */
    async attach(ctx) {
      const written = port()
      calls.push(written ?? 0)
      if (silent) return
      ctx.stdout.write(JSON.stringify({
        status: 'attached', action: 'attach', client: 'claude', dry_run: false, changed: true,
        settings_path: '/home/u/.claude/settings.json', mode: 'otel', telemetry_port: written,
      }) + '\n')
    },
  }
  return {
    getClient(/** @type {string} */ name) { return name === 'claude' ? registration : undefined },
    listClients() { return [registration] },
    registerClient() {}, registerUpstreamPreset() {},
    registerExchangeProjector() {}, registerSettlementEnricher() {},
  }
}

/**
 * @param {{ clients: any, telemetryPorts?: Map<string, number> }} opts
 */
function reconcileInput({ clients, telemetryPorts }) {
  return {
    config: /** @type {any} */ ({ version: 2, plugins: [{ name: PLUGIN, enabled: true, config: {} }] }),
    backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
    env: process.env,
    clientDescriptors: new Map([[CLAUDE_DESCRIPTOR.name, CLAUDE_DESCRIPTOR]]),
    clients,
    endpoint: ENDPOINT,
    ...(telemetryPorts ? { telemetryPorts } : {}),
  }
}

/** @param {string} stateRoot */
function reconcilerFor(stateRoot) {
  return createActionReconciler({ stateRoot, handlers: [createAttachHandler()], log: NOOP_LOG })
}

test('settings on 4319 while the listener bound 20502 are stale: re-attach writes 20502, then current', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    seedMarker(stateRoot, 4319)
    /** @type {number[]} */
    const calls = []
    const clients = clientsWith({ calls, port: () => 20502 })
    const telemetryPorts = new Map([[PLUGIN, 20502]])
    const reconciler = reconcilerFor(stateRoot)

    const r1 = await reconciler.reconcile(reconcileInput({ clients, telemetryPorts }))
    assert.deepEqual(r1.results.map((r) => r.outcome), ['done'])
    assert.deepEqual(calls, [20502])
    assert.equal(readMarker(stateRoot).telemetry_port, 20502)

    const r2 = await reconciler.reconcile(reconcileInput({ clients, telemetryPorts }))
    assert.deepEqual(r2.results.map((r) => r.outcome), ['skipped'])
    assert.equal(calls.length, 1, 'a current port must not re-attach')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a marker port equal to the bound port is current', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    seedMarker(stateRoot, 20502)
    /** @type {number[]} */
    const calls = []
    const r = await reconcilerFor(stateRoot).reconcile(reconcileInput({
      clients: clientsWith({ calls, port: () => 20502 }),
      telemetryPorts: new Map([[PLUGIN, 20502]]),
    }))
    assert.deepEqual(r.results.map((x) => x.outcome), ['skipped'])
    assert.deepEqual(calls, [])
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('an explicit telemetry.listen_port the listener bound is honoured over the default', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // A configured listen_port binds exactly that port; the snapshot carries it.
    const telemetryPorts = telemetryListenPorts([
      { name: 'claude-telemetry', plugin: PLUGIN, state: 'started', details: { listen_port: 5555, last_event_at: null } },
    ])
    /** @type {number[]} */
    const calls = []
    const clients = clientsWith({ calls, port: () => 5555 })

    seedMarker(stateRoot, 5555)
    const current = await reconcilerFor(stateRoot).reconcile(reconcileInput({ clients, telemetryPorts }))
    assert.deepEqual(current.results.map((x) => x.outcome), ['skipped'])

    seedMarker(stateRoot, 4319)
    const stale = await reconcilerFor(stateRoot).reconcile(reconcileInput({ clients, telemetryPorts }))
    assert.deepEqual(stale.results.map((x) => x.outcome), ['done'])
    assert.equal(readMarker(stateRoot).telemetry_port, 5555)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a marker from before the port key re-attaches once, then is current', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    seedMarker(stateRoot, undefined)
    /** @type {number[]} */
    const calls = []
    const clients = clientsWith({ calls, port: () => 4319 })
    const telemetryPorts = new Map([[PLUGIN, 4319]])
    const reconciler = reconcilerFor(stateRoot)

    const r1 = await reconciler.reconcile(reconcileInput({ clients, telemetryPorts }))
    assert.deepEqual(r1.results.map((x) => x.outcome), ['done'])
    const r2 = await reconciler.reconcile(reconcileInput({ clients, telemetryPorts }))
    assert.deepEqual(r2.results.map((x) => x.outcome), ['skipped'])
    assert.equal(calls.length, 1)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('no bound port threaded leaves the marker current', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    seedMarker(stateRoot, 4319)
    /** @type {number[]} */
    const calls = []
    const r = await reconcilerFor(stateRoot).reconcile(reconcileInput({
      clients: clientsWith({ calls, port: () => 20502 }),
    }))
    assert.deepEqual(r.results.map((x) => x.outcome), ['skipped'])
    assert.deepEqual(calls, [])
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('an attach whose report does not parse records the bound port, so it does not loop', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    seedMarker(stateRoot, 4319)
    /** @type {number[]} */
    const calls = []
    const clients = clientsWith({ calls, port: () => 20502, silent: true })
    const telemetryPorts = new Map([[PLUGIN, 20502]])
    const reconciler = reconcilerFor(stateRoot)

    const r1 = await reconciler.reconcile(reconcileInput({ clients, telemetryPorts }))
    assert.deepEqual(r1.results.map((x) => x.outcome), ['done'])
    assert.equal(readMarker(stateRoot).telemetry_port, 20502)
    const r2 = await reconciler.reconcile(reconcileInput({ clients, telemetryPorts }))
    assert.deepEqual(r2.results.map((x) => x.outcome), ['skipped'])
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('telemetryListenPorts takes started listeners only, first per plugin', () => {
  /** @type {SourceSnapshot[]} */
  const sources = [
    { name: 'gateway', plugin: '@hypaware/ai-gateway', state: 'started', details: { listen_port: 18521 } },
    { name: 'failed', plugin: '@hypaware/opencode', state: 'failed', details: { listen_port: 4320, last_event_at: null } },
    { name: 'no-port', plugin: '@hypaware/cursor', state: 'started', details: { last_event_at: null } },
    { name: 'bad-port', plugin: '@hypaware/pi', state: 'started', details: { listen_port: 70000, last_event_at: null } },
    { name: 'claude-telemetry', plugin: PLUGIN, state: 'started', details: { listen_port: 20502, last_event_at: '2026-11-04T00:00:00.000Z' } },
    { name: 'claude-second', plugin: PLUGIN, state: 'started', details: { listen_port: 4319, last_event_at: null } },
  ]
  assert.deepEqual([...telemetryListenPorts(sources)], [[PLUGIN, 20502]])
  assert.deepEqual([...telemetryListenPorts(undefined)], [])
})
