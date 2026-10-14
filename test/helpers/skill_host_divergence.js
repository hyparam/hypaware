// @ts-check

/**
 * Shared computation for the skill-tree parity guard: claude against codex, and the
 * host-neutral tree against each.
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
 *
 * The neutral tree (LLP 0494#skills) generalizes the host-specific sentences of both,
 * so it is recorded against each host tree the same way: a host edit that is not
 * mirrored in the neutral tree, or the reverse, changes a recorded hash.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { SKILL_TREES } from './client_skill_trees.js'

export const FIXTURE_PATH = 'test/fixtures/skill-host-divergence.json'

/**
 * The tree pairs the record covers, `[left, right]` keys of `SKILL_TREES`. The
 * claude/codex pair comes first and keeps its original field names and hashes.
 * @type {[keyof typeof SKILL_TREES, keyof typeof SKILL_TREES][]}
 */
export const TREE_PAIRS = [['claude', 'codex'], ['neutral', 'claude'], ['neutral', 'codex']]

/** @param {[string, string]} pair */
export function pairKey([left, right]) {
  return `${left}-${right}`
}

/**
 * Skills present in both trees of a pair, discovered rather than listed, so a newly
 * shared skill is covered the moment it exists in both places.
 *
 * @param {string} repoRoot
 * @param {[keyof typeof SKILL_TREES, keyof typeof SKILL_TREES]} pair
 * @returns {string[]}
 */
export function sharedSkills(repoRoot, [left, right]) {
  const inLeft = new Set(readSkillDirs(path.join(repoRoot, SKILL_TREES[left])))
  return readSkillDirs(path.join(repoRoot, SKILL_TREES[right]))
    .filter((name) => inLeft.has(name))
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
 * The full divergence record: per tree pair, one entry per skill shipped to both
 * trees, counting the lines only in each as `<left>Only` and `<right>Only`.
 *
 * @param {string} repoRoot
 * @returns {Record<string, Record<string, Record<string, number | string>>>}
 */
export function divergenceReport(repoRoot) {
  /** @type {Record<string, Record<string, Record<string, number | string>>>} */
  const report = {}
  for (const pair of TREE_PAIRS) {
    const [left, right] = pair
    /** @type {Record<string, Record<string, number | string>>} */
    const record = {}
    for (const skill of sharedSkills(repoRoot, pair)) {
      const { leftLines, rightLines } = skillLineSets(repoRoot, skill, pair)
      record[skill] = {
        [`${left}Only`]: leftLines.length,
        [`${right}Only`]: rightLines.length,
        hash: hashLines([...leftLines, '--', ...rightLines]),
      }
    }
    report[pairKey(pair)] = record
  }
  return report
}

/**
 * @param {string} repoRoot
 * @param {string} skill
 * @param {[keyof typeof SKILL_TREES, keyof typeof SKILL_TREES]} pair
 */
export function skillLineSets(repoRoot, skill, [left, right]) {
  const leftText = skillText(path.join(repoRoot, SKILL_TREES[left], skill))
  const rightText = skillText(path.join(repoRoot, SKILL_TREES[right], skill))
  return { leftLines: linesOnlyIn(leftText, rightText), rightLines: linesOnlyIn(rightText, leftText) }
}

/**
 * A skill's whole Markdown surface, not just its entry file.
 *
 * The T12 merge moved most report content into stage files (`reviewing.md`,
 * `rendering.md`, `publishing.md`, `applying.md`) under one skill. Comparing only
 * `SKILL.md` would have reported the merged skill as perfectly in sync while its stage
 * files drifted freely, which is the exact failure this guard exists to prevent.
 *
 * Recurses into subdirectories such as a skill's `references/` tree: `hypaware-report`
 * ships one, and a one-level read left its prose invisible to this guard.
 *
 * @param {string} skillDir
 * @returns {string}
 */
function skillText(skillDir) {
  return findMarkdownFiles(skillDir)
    .sort()
    .map((relPath) => fs.readFileSync(path.join(skillDir, relPath), 'utf8'))
    .join('\n\n')
}

/**
 * Markdown file paths under `dir`, relative to `dir`, found by walking
 * subdirectories recursively.
 *
 * @param {string} dir
 * @param {string} [relDir]
 * @returns {string[]}
 */
function findMarkdownFiles(dir, relDir = '') {
  /** @type {string[]} */
  const found = []
  for (const entry of fs.readdirSync(path.join(dir, relDir), { withFileTypes: true })) {
    const rel = path.join(relDir, entry.name)
    if (entry.isDirectory()) found.push(...findMarkdownFiles(dir, rel))
    else if (entry.name.endsWith('.md')) found.push(rel)
  }
  return found
}
