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
 * existence, a `done` attach marker short-circuits forever, so the client's
 * ANTHROPIC_BASE_URL keeps pointing at the old port and capture silently stops.
 *
 * The fix makes the attach marker endpoint-aware: it records the endpoint it
 * attached at, and an endpoint mismatch on a later pass is a *forward gap* that
 * re-attaches, rather than a permanent `done`.
 *
 * The endpoint is not the only thing that goes stale. Attach also installs the
 * client's skills and subagents, and the org can change what those are long
 * after enrollment without moving the port at all (LLP 0107 §currency), so the
 * marker records the asset set too. Both axes are exercised here because they
 * share one predicate.
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
 * @param {{
 *   endpoint: string | undefined,
 *   clients: any,
 *   home?: string,
 *   skills?: { name: string, clients: string[], sourceDir: string }[],
 * }} opts
 */
function reconcileInput({ endpoint, clients, home, skills }) {
  return {
    config: /** @type {any} */ ({ version: 2, plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }] }),
    backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
    // Without a skills registry the install half is inert, so the default input
    // keeps the real environment: nothing can reach a real HOME from here.
    env: home ? { HOME: home } : process.env,
    clientDescriptors: new Map([[CLAUDE_DESCRIPTOR.name, CLAUDE_DESCRIPTOR]]),
    clients,
    endpoint,
    ...(skills ? { skills: /** @type {any} */ ({ register() {}, list() { return skills } }) } : {}),
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

test('a changed asset set re-attaches at an unchanged endpoint (LLP 0107 currency)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // The scenario §currency promises and a login one-shot was rejected for:
    // the org adds a plugin months after enrollment. The daemon restarts, but a
    // pinned (or well-known default) port comes back identical, so an
    // endpoint-only freshness check would call the marker current forever and
    // the new skill would never land.
    const home = path.join(tmp, 'home')
    const sourceA = path.join(tmp, 'contrib', 'helper-a')
    const sourceB = path.join(tmp, 'contrib', 'helper-b')
    for (const dir of [sourceA, sourceB]) {
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(path.join(dir, 'SKILL.md'), `${path.basename(dir)}\n`, 'utf8')
    }
    const skillA = { name: 'helper-a', clients: ['claude'], sourceDir: sourceA }
    const skillB = { name: 'helper-b', clients: ['claude'], sourceDir: sourceB }
    const endpoint = 'http://127.0.0.1:40000'

    /** @type {string[]} */
    const attachCalls = []
    const clients = clientsWith({ attachCalls })
    const reconciler = createActionReconciler({ stateRoot, handlers: [createAttachHandler()], log: NOOP_LOG })

    // Enrollment: one contributed skill, recorded on the marker as a digest.
    const r1 = await reconciler.reconcile(reconcileInput({ endpoint, clients, home, skills: [skillA] }))
    assert.deepEqual(r1.results.map((x) => x.outcome), ['done'])
    const firstKey = readMarkerFile(stateRoot).attach.claude.assets_key
    assert.equal(typeof firstKey, 'string')

    // Same set, same endpoint: current, so no churn.
    const r2 = await reconciler.reconcile(reconcileInput({ endpoint, clients, home, skills: [skillA] }))
    assert.deepEqual(r2.results.map((x) => x.outcome), ['skipped'])
    assert.equal(attachCalls.length, 1, 'an unchanged asset set must not re-attach')

    // The org's new plugin contributes a second skill. Same endpoint, so only
    // the asset set makes this stale.
    const r3 = await reconciler.reconcile(reconcileInput({ endpoint, clients, home, skills: [skillA, skillB] }))
    assert.deepEqual(r3.results.map((x) => x.outcome), ['done'])
    assert.equal(attachCalls.length, 2, 'a changed asset set is a forward gap')
    assert.equal(
      await fsp.readFile(path.join(home, 'skills', 'claude', 'helper-b', 'SKILL.md'), 'utf8'),
      'helper-b\n',
      'the later-added skill lands without anyone re-running login'
    )
    assert.notEqual(readMarkerFile(stateRoot).attach.claude.assets_key, firstKey)

    // And it settles again rather than re-attaching every pass.
    const r4 = await reconciler.reconcile(reconcileInput({ endpoint, clients, home, skills: [skillA, skillB] }))
    assert.deepEqual(r4.results.map((x) => x.outcome), ['skipped'])
    assert.equal(attachCalls.length, 2)

    // The org withdraws the plugin again. The set shrinks, so this re-attach
    // copies only helper-a, and takes helper-b off the machine: this attach's
    // own record says it wrote that path, the plan no longer contains it, and
    // its bytes are unchanged (LLP 0218 #prune-on-materialize). Before that it
    // sat there until someone ran a detach.
    const r5 = await reconciler.reconcile(reconcileInput({ endpoint, clients, home, skills: [skillA] }))
    assert.deepEqual(r5.results.map((x) => x.outcome), ['done'])
    const dropped = path.join(home, 'skills', 'claude', 'helper-b')
    assert.equal(fs.existsSync(dropped), false, 'the withdrawn skill comes off the machine')
    assert.deepEqual(
      [...readMarkerFile(stateRoot).attach.claude.installed_assets].sort(),
      [path.join(home, 'skills', 'claude', 'helper-a'), dropped].sort(),
      'the undo record still names it: the union is unchanged, and it is what a ' +
        'prune that could not act (an edited copy, a locked path) would fall back on'
    )
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
