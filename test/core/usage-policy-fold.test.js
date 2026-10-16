// @ts-check

// Regression tests for the path-spelling fold: `realpath(2)` folds symlinks
// and nothing else, so on a filesystem that treats two spellings of one
// directory as the same directory the shared gate compared two strings that
// differ and returned `full` for a directory the user opted out of (#483).
//
// **What these tests can and cannot prove on a Linux host.** The Unicode half
// is honest here: `String.prototype.normalize` is a pure function of the
// string, the two spellings are built as literals, and the assertion is that
// the *comparison logic* folds them together. That is the whole mechanism, and
// it is the half that actually bites, because the two paths being compared are
// produced by different processes at different times (a CLI resolving a mark
// versus a client reporting a `cwd`), so an NFC/NFD divergence between them is
// ordinary rather than user error.
//
// The case half is different. Whether a *volume* folds `Proj` and `proj` is a
// property of the filesystem, and ext4 does not, so the tests below drive the
// case-folding logic through an **injected** volume verdict. That covers the
// matcher's behaviour given a verdict; it does not and cannot cover the probe
// that produces the verdict on macOS. The probe is asserted only to be inert
// off darwin, which is the one thing this host can witness.
//
// @ref LLP 0050#normalization [tests]: folding is only ever additive restriction, and NFC divergence no longer opens the gate

import test from 'node:test'
import assert from 'node:assert/strict'

import { createUsagePolicyResolver } from '../../src/core/usage-policy/matcher.js'
import { createVolumeCaseProbe, foldPath, PATH_CASE_PROBE_ERROR_KIND } from '../../src/core/usage-policy/fold.js'

/**
 * @import { UsageClass, UsagePolicyResolver } from '../../src/core/usage-policy/types.js'
 */

// The same four characters, composed and decomposed. Spelled as \u escapes, so
// the source file is pure ASCII and an editor, a merge tool, or a `git` filter
// cannot silently re-normalize it. Re-normalizing raw literals would collapse
// both constants to the same string and make every test below pass vacuously;
// escaping makes that unrepresentable rather than merely detectable, and the
// tripwire immediately below still asserts the premise for anyone who
// reintroduces raw characters.
const NFC = 'caf\u00e9'
const NFD = 'cafe\u0301'

// The premise the whole file rests on. If this ever fails, nothing after it
// means anything.
test('the two fixture spellings are genuinely different strings that NFC folds together', () => {
  assert.notEqual(NFC, NFD)
  assert.equal(NFD.normalize('NFC'), NFC)
  assert.equal(NFC.normalize('NFC'), NFC)
})

const LIST = '/state/usage-policy/local-only.json'

/**
 * A resolver over an in-memory machine-local list. No `.hypignore` exists, so
 * every verdict below comes from list membership, which is the comparison
 * under test.
 *
 * @param {readonly { dir: string, class: UsageClass }[]} entries
 * @param {{ caseInsensitiveVolume?: (dir: string) => boolean, logEvent?: (name: string, fields?: Record<string, unknown>) => void }} [deps]
 * @returns {UsagePolicyResolver}
 */
function resolverOver(entries, deps = {}) {
  const files = { [LIST]: JSON.stringify({ version: 2, entries }) }
  return createUsagePolicyResolver({
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => /** @type {Record<string, string>} */ (files)[p],
    localOnlyListPath: LIST,
    ...deps,
  })
}

// --- the leak: NFC/NFD divergence between two processes -------------------

test('resolve: a local-only entry declared NFC still governs a cwd that arrives NFD', () => {
  const r = resolverOver([{ dir: `/root/${NFC}/proj`, class: 'local-only' }])
  assert.equal(r.resolve(`/root/${NFD}/proj`).class, 'local-only')
})

test('resolve: an ignore entry declared NFD still governs a cwd that arrives NFC', () => {
  const r = resolverOver([{ dir: `/root/${NFD}`, class: 'ignore' }])
  assert.equal(r.resolve(`/root/${NFC}/proj/sub`).class, 'ignore')
  assert.equal(r.isIgnored(`/root/${NFC}/proj/sub`), true)
})

test('resolve: the fold is on the ancestor segment, not only the leaf', () => {
  // The divergent segment is an ancestor of the `cwd`, so the prefix test has
  // to survive folding across a `/` boundary.
  const r = resolverOver([{ dir: `/root/${NFD}/a/b`, class: 'local-only' }])
  assert.equal(r.resolve(`/root/${NFC}/a/b/c/d`).class, 'local-only')
})

// --- the fold must not merge across a path-segment boundary ---------------

test('foldPath distributes over the path separator, so a prefix test stays segment-aware', () => {
  for (const p of [`/root/${NFD}/a`, `/root/${NFC}/a`, '/plain/ascii/path', '/']) {
    const segments = p.split('/')
    assert.equal(foldPath(p), segments.map((s) => foldPath(s)).join('/'))
    assert.equal(foldPath(p, { caseInsensitive: true }), segments.map((s) => foldPath(s, { caseInsensitive: true })).join('/'))
  }
})

test('resolve: a sibling whose name merely shares a folded prefix is still NOT matched', () => {
  const r = resolverOver([{ dir: `/root/${NFC}`, class: 'ignore' }])
  assert.equal(r.resolve(`/root/${NFD}-other`).class, 'full')
  assert.equal(r.resolve(`/root/${NFC}xyz`).class, 'full')
})

// --- the property that keeps this from becoming a forwarding leak ---------

test('resolve: a carve-out that gains reach only by folding does not punch a hole in a broader restrictive entry', () => {
  // The analogue of the regression PR #482's round-1 review found: an argmax
  // over match depth discards verdicts, so a less restrictive entry that only
  // matches once folded can become the deepest match and displace a broader
  // restrictive entry that already governed. Without the two-pass rule this
  // resolves to `full` and the directory starts recording and forwarding.
  const r = resolverOver([
    { dir: '/root/real', class: 'ignore' },
    { dir: `/root/real/${NFC}`, class: 'full' },
  ])
  assert.equal(r.resolve(`/root/real/${NFD}/sub`).class, 'ignore')
  assert.equal(r.resolve(`/root/real/${NFD}`).class, 'ignore')
})

test('resolve: an entry that gains reach by folding overrides a shallower explicit full marker', () => {
  // The tightening direction, against an entry that already matched: LLP 0103's
  // explicit `full` marker governs `/root`, and the restrictive entry only
  // reaches `cwd` once folded. Nearest-governs then has to prefer the deeper
  // folded match, or an opted-out subtree keeps forwarding under the marker its
  // parent carries.
  const r = resolverOver([
    { dir: '/root', class: 'full' },
    { dir: `/root/${NFD}`, class: 'ignore' },
  ])
  assert.equal(r.resolve('/root/elsewhere').class, 'full')
  assert.equal(r.resolve(`/root/${NFC}/deep`).class, 'ignore')
})

test('resolve: a carve-out declared in the same spelling as the entry it carves out of is still honored', () => {
  // The positive half: the two-pass rule must not over-restrict a legitimate
  // nested loosening, only one that crosses spellings.
  const r = resolverOver([
    { dir: '/root/real', class: 'ignore' },
    { dir: `/root/real/${NFC}`, class: 'full' },
  ])
  assert.equal(r.resolve(`/root/real/${NFC}/sub`).class, 'full')
})

test('resolve: nearest-governs is measured on the folded spelling, not on the declared one', () => {
  // NFD is *longer in code units* than NFC for the same name, so a depth
  // measured on the declared string can rank a decomposed ancestor above a
  // composed descendant and invert nearest-governs. Five accented characters
  // is enough: the outer entry is 16 code units decomposed against the inner
  // entry's 14 composed, but 11 against 14 once both are folded.
  const outer = '\u00e9\u00e9\u00e9\u00e9\u00e9'
  const outerNfd = outer.normalize('NFD')
  assert.ok(`/root/${outerNfd}`.length > `/root/${outer}/ab`.length)
  const r = resolverOver([
    { dir: `/root/${outerNfd}`, class: 'ignore' },
    { dir: `/root/${outer}/ab`, class: 'full' },
  ])
  assert.equal(r.resolve(`/root/${outer}/ab/deep`).class, 'full')
  // ...and the outer entry still governs everything the carve-out does not.
  assert.equal(r.resolve(`/root/${outer}/other`).class, 'ignore')
})

test('resolve: folding never loosens, over every arrangement of a nested pair', () => {
  // Exhaustive rather than illustrative: for every pair of classes and every
  // assignment of spellings to the outer and inner entry, the folded verdict is
  // at least as restrictive as the verdict the declared spellings alone give.
  const RANK = { ignore: 2, 'local-only': 1, full: 0 }
  const classes = /** @type {const} */ (['ignore', 'local-only', 'full'])
  const spellings = [NFC, NFD]
  for (const outerClass of classes) {
    for (const innerClass of classes) {
      for (const outerSpelling of spellings) {
        for (const innerSpelling of spellings) {
          for (const cwdSpelling of spellings) {
            const entries = [
              { dir: `/root/${outerSpelling}`, class: outerClass },
              { dir: `/root/${innerSpelling}/inner`, class: innerClass },
            ]
            const cwd = `/root/${cwdSpelling}/inner/deep`
            const folded = resolverOver(entries).resolve(cwd).class
            // The pre-fold answer, computed here from the same fixture by the
            // plain string rule the matcher used before this change.
            const preFold = declaredOnlyVerdict(entries, cwd)
            assert.ok(
              RANK[folded] >= RANK[preFold],
              `folded ${folded} is looser than pre-fold ${preFold} for outer=${outerClass} inner=${innerClass}`
            )
          }
        }
      }
    }
  }
})

/**
 * The pre-fold rule, reimplemented from `master`: longest matching declared
 * `dir` wins, ties broken by the more restrictive class, nothing matching means
 * `full`.
 *
 * @param {readonly { dir: string, class: 'ignore' | 'local-only' | 'full' }[]} entries
 * @param {string} cwd
 * @returns {'ignore' | 'local-only' | 'full'}
 */
function declaredOnlyVerdict(entries, cwd) {
  const RANK = { ignore: 2, 'local-only': 1, full: 0 }
  const matches = entries.filter((e) => cwd === e.dir || cwd.startsWith(e.dir + '/'))
  if (matches.length === 0) return 'full'
  return matches.reduce((best, e) => {
    if (e.dir.length > best.dir.length) return e
    if (e.dir.length === best.dir.length && RANK[e.class] > RANK[best.class]) return e
    return best
  }).class
}

// --- the case half, over an injected volume verdict -----------------------

test('resolve: case is NOT folded by default, because this volume is case-sensitive', () => {
  // The correctness bug in the other direction: on Linux and on a
  // case-sensitive APFS volume `Proj` and `proj` are genuinely two
  // directories, and folding them would over-restrict.
  const r = resolverOver([{ dir: '/root/Proj', class: 'ignore' }])
  assert.equal(r.resolve('/root/proj').class, 'full')
})

test('resolve: case IS folded when the volume verdict says the volume is case-insensitive', () => {
  const r = resolverOver([{ dir: '/root/Proj', class: 'local-only' }], { caseInsensitiveVolume: () => true })
  assert.equal(r.resolve('/root/proj/sub').class, 'local-only')
})

test('resolve: a case-insensitive volume verdict still does not let a carve-out loosen a broader entry', () => {
  const r = resolverOver(
    [
      { dir: '/root/real', class: 'ignore' },
      { dir: '/root/real/Proj', class: 'full' },
    ],
    { caseInsensitiveVolume: () => true }
  )
  assert.equal(r.resolve('/root/real/proj/sub').class, 'ignore')
})

test('resolve: the case verdict is asked per entry, so a per-volume answer applies per entry', () => {
  /** @type {string[]} */
  const asked = []
  const r = resolverOver(
    [
      { dir: '/insensitive/A', class: 'ignore' },
      { dir: '/sensitive/B', class: 'ignore' },
    ],
    {
      caseInsensitiveVolume: (dir) => {
        asked.push(dir)
        return dir.startsWith('/insensitive/')
      },
    }
  )
  assert.equal(r.resolve('/insensitive/a').class, 'ignore')
  assert.equal(r.resolve('/sensitive/b').class, 'full')
  assert.deepEqual(asked, ['/insensitive/A', '/sensitive/B'])
})

// --- the probe itself ------------------------------------------------------

test('createVolumeCaseProbe is inert off darwin: constant false, and it issues no syscall', () => {
  // The only claim about the probe this host can witness. Its darwin behaviour
  // is not exercised anywhere in this suite and is not verified by it.
  let statCalls = 0
  const probe = createVolumeCaseProbe({
    platform: 'linux',
    statSync: () => {
      statCalls += 1
      return { dev: 1, ino: 1 }
    },
  })
  assert.equal(probe('/root/Proj'), false)
  assert.equal(probe('/anything'), false)
  assert.equal(statCalls, 0)
})

test('createVolumeCaseProbe memoizes a definite verdict per volume, not per path', () => {
  /** @type {string[]} */
  const statted = []
  const probe = createVolumeCaseProbe({
    platform: 'darwin',
    statSync: (p) => {
      statted.push(p)
      // One volume (dev 7) where every spelling names the same inode.
      return { dev: 7, ino: 42 }
    },
  })
  assert.equal(probe('/vol/Proj'), true)
  assert.equal(probe('/vol/Other'), true)
  assert.equal(probe('/vol/deep/Nested'), true)
  // Two stats for the first path (the path and its case-flipped spelling), then
  // one per later path to learn its `dev`, and no second probe of the volume.
  assert.deepEqual(statted, ['/vol/Proj', '/vol/pROJ', '/vol/Other', '/vol/deep/Nested'])
})

test('createVolumeCaseProbe does not memoize an undetermined answer as the volume verdict', () => {
  // A directory whose name has no cased character (`/vol/123`) admits no probe,
  // but that says nothing about the volume. Caching the fallback would let one
  // such path decide the verdict for every other path on the same disk.
  const probe = createVolumeCaseProbe({
    platform: 'darwin',
    statSync: () => ({ dev: 7, ino: 42 }),
  })
  assert.equal(probe('/vol/123'), false)
  assert.equal(probe('/vol/Proj'), true)
})

test('createVolumeCaseProbe does not memoize a non-ENOENT failure of the flipped stat', () => {
  // The other undetermined branch, and the one that actually bites on a real
  // volume: the directory itself stats fine, but the case-flipped spelling
  // fails with something that is *not* `ENOENT` (`EACCES` on a directory the
  // daemon may not traverse, `EIO` on a flaky mount). `ENOENT` would be
  // informative, since it means the flipped spelling does not resolve and the
  // volume is therefore case-sensitive. Any other errno says nothing at all, so
  // caching it would let one transient error disable case folding for every
  // path on that disk for the life of the resolver, silently reopening the gap
  // this module exists to close.
  let flippedFails = true
  const probe = createVolumeCaseProbe({
    platform: 'darwin',
    statSync: (p) => {
      if (p === '/vol/Proj' || p === '/vol/Other') return { dev: 7, ino: 42 }
      if (flippedFails) {
        const err = /** @type {Error & { code: string }} */ (new Error('EACCES'))
        err.code = 'EACCES'
        throw err
      }
      return { dev: 7, ino: 42 }
    },
    logSkip: () => {},
  })
  assert.equal(probe('/vol/Proj'), false)
  // The volume verdict must still be open, so a later probe of the same `dev`
  // that *can* reach an answer is believed rather than served the stale `false`.
  flippedFails = false
  assert.equal(probe('/vol/Other'), true)
})

test('createVolumeCaseProbe reports case-sensitive when the flipped spelling does not exist', () => {
  const probe = createVolumeCaseProbe({
    platform: 'darwin',
    statSync: (p) => {
      if (p === '/vol/Proj') return { dev: 7, ino: 42 }
      const err = /** @type {Error & { code: string }} */ (new Error('ENOENT'))
      err.code = 'ENOENT'
      throw err
    },
  })
  assert.equal(probe('/vol/Proj'), false)
})

test('createVolumeCaseProbe fails toward the pre-fold behaviour and logs a hashed skip', () => {
  /** @type {{ name: string, fields: Record<string, unknown> }[]} */
  const events = []
  const probe = createVolumeCaseProbe({
    platform: 'darwin',
    statSync: () => {
      const err = /** @type {Error & { code: string }} */ (new Error('EACCES'))
      err.code = 'EACCES'
      throw err
    },
    logSkip: (name, fields) => events.push({ name, fields: fields ?? {} }),
  })
  assert.equal(probe('/vol/Secret'), false)
  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'usage_policy.case_probe_skipped')
  assert.equal(events[0].fields.error_kind, PATH_CASE_PROBE_ERROR_KIND)
  assert.equal(events[0].fields.status, 'skipped')
  assert.equal(events[0].fields.errno, 'eacces')
  assert.match(String(events[0].fields.path_hash), /^[0-9a-f]{16}$/)
  // The raw path never appears in any attribute value.
  for (const value of Object.values(events[0].fields)) {
    assert.ok(!String(value).includes('Secret'), `raw path leaked in ${String(value)}`)
  }
})

// --- the structured signal on the hot path --------------------------------

test('resolve emits a hashed usage_policy.fold_tightened only when folding changed the verdict', () => {
  /** @type {{ name: string, fields: Record<string, unknown> }[]} */
  const events = []
  const r = resolverOver([{ dir: `/root/${NFC}`, class: 'local-only' }], {
    logEvent: (name, fields) => events.push({ name, fields: fields ?? {} }),
  })

  // Only the fold signal is under test, and it is the only event this resolver
  // emits that is a pure function of the fixture. The real case probe is also
  // live here (no `caseInsensitiveVolume` is injected), and on darwin it stats
  // a fixture path that does not exist and reports
  // `usage_policy.case_probe_skipped`. Counting *every* event would make the
  // assertion pass on ext4 and fail on APFS for a reason this test is not
  // about, so the counts below are over the fold events alone.
  const folds = () => events.filter((e) => e.name === 'usage_policy.fold_tightened')

  // Same spelling: nothing to report.
  assert.equal(r.resolve(`/root/${NFC}/a`).class, 'local-only')
  assert.equal(folds().length, 0)

  // Divergent spelling: the fold is what produced the restriction.
  assert.equal(r.resolve(`/root/${NFD}/a`).class, 'local-only')
  assert.equal(folds().length, 1)
  const fold = folds()[0]
  assert.equal(fold.fields.hyp_operation, 'match_list')
  assert.equal(fold.fields.declared_class, 'none')
  assert.equal(fold.fields.folded_class, 'local-only')
  assert.match(String(fold.fields.cwd_hash), /^[0-9a-f]{16}$/)
  for (const value of Object.values(fold.fields)) {
    assert.ok(!String(value).includes('caf'), `raw path leaked in ${String(value)}`)
  }

  // An unrelated cwd nothing governs: still nothing to report.
  events.length = 0
  assert.equal(r.resolve('/elsewhere').class, 'full')
  assert.equal(folds().length, 0)
})

// --- the hot path stays memoized on the lexical key -----------------------

test('resolve: folding happens on the cache miss only, so a repeated cwd re-reads nothing', () => {
  let listReads = 0
  let caseVerdicts = 0
  const files = { [LIST]: JSON.stringify({ version: 2, entries: [{ dir: `/root/${NFC}`, class: 'ignore' }] }) }
  const r = createUsagePolicyResolver({
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      listReads += 1
      return /** @type {Record<string, string>} */ (files)[p]
    },
    localOnlyListPath: LIST,
    caseInsensitiveVolume: () => {
      caseVerdicts += 1
      return false
    },
    now: () => 1000,
  })
  for (let i = 0; i < 50; i += 1) assert.equal(r.resolve(`/root/${NFD}/a`).class, 'ignore')
  assert.equal(listReads, 1)
  assert.equal(caseVerdicts, 1)
})
