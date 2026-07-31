// @ts-check

// CLAUDE.md's house style bans the em dash repo-wide: "No em dashes (the U+2014
// character) anywhere: code, comments, JSDoc, strings, or docs." A rule that is
// only written down is a rule that drifts back, so this is the gate that keeps
// the sweep swept. It is a lint, not a behavior check: it asserts a property of
// the tree, and the fix is always punctuation.
//
// The replacement is not mechanical. In prose use the punctuation the sentence
// wants (a comma, a colon, parentheses, or a sentence split); in runtime strings
// prefer `-`.
//
// @ref LLP 0001#tooling [tests]: the corpus-hygiene gates run in `npm test`, so a style rule that only lives in CLAUDE.md gets one here too

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Spelled as an escape so the file that forbids the character does not contain
// it. An escape is not the character, so source that legitimately talks *about*
// the em dash (this file, and the consent-copy assertion in
// `usage-policy-classification.test.js`) needs no exemption from the scan.
const EM_DASH = '\u2014'

/**
 * The one place the rule does not reach.
 *
 * `notes-archive/` holds dated, signed review transcripts of LLP drafts. They
 * are records of what a reviewer wrote on a given day, not project prose being
 * maintained, so re-punctuating them would falsify the record rather than fix a
 * style defect. Everything else in the tree is in scope: code, comments, JSDoc,
 * strings, docs, skills, and the LLP corpus including its tombstones.
 *
 * Exemptions are prefixes, listed one per reason, so adding one is a visible
 * diff with an argument attached rather than a quiet loosening.
 */
const EXEMPT_PREFIXES = [
  'notes-archive/',
]

/** @returns {string[]} repo-relative paths of every tracked file */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return out.split('\0').filter(f => f !== '' && !EXEMPT_PREFIXES.some(p => f.startsWith(p)))
}

/**
 * Every em dash in the tree, as `file:line` plus the offending line.
 *
 * The scan reads bytes rather than filtering by extension: a new file type is
 * covered the day it lands, and a binary (which cannot carry prose) is skipped
 * by looking for a NUL rather than by maintaining a list of suffixes.
 *
 * @returns {string[]}
 */
function offenders() {
  /** @type {string[]} */
  const found = []
  for (const file of trackedFiles()) {
    const abs = path.join(REPO_ROOT, file)
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue
    const buf = fs.readFileSync(abs)
    if (buf.includes(0)) continue
    const text = buf.toString('utf8')
    if (!text.includes(EM_DASH)) continue
    text.split('\n').forEach((line, index) => {
      if (line.includes(EM_DASH)) found.push(`${file}:${index + 1}  ${line.trim()}`)
    })
  }
  return found
}

test('no tracked file carries an em dash', () => {
  const found = offenders()
  const shown = found.slice(0, 40)
  assert.deepEqual(found, [], `${found.length} lines carry an em dash (U+2014); ` +
    `replace each with the punctuation the sentence wants:\n  ${shown.join('\n  ')}` +
    (found.length > shown.length ? `\n  ...and ${found.length - shown.length} more` : ''))
})

test('the scan actually reads the tree', () => {
  // A scan that silently matched nothing would pass the rule above forever.
  const files = trackedFiles()
  assert.ok(files.length > 500, `expected the tracked tree, found ${files.length} files`)
  assert.ok(files.includes('CLAUDE.md'), 'expected the file that states the rule to be in scope')
  assert.ok(!files.some(f => f.startsWith('notes-archive/')), 'expected the archive to be exempt')
})
