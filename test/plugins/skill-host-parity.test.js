// @ts-check

/**
 * Parity guard for the skills that ship to Claude Code, Codex, and (from the
 * host-neutral tree) every other client.
 *
 * @ref LLP 0197#t2-premise-corrected [tests]: new divergence between the two skill
 * trees has to be recorded deliberately, because accidental drift looks identical to
 * intentional host-specific content until someone reads both files
 *
 * The two trees diverged silently before this existed: on 2026-08-06 six of the eight
 * shared skills differed, and telling the legitimate differences (no
 * `disable-model-invocation` on Codex, a different session-id mechanism, different
 * client verbs) from an edit someone forgot to mirror required reading every diff by
 * hand.
 *
 * This does not require the trees to match. It requires the *amount and content* of
 * host-specific text to be what the fixture says, so adding some is a reviewable act
 * rather than an invisible one.
 *
 * @ref LLP 0494#skills [tests]: the neutral tree is recorded against both host trees,
 * so a host edit not mirrored in it (or the reverse) is reviewable too
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import {
  FIXTURE_PATH,
  TREE_PAIRS,
  divergenceReport,
  pairKey,
  sharedSkills,
  skillLineSets,
} from '../helpers/skill_host_divergence.js'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')

const RERECORD = 'node scripts/record-skill-host-divergence.js'

/** @type {Record<string, Record<string, Record<string, number | string>>>} */
const expected = JSON.parse(fs.readFileSync(path.join(repoRoot, FIXTURE_PATH), 'utf8'))

const actual = divergenceReport(repoRoot)

test('every skill shipped to more than one tree is covered by the divergence record', () => {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `the tree pairs changed. Re-record with: ${RERECORD}`)
  for (const key of Object.keys(actual)) {
    assert.deepEqual(
      Object.keys(actual[key]).sort(),
      Object.keys(expected[key] ?? {}).sort(),
      `${key}: a skill was added to or removed from one tree. Re-record with: ${RERECORD}`,
    )
  }
})

for (const pair of TREE_PAIRS) {
  const [left, right] = pair
  const key = pairKey(pair)
  for (const skill of sharedSkills(repoRoot, pair)) {
    test(`${key} ${skill}: tree-specific content matches the recorded surface`, () => {
      const want = expected[key]?.[skill]
      assert.ok(want, `${key} ${skill} is not in ${FIXTURE_PATH}. Re-record with: ${RERECORD}`)

      const got = actual[key][skill]
      if (got.hash === want.hash) return

      // Only build the (potentially large) explanation on failure.
      const { leftLines, rightLines } = skillLineSets(repoRoot, skill, pair)
      const sample = [...leftLines.map((l) => `  ${left}-only: ${l}`), ...rightLines.map((l) => `  ${right}-only: ${l}`)]
        .slice(0, 12)
        .join('\n')

      assert.fail(
        `${key} ${skill}: tree-specific content changed.\n` +
          `  recorded: ${left}-only ${want[`${left}Only`]}, ${right}-only ${want[`${right}Only`]}\n` +
          `  actual:   ${left}-only ${got[`${left}Only`]}, ${right}-only ${got[`${right}Only`]}\n` +
          'If this is an edit you forgot to mirror to the other tree, fix the skill.\n' +
          `If it is deliberate tree-specific content, re-record with: ${RERECORD}\n` +
          `First differing lines:\n${sample}`,
      )
    })
  }
}

test('skills recorded as fully shared stay identical across hosts', () => {
  // A skill at 0/0 carries nothing host-specific, so it is a candidate for a future
  // "one source, two outputs" step (LLP 0197 T2 part 2). Derived from the fixture
  // rather than listed here, so the set grows on its own as skills converge: removing
  // disable-model-invocation (LLP 0196 #gate-moves-to-the-command) took it from two to
  // four by making the frontmatter identical.
  const hosts = expected[pairKey(TREE_PAIRS[0])]
  const fullyShared = Object.keys(hosts).filter(
    (skill) => Number(hosts[skill].claudeOnly) + Number(hosts[skill].codexOnly) === 0,
  )
  // May legitimately be empty. The T12 merge folded the four byte-identical report
  // skills into hypaware-report, which also absorbed applying.md's host-specific
  // AskUserQuestion line, so the merged skill diverges by 3/2 and nothing is 0/0 today.

  for (const skill of fullyShared) {
    const record = actual[pairKey(TREE_PAIRS[0])][skill]
    assert.equal(
      Number(record.claudeOnly) + Number(record.codexOnly),
      0,
      `${skill} was fully shared and gained host-specific content, so it is no longer a ` +
        `candidate for deduplication. If that is intended, re-record with: ${RERECORD}`,
    )
  }
})
