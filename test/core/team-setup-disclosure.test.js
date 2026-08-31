// @ts-check

// A lint over the team setup document, not a behavior check.
//
// `docs/TEAM_SETUP.md` walks a reader through the wizard, and the wizard's
// first screen is a two-answer gate (LLP 0201): accept the defaults, or
// customize. The doc therefore has a branch in it, written as the
// "If you choose Customize" subsection. Everything after that heading is
// nested inside it until the next heading, and the thing that follows it
// is the upload-hold callout - the doc's one pointer to the review window,
// the `hypaware-privacy` skill, and PRIVACY.md.
//
// Landing that callout inside the Customize branch hides it from the
// reader who took the one-keypress accept, who is most readers and has no
// reason to open a section headed with a condition they did not meet. The
// sentences are untouched when that happens, so a diff of prose shows
// nothing: only the rendered heading tree does. That is the same shape as
// the two disclosure regressions this surface already shipped, which is
// why it is pinned here rather than left to review.
//
// @ref LLP 0201#decline [tests]: a disclosure that holds for every reader sits at its section's level, never under a heading that states a condition

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC = 'docs/TEAM_SETUP.md'

// Prose every reader of the section needs, whichever answer they gave at
// the gate. Matched on a distinctive fragment rather than the whole
// paragraph so rewording it stays free; moving it does not.
const UNCONDITIONAL_CLAIMS = [
  { what: 'the upload-hold callout', find: 'Nothing is uploaded immediately.' },
  { what: 'the pointer to the privacy skill', find: 'hypaware-privacy' },
  { what: 'the pointer to PRIVACY.md', find: './PRIVACY.md' },
]

/**
 * The document's headings, in order, with the line each starts on. Fenced
 * code blocks are skipped: a `#` comment inside one is not a heading, and
 * this doc has shell blocks full of them.
 *
 * @param {string} text
 * @returns {{ line: number, depth: number, title: string }[]}
 */
function headings(text) {
  const out = []
  let fenced = false
  text.split('\n').forEach((raw, i) => {
    if (/^```/.test(raw)) {
      fenced = !fenced
      return
    }
    if (fenced) return
    const m = /^(#{1,6}) +(.*?)\s*$/.exec(raw)
    if (m) out.push({ line: i + 1, depth: m[1].length, title: m[2] })
  })
  return out
}

/**
 * The heading whose section contains `line`: the nearest one above it.
 *
 * @param {{ line: number, depth: number, title: string }[]} all
 * @param {number} line
 * @returns {{ line: number, depth: number, title: string } | undefined}
 */
function enclosingHeading(all, line) {
  let found
  for (const h of all) {
    if (h.line >= line) break
    found = h
  }
  return found
}

// A heading that states a condition: it describes one branch of a choice,
// so its section is read only by the readers who took that branch.
const CONDITIONAL_HEADING = /^(if|when|unless)\b/i

test('the team setup doc keeps its unconditional disclosures out of a conditional section', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, DOC), 'utf8')
  const lines = text.split('\n')
  const all = headings(text)

  // The branch heading this guards is really there. Without it the test
  // would pass on a doc that lost the structure entirely.
  assert.ok(
    all.some((h) => CONDITIONAL_HEADING.test(h.title)),
    `${DOC} has no conditional heading, so either the gate's branch prose was removed or the pattern needs updating`
  )

  for (const claim of UNCONDITIONAL_CLAIMS) {
    const index = lines.findIndex((l) => l.includes(claim.find))
    assert.notEqual(index, -1, `${DOC} no longer contains ${claim.what} ('${claim.find}')`)
    const owner = enclosingHeading(all, index + 1)
    assert.ok(owner, `${claim.what} sits above every heading in ${DOC}`)
    assert.ok(
      !CONDITIONAL_HEADING.test(owner.title),
      `${DOC}:${index + 1}: ${claim.what} is nested under the conditional heading ` +
      `"${owner.title}" (${DOC}:${owner.line}), so a reader who did not take that ` +
      'branch never reaches it. Give it a heading of its own at the same level, or ' +
      'move it above the branch.'
    )
  }
})
