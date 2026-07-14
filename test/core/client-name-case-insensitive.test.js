// @ts-check

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runAttach, runDetach } from '../../src/core/commands/clients.js'

/**
 * Regression for #300: `hyp attach Claude` / `hyp detach Claude` used to fail
 * with `unknown client 'Claude'` because the client token was matched
 * case-sensitively end to end. The products are branded "Claude"/"Codex" with
 * capitals, so the mixed-case token is a very plausible user mistake. The token
 * is now lowercased once in `parseClientArgs`, so attach, detach, and the `all`
 * sentinel are all case-insensitive. Adapters still register lowercase names.
 *
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

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
 * A live, bound gateway whose registry only knows the lowercase names
 * `claude`/`codex` (mirroring the real `state.clients.get(name)` map). Each
 * `attach()` records the resolved name so the test can assert the mixed-case
 * token routed to the lowercase adapter.
 *
 * @param {string[]} attachCalls
 */
function makeGatewayCtx(attachCalls) {
  const registered = new Set(['claude', 'codex'])
  const gateway = {
    localEndpoint() {
      return 'http://127.0.0.1:4388'
    },
    /** @param {string} name */
    getClient(name) {
      if (!registered.has(name)) return null
      return {
        name,
        async attach() {
          attachCalls.push(name)
        },
      }
    },
    listClients() {
      return [...registered].map((name) => ({ name }))
    },
  }
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    env: { HOME: '/tmp/no-home', HYP_HOME: '/tmp/no-home/.hyp' },
    config: { version: 2 },
    capabilities: {
      has: () => true,
      require: () => gateway,
    },
  })
  return { ctx: /** @type {CommandRunContext} */ (ctx), stdout, stderr }
}

test('attach Claude (capitalized) resolves to the lowercase claude adapter', async () => {
  /** @type {string[]} */
  const attachCalls = []
  const { ctx, stderr } = makeGatewayCtx(attachCalls)
  const code = await runAttach(['Claude'], ctx)
  assert.equal(code, 0, stderr.text())
  assert.deepEqual(attachCalls, ['claude'])
  assert.doesNotMatch(stderr.text(), /unknown client/)
})

test('attach ALL (uppercase sentinel) expands to every registered client', async () => {
  /** @type {string[]} */
  const attachCalls = []
  const { ctx, stderr } = makeGatewayCtx(attachCalls)
  const code = await runAttach(['ALL'], ctx)
  assert.equal(code, 0, stderr.text())
  assert.deepEqual(attachCalls.sort(), ['claude', 'codex'])
  assert.doesNotMatch(stderr.text(), /unknown client/)
})

test('attach claude (already lowercase) is unchanged', async () => {
  /** @type {string[]} */
  const attachCalls = []
  const { ctx, stderr } = makeGatewayCtx(attachCalls)
  const code = await runAttach(['claude'], ctx)
  assert.equal(code, 0, stderr.text())
  assert.deepEqual(attachCalls, ['claude'])
})

test('detach Claude (capitalized) resolves via the client-descriptor map', async () => {
  // Detach routes through the disk-driven core undo and the descriptor map
  // (keyed by lowercase manifest names), a DIFFERENT path from attach's live
  // gateway registry. With no on-disk marker under a temp HOME it is a no-op
  // success; the point is that the capitalized token resolves rather than
  // erroring `unknown client 'Claude'`.
  const home = mkdtempSync(path.join(tmpdir(), 'hyp-detach-case-'))
  try {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
      stdout,
      stderr,
      env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
      config: { version: 2 },
    }))
    const code = await runDetach(['Claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.doesNotMatch(stderr.text(), /unknown client/)
    assert.match(stdout.text(), /nothing to do/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
