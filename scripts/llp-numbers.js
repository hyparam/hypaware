#!/usr/bin/env node
// @ts-check

// The minting rule of LLP 0156, made executable. A number is free only when no
// document claims it on *any* ref that could still merge, so the tree you happen
// to have checked out is the wrong denominator: three branches cut from the same
// master each read `max(llp/) + 1`, each got the same answer, and git reported no
// conflict because their slugs differed (issue #907).
//
//   node scripts/llp-numbers.js next     the next free number, four digits
//   node scripts/llp-numbers.js check    exit 1 if this branch mints a taken number
//   node scripts/llp-numbers.js survey   every collision across every ref
//
// @ref LLP 0156#renumber [implements]: a fresh number sits above the highest claimed anywhere, including branches without an open PR
// @ref LLP 0001#tooling [implements]: the corpus gate that has to hold on every push, as a script rather than a prompt

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** Documents live under this directory, tombstones and subdirectories included. */
const LLP_DIR = 'llp'

/**
 * Per-document review artifacts are not documents and claim no number. Mirrors
 * the exclusion in `.github/workflows/llp-check.yml`.
 */
const EXCLUDED_DIRS = new Set(['reviews'])

/** `NNNN-slug.type.md`, the filename convention of LLP 0000. */
const DOC_PATTERN = /^(\d{4})-.*\.md$/

/** Where the default branch is looked for, first hit wins. */
const BASE_CANDIDATES = ['refs/remotes/origin/master', 'refs/remotes/origin/main', 'refs/heads/master', 'refs/heads/main']

/**
 * The number a path claims, or null when the path is not an LLP document.
 *
 * @param {string} filePath repo-relative, forward-slashed as git reports it
 * @returns {number | null}
 */
export function llpNumberOf(filePath) {
  const parts = filePath.split('/')
  if (parts[0] !== LLP_DIR) return null
  if (parts.slice(1, -1).some(dir => EXCLUDED_DIRS.has(dir))) return null
  const matched = DOC_PATTERN.exec(parts[parts.length - 1])
  return matched === null ? null : Number(matched[1])
}

/**
 * Index every claim across a set of refs: which document basenames claim each
 * number, and which refs carry each basename. Keyed on the basename rather than
 * the full path so that a document that only moved into `llp/tombstones/` on one
 * branch is one claimant, not two.
 *
 * @param {Map<string, string[]>} refFiles ref name to the paths it carries
 * @returns {Map<number, Map<string, string[]>>} number to basename to the refs claiming it
 */
export function claimsByNumber(refFiles) {
  /** @type {Map<number, Map<string, string[]>>} */
  const claims = new Map()
  for (const [ref, files] of refFiles) {
    for (const file of files) {
      const number = llpNumberOf(file)
      if (number === null) continue
      const byName = claims.get(number) ?? new Map()
      const name = basename(file)
      const refs = byName.get(name) ?? []
      if (!refs.includes(ref)) refs.push(ref)
      byName.set(name, refs)
      claims.set(number, byName)
    }
  }
  return claims
}

/**
 * The next number a new document may take: above the highest claimed anywhere,
 * never the lowest unused. The corpus is deliberately sparse, because a number
 * retired with its document is never reused, so a gap is not free.
 *
 * @param {Map<string, string[]>} refFiles
 * @returns {number}
 */
export function nextFreeNumber(refFiles) {
  let highest = 0
  for (const number of claimsByNumber(refFiles).keys()) {
    if (number > highest) highest = number
  }
  return highest + 1
}

/**
 * Numbers claimed by two or more different documents across the given refs.
 *
 * `only` narrows the report to a set of numbers. Reporting every collision would
 * make this unusable as a gate: a branch cut before a repair still carries the
 * pre-repair filename, so the corpus's already-settled collisions live on in
 * every stale branch and would redden pull requests that are party to none of
 * them. What a pull request is answerable for is the number it *mints*.
 *
 * @param {Map<string, string[]>} refFiles
 * @param {Set<number> | null} only
 * @returns {{ number: number, claimants: { file: string, refs: string[] }[] }[]}
 */
export function collisions(refFiles, only = null) {
  /** @type {{ number: number, claimants: { file: string, refs: string[] }[] }[]} */
  const found = []
  for (const [number, byName] of claimsByNumber(refFiles)) {
    if (byName.size < 2) continue
    if (only !== null && !only.has(number)) continue
    const claimants = [...byName].map(([file, refs]) => ({ file, refs }))
    found.push({ number, claimants: claimants.sort((a, b) => a.file.localeCompare(b.file)) })
  }
  return found.sort((a, b) => a.number - b.number)
}

/**
 * The documents a branch adds: present at the tip, absent at the point it left
 * the default branch. Basenames, so that renaming a document already on the base
 * (the repair LLP 0156 prescribes) does not read as a fresh mint.
 *
 * @param {string[]} baseFiles paths at the merge base
 * @param {string[]} headFiles paths at the tip
 * @returns {string[]}
 */
export function addedDocs(baseFiles, headFiles) {
  const before = new Set(baseFiles.filter(f => llpNumberOf(f) !== null).map(basename))
  return headFiles.filter(f => llpNumberOf(f) !== null).map(basename).filter(name => !before.has(name))
}

/**
 * Every ref whose content could still reach the default branch: local branches,
 * remote tracking branches, and the working tree's own ref. Tags are excluded (a
 * tag is history that already merged or never will), and so is a remote's
 * symbolic `HEAD`, an alias for a branch already listed.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function mergeableRefs(repoRoot) {
  const out = git(repoRoot, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  const refs = out.split('\n').filter(line => line !== '' && !/\/HEAD$/.test(line))
  refs.push('HEAD')
  return refs
}

/**
 * The LLP documents each ref carries. A ref that cannot be read (a remote pruned
 * mid-run, a shallow clone missing the object) contributes nothing rather than
 * aborting the scan: a partial index still catches collisions, an aborted one
 * catches none.
 *
 * @param {string} repoRoot
 * @param {string[]} refs
 * @returns {Map<string, string[]>}
 */
export function refFilesFromGit(repoRoot, refs) {
  /** @type {Map<string, string[]>} */
  const refFiles = new Map()
  for (const ref of refs) {
    const listed = tryGit(repoRoot, ['ls-tree', '-r', '--name-only', ref, '--', LLP_DIR])
    if (listed === null) continue
    refFiles.set(ref, listed.split('\n').filter(line => line !== ''))
  }
  return refFiles
}

/**
 * The numbers the working ref mints against the default branch. Empty on the
 * default branch itself, which is what keeps the gate quiet on merges.
 *
 * @param {string} repoRoot
 * @returns {{ base: string | null, numbers: Set<number>, files: string[] }}
 */
export function mintedNumbers(repoRoot) {
  const base = BASE_CANDIDATES.find(ref => tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', ref]) !== null) ?? null
  if (base === null) return { base: null, numbers: new Set(), files: [] }
  const mergeBase = tryGit(repoRoot, ['merge-base', 'HEAD', base])
  const files = addedDocs(
    mergeBase === null ? [] : refFilesFromGit(repoRoot, [mergeBase]).get(mergeBase) ?? [],
    refFilesFromGit(repoRoot, ['HEAD']).get('HEAD') ?? [],
  )
  /** @type {Set<number>} */
  const numbers = new Set()
  for (const file of files) {
    const number = llpNumberOf(`${LLP_DIR}/${file}`)
    if (number !== null) numbers.add(number)
  }
  return { base, numbers, files }
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function basename(filePath) {
  return filePath.split('/').pop() ?? filePath
}

/**
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {string}
 */
function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trimEnd()
}

/**
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {string | null} null when git failed or said nothing
 */
function tryGit(repoRoot, args) {
  try {
    const out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/**
 * @param {number} number
 * @returns {string}
 */
export function padNumber(number) {
  return String(number).padStart(4, '0')
}

/**
 * @param {{ number: number, claimants: { file: string, refs: string[] }[] }[]} found
 * @param {number} next the number a repair should move to
 * @returns {string}
 */
export function formatCollisions(found, next) {
  const lines = [`${found.length} LLP number${found.length === 1 ? '' : 's'} claimed by more than one document:`]
  for (const { number, claimants } of found) {
    lines.push(`  LLP ${padNumber(number)}`)
    for (const claimant of claimants) lines.push(`    ${claimant.file}  on ${claimant.refs.join(', ')}`)
  }
  lines.push('')
  lines.push(`Renumber the later claimant to ${padNumber(next)} or above (LLP 0156), and sweep`)
  lines.push('every @ref, doc link and Related: header that meant it.')
  return lines.join('\n')
}

/**
 * @param {string[]} argv
 * @param {string} repoRoot
 * @param {(text: string) => void} write
 * @param {(text: string) => void} writeError
 * @returns {number} process exit code
 */
export function run(argv, repoRoot, write, writeError) {
  const mode = argv[0]
  if (mode !== 'next' && mode !== 'check' && mode !== 'survey') {
    writeError('usage: llp-numbers.js next | check | survey\n')
    return 2
  }
  const refFiles = refFilesFromGit(repoRoot, mergeableRefs(repoRoot))
  const next = nextFreeNumber(refFiles)
  if (mode === 'next') {
    write(`${padNumber(next)}\n`)
    return 0
  }
  if (mode === 'survey') {
    const all = collisions(refFiles)
    write(all.length === 0 ? 'no LLP number is claimed by two documents\n' : `${formatCollisions(all, next)}\n`)
    return 0
  }
  const minted = mintedNumbers(repoRoot)
  if (minted.base === null) {
    writeError('no default branch to compare against, so nothing is minted here\n')
    return 0
  }
  const found = collisions(refFiles, minted.numbers)
  if (found.length === 0) {
    write(`${minted.files.length} LLP document${minted.files.length === 1 ? '' : 's'} minted against ${minted.base}, no collision\n`)
    return 0
  }
  writeError(`${formatCollisions(found, next)}\n`)
  return 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(process.argv[1]), '..')
  process.exit(run(
    process.argv.slice(2),
    root,
    text => process.stdout.write(text),
    text => process.stderr.write(text),
  ))
}
