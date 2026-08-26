// @ts-check

// A raw NUL byte (U+0000) in a source file makes every text search skip that
// file in silence. POSIX grep classifies a file containing a NUL as binary and
// suppresses matching lines: no error, no warning, just an absence. A tree that
// carries one has a hole in it that shows up only when something else catches
// the miss.
//
// That is not hypothetical here. `src/core/config/merge.js` carried a NUL as a
// dedup-key separator from the day the file was written, and a whole-tree
// `grep -rn "0308"` renumber sweep silently missed the annotation on line 90,
// which pointed at what is now LLP 0309. It was caught only because
// `llp-ref-hygiene.test.js` parses rather than greps, and a dangling reference
// would otherwise have shipped. The same blind spot applies to anything
// grep-shaped: ref sweeps, rename passes, security scans, dependency audits,
// and review. The em-dash gate next door was blinded too, since it skips any
// file holding a NUL.
//
// So the rule is: a tracked file is either text with no NUL in it, or it is a
// declared binary. There is no third category. When source genuinely needs a NUL
// character at runtime, write the escape; the escape produces the same string
// and leaves the bytes on disk searchable.
//
// @ref LLP 0001#tooling [tests]: the ref sweep is grep-shaped, and grep cannot see a file with a NUL in it, so the tree-stays-searchable property gets a gate of its own

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { trackedFiles } from '../helpers/tracked_files.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

// Spelled as an escape, which is the whole point of the rule: this file scans
// for a character it must not itself contain as a byte.
const NUL = '\0'

/**
 * The extensions whose files are binary on purpose and may hold NULs.
 *
 * Deliberately an explicit list rather than a "does this look binary" test: a
 * content heuristic would exempt exactly the regression this gate exists to
 * catch. Adding an entry is a visible diff with an argument attached.
 */
const BINARY_EXTENSIONS = new Set([
  '.png',
])

/**
 * How much of an offending line to echo, and how many offences to report from
 * any one file.
 *
 * Failing is this gate's first-class path: a new kind of binary lands, the gate
 * fails, and someone reads the sentence telling them to declare it above. That
 * path has to survive the file that triggers it. A zero-padded binary carries no
 * newline and a NUL at nearly every offset, so one whole-line echo per NUL is
 * quadratic in it: at 1 MB that is a million entries of two million characters,
 * and the runner dies of heap exhaustion before it can print anything. Both
 * bounds sit on the report, never on the scan, so every tracked file is still
 * read end to end and no NUL goes unnoticed.
 */
const ECHO_LIMIT = 120
const PER_FILE_LIMIT = 3

/**
 * Every raw NUL in the tracked text of `repoRoot`, as `file:line:column`, up to
 * `PER_FILE_LIMIT` per file.
 *
 * The offending line is echoed with each NUL rendered as an escape, so the
 * failure report cannot itself become an unsearchable blob.
 *
 * @param {string} repoRoot absolute path to the repository to scan
 * @returns {string[]}
 */
function nulOffenders(repoRoot) {
  /** @type {string[]} */
  const found = []
  for (const file of trackedFiles(repoRoot)) {
    if (BINARY_EXTENSIONS.has(path.extname(file))) continue
    const abs = path.join(repoRoot, file)
    if (fs.statSync(abs).isDirectory()) continue
    const buf = fs.readFileSync(abs)
    if (!buf.includes(0)) continue
    let reported = 0
    const lines = buf.toString('utf8').split('\n')
    for (let index = 0; index < lines.length && reported < PER_FILE_LIMIT; index++) {
      const line = lines[index]
      if (!line.includes(NUL)) continue
      const clipped = line.length > ECHO_LIMIT
      const shown = line.slice(0, ECHO_LIMIT).replaceAll(NUL, '\\0').trim() + (clipped ? '...' : '')
      for (let column = line.indexOf(NUL); column !== -1 && reported < PER_FILE_LIMIT; column = line.indexOf(NUL, column + 1)) {
        found.push(`${file}:${index + 1}:${column + 1}  ${shown}`)
        reported++
      }
    }
  }
  return found
}

test('no tracked text file carries a raw NUL byte', () => {
  const found = nulOffenders(REPO_ROOT)
  const shown = found.slice(0, 40)
  assert.deepEqual(found, [], `${found.length} raw NUL bytes make their file invisible to grep ` +
    `(at most ${PER_FILE_LIMIT} reported per file); write the escape instead, or declare the path binary:\n  ` + shown.join('\n  ') +
    (found.length > shown.length ? `\n  ...and ${found.length - shown.length} more` : ''))
})

test('the scan actually reads the tree', () => {
  // A scan that silently matched nothing would pass the rule above forever.
  const files = trackedFiles(REPO_ROOT).filter(f => !BINARY_EXTENSIONS.has(path.extname(f)))
  assert.ok(files.length > 500, `expected the tracked tree, found ${files.length} files`)
  assert.ok(files.includes('src/core/config/merge.js'),
    'expected the file this gate was written for to be in scope')
  assert.ok(!files.some(f => f.endsWith('.png')), 'expected declared binaries to be out of scope')
})

test('the scan catches a NUL that plain grep would hide', () => {
  // A gate is worth its runtime only if it fails when it should, so prove the
  // detector against a file built to be exactly the defect it guards against.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-byte-gate-'))
  try {
    fs.writeFileSync(path.join(root, 'clean.js'), 'const key = `${a}\\0${b}`\n')
    fs.writeFileSync(path.join(root, 'dirty.js'), `const key = \`\${a}${NUL}\${b}\`\n`)
    fs.writeFileSync(path.join(root, 'art.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['add', '--all'], { cwd: root })
    assert.deepEqual(nulOffenders(root), ['dirty.js:1:18  const key = `${a}\\0${b}`'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a binary that forgot its extension fails with a message, not a heap OOM', () => {
  // The message is the whole product of a failure here, so the file most likely
  // to cause one has to be a file the report can survive. A zero-padded binary
  // is that file: no newline anywhere, and a NUL at nearly every offset.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-byte-gate-binary-'))
  try {
    fs.writeFileSync(path.join(root, 'fixture.parquet'), Buffer.alloc(1024 * 1024))
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['add', '--all'], { cwd: root })
    const found = nulOffenders(root)
    assert.equal(found.length, PER_FILE_LIMIT, 'expected one file to contribute no more than its share')
    for (const entry of found) {
      assert.match(entry, /^fixture\.parquet:1:\d+ {2}/, `expected a located offence, got ${entry.slice(0, 80)}`)
      // A fixed ceiling, not one phrased in ECHO_LIMIT: an assertion written in
      // terms of the constant it is checking passes whatever that constant becomes.
      assert.ok(entry.length < 500, `expected a clipped echo, got ${entry.length} characters`)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
