// @ts-check

/**
 * Shared computation for the claude/codex skill parity guard.
 *
 * @ref LLP 0197#t2-premise-corrected [implements]: records the host-specific surface
 * between the two skill trees rather than trying to eliminate it
 *
 * `@hypaware/claude` and `@hypaware/codex` ship separate skill trees to separate
 * `skill_dir`s, and the codex tree is NOT derivable from the claude one: it carries
 * host-specific content the claude tree does not have, most of it in
 * `hypaware-privacy`, where Codex has no `CLAUDE_CODE_SESSION_ID` equivalent and the
 * skill must resolve the session container off disk instead.
 *
 * So this does not assert the trees match. It records, per skill, how many lines are
 * unique to each side and a hash of them, so that *new* divergence fails and has to be
 * re-recorded deliberately. Line-set comparison (rather than a positional diff) keeps
 * the record stable under reordering and reflows, which are not the failure mode worth
 * catching here.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const FIXTURE_PATH = 'test/fixtures/skill-host-divergence.json'

const CLAUDE_SKILLS = 'hypaware-core/plugins-workspace/claude/skills'
const CODEX_SKILLS = 'hypaware-core/plugins-workspace/codex/skills'

/**
 * Skills present in both trees, discovered rather than listed, so a newly shared skill
 * is covered the moment it exists in both places.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function sharedSkills(repoRoot) {
  const inClaude = new Set(readSkillDirs(path.join(repoRoot, CLAUDE_SKILLS)))
  return readSkillDirs(path.join(repoRoot, CODEX_SKILLS))
    .filter((name) => inClaude.has(name))
    .sort()
}

/** @param {string} dir */
function readSkillDirs(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
}

/**
 * Lines present in one file's line set but not the other's, blank lines dropped as
 * noise.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string[]}
 */
function linesOnlyIn(a, b) {
  const other = new Set(b.split('\n').map((line) => line.trim()))
  return [...new Set(a.split('\n').map((line) => line.trim()))]
    .filter((line) => line !== '' && !other.has(line))
    .sort()
}

/** @param {string[]} lines */
function hashLines(lines) {
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}

/**
 * The full divergence record: one entry per skill shipped to both hosts.
 *
 * @param {string} repoRoot
 * @returns {Record<string, { claudeOnly: number, codexOnly: number, hash: string }>}
 */
export function divergenceReport(repoRoot) {
  /** @type {Record<string, { claudeOnly: number, codexOnly: number, hash: string }>} */
  const report = {}
  for (const skill of sharedSkills(repoRoot)) {
    const { claudeLines, codexLines } = skillLineSets(repoRoot, skill)
    report[skill] = {
      claudeOnly: claudeLines.length,
      codexOnly: codexLines.length,
      hash: hashLines([...claudeLines, '--', ...codexLines]),
    }
  }
  return report
}

/**
 * @param {string} repoRoot
 * @param {string} skill
 */
export function skillLineSets(repoRoot, skill) {
  const claude = skillText(path.join(repoRoot, CLAUDE_SKILLS, skill))
  const codex = skillText(path.join(repoRoot, CODEX_SKILLS, skill))
  return { claudeLines: linesOnlyIn(claude, codex), codexLines: linesOnlyIn(codex, claude) }
}

/**
 * A skill's whole Markdown surface, not just its entry file.
 *
 * The T12 merge moved most report content into stage files (`reviewing.md`,
 * `rendering.md`, `publishing.md`, `applying.md`) under one skill. Comparing only
 * `SKILL.md` would have reported the merged skill as perfectly in sync while its stage
 * files drifted freely, which is the exact failure this guard exists to prevent.
 *
 * @param {string} skillDir
 * @returns {string}
 */
function skillText(skillDir) {
  return fs
    .readdirSync(skillDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => fs.readFileSync(path.join(skillDir, name), 'utf8'))
    .join('\n\n')
}
