// @ts-check

// An upgrade that retires a skill has to take the installed copy off the
// machine, and must take nothing else (#726, #660). Most tests here drive the
// real `hyp skills install` path twice against one temp home: once with the
// "old" contribution set, once with the "new" one, which is what an in-place
// upgrade looks like from the materializer's side. The last one drives the
// org-driven half (a reconciler attach pass) instead, because only a boot has
// plugins that can fail to activate.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createAttachHandler } from '../../src/core/config/action_attach.js'
import { createActionReconciler } from '../../src/core/config/action_reconciler.js'
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
 * `clients` defaults to `['claude']`; a test that needs two clients sharing one
 * physical directory names them explicitly.
 *
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   skills?: { name: string, sourceDir: string, clients?: string[] }[],
 *   agents?: { name: string, sourceFile: string, clients?: string[] }[],
 * }} args
 */
async function installWith({ env, skills = [], agents = [] }) {
  const { kernel, registry } = kernelAndRegistry()
  for (const skill of skills) {
    kernel.skills.register({
      name: skill.name,
      plugin: /** @type {any} */ ('@hypaware/claude'),
      clients: /** @type {any} */ (skill.clients ?? ['claude']),
      sourceDir: skill.sourceDir,
    })
  }
  for (const agent of agents) {
    kernel.agents.register({
      name: agent.name,
      plugin: /** @type {any} */ ('@hypaware/claude'),
      clients: /** @type {any} */ (agent.clients ?? ['claude']),
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

/**
 * Seed a `done` attach marker for `claude` naming `installed_assets`, the way an
 * org-driven attach records what it wrote (LLP 0138 #marker-undo).
 *
 * @param {string} home
 * @param {string[]} installedAssets
 * @returns {Promise<void>}
 */
async function seedAttachMarker(home, installedAssets) {
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
          installed_assets: installedAssets,
        },
      },
    }),
    'utf8'
  )
}

test('an asset only the attach marker records is named, never removed (pre-ledger installs)', async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')

  // What an older version left behind: the copy on disk, named by the attach
  // marker's `installed_assets` (LLP 0138 #marker-undo) and by nothing else,
  // because no ledger existed when it was written. The marker names the path;
  // it says nothing about the bytes, and `installed_assets` never shrinks, so
  // acting on it would delete whatever happens to sit at that name today.
  const skillsDir = path.join(home, '.claude', 'skills')
  const stale = path.join(skillsDir, 'hypaware-ignore')
  await fs.mkdir(stale, { recursive: true })
  // The user fixed the stale `8787` port themselves, which is exactly the
  // edit #726 describes and exactly what a digest would have caught.
  await fs.writeFile(path.join(stale, 'SKILL.md'), 'retired body, port fixed by hand\n', 'utf8')
  await seedAttachMarker(home, [stale, path.join(skillsDir, 'hypaware-query')])

  const result = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.equal(result.code, 0)
  assert.equal(
    await fs.readFile(path.join(stale, 'SKILL.md'), 'utf8'),
    'retired body, port fixed by hand\n',
    'a marker-named path carries no digest, so nothing proves the bytes are ours to delete'
  )
  assert.ok(await exists(path.join(skillsDir, 'hypaware-query', 'SKILL.md')))
  assert.doesNotMatch(result.stdout, /removed retired skill 'hypaware-ignore'/)
  assert.match(result.stderr, /hypaware-ignore/)
  assert.match(result.stderr, /no recorded content digest/)
})

test('a skill the user authored at a path the attach marker still names is never removed', async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')

  const skillsDir = path.join(home, '.claude', 'skills')
  const stale = path.join(skillsDir, 'hypaware-ignore')
  await fs.mkdir(stale, { recursive: true })
  await fs.writeFile(path.join(stale, 'SKILL.md'), 'retired body\n', 'utf8')
  await seedAttachMarker(home, [stale, path.join(skillsDir, 'hypaware-query')])

  await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  // However the pre-ledger copy leaves the machine, the marker keeps naming its
  // path: `installed_assets` is unioned across every rewrite and never shrinks.
  await fs.rm(stale, { recursive: true, force: true })

  // Months later the user writes their own skill under that name. Nothing
  // HypAware ever wrote is involved, and there is no source to re-copy from, so
  // a delete here is unrecoverable.
  await fs.mkdir(stale, { recursive: true })
  await fs.writeFile(path.join(stale, 'SKILL.md'), 'my own skill\n', 'utf8')

  const second = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.equal(second.code, 0)
  assert.equal(
    await fs.readFile(path.join(stale, 'SKILL.md'), 'utf8'),
    'my own skill\n',
    'a path the marker names is not evidence about the file sitting there now'
  )
})

test('a ledger record whose digest is not a string never becomes an unconditional delete', async () => {
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

  // A corrupt (or hand-edited) ledger: the digest is there, but it is a number.
  // Reading it as "no digest recorded" and then treating a missing digest as a
  // match is what turns an unreadable record into an unconditional delete.
  const ledgerPath = path.join(home, '.hyp', 'hypaware', 'client-assets.json')
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
  for (const record of ledger.assets) {
    if (record.name === 'hypaware-ignore') record.digest = 12345
  }
  await fs.writeFile(ledgerPath, JSON.stringify(ledger), 'utf8')

  const second = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.equal(second.code, 0)
  assert.equal(
    await fs.readFile(edited, 'utf8'),
    'retired body\nmy own note\n',
    'a wrong-typed digest must fail closed: an unreadable record can only ever remove less'
  )
})

test('a ledger record with no digest at all is withheld and reported', async () => {
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

  // Reachable without any corruption: the install records no digest when
  // `digestClientAsset` fails transiently on the copy it just made.
  const ledgerPath = path.join(home, '.hyp', 'hypaware', 'client-assets.json')
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
  for (const record of ledger.assets) {
    if (record.name === 'hypaware-ignore') delete record.digest
  }
  await fs.writeFile(ledgerPath, JSON.stringify(ledger), 'utf8')

  const second = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  const skillsDir = path.join(home, '.claude', 'skills')
  assert.equal(second.code, 0)
  assert.ok(
    await exists(path.join(skillsDir, 'hypaware-ignore', 'SKILL.md')),
    'a digest-less record proves the path was ours, never that the bytes still are'
  )
  assert.match(second.stderr, /hypaware-ignore/)
  assert.match(second.stderr, /no recorded content digest/)
})

test('a destination another client in the same run planned is never pruned', async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')
  const movedSource = await writeSkillSource(home, 'hypaware-privacy', 'privacy body\n')

  // `claude` and `claude-desktop` both declare `.claude/skills`, so one physical
  // path can be recorded under one client and planned under the other.
  await installWith({
    env,
    skills: [
      { name: 'hypaware-query', sourceDir: keptSource, clients: ['claude'] },
      { name: 'hypaware-privacy', sourceDir: movedSource, clients: ['claude'] },
    ],
  })

  const skillsDir = path.join(home, '.claude', 'skills')
  const shared = path.join(skillsDir, 'hypaware-privacy')
  assert.ok(await exists(path.join(shared, 'SKILL.md')))

  // The upgrade moves the privacy skill's declared client. Same bytes, same
  // path, still contributed by this very run: it is not retired by anyone.
  const second = await installWith({
    env,
    skills: [
      { name: 'hypaware-query', sourceDir: keptSource, clients: ['claude'] },
      { name: 'hypaware-privacy', sourceDir: movedSource, clients: ['claude-desktop'] },
    ],
  })

  assert.equal(second.code, 0)
  assert.match(second.stdout, /installed skill 'hypaware-privacy'/)
  assert.doesNotMatch(
    second.stdout,
    /removed retired skill 'hypaware-privacy'/,
    'a path this run just contributed must never be read as retired'
  )
  assert.equal(
    await fs.readFile(path.join(shared, 'SKILL.md'), 'utf8'),
    'privacy body\n',
    'the copy this run made must survive the same run'
  )
})

test('a recorded destination outside the client asset directories is refused out loud', async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')

  await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  // A record naming a path no write this module makes could ever produce is the
  // loudest available signal that the install record is corrupt. It is
  // correctly refused; refusing it in silence throws that signal away.
  const precious = path.join(home, 'PRECIOUS')
  await fs.mkdir(precious, { recursive: true })
  await fs.writeFile(path.join(precious, 'notes.md'), 'mine\n', 'utf8')
  const ledgerPath = path.join(home, '.hyp', 'hypaware', 'client-assets.json')
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
  ledger.assets.push({ kind: 'skill', name: 'bogus', client: 'claude', dest: precious })
  await fs.writeFile(ledgerPath, JSON.stringify(ledger), 'utf8')

  const second = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.equal(second.code, 0)
  assert.equal(await fs.readFile(path.join(precious, 'notes.md'), 'utf8'), 'mine\n')
  assert.match(second.stderr, /PRECIOUS/)
  assert.match(second.stderr, /outside/)
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

/**
 * The org-driven half of the same materialization: a reconciler pass whose
 * attach action installs (and prunes) the client's assets. Used for the guard
 * that only the daemon path can express, because only a boot has plugins that
 * can fail to activate.
 *
 * @param {{
 *   home: string,
 *   skills: { name: string, clients: string[], sourceDir: string }[],
 *   failedPlugins?: string[],
 *   endpoint?: string,
 * }} args
 * @returns {any}
 */
function attachReconcileInput({ home, skills, failedPlugins, endpoint = 'http://127.0.0.1:40000' }) {
  const registration = {
    name: 'claude',
    /** @param {{ endpoint: string, stdout: any }} ctx */
    async attach(ctx) {
      ctx.stdout.write(
        JSON.stringify({
          status: 'attached', action: 'attach', client: 'claude', dry_run: false,
          changed: true, settings_path: path.join(home, '.claude', 'settings.json'), port: 40000,
        }) + '\n'
      )
    },
  }
  return {
    config: /** @type {any} */ ({ version: 2, plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }] }),
    backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    clientDescriptors: new Map([
      ['claude', {
        plugin: /** @type {any} */ ('@hypaware/claude'),
        name: 'claude',
        skillDir: '.claude/skills',
        attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' },
      }],
    ]),
    clients: /** @type {any} */ ({
      getClient(/** @type {string} */ name) { return name === 'claude' ? registration : undefined },
      listClients() { return [registration] },
      registerClient() {}, registerUpstreamPreset() {},
      registerExchangeProjector() {}, registerSettlementEnricher() {},
    }),
    endpoint,
    skills: /** @type {any} */ ({ register() {}, list() { return skills } }),
    ...(failedPlugins ? { failedPlugins } : {}),
  }
}

test('a boot where a plugin failed to activate prunes nothing', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-prune-boot-'))
  const stateRoot = path.join(home, '.hyp', 'hypaware')
  const sourceA = await writeSkillSource(home, 'helper-a', 'helper-a\n')
  const sourceB = await writeSkillSource(home, 'helper-b', 'helper-b\n')
  const skillA = { name: 'helper-a', clients: ['claude'], sourceDir: sourceA }
  const skillB = { name: 'helper-b', clients: ['claude'], sourceDir: sourceB }
  const dropped = path.join(home, '.claude', 'skills', 'helper-b')

  const reconciler = createActionReconciler({
    stateRoot,
    handlers: [createAttachHandler()],
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })

  // Both plugins activate: both skills land, both are recorded.
  await reconciler.reconcile(attachReconcileInput({ home, skills: [skillA, skillB] }))
  assert.ok(await exists(path.join(dropped, 'SKILL.md')))

  // Now helper-b's plugin throws in `activate()`. `activatePlugins` catches per
  // plugin and boot returns normally, so the pass runs with a *partial* registry:
  // helper-b is absent from the plan for the same reason a retired skill is, and
  // nothing in the plan can tell the two apart.
  await reconciler.reconcile(
    attachReconcileInput({ home, skills: [skillA], failedPlugins: ['@hypaware/helper-b'] })
  )
  assert.ok(
    await exists(path.join(dropped, 'SKILL.md')),
    'a transient activation failure must not strip the client of a working skill'
  )

  // And the guard is scoped to that: a complete boot that really did retire
  // helper-b still takes it off the machine. (A rebind, so the marker is stale
  // on the endpoint axis and the pass actually re-attaches.)
  await reconciler.reconcile(
    attachReconcileInput({ home, skills: [skillA], endpoint: 'http://127.0.0.1:55555' })
  )
  assert.equal(await exists(dropped), false, 'a complete boot still prunes what it retired')

  await fs.rm(home, { recursive: true, force: true })
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
