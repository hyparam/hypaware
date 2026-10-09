// @ts-check

// @hypaware/fastask before enablement (LLP 0480#enablement): bundled but out
// of default activation, so a default boot carries none of it; an explicit
// plugins[] entry activates it with exactly one source and no commands.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { V1_EXCLUDED_FROM_DEFAULT, discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { bootKernel } from '../../src/core/runtime/boot.js'

// @ref LLP 0480#enablement [tests]: nothing registered without an explicit plugins[] entry; with one, the source and no commands
test('fastask is bundled, excluded from default, and declares only its source', async () => {
  const catalog = await discoverBundledPlugins()
  assert.equal(catalog.failed.length, 0)
  assert.ok(V1_EXCLUDED_FROM_DEFAULT.has('@hypaware/fastask'))
  const entry = catalog.excluded.find((e) => e.manifest.name === '@hypaware/fastask')
  assert.ok(entry)
  assert.deepEqual(entry.manifest.contributes, { sources: [{ name: 'team-graph-replica' }] })
})

test('a default boot registers nothing of fastask; an explicit entry registers the source and no command', async (t) => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-fastask-activation-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const configPath = path.join(hypHome, 'hypaware-config.json')
  const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath }

  await fs.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false, plugins: [] }))
  const plain = await bootKernel({ hypHome, configPath, env })
  assert.ok(!plain.runtime.sources.list().some((s) => s.name === 'team-graph-replica'))

  await fs.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false, plugins: [{ name: '@hypaware/fastask' }] }))
  const explicit = await bootKernel({ hypHome, configPath, env })
  const activation = explicit.activations.find((a) => a.plugin.name === '@hypaware/fastask')
  assert.equal(activation?.ok, true)
  assert.deepEqual(explicit.runtime.sources.list().map((s) => s.name), ['team-graph-replica'])
  const commands = explicit.runtime.commands.list().filter((c) => c.plugin === '@hypaware/fastask')
  assert.deepEqual(commands, [], 'no commands before enablement')
})
