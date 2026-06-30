// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseHypignore, createUsagePolicyResolver, findRepoRoot } from '../../src/core/usage-policy/index.js'

// --- format.js: parseHypignore -------------------------------------------

test('parseHypignore: empty body => ignore (the empty-file opt-out)', () => {
  const result = parseHypignore('')
  assert.equal(result.class, 'ignore')
  assert.equal(result.declared, null)
  assert.equal(result.warn, undefined)
})

test('parseHypignore: comment-only/blank body => ignore', () => {
  const result = parseHypignore('# just a note\n\n   \n#another\n')
  assert.equal(result.class, 'ignore')
  assert.equal(result.declared, null)
  assert.equal(result.warn, undefined)
})

test('parseHypignore: recognized `ignore` token => ignore, no warn', () => {
  const result = parseHypignore('# header\nignore\n')
  assert.equal(result.class, 'ignore')
  assert.equal(result.declared, 'ignore')
  assert.equal(result.warn, undefined)
})

test('parseHypignore: unknown token => ignore + warn (fail-safe)', () => {
  const result = parseHypignore('mystery-class\n')
  assert.equal(result.class, 'ignore')
  assert.equal(result.declared, 'mystery-class')
  assert.match(String(result.warn), /mystery-class/)
  assert.match(String(result.warn), /ignore/)
})

test('parseHypignore: reserved `local-only` => ignore + warn in V1 (fail-safe)', () => {
  const result = parseHypignore('local-only\n')
  assert.equal(result.class, 'ignore')
  assert.equal(result.declared, 'local-only')
  assert.match(String(result.warn), /local-only/)
})

test('parseHypignore: first token wins; trailing path patterns are parsed-but-ignored', () => {
  const result = parseHypignore('ignore   secrets/\n# trailing comment\n')
  assert.equal(result.class, 'ignore')
  assert.equal(result.declared, 'ignore')
})

// --- matcher.js: createUsagePolicyResolver -------------------------------

/**
 * Build an injectable fs over a fixed map of `.hypignore` file -> contents.
 * Tracks read counts so the cache can be asserted.
 *
 * @param {Record<string, string>} files
 */
function fakeFs(files) {
  const reads = /** @type {Record<string, number>} */ ({})
  return {
    reads,
    /** @param {string} p */
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    /** @param {string} p */
    readFileSync: (p) => {
      reads[p] = (reads[p] ?? 0) + 1
      return files[p] ?? ''
    },
  }
}

test('resolve: no .hypignore anywhere => full, governedBy null', () => {
  const fs = fakeFs({})
  const resolver = createUsagePolicyResolver(fs)
  const result = resolver.resolve('/work/repo/sub')
  assert.equal(result.class, 'full')
  assert.equal(result.governedBy, null)
  assert.equal(result.declared, null)
  assert.equal(resolver.isIgnored('/work/repo/sub'), false)
})

test('resolve: nearest ancestor .hypignore wins', () => {
  const fs = fakeFs({
    '/work/repo/.hypignore': '',
    '/work/repo/sub/.hypignore': 'ignore\n',
  })
  const resolver = createUsagePolicyResolver(fs)

  const deep = resolver.resolve('/work/repo/sub/deeper/leaf')
  assert.equal(deep.class, 'ignore')
  assert.equal(deep.governedBy, '/work/repo/sub/.hypignore')

  const shallow = resolver.resolve('/work/repo/other')
  assert.equal(shallow.class, 'ignore')
  assert.equal(shallow.governedBy, '/work/repo/.hypignore')
})

test('resolve: walks all the way to the filesystem root', () => {
  const fs = fakeFs({ '/.hypignore': 'ignore\n' })
  const resolver = createUsagePolicyResolver(fs)
  const result = resolver.resolve('/a/b/c/d/e')
  assert.equal(result.class, 'ignore')
  assert.equal(result.governedBy, '/.hypignore')
})

test('resolve: unimplemented class in a governing file fails safe to ignore', () => {
  const fs = fakeFs({ '/work/repo/.hypignore': 'local-only\n' })
  const resolver = createUsagePolicyResolver(fs)
  const result = resolver.resolve('/work/repo/sub')
  assert.equal(result.class, 'ignore')
  assert.equal(result.declared, 'local-only')
  assert.equal(result.governedBy, '/work/repo/.hypignore')
})

test('resolve: per-cwd cache is stable and reads the file once', () => {
  const fs = fakeFs({ '/work/repo/.hypignore': 'ignore\n' })
  const resolver = createUsagePolicyResolver(fs)

  const first = resolver.resolve('/work/repo/sub')
  const second = resolver.resolve('/work/repo/sub')
  assert.equal(first, second) // same memoized object
  assert.deepEqual(first, { class: 'ignore', governedBy: '/work/repo/.hypignore', declared: 'ignore' })
  assert.equal(fs.reads['/work/repo/.hypignore'], 1)

  // isIgnored shares the same cache: still one read.
  assert.equal(resolver.isIgnored('/work/repo/sub'), true)
  assert.equal(fs.reads['/work/repo/.hypignore'], 1)
})

test('resolve: relative cwd is normalized before caching', () => {
  const fs = fakeFs({})
  const resolver = createUsagePolicyResolver(fs)
  // Should not throw and should resolve against an absolute key.
  const result = resolver.resolve('.')
  assert.equal(result.class, 'full')
})

test('createUsagePolicyResolver defaults fs to node:fs when none injected', () => {
  // A directory tree with no .hypignore resolves to full without throwing.
  const resolver = createUsagePolicyResolver()
  const result = resolver.resolve(process.cwd())
  assert.ok(result.class === 'full' || result.class === 'ignore')
  assert.equal(typeof resolver.isIgnored(process.cwd()), 'boolean')
})

// --- repo_root.js: findRepoRoot ------------------------------------------

/** @param {string[]} present Absolute paths existsSync should report true for. */
function fakeExistsFs(present) {
  const set = new Set(present)
  return { existsSync: (/** @type {string} */ p) => set.has(p) }
}

test('findRepoRoot: nearest ancestor with a .git entry is the repo root', () => {
  const fs = fakeExistsFs(['/work/repo/.git'])
  assert.equal(findRepoRoot('/work/repo/src/deep', fs), '/work/repo')
})

test('findRepoRoot: the start dir itself can be the repo root', () => {
  const fs = fakeExistsFs(['/work/repo/.git'])
  assert.equal(findRepoRoot('/work/repo', fs), '/work/repo')
})

test('findRepoRoot: returns null when no ancestor has a .git', () => {
  const fs = fakeExistsFs([])
  assert.equal(findRepoRoot('/work/repo/src', fs), null)
})

test('findRepoRoot: defaults fs to node:fs without throwing', () => {
  const result = findRepoRoot(process.cwd())
  assert.ok(result === null || typeof result === 'string')
})
