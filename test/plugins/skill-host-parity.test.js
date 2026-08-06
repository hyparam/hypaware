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

test('the two skills with no host-specific content stay identical', () => {
  // These carry nothing host-specific today, so they are the ones a future "one source,
  // two outputs" step can dedup without losing anything (LLP 0194 T2 part 2).
  for (const skill of ['hypaware-ai-usage-report', 'hypaware-graph']) {
    const record = actual[skill]
    assert.equal(
      record.claudeOnly + record.codexOnly,
      0,
      `${skill} gained host-specific content, so it is no longer a candidate for ` +
        `deduplication. If that is intended, update this test and re-record with: ${RERECORD}`,
    )
  }
})
