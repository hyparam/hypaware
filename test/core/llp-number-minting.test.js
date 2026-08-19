// @ts-check

// Issue #907: three branches cut from the same master each minted `llp/0266-*`.
// Each read the highest number in the tree it had checked out, each got 0265,
// and each picked 0266. Their slugs differed, so git reported no conflict and
// the second merge would simply have added a second document numbered 0266.
//
// The fixtures below are that history, rebuilt in temp repos, and they are the
// whole reason this file exists: the rule under test is only wrong when more
// than one branch is in play, so a check that reads the working tree cannot see
// the defect it is meant to catch.
//
// @ref LLP 0156#renumber [tests]: a fresh number sits above the highest claimed anywhere, so a per-branch max is not the rule

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  addedDocs,
  claimsByNumber,
  collisions,
  llpNumberOf,
  mergeableRefs,
  mintedNumbers,
  nextFreeNumber,
  NOT_A_CHECKOUT,
  partialScan,
  refFilesFromGit,
  run,
} from '../../scripts/llp-numbers.js'

/**
 * @import { TestContext } from 'node:test'
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The three documents of issue #907, one per branch, all numbered 0266. */
const COLLIDED = [
  ['fix/issue-836', 'llp/0266-core-command-argument-validation.decision.md'],
  ['fix/issue-884', 'llp/0266-prune-asks-every-client-not-the-run.decision.md'],
  ['update/icebird-squirreling', 'llp/0266-native-prepared-batches.decision.md'],
]

/**
 * @param {string} repo
 * @param {string[]} args
 * @returns {string}
 */
function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trimEnd()
}

/**
 * @param {string} repo
 * @param {string} message
 */
function commit(repo, message) {
  git(repo, ['add', '-A'])
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message])
}

/**
 * @param {string} repo
 * @param {string} file
 */
function writeDoc(repo, file) {
  const full = path.join(repo, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, `# ${file}\n`)
}

/**
 * @param {TestContext} t
 * @returns {string} an empty repo with a master branch
 */
function emptyRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'llp-numbers-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  git(repo, ['init', '-q', '-b', 'master'])
  return repo
}

/**
 * A master at LLP 0265 with the three colliding branches hanging off it, each
 * also mirrored under `refs/remotes/origin/` so the scan sees what a fetched
 * clone would see.
 *
 * @param {TestContext} t
 * @returns {string} the repo path
 */
function collidedRepo(t) {
  const repo = emptyRepo(t)
  writeDoc(repo, 'llp/0264-grep-search.decision.md')
  writeDoc(repo, 'llp/0265-grep-search-implementation.plan.md')
  writeDoc(repo, 'llp/tombstones/0018-retired.decision.md')
  commit(repo, 'the corpus up to LLP 0265')
  for (const [branch, file] of COLLIDED) {
    git(repo, ['checkout', '-q', '-b', branch, 'master'])
    writeDoc(repo, file)
    commit(repo, `mint 0266 on ${branch}`)
    git(repo, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'])
  }
  git(repo, ['checkout', '-q', 'master'])
  git(repo, ['update-ref', 'refs/remotes/origin/master', 'master'])
  return repo
}

test('a path claims a number only when it is an LLP document', () => {
  assert.equal(llpNumberOf('llp/0266-prune-asks-every-client.decision.md'), 266)
  // A retired number is never reused, so a tombstone still claims its number.
  assert.equal(llpNumberOf('llp/tombstones/0018-retired.decision.md'), 18)
  assert.equal(llpNumberOf('llp/0000-hypaware.explainer.md'), 0)
  assert.equal(llpNumberOf('llp/reviews/0266-round-1.claude.md'), null)
  assert.equal(llpNumberOf('llp/README.md'), null)
  assert.equal(llpNumberOf('llp/266-unpadded.decision.md'), null)
  assert.equal(llpNumberOf('notes-archive/0266-not-an-llp.md'), null)
})

// A document is tombstoned on one branch and not on another all the time, and
// that is one document at one number, not two claimants of it.
test('a document that only moved between directories is one claimant', () => {
  const refFiles = new Map([
    ['refs/heads/master', ['llp/0100-a.spec.md']],
    ['refs/heads/topic', ['llp/tombstones/0100-a.spec.md']],
  ])
  const byName = claimsByNumber(refFiles).get(100) ?? new Map()
  assert.deepEqual([...byName.keys()], ['0100-a.spec.md'])
  assert.deepEqual(byName.get('0100-a.spec.md'), ['refs/heads/master', 'refs/heads/topic'])
  assert.deepEqual(collisions(refFiles), [])
})

test('renaming a document already on the base is not a fresh mint', () => {
  assert.deepEqual(addedDocs(['llp/0100-a.spec.md'], ['llp/tombstones/0100-a.spec.md']), [])
  assert.deepEqual(addedDocs(['llp/0100-a.spec.md'], ['llp/0100-a.spec.md', 'llp/0101-b.spec.md']), ['0101-b.spec.md'])
  assert.deepEqual(addedDocs([], ['llp/README.md']), [])
})

// The reproduction. Reading one branch at a time is exactly what each of the
// three workers did, and it is why all three answered 0266.
test('the next free number is the highest claimed on any ref, not on the checked-out one', t => {
  const repo = collidedRepo(t)
  const refs = ['refs/heads/master', ...COLLIDED.map(([branch]) => `refs/heads/${branch}`)]
  const perRef = refFilesFromGit(repo, refs)
  // Master alone is the tree all three workers read, and it answers 0266.
  assert.equal(nextFreeNumber(new Map([['refs/heads/master', perRef.get('refs/heads/master') ?? []]])), 266)
  // Across every ref that could still merge, 0266 is taken and 0267 is free.
  assert.equal(nextFreeNumber(refFilesFromGit(repo, mergeableRefs(repo))), 267)
})

test('a number claimed by two documents on different refs is a collision', t => {
  const repo = collidedRepo(t)
  const found = collisions(refFilesFromGit(repo, mergeableRefs(repo)))
  assert.equal(found.length, 1)
  assert.equal(found[0].number, 266)
  assert.deepEqual(
    found[0].claimants.map(c => c.file).sort(),
    COLLIDED.map(([, file]) => String(file.split('/').pop())).sort(),
  )
})

test('the check fails on the branch that minted the taken number, and names every claimant', t => {
  const repo = collidedRepo(t)
  git(repo, ['checkout', '-q', COLLIDED[1][0]])
  assert.deepEqual([...mintedNumbers(repo).numbers], [266])
  /** @type {string[]} */
  const err = []
  const code = run(['check'], repo, () => {}, text => err.push(text))
  assert.equal(code, 1)
  const report = err.join('')
  assert.match(report, /LLP 0266/)
  for (const [, file] of COLLIDED) assert.ok(report.includes(String(file.split('/').pop())), report)
  // And it says where to move: above everything claimed anywhere, per LLP 0156.
  assert.match(report, /0267 or above \(LLP 0156\)/)
})

test('the check passes on the branch that mints nothing', t => {
  const repo = collidedRepo(t)
  assert.deepEqual([...mintedNumbers(repo).numbers], [])
  /** @type {string[]} */
  const out = []
  assert.equal(run(['check'], repo, text => out.push(text), () => {}), 0)
  assert.match(out.join(''), /no collision/)
})

// The gate has to be quiet about collisions it is not party to, or it stops
// being read. A branch cut before a repair still carries the pre-repair
// filename, so every already-settled collision in the corpus lives on in stale
// branches forever.
test('a settled collision surviving on a stale branch does not fail an unrelated branch', t => {
  const repo = emptyRepo(t)
  writeDoc(repo, 'llp/0100-a.spec.md')
  commit(repo, 'before the repair')
  git(repo, ['branch', 'stale'])
  git(repo, ['mv', 'llp/0100-a.spec.md', 'llp/0101-a.spec.md'])
  writeDoc(repo, 'llp/0100-b.spec.md')
  commit(repo, 'the repair of LLP 0156: the later claimant is renumbered')
  git(repo, ['checkout', '-q', '-b', 'topic'])
  writeDoc(repo, 'llp/0102-c.spec.md')
  commit(repo, 'an unrelated branch minting the next free number')

  // Across refs, 0100 really is claimed twice, and a survey says so.
  const refFiles = refFilesFromGit(repo, mergeableRefs(repo))
  assert.deepEqual(collisions(refFiles).map(c => c.number), [100])
  /** @type {string[]} */
  const surveyed = []
  assert.equal(run(['survey'], repo, text => surveyed.push(text), () => {}), 0)
  assert.match(surveyed.join(''), /LLP 0100/)

  // The gate stays quiet: 0102 is all this branch minted.
  assert.deepEqual([...mintedNumbers(repo).numbers], [102])
  assert.equal(run(['check'], repo, () => {}, () => {}), 0)
})

test('the next mode prints the free number zero-padded', t => {
  const repo = collidedRepo(t)
  /** @type {string[]} */
  const out = []
  assert.equal(run(['next'], repo, text => out.push(text), () => {}), 0)
  assert.equal(out.join(''), '0267\n')
})

test('an unknown mode is a usage error, not a silent pass', t => {
  const repo = collidedRepo(t)
  assert.equal(run([], repo, () => {}, () => {}), 2)
  assert.equal(run(['fix'], repo, () => {}, () => {}), 2)
})

// A checkout that carries one branch and no default branch answers every mode
// from a corpus of one, which is the defect of issue #907 rather than a pass.
// `actions/checkout` hands exactly that to any job that does not ask for more,
// so the condition is detected rather than assumed away.
test('a checkout that cannot see the corpus says so instead of answering', t => {
  assert.equal(partialScan(collidedRepo(t)), null)

  const alone = emptyRepo(t)
  writeDoc(alone, 'llp/0100-a.spec.md')
  commit(alone, 'one branch, no default branch, no remote')
  git(alone, ['checkout', '-q', '-b', 'topic'])
  git(alone, ['branch', '-q', '-D', 'master'])
  assert.match(String(partialScan(alone)), /no default-branch ref/)
  /** @type {string[]} */
  const err = []
  assert.equal(run(['next'], alone, () => {}, text => err.push(text)), 0)
  assert.match(err.join(''), /^warning: /)

  assert.equal(partialScan(path.join(os.tmpdir(), 'llp-numbers-no-such-checkout')), NOT_A_CHECKOUT)
})

// The in-suite half of the gate: what this branch mints has to be free in this
// repository, not only in a fixture. It can only answer that where the clone
// carries the other branches, so it says why it is skipping rather than passing
// green on a shallow or single-branch checkout that never looked.
test('this branch mints no number another ref already claims', t => {
  const partial = partialScan(REPO_ROOT)
  if (partial !== null) {
    t.skip(`this is ${partial}: fetch every branch to run this check`)
    return
  }
  const refFiles = refFilesFromGit(REPO_ROOT, mergeableRefs(REPO_ROOT))
  assert.ok(refFiles.size > 0, 'expected at least one readable ref')
  const found = collisions(refFiles, mintedNumbers(REPO_ROOT).numbers)
  assert.deepEqual(found.map(c => `LLP ${c.number}: ${c.claimants.map(x => x.file).join(', ')}`), [])
})
