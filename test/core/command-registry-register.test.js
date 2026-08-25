// @ts-check

/**
 * `register()` treats its argument as an input, not as the registry's
 * storage. The registry fills `category`, `audience`, and `bootProfile` at
 * the boundary so third-party commands participate without boilerplate;
 * doing that in place made the caller's object part of the mechanism, which
 * a frozen registration cannot survive and a rejected registration should
 * never have been subjected to.
 *
 * @ref LLP 0248#semantic-boot [tests]: the semantic defaults land on the registry's record, not on whatever object the caller happened to pass
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { isVerbProjection, verbToCommand } from '../../src/core/cli/verb_command.js'

/** @param {object} [over] @returns {any} */
function makeCommand(over = {}) {
  return { name: 'demo', summary: 'a demo command', usage: 'hyp demo', run: async () => 0, ...over }
}

test('register fills the semantic defaults on the stored record', () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand())
  const stored = commands.get('demo')
  assert.equal(stored?.category, 'demo')
  assert.equal(stored?.audience, 'everyday')
  assert.equal(stored?.bootProfile, 'config')
})

// The defaulting used to write straight into the argument, so a plugin that
// registered a frozen module-level constant got a TypeError out of the
// defaulting instead of a registered command.
test('register accepts a frozen registration object', () => {
  const commands = createCommandRegistry()
  const frozen = Object.freeze(makeCommand({ name: 'frozen', aliases: Object.freeze(['fz']) }))
  assert.doesNotThrow(() => commands.register(frozen))
  assert.equal(commands.get('frozen')?.audience, 'everyday')
  assert.equal(commands.get('fz')?.name, 'frozen')
})

test('register leaves the caller object unmodified on success', () => {
  const commands = createCommandRegistry()
  const registration = makeCommand()
  commands.register(registration)
  assert.equal('category' in registration, false)
  assert.equal('audience' in registration, false)
  assert.equal('bootProfile' in registration, false)
})

// A rejected registration is a no-op on the caller's side: the object it
// passed comes back exactly as it went in, so a retry under a different name
// does not silently inherit defaults derived from the name that lost.
test('a rejected duplicate leaves the caller object unmutated', () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand())
  const rejected = makeCommand({ summary: 'the loser' })
  assert.throws(() => commands.register(rejected), /duplicate command name 'demo'/)
  assert.deepEqual(Object.keys(rejected).sort(), ['name', 'run', 'summary', 'usage'])
})

test('a rejected alias collision leaves the caller object unmutated', () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand({ aliases: ['d'] }))
  const rejected = makeCommand({ name: 'other', aliases: ['d'] })
  assert.throws(() => commands.register(rejected), /collides with an existing command/)
  assert.deepEqual(Object.keys(rejected).sort(), ['aliases', 'name', 'run', 'summary', 'usage'])
})

// The copy is shallow on purpose: the stored record must keep pointing at the
// same `run`, and mutating the caller's object afterwards must not rewrite
// what dispatch will render.
test('the stored record keeps the callers run() but not its later edits', () => {
  const commands = createCommandRegistry()
  const registration = makeCommand()
  commands.register(registration)
  assert.equal(commands.get('demo')?.run, registration.run)
  registration.summary = 'edited after registration'
  assert.equal(commands.get('demo')?.summary, 'a demo command')
})

// The one thing the copy could have broken. `VerbRegistry.unregister` asks
// `isVerbProjection` whether the command sitting under a released verb name
// is the one the kernel projected, and the answer has to survive the record
// the registry actually stored, not just the object `verbToCommand` returned.
// @ref LLP 0264#verb [tests]: the projection mark rides on the registration, so a released verb name still retracts its own CLI command
test('a verb projection is still recognizable after the registry copies it', () => {
  const commands = createCommandRegistry()
  const projected = verbToCommand(/** @type {any} */ ({
    name: 'demo verb',
    tool: 'demo_verb',
    summary: 'a demo verb',
    inputSchema: { type: 'object', properties: {}, positional: [] },
    operation: async () => ({}),
    render: () => ({ stdout: '' }),
  }))
  assert.equal(isVerbProjection(projected), true)
  commands.register(projected)
  assert.equal(isVerbProjection(commands.get('demo verb')), true)
  // A plain command that merely shares the shape is not a projection.
  commands.register(makeCommand())
  assert.equal(isVerbProjection(commands.get('demo')), false)
})
