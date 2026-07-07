// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseHypignore,
  createUsagePolicyResolver,
  findRepoRoot,
  LocalOnlyListUnreadableError,
} from '../../src/core/usage-policy/index.js'

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

test('parseHypignore: implemented `local-only` token resolves to local-only, no warn (LLP 0070)', () => {
  const result = parseHypignore('local-only\n')
  assert.equal(result.class, 'local-only')
  assert.equal(result.declared, 'local-only')
  assert.equal(result.warn, undefined)
})

test('parseHypignore: a still-unimplemented token => ignore + warn (fail-safe)', () => {
  const result = parseHypignore('some-future-class\n')
  assert.equal(result.class, 'ignore')
  assert.equal(result.declared, 'some-future-class')
  assert.match(String(result.warn), /some-future-class/)
  assert.match(String(result.warn), /ignore/)
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

test('resolve: dotfile `local-only` token is honored (implemented, LLP 0070), not clamped to ignore', () => {
  const fs = fakeFs({ '/work/repo/.hypignore': 'local-only\n' })
  const resolver = createUsagePolicyResolver(fs)
  const result = resolver.resolve('/work/repo/sub')
  assert.equal(result.class, 'local-only')
  assert.equal(result.declared, 'local-only')
  assert.equal(result.governedBy, '/work/repo/.hypignore')
  assert.equal(result.warn, undefined)
})

test('resolve: a still-unimplemented class in a governing file fails safe to ignore', () => {
  const fs = fakeFs({ '/work/repo/.hypignore': 'some-future-class\n' })
  const resolver = createUsagePolicyResolver(fs)
  const result = resolver.resolve('/work/repo/sub')
  assert.equal(result.class, 'ignore')
  assert.equal(result.declared, 'some-future-class')
  assert.equal(result.governedBy, '/work/repo/.hypignore')
  assert.match(String(result.warn), /some-future-class/)
})

test('resolve: a present-but-unreadable .hypignore fails closed to ignore (privacy-protecting)', () => {
  // safeRead clamps a read error to an empty body, which the format parses as
  // `ignore`: an uninterpretable privacy signal must suppress, never record.
  // Without the try/catch this throws; with it the cwd resolves to `ignore`.
  const resolver = createUsagePolicyResolver({
    existsSync: () => true,
    readFileSync: () => { throw new Error('EACCES') },
  })
  const result = resolver.resolve('/work/repo/sub')
  assert.equal(result.class, 'ignore', 'an unreadable governing .hypignore must fail closed to ignore')
  assert.equal(result.governedBy, '/work/repo/sub/.hypignore', 'the nearest existing file governs')
  assert.equal(resolver.isIgnored('/work/repo/sub'), true)
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

test('resolve: a .hypignore written after a cwd was cached `full` is honored once the TTL elapses', () => {
  // The privacy-critical staleness direction (R1): a long-lived daemon
  // resolver must not keep recording a folder forever just because it cached
  // `full` before the user ran `hyp ignore`.
  const files = /** @type {Record<string, string>} */ ({})
  let clock = 1_000
  const resolver = createUsagePolicyResolver({
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => files[p] ?? '',
    now: () => clock,
    ttlMs: 5_000,
  })

  // First resolve: nothing governs => full, cached with a 5s expiry.
  assert.equal(resolver.resolve('/work/repo/sub').class, 'full')

  // User writes a .hypignore. Within the TTL the cached `full` still wins.
  files['/work/repo/.hypignore'] = 'ignore\n'
  clock += 1_000
  assert.equal(resolver.resolve('/work/repo/sub').class, 'full')

  // Once the entry expires, the walk re-runs and the new file is honored,
  // without a daemon restart.
  clock += 5_000
  assert.equal(resolver.resolve('/work/repo/sub').class, 'ignore')
  assert.equal(resolver.isIgnored('/work/repo/sub'), true)
})

test('resolve: removing a .hypignore is honored once the TTL elapses (unignore)', () => {
  // The inverse direction: after `hyp unignore` the subtree records again
  // within the TTL rather than staying suppressed until restart.
  const files = /** @type {Record<string, string>} */ ({ '/work/repo/.hypignore': 'ignore\n' })
  let clock = 1_000
  const resolver = createUsagePolicyResolver({
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => files[p] ?? '',
    now: () => clock,
    ttlMs: 5_000,
  })

  assert.equal(resolver.resolve('/work/repo/sub').class, 'ignore')

  delete files['/work/repo/.hypignore']
  clock += 5_001
  assert.equal(resolver.resolve('/work/repo/sub').class, 'full')
})

// --- matcher.js: local-only list as a second source (LLP 0070/0071) ------

const LIST_PATH = '/state/usage-policy/local-only.json'

/** @param {string[]} dirs */
function listFile(dirs) {
  return JSON.stringify({ version: 1, dirs })
}

test('resolve: no localOnlyListPath configured => resolver behaves exactly as before', () => {
  const fs = fakeFs({ '/work/repo/.hypignore': 'ignore\n' })
  const resolver = createUsagePolicyResolver(fs)
  assert.deepEqual(resolver.resolve('/work/repo/sub'), {
    class: 'ignore',
    governedBy: '/work/repo/.hypignore',
    declared: 'ignore',
  })
  assert.equal(resolver.resolve('/private/side-project').class, 'full')
})

test('resolve: cwd equal to a listed dir is local-only, governed by the list path', () => {
  const fs = fakeFs({ [LIST_PATH]: listFile(['/private/side-project']) })
  const resolver = createUsagePolicyResolver({ ...fs, localOnlyListPath: LIST_PATH })
  assert.deepEqual(resolver.resolve('/private/side-project'), {
    class: 'local-only',
    governedBy: LIST_PATH,
    declared: 'local-only',
  })
})

test('resolve: cwd descendant of a listed dir is local-only', () => {
  const fs = fakeFs({ [LIST_PATH]: listFile(['/private/side-project']) })
  const resolver = createUsagePolicyResolver({ ...fs, localOnlyListPath: LIST_PATH })
  const result = resolver.resolve('/private/side-project/nested/deep')
  assert.equal(result.class, 'local-only')
  assert.equal(result.governedBy, LIST_PATH)
})

test('resolve: sibling-prefix directory is NOT matched (segment-aware: /a/bc vs /a/b)', () => {
  const fs = fakeFs({ [LIST_PATH]: listFile(['/a/b']) })
  const resolver = createUsagePolicyResolver({ ...fs, localOnlyListPath: LIST_PATH })
  assert.equal(resolver.resolve('/a/bc').class, 'full', '/a/bc merely shares a string prefix with /a/b')
  assert.equal(resolver.resolve('/a/b').class, 'local-only')
  assert.equal(resolver.resolve('/a/b/c').class, 'local-only')
})

test('resolve: dotfile `ignore` beats a list `local-only` match (most-restrictive wins)', () => {
  const fs = fakeFs({
    '/work/repo/.hypignore': 'ignore\n',
    [LIST_PATH]: listFile(['/work/repo']),
  })
  const resolver = createUsagePolicyResolver({ ...fs, localOnlyListPath: LIST_PATH })
  const result = resolver.resolve('/work/repo/sub')
  assert.equal(result.class, 'ignore')
  assert.equal(result.governedBy, '/work/repo/.hypignore', 'the stronger dotfile source names the governor')
})

test('resolve: list `local-only` beats an unlisted `full` dotfile default (most-restrictive wins)', () => {
  const fs = fakeFs({ [LIST_PATH]: listFile(['/private/proj']) })
  const resolver = createUsagePolicyResolver({ ...fs, localOnlyListPath: LIST_PATH })
  const result = resolver.resolve('/private/proj')
  assert.equal(result.class, 'local-only')
  assert.equal(result.governedBy, LIST_PATH)
})

test('resolve: cwd not in the list and no governing dotfile => full', () => {
  const fs = fakeFs({ [LIST_PATH]: listFile(['/private/other']) })
  const resolver = createUsagePolicyResolver({ ...fs, localOnlyListPath: LIST_PATH })
  assert.equal(resolver.resolve('/somewhere/else').class, 'full')
})

test('resolve: a missing local-only list file is "no exclusions" ([])', () => {
  const fs = fakeFs({})
  const resolver = createUsagePolicyResolver({ ...fs, localOnlyListPath: LIST_PATH })
  assert.equal(resolver.resolve('/anywhere').class, 'full')
})

test('resolve: list parse is memoized (TTL) independent of per-cwd caching, and re-read picks up an edited list', () => {
  const files = /** @type {Record<string, string>} */ ({ [LIST_PATH]: listFile([]) })
  let clock = 1_000
  let listReads = 0
  const resolver = createUsagePolicyResolver({
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (p === LIST_PATH) listReads += 1
      return files[p] ?? ''
    },
    now: () => clock,
    ttlMs: 5_000,
    localOnlyListPath: LIST_PATH,
  })

  // First resolve of a fresh cwd against the (empty) list: does the first read.
  assert.equal(resolver.resolve('/private/proj-a').class, 'full')
  assert.equal(listReads, 1)

  // A second, distinct, never-before-seen cwd resolved in the same window
  // reuses the cached list parse rather than re-reading the file.
  assert.equal(resolver.resolve('/private/proj-b').class, 'full')
  assert.equal(listReads, 1)

  // The user edits the list mid-window (e.g. `hyp ignore --local-only`). A
  // third, still-unseen cwd resolved before the TTL elapses still sees the
  // stale, cached list.
  files[LIST_PATH] = listFile(['/private/proj-c'])
  clock += 1_000
  assert.equal(resolver.resolve('/private/proj-c').class, 'full')
  assert.equal(listReads, 1)

  // Once the TTL elapses the list is re-read and the edit is honored.
  clock += 5_000
  assert.equal(resolver.resolve('/private/proj-c').class, 'local-only')
  assert.equal(listReads, 2)
})

test('resolve: a corrupt local-only list throws, not silently "no exclusions" (fail-safe)', () => {
  const fs = fakeFs({ [LIST_PATH]: '{ not valid json' })
  const resolver = createUsagePolicyResolver({ ...fs, localOnlyListPath: LIST_PATH })
  assert.throws(
    () => resolver.resolve('/anything'),
    (err) => {
      assert.ok(err instanceof LocalOnlyListUnreadableError)
      assert.equal(err.error_kind, 'local_only_list_unreadable')
      assert.equal(err.filePath, LIST_PATH)
      return true
    }
  )
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
