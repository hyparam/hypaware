// @ts-check

/**
 * The manifest, the registration code, and the directories on disk must name the same
 * skills.
 *
 * @ref LLP 0197#t12-graph-was-already-owned [tests]: a skill set is stated in three
 * places, and nothing checked they agreed
 *
 * A client plugin declares its skills three times: `contributes.skills` in
 * `hypaware.plugin.json` (what the manifest advertises), the list `activate()` passes to
 * `ctx.skills.register` (what actually gets installed), and the directories under
 * `skills/` (what exists to install). Any one can be edited without the others.
 *
 * The T12 merge (LLP 0197) proved that costs real breakage. It replaced five skill
 * directories with one and updated neither the manifests nor the registration lists, so
 * both plugins would have tried to install five skills that no longer existed and would
 * never have installed `hypaware-report`. Nothing in the suite noticed, because nothing
 * compared the three lists. This does.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')
const workspace = path.join(repoRoot, 'hypaware-core/plugins-workspace')

const CLIENTS = ['claude', 'codex']

/**
 * Skills the plugin's `activate()` actually registers, captured by running it against a
 * stub context rather than parsed out of the source: the registration call is what
 * installs a skill, so that is what must be checked.
 *
 * @param {string} client
 * @returns {Promise<{ name: string, sourceDir: string }[]>}
 */
async function registeredSkills(client) {
  /** @type {{ name: string, sourceDir: string }[]} */
  const skills = []
  const noop = () => {}
  // Any method, returning another permissive object. Used ONLY for the gateway
  // capability, whose surface is broad (upstream presets, exchange projectors,
  // settlement enrichers, client registration) and entirely beside the point here.
  // Enumerating it would make this test fail whenever the gateway grows a method,
  // which says nothing about whether the skill lists agree.
  const anything = new Proxy(() => anything, { get: () => anything, apply: () => anything })

  // ctx itself stays explicit: a new ctx dependency should surface as a clear failure.
  const ctx = /** @type {any} */ ({
    skills: { register: (/** @type {any} */ s) => skills.push(s) },
    agents: { register: noop },
    commands: { register: noop },
    backfills: { register: noop },
    sources: { register: noop },
    query: { registerDataset: noop },
    configRegistry: { registerSection: noop },
    initPresets: { register: noop },
    paths: { stateDir: '/tmp/hyp-test-state' },
    plugin: { version: '0.0.0-test' },
    env: {},
    stdout: { write: noop },
    stderr: { write: noop },
    log: { info: noop, warn: noop, error: noop, debug: noop },
    requireCapability: () => anything,
    provideCapability: noop,
  })
  const { activate } = await import(url.pathToFileURL(path.join(workspace, client, 'src/index.js')).href)
  await activate(ctx)
  return skills
}

/** @param {string} client */
function manifestSkills(client) {
  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, client, 'hypaware.plugin.json'), 'utf8'))
  return manifest.contributes.skills.map((/** @type {any} */ s) => s.name)
}

/** @param {string} client */
function onDiskSkills(client) {
  const dir = path.join(workspace, client, 'skills')
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
}

for (const client of CLIENTS) {
  test(`${client}: the manifest and the registration code name the same skills`, async () => {
    const registered = (await registeredSkills(client)).map((s) => s.name)
    assert.deepEqual(
      registered.sort(),
      manifestSkills(client).sort(),
      `contributes.skills in ${client}/hypaware.plugin.json disagrees with what activate() registers. ` +
        'A skill in one but not the other is either advertised and never installed, or installed and undeclared.',
    )
  })

  test(`${client}: every registered skill exists on disk`, async () => {
    const onDisk = new Set(onDiskSkills(client))
    for (const skill of await registeredSkills(client)) {
      assert.ok(
        onDisk.has(skill.name),
        `${client} registers "${skill.name}" but ${client}/skills/${skill.name}/SKILL.md does not exist. ` +
          'Attach would try to install a skill that was renamed or removed.',
      )
      assert.ok(
        fs.existsSync(path.join(skill.sourceDir, 'SKILL.md')),
        `${client} registers "${skill.name}" with sourceDir ${skill.sourceDir}, which has no SKILL.md`,
      )
    }
  })

  test(`${client}: every skill on disk is registered`, async () => {
    const registered = new Set((await registeredSkills(client)).map((s) => s.name))
    for (const name of onDiskSkills(client)) {
      assert.ok(
        registered.has(name),
        `${client}/skills/${name}/ ships but nothing registers it, so it is dead weight in the package. ` +
          'Register it, or delete it.',
      )
    }
  })

  test(`${client}: the manifest description does not name a skill it no longer ships`, () => {
    // The description is the human-facing account of what the plugin contributes, and it
    // named skills by hand. Stale names there mislead without failing anything else.
    const manifest = JSON.parse(fs.readFileSync(path.join(workspace, client, 'hypaware.plugin.json'), 'utf8'))
    const shipped = new Set(manifestSkills(client))
    for (const named of manifest.description.match(/hypaware-[a-z-]+/g) ?? []) {
      assert.ok(
        shipped.has(named),
        `${client}/hypaware.plugin.json description names "${named}", which this plugin no longer ships`,
      )
    }
  })
}
