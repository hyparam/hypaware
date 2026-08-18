// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { activate } from '../../hypaware-core/plugins-workspace/context-graph/src/index.js'

test('activate provides the context-graph capability and registers node/edge datasets, the graph commands + graph_neighbors verb, its group help, and no skill', async () => {
  /** @type {any[]} */ const datasets = []
  /** @type {any[]} */ const commands = []
  /** @type {any[]} */ const verbs = []
  /** @type {any[]} */ const skills = []
  /** @type {any[]} */ const caps = []
  /** @type {any[]} */ const groups = []
  const ctx = /** @type {any} */ ({
    query: { registerDataset: (d) => datasets.push(d) },
    commands: { register: (c) => commands.push(c), registerGroup: (g) => groups.push(g) },
    verbs: { register: (v) => verbs.push(v) },
    skills: { register: (s) => skills.push(s) },
    provideCapability: (name, version, value) => caps.push({ name, version, value }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  })

  await activate(ctx)

  // The capability source plugins/connectors contribute contracts through.
  assert.equal(caps.length, 1)
  assert.equal(caps[0].name, 'hypaware.context-graph')
  assert.equal(caps[0].version, '1.0.0')
  assert.equal(typeof caps[0].value.registerContract, 'function')
  assert.equal(typeof caps[0].value.kit.makeRowBuilders, 'function')
  assert.equal(typeof caps[0].value.kit.nodeId, 'function')
  assert.equal(typeof caps[0].value.kit.edgeId, 'function')

  assert.deepEqual(datasets.map((d) => d.name).sort(), ['edge', 'node'])
  // `query graph neighbors` is a verb (projects a CLI command + the
  // graph_neighbors MCP tool); the two imperative graph ops stay commands.
  assert.deepEqual(commands.map((c) => c.name).sort(), ['graph compact', 'graph project'])
  assert.equal(verbs.length, 1)
  assert.equal(verbs[0].name, 'query graph neighbors')
  assert.equal(verbs[0].tool, 'graph_neighbors')
  assert.equal(verbs[0].authClass, 'read')

  // The group describes itself, so `hyp graph --help` opens with what the
  // graph is and that projection runs on demand, rather than a bare table.
  // @ref LLP 0214#d2 [tests]: a plugin namespace registers a group description
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, 'query graph')
  assert.match(groups[0].help, /hyp graph project/)

  // Mechanics belong in help, not in a skill narrating the command from
  // outside it. These are the two the graph skill used to carry.
  // @ref LLP 0214#d1 [tests]: the verb explains its own flags
  assert.match(verbs[0].help, /--direction/)
  assert.match(verbs[0].help, /--json, not --format json/)
  for (const command of commands) {
    assert.equal(typeof command.help, 'string', `${command.name} should explain itself`)
  }

  // No skill. `hypaware-graph` merged into `hypaware-query` (LLP 0213 #d2),
  // which the two gateway-requiring adapters ship, so the merged skill cannot
  // reach an install without the graph and a second skill buys nothing. The
  // mechanics it used to carry are this plugin's own `--help`, asserted above.
  // @ref LLP 0213#d2 [tests]: the graph plugin documents itself through help, not through a skill
  assert.deepEqual(skills, [], 'the graph plugin ships no skill of its own')
})
