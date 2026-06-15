// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { activate } from '../../hypaware-core/plugins-workspace/context-graph/src/index.js'

test('activate provides the context-graph capability and registers node/edge datasets, the three graph commands, and the hypaware-graph skill', async () => {
  /** @type {any[]} */ const datasets = []
  /** @type {any[]} */ const commands = []
  /** @type {any[]} */ const skills = []
  /** @type {any[]} */ const caps = []
  const ctx = /** @type {any} */ ({
    query: { registerDataset: (d) => datasets.push(d) },
    commands: { register: (c) => commands.push(c) },
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
  assert.deepEqual(commands.map((c) => c.name).sort(), ['graph compact', 'graph neighbors', 'graph project'])

  assert.equal(skills.length, 1)
  const skill = skills[0]
  assert.equal(skill.name, 'hypaware-graph')
  assert.deepEqual(skill.clients, ['claude', 'codex'])

  // The install copies skill.sourceDir verbatim, so it must hold a SKILL.md
  // whose frontmatter name matches the registration.
  const md = await fs.readFile(path.join(skill.sourceDir, 'SKILL.md'), 'utf8')
  assert.match(md, /^---\nname: hypaware-graph\n/)
})
