// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { createActionReconciler } from '../../src/core/config/action_reconciler.js'
import { createAttachHandler } from '../../src/core/config/action_attach.js'

/**
 * Regression for #217 (LLP 0044/0045): a manual `hyp detach <client>` must
 * retract the client's `attach` marker so a later `hyp join` re-attaches it.
 *
 * Before the fix, manual detach reversed the on-disk settings but left an
 * orphaned `status: "done"` attach marker in `client-actions.json`. The action
 * reconciler is level-triggered against that marker, so the next join's forward
 * gap short-circuits on `done` and never re-attaches: detach-via-config-drop was
 * rejoin-recoverable while detach-via-CLI was not. The two now converge on the
 * single core disk undo (LLP 0045 §Part 3) — manual detach retracts the marker
 * exactly as the reconciler's `reverse()` does.
 *
 * The whole join -> detach -> rejoin cycle is exercised end to end: the real
 * reconciler attaches (marker `done` + settings written), the real `hyp detach`
 * command reverses the settings *and* retracts the marker, and a second
 * reconcile re-attaches. A sibling client that was never detached stays attached
 * so the divergence is visible side by side, mirroring the issue report.
 *
 * @import { ClientDescriptor } from '../../src/core/types.js'
 */

const ENDPOINT = 'http://127.0.0.1:4388'
const FOREIGN_URL = 'https://foreign.example/api'

/** A quiet logger so the reconciler doesn't spam stderr. */
const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} }

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
 * A fake gateway registry whose `claude.attach()` writes the self-describing
 * `_hypaware` marker the real core undo (`detachClientFromDisk`) replays: a
 * managed `ANTHROPIC_BASE_URL` plus the prior URL to restore. `codex.attach()`
 * only records the call (codex is never detached in this test).
 *
 * @param {string} home
 * @param {string[]} calls  push the client name on each attach
 * @returns {any}
 */
function makeClients(home, calls) {
  const claudeSettingsPath = path.join(home, '.claude', 'settings.json')
  const registrations = {
    claude: {
      name: 'claude',
      defaultUpstream: 'anthropic',
      /** @param {any} ctx */
      async attach(ctx) {
        calls.push('claude')
        fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true })
        const body = {
          env: { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: ENDPOINT },
          _hypaware: {
            prev_base_url: FOREIGN_URL,
            managed: { env: { ANTHROPIC_BASE_URL: ENDPOINT }, hooks: [] },
          },
        }
        fs.writeFileSync(claudeSettingsPath, JSON.stringify(body, null, 2) + '\n')
        ctx.stdout.write(JSON.stringify({
          status: 'attached', action: 'attach', client: 'claude', dry_run: false,
          changed: true, settings_path: claudeSettingsPath, prev_value: FOREIGN_URL,
        }))
      },
    },
    codex: {
      name: 'codex',
      defaultUpstream: 'openai',
      /** @param {any} ctx */
      async attach(ctx) {
        calls.push('codex')
        ctx.stdout.write(JSON.stringify({
          status: 'attached', action: 'attach', client: 'codex', dry_run: false, changed: true,
        }))
      },
    },
  }
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
 * A joined-host reconcile input naming both client plugins.
 * @param {string} home
 * @param {any} clients
 */
function reconcileInput(home, clients) {
  return {
    config: /** @type {any} */ ({
      version: 2,
      plugins: [
        { name: '@hypaware/claude', enabled: true, config: {} },
        { name: '@hypaware/codex', enabled: true, config: {} },
      ],
    }),
    backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
    env: { ...process.env, HOME: home },
    clientDescriptors: new Map([['claude', CLAUDE_DESCRIPTOR], ['codex', CODEX_DESCRIPTOR]]),
    clients: /** @type {any} */ (clients),
    endpoint: ENDPOINT,
  }
}

/** @param {string} stateRoot */
function readMarkers(stateRoot) {
  const p = path.join(stateRoot, 'config-control', 'client-actions.json')
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function makeBuf() {
  let value = ''
  return {
    write(/** @type {unknown} */ chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

function fakeKernel() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  return { registry, kernel }
}

test('manual `hyp detach` retracts the attach marker so a later join re-attaches (#217)', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-detach-rejoin-'))
  const stateRoot = path.join(home, 'hypaware')
  const settingsPath = path.join(home, '.claude', 'settings.json')
  try {
    /** @type {string[]} */
    const attachCalls = []
    const clients = makeClients(home, attachCalls)

    let clock = Date.parse('2026-06-25T00:00:00.000Z')
    const reconciler = createActionReconciler({
      stateRoot,
      handlers: [createAttachHandler()],
      now: () => clock,
      log: NOOP_LOG,
    })

    // 1. Join: the reconciler attaches claude + codex (marker `done`, settings written).
    await reconciler.reconcile(reconcileInput(home, clients))
    assert.deepEqual([...attachCalls].sort(), ['claude', 'codex'], 'both clients attach on first join')
    let markers = readMarkers(stateRoot)
    assert.equal(markers.attach.claude.status, 'done')
    assert.equal(markers.attach.codex.status, 'done')
    assert.ok(
      '_hypaware' in JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
      'claude settings carry the attach marker after join'
    )

    // 2. Manual `hyp detach claude`: the real CLI command reverses the on-disk
    //    settings AND (the fix) retracts the orphaned attach marker.
    const { registry, kernel } = fakeKernel()
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(['detach', 'claude', '--json'], {
      stdout,
      stderr,
      registry,
      kernel,
      // HOME drives the .claude/settings.json path; HYP_HOME drives stateRoot.
      // CLAUDE_HOME is deliberately unset so the probe resolves under HOME.
      env: { ...process.env, HOME: home, HYP_HOME: home, CLAUDE_HOME: '' },
    })
    assert.equal(code, 0, stderr.text())

    // Settings reversed: marker stripped, prior base URL restored.
    const afterDetach = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    assert.equal('_hypaware' in afterDetach, false, 'detach stripped the settings marker')
    assert.equal(afterDetach.env.ANTHROPIC_BASE_URL, FOREIGN_URL, 'detach restored the prior base URL')

    // The core fix: the claude attach marker is gone; the un-detached sibling survives.
    markers = readMarkers(stateRoot)
    assert.equal(
      markers.attach?.claude,
      undefined,
      'manual detach must retract the orphaned claude attach marker (#217)'
    )
    assert.equal(markers.attach.codex.status, 'done', 'the un-detached sibling stays attached')

    // 3. Rejoin: the reconciler must RE-ATTACH claude (no stale `done` marker to
    //    short-circuit on) while codex is skipped (its marker is still `done`).
    attachCalls.length = 0
    clock += 1000
    await reconciler.reconcile(reconcileInput(home, clients))
    assert.deepEqual(attachCalls, ['claude'], 'rejoin re-attaches only the previously-detached client')
    markers = readMarkers(stateRoot)
    assert.equal(markers.attach.claude.status, 'done', 'claude re-attached (marker `done` again)')
    assert.ok(
      '_hypaware' in JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
      'claude settings re-written on rejoin'
    )
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})
