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
    assert.match(stderr.text, /hyp ignore --private/)
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
