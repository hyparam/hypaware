// @ts-check

// An upgrade that retires a skill has to take the installed copy off the
// machine, and must take nothing else (#726, #660). Every test here drives the
// real `hyp skills install` path twice against one temp home: once with the
// "old" contribution set, once with the "new" one, which is what an in-place
// upgrade looks like from the materializer's side.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'

/**
 * A fresh kernel + command registry, the way a new process would boot one. Each
 * `hyp skills install` in these tests gets its own, because the point is that
 * the second run's registries no longer carry the retired contribution.
 */
function kernelAndRegistry() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  return { kernel, registry }
}

/** @returns {Promise<{ home: string, env: NodeJS.ProcessEnv }>} */
async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-prune-'))
  return { home, env: { ...process.env, HOME: home, HYP_HOME: path.join(home, '.hyp') } }
}

/**
 * Write a skill source tree and return its directory.
 *
 * @param {string} root
 * @param {string} name
 * @param {string} body
 * @returns {Promise<string>}
 */
async function writeSkillSource(root, name, body) {
  const dir = path.join(root, 'sources', name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), body, 'utf8')
  return dir
}

/**
 * Run `hyp skills install` with exactly `skills` (and `agents`) registered.
 *
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   skills?: { name: string, sourceDir: string }[],
 *   agents?: { name: string, sourceFile: string }[],
 * }} args
 */
async function installWith({ env, skills = [], agents = [] }) {
  const { kernel, registry } = kernelAndRegistry()
  for (const skill of skills) {
    kernel.skills.register({
      name: skill.name,
      plugin: /** @type {any} */ ('@hypaware/claude'),
      clients: ['claude'],
      sourceDir: skill.sourceDir,
    })
  }
  for (const agent of agents) {
    kernel.agents.register({
      name: agent.name,
      plugin: /** @type {any} */ ('@hypaware/claude'),
      clients: ['claude'],
      sourceFile: agent.sourceFile,
    })
  }
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(['skills', 'install'], { stdout, stderr, env, registry, kernel })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

/** @param {string} p @returns {Promise<boolean>} */
async function exists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

test('hyp skills install removes a skill the current manifests no longer declare', async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')
  const retiredSource = await writeSkillSource(home, 'hypaware-ignore', 'retired body\n')

  const first = await installWith({
    env,
    skills: [
      { name: 'hypaware-query', sourceDir: keptSource },
      { name: 'hypaware-ignore', sourceDir: retiredSource },
    ],
  })
  assert.equal(first.code, 0)
  const skillsDir = path.join(home, '.claude', 'skills')
  assert.ok(await exists(path.join(skillsDir, 'hypaware-ignore', 'SKILL.md')))

  // The upgrade: this version's plugins contribute only `hypaware-query`.
  const second = await installWith({
    env,
    skills: [{ name: 'hypaware-query', sourceDir: keptSource }],
  })

  assert.equal(second.code, 0)
  assert.equal(
    await exists(path.join(skillsDir, 'hypaware-ignore')),
    false,
    'the retired skill directory should have been removed by the upgrade install'
  )
  // Still declared, so still installed.
  assert.equal(await fs.readFile(path.join(skillsDir, 'hypaware-query', 'SKILL.md'), 'utf8'), 'query body\n')
  assert.match(second.stdout, /removed retired skill 'hypaware-ignore'/)
})

test('a retired subagent file is removed the same way a skill directory is', async () => {
  const { home, env } = await makeHome()
  const keptSource = path.join(home, 'sources', 'analyst.md')
  const retiredSource = path.join(home, 'sources', 'reporter.md')
  await fs.mkdir(path.dirname(keptSource), { recursive: true })
  await fs.writeFile(keptSource, 'analyst\n', 'utf8')
  await fs.writeFile(retiredSource, 'reporter\n', 'utf8')

  await installWith({
    env,
    agents: [
      { name: 'hypaware-analyst', sourceFile: keptSource },
      { name: 'hypaware-reporter', sourceFile: retiredSource },
    ],
  })
  const agentsDir = path.join(home, '.claude', 'agents')
  assert.ok(await exists(path.join(agentsDir, 'hypaware-reporter.md')))

  const second = await installWith({
    env,
    agents: [{ name: 'hypaware-analyst', sourceFile: keptSource }],
  })

  assert.equal(await exists(path.join(agentsDir, 'hypaware-reporter.md')), false)
  assert.ok(await exists(path.join(agentsDir, 'hypaware-analyst.md')))
  assert.match(second.stdout, /removed retired agent 'hypaware-reporter'/)
})

test("a user's own skill in the same directory is never removed", async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')
  const retiredSource = await writeSkillSource(home, 'hypaware-ignore', 'retired body\n')

  await installWith({
    env,
    skills: [
      { name: 'hypaware-query', sourceDir: keptSource },
      { name: 'hypaware-ignore', sourceDir: retiredSource },
    ],
  })

  // Authored by hand, in the same root, and never installed by HypAware. It has
  // no ledger record, which is the whole of its protection.
  const skillsDir = path.join(home, '.claude', 'skills')
  const mine = path.join(skillsDir, 'my-own-skill')
  await fs.mkdir(mine, { recursive: true })
  await fs.writeFile(path.join(mine, 'SKILL.md'), 'mine\n', 'utf8')
  // Even one named the way a retired HypAware skill was, if we never wrote it.
  const lookalike = path.join(skillsDir, 'hypaware-graph')
  await fs.mkdir(lookalike, { recursive: true })
  await fs.writeFile(path.join(lookalike, 'SKILL.md'), 'not ours\n', 'utf8')

  const second = await installWith({
    env,
    skills: [{ name: 'hypaware-query', sourceDir: keptSource }],
  })

  assert.equal(await fs.readFile(path.join(mine, 'SKILL.md'), 'utf8'), 'mine\n')
  assert.equal(await fs.readFile(path.join(lookalike, 'SKILL.md'), 'utf8'), 'not ours\n')
  // The one we did install is still gone, so the test is not passing by inertia.
  assert.equal(await exists(path.join(skillsDir, 'hypaware-ignore')), false)
  assert.doesNotMatch(second.stdout, /my-own-skill/)
})

test('a retired skill the user edited is left in place and named, never deleted', async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')
  const retiredSource = await writeSkillSource(home, 'hypaware-ignore', 'retired body\n')

  await installWith({
    env,
    skills: [
      { name: 'hypaware-query', sourceDir: keptSource },
      { name: 'hypaware-ignore', sourceDir: retiredSource },
    ],
  })

  const skillsDir = path.join(home, '.claude', 'skills')
  const edited = path.join(skillsDir, 'hypaware-ignore', 'SKILL.md')
  await fs.writeFile(edited, 'retired body\nmy own note\n', 'utf8')

  const second = await installWith({
    env,
    skills: [{ name: 'hypaware-query', sourceDir: keptSource }],
  })

  assert.equal(second.code, 0)
  assert.equal(
    await fs.readFile(edited, 'utf8'),
    'retired body\nmy own note\n',
    'a hand-edited retired skill must survive: the bytes are no longer ours to delete'
  )
  assert.match(second.stderr, /hypaware-ignore/)
  assert.match(second.stderr, /changed since HypAware installed it/)
})

test('an asset only the attach marker records is pruned too (pre-ledger installs)', async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')

  // What an older version left behind: the copy on disk, named by the attach
  // marker's `installed_assets` (LLP 0138 #marker-undo) and by nothing else,
  // because no ledger existed when it was written.
  const skillsDir = path.join(home, '.claude', 'skills')
  const stale = path.join(skillsDir, 'hypaware-ignore')
  await fs.mkdir(stale, { recursive: true })
  await fs.writeFile(path.join(stale, 'SKILL.md'), 'retired body\n', 'utf8')
  const controlDir = path.join(home, '.hyp', 'hypaware', 'config-control')
  await fs.mkdir(controlDir, { recursive: true })
  await fs.writeFile(
    path.join(controlDir, 'client-actions.json'),
    JSON.stringify({
      attach: {
        claude: {
          status: 'done',
          request_key: 'claude',
          at: '2026-08-01T00:00:00.000Z',
          installed_assets: [stale, path.join(skillsDir, 'hypaware-query')],
        },
      },
    }),
    'utf8'
  )

  const result = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.equal(result.code, 0)
  assert.equal(await exists(stale), false)
  assert.ok(await exists(path.join(skillsDir, 'hypaware-query', 'SKILL.md')))
  assert.match(result.stdout, /removed retired skill 'hypaware-ignore'/)
})

test('nothing is removed when this run installs nothing', async () => {
  const { home, env } = await makeHome()
  const source = await writeSkillSource(home, 'hypaware-query', 'query body\n')
  await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: source }] })

  // A boot that resolved no contributions at all (a broken plugin set, a config
  // that activates nothing) must not read as "every asset was retired".
  const second = await installWith({ env })

  assert.equal(second.code, 0)
  assert.ok(await exists(path.join(home, '.claude', 'skills', 'hypaware-query', 'SKILL.md')))
  assert.match(second.stdout, /\(nothing to install\)/)
})

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}
