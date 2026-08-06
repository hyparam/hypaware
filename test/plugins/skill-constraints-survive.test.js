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
 * Every Markdown file a host's skills ship, concatenated, whitespace collapsed.
 *
 * **Not just `SKILL.md`.** A skill is its entry file plus the reference files it loads
 * on demand, and the T12 merge moved most of the report constraints out of four
 * `SKILL.md`s into `reviewing.md` / `rendering.md` / `publishing.md` / `applying.md`
 * under one skill. Reading only entry files reported eight constraints as dropped when
 * every one of them had simply moved, which is a false alarm of the worst kind: it
 * trains people to loosen patterns during exactly the refactor the guard exists for.
 * What must hold is that a constraint is still stated somewhere a reader reaches.
 *
 * Deliberately newline-agnostic too: skill prose is hard-wrapped at ~90 columns, so a
 * constraint routinely straddles a line break, and matching raw text would make every
 * multi-word pattern hostage to where the wrap falls.
 *
 * @param {string} skillsDir
 */
function hostCorpus(skillsDir) {
  const dir = path.join(repoRoot, skillsDir)
  /** @type {string[]} */
  const texts = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of fs.readdirSync(path.join(dir, entry.name))) {
      if (file.endsWith('.md')) texts.push(fs.readFileSync(path.join(dir, entry.name, file), 'utf8'))
    }
  }
  return texts.join('\n\n').replace(/\s+/g, ' ')
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
