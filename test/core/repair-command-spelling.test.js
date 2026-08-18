// @ts-check

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveGatewayEndpointForCli } from '../../hypaware-core/plugins-workspace/ai-gateway/src/session_command.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { isHelpFlag, listGroupChildren } from '../../src/core/cli/group_help.js'
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
//
// Both messages under test name core commands only. A give-up message reworded
// to name a *plugin* command (`hyp session ignore`, `hyp graph project`) would
// fail here against a core-only registry even though `hyp` accepts it; extend
// the registry rather than loosening the assertion if that day comes.

/**
 * Quoted or parenthesized `hyp <argv...>` mentions inside a message.
 *
 * The captured body is everything up to the closing delimiter rather than a
 * run of lowercase words, because a mention that carries a flag or a
 * placeholder (`hyp start --foreground`) is exactly the kind that must still
 * be resolved: a pattern that matched nothing there would skip it silently and
 * let the unrunnable-repair regression back in while the suite stayed green.
 */
const HYP_MENTION = /[`'(]+hyp ([^`'")\n]+)[`')]+/g

/**
 * @param {string} text
 * @returns {string[]}
 */
function hypCommandsIn(text) {
  return [...text.matchAll(HYP_MENTION)].map((m) => m[1].trim()).filter((name) => name.length > 0)
}

/** @returns {ReturnType<typeof createCommandRegistry>} */
function coreRegistry() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  return registry
}

/**
 * Assert every spelling routes the way `hyp` itself routes it: the dispatcher
 * takes the longest registered prefix of argv, so a spelling with no
 * registered prefix at all is the "unknown command" dead end. Leftover tokens
 * are arguments, except under a group command, where a leftover that is not a
 * help flag is a subcommand `makeGroupCommand` would reject.
 *
 * @param {ReturnType<typeof createCommandRegistry>} registry
 * @param {string[]} names
 * @param {string} source
 */
function assertAllRegistered(registry, names, source) {
  assert.ok(names.length > 0, `${source} named no hyp command to check`)
  for (const name of names) {
    const argv = name.split(/\s+/)
    // `hyp --help` names a flag on the binary, not a command to resolve.
    if (argv[0].startsWith('-')) continue
    const hit = registry.match(argv)
    assert.ok(hit, `${source} recommends 'hyp ${name}', which is not a registered command`)
    const leftover = hit.rest[0]
    if (leftover !== undefined && !isHelpFlag(leftover) && listGroupChildren(registry, hit.command.name).length > 0) {
      assert.fail(
        `${source} recommends 'hyp ${name}', but 'hyp ${hit.command.name}' knows no '${leftover}' subcommand`
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
