// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { purgeCache } from '../../src/core/cache/purge.js'
import { deleteMatchingRows } from '../../src/core/cache/iceberg/store.js'
import { appendRowsToSourceTable, readCursorSync } from '../../src/core/cache/partition.js'
import { resolveIcebergDir } from '../../src/core/cache/storage.js'
import { readRowsFromTable, scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { runPurge } from '../../src/core/commands/purge.js'
import { scopeGovernance, scopeGoverns } from '../../src/core/usage-policy/matcher.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { UsagePolicyResolver } from '../../src/core/usage-policy/types.js'
 */

// `hyp purge` (LLP 0104 / plan T3): the destructive verb. These tests cover
// the cache-layer row deletion (`purgeCache` / `deleteMatchingRows`) for each
// target shape, part_id + watermark integrity after a rewrite, and the CLI
// wrapper's target validation, confirmation gate, resurrection warning, and
// JSON output.

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'timestamp', type: 'STRING', nullable: true },
]

const REPO_A = '/home/u/repoA'
const REPO_A_SUB = '/home/u/repoA/sub'
const REPO_B = '/home/u/repoB'
const SECRET = '/home/u/secret'

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-purge-${prefix}-`))
}

/**
 * Seed a source-table `ai_gateway_messages` partition with a fixed row set
 * spanning several cwds and sessions.
 *
 * @param {string} cacheRoot
 * @param {Record<string, unknown>[]} [rows]
 */
async function seed(cacheRoot, rows) {
  const data = rows ?? [
    { session_id: 's1', cwd: REPO_A, part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
    { session_id: 's1', cwd: REPO_A_SUB, part_id: 'm2#0', timestamp: '2026-07-01T00:00:01Z' },
    { session_id: 's2', cwd: REPO_B, part_id: 'm3#0', timestamp: '2026-07-01T00:00:02Z' },
    { session_id: 's3', cwd: SECRET, part_id: 'm4#0', timestamp: '2026-07-01T00:00:03Z' },
  ]
  await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=claude'], COLUMNS, data)
}

/** @param {string} cacheRoot */
function partitionDir(cacheRoot) {
  return path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
}

/**
 * @param {string} cacheRoot
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function remainingRows(cacheRoot) {
  return readRowsFromTable(resolveIcebergDir(partitionDir(cacheRoot)))
}

/**
 * A usage-policy resolver stub keyed off substrings, so tests classify cwds
 * without touching the filesystem.
 *
 * @param {(cwd: string) => import('../../src/core/usage-policy/types.js').UsageClass} classOf
 * @returns {UsagePolicyResolver}
 */
function stubResolver(classOf) {
  return {
    resolve: (cwd) => ({ class: classOf(cwd), governedBy: null, declared: null }),
    isIgnored: (cwd) => classOf(cwd) === 'ignore',
  }
}

/* ------------------------------ purgeCache ------------------------------ */

test('purge subtree deletes rows equal-or-descendant, leaves siblings', async () => {
  const cacheRoot = await makeTmpDir('subtree')
  try {
    await seed(cacheRoot)
    const summary = await purgeCache({ cacheRoot, target: { kind: 'subtree', path: REPO_A } })
    assert.equal(summary.rowsDeleted, 2, 'REPO_A + REPO_A/sub')
    assert.equal(summary.partitionsAffected, 1)
    const rows = await remainingRows(cacheRoot)
    const parts = new Set(rows.map((r) => r.part_id))
    assert.deepEqual([...parts].sort(), ['m3#0', 'm4#0'])
    // Segment-aware: REPO_A/sub is under REPO_A, REPO_B is NOT.
    assert.ok(!parts.has('m1#0') && !parts.has('m2#0'))
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('purge subtree is segment-aware: /home/u/repoA does not match /home/u/repoA-other', async () => {
  const cacheRoot = await makeTmpDir('segment')
  try {
    await seed(cacheRoot, [
      { session_id: 's1', cwd: REPO_A, part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
      { session_id: 's2', cwd: '/home/u/repoA-other', part_id: 'm2#0', timestamp: '2026-07-01T00:00:01Z' },
    ])
    const summary = await purgeCache({ cacheRoot, target: { kind: 'subtree', path: REPO_A } })
    assert.equal(summary.rowsDeleted, 1)
    const rows = await remainingRows(cacheRoot)
    assert.deepEqual(rows.map((r) => r.part_id), ['m2#0'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0050#canonicalization [tests]: purge matches the directory, not the spelling the row happened to record
test('purge subtree matches a row recorded under a symlink spelling of the target', async () => {
  const cacheRoot = await makeTmpDir('symlink')
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-purge-projects-'))
  try {
    const root = await fs.realpath(projects)
    const real = path.join(root, 'real', 'proj')
    await fs.mkdir(real, { recursive: true })
    const link = path.join(root, 'link')
    await fs.symlink(real, link)
    await seed(cacheRoot, [
      // The capture seam recorded the `cwd` the client reported: the symlink.
      { session_id: 's1', cwd: path.join(link, 'sub'), part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
      { session_id: 's2', cwd: path.join(root, 'real', 'projx'), part_id: 'm2#0', timestamp: '2026-07-01T00:00:01Z' },
    ])
    // The user purges by the real path.
    const summary = await purgeCache({ cacheRoot, target: { kind: 'subtree', path: real } })
    assert.equal(summary.rowsDeleted, 1, 'the symlink-spelled row is in the purged subtree')
    const rows = await remainingRows(cacheRoot)
    assert.deepEqual(
      rows.map((r) => r.part_id),
      ['m2#0'],
      'the sibling-prefix directory is still not a descendant'
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(projects, { recursive: true, force: true })
  }
})

test('purge --session deletes only that session', async () => {
  const cacheRoot = await makeTmpDir('session')
  try {
    await seed(cacheRoot)
    const summary = await purgeCache({ cacheRoot, target: { kind: 'session', id: 's1' } })
    assert.equal(summary.rowsDeleted, 2)
    const rows = await remainingRows(cacheRoot)
    assert.deepEqual(rows.map((r) => r.session_id).sort(), ['s2', 's3'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('purge --ignored deletes only rows whose cwd resolves ignore', async () => {
  const cacheRoot = await makeTmpDir('ignored')
  try {
    await seed(cacheRoot)
    const resolver = stubResolver((cwd) => (cwd.includes('secret') ? 'ignore' : 'full'))
    const summary = await purgeCache({ cacheRoot, target: { kind: 'ignored', resolver } })
    assert.equal(summary.rowsDeleted, 1)
    const rows = await remainingRows(cacheRoot)
    assert.ok(!rows.some((r) => r.cwd === SECRET))
    assert.equal(rows.length, 3)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('purge --all deletes every row', async () => {
  const cacheRoot = await makeTmpDir('all')
  try {
    await seed(cacheRoot)
    const summary = await purgeCache({ cacheRoot, target: { kind: 'all' } })
    assert.equal(summary.rowsDeleted, 4)
    const rows = await remainingRows(cacheRoot)
    assert.equal(rows.length, 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('purge reports distinct purged cwds for the resurrection warning', async () => {
  const cacheRoot = await makeTmpDir('cwds')
  try {
    await seed(cacheRoot)
    const summary = await purgeCache({ cacheRoot, target: { kind: 'session', id: 's1' } })
    assert.deepEqual(summary.purgedCwds.sort(), [REPO_A, REPO_A_SUB].sort())
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('purge preserves surviving rows\' part_id (dedupe identity) and does not resurrect on re-scan', async () => {
  const cacheRoot = await makeTmpDir('partid')
  try {
    await seed(cacheRoot)
    await purgeCache({ cacheRoot, target: { kind: 'subtree', path: REPO_A } })

    // Surviving part_ids are byte-identical to what was written (position-delete
    // never rewrites survivors), so a re-record mints the same part_id and the
    // forward sink's chunk dedupe absorbs it.
    const rows = await remainingRows(cacheRoot)
    assert.deepEqual(rows.map((r) => r.part_id).sort(), ['m3#0', 'm4#0'])

    // Watermark integrity: the streaming scan (what the export seam reads)
    // yields exactly the survivors, and a second scan is stable — the deletes
    // are durable, no purged row resurrects.
    /** @param {AsyncIterable<Record<string, unknown>>} it */
    const collect = async (it) => { const out = []; for await (const r of it) out.push(r.part_id); return out.sort() }
    const dir = resolveIcebergDir(partitionDir(cacheRoot))
    assert.deepEqual(await collect(scanRowsFromTable(dir)), ['m3#0', 'm4#0'])
    assert.deepEqual(await collect(scanRowsFromTable(dir)), ['m3#0', 'm4#0'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('purge updates the partition cursor rowCount to the live count', async () => {
  const cacheRoot = await makeTmpDir('cursor')
  try {
    await seed(cacheRoot)
    assert.equal(readCursorSync(partitionDir(cacheRoot)).rowCount, 4)
    await purgeCache({ cacheRoot, target: { kind: 'subtree', path: REPO_A } })
    assert.equal(readCursorSync(partitionDir(cacheRoot)).rowCount, 2)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('purge is idempotent: re-purging the same target deletes nothing new', async () => {
  const cacheRoot = await makeTmpDir('idem')
  try {
    await seed(cacheRoot)
    const first = await purgeCache({ cacheRoot, target: { kind: 'session', id: 's1' } })
    assert.equal(first.rowsDeleted, 2)
    const second = await purgeCache({ cacheRoot, target: { kind: 'session', id: 's1' } })
    assert.equal(second.rowsDeleted, 0)
    assert.equal((await remainingRows(cacheRoot)).length, 2)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('deleteMatchingRows on an empty/absent table is a no-op', async () => {
  const cacheRoot = await makeTmpDir('empty')
  try {
    const res = await deleteMatchingRows(
      path.join(cacheRoot, 'nope', 'table'), () => true, { columns: ['cwd'] }
    )
    assert.deepEqual(res, { rowsDeleted: 0, filesAffected: 0, batchCount: 0 })
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

/* ------------------------------ runPurge (CLI) ------------------------------ */

function captureStream() {
  let buf = ''
  return {
    write: (/** @type {string} */ s) => { buf += s; return true },
    get text() { return buf },
  }
}

/**
 * @param {{ cacheRoot: string, hypHome: string, argvStdinTty?: boolean }} args
 */
function makeCtx({ cacheRoot, hypHome, argvStdinTty = false }) {
  const stdout = captureStream()
  const stderr = captureStream()
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    stdin: { isTTY: argvStdinTty },
    env: { HYP_HOME: hypHome },
    cwd: '/home/u',
    storage: { cacheRoot },
  })
  return { ctx, stdout, stderr }
}

test('runPurge: bare purge (no target) errors', async () => {
  const cacheRoot = await makeTmpDir('cli-bare')
  const hypHome = await makeTmpDir('cli-bare-home')
  try {
    const { ctx, stderr } = makeCtx({ cacheRoot, hypHome })
    const code = await runPurge([], ctx)
    assert.equal(code, 2)
    assert.match(stderr.text, /a target is required/)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('runPurge: two targets error', async () => {
  const cacheRoot = await makeTmpDir('cli-two')
  const hypHome = await makeTmpDir('cli-two-home')
  try {
    const { ctx, stderr } = makeCtx({ cacheRoot, hypHome })
    const code = await runPurge(['--all', '--ignored'], ctx)
    assert.equal(code, 2)
    assert.match(stderr.text, /exactly one/)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('runPurge: non-TTY without --yes refuses', async () => {
  const cacheRoot = await makeTmpDir('cli-confirm')
  const hypHome = await makeTmpDir('cli-confirm-home')
  try {
    await seed(cacheRoot)
    const { ctx, stderr } = makeCtx({ cacheRoot, hypHome, argvStdinTty: false })
    const code = await runPurge(['--all'], ctx)
    assert.equal(code, 2)
    assert.match(stderr.text, /refusing to purge without confirmation/)
    assert.equal((await remainingRows(cacheRoot)).length, 4, 'nothing deleted')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('runPurge --all --yes deletes everything and reports counts', async () => {
  const cacheRoot = await makeTmpDir('cli-all')
  const hypHome = await makeTmpDir('cli-all-home')
  try {
    await seed(cacheRoot)
    const { ctx, stdout } = makeCtx({ cacheRoot, hypHome })
    const code = await runPurge(['--all', '--yes'], ctx)
    assert.equal(code, 0)
    assert.match(stdout.text, /purged 4 rows from 1 partition/)
    assert.equal((await remainingRows(cacheRoot)).length, 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('runPurge subtree warns about resurrection when the dir still resolves full', async () => {
  const cacheRoot = await makeTmpDir('cli-warn')
  const hypHome = await makeTmpDir('cli-warn-home')
  try {
    await seed(cacheRoot)
    // No .hypignore, empty local-only list => REPO_A resolves `full`.
    const { ctx, stderr } = makeCtx({ cacheRoot, hypHome })
    const code = await runPurge(['/home/u/repoA', '--yes'], ctx)
    assert.equal(code, 0)
    assert.match(stderr.text, /still record and will be re-imported/)
    assert.match(stderr.text, /home\/u\/repoA/)
    assert.match(stderr.text, /hyp policy set <path> ignore/)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('runPurge --ignored is durable: an ignored dir does not warn', async () => {
  const cacheRoot = await makeTmpDir('cli-ign')
  const hypHome = await makeTmpDir('cli-ign-home')
  // A real .hypignore so the shared resolver classes the cwd `ignore`.
  const ignoredRepo = await makeTmpDir('cli-ign-repo')
  try {
    await fs.writeFile(path.join(ignoredRepo, '.hypignore'), 'ignore\n')
    await seed(cacheRoot, [
      { session_id: 's1', cwd: ignoredRepo, part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
      { session_id: 's2', cwd: REPO_B, part_id: 'm2#0', timestamp: '2026-07-01T00:00:01Z' },
    ])
    const { ctx, stdout, stderr } = makeCtx({ cacheRoot, hypHome })
    const code = await runPurge(['--ignored', '--yes'], ctx)
    assert.equal(code, 0)
    assert.match(stdout.text, /purged 1 row /)
    assert.doesNotMatch(stderr.text, /re-imported/)
    const rows = await remainingRows(cacheRoot)
    assert.deepEqual(rows.map((r) => r.part_id), ['m2#0'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(hypHome, { recursive: true, force: true })
    await fs.rm(ignoredRepo, { recursive: true, force: true })
  }
})

test('runPurge --json emits machine-readable counts and resurrectable dirs', async () => {
  const cacheRoot = await makeTmpDir('cli-json')
  const hypHome = await makeTmpDir('cli-json-home')
  try {
    await seed(cacheRoot)
    const { ctx, stdout } = makeCtx({ cacheRoot, hypHome })
    const code = await runPurge(['--session', 's1', '--yes', '--json'], ctx)
    assert.equal(code, 0)
    const parsed = JSON.parse(stdout.text)
    assert.equal(parsed.rowsDeleted, 2)
    assert.equal(parsed.partitionsAffected, 1)
    assert.deepEqual(parsed.resurrectable.sort(), [REPO_A, REPO_A_SUB].sort())
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

/* ------------------ aliased spellings of the purge target (#485) ------------------ */

// `hyp purge <path>` used to report success and exit 0 while retaining every
// row recorded under a different *spelling* of the target directory: the
// subtree predicate folded symlinks (LLP 0050 #canonicalization) but compared
// Unicode normalization and case byte-for-byte, so rows recorded NFD survived a
// purge argument typed NFC, and vice versa, and stderr was empty.
//
// The fix cannot be "fold the predicate". Purge deletes, so a fold that merges
// two genuinely different directories destroys data the user never named, and
// on ext4 `caf` + U+00E9 and `cafe` + U+0301 *are* two directories. So the fold
// only proposes an alias spelling and `dev`/`ino` identity decides. That splits
// these tests in two, and the split is not incidental:
//
//   - Whether a *volume* folds two spellings into one directory is a property
//     of the filesystem, and no ext4 host has one, so the deleting direction is
//     driven through an **injected** `statSync` standing in for a default APFS
//     volume. That is the same concession `usage-policy-fold.test.js` makes for
//     the case probe.
//   - The **retaining** direction needs no injection and is the one that must
//     never regress, because its failure mode is unrecoverable data loss. It
//     runs against the real filesystem and asserts that purge agrees with
//     whatever this host actually reports.
//
// @ref LLP 0104#spellings [tests]: purge deletes an aliased spelling the filesystem proves, retains and reports one it cannot

// The same four characters, composed and decomposed, as `\u` escapes so the
// source stays pure ASCII: a raw pair could be silently re-normalized by an
// editor, a merge tool, or a `git` filter, which would collapse the two
// constants into one string and make every test below pass vacuously.
const NFC = 'caf\u00e9'
const NFD = 'cafe\u0301'

test('#485 premise: the two fixture spellings are different strings that NFC folds together', () => {
  assert.notEqual(NFC, NFD)
  assert.equal(NFD.normalize('NFC'), NFC)
  assert.equal(NFC.normalize('NFC'), NFC)
})

/**
 * A `statSync` over a fake volume that treats every spelling of a name the
 * fold merges (Unicode normalization *and* case) as one directory, which is
 * what a default APFS volume does and what no ext4 test host can provide.
 * Anything not listed does not exist.
 *
 * @param {string[]} dirs
 * @returns {(p: string) => { dev: number, ino: number }}
 */
function spellingInsensitiveVolume(dirs) {
  /** @type {Map<string, number>} */
  const inodes = new Map()
  for (const dir of dirs) {
    const key = dir.normalize('NFC').toLowerCase()
    if (!inodes.has(key)) inodes.set(key, inodes.size + 1)
  }
  return (p) => {
    const ino = inodes.get(p.normalize('NFC').toLowerCase())
    if (ino === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return { dev: 42, ino }
  }
}

// `realpath` on paths that only exist inside the fake volume above would fall
// back to the host's filesystem and add noise; the fake volume has no symlinks,
// so identity is the honest canonicalizer for it.
const NO_SYMLINKS = /** @param {string} p */ (p) => p

test('purge subtree deletes a row recorded NFD when the target is typed NFC, on a volume that folds them', async () => {
  const cacheRoot = await makeTmpDir('alias-nfd')
  const nfcDir = `/vol/${NFC}`
  const nfdDir = `/vol/${NFD}`
  try {
    await seed(cacheRoot, [
      // The capture seam recorded what the client reported: the NFD spelling.
      { session_id: 's1', cwd: `${nfdDir}/sub`, part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
      // A sibling that merely shares the folded prefix, and an unrelated dir.
      { session_id: 's2', cwd: `/vol/${NFC}-other`, part_id: 'm2#0', timestamp: '2026-07-01T00:00:01Z' },
      { session_id: 's3', cwd: '/vol/elsewhere', part_id: 'm3#0', timestamp: '2026-07-01T00:00:02Z' },
    ])
    const summary = await purgeCache({
      cacheRoot,
      target: { kind: 'subtree', path: nfcDir },
      deps: {
        realpathSync: NO_SYMLINKS,
        statSync: spellingInsensitiveVolume([nfcDir, `/vol/${NFC}-other`, '/vol/elsewhere']),
      },
    })
    assert.equal(summary.rowsDeleted, 1, 'the NFD-spelled row is inside the directory the user named')
    assert.equal(summary.retainedAliasRows, 0, 'nothing was left behind, so nothing to report')
    assert.deepEqual(summary.purgedCwds, [`${nfdDir}/sub`], 'the deleted cwd drives the resurrection warning')
    const rows = await remainingRows(cacheRoot)
    assert.deepEqual(rows.map((r) => r.part_id).sort(), ['m2#0', 'm3#0'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('purge subtree deletes a row recorded NFC when the target is typed NFD, on a volume that folds them', async () => {
  const cacheRoot = await makeTmpDir('alias-nfc')
  const nfcDir = `/vol/${NFC}`
  const nfdDir = `/vol/${NFD}`
  try {
    await seed(cacheRoot, [
      { session_id: 's1', cwd: nfcDir, part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
      { session_id: 's2', cwd: '/vol/elsewhere', part_id: 'm2#0', timestamp: '2026-07-01T00:00:01Z' },
    ])
    const summary = await purgeCache({
      cacheRoot,
      target: { kind: 'subtree', path: nfdDir },
      deps: {
        realpathSync: NO_SYMLINKS,
        statSync: spellingInsensitiveVolume([nfcDir, '/vol/elsewhere']),
      },
    })
    assert.equal(summary.rowsDeleted, 1)
    const rows = await remainingRows(cacheRoot)
    assert.deepEqual(rows.map((r) => r.part_id), ['m2#0'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('purge subtree deletes a row recorded under a case variant, on a case-insensitive volume', async () => {
  const cacheRoot = await makeTmpDir('alias-case')
  try {
    await seed(cacheRoot, [
      { session_id: 's1', cwd: '/vol/proj/sub', part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
      { session_id: 's2', cwd: '/vol/projx', part_id: 'm2#0', timestamp: '2026-07-01T00:00:01Z' },
    ])
    const summary = await purgeCache({
      cacheRoot,
      target: { kind: 'subtree', path: '/vol/Proj' },
      deps: {
        realpathSync: NO_SYMLINKS,
        statSync: spellingInsensitiveVolume(['/vol/Proj', '/vol/projx']),
      },
    })
    assert.equal(summary.rowsDeleted, 1)
    const rows = await remainingRows(cacheRoot)
    assert.deepEqual(rows.map((r) => r.part_id), ['m2#0'], 'a sibling prefix is still not a descendant')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('purge subtree never widens onto a spelling the volume says is a different directory', async () => {
  const cacheRoot = await makeTmpDir('alias-unproven')
  const nfcDir = `/vol/${NFC}`
  const nfdDir = `/vol/${NFD}`
  try {
    await seed(cacheRoot, [
      { session_id: 's1', cwd: `${nfdDir}/sub`, part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
      { session_id: 's2', cwd: nfcDir, part_id: 'm2#0', timestamp: '2026-07-01T00:00:01Z' },
    ])
    // Both spellings exist and are *different* inodes: an ext4-style volume,
    // modelled explicitly so the assertion does not depend on the test host.
    const summary = await purgeCache({
      cacheRoot,
      target: { kind: 'subtree', path: nfcDir },
      deps: {
        realpathSync: NO_SYMLINKS,
        statSync: (p) => {
          if (p === nfcDir) return { dev: 42, ino: 1 }
          if (p === nfdDir) return { dev: 42, ino: 2 }
          throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
        },
      },
    })
    assert.equal(summary.rowsDeleted, 1, 'only the directory the user actually named')
    assert.equal(summary.retainedAliasRows, 1, 'the lookalike row was retained')
    assert.deepEqual(summary.retainedAliasCwds, [`${nfdDir}/sub`], 'and is named, so the retention is not silent')
    const rows = await remainingRows(cacheRoot)
    assert.deepEqual(rows.map((r) => r.part_id), ['m1#0'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

/**
 * Create two spellings of one name under `root` on the **real** filesystem and
 * report whether this host treats them as one directory. ext4 says two, a
 * default APFS volume says one; both are correct answers about that host, and
 * the point of the tests that use this is that purge agrees with whichever it
 * gets rather than with a platform assumption baked into the test.
 *
 * @param {string} root
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
async function oneDirectoryHere(root, a, b) {
  await fs.mkdir(path.join(root, a), { recursive: true })
  await fs.mkdir(path.join(root, b), { recursive: true })
  const [statA, statB] = await Promise.all([fs.stat(path.join(root, a)), fs.stat(path.join(root, b))])
  return statA.dev === statB.dev && statA.ino === statB.ino
}

test('purge subtree agrees with the real filesystem about an NFC/NFD pair, and never over-deletes', async () => {
  const cacheRoot = await makeTmpDir('real-nfd')
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-purge-real-'))
  try {
    const root = await fs.realpath(projects)
    const folded = await oneDirectoryHere(root, NFC, NFD)
    await seed(cacheRoot, [
      { session_id: 's1', cwd: path.join(root, NFD, 'sub'), part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
      { session_id: 's2', cwd: path.join(root, `${NFC}-other`), part_id: 'm2#0', timestamp: '2026-07-01T00:00:01Z' },
    ])
    const summary = await purgeCache({ cacheRoot, target: { kind: 'subtree', path: path.join(root, NFC) } })
    const rows = await remainingRows(cacheRoot)
    if (folded) {
      assert.equal(summary.rowsDeleted, 1, 'this volume folds the two spellings, so the row is inside the target')
      assert.deepEqual(rows.map((r) => r.part_id), ['m2#0'])
    } else {
      assert.equal(summary.rowsDeleted, 0, 'two inodes here: purging one must not destroy the other')
      assert.equal(summary.retainedAliasRows, 1, 'and the near-miss is reported rather than silent')
      assert.deepEqual(rows.map((r) => r.part_id).sort(), ['m1#0', 'm2#0'])
    }
    assert.ok(
      rows.some((r) => r.part_id === 'm2#0'),
      'a sibling sharing the folded prefix is never a descendant, on any volume'
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(projects, { recursive: true, force: true })
  }
})

test('purge subtree agrees with the real filesystem about a case variant, and never over-deletes', async () => {
  const cacheRoot = await makeTmpDir('real-case')
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-purge-case-'))
  try {
    const root = await fs.realpath(projects)
    const folded = await oneDirectoryHere(root, 'Proj', 'proj')
    await seed(cacheRoot, [
      { session_id: 's1', cwd: path.join(root, 'proj', 'sub'), part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
      { session_id: 's2', cwd: path.join(root, 'projx'), part_id: 'm2#0', timestamp: '2026-07-01T00:00:01Z' },
    ])
    const summary = await purgeCache({ cacheRoot, target: { kind: 'subtree', path: path.join(root, 'Proj') } })
    const rows = await remainingRows(cacheRoot)
    if (folded) {
      assert.equal(summary.rowsDeleted, 1)
      assert.deepEqual(rows.map((r) => r.part_id), ['m2#0'])
    } else {
      assert.equal(summary.rowsDeleted, 0, 'on a case-sensitive volume these are a stranger\'s rows')
      assert.equal(summary.retainedAliasRows, 1)
      assert.deepEqual(rows.map((r) => r.part_id).sort(), ['m1#0', 'm2#0'])
    }
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(projects, { recursive: true, force: true })
  }
})

test('runPurge says so when it leaves a lookalike spelling in place, instead of exiting 0 in silence', async () => {
  const cacheRoot = await makeTmpDir('cli-alias')
  const hypHome = await makeTmpDir('cli-alias-home')
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-purge-cli-alias-'))
  try {
    const root = await fs.realpath(projects)
    const folded = await oneDirectoryHere(root, NFC, NFD)
    await seed(cacheRoot, [
      { session_id: 's1', cwd: path.join(root, NFD, 'sub'), part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
    ])
    const { ctx, stdout, stderr } = makeCtx({ cacheRoot, hypHome })
    const code = await runPurge([path.join(root, NFC), '--yes'], ctx)
    assert.equal(code, 0)
    if (folded) {
      assert.match(stdout.text, /purged 1 row /)
      assert.doesNotMatch(stderr.text, /left in place/)
    } else {
      // The bug this replaces: `purged 0 rows`, empty stderr, exit 0, which is
      // byte-identical to "that directory had nothing cached".
      assert.match(stdout.text, /purged 0 rows /)
      assert.match(stderr.text, /1 cached row under a similarly spelled directory was left in place/)
      assert.match(stderr.text, /purge that exact spelling too/)
      assert.notEqual(stderr.text, '')
    }
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(hypHome, { recursive: true, force: true })
    await fs.rm(projects, { recursive: true, force: true })
  }
})

test('scopeGovernance stays unwidened for callers that do not opt in', () => {
  // The CLI membership sites (`policy show`, `policy unset`) share this
  // predicate and must keep their pre-fix answers: their wrong direction is the
  // harmless one (an opt-out stays on), and widening them is a separate
  // decision from widening a deletion.
  assert.equal(scopeGovernance(`/vol/${NFD}/sub`, `/vol/${NFC}`), 'outside')
  assert.equal(scopeGoverns(`/vol/${NFD}/sub`, `/vol/${NFC}`), false)
  assert.equal(scopeGovernance(`/vol/${NFC}/sub`, `/vol/${NFC}`), 'governs')
})

// The near-miss note has to be true of *this* run, not only of the run the
// report was designed around. `aliased` has three causes and only the first is
// the filesystem adjudicating: two live directories with two inodes, a spelling
// no longer on disk (the ordinary case, when the user purges a project
// directory they already deleted), and a `stat` that could not be taken at all,
// because `sameDirectoryOnDisk` answers `false` for every errno rather than for
// `ENOENT` alone. The tests below use spellings that exist on no host, or exist
// but cannot be read, so none of them depends on whether the test volume folds.
// @ref LLP 0104#spellings [tests]: the retention note claims only what the run established
test('the near-miss note does not claim a verdict an ENOENT never gave', async () => {
  const cacheRoot = await makeTmpDir('cli-alias-gone')
  const hypHome = await makeTmpDir('cli-alias-gone-home')
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-purge-gone-'))
  try {
    const root = await fs.realpath(projects)
    // Neither spelling is on disk, so no volume can prove or disprove them.
    await seed(cacheRoot, [
      { session_id: 's1', cwd: path.join(root, NFD, 'sub'), part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
    ])
    const { ctx, stdout, stderr } = makeCtx({ cacheRoot, hypHome })
    const code = await runPurge([path.join(root, NFC), '--yes'], ctx)
    assert.equal(code, 0)
    assert.match(stdout.text, /purged 0 rows /)
    assert.match(stderr.text, /1 cached row under a similarly spelled directory was left in place/)
    assert.match(stderr.text, /does not report it as the directory you named/)
    assert.doesNotMatch(
      stderr.text,
      /filesystem reports it is a different directory/,
      'nothing was stat-able here, so the filesystem reported no such thing'
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(hypHome, { recursive: true, force: true })
    await fs.rm(projects, { recursive: true, force: true })
  }
})

test('the near-miss note agrees in number with the rows it is counting', async () => {
  const cacheRoot = await makeTmpDir('cli-alias-plural')
  const hypHome = await makeTmpDir('cli-alias-plural-home')
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-purge-plural-'))
  try {
    const root = await fs.realpath(projects)
    // Two rows, one retained directory: the verb agrees with the row count, the
    // noun with the directory count.
    await seed(cacheRoot, [
      { session_id: 's1', cwd: path.join(root, NFD, 'sub'), part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
      { session_id: 's2', cwd: path.join(root, NFD, 'sub'), part_id: 'm2#0', timestamp: '2026-07-01T00:00:01Z' },
    ])
    const { ctx, stderr } = makeCtx({ cacheRoot, hypHome })
    assert.equal(await runPurge([path.join(root, NFC), '--yes'], ctx), 0)
    assert.match(stderr.text, /2 cached rows under a similarly spelled directory were left in place/)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(hypHome, { recursive: true, force: true })
    await fs.rm(projects, { recursive: true, force: true })
  }
})

// The third cause, and the one the note used to misdescribe (#497 finding 1).
// `sameDirectoryOnDisk` answers `false` for *any* `stat` error, so an alias that
// is present on disk but unreadable retains exactly like one that is absent, and
// the run has no way to tell them apart. That collapse is correct and stays: the
// alternative is widening a deletion onto an unproven pair. What it constrains
// is the sentence, which used to offer "genuinely different, or no longer on
// disk" as an exhaustive pair when neither holds here.
//
// The fixture uses a self-referential symlink for `ELOOP` rather than a
// chmod-ed ancestor for `EACCES`: it needs no injection, needs the real
// predicate rather than a stubbed one, and unlike a permission bit it still
// fails the `stat` when the suite runs as root.
test('the near-miss note does not say "no longer on disk" of an alias that is on disk but unreadable', async () => {
  const cacheRoot = await makeTmpDir('cli-alias-eloop')
  const hypHome = await makeTmpDir('cli-alias-eloop-home')
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-purge-eloop-'))
  try {
    const root = await fs.realpath(projects)
    await fs.mkdir(path.join(root, NFC))
    // Present (`lstat` finds it), unreadable (`stat` gives `ELOOP`), and so
    // neither "genuinely different" nor "no longer on disk".
    await fs.symlink(path.join(root, NFD), path.join(root, NFD))
    assert.ok(await fs.lstat(path.join(root, NFD)), 'the alias spelling is on disk')
    await assert.rejects(fs.stat(path.join(root, NFD)), { code: 'ELOOP' })

    await seed(cacheRoot, [
      { session_id: 's1', cwd: path.join(root, NFD, 'sub'), part_id: 'm1#0', timestamp: '2026-07-01T00:00:00Z' },
    ])
    const { ctx, stdout, stderr } = makeCtx({ cacheRoot, hypHome })
    assert.equal(await runPurge([path.join(root, NFC), '--yes'], ctx), 0)

    // Retention is the safe direction and must not move: an unprovable alias is
    // never deleted, whatever stopped the `stat`.
    assert.match(stdout.text, /purged 0 rows /)
    assert.deepEqual((await remainingRows(cacheRoot)).map((r) => r.part_id), ['m1#0'])

    assert.match(stderr.text, /1 cached row under a similarly spelled directory was left in place/)
    assert.match(
      stderr.text,
      /\(genuinely different, no longer on disk, or could not be checked\)/,
      'the enumeration has to admit the cause this run actually hit'
    )
    assert.doesNotMatch(
      stderr.text,
      /\(genuinely different, or no longer on disk\)/,
      'the alias is on disk and nothing adjudicated it different, so neither of the old two holds'
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
    await fs.rm(hypHome, { recursive: true, force: true })
    await fs.rm(projects, { recursive: true, force: true })
  }
})

// The other half of #497 finding 1, and the reason it is a message defect and
// not a data-loss one: pin that a swallowed error resolves to `aliased` and
// never to `governs`, for every errno anyone has proposed. A future attempt to
// "improve" the swallow by treating some errno as reachable would delete rows
// under a directory no filesystem ever identified with the target, and would
// fail here rather than in someone's cache.
// @ref LLP 0104#spellings [tests]: an unprovable alias is retained whatever the errno, so the fix to the wording cannot move a deletion
test('no stat errno makes an unprovable alias deletable', () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'EIO']) {
    const statSync = () => {
      const err = new Error(code)
      Object.assign(err, { code })
      throw err
    }
    assert.equal(
      scopeGovernance(`/vol/${NFD}/sub`, `/vol/${NFC}`, { proveAliases: true, statSync }),
      'aliased',
      `${code} must retain and report, never widen the deletion`
    )
  }
})
