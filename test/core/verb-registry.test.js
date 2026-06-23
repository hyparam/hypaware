// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createVerbRegistry, verbAuthClass, verbExposure } from '../../src/core/registry/verbs.js'

/** @param {object} [over] */
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
  // Must not throw on the duplicate command name — the verb still registers.
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
