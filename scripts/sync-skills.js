#!/usr/bin/env node
// Copy the shipped skills from a pinned hypaware release into skills/ and
// write the pin into every version field. Run by hand when bumping the pin:
//
//   node scripts/sync-skills.js <version>
//
// The skills are a byte-identical copy of hypaware-core/skills/<name>/ from
// that release's npm tarball. Never edit a file under skills/ by hand; change
// the skill in hypaware, release it, and bump the pin here.
// Uses Node's standard library, npm and tar only.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The skills the plugin ships; hypaware-report and hypaware-privacy drive local `hyp` and stay out. */
export const SKILLS = ['hypaware-query', 'hypaware-reference']

/** Every field that carries the pin, as [file, key path]. */
export const VERSION_FIELDS = /** @type {[string, (string | number)[]][]} */ ([
  ['.claude-plugin/plugin.json', ['version']],
  ['.cursor-plugin/plugin.json', ['version']],
  ['registry/server.json', ['version']],
  ['registry/server.json', ['packages', 0, 'version']],
])

/**
 * Pack hypaware@<version> into a temp directory and extract the shipped skills.
 * The caller removes `tmp` when done.
 *
 * @param {string} version an exact release version, such as 1.43.0
 * @returns {{ tmp: string, skillsDir: string }}
 */
export function unpackSkills(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not an exact version: ${JSON.stringify(version)}`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-skills-'))
  const out = execFileSync('npm', ['pack', `hypaware@${version}`, '--pack-destination', tmp, '--silent'], { encoding: 'utf8' })
  const tarball = path.join(tmp, out.trim().split('\n').pop() ?? '')
  const members = SKILLS.map(name => `package/hypaware-core/skills/${name}`)
  execFileSync('tar', ['-xzf', tarball, '-C', tmp, ...members])
  return { tmp, skillsDir: path.join(tmp, 'package/hypaware-core/skills') }
}

/**
 * @param {string} file repo-relative
 * @returns {any}
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
}

/**
 * @param {any} obj
 * @param {(string | number)[]} keys
 * @returns {unknown}
 */
function getPath(obj, keys) {
  return keys.reduce((o, k) => o?.[k], obj)
}

/** @returns {{ field: string, value: unknown }[]} every version field and its current value */
export function readVersionFields() {
  return VERSION_FIELDS.map(([file, keys]) => ({ field: `${file} ${keys.join('.')}`, value: getPath(readJson(file), keys) }))
}

/** @param {string} version */
function writeVersionFields(version) {
  /** @type {Map<string, any>} */
  const docs = new Map()
  for (const [file, keys] of VERSION_FIELDS) {
    const doc = docs.get(file) ?? readJson(file)
    docs.set(file, doc)
    const parent = /** @type {any} */ (getPath(doc, keys.slice(0, -1)))
    if (parent === null || typeof parent !== 'object') throw new Error(`${file}: no ${keys.join('.')}`)
    parent[keys[keys.length - 1]] = version
  }
  for (const [file, doc] of docs) fs.writeFileSync(path.join(ROOT, file), JSON.stringify(doc, null, 2) + '\n')
}

/** @param {string} version */
function sync(version) {
  const { tmp, skillsDir } = unpackSkills(version)
  try {
    for (const name of SKILLS) {
      const src = path.join(skillsDir, name)
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`hypaware@${version} ships no hypaware-core/skills/${name}/SKILL.md`)
      const dest = path.join(ROOT, 'skills', name)
      fs.rmSync(dest, { recursive: true, force: true })
      fs.cpSync(src, dest, { recursive: true })
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  writeVersionFields(version)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2]
  if (!version) {
    process.stderr.write('usage: node scripts/sync-skills.js <version>\n')
    process.exit(2)
  }
  try {
    sync(version)
    process.stdout.write(`skills/ synced from hypaware@${version}; ${VERSION_FIELDS.length} version fields set\n`)
  } catch (err) {
    process.stderr.write(`sync-skills: ${/** @type {Error} */ (err).message}\n`)
    process.exit(1)
  }
}
