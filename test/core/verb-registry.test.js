// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createVerbRegistry, verbAuthClass, verbExposure } from '../../src/core/registry/verbs.js'

/**
 * @import { VerbRegistration } from '../../hypaware-plugin-kernel-types.js'
 */

/**
 * @param {object} [over] overrides, deliberately loose: the malformed-verb
 *   cases below pass values a `Partial<VerbRegistration>` would reject
 * @returns {VerbRegistration}
 */
function makeVerb(over = {}) {
  return {
    name: 'demo verb',
    tool: 'demo_verb',
    summary: 'a demo verb',
    inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], positional: ['x'] },
    operation: async (/** @type {any} */ p) => ({ echoed: p.x }),
    render: (/** @type {any} */ r) => ({ stdout: `${r.echoed}\n` }),
    ...over,
  }
}

test('register projects a CLI command into the command registry', () => {
  const commands = createCommandRegistry()
  const verbs = createVerbRegistry({ commandRegistry: commands })
  verbs.register(makeVerb())
  const cmd = commands.get('demo verb')
  assert.ok(cmd)
  assert.equal(cmd.summary, 'a demo verb')
  assert.match(cmd.usage, /^hyp demo verb <x>/)
})

test('getByTool and get resolve the same verb; list is sorted', () => {
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  verbs.register(makeVerb({ name: 'b verb', tool: 'b_tool' }))
  verbs.register(makeVerb({ name: 'a verb', tool: 'a_tool' }))
  assert.equal(verbs.getByTool('a_tool')?.name, 'a verb')
  assert.equal(verbs.get('b verb')?.tool, 'b_tool')
  assert.deepEqual(verbs.list().map((v) => v.name), ['a verb', 'b verb'])
})

test('duplicate verb name and duplicate tool name are both rejected', () => {
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  verbs.register(makeVerb())
  assert.throws(() => verbs.register(makeVerb({ tool: 'other_tool' })), /verb 'demo verb' already registered/)
  assert.throws(() => verbs.register(makeVerb({ name: 'other verb' })), /tool 'demo_verb' already registered/)
})

test('projection is idempotent when a command of that name already exists', () => {
  const commands = createCommandRegistry()
  commands.register({ name: 'demo verb', summary: 's', usage: 'u', run: async () => 0 })
  const verbs = createVerbRegistry({ commandRegistry: commands })
  // Must not throw on the duplicate command name: the verb still registers.
  assert.doesNotThrow(() => verbs.register(makeVerb()))
  assert.ok(verbs.getByTool('demo_verb'))
})

test('exposure and auth-class default to cli+mcp / read', () => {
  assert.equal(verbExposure(makeVerb()), 'cli+mcp')
  assert.equal(verbAuthClass(makeVerb()), 'read')
  assert.equal(verbExposure(makeVerb({ exposure: 'local-only' })), 'local-only')
  assert.equal(verbAuthClass(makeVerb({ authClass: 'operator' })), 'operator')
})

test('validation rejects malformed verbs', () => {
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  assert.throws(() => verbs.register(makeVerb({ tool: '' })), /verb.tool is required/)
  assert.throws(() => verbs.register(makeVerb({ operation: undefined })), /operation\(\) is required/)
  assert.throws(() => verbs.register(makeVerb({ exposure: 'nonsense' })), /unknown exposure/)
})

// --- unregister: releasing a claimed name -----------------------------------

test('unregister frees both the name map and the tool map', () => {
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  verbs.register(makeVerb())
  verbs.unregister('demo verb')
  assert.equal(verbs.get('demo verb'), undefined)
  // The tool slot is the part the server re-checks before registering its
  // own implementation: a partial removal would degrade it silently.
  assert.equal(verbs.getByTool('demo_verb'), undefined)
  assert.deepEqual(verbs.list().map((v) => v.name), [])
})

test('a name released by unregister can be claimed again', () => {
  const commands = createCommandRegistry()
  const verbs = createVerbRegistry({ commandRegistry: commands })
  verbs.register(makeVerb())
  verbs.unregister('demo verb')
  assert.doesNotThrow(() => verbs.register(makeVerb({ summary: 'the replacement' })))
  assert.equal(verbs.get('demo verb')?.summary, 'the replacement')
  // The replacement's command projects too: retraction left the name free.
  assert.equal(commands.get('demo verb')?.summary, 'the replacement')
})

test('unregister of an unknown name is a no-op, never a throw', () => {
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  verbs.register(makeVerb())
  assert.doesNotThrow(() => verbs.unregister('no such verb'))
  // Idempotent: the second removal of a real name is a no-op too.
  verbs.unregister('demo verb')
  assert.doesNotThrow(() => verbs.unregister('demo verb'))
  assert.equal(verbs.get('demo verb'), undefined)
})

test('unregister retracts the CLI command the registration projected', () => {
  const commands = createCommandRegistry()
  const verbs = createVerbRegistry({ commandRegistry: commands })
  verbs.register(makeVerb())
  assert.ok(commands.get('demo verb'))
  verbs.unregister('demo verb')
  assert.equal(commands.get('demo verb'), undefined)
  assert.equal(commands.has('demo verb'), false)
  assert.deepEqual(commands.list().map((c) => c.name), [])
})

test('unregister leaves a same-named command the registration did not project', () => {
  const commands = createCommandRegistry()
  commands.register({ name: 'demo verb', summary: 'pre-existing', usage: 'u', run: async () => 0 })
  const verbs = createVerbRegistry({ commandRegistry: commands })
  verbs.register(makeVerb())
  verbs.unregister('demo verb')
  assert.equal(verbs.get('demo verb'), undefined)
  // Projection was skipped for this verb, so retraction must not delete
  // somebody else's command of the same name.
  assert.equal(commands.get('demo verb')?.summary, 'pre-existing')
})

test('a verb registry without a command registry unregisters cleanly', () => {
  const verbs = createVerbRegistry()
  verbs.register(makeVerb())
  assert.doesNotThrow(() => verbs.unregister('demo verb'))
  assert.equal(verbs.getByTool('demo_verb'), undefined)
})

test('a command registry that predates unregister degrades, never throws', () => {
  // `CommandRegistry.unregister` is optional in the published contract, so
  // an injected registry may not have it. Retraction has to tolerate that
  // (a throw here takes daemon boot down) while still releasing the verb.
  /** @type {any} */
  const legacy = createCommandRegistry()
  delete legacy.unregister
  const verbs = createVerbRegistry({ commandRegistry: legacy })
  verbs.register(makeVerb())
  assert.ok(legacy.get('demo verb'))
  assert.doesNotThrow(() => verbs.unregister('demo verb'))
  assert.equal(verbs.get('demo verb'), undefined)
  assert.equal(verbs.getByTool('demo_verb'), undefined)
  // The stale CLI command is the one thing left behind, which is exactly
  // what the warn on that branch reports.
  assert.ok(legacy.get('demo verb'))
})

test('a command registry whose get() answers null degrades, never throws', () => {
  // The projection test reads a property off whatever `get` returned, so an
  // injected registry answering `null` where the contract says `undefined`
  // would throw straight out of retraction. Same rule as the missing
  // `unregister` above: a throw here takes daemon boot down, so the verb is
  // released and the stale command is the only thing left behind.
  /** @type {any} */
  const offContract = createCommandRegistry()
  offContract.get = () => null
  const verbs = createVerbRegistry({ commandRegistry: offContract })
  verbs.register(makeVerb())
  assert.doesNotThrow(() => verbs.unregister('demo verb'))
  assert.equal(verbs.get('demo verb'), undefined)
  assert.equal(verbs.getByTool('demo_verb'), undefined)
})

test('unregister retracts a projection a different registry made over the same command registry', () => {
  // A runtime re-created over a shared command registry: the second
  // registry's own projection is skipped because the name is taken, but
  // the command under that name is still a verb projection and retraction
  // has to give it back. Tracking "did *this* registry project it" would
  // leave the stale command routing `hyp demo verb` at the released verb.
  const commands = createCommandRegistry()
  const first = createVerbRegistry({ commandRegistry: commands })
  first.register(makeVerb())
  const second = createVerbRegistry({ commandRegistry: commands })
  second.register(makeVerb())
  second.unregister('demo verb')
  assert.equal(commands.get('demo verb'), undefined)
  assert.equal(commands.has('demo verb'), false)
})
