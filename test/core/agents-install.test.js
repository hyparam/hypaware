// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'

function agentsKernelAndRegistry() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  return { kernel, registry }
}

test('agents.register validates contribution shape', () => {
  const { kernel } = agentsKernelAndRegistry()

  assert.throws(
    () => kernel.agents.register(/** @type {any} */ ({})),
    /name is required/
  )
  assert.throws(
    () => kernel.agents.register(/** @type {any} */ ({ name: 'a' })),
    /plugin is required/
  )
  assert.throws(
    () => kernel.agents.register(/** @type {any} */ ({ name: 'a', plugin: 'p', clients: [] })),
    /clients must be a non-empty array/
  )
  assert.throws(
    () => kernel.agents.register(/** @type {any} */ ({ name: 'a', plugin: 'p', clients: ['claude'] })),
    /sourceFile is required/
  )

  kernel.agents.register({
    name: 'a',
    plugin: /** @type {any} */ ('p'),
    clients: ['claude'],
    sourceFile: '/abs/a.md',
  })
  assert.equal(kernel.agents.list().length, 1)
  assert.deepEqual(kernel.agents.list()[0], {
    name: 'a',
    plugin: 'p',
    clients: ['claude'],
    sourceFile: '/abs/a.md',
  })
})

test('agents.register rejects path-traversal names', () => {
  const { kernel } = agentsKernelAndRegistry()

  for (const name of ['../evil', '../../etc/cron.d/x', 'a/b', '/abs', '..', '.']) {
    assert.throws(
      () => kernel.agents.register(/** @type {any} */ ({
        name,
        plugin: 'p',
        clients: ['claude'],
        sourceFile: '/abs/a.md',
      })),
      /name must be a safe basename/,
      `expected ${JSON.stringify(name)} to be rejected`
    )
  }
  assert.equal(kernel.agents.list().length, 0)
})

test('skills.register rejects path-traversal names', () => {
  const { kernel } = agentsKernelAndRegistry()

  for (const name of ['../evil', 'a/b', '/abs', '..']) {
    assert.throws(
      () => kernel.skills.register(/** @type {any} */ ({
        name,
        plugin: 'p',
        clients: ['claude'],
        sourceDir: '/abs/skill',
      })),
      /name must be a safe basename/,
      `expected ${JSON.stringify(name)} to be rejected`
    )
  }
  assert.equal(kernel.skills.list().length, 0)
})

test('hyp agents install copies registered agent files into the client agent dir', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-agents-'))
  const sourceFile = path.join(home, 'src-agent.md')
  await fs.writeFile(sourceFile, '---\nname: test-analyst\n---\nbody\n', 'utf8')

  const { kernel, registry } = agentsKernelAndRegistry()
  kernel.agents.register({
    name: 'test-analyst',
    plugin: /** @type {any} */ ('@hypaware/claude'),
    clients: ['claude'],
    sourceFile,
  })

  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(['agents', 'install'], {
    stdout,
    stderr,
    env: { ...process.env, HOME: home },
    registry,
    kernel,
  })

  assert.equal(code, 0)
  const dest = path.join(home, '.claude', 'agents', 'test-analyst.md')
  const installed = await fs.readFile(dest, 'utf8')
  assert.equal(installed, '---\nname: test-analyst\n---\nbody\n')
  assert.match(stdout.text(), /installed agent 'test-analyst'/)
  assert.match(stdout.text(), /installed 1 agent copy/)
})

test('hyp agents install warns when the target client has no agent dir', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-agents-'))
  const sourceFile = path.join(home, 'src-agent.md')
  await fs.writeFile(sourceFile, 'body\n', 'utf8')

  const { kernel, registry } = agentsKernelAndRegistry()
  kernel.agents.register({
    name: 'test-analyst',
    plugin: /** @type {any} */ ('@hypaware/codex'),
    clients: ['codex'],
    sourceFile,
  })

  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(['agents', 'install'], {
    stdout,
    stderr,
    env: { ...process.env, HOME: home },
    registry,
    kernel,
  })

  assert.equal(code, 0)
  assert.match(stderr.text(), /without an agent directory/)
  assert.match(stdout.text(), /installed 0 agent copy/)
  await assert.rejects(fs.access(path.join(home, '.codex', 'agents')))
})

test('hyp agents install respects --client filtering', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-agents-'))
  const sourceFile = path.join(home, 'src-agent.md')
  await fs.writeFile(sourceFile, 'body\n', 'utf8')

  const { kernel, registry } = agentsKernelAndRegistry()
  kernel.agents.register({
    name: 'test-analyst',
    plugin: /** @type {any} */ ('@hypaware/claude'),
    clients: ['claude'],
    sourceFile,
  })

  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(['agents', 'install', '--client', 'codex'], {
    stdout,
    stderr,
    env: { ...process.env, HOME: home },
    registry,
    kernel,
  })

  assert.equal(code, 0)
  assert.match(stdout.text(), /installed 0 agent copy/)
  await assert.rejects(fs.access(path.join(home, '.claude', 'agents', 'test-analyst.md')))
})

test('bundled @hypaware/claude manifest declares the hypaware-analyst agent', async () => {
  const manifestPath = path.resolve(
    'hypaware-core/plugins-workspace/claude/hypaware.plugin.json'
  )
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  assert.equal(manifest.contributes.client.agent_dir, '.claude/agents')
  assert.deepEqual(manifest.contributes.agents, [
    { name: 'hypaware-analyst', clients: ['claude'] },
  ])

  const agentFile = path.resolve(
    'hypaware-core/plugins-workspace/claude/agents/hypaware-analyst.md'
  )
  const body = await fs.readFile(agentFile, 'utf8')
  assert.match(body, /^---\nname: hypaware-analyst\n/)
})

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
