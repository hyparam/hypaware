// @ts-check

/**
 * Parity guard for the skills that ship to both Claude Code and Codex.
 *
 * @ref LLP 0194#t2-premise-corrected [tests]: new divergence between the two skill
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
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import {
  FIXTURE_PATH,
  divergenceReport,
  sharedSkills,
  skillLineSets,
} from '../helpers/skill_host_divergence.js'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')

const RERECORD = 'node scripts/record-skill-host-divergence.js'

/** @type {Record<string, { claudeOnly: number, codexOnly: number, hash: string }>} */
const expected = JSON.parse(fs.readFileSync(path.join(repoRoot, FIXTURE_PATH), 'utf8'))

const actual = divergenceReport(repoRoot)

test('every skill shipped to both hosts is covered by the divergence record', () => {
  assert.deepEqual(
    Object.keys(actual).sort(),
    Object.keys(expected).sort(),
    `a skill was added to or removed from one tree. Re-record with: ${RERECORD}`,
  )
})

for (const skill of sharedSkills(repoRoot)) {
  test(`${skill}: host-specific content matches the recorded surface`, () => {
    const want = expected[skill]
    assert.ok(want, `${skill} is not in ${FIXTURE_PATH}. Re-record with: ${RERECORD}`)

    const got = actual[skill]
    if (got.hash === want.hash) return

    // Only build the (potentially large) explanation on failure.
    const { claudeLines, codexLines } = skillLineSets(repoRoot, skill)
    const sample = [...claudeLines.map((l) => `  claude-only: ${l}`), ...codexLines.map((l) => `  codex-only:  ${l}`)]
      .slice(0, 12)
      .join('\n')

    assert.fail(
      `${skill}: host-specific content changed.\n` +
        `  recorded: claude-only ${want.claudeOnly}, codex-only ${want.codexOnly}\n` +
        `  actual:   claude-only ${got.claudeOnly}, codex-only ${got.codexOnly}\n` +
        'If this is an edit you forgot to mirror to the other host, fix the skill.\n' +
        `If it is deliberate host-specific content, re-record with: ${RERECORD}\n` +
        `First differing lines:\n${sample}`,
    )
  })
}

test('skills recorded as fully shared stay identical across hosts', () => {
  // A skill at 0/0 carries nothing host-specific, so it is a candidate for a future
  // "one source, two outputs" step (LLP 0194 T2 part 2). Derived from the fixture
  // rather than listed here, so the set grows on its own as skills converge: removing
  // disable-model-invocation (LLP 0193 #gate-moves-to-the-command) took it from two to
  // four by making the frontmatter identical.
  const fullyShared = Object.keys(expected).filter(
    (skill) => expected[skill].claudeOnly + expected[skill].codexOnly === 0,
  )
  // May legitimately be empty. The T12 merge folded the four byte-identical report
  // skills into hypaware-report, which also absorbed applying.md's host-specific
  // AskUserQuestion line, so the merged skill diverges by 3/2 and nothing is 0/0 today.

  for (const skill of fullyShared) {
    const record = actual[skill]
    assert.equal(
      record.claudeOnly + record.codexOnly,
      0,
      `${skill} was fully shared and gained host-specific content, so it is no longer a ` +
        `candidate for deduplication. If that is intended, re-record with: ${RERECORD}`,
    )
  }
})
