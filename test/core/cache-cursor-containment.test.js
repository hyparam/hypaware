// @ts-check

// LLP 0323: a partition cursor may only name a generation inside its own
// partition. `tryReadCursorSync` is the one gate, so a `tableDir` that
// escapes makes the whole cursor unreadable and every destructive reader
// downstream degrades the way it already degrades on a corrupt cursor.
//
// The regression these pin (hyparam/hypaware#1084): `generationLayout`
// joined the cursor's `tableDir` onto the partition path unchecked, so an
// edited `cursor.json` pointed the maintenance tick's file sweep at a
// directory outside the cache.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync, tryReadCursorSync, writeCursor } from '../../src/core/cache/partition.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const SESSION_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
]

const STALE = new Date(Date.now() - 5 * 60 * 60 * 1000)

/**
 * A container holding a real cache beside a directory the cache has no
 * business in. Both live under one temp root so the escape target is a
 * genuine sibling of the cache tree, not a path inside it.
 *
 * @returns {Promise<{ root: string, cacheRoot: string, outside: string }>}
 */
async function makeCacheBesideOutsider() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-escape-'))
  const cacheRoot = path.join(root, 'cache')
  const outside = path.join(root, 'outside')
  await fs.mkdir(cacheRoot, { recursive: true })
  await fs.mkdir(path.join(outside, 'metadata'), { recursive: true })
  await appendRowsToSourceTable(
    cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
    [{ id: 1, session_id: 's-1' }]
  )
  return { root, cacheRoot, outside }
}

/** @param {string} cacheRoot @returns {string} */
function partitionDir(cacheRoot) {
  return path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
}

/**
 * Plant the one file shape the sweep's staged-only door reclaims without
 * needing any published metadata at all (LLP 0316
 * #staged-writes-are-reclaimed): a staging name, aged past
 * `ORPHAN_GRACE_MS`. Nothing else has to exist in the directory.
 *
 * @param {string} tableDir
 * @returns {Promise<string>} the planted path
 */
async function plantStaleStagedName(tableDir) {
  const leak = path.join(tableDir, 'metadata', 'v1.metadata.json.tmp.4242.1756200000000.k3f9zq')
  await fs.writeFile(leak, 'bytes that belong to whoever owns this directory')
  await fs.utimes(leak, STALE, STALE)
  return leak
}

/** @param {string} p @returns {Promise<boolean>} */
async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Point the partition's cursor at `tableDir`, keeping every other field a
 * real append wrote. Written through `writeCursor` so the file is exactly
 * the shape the reader expects; only the value under test is unusual.
 *
 * @param {string} dir
 * @param {string} tableDir
 */
async function aimCursorAt(dir, tableDir) {
  await writeCursor(dir, { ...readCursorSync(dir), layout: 'source-table', tableDir })
}

test('a cursor whose tableDir escapes the partition sweeps nothing outside it', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    const leak = await plantStaleStagedName(outside)
    await aimCursorAt(dir, path.relative(dir, outside))

    const report = await maintainCache({ cacheRoot })

    assert.equal(await pathExists(leak), true, 'a staged-shaped name outside the partition is not the cache to reclaim')
    assert.equal(
      report.partitions[0]?.unreferencedFilesRemoved, undefined,
      'and nothing outside is reported reclaimed either'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// Not a reproduction of #1084's escape: `path.join` swallows a leading
// separator, so today's consumers land at `<partition>/<abs>` and stay
// contained by accident. It is pinned because the accident is the
// consumer's, not the cursor's - one reader switching to `path.resolve`
// (which discards the partition outright) turns an absolute tableDir into
// the same defect by a shorter route.
test('an absolute tableDir sweeps nothing at the path it names', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const leak = await plantStaleStagedName(outside)
    await aimCursorAt(partitionDir(cacheRoot), outside)

    await maintainCache({ cacheRoot })

    assert.equal(await pathExists(leak), true, 'an absolute tableDir is not a generation this partition owns')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('rejecting the cursor does not hand the orphan sweep the real generation', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    const live = path.join(dir, 'table')
    // Aged past ORPHAN_GRACE_MS, so only a cursor that still knows this is
    // the live generation - or one that has stopped naming any generation
    // at all - keeps it. A guard that dropped the escaping field instead of
    // the cursor would leave `liveDir` reading as `table` by default, which
    // is the right answer here and the wrong one for a partition whose live
    // generation is a `table-<ms>`.
    await fs.utimes(live, STALE, STALE)
    await aimCursorAt(dir, path.relative(dir, outside))

    await maintainCache({ cacheRoot })

    assert.equal(await pathExists(live), true, 'an unreadable cursor names no live generation, so it orphans none')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The load-bearing case for rejecting the WHOLE cursor rather than the
// escaping field (LLP 0323#whole-cursor). The test above it cannot see the
// difference: its live generation is `table`, which is exactly what a
// field-only guard would default to, so both designs keep it. Only a
// partition that has been through a generation swap tells them apart.
test('rejecting the whole cursor keeps a swapped generation the default would orphan', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    const generation = 'table-1756200000000'
    // The shape a generation swap leaves: the live generation is a
    // `table-<ms>`, and `table` is not it.
    await fs.rename(path.join(dir, 'table'), path.join(dir, generation))
    await aimCursorAt(dir, generation)
    await fs.utimes(path.join(dir, generation), STALE, STALE)

    await aimCursorAt(dir, path.relative(dir, outside))
    await maintainCache({ cacheRoot })

    // Under a guard that dropped only `tableDir`, the cursor would still
    // read as a source-table cursor, `liveGenerationDir` would answer
    // `table`, and this directory would be swept as an orphan.
    assert.equal(
      await pathExists(path.join(dir, generation)), true,
      'a cursor that names no generation must not nominate the default one'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// A tableDir that resolves to the live generation but is not spelled as its
// name is the same data loss by a shorter route: the orphan sweep compares
// `cursor.tableDir` to a `readdir` entry name, and `./table` matches no
// entry, so the live generation reads as an orphan.
test('a tableDir that aliases the live generation does not cost the live generation', async () => {
  for (const alias of ['./table', 'table/', 'table/nested']) {
    const { root, cacheRoot } = await makeCacheBesideOutsider()
    try {
      const dir = partitionDir(cacheRoot)
      const live = path.join(dir, 'table')
      await fs.utimes(live, STALE, STALE)
      await aimCursorAt(dir, alias)

      await maintainCache({ cacheRoot })

      assert.equal(await pathExists(live), true, `${alias} must not orphan the generation it resolves to`)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})

test('the next append heals a rejected cursor into a contained one', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    await aimCursorAt(dir, path.relative(dir, outside))
    assert.equal(tryReadCursorSync(dir), null, 'the tampered cursor reads as unreadable')

    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 2, session_id: 's-2' }]
    )

    const healed = tryReadCursorSync(dir)
    assert.equal(healed?.tableDir, 'table', 'the append rewrites the cursor at the default generation')
    assert.equal(await pathExists(path.join(outside, 'table')), false, 'and wrote nothing outside the partition')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('tryReadCursorSync accepts every generation name hyp actually mints', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-contained-'))
  try {
    // The complete set of shapes any writer produces: a first append's
    // `table`, a generation swap's `table-<ms>`, and the legacy layout's
    // `epoch=<n>`. Nothing in the tree spells a generation any other way.
    for (const tableDir of ['table', 'table-1756200000000', 'epoch=3']) {
      await writeCursor(dir, { epoch: 0, rowCount: 1, compaction: null, layout: 'source-table', tableDir })
      assert.equal(tryReadCursorSync(dir)?.tableDir, tableDir, `${tableDir} is a generation this partition owns`)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('tryReadCursorSync rejects a tableDir that is not a bare name inside the partition', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-escaping-'))
  try {
    // `./table` and `table/` resolve to the live generation and are still
    // rejected: the orphan sweep matches this string against a `readdir`
    // entry name, so a spelling that resolves right and compares wrong is
    // the shape that reclaims the live generation. See the behaviour test
    // above it.
    const notAName = ['./table', 'table/', 'table/nested', './/table', 'a/../b']
    const notInside = ['..', '../sibling', 'table/../../escape', path.join(dir, '..', 'absolute'), '', '.']
    for (const tableDir of [...notAName, ...notInside]) {
      await writeCursor(dir, { epoch: 0, rowCount: 1, compaction: null, layout: 'source-table', tableDir })
      assert.equal(tryReadCursorSync(dir), null, `${JSON.stringify(tableDir)} is not a generation this partition owns`)
      // The lenient reader answers what it answers for any other corrupt
      // cursor, so no caller of it inherits a special case.
      assert.deepEqual(
        readCursorSync(dir), { epoch: 0, rowCount: 0, compaction: null },
        'and the lenient reader synthesizes the same default a corrupt cursor gets'
      )
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// A `tableDir` that is present but not a string reaches the same data loss
// through the reader's other door: the old `typeof === 'string'` test
// dropped it, which is the field-level guard LLP 0323#whole-cursor rejects.
// Absent is a different thing and stays legitimate, because a cursor
// written before `tableDir` existed means `table` by omission.
test('a tableDir that is present but not a string is rejected, not dropped', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-nonstring-'))
  try {
    for (const tableDir of [42, null, ['table'], { name: 'table' }, true]) {
      await fs.writeFile(
        path.join(dir, 'cursor.json'),
        JSON.stringify({ epoch: 0, rowCount: 1, compaction: null, layout: 'source-table', tableDir })
      )
      assert.equal(
        tryReadCursorSync(dir), null,
        `${JSON.stringify(tableDir)} is not a generation name, so it cannot be read as the default one`
      )
    }
    await fs.writeFile(
      path.join(dir, 'cursor.json'),
      JSON.stringify({ epoch: 0, rowCount: 1, compaction: null, layout: 'source-table' })
    )
    assert.deepEqual(
      tryReadCursorSync(dir), { epoch: 0, rowCount: 1, compaction: null, layout: 'source-table' },
      'a cursor that never carried a tableDir still means the default generation'
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a non-string tableDir does not cost a swapped generation either', async () => {
  const { root, cacheRoot } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    const generation = 'table-1756200000000'
    await fs.rename(path.join(dir, 'table'), path.join(dir, generation))
    await fs.utimes(path.join(dir, generation), STALE, STALE)
    await fs.writeFile(
      path.join(dir, 'cursor.json'),
      JSON.stringify({ epoch: 0, rowCount: 1, compaction: null, layout: 'source-table', tableDir: 42 })
    )

    await maintainCache({ cacheRoot })

    assert.equal(
      await pathExists(path.join(dir, generation)), true,
      'a cursor whose tableDir is not a name must not nominate the default one'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
