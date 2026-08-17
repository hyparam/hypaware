// @ts-check

// Triage of PR #785 found an `npm-install.log` committed at the repo root: a
// reviewer's install transcript, 11 lines ending `INSTALL EXIT=0`, swept up by
// a `git add -A`. Nothing in the toolchain objected. It is excluded from the
// published file set (`package.json` `files`), so `npm pack` stays clean; it
// touches no code path, so no test moved; and `.gitignore` carried no rule for
// tool transcripts, so `git status` listed it as an ordinary new file. The only
// thing that caught it was a human reading the diff, which is exactly the check
// that is not there next time.
//
// This is the gate for both halves of that, per issue #786: the tree carries no
// tool transcript today, and `.gitignore` refuses one tomorrow. The second half
// is the one that matters - a lint that only notices after the fact still needs
// someone to run it on the right branch, while an ignore rule means the file
// never reaches `git add` in the first place.
//
// It is a lint on a property of the repository rather than a behavior check, in
// the shape of `house-style-em-dash.test.js`.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** @returns {string[]} repo-relative paths of every tracked file */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return out.split('\0').filter(f => f !== '')
}

/**
 * Whether `.gitignore` (and friends) would keep `relPath` out of a commit.
 *
 * `git check-ignore` exits 0 when a path is ignored and 1 when it is not, so
 * the status is the answer and a nonzero exit is not a failure to report.
 *
 * `--no-index` is passed so the answer is about the ignore *rules* alone. By
 * default `check-ignore` consults the index first and reports any tracked path
 * as not ignored, whatever `.gitignore` says. That is the wrong question here,
 * and it fails in the one case this file exists for: once a `.log` is tracked,
 * the rule probe would flip to "unguarded" and send the reader off to add a
 * `.gitignore` rule that is already there. Tracked transcripts are the other
 * test's job, and its message names the fix (delete the file).
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function isIgnored(relPath) {
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', relPath], { cwd: REPO_ROOT })
  if (result.error) throw result.error
  return result.status === 0
}

test('no tool transcript is tracked in the repo', () => {
  const found = trackedFiles().filter(f => f.endsWith('.log'))
  assert.deepEqual(found, [], 'a `.log` file is a tool transcript, not source; ' +
    `delete it and let \`.gitignore\` hold the line:\n  ${found.join('\n  ')}`)
})

test('.gitignore refuses a tool transcript', () => {
  // The root case is the one that actually happened; the nested cases prove the
  // rule is not anchored to the root, because scratch lands in subdirectories
  // at least as often as it lands beside `package.json`.
  const probes = [
    'npm-install.log',
    'npm-test.log',
    'typecheck.log',
    'x/npm-test.log',
    'src/core/cli/debug.log',
  ]
  const unguarded = probes.filter(p => !isIgnored(p))
  assert.deepEqual(unguarded, [], 'these paths would be committable by a stray ' +
    `\`git add -A\`; \`.gitignore\` needs a rule covering them:\n  ${unguarded.join('\n  ')}`)
})

test('the probe distinguishes ignored from unignored paths', () => {
  // A probe that answered "ignored" for everything would pass the rule above
  // forever, including on a repo with no `.gitignore` at all. Under
  // `--no-index` both assertions read the rules and nothing else, so neither
  // can be satisfied by the path's tracked status.
  assert.ok(!isIgnored('package.json'), 'expected a source file no rule matches to read as not ignored')
  assert.ok(isIgnored('hypaware-9.9.9.tgz'), 'expected an existing ignore rule (`*.tgz`) to read as ignored')
  const files = trackedFiles()
  assert.ok(files.length > 500, `expected the tracked tree, found ${files.length} files`)
})
