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

/** A fake ai-gateway kernel that records attach/detach calls and emits JSON. */
function fakeClientKernel() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  /** @type {Array<{ action: string, client: string, json: boolean }>} */
  const calls = []
  const clients = new Map(
    ['claude', 'codex'].map((name) => [
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

test('detach returns the parsed structured result', async () => {
  const { registry, kernel, calls } = fakeClientKernel()
  const result = await detach('codex', {
    hypHome: await freshHome(),
    // @ts-expect-error test-only kernel injection
    registry,
    kernel,
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.action, 'detach')
  assert.equal(result.client, 'codex')
  assert.deepEqual(calls, [{ action: 'detach', client: 'codex', json: true }])
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
