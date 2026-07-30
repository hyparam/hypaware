// @ts-check

// Regression suite for the symlink escape (issue #479). `path.resolve` is
// lexical, so a string-only test can pass while the real filesystem leaks:
// every case below builds a genuine `symlink(2)` with `node:fs` and drives the
// real `node:fs` reader, no injection.
//
// @ref LLP 0050#canonicalization [tests]: an ignored directory reached by a symlink is still ignored, and a machine-local entry declared by either spelling still governs

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  canonicalizeDirSync,
  createUsagePolicyResolver,
  sameDirectory,
  scopeGoverns,
} from '../../src/core/usage-policy/index.js'

/**
 * A canonical temp root: `mkdtemp` hands back `/var/folders/...` on macOS,
 * whose `/var` is itself a symlink, so the fixtures below canonicalize their
 * own root first and introduce exactly one symlink of their own.
 *
 * @returns {string}
 */
function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-usage-policy-symlink-'))
  const root = fs.realpathSync(dir)
  test.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

/**
 * @param {string} root
 * @param {string} listPath
 * @param {readonly { dir: string, class: 'ignore' | 'local-only' | 'full' }[]} entries
 */
function writeList(root, listPath, entries) {
  fs.mkdirSync(path.dirname(listPath), { recursive: true })
  fs.writeFileSync(listPath, JSON.stringify({ version: 2, entries }))
}

test('resolve: an ignored directory reached by its symlink spelling is still ignored', () => {
  const root = tempRoot()
  const real = path.join(root, 'work', 'ignored', 'a', 'b', 'c')
  fs.mkdirSync(real, { recursive: true })
  fs.writeFileSync(path.join(root, 'work', 'ignored', '.hypignore'), 'ignore\n')
  fs.mkdirSync(path.join(root, 'home', 'me'), { recursive: true })
  const link = path.join(root, 'home', 'me', 'link')
  fs.symlinkSync(real, link)

  const resolver = createUsagePolicyResolver()
  assert.equal(resolver.resolve(real).class, 'ignore', 'the canonical spelling was never in doubt')
  const viaLink = resolver.resolve(link)
  assert.equal(viaLink.class, 'ignore', 'the symlink spelling denotes the same ignored directory')
  assert.equal(viaLink.governedBy, path.join(root, 'work', 'ignored', '.hypignore'))
  assert.equal(resolver.isIgnored(link), true)
})

test('resolve: a descendant of a symlink that points into an ignored tree is ignored', () => {
  const root = tempRoot()
  // The link points *below* the governing file, so the lexical walk from
  // `link/b/c` climbs out of the ignored tree without ever meeting it. (A link
  // that points *at* the governing directory leaks nothing even on master:
  // `existsSync` follows symlinks, so `link/.hypignore` is a real hit.)
  fs.mkdirSync(path.join(root, 'work', 'ignored', 'a', 'b', 'c'), { recursive: true })
  fs.writeFileSync(path.join(root, 'work', 'ignored', '.hypignore'), 'ignore\n')
  const link = path.join(root, 'link')
  fs.symlinkSync(path.join(root, 'work', 'ignored', 'a'), link)

  const resolver = createUsagePolicyResolver()
  assert.equal(resolver.resolve(path.join(link, 'b', 'c')).class, 'ignore')
})

test('resolve: a `.hypignore` governing the symlink\'s own ancestors still governs (the converse spelling is not lost)', () => {
  const root = tempRoot()
  // The `.hypignore` sits above the *link*, not above the link's target: the
  // one-sided "canonicalize the incoming cwd" patch throws this verdict away.
  const real = path.join(root, 'work', 'proj')
  fs.mkdirSync(real, { recursive: true })
  fs.mkdirSync(path.join(root, 'private'), { recursive: true })
  fs.writeFileSync(path.join(root, 'private', '.hypignore'), 'ignore\n')
  const link = path.join(root, 'private', 'link')
  fs.symlinkSync(real, link)

  const resolver = createUsagePolicyResolver()
  const viaLink = resolver.resolve(link)
  assert.equal(viaLink.class, 'ignore', 'the as-given spelling is under an ignored tree')
  assert.equal(viaLink.governedBy, path.join(root, 'private', '.hypignore'))
})

test('resolve: a local-only entry declared by its symlink spelling governs the real directory', () => {
  const root = tempRoot()
  const real = path.join(root, 'real', 'proj')
  fs.mkdirSync(real, { recursive: true })
  const link = path.join(root, 'plink')
  fs.symlinkSync(real, link)
  const listPath = path.join(root, 'state', 'usage-policy', 'local-only.json')
  writeList(root, listPath, [{ dir: link, class: 'local-only' }])

  const resolver = createUsagePolicyResolver({ localOnlyListPath: listPath })
  assert.equal(resolver.resolve(link).class, 'local-only', 'the spelling the user typed still governs')
  const viaReal = resolver.resolve(real)
  assert.equal(viaReal.class, 'local-only', 'so does the directory it denotes')
  assert.equal(viaReal.governedBy, listPath)
  assert.equal(resolver.resolve(path.join(real, 'nested')).class, 'local-only')
})

test('resolve: a local-only entry declared canonically governs a cwd that arrives by symlink', () => {
  const root = tempRoot()
  const real = path.join(root, 'real', 'proj')
  fs.mkdirSync(real, { recursive: true })
  const link = path.join(root, 'plink')
  fs.symlinkSync(real, link)
  const listPath = path.join(root, 'state', 'usage-policy', 'local-only.json')
  writeList(root, listPath, [{ dir: real, class: 'local-only' }])

  const resolver = createUsagePolicyResolver({ localOnlyListPath: listPath })
  assert.equal(resolver.resolve(real).class, 'local-only')
  assert.equal(resolver.resolve(link).class, 'local-only')
  assert.equal(resolver.resolve(path.join(link, 'nested')).class, 'local-only')
})

test('resolve: nested entries keep nearest-governs when the outer one matched by its canonical spelling', () => {
  const root = tempRoot()
  const real = path.join(root, 'real')
  fs.mkdirSync(path.join(real, 'public', 'deep'), { recursive: true })
  fs.mkdirSync(path.join(real, 'private'), { recursive: true })
  const link = path.join(root, 'link')
  fs.symlinkSync(real, link)
  const listPath = path.join(root, 'state', 'usage-policy', 'local-only.json')
  // The outer entry was declared by the symlink spelling, the inner one by the
  // real one: specificity has to be measured on the spelling that matched.
  writeList(root, listPath, [
    { dir: link, class: 'local-only' },
    { dir: path.join(real, 'public'), class: 'full' },
  ])

  const resolver = createUsagePolicyResolver({ localOnlyListPath: listPath })
  assert.equal(resolver.resolve(path.join(real, 'private')).class, 'local-only')
  assert.equal(resolver.resolve(path.join(real, 'public', 'deep')).class, 'full', 'the inner entry is more specific')
  // Reached by the *other* spelling, the inner carve-out does not apply (it was
  // declared under the real path, and `link/public/deep` is not lexically under
  // it), so only the outer `local-only` entry governs that spelling. Across
  // spellings the gate keeps the more restrictive verdict, so a nested
  // loosening declared under one spelling never loosens the other. Documented
  // as a consequence of most-restrictive-wins, not an accident.
  assert.equal(resolver.resolve(path.join(link, 'public', 'deep')).class, 'local-only')
})

test('resolve: a symlinked cwd is still not matched by a mere string-prefix sibling (segment-aware after canonicalization)', () => {
  const root = tempRoot()
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
  fs.mkdirSync(path.join(root, 'a', 'bc'), { recursive: true })
  const link = path.join(root, 'link-bc')
  fs.symlinkSync(path.join(root, 'a', 'bc'), link)
  const listPath = path.join(root, 'state', 'usage-policy', 'local-only.json')
  writeList(root, listPath, [{ dir: path.join(root, 'a', 'b'), class: 'local-only' }])

  const resolver = createUsagePolicyResolver({ localOnlyListPath: listPath })
  assert.equal(resolver.resolve(link).class, 'full', '/a/bc merely shares a string prefix with /a/b')
  assert.equal(resolver.resolve(path.join(root, 'a', 'b')).class, 'local-only')
})

test('resolve: a list entry whose declared target has been deleted keeps governing its declared spelling', () => {
  const root = tempRoot()
  const gone = path.join(root, 'gone', 'proj')
  const listPath = path.join(root, 'state', 'usage-policy', 'local-only.json')
  writeList(root, listPath, [{ dir: gone, class: 'ignore' }])

  const resolver = createUsagePolicyResolver({ localOnlyListPath: listPath })
  const result = resolver.resolve(gone)
  assert.equal(result.class, 'ignore', 'canonicalization failed on both sides; the declaration still stands')
  assert.equal(result.governedBy, listPath)
})

test('resolve: an unresolvable cwd under a symlinked ancestor still meets the .hypignore governing its real tree', () => {
  const root = tempRoot()
  fs.mkdirSync(path.join(root, 'work', 'ignored', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(root, 'work', 'ignored', '.hypignore'), 'ignore\n')
  const link = path.join(root, 'link')
  fs.symlinkSync(path.join(root, 'work', 'ignored', 'deep'), link)

  // `realpath` on the whole path throws ENOENT: the leaf does not exist. The
  // partial canonicalization keeps the resolvable ancestors, which is where the
  // symlink was, so the walk still meets the governing file above the target.
  const resolver = createUsagePolicyResolver()
  assert.equal(resolver.resolve(path.join(link, 'not-created-yet')).class, 'ignore')
})

test('resolve: canonicalization costs one realpath per cwd per TTL window, not one per call', () => {
  const root = tempRoot()
  const real = path.join(root, 'proj')
  fs.mkdirSync(real, { recursive: true })
  let realpathCalls = 0
  let clock = 1_000
  const resolver = createUsagePolicyResolver({
    realpathSync: (p) => {
      realpathCalls += 1
      return fs.realpathSync(p)
    },
    now: () => clock,
    ttlMs: 5_000,
  })

  for (let i = 0; i < 50; i++) assert.equal(resolver.resolve(real).class, 'full')
  assert.equal(realpathCalls, 1, 'the per-cwd cache is consulted before any canonicalization')

  clock += 5_001
  assert.equal(resolver.resolve(real).class, 'full')
  assert.equal(realpathCalls, 2, 'and re-canonicalizes exactly once when the entry expires')
})

test('canonicalizeDirSync: full, partial, and unresolvable outcomes', () => {
  const root = tempRoot()
  const real = path.join(root, 'work', 'proj')
  fs.mkdirSync(real, { recursive: true })
  const link = path.join(root, 'link')
  fs.symlinkSync(path.join(root, 'work'), link)

  const full = canonicalizeDirSync(path.join(link, 'proj'))
  assert.deepEqual(full, { path: real, resolved: 'full', errno: null })

  const partial = canonicalizeDirSync(path.join(link, 'proj', 'a', 'b'))
  assert.equal(partial.path, path.join(real, 'a', 'b'), 'the resolvable prefix is canonicalized, the tail rejoined')
  assert.equal(partial.resolved, 'partial')
  assert.equal(partial.errno, 'enoent')

  const unresolvable = canonicalizeDirSync(path.join(root, 'nope'), {
    realpathSync: () => {
      throw Object.assign(new Error('boom'), { code: 'EACCES' })
    },
  })
  assert.deepEqual(unresolvable, { path: path.join(root, 'nope'), resolved: 'none', errno: 'eacces' })
})

test('scopeGoverns / sameDirectory: spelling-agnostic, still segment-aware', () => {
  const root = tempRoot()
  fs.mkdirSync(path.join(root, 'real', 'proj', 'nested'), { recursive: true })
  fs.mkdirSync(path.join(root, 'real', 'projx'), { recursive: true })
  const link = path.join(root, 'link')
  fs.symlinkSync(path.join(root, 'real', 'proj'), link)

  assert.equal(scopeGoverns(path.join(root, 'real', 'proj', 'nested'), link), true)
  assert.equal(scopeGoverns(path.join(link, 'nested'), path.join(root, 'real', 'proj')), true)
  assert.equal(scopeGoverns(path.join(root, 'real', 'projx'), link), false, 'sibling prefix is not a descendant')

  assert.equal(sameDirectory(link, path.join(root, 'real', 'proj')), true)
  assert.equal(sameDirectory(link, path.join(root, 'real', 'projx')), false)
  assert.equal(sameDirectory(path.join(root, 'gone-a'), path.join(root, 'gone-b')), false, 'neither side resolves')
})
