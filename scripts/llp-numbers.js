#!/usr/bin/env node
// @ts-check

// The minting rule of LLP 0156, made executable. A number is free only when no
// document claims it on *any* ref that could still merge, nor in the working tree
// alongside them, so the tree you happen to have checked out is the wrong
// denominator: three branches cut from the same
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

import { compareStrings } from '../src/core/util/compare_strings.js'

/** Documents live under this directory, tombstones and subdirectories included. */
const LLP_DIR = 'llp'

/**
 * Per-document review artifacts are not documents and claim no number. Mirrors
 * the exclusion in `.github/workflows/llp-check.yml`.
 */
const EXCLUDED_DIRS = new Set(['reviews'])

/** `NNNN-slug.type.md`, the filename convention of LLP 0000. */
const DOC_PATTERN = /^(\d{4})-.*\.md$/

/** How many refs a claimant line names before it summarises the rest. */
const MAX_REFS_SHOWN = 6

/** The mode a tree entry carries when it is itself a tree, in git's own octal. */
const TREE_MODE = '40000'

/**
 * Room for one level of the walk in `refFilesFromGit`: every distinct `llp/`
 * tree across every ref, at a few dozen bytes an entry. This clone's 951 refs
 * share 441 such trees and come to 5.5 MiB; the default 1 MiB would not hold
 * them.
 */
const BATCH_BUFFER_BYTES = 64 * 1024 * 1024

/** The label the working tree carries when it claims a number alongside the refs. */
export const WORKTREE = 'the working tree'

/** What `partialScan` answers when the path is not a git checkout at all. */
export const NOT_A_CHECKOUT = 'not a git checkout, so there is no corpus to scan'

/** What `partialScan` answers when the clone carries truncated history. */
export const SHALLOW_CLONE = 'a shallow clone, so the history it carries is not the corpus'

/** What `partialScan` answers when the clone carries no branch to compare against. */
export const NO_BASE_REF = 'a checkout with no default-branch ref, so the branches it carries are not the corpus'

/**
 * The fetch that turns each partial scan into a whole one, named per case
 * because the two are not interchangeable: `--unshallow` aborts with
 * `fatal: --unshallow on a complete repository does not make sense` on a
 * single-branch clone, which is the other case entirely.
 */
const REMEDY = new Map([
  [SHALLOW_CLONE, 'git fetch --prune --unshallow'],
  [NO_BASE_REF, "git fetch --no-tags --prune origin '+refs/heads/*:refs/remotes/origin/*'"],
])

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
    found.push({ number, claimants: claimants.sort((a, b) => compareStrings(a.file, b.file)) })
  }
  return found.sort((a, b) => a.number - b.number)
}

/**
 * Distinct documents per number in one tree, by basename so that a document the
 * branch only moved between directories (into `llp/tombstones/`, say) stays one
 * document.
 *
 * @param {string[]} files
 * @returns {Map<number, Set<string>>}
 */
function docsByNumber(files) {
  /** @type {Map<number, Set<string>>} */
  const byNumber = new Map()
  for (const file of files) {
    const number = llpNumberOf(file)
    if (number === null) continue
    const names = byNumber.get(number) ?? new Set()
    names.add(basename(file))
    byNumber.set(number, names)
  }
  return byNumber
}

/**
 * The numbers a branch is answerable for: those that more documents claim at its
 * tip than at the point it left the default branch. Counted rather than matched
 * by name, because changing a document's slug leaves its number exactly as
 * claimed as it already was (0265-a to 0265-b mints nothing), while adding a
 * second document at a number the base already carries does mint it. A renumber,
 * the repair LLP 0156 prescribes, mints the number it moves to and is checked
 * there, which is the point: the number it moves to has to be free too.
 *
 * @param {string[]} baseFiles paths at the merge base
 * @param {string[]} headFiles paths at the tip
 * @returns {Set<number>}
 */
export function mintedAgainst(baseFiles, headFiles) {
  const before = docsByNumber(baseFiles)
  /** @type {Set<number>} */
  const minted = new Set()
  for (const [number, names] of docsByNumber(headFiles)) {
    if (names.size > (before.get(number)?.size ?? 0)) minted.add(number)
  }
  return minted
}

/**
 * The base branch's own documents that are sitting in this tree: inherited, not
 * minted here. The merge base alone is the wrong floor whenever the tree carries
 * base-branch content the fork point did not have (an interrupted `git merge`,
 * a `git checkout origin/master -- llp/`). Every such document then reads as
 * newly minted and the branch is told to renumber one it never wrote. Matching
 * by basename, and only where the document is actually here, keeps the count
 * comparison honest: a slug this branch rewrote is not in the base tip under its
 * new name, so it stays inherited at one document, and a number the base branch
 * claims under a name this branch does not carry stays mintable, which is how a
 * rival document landing on master first is still caught.
 *
 * @param {string[]} baseFiles paths at the base branch's tip
 * @param {string[]} tipPaths paths this branch would merge
 * @returns {string[]}
 */
function inheritedFrom(baseFiles, tipPaths) {
  const here = new Set(tipPaths.map(basename))
  return baseFiles.filter(file => here.has(basename(file)))
}

/**
 * Refs whose tip is reachable from HEAD. They hold no claim of their own: every
 * document they carry is either in this tree too or was removed on the way here,
 * so a claim only they hold is a prior version of this branch rather than a
 * rival. Without this, renaming the slug of a number you minted and pushed fails
 * the gate against your own pre-rename filename, still sitting on
 * `refs/remotes/origin/<branch>`, and prescribes a renumber for a collision with
 * yourself.
 *
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
export function supersededRefs(repoRoot) {
  const out = tryGit(repoRoot, ['for-each-ref', '--format=%(refname)', '--merged', 'HEAD', 'refs/heads', 'refs/remotes'])
  return new Set((out ?? '').split('\n').filter(line => line !== ''))
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
  const out = tryGit(repoRoot, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  const refs = (out ?? '').split('\n').filter(line => line !== '' && !/\/HEAD$/.test(line))
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
  if (refs.length === 0) return refFiles
  // One `cat-file` resolves every ref's `llp/` tree, one line per ref in order,
  // where a `ls-tree` per ref cost a process each: a clone with a hundred
  // branches spent well over a second here, most of it in fork and exec. A ref
  // without the directory, or one git cannot read, comes back `missing`.
  const resolved = tryGitBatch(repoRoot, ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    refs.map(ref => `${ref}:${LLP_DIR}`).join('\n') + '\n')
  if (resolved === null) return refFiles
  /** @type {Map<string, string>} */
  const treeOf = new Map()
  resolved.toString('utf8').split('\n').forEach((line, index) => {
    const [id, type] = line.split(' ')
    if (type === 'tree' && index < refs.length) treeOf.set(refs[index], id)
  })

  // Walk the trees a level at a time, every tree of the level in one more
  // `cat-file`, so the calls scale with the depth of `llp/` and not with the
  // number of refs. Refs sharing a tree, the common case for a branch that
  // never touched the corpus, are read once.
  /** @type {Map<string, string[]>} */
  const filesOfTree = new Map()
  /** @type {{ root: string, id: string, prefix: string }[]} */
  let level = [...new Set(treeOf.values())].map(id => ({ root: id, id, prefix: `${LLP_DIR}/` }))
  while (level.length > 0) {
    const raw = tryGitBatch(repoRoot, ['cat-file', '--batch'], [...new Set(level.map(node => node.id))].join('\n') + '\n')
    if (raw === null) break
    const trees = parseTreeBatch(raw)
    /** @type {typeof level} */
    const next = []
    for (const node of level) {
      const files = filesOfTree.get(node.root) ?? []
      filesOfTree.set(node.root, files)
      for (const entry of trees.get(node.id) ?? []) {
        if (entry.mode === TREE_MODE) next.push({ root: node.root, id: entry.id, prefix: `${node.prefix}${entry.name}/` })
        else files.push(`${node.prefix}${entry.name}`)
      }
    }
    level = next
  }
  // Byte order of the full path, which is the order `ls-tree -r` lists in.
  for (const files of filesOfTree.values()) files.sort()
  for (const [ref, id] of treeOf) refFiles.set(ref, [...filesOfTree.get(id) ?? []])
  return refFiles
}

/**
 * The LLP documents on disk, tracked and untracked alike. A document written but
 * not yet committed claims its number: two `/llp-create` calls in one session
 * are the ordinary case, and a scan of committed trees only would hand both the
 * same number, which is the defect this script exists to prevent.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function worktreeFiles(repoRoot) {
  const listed = tryGit(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '--', LLP_DIR])
  return listed === null ? [] : [...new Set(listed.split('\n').filter(line => line !== ''))]
}

/**
 * What this branch would merge: the working tree where there is one, the HEAD
 * tree otherwise (a bare checkout, or a repo with no `llp/` on disk).
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function tipFiles(repoRoot) {
  const worktree = worktreeFiles(repoRoot)
  return worktree.length > 0 ? worktree : refFilesFromGit(repoRoot, ['HEAD']).get('HEAD') ?? []
}

/**
 * The claim index every mode reads: every mergeable ref plus the working tree.
 *
 * @param {string} repoRoot
 * @returns {Map<string, string[]>}
 */
export function scanRefFiles(repoRoot) {
  const refFiles = refFilesFromGit(repoRoot, mergeableRefs(repoRoot))
  const worktree = worktreeFiles(repoRoot)
  if (worktree.length > 0) refFiles.set(WORKTREE, worktree)
  return refFiles
}

/**
 * The numbers the working ref mints against the default branch. Empty on the
 * default branch itself, which is what keeps the gate quiet on merges.
 *
 * A merge base that cannot be found (a truncated clone, an unrelated history)
 * means the answer is unknown, reported as a null `mergeBase`. Treating it as an
 * empty base instead would count the whole corpus at HEAD as newly minted and
 * blame this branch for every collision already settled in it.
 *
 * @param {string} repoRoot
 * @returns {{ base: string | null, mergeBase: string | null, numbers: Set<number> }}
 */
export function mintedNumbers(repoRoot) {
  const base = BASE_CANDIDATES.find(ref => tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', ref]) !== null) ?? null
  if (base === null) return { base: null, mergeBase: null, numbers: new Set() }
  const mergeBase = tryGit(repoRoot, ['merge-base', 'HEAD', base])
  if (mergeBase === null) return { base, mergeBase: null, numbers: new Set() }
  const tip = tipFiles(repoRoot)
  const inherited = inheritedFrom(refFilesFromGit(repoRoot, [base]).get(base) ?? [], tip)
  const floor = [...refFilesFromGit(repoRoot, [mergeBase]).get(mergeBase) ?? [], ...inherited]
  return { base, mergeBase, numbers: mintedAgainst(floor, tip) }
}

/**
 * Why this checkout cannot answer the question, or null when it can. A clone
 * fetched shallow or with a single branch (what `actions/checkout` hands a job
 * that does not ask for more) carries one ref and no default branch, so every
 * mode reads a corpus of one: `next` hands back a number other branches already
 * took, and `check` finds no base to diff against and passes. That is issue
 * #907 wearing this script's own clothes, so it is reported rather than answered
 * silently.
 *
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function partialScan(repoRoot) {
  if (tryGit(repoRoot, ['rev-parse', '--git-dir']) === null) return NOT_A_CHECKOUT
  if (tryGit(repoRoot, ['rev-parse', '--is-shallow-repository']) === 'true') return SHALLOW_CLONE
  if (!BASE_CANDIDATES.some(ref => tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', ref]) !== null)) return NO_BASE_REF
  return null
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
 * Run git with `input` on stdin and hand back its raw stdout, or null when git
 * failed. Raw, not decoded: `cat-file --batch` follows each text header with the
 * object's bytes, and a tree object is binary.
 *
 * @param {string} repoRoot
 * @param {string[]} args
 * @param {string} input
 * @returns {Buffer | null}
 */
function tryGitBatch(repoRoot, args, input) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, input, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: BATCH_BUFFER_BYTES })
  } catch {
    return null
  }
}

/**
 * The entries of every tree object in a `cat-file --batch` reply, keyed by id.
 * The reply is `<id> <type> <size>\n<bytes>\n` per object, or `<id> missing\n`
 * for one git does not have (a shallow clone), which lists as empty. A tree's
 * bytes are `<mode> <name>\0<20-byte id>` per entry, in tree order.
 *
 * @param {Buffer} raw
 * @returns {Map<string, { mode: string, name: string, id: string }[]>}
 */
function parseTreeBatch(raw) {
  /** @type {Map<string, { mode: string, name: string, id: string }[]>} */
  const trees = new Map()
  let at = 0
  while (at < raw.length) {
    const eol = raw.indexOf(0x0a, at)
    if (eol === -1) break
    const [id, type, size] = raw.toString('latin1', at, eol).split(' ')
    at = eol + 1
    if (type === 'missing') continue
    const end = at + Number(size)
    if (type === 'tree') {
      /** @type {{ mode: string, name: string, id: string }[]} */
      const entries = []
      let cursor = at
      while (cursor < end) {
        const space = raw.indexOf(0x20, cursor)
        const nul = raw.indexOf(0x00, space)
        entries.push({
          mode: raw.toString('latin1', cursor, space),
          name: raw.toString('utf8', space + 1, nul),
          id: raw.toString('hex', nul + 1, nul + 21),
        })
        cursor = nul + 21
      }
      trees.set(id, entries)
    }
    at = end + 1
  }
  return trees
}

/**
 * @param {number} number
 * @returns {string}
 */
export function padNumber(number) {
  return String(number).padStart(4, '0')
}

/**
 * A claimant is carried by every branch cut since it landed, which on this repo
 * is over a hundred refs for one document. Naming them all buries the report the
 * reader has to act on, so the line names enough to locate it and counts the rest.
 *
 * @param {string[]} refs
 * @returns {string}
 */
function describeRefs(refs) {
  if (refs.length <= MAX_REFS_SHOWN) return refs.join(', ')
  return `${refs.slice(0, MAX_REFS_SHOWN).join(', ')} and ${refs.length - MAX_REFS_SHOWN} more`
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
    for (const claimant of claimants) lines.push(`    ${claimant.file}  on ${describeRefs(claimant.refs)}`)
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
  const partial = partialScan(repoRoot)
  if (partial === NOT_A_CHECKOUT) {
    writeError(`${repoRoot} is ${partial}. Mint by hand from max(llp/) + 1, and say that you did.\n`)
    return 2
  }
  if (partial !== null) {
    const remedy = REMEDY.get(partial) ?? 'git fetch --prune'
    // `check` refuses rather than warns: a gate whose failure mode is a silent
    // pass is the defect of issue #907 again, one layer up. A job that loses its
    // `fetch-depth: 0` would go green having compared one ref against itself.
    if (mode === 'check') {
      writeError(`this is ${partial}. The check would pass without looking, so it refuses instead. Run \`${remedy}\`, or run it where the whole corpus is.\n`)
      return 2
    }
    writeError(`warning: this is ${partial}. Run \`${remedy}\`, or this answer is a guess.\n`)
  }
  const refFiles = scanRefFiles(repoRoot)
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
  if (minted.mergeBase === null) {
    writeError(`no common ancestor with ${minted.base}, so what this branch mints cannot be told from what it inherited\n`)
    return 0
  }
  const superseded = supersededRefs(repoRoot)
  const rivals = new Map([...refFiles].filter(([ref]) => !superseded.has(ref)))
  const found = collisions(rivals, minted.numbers)
  if (found.length === 0) {
    write(`${minted.numbers.size} LLP number${minted.numbers.size === 1 ? '' : 's'} minted against ${minted.base}, no collision\n`)
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
