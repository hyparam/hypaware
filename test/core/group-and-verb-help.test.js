// @ts-check

/**
 * Long help for the two shapes a plugin registers.
 *
 * @ref LLP 0214#d1 [tests]: a verb's `help` reaches the command registration dispatch renders
 * @ref LLP 0214#d2 [tests]: a plugin-owned group renders a header and paragraph, not a bare table
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { renderGroupHelp } from '../../src/core/cli/group_help.js'
import { verbToCommand } from '../../src/core/cli/verb_command.js'

/** @returns {{ out: () => string, write(chunk: string): void }} */
function capture() {
  let buf = ''
  return { out: () => buf, write(chunk) { buf += chunk } }
}

/** @param {Record<string, unknown>} extra */
function verb(extra = {}) {
  return /** @type {any} */ ({
    name: 'graph neighbors',
    tool: 'graph_neighbors',
    summary: 'Walk the graph',
    inputSchema: { type: 'object', properties: { node: { type: 'string' } }, required: ['node'], positional: ['node'] },
    operation: async () => ({ ok: true }),
    render: () => ({ stdout: '' }),
    ...extra,
  })
}

// --- T2: verbs carry long help ----------------------------------------------

test('a verb with help projects it onto the command registration', () => {
  const cmd = verbToCommand(verb({ help: 'Direction is load-bearing.' }))
  assert.equal(cmd.help, 'Direction is load-bearing.')
})

// Absent rather than undefined: the registration is spread into help
// rendering, and an explicit `help: undefined` would print an empty section.
test('a verb without help contributes no help key at all', () => {
  const cmd = verbToCommand(verb())
  assert.equal('help' in cmd, false)
})

test('the verb help passthrough does not disturb summary or usage', () => {
  const cmd = verbToCommand(verb({ help: 'x' }))
  assert.equal(cmd.summary, 'Walk the graph')
  assert.match(cmd.usage, /^hyp graph neighbors <node>/)
})

// --- T3: plugin-owned groups carry long help --------------------------------

test('registerGroup stores a description without adding a command', () => {
  const registry = createCommandRegistry()
  registry.registerGroup({ name: 'graph', summary: 'Build and walk the graph', help: 'Projected on demand.' })
  assert.equal(registry.getGroup('graph')?.summary, 'Build and walk the graph')
  // The whole point of metadata-only: it must not become a command, or it
  // would shadow dispatch and show up as a subcommand of itself.
  assert.equal(registry.get('graph'), undefined)
  assert.equal(registry.list().length, 0)
})

test('registerGroup rejects a missing name and non-string prose', () => {
  const registry = createCommandRegistry()
  assert.throws(() => registry.registerGroup(/** @type {any} */ ({})), /name/)
  assert.throws(() => registry.registerGroup(/** @type {any} */ ({ name: 'g', summary: 1 })), /summary/)
  assert.throws(() => registry.registerGroup(/** @type {any} */ ({ name: 'g', help: {} })), /help/)
})

test('re-registering a group replaces it rather than throwing', () => {
  const registry = createCommandRegistry()
  registry.registerGroup({ name: 'graph', summary: 'first' })
  registry.registerGroup({ name: 'graph', summary: 'second' })
  assert.equal(registry.getGroup('graph')?.summary, 'second')
})

test('group help renders the header and paragraph above the subcommand table', () => {
  const stdout = capture()
  renderGroupHelp({
    stdout,
    group: 'graph',
    groupCommand: { summary: 'Build and walk the graph', help: 'Projected on demand.' },
    children: [{ name: 'project', summary: 'Project the graph' }],
  })
  const out = stdout.out()
  assert.match(out, /^hyp graph - Build and walk the graph/)
  assert.match(out, /Projected on demand\./)
  assert.ok(out.indexOf('Projected on demand.') < out.indexOf('Subcommands:'), 'prose precedes the table')
})

// A group may register help without a summary. Before the guard this
// printed a literal `hyp graph - undefined` header.
test('a group with help but no summary renders no header line', () => {
  const stdout = capture()
  renderGroupHelp({
    stdout,
    group: 'graph',
    groupCommand: { help: 'Projected on demand.' },
    children: [{ name: 'project', summary: 'Project the graph' }],
  })
  const out = stdout.out()
  assert.doesNotMatch(out, /undefined/)
  assert.match(out, /Projected on demand\./)
})

test('an undescribed group still renders its table, as before', () => {
  const stdout = capture()
  renderGroupHelp({ stdout, group: 'graph', children: [{ name: 'project', summary: 'Project the graph' }] })
  const out = stdout.out()
  assert.doesNotMatch(out, /undefined/)
  assert.match(out, /Subcommands:/)
  assert.match(out, /project/)
})
