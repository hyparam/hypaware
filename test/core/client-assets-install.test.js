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
import { materializeClientAssets } from '../../src/core/runtime/client_assets.js'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'

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

test('a listed contribution is a copy, so writing to it cannot reach the registry', () => {
  // `list()` used to be `items.slice()`: a copy of the array, whose elements
  // were the records the registry holds. `ctx.skills` and `ctx.agents` are on
  // the activation context, so a plugin calling `list()` inside its own
  // `activate()` held the stored record and could rewrite the `name` that had
  // just cleared `isSafeContributionName`, or push a client it never
  // registered for onto the array that decides which homes an install writes
  // into (hyparam/hypaware#1552).
  const { kernel } = agentsKernelAndRegistry()
  kernel.skills.register({ name: 'honest-skill', plugin: /** @type {any} */ ('p'), clients: ['claude'], sourceDir: '/abs/skill' })
  kernel.agents.register({ name: 'honest-agent', plugin: /** @type {any} */ ('p'), clients: ['claude'], sourceFile: '/abs/a.md' })

  for (const registry of [kernel.skills, kernel.agents]) {
    const handed = registry.list()[0]
    const validated = handed.name
    Object.defineProperty(handed, 'name', { get: () => 'IMPOSTOR' })
    handed.clients.push(/** @type {any} */ ('codex'))

    assert.equal(registry.list()[0].name, validated)
    assert.deepEqual(registry.list()[0].clients, ['claude'])
    // Two listings do not share entries either, or one caller's write would
    // still be another's read.
    assert.notEqual(registry.list()[0], registry.list()[0])
    assert.notEqual(registry.list()[0].clients, registry.list()[0].clients)
  }
})

test('an honest registration lists exactly what it registered, every time', () => {
  // The copies are only a fix while they are faithful: shape, values and
  // ordering are what `hyp skills install`, attach and the doctor read.
  const { kernel } = agentsKernelAndRegistry()
  const skills = [
    { name: 'first', plugin: /** @type {any} */ ('@hypaware/claude'), clients: /** @type {any} */ (['claude']), sourceDir: '/abs/first' },
    { name: 'second', plugin: /** @type {any} */ ('@hypaware/codex'), clients: /** @type {any} */ (['all']), sourceDir: '/abs/second', projectLocal: true },
  ]
  for (const skill of skills) kernel.skills.register(skill)
  kernel.agents.register({ name: 'analyst', plugin: /** @type {any} */ ('@hypaware/claude'), clients: ['claude'], sourceFile: '/abs/a.md' })

  assert.deepEqual(kernel.skills.list(), skills)
  assert.deepEqual(kernel.agents.list(), [{ name: 'analyst', plugin: '@hypaware/claude', clients: ['claude'], sourceFile: '/abs/a.md' }])
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

test('hyp skills install materializes skills and subagents in one command', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-assets-'))
  const sourceFile = path.join(home, 'src-agent.md')
  await fs.writeFile(sourceFile, '---\nname: test-analyst\n---\nbody\n', 'utf8')
  const sourceDir = path.join(home, 'src-skill')
  await fs.mkdir(sourceDir, { recursive: true })
  await fs.writeFile(path.join(sourceDir, 'SKILL.md'), 'skill body\n', 'utf8')

  const { kernel, registry } = agentsKernelAndRegistry()
  kernel.agents.register({
    name: 'test-analyst',
    plugin: /** @type {any} */ ('@hypaware/claude'),
    clients: ['claude'],
    sourceFile,
  })
  kernel.skills.register({
    name: 'test-skill',
    plugin: /** @type {any} */ ('@hypaware/claude'),
    clients: ['claude'],
    sourceDir,
  })

  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(['skills', 'install'], {
    stdout,
    stderr,
    env: { ...process.env, HOME: home },
    registry,
    kernel,
  })

  assert.equal(code, 0)
  // One command, both asset kinds: the agent lands as a flat `<name>.md`, the
  // skill as a directory tree (LLP 0138 #one-command).
  const agentDest = path.join(home, '.claude', 'agents', 'test-analyst.md')
  assert.equal(await fs.readFile(agentDest, 'utf8'), '---\nname: test-analyst\n---\nbody\n')
  const skillDest = path.join(home, '.claude', 'skills', 'test-skill', 'SKILL.md')
  assert.equal(await fs.readFile(skillDest, 'utf8'), 'skill body\n')
  assert.match(stdout.text(), /installed skill 'test-skill'/)
  assert.match(stdout.text(), /installed agent 'test-analyst'/)
  assert.match(stdout.text(), /installed 1 skill copy\(ies\), 1 agent copy\(ies\)/)

  // Update uses this same command: managed copies replace edits and restore
  // deletions, with no separate digest-based refresh policy.
  await fs.writeFile(skillDest, 'user edit\n')
  await fs.rm(agentDest)
  assert.equal(await dispatch(['skills', 'install'], {
    stdout, stderr, env: { ...process.env, HOME: home }, registry, kernel,
  }), 0)
  assert.equal(await fs.readFile(skillDest, 'utf8'), 'skill body\n')
  assert.equal(await fs.readFile(agentDest, 'utf8'), '---\nname: test-analyst\n---\nbody\n')
})

test('update-mode skills install respects attachment, client filtering, and a subsequent detach', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-attached-assets-'))
  try {
    const env = isolatedClientEnv(process.env, home)
    const { kernel, registry } = agentsKernelAndRegistry()
    const sourceDir = path.join(home, 'source-skill')
    const sourceFile = path.join(home, 'source-agent.md')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'SKILL.md'), 'current skill\n')
    await fs.writeFile(sourceFile, 'current agent\n')
    kernel.skills.register({ name: 'test-skill', plugin: '@hypaware/claude', clients: ['claude', 'codex'], sourceDir })
    kernel.agents.register({ name: 'test-agent', plugin: '@hypaware/claude', clients: ['claude'], sourceFile })
    const stdout = makeBuf()
    const stderr = makeBuf()
    const opts = { env, kernel, registry, stdout, stderr }
    const stateRoot = path.join(home, '.hyp', 'hypaware')
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const skillDir = path.join(home, '.claude', 'skills', 'test-skill')
    const agentPath = path.join(home, '.claude', 'agents', 'test-agent.md')

    // Registered contributions alone must not create client directories or a ledger.
    assert.equal(await dispatch(['skills', 'install', '--attached'], opts), 0)
    await assert.rejects(fs.stat(path.join(home, '.claude')), { code: 'ENOENT' })
    await assert.rejects(fs.stat(path.join(home, '.codex')), { code: 'ENOENT' })
    await assert.rejects(fs.stat(path.join(stateRoot, 'client-assets.json')), { code: 'ENOENT' })
    assert.match(stdout.text(), /no attached clients/)

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, JSON.stringify({ _hypaware: { managed: { env: {}, hooks: [] } } }))
    assert.equal(await dispatch(['skills', 'install', '--attached', '--client', 'codex'], opts), 0)
    await assert.rejects(fs.stat(skillDir), { code: 'ENOENT' })
    assert.equal(await dispatch(['skills', 'install', '--attached'], opts), 0)
    assert.equal(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), 'current skill\n')
    assert.equal(await fs.readFile(agentPath, 'utf8'), 'current agent\n')
    await assert.rejects(fs.stat(path.join(home, '.codex')), { code: 'ENOENT' })

    await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'local edit\n')
    await fs.rm(agentPath)
    assert.equal(await dispatch(['skills', 'install', '--attached'], opts), 0)
    assert.equal(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), 'current skill\n')
    assert.equal(await fs.readFile(agentPath, 'utf8'), 'current agent\n')

    // Seed the org attach's undo record so the real detach removes both assets.
    const actionsPath = path.join(stateRoot, 'config-control', 'client-actions.json')
    await fs.mkdir(path.dirname(actionsPath), { recursive: true })
    const actions = JSON.stringify({ attach: { claude: {
      status: 'done', request_key: 'claude', installed_assets: [skillDir, agentPath],
    } } })
    await fs.writeFile(actionsPath, actions)
    assert.equal(await dispatch(['detach', 'claude'], opts), 0, stderr.text())
    await assert.rejects(fs.stat(skillDir), { code: 'ENOENT' })
    await assert.rejects(fs.stat(agentPath), { code: 'ENOENT' })
    const ledger = await fs.readFile(path.join(stateRoot, 'client-assets.json'), 'utf8')
    // Even a leftover control-plane marker cannot override the settings probe.
    await fs.writeFile(actionsPath, actions)
    assert.equal(await dispatch(['skills', 'install', '--attached'], opts), 0)
    await assert.rejects(fs.stat(skillDir), { code: 'ENOENT' })
    await assert.rejects(fs.stat(agentPath), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(stateRoot, 'client-assets.json'), 'utf8'), ledger)
    await assert.rejects(fs.stat(path.join(home, '.codex')), { code: 'ENOENT' })

    await fs.writeFile(settingsPath, '{malformed')
    assert.equal(await dispatch(['skills', 'install', '--attached'], opts), 0)
    await assert.rejects(fs.stat(skillDir), { code: 'ENOENT' })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('hyp skills install sweeps orphaned refresh staging, and only that', async () => {
  // A v1.39-era refresh killed between its two renames leaves
  // `<dest>.hyp-refresh` and `<dest>.hyp-refresh-old` in the client's skills
  // directory, each a complete SKILL.md the client loads as a duplicate of the
  // same skill. The boot refresher that swept them is gone, so an explicit
  // install is the recovery path (#2407).
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-refresh-orphan-'))
  try {
    const sourceDir = path.join(home, 'src-skill')
    await fs.mkdir(sourceDir, { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '---\nname: demo-skill\n---\nv2 body\n', 'utf8')
    const sourceFile = path.join(home, 'src-agent.md')
    await fs.writeFile(sourceFile, 'agent body\n', 'utf8')

    const { kernel, registry } = agentsKernelAndRegistry()
    kernel.skills.register({ name: 'demo-skill', plugin: '@hypaware/claude', clients: ['claude'], sourceDir })
    kernel.agents.register({ name: 'demo-agent', plugin: '@hypaware/claude', clients: ['claude'], sourceFile })

    const skillsDir = path.join(home, '.claude', 'skills')
    const dest = path.join(skillsDir, 'demo-skill')
    const agentDest = path.join(home, '.claude', 'agents', 'demo-agent.md')
    await fs.mkdir(`${dest}.hyp-refresh`, { recursive: true })
    await fs.writeFile(path.join(`${dest}.hyp-refresh`, 'SKILL.md'), '---\nname: demo-skill\n---\nv2 body\n', 'utf8')
    await fs.mkdir(`${dest}.hyp-refresh-old`, { recursive: true })
    await fs.writeFile(path.join(`${dest}.hyp-refresh-old`, 'SKILL.md'), '---\nname: demo-skill\n---\nv1 body\n', 'utf8')
    await fs.mkdir(path.dirname(agentDest), { recursive: true })
    await fs.writeFile(`${agentDest}.hyp-refresh`, 'agent body\n', 'utf8')

    // Canaries: the skills directory is the user's own and the sweep is a
    // recursive delete inside it, so a file and a directory whose names merely
    // start with the staging prefix must survive.
    await fs.mkdir(path.join(skillsDir, 'demo-skill.hyp-refreshed-by-me'), { recursive: true })
    await fs.writeFile(path.join(skillsDir, 'demo-skill.hyp-refreshed-by-me', 'SKILL.md'), 'mine too\n', 'utf8')
    await fs.writeFile(path.join(skillsDir, 'notes.hyp-refresh.md'), 'my notes\n', 'utf8')
    await fs.mkdir(path.join(skillsDir, 'my-own-skill'), { recursive: true })
    await fs.writeFile(path.join(skillsDir, 'my-own-skill', 'SKILL.md'), 'mine\n', 'utf8')

    const stdout = makeBuf()
    const stderr = makeBuf()
    const opts = { stdout, stderr, env: { ...process.env, HOME: home }, registry, kernel }
    assert.equal(await dispatch(['skills', 'install'], opts), 0, stderr.text())

    await assert.rejects(fs.stat(`${dest}.hyp-refresh`), { code: 'ENOENT' })
    await assert.rejects(fs.stat(`${dest}.hyp-refresh-old`), { code: 'ENOENT' })
    await assert.rejects(fs.stat(`${agentDest}.hyp-refresh`), { code: 'ENOENT' })
    assert.match(stdout.text(), /removed leftover refresh staging .*demo-skill\.hyp-refresh\n/)
    assert.match(stdout.text(), /removed leftover refresh staging .*demo-skill\.hyp-refresh-old\n/)

    // Exactly one directory offers the skill now, so the client sees one copy.
    const offering = []
    for (const entry of await fs.readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const body = await fs.readFile(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf8').catch(() => '')
      if (body.includes('name: demo-skill')) offering.push(entry.name)
    }
    assert.deepEqual(offering, ['demo-skill'])
    assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), '---\nname: demo-skill\n---\nv2 body\n')

    assert.equal(await fs.readFile(path.join(skillsDir, 'demo-skill.hyp-refreshed-by-me', 'SKILL.md'), 'utf8'), 'mine too\n')
    assert.equal(await fs.readFile(path.join(skillsDir, 'notes.hyp-refresh.md'), 'utf8'), 'my notes\n')
    assert.equal(await fs.readFile(path.join(skillsDir, 'my-own-skill', 'SKILL.md'), 'utf8'), 'mine\n')

    // With nothing left over the command says exactly what it always said.
    const second = makeBuf()
    assert.equal(await dispatch(['skills', 'install'], { ...opts, stdout: second }), 0, stderr.text())
    assert.equal(
      second.text(),
      `installed skill 'demo-skill' \u2192 ${dest}\n` +
      `installed agent 'demo-agent' \u2192 ${agentDest}\n` +
      'installed 1 skill copy(ies), 1 agent copy(ies)\n'
    )
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a copy that did not land, and a dry run, sweep no refresh staging', async () => {
  // The sweep is authorized by this run having written the destination, which
  // is what makes a staging tree redundant rather than the only copy there is:
  // a kill between the two renames leaves `dest` absent and the previous copy
  // under `.hyp-refresh-old`.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-refresh-live-'))
  try {
    const skillsDir = path.join(home, '.claude', 'skills')
    const dest = path.join(skillsDir, 'demo-skill')
    const stepped = `${dest}.hyp-refresh-old`
    await fs.mkdir(stepped, { recursive: true })
    await fs.writeFile(path.join(stepped, 'SKILL.md'), 'the only copy\n', 'utf8')
    const descriptors = new Map([
      ['claude', { plugin: '@hypaware/claude', name: 'claude', skillDir: '.claude/skills' }],
    ])

    const failing = agentsKernelAndRegistry()
    failing.kernel.skills.register({
      name: 'demo-skill',
      plugin: '@hypaware/claude',
      clients: ['claude'],
      sourceDir: path.join(home, 'no-such-source'),
    })
    const stdout = makeBuf()
    const stderr = makeBuf()
    assert.equal(await dispatch(['skills', 'install'], {
      stdout, stderr, env: { ...process.env, HOME: home }, registry: failing.registry, kernel: failing.kernel,
    }), 0)
    assert.match(stderr.text(), /skill 'demo-skill' for claude failed/)
    assert.doesNotMatch(stdout.text(), /removed leftover/)
    // copyDir creates the destination before it reads the source, so a failed
    // copy can leave an empty `dest`; what it never leaves is a usable copy.
    await assert.rejects(fs.stat(path.join(dest, 'SKILL.md')), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(stepped, 'SKILL.md'), 'utf8'), 'the only copy\n')

    // A dry run is a plan, so it removes nothing either (hyp init --dry-run,
    // hyp attach --dry-run).
    const sourceDir = path.join(home, 'src-skill')
    await fs.mkdir(sourceDir, { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'SKILL.md'), 'real body\n', 'utf8')
    const planning = agentsKernelAndRegistry()
    planning.kernel.skills.register({ name: 'demo-skill', plugin: '@hypaware/claude', clients: ['claude'], sourceDir })
    const planned = makeBuf()
    await materializeClientAssets({
      clients: ['claude'],
      descriptors,
      homeDir: home,
      skills: planning.kernel.skills,
      dryRun: true,
      stdout: planned,
      stderr,
    })
    assert.match(planned.text(), /\(dry-run\) Would install/)
    assert.doesNotMatch(planned.text(), /removed leftover/)
    assert.equal(await fs.readFile(path.join(stepped, 'SKILL.md'), 'utf8'), 'the only copy\n')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a contribution named for the staging suffix is not swept by its own neighbour', async () => {
  // `<X>.hyp-refresh` is a legal single-segment contribution name, so the tree
  // the sweep derives from `X` can be a destination this same plan installs
  // rather than a leftover. Sweeping it deleted a copy the run had just made
  // and reported installed, on every run forever: the ledger went on naming it,
  // the prune reported nothing, and the client never saw the skill.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-refresh-collide-'))
  try {
    const plain = path.join(home, 'src-plain')
    await fs.mkdir(plain, { recursive: true })
    await fs.writeFile(path.join(plain, 'SKILL.md'), 'plain body\n', 'utf8')
    const suffixed = path.join(home, 'src-suffixed')
    await fs.mkdir(suffixed, { recursive: true })
    await fs.writeFile(path.join(suffixed, 'SKILL.md'), 'suffixed body\n', 'utf8')

    const { kernel, registry } = agentsKernelAndRegistry()
    // Registered first, so it is copied before the sweep that derives its path.
    kernel.skills.register({ name: 'demo.hyp-refresh', plugin: '@hypaware/claude', clients: ['claude'], sourceDir: suffixed })
    kernel.skills.register({ name: 'demo', plugin: '@hypaware/claude', clients: ['claude'], sourceDir: plain })

    const skillsDir = path.join(home, '.claude', 'skills')
    const stdout = makeBuf()
    const stderr = makeBuf()
    const opts = { stdout, stderr, env: { ...process.env, HOME: home }, registry, kernel }
    assert.equal(await dispatch(['skills', 'install'], opts), 0, stderr.text())

    // Both land, and the one whose name looks like staging keeps its own body.
    assert.equal(await fs.readFile(path.join(skillsDir, 'demo', 'SKILL.md'), 'utf8'), 'plain body\n')
    assert.equal(await fs.readFile(path.join(skillsDir, 'demo.hyp-refresh', 'SKILL.md'), 'utf8'), 'suffixed body\n')
    assert.doesNotMatch(stdout.text(), /removed leftover/)

    // A genuine leftover beside the same pair is still swept.
    await fs.mkdir(`${path.join(skillsDir, 'demo')}.hyp-refresh-old`, { recursive: true })
    await fs.writeFile(path.join(`${path.join(skillsDir, 'demo')}.hyp-refresh-old`, 'SKILL.md'), 'stale\n', 'utf8')
    const second = makeBuf()
    assert.equal(await dispatch(['skills', 'install'], { ...opts, stdout: second }), 0, stderr.text())
    await assert.rejects(fs.stat(`${path.join(skillsDir, 'demo')}.hyp-refresh-old`), { code: 'ENOENT' })
    assert.match(second.text(), /removed leftover refresh staging .*demo\.hyp-refresh-old\n/)
    assert.doesNotMatch(second.text(), /removed leftover refresh staging .*demo\.hyp-refresh\n/)
    assert.equal(await fs.readFile(path.join(skillsDir, 'demo.hyp-refresh', 'SKILL.md'), 'utf8'), 'suffixed body\n')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('hyp agents install is gone: agents is not a command', async () => {
  const { kernel, registry } = agentsKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['agents', 'install'], {
    stdout,
    stderr,
    env: { ...process.env },
    registry,
    kernel,
  })

  assert.notEqual(code, 0)
  assert.match(stderr.text(), /unknown command/i)
})

test('hyp skills install skips a client with no directory for that asset kind', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-assets-'))
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
  const code = await dispatch(['skills', 'install'], {
    stdout,
    stderr,
    env: { ...process.env, HOME: home },
    registry,
    kernel,
  })

  assert.equal(code, 0)
  // Codex has skills but no subagent concept, so this is a silent skip, not a
  // warning the user could act on.
  assert.equal(stderr.text(), '')
  assert.match(stdout.text(), /\(nothing to install\)/)
  await assert.rejects(fs.access(path.join(home, '.codex', 'agents')))
})

test('hyp skills install warns when a contribution names an unknown client', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-assets-'))
  const sourceDir = path.join(home, 'src-skill')
  await fs.mkdir(sourceDir, { recursive: true })
  await fs.writeFile(path.join(sourceDir, 'SKILL.md'), 'body\n', 'utf8')

  const { kernel, registry } = agentsKernelAndRegistry()
  kernel.skills.register({
    name: 'test-skill',
    plugin: /** @type {any} */ ('@hypaware/nonesuch'),
    clients: [/** @type {any} */ ('nonesuch')],
    sourceDir,
  })

  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(['skills', 'install'], {
    stdout,
    stderr,
    env: { ...process.env, HOME: home },
    registry,
    kernel,
  })

  assert.equal(code, 0)
  assert.match(stderr.text(), /targets unknown client 'nonesuch'/)
})

test('hyp skills install respects --client filtering', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-assets-'))
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
  const code = await dispatch(['skills', 'install', '--client', 'codex'], {
    stdout,
    stderr,
    env: { ...process.env, HOME: home },
    registry,
    kernel,
  })

  assert.equal(code, 0)
  assert.match(stdout.text(), /\(nothing to install\)/)
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
