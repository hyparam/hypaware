// @ts-check

/**
 * Constraint-survival guard for the skill corpus.
 *
 * @ref LLP 0194#t12-constraint-inventory [tests]: the merge is where load-bearing
 * constraints get silently dropped, and the ones most easily lost read like trivia
 *
 * LLP 0194 T12 merges ten skills into six. The risk there is not that the merge fails
 * loudly; it is that a constraint like "COALESCE every token sum" gets dropped as
 * incidental detail during a rewrite, and nothing notices until a report is confidently
 * wrong or a query takes the production server down.
 *
 * So this test matches each constraint against the CONCATENATED corpus of a host rather
 * than against a named file. Skills may be merged, split, or renamed freely; what may
 * not happen is a constraint disappearing. The patterns key on distinctive terms rather
 * than whole sentences, so honest rewording during a merge survives and deletion does
 * not.
 *
 * If a constraint here genuinely stops applying, delete it from the fixture in the same
 * commit that removes it from the skills, and say why in the commit message. Do not
 * loosen a pattern until it passes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')

const HOSTS = {
  claude: 'hypaware-core/plugins-workspace/claude/skills',
  codex: 'hypaware-core/plugins-workspace/codex/skills',
}

/** @type {{ constraints: { id: string, pattern: string, harm: string }[] }} */
const { constraints } = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'test/fixtures/skill-constraints.json'), 'utf8'),
)

/**
 * Every SKILL.md a host ships, concatenated, with whitespace runs collapsed.
 *
 * Deliberately file-agnostic, and deliberately newline-agnostic: skill prose is
 * hard-wrapped at ~90 columns, so a constraint sentence routinely straddles a line
 * break with leading indentation on the continuation. Matching raw text would make
 * every multi-word pattern hostage to where the wrap happens to fall, and a reflow
 * during the merge would look identical to a deletion.
 *
 * @param {string} skillsDir
 */
function hostCorpus(skillsDir) {
  const dir = path.join(repoRoot, skillsDir)
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, 'SKILL.md'))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n\n')
    .replace(/\s+/g, ' ')
}

const corpora = Object.fromEntries(
  Object.entries(HOSTS).map(([host, dir]) => [host, hostCorpus(dir)]),
)

test('the constraint inventory is non-empty and has no duplicate ids', () => {
  assert.ok(constraints.length > 0)
  const ids = constraints.map((c) => c.id)
  assert.deepEqual([...new Set(ids)].sort(), [...ids].sort(), 'duplicate constraint id')
})

test('every constraint states the harm of dropping it', () => {
  // A constraint with no nameable harm is guidance, and guidance does not belong in a
  // survival test: it makes the test noisy and trains people to loosen patterns.
  for (const { id, harm } of constraints) {
    assert.ok(harm && harm.length > 40, `${id}: needs a concrete harm statement, got ${harm}`)
  }
})

for (const [host, corpus] of Object.entries(corpora)) {
  for (const { id, pattern, harm } of constraints) {
    test(`${host}: constraint "${id}" survives somewhere in the skill corpus`, () => {
      assert.match(
        corpus,
        new RegExp(pattern, 'i'),
        `Constraint "${id}" is no longer stated anywhere in the ${host} skills.\n` +
          `  Why it matters: ${harm}\n` +
          '  If a merge moved or reworded it, update the pattern in ' +
          'test/fixtures/skill-constraints.json.\n' +
          '  If it was dropped, put it back. Do not loosen the pattern to make this pass.',
      )
    })
  }
}
