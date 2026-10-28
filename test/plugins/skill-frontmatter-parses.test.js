// @ts-check

/**
 * Every shipped SKILL.md frontmatter parses as YAML.
 *
 * Hosts read that block with a real YAML parser, and Pi drops a skill whose
 * frontmatter does not parse. An unquoted `description:` containing `': '` passes
 * every byte-comparison install test and is still unloadable, which is how the
 * hypaware-query and hypaware-privacy descriptions shipped. The strict reader holds
 * each file to the YAML rules for the flat scalars the skills use, since the repo
 * has no YAML dependency to parse with.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSkillFrontmatter, readSkillFrontmatter } from '../helpers/skill_frontmatter.js'
import { trackedFiles } from '../helpers/tracked_files.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const SHIPPED = trackedFiles(REPO_ROOT, new Set(['.md'])).filter(
  (f) => f.startsWith('hypaware-core/') && path.basename(f) === 'SKILL.md',
)

test('every shipped SKILL.md frontmatter parses, with a name and a description', () => {
  // The four shared skills plus gascity: guard against the
  // discovery quietly finding nothing.
  assert.ok(SHIPPED.length >= 5, `expected the shipped skill files, found ${SHIPPED.length}`)
  for (const file of SHIPPED) {
    const fm = readSkillFrontmatter(path.join(REPO_ROOT, file))
    assert.equal(fm.name, path.basename(path.dirname(file)), `${file}: name does not match its directory`)
    assert.ok(fm.description, `${file}: no description`)
  }
})

test('strict reader rejects the plain scalars a YAML parser rejects', () => {
  const fm = (/** @type {string} */ line) => `---\nname: x\n${line}\n---\nbody\n`
  /** @type {[string, RegExp][]} */
  const cases = [
    ['description: act on it: survey', /": "/],
    ['description: ends with a colon:', /": "/],
    ['description: keep # this', /comment/],
    ['description: [a, b]', /may not start/],
    ['description: "unterminated', /unterminated/],
    ["description: 'one' two'", /after the closing/],
    ['description: "bad \\q escape"', /unsupported escape/],
    ['  description: indented', /flat/],
    ['description: >-', /may not start/],
    ['name: twice', /duplicate/],
  ]
  for (const [line, why] of cases) assert.throws(() => parseSkillFrontmatter(fm(line)), why, line)
  assert.throws(() => parseSkillFrontmatter('name: x\n'), /line 1/)
  assert.throws(() => parseSkillFrontmatter('---\nname: x\n'), /unterminated frontmatter/)
})

test('strict reader decodes quoted scalars and keeps plain ones', () => {
  const fm = (/** @type {string} */ line) => parseSkillFrontmatter(`---\n${line}\n---\n`)
  assert.deepEqual(fm(`description: 'act on it: survey; don''t "record"'`), { description: `act on it: survey; don't "record"` })
  assert.deepEqual(fm('description: "act on it: \\"quoted\\" \\\\ ok"'), { description: 'act on it: "quoted" \\ ok' })
  assert.deepEqual(fm('user-invocable: false'), { 'user-invocable': 'false' })
  assert.deepEqual(fm('description: a/b; c-d (e) $20 x#y'), { description: 'a/b; c-d (e) $20 x#y' })
})
