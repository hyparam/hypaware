// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { activate } from '../../hypaware-core/plugins-workspace/context-graph/src/index.js'

test('activate registers node/edge datasets, the three graph commands, and the hypaware-graph skill', async () => {
  /** @type {any[]} */ const datasets = []
  /** @type {any[]} */ const commands = []
  /** @type {any[]} */ const skills = []
  const ctx = /** @type {any} */ ({
    query: { registerDataset: (d) => datasets.push(d) },
    commands: { register: (c) => commands.push(c) },
    skills: { register: (s) => skills.push(s) },
  })

  await activate(ctx)

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
