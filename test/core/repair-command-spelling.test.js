// @ts-check

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveGatewayEndpointForCli } from '../../hypaware-core/plugins-workspace/ai-gateway/src/session_command.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { listGroupChildren } from '../../src/core/cli/group_help.js'
import { runAttach } from '../../src/core/commands/clients.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { installFakeDaemonService } from '../helpers/daemon_service_fixture.js'

/**
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

// A repair a failure path prints is only a repair if the same binary can run
// it. `hyp start` was never registered (the lifecycle command is
// `hyp daemon start`), so following the printed advice produced a second
// failure: "hyp: unknown command 'start'". These tests resolve every `hyp ...`
// spelling the endpoint give-up messages name against the real core command
// registry, so a message can no longer name a command the dispatcher rejects.

/** Quoted or parenthesized `hyp <subcommand...>` mentions inside a message. */
const HYP_MENTION = /[`'(]+hyp ([a-z]+(?: [a-z]+)*)[`')]+/g

/**
 * @param {string} text
 * @returns {string[]}
 */
function hypCommandsIn(text) {
  return [...text.matchAll(HYP_MENTION)].map((m) => m[1])
}

/** @returns {ReturnType<typeof createCommandRegistry>} */
function coreRegistry() {
  const registry = createCommandRegistry()
  registerCoreCommands(/** @type {any} */ (registry))
  return registry
}

/**
 * Assert every spelling routes the way `hyp` itself routes it: the dispatcher
 * takes the longest registered prefix of argv, so a spelling with no
 * registered prefix at all is the "unknown command" dead end. Leftover tokens
 * are arguments, except under a group command, where a leftover is a
 * subcommand the group would reject.
 *
 * @param {ReturnType<typeof createCommandRegistry>} registry
 * @param {string[]} names
 * @param {string} source
 */
function assertAllRegistered(registry, names, source) {
  assert.ok(names.length > 0, `${source} named no hyp command to check`)
  for (const name of names) {
    const argv = name.split(' ')
    const hit = registry.match(argv)
    assert.ok(hit, `${source} recommends 'hyp ${name}', which is not a registered command`)
    if (hit.rest.length > 0 && listGroupChildren(registry, hit.command.name).length > 0) {
      assert.fail(
        `${source} recommends 'hyp ${name}', but 'hyp ${hit.command.name}' knows no '${hit.rest[0]}' subcommand`
      )
    }
  }
}

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
 * A context whose gateway capability is live but unbound and whose config
 * pins no ai-gateway `listen`: the shape that reaches the give-up messages.
 *
 * @param {string} home
 */
function makeUnboundCtx(home) {
  const gateway = {
    localEndpoint() {
      throw new Error('ai-gateway: localEndpoint() called before the gateway started')
    },
    /** @param {string} name */
    getClient(name) {
      return { name, async attach() {} }
    },
    listClients() {
      return [{ name: 'claude' }]
    },
  }
  const stderr = makeBuf()
  const ctx = /** @type {any} */ ({
    stdout: makeBuf(),
    stderr,
    cwd: home,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config: { version: 2 },
    capabilities: {
      has: () => true,
      require: () => gateway,
    },
  })
  return { ctx: /** @type {CommandRunContext} */ (ctx), stderr }
}

/** @param {(home: string) => Promise<void> | void} fn */
async function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-repair-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('attach give-up message (daemon installed) names only registered commands', async () => {
  await withTempHome(async (home) => {
    installFakeDaemonService(home)
    const { ctx, stderr } = makeUnboundCtx(home)
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assertAllRegistered(coreRegistry(), hypCommandsIn(stderr.text()), 'hyp attach (daemon installed)')
  })
})

test('attach give-up message (no daemon installed) names only registered commands', async () => {
  await withTempHome(async (home) => {
    const { ctx, stderr } = makeUnboundCtx(home)
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assertAllRegistered(coreRegistry(), hypCommandsIn(stderr.text()), 'hyp attach (no daemon)')
  })
})

test('session endpoint give-up message names only registered commands', async () => {
  await withTempHome(async (home) => {
    const ctx = /** @type {any} */ ({
      env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
      config: { version: 2 },
    })
    const resolution = resolveGatewayEndpointForCli(ctx)
    assert.equal(resolution.ok, false)
    assertAllRegistered(
      coreRegistry(),
      hypCommandsIn(String(resolution.error)),
      'hyp session endpoint resolution'
    )
  })
})
