// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { attach, detach, join, run, HypAwareCommandError } from '../../src/core/cli/integration.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

/**
 * A fake ai-gateway kernel that records attach/detach calls and emits JSON.
 *
 * `clientNames` controls which client adapters the *live* gateway registry
 * exposes; pass `[]` to model an adapter that has been dropped/unloaded while
 * the gateway capability itself is still active (the disk-driven detach must
 * still resolve such a client from the bundled descriptor map).
 *
 * @param {{ clientNames?: string[] }} [opts]
 */
function fakeClientKernel({ clientNames = ['claude', 'codex'] } = {}) {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  /** @type {Array<{ action: string, client: string, json: boolean }>} */
  const calls = []
  const clients = new Map(
    clientNames.map((name) => [
      name,
      {
        name,
        defaultUpstream: name === 'claude' ? 'anthropic' : 'openai',
        /** @param {any} ctx */
        async attach(ctx) {
          calls.push({ action: 'attach', client: name, json: ctx.json === true })
          if (ctx.json) {
            ctx.stdout.write(
              JSON.stringify({
                status: 'ok',
                action: 'attach',
                client: name,
                dry_run: ctx.dryRun === true,
                settings_path: `/tmp/${name}/settings.json`,
                changed: true,
                port: 4388,
              }) + '\n'
            )
          }
        },
        /** @param {any} ctx */
        async detach(ctx) {
          calls.push({ action: 'detach', client: name, json: ctx.json === true })
          if (ctx.json) {
            ctx.stdout.write(
              JSON.stringify({
                status: 'ok',
                action: 'detach',
                client: name,
                dry_run: ctx.dryRun === true,
                settings_path: `/tmp/${name}/settings.json`,
                changed: true,
              }) + '\n'
            )
          }
        },
      },
    ])
  )
  kernel.capabilities.provide('test', 'hypaware.ai-gateway', '2.0.0', {
    registerUpstreamPreset() {},
    registerClient() {},
    registerExchangeProjector() {},
    localEndpoint() {
      return 'http://127.0.0.1:4388'
    },
    /** @param {string} name */
    getClient(name) {
      return clients.get(name)
    },
    listClients() {
      return Array.from(clients.values())
    },
  })
  return { registry, kernel, calls }
}

/**
 * A kernel with NO `hypaware.ai-gateway` capability — models the gateway
 * plugin being uninstalled/unloaded. Detach must still run (it is the
 * disk-driven core undo resolved from the static descriptor map, LLP 0045
 * §Part 3); attach stays gated and fails cap_missing.
 */
function fakeKernelWithoutGateway() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  return { registry, kernel }
}

/** @returns {Promise<string>} */
async function freshHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-integration-'))
}

test('attach returns the parsed structured result', async () => {
  const { registry, kernel, calls } = fakeClientKernel()
  const result = await attach('claude', {
    hypHome: await freshHome(),
    // @ts-expect-error test-only kernel injection
    registry,
    kernel,
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.action, 'attach')
  assert.equal(result.client, 'claude')
  assert.equal(result.port, 4388)
  assert.equal(result.changed, true)
  assert.deepEqual(calls, [{ action: 'attach', client: 'claude', json: true }])
})

test('detach returns the parsed structured result (core disk undo)', async () => {
  const { registry, kernel, calls } = fakeClientKernel()
  // Isolate HOME/CODEX_HOME so the disk-driven detach targets a temp tree
  // (no marker present → a clean no-op) rather than the developer's files.
  const home = await freshHome()
  const result = await detach('codex', {
    hypHome: home,
    env: { ...process.env, HOME: home, CODEX_HOME: home },
    // @ts-expect-error test-only kernel injection
    registry,
    kernel,
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.action, 'detach')
  assert.equal(result.client, 'codex')
  // Detach is the single core disk-driven undo (LLP 0045 §Part 3), not a
  // per-adapter hook — the fake client's detach() is never dispatched.
  assert.deepEqual(calls, [])
})

test('detach reverses a client whose adapter was dropped from the live gateway (LLP 0045 §Part 3)', async () => {
  // The ai-gateway capability is present, but the codex adapter has been
  // dropped/unloaded — the live registry exposes no clients. Detach must still
  // resolve the target from the bundled+installed descriptor map and run the
  // disk-driven undo; it is NOT gated on gateway.getClient.
  const { registry, kernel, calls } = fakeClientKernel({ clientNames: [] })
  const home = await freshHome()
  const result = await detach('codex', {
    hypHome: home,
    env: { ...process.env, HOME: home, CODEX_HOME: home },
    // @ts-expect-error test-only kernel injection
    registry,
    kernel,
  })
  // Resolved + ran (no marker on the temp tree → clean no-op) rather than
  // failing "unknown client", and the (retired) adapter detach() is untouched.
  assert.equal(result.status, 'ok')
  assert.equal(result.action, 'detach')
  assert.equal(result.client, 'codex')
  assert.equal(result.changed, false)
  assert.deepEqual(calls, [])
})

test('detach resolves an INSTALLED (non-bundled) client adapter from the bundled+installed descriptor map (LLP 0045 §Part 3)', async () => {
  // buildClientDescriptorMap() was bundled-only while boot/status use
  // bundled+installed. Stage an installed client plugin with an attach_probe and
  // prove `hyp detach <client>` resolves its descriptor and runs the disk undo
  // — otherwise it would throw "no client descriptor".
  const { registry, kernel } = fakeClientKernel()
  const hypHome = await freshHome()
  const stateDir = path.join(hypHome, 'hypaware')
  const installDir = path.join(stateDir, 'plugins', 'widget')
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(
    path.join(installDir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name: '@acme/widget',
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      requires: { capabilities: { 'hypaware.ai-gateway': '^2.0.0' } },
      contributes: {
        client: {
          name: 'widget',
          skill_dir: '.widget/skills',
          attach_probe: { format: 'json', settings_file: '.widget/settings.json', marker_key: '_hypaware' },
        },
      },
    }, null, 2)
  )
  await fs.writeFile(path.join(installDir, 'index.js'), 'export async function activate() {}\n')
  await writeLock(stateDir, {
    schema_version: 1,
    plugins: {
      '@acme/widget': {
        name: '@acme/widget',
        version: '1.0.0',
        source: { kind: 'local-dir', raw: installDir, path: installDir },
        install_dir: installDir,
        content_hash: 'a'.repeat(64),
        manifest_hash: 'b'.repeat(64),
        installed_at: '2026-06-26T00:00:00.000Z',
      },
    },
  })

  const result = await detach('widget', {
    hypHome,
    env: { ...process.env, HOME: hypHome, HYP_HOME: hypHome },
    // @ts-expect-error test-only kernel injection
    registry,
    kernel,
  })
  // Resolved from the *installed* catalog (not bundled, not the live gateway)
  // and ran the disk undo to a clean no-op rather than failing "unknown client".
  assert.equal(result.status, 'ok')
  assert.equal(result.action, 'detach')
  assert.equal(result.client, 'widget')
  assert.equal(result.changed, false)
})

test('detach works with the @hypaware/ai-gateway capability absent (disk-driven undo, LLP 0045 §Part 3)', async () => {
  // The gateway plugin is not installed/loaded, so the capability is absent.
  // Detach is a pure on-disk undo resolved from the static descriptor map, so
  // it must still succeed — it is NOT gated on the live gateway. (Attach stays
  // gated; the next test proves it still fails cap_missing.)
  const { registry, kernel } = fakeKernelWithoutGateway()
  const home = await freshHome()
  const result = await detach('codex', {
    hypHome: home,
    env: { ...process.env, HOME: home, CODEX_HOME: home },
    // @ts-expect-error test-only kernel injection
    registry,
    kernel,
  })
  // Resolved 'codex' from the bundled descriptor map and ran the disk undo to a
  // clean no-op (no marker on the temp tree) — not a cap_missing failure.
  assert.equal(result.status, 'ok')
  assert.equal(result.action, 'detach')
  assert.equal(result.client, 'codex')
  assert.equal(result.changed, false)
})

test('attach stays gated on the @hypaware/ai-gateway capability (cap_missing)', async () => {
  // The counterpart to the detach-without-gateway test: attach genuinely needs
  // the live adapter, so with the capability absent it must fail cap_missing
  // rather than silently no-op.
  const { registry, kernel } = fakeKernelWithoutGateway()
  const home = await freshHome()
  const result = await run(['attach', 'codex', '--json'], {
    hypHome: home,
    env: { ...process.env, HOME: home, CODEX_HOME: home },
    // @ts-expect-error test-only kernel injection
    registry,
    kernel,
  })
  assert.equal(result.code, 1)
  const json = /** @type {any} */ (result.json)
  assert.equal(json.status, 'failed')
  assert.equal(json.action, 'attach')
  assert.equal(json.error_kind, 'cap_missing')
})

test('attach throws HypAwareCommandError for an unknown client', async () => {
  const { registry, kernel } = fakeClientKernel()
  const hypHome = await freshHome()
  await assert.rejects(
    () =>
      attach('nope', {
        hypHome,
        // @ts-expect-error test-only kernel injection
        registry,
        kernel,
      }),
    (err) => {
      assert.ok(err instanceof HypAwareCommandError)
      assert.notEqual(err.code, 0)
      return true
    }
  )
})

test('join writes the central seed and returns success', async () => {
  const hypHome = await freshHome()
  const result = await join('https://central.example', 'policy-token', { hypHome })
  assert.equal(result.code, 0)
  const seedPath = centralSeedPath(path.join(hypHome, 'hypaware'))
  const stat = await fs.stat(seedPath)
  assert.equal(stat.mode & 0o777, 0o600)
  const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'))
  assert.equal(seed.version, 2)
})

test('join throws HypAwareCommandError for an invalid url', async () => {
  const hypHome = await freshHome()
  await assert.rejects(
    () => join('not-a-url', 'tok', { hypHome }),
    (err) => {
      assert.ok(err instanceof HypAwareCommandError)
      assert.match(err.message, /join/)
      return true
    }
  )
})

test('join rejects dryRun instead of silently writing the seed', async () => {
  const hypHome = await freshHome()
  await assert.rejects(
    () =>
      join('https://central.example', 'policy-token', {
        hypHome,
        // @ts-expect-error dryRun is intentionally not part of join's options
        dryRun: true,
      }),
    (err) => {
      assert.ok(err instanceof HypAwareCommandError)
      assert.match(err.message, /dry-run/)
      return true
    }
  )
  // The whole point: a dry-run caller must not have mutated state.
  const seedPath = centralSeedPath(path.join(hypHome, 'hypaware'))
  await assert.rejects(() => fs.stat(seedPath), (err) => {
    assert.equal(/** @type {NodeJS.ErrnoException} */ (err).code, 'ENOENT')
    return true
  })
})

test('attach rejects the "all" target instead of dropping results', async () => {
  const { registry, kernel, calls } = fakeClientKernel()
  const hypHome = await freshHome()
  await assert.rejects(
    () =>
      attach('all', {
        hypHome,
        // @ts-expect-error test-only kernel injection
        registry,
        kernel,
      }),
    (err) => {
      assert.ok(err instanceof HypAwareCommandError)
      assert.match(err.message, /all/)
      return true
    }
  )
  // The guard fires before dispatch, so no client was touched.
  assert.deepEqual(calls, [])
})

test('detach rejects the "all" target instead of dropping results', async () => {
  const { registry, kernel, calls } = fakeClientKernel()
  const hypHome = await freshHome()
  await assert.rejects(
    () =>
      detach('all', {
        hypHome,
        // @ts-expect-error test-only kernel injection
        registry,
        kernel,
      }),
    (err) => {
      assert.ok(err instanceof HypAwareCommandError)
      assert.match(err.message, /all/)
      return true
    }
  )
  assert.deepEqual(calls, [])
})

test('run is the escape hatch for multi-client attach (every client surfaces)', async () => {
  const { registry, kernel } = fakeClientKernel()
  const hypHome = await freshHome()
  const result = await run(['attach', 'all', '--json'], {
    hypHome,
    // @ts-expect-error test-only kernel injection
    registry,
    kernel,
  })
  assert.equal(result.code, 0)
  const clients = result.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line).client)
    .sort()
  assert.deepEqual(clients, ['claude', 'codex'])
  // run().json keeps only the final line — exactly why attach()/detach()
  // reject 'all' rather than route the fan-out through that single result.
  assert.equal(/** @type {{ client: string }} */ (result.json).client, 'codex')
})

test('run().json recovers the JSON object past trailing non-JSON prose', async () => {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  kernel.capabilities.provide('test', 'hypaware.ai-gateway', '2.0.0', {
    registerUpstreamPreset() {},
    registerClient() {},
    registerExchangeProjector() {},
    localEndpoint() {
      return 'http://127.0.0.1:4388'
    },
    /** @param {string} name */
    getClient(name) {
      if (name !== 'claude') return undefined
      return {
        name: 'claude',
        /** @param {any} ctx */
        async attach(ctx) {
          ctx.stdout.write(
            JSON.stringify({ status: 'ok', action: 'attach', client: 'claude', changed: true }) + '\n'
          )
          // A trailing human line after the JSON would defeat a last-line-only parser.
          ctx.stdout.write('✓ Claude Code attached (/tmp/claude/settings.json)\n')
        },
      }
    },
    listClients() {
      return [{ name: 'claude' }]
    },
  })
  const hypHome = await freshHome()
  const result = await run(['attach', 'claude', '--json'], {
    hypHome,
    // @ts-expect-error test-only kernel injection
    registry,
    kernel,
  })
  const json = /** @type {{ status: string, client: string } | null} */ (result.json)
  assert.ok(json, 'expected the JSON object to be recovered past the trailing prose')
  assert.equal(json.status, 'ok')
  assert.equal(json.client, 'claude')
})

test('run exposes raw code and captured streams', async () => {
  const result = await run(['--help'])
  assert.equal(result.code, 0)
  assert.ok(result.stdout.length > 0)
})
