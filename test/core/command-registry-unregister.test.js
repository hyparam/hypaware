// @ts-check

/**
 * Removal on the command registry: the surface a retracted verb name has
 * to be released from as well, since `registerVerb` projects a CLI
 * command the moment it claims a name.
 *
 * @ref LLP 0264#verb [tests]: a claimed name is released on both surfaces so a server can displace the kernel twin
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { createVerbRegistry } from '../../src/core/registry/verbs.js'

/** @param {object} [over] @returns {any} */
function makeCommand(over = {}) {
  return { name: 'demo', summary: 'a demo command', usage: 'hyp demo', run: async () => 0, ...over }
}

test('unregister removes the command from get, has, and list', () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand())
  commands.unregister('demo')
  assert.equal(commands.get('demo'), undefined)
  assert.equal(commands.has('demo'), false)
  assert.equal(commands.size(), 0)
  assert.deepEqual(commands.list().map((c) => c.name), [])
})

test('unregister clears the alias index entries pointing at the removed command', () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand({ aliases: ['d', 'dem'] }))
  commands.register(makeCommand({ name: 'other', aliases: ['o'] }))
  commands.unregister('demo')
  // A stale alias would keep the name unclaimable and route `hyp d` at a
  // command that is no longer registered.
  assert.equal(commands.get('d'), undefined)
  assert.equal(commands.has('dem'), false)
  assert.equal(commands.match(['d']), undefined)
  // Only the removed command's aliases go.
  assert.equal(commands.get('o')?.name, 'other')
})

test('a name and its aliases are free to be claimed again after unregister', () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand({ aliases: ['d'] }))
  commands.unregister('demo')
  assert.doesNotThrow(() => commands.register(makeCommand({ summary: 'the replacement', aliases: ['d'] })))
  assert.equal(commands.get('d')?.summary, 'the replacement')
})

test('unregister accepts an alias, exactly as get does', () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand({ aliases: ['d'] }))
  commands.unregister('d')
  assert.equal(commands.get('demo'), undefined)
  assert.equal(commands.has('d'), false)
})

test('unregister of an unknown name is a no-op, never a throw', () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand())
  assert.doesNotThrow(() => commands.unregister('nope'))
  assert.doesNotThrow(() => commands.unregister(''))
  assert.equal(commands.size(), 1)
})

test('top-level help no longer lists a retracted verb command', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-unregister-help-'))
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const verbs = createVerbRegistry({ commandRegistry: registry })
  verbs.register({
    name: 'demoverb',
    tool: 'demo_verb',
    summary: 'a demo verb nobody should see after retraction',
    inputSchema: { type: 'object', properties: {}, required: [] },
    operation: async () => ({}),
    render: () => ({ stdout: '' }),
  })
  createKernelRuntime({ commandRegistry: registry, verbRegistry: verbs })

  const before = await renderHelp(registry, hypHome)
  assert.equal(before.includes('demoverb'), true)

  verbs.unregister('demoverb')

  const after = await renderHelp(registry, hypHome)
  assert.equal(after.includes('demoverb'), false)
})

/**
 * @param {ReturnType<typeof createCommandRegistry>} registry
 * @param {string} hypHome
 * @returns {Promise<string>}
 */
async function renderHelp(registry, hypHome) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(['--help'], {
    stdout,
    stderr,
    registry,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
  })
  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  return stdout.text()
}

function makeBuf() {
  let value = ''
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

test('unregister retracts a core verb command projected before the kernel booted', () => {
  // The real boot path, and the one the affordance exists for: dispatch
  // runs `registerCoreCommands`, which pre-projects every core verb so
  // `hyp --help` renders without booting, then boot builds the runtime
  // over that same command registry, so the verb registry skips its own
  // projection. Retraction still has to release the CLI name, or a host
  // that displaces the verb keeps answering `hyp query sql` with the
  // kernel implementation it just took the tool slot from.
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const runtime = createKernelRuntime({ commandRegistry: registry })
  assert.ok(registry.get('query sql'))
  assert.ok(runtime.verbs.getByTool('query_sql'))

  runtime.verbs.unregister('query sql')

  assert.equal(runtime.verbs.getByTool('query_sql'), undefined)
  assert.equal(registry.get('query sql'), undefined)
  assert.equal(registry.has('query sql'), false)
  // `hyp query sql` no longer routes at the retracted command: the bare
  // group command is the longest registered prefix left.
  assert.equal(registry.match(['query', 'sql'])?.command.name, 'query')
})
