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
import { runPickerFinale } from '../../src/core/cli/walkthrough.js'
import { createAttachHandler } from '../../src/core/config/action_attach.js'
import { createActionReconciler } from '../../src/core/config/action_reconciler.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { bootKernel } from '../../src/core/runtime/boot.js'
import { clientAssetStateRoot, digestClientAsset } from '../../src/core/runtime/client_asset_ledger.js'
import { materializeClientAssets, removeClientAssets } from '../../src/core/runtime/client_assets.js'

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
 * `client` is the `--client` filter the command runs under, defaulting to the
 * command's own default of `all`. A test that needs the scoped shape every
 * attach path actually uses (`clients: [name]`) names one client.
 *
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   client?: string,
 *   skills?: { name: string, sourceDir: string, clients?: string[] }[],
 *   agents?: { name: string, sourceFile: string, clients?: string[] }[],
 * }} args
 */
async function installWith({ env, client, skills = [], agents = [] }) {
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
  const argv = client ? ['skills', 'install', '--client', client] : ['skills', 'install']
  const code = await dispatch(argv, { stdout, stderr, env, registry, kernel })
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

/*
 * @ref LLP 0226#unreadable-is-not-absent [tests]:
 */
test('a retired asset that cannot be read is named and kept on the books', async (t) => {
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
  const retired = path.join(skillsDir, 'hypaware-ignore')
  const ledgerPath = path.join(home, '.hyp', 'hypaware', 'client-assets.json')
  /** @param {string} p @returns {Promise<any>} */
  const recordFor = async (p) =>
    JSON.parse(await fs.readFile(ledgerPath, 'utf8')).assets.find(
      (/** @type {any} */ r) => r.dest === p
    )
  const installedRecord = await recordFor(retired)
  assert.ok(installedRecord?.digest, 'the install must have recorded a digest to carry forward')

  // The copy is plainly still there - the top-level stat succeeds - but the
  // digest walk cannot finish, because one directory inside it is unlistable.
  // This is the case that must not read as "already gone".
  const locked = path.join(retired, 'reference')
  await fs.mkdir(locked, { recursive: true })
  await fs.writeFile(path.join(locked, 'notes.md'), 'notes\n', 'utf8')
  await fs.chmod(locked, 0o000)
  // Registered the moment the mode drops, not after the assertions below: a
  // failed assertion here must not leave a mode-000 directory that `rm -rf`
  // cannot remove. Registered before the `home` cleanup below so it always
  // runs first: `t.after` hooks run in registration order, and restoring the
  // mode is what makes the recursive `home` removal possible at all.
  t.after(() => fs.chmod(locked, 0o755).catch(() => {}))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const stillReadable = await fs.readdir(locked).then(() => true, () => false)
  if (stillReadable) {
    // Root reads through any mode, so the fixture cannot be built here at all.
    await fs.chmod(locked, 0o755)
    t.skip('needs an unreadable directory, which a root-owned run cannot produce')
    return
  }

  const second = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.equal(second.code, 0)
  assert.ok(await exists(retired), 'nothing was removed, which is right but not the point')
  assert.match(second.stderr, /hypaware-ignore/)
  assert.match(
    second.stderr,
    /could not be read/,
    'a copy we cannot account for must be reported, not silently forgotten'
  )
  const carried = await recordFor(retired)
  assert.equal(
    carried?.digest,
    installedRecord.digest,
    'the record must survive verbatim: dropping it makes the copy unprunable and unreportable forever'
  )

  // And the record still means what it meant. With the tree readable again and
  // the bytes untouched, the ordinary prune finishes the job a later run was
  // always supposed to be able to do.
  await fs.chmod(locked, 0o755)
  await fs.rm(locked, { recursive: true, force: true })
  const third = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.equal(third.code, 0)
  assert.equal(
    await exists(retired),
    false,
    'the carried record is what lets the next complete pass remove the retired copy'
  )
  assert.match(third.stdout, /removed retired skill 'hypaware-ignore'/)
})

/*
 * The split try/catch in `inspectClientAsset` only changes behaviour for an
 * `ENOENT` raised *below* `dest`, after the top-level `fs.stat(dest)` already
 * succeeded. A dangling symlink placed at `dest` itself does not reach that
 * code at all: `fs.stat` follows the symlink and throws `ENOENT` at the
 * top-level probe, which both the old and the new code read as "missing" -
 * so it cannot discriminate this fix (verified empirically: `fs.stat` on a
 * dangling symlink throws before either version of the function branches on
 * shape). A file `readdir` lists that a concurrent actor removes before the
 * following `readFile` reaches it is the actual case the split guards, and a
 * real race is not reproducible on demand, so this mocks `fs.readFile` to
 * throw `ENOENT` for one specific path the walk is mid-way through - the same
 * error a vanish-between-list-and-read race would produce, without depending
 * on winning one.
 * @ref LLP 0226#unreadable-is-not-absent [tests]:
 */
test('an ENOENT raised reading inside a retired asset, not at dest itself, is reported as unreadable', async (t) => {
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
  const retired = path.join(skillsDir, 'hypaware-ignore')
  const ledgerPath = path.join(home, '.hyp', 'hypaware', 'client-assets.json')
  /** @param {string} p @returns {Promise<any>} */
  const recordFor = async (p) =>
    JSON.parse(await fs.readFile(ledgerPath, 'utf8')).assets.find(
      (/** @type {any} */ r) => r.dest === p
    )
  const installedRecord = await recordFor(retired)
  assert.ok(installedRecord?.digest, 'the install must have recorded a digest to carry forward')

  // The top-level stat of `retired` itself must succeed - this is not the
  // "dest is gone" case - so the digest walk gets far enough to reach the
  // file the mock below intercepts.
  const nested = path.join(retired, 'reference', 'notes.md')
  await fs.mkdir(path.dirname(nested), { recursive: true })
  await fs.writeFile(nested, 'notes\n', 'utf8')

  const original = fs.readFile
  let intercepted = false
  t.mock.method(fs, 'readFile', async (/** @type {any[]} */ ...args) => {
    if (args[0] === nested) {
      intercepted = true
      const err = /** @type {NodeJS.ErrnoException} */ (new Error('simulated: vanished between readdir and readFile'))
      err.code = 'ENOENT'
      throw err
    }
    return original.apply(fs, args)
  })

  const second = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.ok(intercepted, 'sanity: the mocked path must actually have been reached by the digest walk')
  assert.equal(second.code, 0)
  assert.ok(await exists(retired), 'the top-level stat succeeded; this is not "already gone"')
  assert.match(second.stderr, /hypaware-ignore/)
  assert.match(
    second.stderr,
    /could not be read/,
    'an ENOENT below dest must not be read as dest itself being gone'
  )
  const carried = await recordFor(retired)
  assert.equal(
    carried?.digest,
    installedRecord.digest,
    'the record must survive verbatim, the same as any other unreadable-below-dest failure'
  )
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

/*
 * @ref LLP 0219#prune-on-materialize [tests]: the plan the keep-set is asked of
 * is every client's contributions, not the ones this scoped run installs for.
 */
test('a client-scoped run never prunes a destination another client still contributes', async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')
  const sharedSource = await writeSkillSource(home, 'hypaware-privacy', 'privacy body\n')

  // `claude` and `claude-desktop` both declare `.claude/skills`, so the privacy
  // skill has one physical destination recorded under both clients.
  await installWith({
    env,
    skills: [
      { name: 'hypaware-query', sourceDir: keptSource, clients: ['claude'] },
      { name: 'hypaware-privacy', sourceDir: sharedSource, clients: ['claude', 'claude-desktop'] },
    ],
  })

  const shared = path.join(home, '.claude', 'skills', 'hypaware-privacy')
  assert.ok(await exists(path.join(shared, 'SKILL.md')))

  // The upgrade narrows the privacy skill to `claude-desktop`, and the next
  // attach is scoped to `claude` - which is the shape every attach path uses.
  // The dest is still contributed, just by a client outside this run's filter,
  // so nothing about it is retired.
  const second = await installWith({
    env,
    client: 'claude',
    skills: [
      { name: 'hypaware-query', sourceDir: keptSource, clients: ['claude'] },
      { name: 'hypaware-privacy', sourceDir: sharedSource, clients: ['claude-desktop'] },
    ],
  })

  assert.equal(second.code, 0)
  assert.doesNotMatch(
    second.stdout,
    /removed retired skill 'hypaware-privacy'/,
    'a scoped run must not read another client\'s live contribution as retired'
  )
  assert.equal(
    await fs.readFile(path.join(shared, 'SKILL.md'), 'utf8'),
    'privacy body\n',
    'the shared skill claude-desktop still contributes must survive a claude-scoped run'
  )
})

test('a client-scoped run still prunes a destination no client contributes any more', async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')
  const retiredSource = await writeSkillSource(home, 'hypaware-ignore', 'retired body\n')

  await installWith({
    env,
    skills: [
      { name: 'hypaware-query', sourceDir: keptSource, clients: ['claude'] },
      { name: 'hypaware-ignore', sourceDir: retiredSource, clients: ['claude', 'claude-desktop'] },
    ],
  })

  const retired = path.join(home, '.claude', 'skills', 'hypaware-ignore')
  assert.ok(await exists(retired))

  // Widening the keep-set past this run's filter must not become "a scoped run
  // prunes nothing": a name no manifest declares any more is still retired.
  const second = await installWith({
    env,
    client: 'claude',
    skills: [{ name: 'hypaware-query', sourceDir: keptSource, clients: ['claude'] }],
  })

  assert.equal(second.code, 0)
  assert.match(second.stdout, /removed retired skill 'hypaware-ignore'/)
  assert.equal(await exists(retired), false)
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

/*
 * @ref LLP 0226#only-direct-children [tests]:
 */
test('a recorded destination deeper than a direct child is refused, digest or no digest', async () => {
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

  // A directory the user owns, with content of their own one level further in.
  // Nothing HypAware wrote is involved anywhere in this subtree.
  const skillsDir = path.join(home, '.claude', 'skills')
  const nested = path.join(skillsDir, 'my-own-skill', 'reference')
  await fs.mkdir(nested, { recursive: true })
  await fs.writeFile(path.join(nested, 'notes.md'), 'mine\n', 'utf8')

  // A corrupt record naming that subtree - and carrying a digest that really
  // does match it, so every other condition the prune checks is satisfied. What
  // must stop the delete is that no copy this module makes is ever deeper than
  // `<base>/<name>`, so a record this shape cannot be describing our own write.
  const ledgerPath = path.join(home, '.hyp', 'hypaware', 'client-assets.json')
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
  ledger.assets.push({
    kind: 'skill',
    name: 'reference',
    client: 'claude',
    dest: nested,
    digest: await digestClientAsset(nested),
  })
  await fs.writeFile(ledgerPath, JSON.stringify(ledger), 'utf8')

  const second = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.equal(second.code, 0)
  assert.equal(
    await fs.readFile(path.join(nested, 'notes.md'), 'utf8'),
    'mine\n',
    'a recursive delete must not reach a path deeper than the copy side ever writes'
  )
  assert.match(second.stderr, /deeper into them than HypAware writes/)
  // Not passing by inertia: the same run still prunes the direct child it did
  // write, so the refusal is about the depth and nothing else.
  assert.equal(await exists(path.join(skillsDir, 'hypaware-ignore')), false)
  assert.match(second.stdout, /removed retired skill 'hypaware-ignore'/)
})

/*
 * `path.dirname` alone reads a basename beginning with `..` as a direct
 * child, because `path.dirname('<base>/..stash')` is `<base>`. The old
 * containment (`isWithinDir`) refused it on a prefix test instead
 * (`path.relative(base, '<base>/..stash')` is the string `'..stash'`, which
 * starts with `'..'`), so `isRemovableAsset` must keep both conjuncts or it
 * widens for exactly this shape of name.
 * @ref LLP 0226#only-direct-children [tests]:
 */
test('a recorded destination whose basename begins with ".." is refused, not read as a direct child', async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')

  await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  // A directory the user owns. Nothing HypAware ever writes can produce this
  // name - `isSafeContributionName` forces a single safe segment - so a
  // record naming it can only be corrupt.
  const skillsDir = path.join(home, '.claude', 'skills')
  const stash = path.join(skillsDir, '..stash')
  await fs.mkdir(stash, { recursive: true })
  await fs.writeFile(path.join(stash, 'notes.md'), 'mine\n', 'utf8')

  // A corrupt record naming it, carrying a digest that really does match, so
  // every condition but the shape of the name is satisfied.
  const ledgerPath = path.join(home, '.hyp', 'hypaware', 'client-assets.json')
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
  ledger.assets.push({
    kind: 'skill',
    name: '..stash',
    client: 'claude',
    dest: stash,
    digest: await digestClientAsset(stash),
  })
  await fs.writeFile(ledgerPath, JSON.stringify(ledger), 'utf8')

  const second = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.equal(second.code, 0)
  assert.equal(
    await fs.readFile(path.join(stash, 'notes.md'), 'utf8'),
    'mine\n',
    'a basename beginning with ".." must not be read as a direct child of the base'
  )
  assert.match(second.stderr, /deeper into them than HypAware writes/)
})

/*
 * The same widening, reproduced through the lower-level entry point
 * directly: `hyp detach` calls `removeClientAssets` with no digest gate at
 * all, so containment is the only thing standing between a corrupt or
 * malicious marker and a user's files.
 * @ref LLP 0226#only-direct-children [tests]:
 */
test('removeClientAssets refuses a basename beginning with ".." on posix and win32 alike', async () => {
  const { home } = await makeHome()
  const skillsDir = path.join(home, '.claude', 'skills')
  const stash = path.join(skillsDir, '..stash')
  const notes = path.join(skillsDir, '...notes')
  await fs.mkdir(stash, { recursive: true })
  await fs.writeFile(path.join(stash, 'mine.md'), 'mine\n', 'utf8')
  await fs.mkdir(notes, { recursive: true })
  await fs.writeFile(path.join(notes, 'mine.md'), 'mine too\n', 'utf8')

  const { removed, failed } = await removeClientAssets([stash, notes], [skillsDir])

  assert.deepEqual(removed, [], 'a basename beginning with ".." must never be read as a direct child')
  assert.equal(failed.length, 2)
  assert.equal(await fs.readFile(path.join(stash, 'mine.md'), 'utf8'), 'mine\n')
  assert.equal(await fs.readFile(path.join(notes, 'mine.md'), 'utf8'), 'mine too\n')
  await fs.rm(home, { recursive: true, force: true })
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

/* ------------------------------------------------------------------------ *
 * A boot can come up short of its plugin set without any `activate()` ever
 * throwing, and the profile door is the one a shipped, bundled, opt-in plugin
 * walks through on an ordinary `hyp init`.
 * @ref LLP 0219#incomplete-activation-prunes-nothing [tests]:
 * ------------------------------------------------------------------------ */

/**
 * A synthetic bundled workspace: a client-owning plugin and an opt-in plugin,
 * each contributing one skill it registers from its own source tree. Real
 * bundled names, because the profiles bucket on fixed name sets.
 *
 * @param {string} root
 * @returns {Promise<string>} the workspace directory
 */
async function writeBundledWorkspace(root) {
  const workspaceDir = path.join(root, 'workspace')
  /**
   * @param {string} dir
   * @param {string} name
   * @param {string} skill
   * @param {Record<string, unknown>} [clientContribution]
   */
  const write = async (dir, name, skill, clientContribution) => {
    const pluginDir = path.join(workspaceDir, dir)
    await fs.mkdir(path.join(pluginDir, 'skills', skill), { recursive: true })
    await fs.writeFile(path.join(pluginDir, 'skills', skill, 'SKILL.md'), `${skill} body\n`, 'utf8')
    await fs.writeFile(
      path.join(pluginDir, 'hypaware.plugin.json'),
      JSON.stringify({
        schema_version: 1,
        name,
        version: '2.0.0',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
        contributes: {
          ...(clientContribution ? { client: clientContribution } : {}),
          skills: [{ name: skill, clients: ['claude'] }],
        },
      })
    )
    await fs.writeFile(
      path.join(pluginDir, 'index.js'),
      "import path from 'node:path'\n" +
        "import { fileURLToPath } from 'node:url'\n" +
        'export async function activate(ctx) {\n' +
        '  ctx.skills.register({\n' +
        `    name: ${JSON.stringify(skill)},\n` +
        `    plugin: ${JSON.stringify(name)},\n` +
        "    clients: ['claude'],\n" +
        `    sourceDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills', ${JSON.stringify(skill)}),\n` +
        '  })\n' +
        '}\n'
    )
  }
  await write('claude', '@hypaware/claude', 'hypaware-query', {
    name: 'claude',
    skill_dir: '.claude/skills',
    agent_dir: '.claude/agents',
  })
  await write('gascity', '@hypaware/gascity', 'hypaware-gascity')
  return workspaceDir
}

/**
 * What the wizard finale and the reconciler both do with a boot: materialize
 * the client assets that boot's registries hold, telling the materializer what
 * the boot did not get.
 *
 * @param {{ boot: any, home: string, env: NodeJS.ProcessEnv }} args
 * @returns {Promise<any>}
 */
function materializeFromBoot({ boot, home, env }) {
  return materializeClientAssets({
    clients: ['claude'],
    descriptors: boot.clientDescriptors,
    homeDir: home,
    stateRoot: clientAssetStateRoot(env, home),
    skills: boot.runtime.skills,
    ...(boot.unavailablePlugins?.length ? { failedPlugins: boot.unavailablePlugins } : {}),
    stderr: makeBuf(),
  })
}

test('a skill the boot profile withheld is never read as retired', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-prune-profile-'))
  const env = { ...process.env, HOME: home, HYP_HOME: path.join(home, '.hyp') }
  const workspaceDir = await writeBundledWorkspace(home)
  const configPath = path.join(home, '.hyp', 'hypaware-config.json')
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 2,
      plugins: [{ name: '@hypaware/claude', config: {} }, { name: '@hypaware/gascity', config: {} }],
    })
  )

  const bootArgs = /** @type {const} */ ({
    hypHome: path.join(home, '.hyp'),
    configPath,
    workspaceDir,
    mode: 'smoke',
    env,
  })

  // `hyp attach claude` / `hyp skills install`: the `config` profile honours the
  // opt-in, so gascity's skill lands and is ledgered with a matching digest.
  const first = await bootKernel({ ...bootArgs, runId: 'prune-profile-1' })
  await materializeFromBoot({ boot: first, home, env })
  const gascitySkill = path.join(home, '.claude', 'skills', 'hypaware-gascity')
  assert.ok(await exists(path.join(gascitySkill, 'SKILL.md')), 'the opt-in skill must land first')

  // The user re-runs `hyp init`, which boots `all-available`. That profile drops
  // the opt-in plugin even though the config enables it, so its skill is missing
  // from the plan for a reason that is not a retirement - while claude's own
  // skills still land, keeping the client in scope.
  const second = await bootKernel({ ...bootArgs, runId: 'prune-profile-2', bootProfile: 'all-available' })
  assert.deepEqual(
    second.activations.filter((/** @type {any} */ r) => r.ok === false),
    [],
    'nothing threw, so an activation-only stand-down sees no reason to stand down'
  )
  await materializeFromBoot({ boot: second, home, env })

  assert.ok(
    await exists(path.join(gascitySkill, 'SKILL.md')),
    'a skill this boot profile withheld must survive: the next attach would only put it back'
  )
  await fs.rm(home, { recursive: true, force: true })
})

/* ------------------------------------------------------------------------ *
 * The door next to those four, which deliberately does not stand the prune
 * down. Pinned so the reading cannot drift silently into either behaviour.
 * @ref LLP 0219#uninstalled-is-retired [tests]:
 * ------------------------------------------------------------------------ */

test('a config-enabled plugin that is no longer installed is retired, and its skill prunes', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-prune-uninstalled-'))
  const env = { ...process.env, HOME: home, HYP_HOME: path.join(home, '.hyp') }
  const workspaceDir = await writeBundledWorkspace(home)
  const configPath = path.join(home, '.hyp', 'hypaware-config.json')
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 2,
      plugins: [{ name: '@hypaware/claude', config: {} }, { name: '@hypaware/gascity', config: {} }],
    })
  )

  const bootArgs = /** @type {const} */ ({
    hypHome: path.join(home, '.hyp'),
    configPath,
    workspaceDir,
    mode: 'smoke',
    env,
  })

  const first = await bootKernel({ ...bootArgs, runId: 'prune-uninstalled-1' })
  await materializeFromBoot({ boot: first, home, env })
  const gascitySkill = path.join(home, '.claude', 'skills', 'hypaware-gascity')
  assert.ok(await exists(path.join(gascitySkill, 'SKILL.md')), 'the opt-in skill must land first')

  // The plugin is uninstalled: its whole directory is gone, so no manifest
  // fails to load and nothing is withheld by a profile. It is in no list boot
  // returns, and that is the intended reading - an uninstalled plugin is a
  // retired plugin, and what prunes is a byte-identical copy of what HypAware
  // wrote whose source no longer exists on this machine.
  await fs.rm(path.join(workspaceDir, 'gascity'), { recursive: true, force: true })

  const second = await bootKernel({ ...bootArgs, runId: 'prune-uninstalled-2' })
  assert.deepEqual(
    second.unavailablePlugins,
    [],
    'a wholly absent plugin directory walks through none of the four doors'
  )
  await materializeFromBoot({ boot: second, home, env })

  assert.equal(
    await exists(gascitySkill),
    false,
    'pinning the reading: change it in a new LLP, never by accident here'
  )
  await fs.rm(home, { recursive: true, force: true })
})

/* ------------------------------------------------------------------------ *
 * The digest is the only thing between the prune and a user's files, so the
 * shapes it hashes have to be distinguishable from each other.
 * @ref LLP 0219#edited-assets-are-not-ours [tests]:
 * ------------------------------------------------------------------------ */

test('a directory and a file never share a content digest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-digest-'))

  const emptyDir = path.join(root, 'empty-dir')
  await fs.mkdir(emptyDir, { recursive: true })
  const emptyFile = path.join(root, 'empty-file')
  await fs.writeFile(emptyFile, '', 'utf8')
  assert.notEqual(
    await digestClientAsset(emptyDir),
    await digestClientAsset(emptyFile),
    'an empty installed skill and an empty user file must not hash alike'
  )

  // The tree walk frames each entry's path but not its shape, so a one-file
  // skill and a file holding that skill's path followed by its bytes collide.
  const treeDir = path.join(root, 'tree')
  await fs.mkdir(treeDir, { recursive: true })
  await fs.writeFile(path.join(treeDir, 'SKILL.md'), 'body\n', 'utf8')
  const flatFile = path.join(root, 'flat')
  await fs.writeFile(flatFile, 'SKILL.md\nbody\n', 'utf8')
  assert.notEqual(
    await digestClientAsset(treeDir),
    await digestClientAsset(flatFile),
    'a skill tree and a file spelling out that tree must not hash alike'
  )

  await fs.rm(root, { recursive: true, force: true })
})

test("a user's file that collides with a retired skill's digest is left in place", async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')
  const retiredSource = await writeSkillSource(home, 'hypaware-ignore', 'body\n')

  await installWith({
    env,
    skills: [
      { name: 'hypaware-query', sourceDir: keptSource },
      { name: 'hypaware-ignore', sourceDir: retiredSource },
    ],
  })

  // The installed skill is a directory holding one `SKILL.md` of `body\n`. The
  // user takes the name over with a file of their own whose bytes happen to
  // spell the tree out: same hash under a shape-blind digest, and this one is
  // not empty, so the delete destroys real content.
  const skillsDir = path.join(home, '.claude', 'skills')
  const taken = path.join(skillsDir, 'hypaware-ignore')
  await fs.rm(taken, { recursive: true, force: true })
  await fs.writeFile(taken, 'SKILL.md\nbody\n', 'utf8')

  const second = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.equal(second.code, 0)
  assert.equal(
    await fs.readFile(taken, 'utf8'),
    'SKILL.md\nbody\n',
    'a file the user authored must not be deletable by colliding with a skill tree'
  )
  assert.match(second.stderr, /hypaware-ignore/)
})

test("a user's empty file at an empty retired skill's path is left in place", async () => {
  const { home, env } = await makeHome()
  const keptSource = await writeSkillSource(home, 'hypaware-query', 'query body\n')
  // A contributed skill whose source tree happens to be empty: the recorded
  // digest is the hash of nothing at all.
  const retiredSource = path.join(home, 'sources', 'hypaware-ignore')
  await fs.mkdir(retiredSource, { recursive: true })

  await installWith({
    env,
    skills: [
      { name: 'hypaware-query', sourceDir: keptSource },
      { name: 'hypaware-ignore', sourceDir: retiredSource },
    ],
  })

  const skillsDir = path.join(home, '.claude', 'skills')
  const taken = path.join(skillsDir, 'hypaware-ignore')
  await fs.rm(taken, { recursive: true, force: true })
  await fs.writeFile(taken, '', 'utf8')

  const second = await installWith({ env, skills: [{ name: 'hypaware-query', sourceDir: keptSource }] })

  assert.equal(second.code, 0)
  assert.ok(
    await exists(taken),
    'an empty user file must not inherit an empty installed directory digest'
  )
})

/* ------------------------------------------------------------------------ *
 * The finale is the one call site with a human at the terminal, and it is the
 * one that said nothing when it deleted.
 * @ref LLP 0219#automatic-not-gated [tests]:
 * ------------------------------------------------------------------------ */

test('the wizard finale says how many retired assets it removed', async () => {
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

  const stdout = makeBuf()
  await runPickerFinale(/** @type {any} */ ({
    finale: { skipDaemon: true, skipDaemonInstall: true },
    clientsPicked: ['claude'],
    capabilities: /** @type {any} */ ({ has: () => false }),
    skills: { list: () => [{ name: 'hypaware-query', clients: ['claude'], sourceDir: keptSource }] },
    config: { version: 2, plugins: [] },
    configPath: path.join(home, '.hyp', 'hypaware-config.json'),
    env,
    stdout,
    stderr: makeBuf(),
    retentionDays: 30,
    interactive: false,
  }))

  assert.equal(
    await exists(path.join(home, '.claude', 'skills', 'hypaware-ignore')),
    false,
    'the finale really does delete here; the question is whether it says so'
  )
  assert.match(
    stdout.text(),
    /removed 1 retired skill for claude/,
    'a wizard that deletes a skill under the user\'s nose must count it out loud'
  )
})

/* ------------------------------------------------------------------------ *
 * A dest that changes hands between clients must keep its record, or the copy
 * on disk becomes unprunable and unreportable forever - the leave-behind this
 * whole mechanism exists to end.
 * @ref LLP 0219#prune-on-materialize [tests]:
 * ------------------------------------------------------------------------ */

test('a record survives a dest moving to a client whose copy failed', async () => {
  const { home, env } = await makeHome()
  const keptSource = path.join(home, 'sources', 'analyst.md')
  const movedSource = path.join(home, 'sources', 'reporter.md')
  await fs.mkdir(path.dirname(keptSource), { recursive: true })
  await fs.writeFile(keptSource, 'analyst\n', 'utf8')
  await fs.writeFile(movedSource, 'reporter\n', 'utf8')

  // `claude` and `claude-desktop` both declare `.claude/agents`, so one physical
  // path can be recorded under one client and planned under the other.
  await installWith({
    env,
    agents: [
      { name: 'hypaware-analyst', sourceFile: keptSource, clients: ['claude'] },
      { name: 'hypaware-reporter', sourceFile: movedSource, clients: ['claude'] },
    ],
  })
  const agentsDir = path.join(home, '.claude', 'agents')
  const moved = path.join(agentsDir, 'hypaware-reporter.md')
  assert.equal(await fs.readFile(moved, 'utf8'), 'reporter\n')

  // The upgrade hands the reporter to `claude-desktop`, and that client's copy
  // fails (its source is gone). The dest is in this run's plan, so it is no
  // candidate; it is not in `claude`'s share of the plan, so the old carry loop
  // dropped its record on the floor and nothing named the file again.
  await fs.rm(movedSource, { force: true })
  const second = await installWith({
    env,
    agents: [
      { name: 'hypaware-analyst', sourceFile: keptSource, clients: ['claude'] },
      { name: 'hypaware-reporter', sourceFile: movedSource, clients: ['claude-desktop'] },
    ],
  })
  assert.equal(second.code, 0)
  assert.equal(await fs.readFile(moved, 'utf8'), 'reporter\n', 'the failed copy left the old bytes alone')

  // The next version retires the reporter outright. With its record intact this
  // is an ordinary prune; without it the file is ours no more and stays forever.
  const third = await installWith({
    env,
    agents: [{ name: 'hypaware-analyst', sourceFile: keptSource, clients: ['claude'] }],
  })

  assert.equal(third.code, 0)
  assert.equal(
    await exists(moved),
    false,
    'a dest that changed hands must stay accounted for, or it can never be removed'
  )
  assert.match(third.stdout, /removed retired agent 'hypaware-reporter'/)
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
