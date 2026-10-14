// @ts-check

/**
 * Hermes skills install under the narrow LLP 0118 carve-out: HypAware creates
 * and removes only its own `~/.hermes/skills/hypaware-*` directories, touches
 * nothing else under `~/.hermes/`, and removes them on detach.
 *
 * Hermes writes its own files beside ours (`.usage.json` and `.archive/` under
 * `~/.hermes/skills`, `state.db` and `config.yaml` under `~/.hermes`), and a
 * user may keep a skill of their own there, so every one of those is planted
 * first and must come through attach and detach byte-identical.
 *
 * @ref LLP 0494#skills [tests]: Hermes attach writes only the four marker-owned
 *   skill directories and detach removes only those
 * @ref LLP 0118#requirements [tests]: nothing else under `~/.hermes/` is touched
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'
import { NEUTRAL_SKILLS_DIR, NEUTRAL_SKILL_NAMES } from '../../hypaware-core/skills/index.js'

/** @import { TestContext } from 'node:test' */

/** Files Hermes or the user own, relative to `~/.hermes`. */
const FOREIGN = {
  'state.db': 'SQLite format 3\u0000 hermes state, never ours',
  'config.yaml': 'model: hermes-default\nskills:\n  external_dirs: []\n',
  'skills/.usage.json': '{"my-own-skill":{"created_by":"agent","uses":3}}\n',
  'skills/.archive/old-skill/SKILL.md': '---\nname: old-skill\ndescription: archived by the curator\n---\n',
  'skills/my-own-skill/SKILL.md': '---\nname: my-own-skill\ndescription: written by the user\n---\nBody.\n',
}

function makeBuf() {
  let value = ''
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * Every file and directory under `dir`, relative to it, with a digest per
 * file: the byte-identical check for everything that is not ours.
 *
 * @param {string} dir
 * @returns {Promise<Map<string, string>>}
 */
async function snapshot(dir) {
  /** @type {Map<string, string>} */
  const out = new Map()
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const abs = path.join(entry.parentPath, entry.name)
    const rel = path.relative(dir, abs)
    if (entry.isDirectory()) out.set(rel, 'dir')
    else out.set(rel, createHash('sha256').update(await fs.readFile(abs)).digest('hex'))
  }
  return out
}

/**
 * @param {Map<string, string>} snap
 * @returns {Map<string, string>}
 */
function withoutOurs(snap) {
  return new Map([...snap].filter(([rel]) => !NEUTRAL_SKILL_NAMES.some((name) => rel === `skills/${name}` || rel.startsWith(`skills/${name}${path.sep}`))))
}

/** @param {TestContext} t */
async function hermesHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hermes-skills-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const hermesDir = path.join(home, '.hermes')
  for (const [rel, body] of Object.entries(FOREIGN)) {
    await fs.mkdir(path.dirname(path.join(hermesDir, rel)), { recursive: true })
    await fs.writeFile(path.join(hermesDir, rel), body)
  }
  const configPath = path.join(home, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    auto_update: false,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/hermes' }],
  }))
  const env = { ...isolatedClientEnv(process.env, home), HYP_CONFIG: configPath }
  /** @param {string[]} argv */
  const run = async (argv) => {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(argv, { stdout, stderr, env })
    return { code, stdout: stdout.text(), stderr: stderr.text() }
  }
  return { hermesDir, skillsDir: path.join(hermesDir, 'skills'), run }
}

/** @param {string} skillsDir */
async function ourDirs(skillsDir) {
  return (await fs.readdir(skillsDir)).filter((name) => name.startsWith('hypaware-')).sort()
}

test('hermes attach writes only the four hypaware-* skill directories and detach removes only them', async (t) => {
  const { hermesDir, skillsDir, run } = await hermesHome(t)
  const before = await snapshot(hermesDir)

  const attached = await run(['client', 'attach', 'hermes'])
  assert.equal(attached.code, 0, attached.stderr)
  assert.deepEqual(await ourDirs(skillsDir), [...NEUTRAL_SKILL_NAMES].sort())
  for (const name of NEUTRAL_SKILL_NAMES) {
    assert.deepEqual(
      await snapshot(path.join(skillsDir, name)),
      await snapshot(path.join(NEUTRAL_SKILLS_DIR, name)),
      `${name} is the neutral tree, byte for byte`
    )
  }
  const afterAttach = await snapshot(hermesDir)
  assert.deepEqual(withoutOurs(afterAttach), before, 'nothing but hypaware-* changed under ~/.hermes on attach')

  const detached = await run(['client', 'detach', 'hermes'])
  assert.equal(detached.code, 0, detached.stderr)
  assert.deepEqual(await ourDirs(skillsDir), [])
  assert.deepEqual(await snapshot(hermesDir), before, '~/.hermes is byte-identical to before attach')
})

test('hermes detach leaves an edited hypaware-* copy in place and says so', async (t) => {
  const { hermesDir, skillsDir, run } = await hermesHome(t)
  const before = await snapshot(hermesDir)

  assert.equal((await run(['client', 'attach', 'hermes'])).code, 0)
  const edited = path.join(skillsDir, 'hypaware-report', 'SKILL.md')
  await fs.appendFile(edited, '\nMy own note.\n')
  const editedBytes = await fs.readFile(edited)

  const detached = await run(['client', 'detach', 'hermes'])
  assert.equal(detached.code, 0, detached.stderr)
  assert.deepEqual(await ourDirs(skillsDir), ['hypaware-report'])
  assert.deepEqual(await fs.readFile(edited), editedBytes)
  assert.match(detached.stderr, /hypaware-report.*changed since HypAware installed it; left in place/)
  assert.deepEqual(withoutOurs(await snapshot(hermesDir)), before)
})

test('a hypaware-* directory HypAware never wrote survives hermes detach', async (t) => {
  const { hermesDir, skillsDir, run } = await hermesHome(t)
  // The user's own directory under one of our names, with no install record.
  const theirs = path.join(skillsDir, 'hypaware-query', 'SKILL.md')
  await fs.mkdir(path.dirname(theirs), { recursive: true })
  await fs.writeFile(theirs, '---\nname: hypaware-query\ndescription: the user wrote this\n---\n')
  const before = await snapshot(hermesDir)

  const detached = await run(['client', 'detach', 'hermes'])
  assert.equal(detached.code, 0, detached.stderr)
  assert.deepEqual(await snapshot(hermesDir), before)
})

test('client skills install --client hermes is removed by detach the same way', async (t) => {
  const { hermesDir, skillsDir, run } = await hermesHome(t)
  const before = await snapshot(hermesDir)

  const installed = await run(['client', 'skills', 'install', '--client', 'hermes'])
  assert.equal(installed.code, 0, installed.stderr)
  assert.deepEqual(await ourDirs(skillsDir), [...NEUTRAL_SKILL_NAMES].sort())
  assert.deepEqual(withoutOurs(await snapshot(hermesDir)), before)

  const detached = await run(['client', 'detach', 'hermes'])
  assert.equal(detached.code, 0, detached.stderr)
  assert.deepEqual(await snapshot(hermesDir), before)
})
