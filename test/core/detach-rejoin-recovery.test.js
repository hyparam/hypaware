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
import { writeLock } from '../../src/core/plugin_install/lock.js'

/**
 * Regression for #217 (LLP 0044/0045): a manual `hyp detach <client>` must
 * retract the client's `attach` marker so a later `hyp join` re-attaches it.
 *
 * Before the fix, manual detach reversed the on-disk settings but left an
 * orphaned `status: "done"` attach marker in `client-actions.json`. The action
 * reconciler is level-triggered against that marker, so the next join's forward
 * gap short-circuits on `done` and never re-attaches: detach-via-config-drop was
 * rejoin-recoverable while detach-via-CLI was not. The two now converge on the
 * single core disk undo (LLP 0045 §Part 3): manual detach retracts the marker
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

/**
 * Seed a stale `done` attach marker directly into the client-actions store, as
 * if a prior attach had completed. Lets these focused tests exercise the CLI
 * detach's best-effort marker retraction (and its probe-less guard) without
 * running a full reconcile first.
 *
 * @param {string} stateRoot
 * @param {string} kind
 * @param {string} requestKey
 */
function seedStaleMarker(stateRoot, kind, requestKey) {
  const dir = path.join(stateRoot, 'config-control')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'client-actions.json'),
    JSON.stringify({ [kind]: { [requestKey]: { status: 'done', request_key: requestKey } } }, null, 2) + '\n'
  )
}

/**
 * Stage an installed client plugin with NO `attach_probe`, so its descriptor is
 * probe-less: `perform()` could attach it, but the disk-driven `reverse()` has
 * nothing to replay (mirrors the #212 fixture). There is no bundled probe-less
 * client, so this is how the real CLI detach path resolves one via
 * `buildClientDescriptorMap`.
 *
 * @param {string} home
 */
async function stageProbelessClient(home) {
  const stateDir = path.join(home, 'hypaware')
  const name = '@hypaware/probeless'
  const installDir = path.join(stateDir, 'plugins', 'probeless')
  await fsp.mkdir(installDir, { recursive: true })
  await fsp.writeFile(
    path.join(installDir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      contributes: { client: { name: 'probeless', skill_dir: 'skills/probeless' } },
    }) + '\n'
  )
  await fsp.writeFile(path.join(installDir, 'index.js'), 'export async function activate() {}\n')
  await writeLock(stateDir, /** @type {any} */ ({
    schema_version: 1,
    plugins: {
      [name]: {
        name,
        version: '1.0.0',
        source: { kind: 'local-dir', raw: installDir, path: installDir },
        install_dir: installDir,
        content_hash: 'a'.repeat(64),
        manifest_hash: 'b'.repeat(64),
        installed_at: '2026-06-25T00:00:00.000Z',
      },
    },
  }))
}

test('detach of a probe-HAVING client with already-clean settings (changed:false) still clears its stale marker', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-detach-clean-'))
  const stateRoot = path.join(home, 'hypaware')
  try {
    // A stale `done` marker exists, but the on-disk settings are already clean
    // (no .claude/settings.json), so detachClientFromDisk returns changed:false.
    seedStaleMarker(stateRoot, 'attach', 'claude')

    const { registry, kernel } = fakeKernel()
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(['detach', 'claude', '--json'], {
      stdout,
      stderr,
      registry,
      kernel,
      env: { ...process.env, HOME: home, HYP_HOME: home, CLAUDE_HOME: '' },
    })
    assert.equal(code, 0, stderr.text())

    // The already-clean path: nothing on disk to reverse.
    const out = JSON.parse(stdout.text())
    assert.equal(out.changed, false, 'settings were already clean (changed:false)')

    // But the stale marker over those clean settings is still retracted: a
    // probe-HAVING client's changed:false means "already clean", safe to clear.
    const markers = readMarkers(stateRoot)
    assert.equal(
      markers.attach?.claude,
      undefined,
      'a stale marker over already-clean settings is cleared for a probe-having client'
    )
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test("detach of a probe-LESS client does NOT clear its marker (mirrors reverse()'s #212 exception)", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-detach-probeless-'))
  const stateRoot = path.join(home, 'hypaware')
  try {
    await stageProbelessClient(home)
    // A marker exists (applied out-of-band), but the descriptor has no probe, so
    // the disk-driven undo cannot honestly reverse it. reverse() KEEPS the
    // marker in this case rather than orphaning settings; the CLI must match.
    seedStaleMarker(stateRoot, 'attach', 'probeless')

    const { registry, kernel } = fakeKernel()
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(['detach', 'probeless', '--json'], {
      stdout,
      stderr,
      registry,
      kernel,
      env: { ...process.env, HOME: home, HYP_HOME: home, CLAUDE_HOME: '' },
    })
    assert.equal(code, 0, stderr.text())

    // The finding-2 guard: a probe-less detach leaves the marker in place. If the
    // `if (descriptor.attachProbe)` guard is removed, this marker is cleared and
    // the assertion below fails (the mutation check).
    const markers = readMarkers(stateRoot)
    assert.equal(
      markers.attach?.probeless?.status,
      'done',
      'a probe-less client keeps its marker (never silently orphaned) (#212)'
    )
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('detach still succeeds when the marker retraction throws (best-effort, not a detach failure)', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-detach-marker-throw-'))
  const stateRoot = path.join(home, 'hypaware')
  const settingsPath = path.join(home, '.claude', 'settings.json')
  try {
    // A real attach on disk so detach has settings to reverse (changed:true).
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: ENDPOINT },
        _hypaware: {
          prev_base_url: FOREIGN_URL,
          managed: { env: { ANTHROPIC_BASE_URL: ENDPOINT }, hooks: [] },
        },
      }, null, 2) + '\n'
    )

    // Force clearClientActionMarker to throw: a *directory* where the marker
    // file belongs makes its readFileSync fail (EISDIR). Any throw from the
    // retraction must be swallowed - without the best-effort try/catch this
    // would bubble up and fail the detach with exit 1.
    fs.mkdirSync(path.join(stateRoot, 'config-control', 'client-actions.json'), { recursive: true })

    const { registry, kernel } = fakeKernel()
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(['detach', 'claude', '--json'], {
      stdout,
      stderr,
      registry,
      kernel,
      env: { ...process.env, HOME: home, HYP_HOME: home, CLAUDE_HOME: '' },
    })
    // Exit 0 proves the best-effort catch swallowed the real throw; the detach
    // output (written after the catch) and the reversed settings prove execution
    // continued past it.
    assert.equal(code, 0, stderr.text())
    const out = JSON.parse(stdout.text())
    assert.equal(out.status, 'ok')
    assert.equal(out.changed, true, 'the settings reversal still landed')
    const afterDetach = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    assert.equal('_hypaware' in afterDetach, false, 'detach stripped the settings marker despite the marker-store throw')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})
