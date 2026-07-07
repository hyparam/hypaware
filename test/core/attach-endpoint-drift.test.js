// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createActionReconciler, readClientActionStatus } from '../../src/core/config/action_reconciler.js'
import { createAttachHandler } from '../../src/core/config/action_attach.js'

/**
 * Issue #277 Gap 2: the daemon's gateway rebinds to a fresh ephemeral port on
 * every restart, but the attach reconcile pass is level-triggered on marker
 * existence — a `done` attach marker short-circuits forever, so the client's
 * ANTHROPIC_BASE_URL keeps pointing at the old port and capture silently stops.
 *
 * The fix makes the attach marker endpoint-aware: it records the endpoint it
 * attached at, and an endpoint mismatch on a later pass is a *forward gap* that
 * re-attaches, rather than a permanent `done`.
 *
 * @import { ClientDescriptor } from '../../src/core/types.js'
 */

const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} }

/** @type {ClientDescriptor} */
const CLAUDE_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/claude'),
  name: 'claude',
  skillDir: 'skills/claude',
  attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' },
}

async function makeFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-attach-drift-'))
  return { tmp, stateRoot: path.join(tmp, 'hypaware') }
}

function markerPath(stateRoot) {
  return path.join(stateRoot, 'config-control', 'client-actions.json')
}

function readMarkerFile(stateRoot) {
  return JSON.parse(fs.readFileSync(markerPath(stateRoot), 'utf8'))
}

/**
 * A fake gateway registry whose single client's `attach()` echoes the
 * endpoint's port back in the adapter JSON and counts calls.
 * @param {{ attachCalls: string[] }} sink
 */
function clientsWith({ attachCalls }) {
  const registration = {
    name: 'claude',
    /** @param {{ endpoint: string, json?: boolean, stdout: any }} ctx */
    async attach(ctx) {
      attachCalls.push(ctx.endpoint)
      const port = Number(new URL(ctx.endpoint).port)
      ctx.stdout.write(
        JSON.stringify({
          status: 'attached', action: 'attach', client: 'claude', dry_run: false,
          changed: true, settings_path: '/home/u/.claude/settings.json', port,
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

/**
 * @param {{ endpoint: string | undefined, clients: any }} opts
 */
function reconcileInput({ endpoint, clients }) {
  return {
    config: /** @type {any} */ ({ version: 2, plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }] }),
    backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
    env: process.env,
    clientDescriptors: new Map([[CLAUDE_DESCRIPTOR.name, CLAUDE_DESCRIPTOR]]),
    clients,
    endpoint,
  }
}

test('a rebind (new endpoint) re-attaches instead of short-circuiting on the done marker (#277 Gap 2)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    /** @type {string[]} */
    const attachCalls = []
    const clients = clientsWith({ attachCalls })
    const reconciler = createActionReconciler({
      stateRoot,
      handlers: [createAttachHandler()],
      now: () => Date.parse('2026-07-07T00:00:00.000Z'),
      log: NOOP_LOG,
    })

    // Boot 1: gateway bound at port 40000 → attach once, marker records the endpoint.
    const r1 = await reconciler.reconcile(reconcileInput({ endpoint: 'http://127.0.0.1:40000', clients }))
    assert.deepEqual(r1.results.map((r) => r.outcome), ['done'])
    assert.deepEqual(attachCalls, ['http://127.0.0.1:40000'])
    assert.equal(readMarkerFile(stateRoot).attach.claude.endpoint, 'http://127.0.0.1:40000')

    // Same endpoint → the done marker is current, so no re-attach.
    const r2 = await reconciler.reconcile(reconcileInput({ endpoint: 'http://127.0.0.1:40000', clients }))
    assert.deepEqual(r2.results.map((r) => r.outcome), ['skipped'])
    assert.equal(attachCalls.length, 1, 'a current endpoint must not re-attach')

    // Boot 2: the daemon rebound to a new ephemeral port → forward gap → re-attach.
    const r3 = await reconciler.reconcile(reconcileInput({ endpoint: 'http://127.0.0.1:55555', clients }))
    assert.deepEqual(r3.results.map((r) => r.outcome), ['done'])
    assert.deepEqual(attachCalls, ['http://127.0.0.1:40000', 'http://127.0.0.1:55555'])
    assert.equal(readMarkerFile(stateRoot).attach.claude.endpoint, 'http://127.0.0.1:55555')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a legacy done attach marker with no recorded endpoint re-attaches once (backward compatible) (#277 Gap 2)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // Seed a pre-fix marker: done, but with no `endpoint` field (attached by an
    // older build). It must be treated as stale (re-attach once), never crash.
    fs.mkdirSync(path.join(stateRoot, 'config-control'), { recursive: true })
    fs.writeFileSync(
      markerPath(stateRoot),
      JSON.stringify({ attach: { claude: { status: 'done', request_key: 'claude', at: '2026-06-01T00:00:00.000Z' } } }, null, 2) + '\n'
    )

    /** @type {string[]} */
    const attachCalls = []
    const clients = clientsWith({ attachCalls })
    const reconciler = createActionReconciler({ stateRoot, handlers: [createAttachHandler()], log: NOOP_LOG })

    const r = await reconciler.reconcile(reconcileInput({ endpoint: 'http://127.0.0.1:55555', clients }))
    assert.deepEqual(r.results.map((x) => x.outcome), ['done'])
    assert.deepEqual(attachCalls, ['http://127.0.0.1:55555'], 'a legacy endpoint-less marker re-attaches once')
    assert.equal(readMarkerFile(stateRoot).attach.claude.endpoint, 'http://127.0.0.1:55555')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('an unresolvable endpoint this pass leaves the existing done attach untouched (#277 Gap 2)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    /** @type {string[]} */
    const attachCalls = []
    const clients = clientsWith({ attachCalls })
    const reconciler = createActionReconciler({ stateRoot, handlers: [createAttachHandler()], log: NOOP_LOG })

    // Attach at 40000.
    await reconciler.reconcile(reconcileInput({ endpoint: 'http://127.0.0.1:40000', clients }))
    assert.equal(attachCalls.length, 1)

    // A pass where the gateway never bound (endpoint undefined) must not churn
    // the existing attach: no re-perform, no failed marker, the done stays.
    const r = await reconciler.reconcile(reconcileInput({ endpoint: undefined, clients }))
    assert.deepEqual(r.results.map((x) => x.outcome), ['skipped'])
    assert.equal(attachCalls.length, 1, 'an unresolvable endpoint must not re-attach or fail the marker')
    assert.equal(readClientActionStatus({ stateRoot }).byKind.attach.claude.status, 'done')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})
