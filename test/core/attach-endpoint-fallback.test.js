// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'

/**
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

// Manual `hyp attach` when the gateway is not bound in the CLI process and the
// config carries no ai-gateway `listen` fallback (LLP 0045): the daemon-managed
// shape. The command must not leak the internal localEndpoint() error; it
// probes the on-disk attach state and reports "already attached" as a no-op
// success, or fails with a message pointing at the daemon / a pinned listen.

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * Build a CommandRunContext whose gateway capability is live but unbound
 * (localEndpoint() throws) and whose config has no ai-gateway listen.
 *
 * @param {{ home: string, attachCalls: string[], config?: object }} opts
 */
function makeCtx({ home, attachCalls, config }) {
  const gateway = {
    localEndpoint() {
      throw new Error('ai-gateway: localEndpoint() called before the gateway started')
    },
    /** @param {string} name */
    getClient(name) {
      return {
        name,
        async attach() {
          attachCalls.push(name)
        },
      }
    },
    listClients() {
      return [{ name: 'claude' }]
    },
  }
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    cwd: home,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config: config ?? { version: 2 },
    capabilities: {
      has: () => true,
      require: () => gateway,
    },
  })
  return { ctx: /** @type {CommandRunContext} */ (ctx), stdout, stderr }
}

/** @param {(home: string) => Promise<void> | void} fn */
async function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-attach-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('attach without endpoint: already-attached client is a no-op success', async () => {
  await withTempHome(async (home) => {
    // The claude attach probe (bundled manifest): .claude/settings.json with a
    // `_hypaware` marker object means "attached".
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ _hypaware: { version: '2.0.0', port: 60680 } })
    )
    /** @type {string[]} */
    const attachCalls = []
    const { ctx, stdout, stderr } = makeCtx({ home, attachCalls })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.match(stdout.text(), /already attached/)
    assert.match(stdout.text(), /daemon manages attach/)
    assert.deepEqual(attachCalls, [], 'adapter attach() must not run without an endpoint')
    assert.doesNotMatch(stderr.text(), /localEndpoint/)
  })
})

test('attach without endpoint: already-attached --json reports ok/unchanged', async () => {
  await withTempHome(async (home) => {
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ _hypaware: { version: '2.0.0' } })
    )
    const { ctx, stdout } = makeCtx({ home, attachCalls: [] })
    const code = await runAttach(['claude', '--json'], ctx)
    assert.equal(code, 0)
    const payload = JSON.parse(stdout.text())
    assert.equal(payload.status, 'ok')
    assert.equal(payload.action, 'attach')
    assert.equal(payload.client, 'claude')
    assert.equal(payload.changed, false)
    assert.equal(payload.attached, true)
    assert.equal(payload.settings_path, path.join(home, '.claude', 'settings.json'))
  })
})

test('attach without endpoint: not-attached client fails with actionable message', async () => {
  await withTempHome(async (home) => {
    /** @type {string[]} */
    const attachCalls = []
    const { ctx, stderr } = makeCtx({ home, attachCalls })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.match(stderr.text(), /cannot resolve the gateway endpoint/)
    assert.match(stderr.text(), /hyp start/)
    assert.doesNotMatch(stderr.text(), /localEndpoint\(\) called before/)
    assert.deepEqual(attachCalls, [])
  })
})

test('attach with configured listen still uses the config fallback', async () => {
  await withTempHome(async (home) => {
    /** @type {string[]} */
    const attachCalls = []
    const { ctx, stderr } = makeCtx({
      home,
      attachCalls,
      config: {
        version: 2,
        plugins: [{ name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787' } }],
      },
    })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.deepEqual(attachCalls, ['claude'])
  })
})
