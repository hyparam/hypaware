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
import { appendRowsToPartition, appendRowsToSourceTable, readCursorSync, tryReadCursorSync, writeCursor } from '../../src/core/cache/partition.js'
import { readRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { createRetentionEnforcer } from '../../src/core/cache/retention.js'
import { createCacheSpool, SPOOL_DIR } from '../../src/core/cache/spool.js'

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

// LLP 0347#file-not-reader withdrew the heal this used to pin. A rejected
// cursor is an unreadable one, so the append no longer rewrites it at the
// default generation: on a partition compacted onto a `table-<ms>` that
// default is a guess, and publishing it costs the real generation to the
// orphan sweep (issue #1170). What the append still may not do is write
// where the rejected value pointed, which is the property LLP 0323 is about
// and the half of this test that has not moved.
test('the next append refuses a rejected cursor rather than healing it to a guess', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    await aimCursorAt(dir, path.relative(dir, outside))
    assert.equal(tryReadCursorSync(dir), null, 'the tampered cursor reads as unreadable')

    await assert.rejects(
      appendRowsToSourceTable(
        cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
        [{ id: 2, session_id: 's-2' }]
      ),
      /present but unreadable/,
      'the append refuses a cursor whose live generation it cannot name'
    )
    assert.equal(tryReadCursorSync(dir), null, 'and leaves the tampered bytes for a repair to look at')
    assert.equal(await pathExists(path.join(outside, 'table')), false, 'having written nothing outside the partition')
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

// LLP 0326 extends LLP 0323's containment rule past the string. `path.resolve`
// reads the name, never the filesystem, so a bare-name SYMLINK is contained by
// spelling and elsewhere in fact: triage of hyparam/hypaware#1091 measured the
// staged-only sweep (LLP 0316#staged-writes-are-reclaimed) actually unlinking
// in the symlink's target, outside the cache.

/**
 * The measured shape: a bare-name symlink in the partition pointing at a
 * directory the cache does not own, with the one file shape the staged-only
 * sweep reclaims planted in it, and one file that is not staged-shaped
 * beside it so an over-broad fix is visible as well as an under-broad one.
 *
 * @param {string} partition
 * @param {string} outside
 * @param {string} name
 * @returns {Promise<{ leak: string, precious: string }>}
 */
async function plantSymlinkedGeneration(partition, outside, name) {
  const leak = await plantStaleStagedName(outside)
  const precious = path.join(outside, 'metadata', 'precious.txt')
  await fs.writeFile(precious, 'a file the cache has no business in')
  await fs.utimes(precious, STALE, STALE)
  await fs.symlink(outside, path.join(partition, name), 'dir')
  return { leak, precious }
}

test('a tableDir naming a symlink out of the partition sweeps nothing at its target', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    const { leak, precious } = await plantSymlinkedGeneration(dir, outside, 'table-1756200000000')
    await aimCursorAt(dir, 'table-1756200000000')

    assert.equal(tryReadCursorSync(dir), null, 'a symlinked generation is not a generation this partition owns')

    const report = await maintainCache({ cacheRoot })

    assert.equal(await pathExists(leak), true, 'the sweep does not unlink through a symlinked generation')
    assert.equal(await pathExists(precious), true, 'and touches nothing else in the foreign directory either')
    assert.equal(
      report.partitions[0]?.unreferencedFilesRemoved, undefined,
      'and reports reclaiming nothing, because it reclaimed nothing'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The default generation name is the same door: nothing about `table` makes
// it likelier to be a real directory than `table-<ms>` is.
test('a tableDir naming a symlinked default generation is rejected too', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    await fs.rm(path.join(dir, 'table'), { recursive: true, force: true })
    const { leak } = await plantSymlinkedGeneration(dir, outside, 'table')
    await aimCursorAt(dir, 'table')

    await maintainCache({ cacheRoot })

    assert.equal(await pathExists(leak), true, 'a symlink named `table` is still a symlink')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The over-tightening control, on the door the check actually opens: the gate
// now stats the path, so the writer-minted shapes have to be re-proved as REAL
// directories on disk, which the string-only test above it cannot see.
test('every generation name hyp mints is still accepted as a real directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-real-'))
  try {
    for (const tableDir of ['table', 'table-1756200000000', 'epoch=3']) {
      await fs.mkdir(path.join(dir, tableDir), { recursive: true })
      await writeCursor(dir, { epoch: 0, rowCount: 1, compaction: null, layout: 'source-table', tableDir })
      assert.equal(tryReadCursorSync(dir)?.tableDir, tableDir, `${tableDir} is a directory this partition owns`)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// Rejection needs positive evidence, or the gate would invent a new way to
// lose a generation. A cursor naming a directory that is not there yet (or not
// there any more) is a legitimate state, and a filesystem that will not answer
// says nothing about the name.
test('a tableDir naming no directory at all is still a name this partition owns', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-absent-gen-'))
  try {
    await writeCursor(dir, {
      epoch: 0, rowCount: 1, compaction: null, layout: 'source-table', tableDir: 'table-1756200000000',
    })
    assert.equal(
      tryReadCursorSync(dir)?.tableDir, 'table-1756200000000',
      'a generation that does not exist yet is not a generation somewhere else'
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// A cache reached through a symlinked ANCESTOR is the legitimate case a
// containment check can plausibly break: `$HYP_HOME` on another volume, or
// `/tmp` pointing at `/private/tmp` on macOS. The check reads the last
// component and nothing above it, so the lifecycle is untouched.
test('a cache reached through a symlinked ancestor keeps every cursor readable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-symlinked-home-'))
  try {
    await fs.mkdir(path.join(root, 'volume', 'hyp-home'), { recursive: true })
    await fs.symlink(path.join(root, 'volume'), path.join(root, 'home'), 'dir')
    const cacheRoot = path.join(root, 'home', 'hyp-home', 'cache')

    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 1, session_id: 's-1' }]
    )
    const dir = partitionDir(cacheRoot)
    assert.equal(tryReadCursorSync(dir)?.tableDir, 'table', 'the first append writes a readable cursor')

    // And through a generation swap, which is the shape that stops naming the
    // default: the swap's `table-<ms>` is a real directory under the symlinked
    // spelling of the same partition.
    const generation = 'table-1756200000000'
    await fs.rename(path.join(dir, 'table'), path.join(dir, generation))
    await aimCursorAt(dir, generation)
    await fs.utimes(path.join(dir, generation), STALE, STALE)

    await maintainCache({ cacheRoot })

    assert.equal(tryReadCursorSync(dir)?.tableDir, generation, 'and it survives a maintenance tick')
    assert.equal(await pathExists(path.join(dir, generation)), true, 'with its live generation intact')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// Item 2 of hyparam/hypaware#1091, which comes along with the stat rather than
// being separate work: a NUL is the one byte that makes the stat throw on its
// argument instead of on the filesystem, and no directory entry can carry one,
// so the name is rejected on the way past rather than special-cased at the stat.
test('a tableDir carrying a NUL byte names no directory entry anywhere', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-nul-'))
  const nul = String.fromCharCode(0)
  try {
    for (const tableDir of [`ta${nul}ble`, nul, `table${nul}`]) {
      await fs.writeFile(
        path.join(dir, 'cursor.json'),
        JSON.stringify({ epoch: 0, rowCount: 1, compaction: null, layout: 'source-table', tableDir })
      )
      assert.equal(tryReadCursorSync(dir), null, 'a name a directory entry cannot carry is not a generation')
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// The other half of the over-tightening control: not the shapes a writer
// mints in isolation, but a partition carried through append, a compaction
// generation swap, and a retention tick, with the cursor re-read at every
// step. A gate that stats the generation directory has to survive the tick
// that renames it.
test('append, generation swap, and retention leave every cursor readable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-lifecycle-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const dir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')

    for (let id = 1; id <= 6; id++) {
      await appendRowsToSourceTable(
        cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
        [{ id, session_id: `s-${id}` }]
      )
    }
    const seeded = tryReadCursorSync(dir)
    assert.equal(seeded?.tableDir, 'table', 'appends leave the default generation named and readable')

    const maint = await maintainCache({ cacheRoot, force: true, compactOnly: true })
    assert.equal(maint.totalFailed, 0, 'the compaction tick failed no partition')
    assert.ok(maint.totalCompacted > 0, 'and it actually compacted, so a generation was swapped')

    const swapped = tryReadCursorSync(dir)
    assert.notEqual(swapped, null, 'the swapped cursor is still readable')
    assert.notEqual(swapped?.tableDir, 'table', 'and names the replacement generation, not the default')
    assert.equal(
      (await fs.lstat(path.join(dir, String(swapped?.tableDir)))).isDirectory(), true,
      'which is a real directory the swap minted, not a link to one'
    )

    const retention = createRetentionEnforcer({ cacheRoot, config: { default_days: 1 } })
    await retention.tick({ now: new Date() })

    const after = tryReadCursorSync(dir)
    assert.equal(after?.tableDir, swapped?.tableDir, 'and retention leaves it readable and unchanged')

    // The append after the whole lifecycle still lands in the generation the
    // cursor names, which is the property a rejected cursor would silently
    // cost (the append would heal to `table` and abandon the swap).
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 7, session_id: 's-7' }]
    )
    assert.equal(
      tryReadCursorSync(dir)?.tableDir, swapped?.tableDir,
      'the next append writes into the swapped generation, not a fresh default'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The same door, reached without editing `tableDir` at all. LLP 0326
// #not-a-symlink covers the name the cursor writes down; these cover the two
// names it does not, and the two path components below them.

test('a cursor that names no generation is still not a pointer to one', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    const leak = await plantStaleStagedName(outside)
    await fs.rm(path.join(dir, 'table'), { recursive: true, force: true })
    await fs.symlink(outside, path.join(dir, 'table'), 'dir')
    // The pre-`tableDir` spelling: legitimate, and it still resolves to a
    // generation name every reader joins onto the partition path.
    const { epoch, rowCount } = readCursorSync(dir)
    await fs.writeFile(
      path.join(dir, 'cursor.json'),
      JSON.stringify({ epoch, rowCount, compaction: null, layout: 'source-table' })
    )

    assert.equal(tryReadCursorSync(dir), null, 'the default generation gets the same question an explicit one does')

    const report = await maintainCache({ cacheRoot })

    assert.equal(await pathExists(leak), true, 'the sweep does not unlink through the default name either')
    assert.equal(report.partitions[0]?.unreferencedFilesRemoved, undefined, 'and reclaimed nothing')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a legacy epoch cursor resolves a default name too, and it is asked the same question', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    await plantStaleStagedName(outside)
    await fs.rm(path.join(dir, 'table'), { recursive: true, force: true })
    await fs.symlink(outside, path.join(dir, 'epoch=0'), 'dir')
    await fs.writeFile(path.join(dir, 'cursor.json'), JSON.stringify({ epoch: 0, rowCount: 1, compaction: null }))

    assert.equal(tryReadCursorSync(dir), null, '`epoch=<n>` is a generation name the readers resolve')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// LLP 0326#one-level-down: the generation is a real directory the cursor
// legitimately names, and the symlink is one component further down, on the
// path the sweep itself joins and lists.

/**
 * @param {string} cacheRoot
 * @param {string} outside
 * @param {'metadata' | 'data'} component
 */
async function plantSymlinkedComponent(cacheRoot, outside, component) {
  const generation = path.join(partitionDir(cacheRoot), 'table')
  await fs.rm(path.join(generation, component), { recursive: true, force: true })
  await fs.mkdir(path.join(outside, component), { recursive: true })
  await fs.symlink(path.join(outside, component), path.join(generation, component), 'dir')
}

test('the sweep reclaims nothing through a symlinked metadata directory', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const leak = await plantStaleStagedName(outside)
    await plantSymlinkedComponent(cacheRoot, outside, 'metadata')

    const dir = partitionDir(cacheRoot)
    assert.notEqual(tryReadCursorSync(dir), null, 'the cursor itself is fine: it names a real directory')

    const report = await maintainCache({ cacheRoot })

    assert.equal(await pathExists(leak), true, 'a staged name reached through a planted link is not the cache to reclaim')
    assert.equal(report.partitions[0]?.unreferencedFilesRemoved, undefined, 'and the sweep counted nothing')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('the sweep reclaims nothing through a symlinked data directory either', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    await plantSymlinkedComponent(cacheRoot, outside, 'data')
    // The referenced-set pass, not the staged one: a stale parquet no
    // snapshot names is what it reclaims out of `data/`.
    const leak = path.join(outside, 'data', 'part-orphan.parquet')
    await fs.writeFile(leak, 'bytes that belong to whoever owns this directory')
    await fs.utimes(leak, STALE, STALE)

    await maintainCache({ cacheRoot })

    assert.equal(await pathExists(leak), true, 'the other component the sweep lists is refused on the same terms')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// And the over-tightening control for that guard, which is the whole risk of
// adding it: a sweep that refuses everything reclaims nothing, and the staged
// leak (LLP 0316#staged-writes-are-reclaimed) has no other reclaimer.
test('the sweep still reclaims a stale staged name inside a generation it owns', async () => {
  const { root, cacheRoot } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    const leak = await plantStaleStagedName(path.join(dir, 'table'))

    const report = await maintainCache({ cacheRoot })

    assert.equal(await pathExists(leak), false, 'a real generation is still swept')
    assert.equal(report.partitions[0]?.unreferencedFilesRemoved, 1, 'and the reclaim is still counted')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The same control through a symlinked ancestor, which is where a guard
// spelled as a canonicalization (`realpath(p) === p`) stops sweeping and a
// guard spelled as `lstat` does not.
test('and still reclaims it in a cache reached through a symlinked ancestor', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sweep-symlinked-home-'))
  try {
    await fs.mkdir(path.join(root, 'volume', 'hyp-home'), { recursive: true })
    await fs.symlink(path.join(root, 'volume'), path.join(root, 'home'), 'dir')
    const cacheRoot = path.join(root, 'home', 'hyp-home', 'cache')
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 1, session_id: 's-1' }]
    )
    const leak = await plantStaleStagedName(path.join(partitionDir(cacheRoot), 'table'))

    const report = await maintainCache({ cacheRoot })

    assert.equal(await pathExists(leak), false, 'the shape of the path the cache lives at is not the sweep\'s business')
    assert.equal(report.partitions[0]?.unreferencedFilesRemoved, 1, 'and the reclaim is still counted')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The pass the cursor gate does NOT stand in front of. The grep-index scratch
// sweep resolves its generation through `readCursorSync`, the lenient reader,
// so a cursor the gate rejected still yields a default generation name there -
// and this cursor does not even have to be edited, only corrupt.
test('the index-scratch sweep does not unlink through a symlinked generation either', async () => {
  const { root, cacheRoot, outside } = await makeCacheBesideOutsider()
  try {
    const dir = partitionDir(cacheRoot)
    await fs.mkdir(path.join(outside, 'data'), { recursive: true })
    const scratch = path.join(outside, 'data', 'part-0.index.parquet.tmp')
    await fs.writeFile(scratch, 'someone else\'s abandoned scratch')
    await fs.utimes(scratch, STALE, STALE)
    // Unreadable, so the lenient reader synthesizes epoch 0 and the epoch
    // layout names `epoch=0` as the live generation.
    await fs.writeFile(path.join(dir, 'cursor.json'), '{ not json')
    await fs.symlink(outside, path.join(dir, 'epoch=0'), 'dir')

    await maintainCache({ cacheRoot })

    assert.equal(await pathExists(scratch), true, 'a scratch-shaped name outside the cache is not the cache to reclaim')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The same class of door reached without any cursor at all. `_hypaware_spool`
// is a fixed name inside the partition, `readdir` follows a symlinked
// directory, and the flush removes every file it drains by path. LLP 0326
// #one-level-down.

/**
 * @param {string} cacheRoot
 * @param {Record<string, unknown>[]} sink
 */
function spoolInto(cacheRoot, sink) {
  return createCacheSpool({
    cacheRoot,
    appendChunk: async (_tablePath, _columns, rows) => {
      sink.push(...rows)
      return { bytesWritten: 1 }
    },
  })
}

/** @type {ColumnSpec[]} */
const ID_COLUMN = [{ name: 'id', type: 'INT32', nullable: false }]

test('the spool flush reads and unlinks nothing through a symlinked spool directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-spool-escape-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const tablePath = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
    const outside = path.join(root, 'outside')
    await fs.mkdir(tablePath, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.symlink(outside, path.join(tablePath, SPOOL_DIR), 'dir')
    // The one file shape the drain reads and then removes by path.
    const planted = path.join(outside, 'flush-1700000000000-1-abcdef.jsonl')
    await fs.writeFile(planted, 'bytes that belong to whoever owns this directory\n')

    /** @type {Record<string, unknown>[]} */
    const ingested = []
    const spool = spoolInto(cacheRoot, ingested)
    await spool.append(tablePath, ID_COLUMN, [{ id: 1 }])
    await spool.flushTable(tablePath, { reason: 'test' })

    assert.equal(await pathExists(planted), true, 'a flush-shaped name outside the cache is not the spool to drain')
    assert.equal(ingested.length, 0, 'and nothing outside the cache was read into it either')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The over-tightening control, which is the whole risk of the guard above: a
// flush that refuses drains nothing, and rows that never drain never commit.
test('an ordinary spool still drains and still reclaims its own flush files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-spool-ordinary-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const tablePath = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
    await fs.mkdir(tablePath, { recursive: true })

    /** @type {Record<string, unknown>[]} */
    const ingested = []
    const spool = spoolInto(cacheRoot, ingested)
    await spool.append(tablePath, ID_COLUMN, [{ id: 1 }, { id: 2 }])
    const result = await spool.flushTable(tablePath, { reason: 'test' })

    assert.equal(result.flushed, true, 'the flush still moves rows')
    assert.equal(ingested.length, 2, 'and all of them')
    const left = await fs.readdir(path.join(tablePath, SPOOL_DIR))
    assert.equal(left.some((name) => name.startsWith('flush-')), false, 'and still removes the files it drained')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('and a spool reached through a symlinked ancestor drains like any other', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-spool-symlinked-home-'))
  try {
    await fs.mkdir(path.join(root, 'volume', 'hyp-home'), { recursive: true })
    await fs.symlink(path.join(root, 'volume'), path.join(root, 'home'), 'dir')
    const cacheRoot = path.join(root, 'home', 'hyp-home', 'cache')
    const tablePath = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
    await fs.mkdir(tablePath, { recursive: true })

    /** @type {Record<string, unknown>[]} */
    const ingested = []
    const spool = spoolInto(cacheRoot, ingested)
    await spool.append(tablePath, ID_COLUMN, [{ id: 1 }])
    const result = await spool.flushTable(tablePath, { reason: 'test' })

    assert.equal(result.flushed, true, 'the shape of the path the cache lives at is not the flush\'s business')
    assert.equal(ingested.length, 1, 'and the row still lands')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The write-path half of the same gate (issue #1170). LLP 0323#whole-cursor
// refuses a non-string `tableDir` rather than dropping the field precisely so
// nothing publishes the default `table` over a partition compacted onto a
// `table-<ms>`. The append path re-derived that guess anyway: it read through
// `tryReadCursorSync` and then spelled out `readCursorSync`'s default, so an
// unreadable cursor was indistinguishable from a missing one, and the orphan
// sweep took the real generation once past its grace window.

/**
 * A partition carried to the state the defect needs: compacted onto a
 * `table-<ms>` generation, with the pre-compaction `table/` already reclaimed
 * the way the sweep reclaims it once its `.retired` marker ages past the 24h
 * grace. `expireOnly` runs the sweep without a second compaction, so exactly
 * one generation is live when the cursor is corrupted.
 *
 * @param {string} cacheRoot
 * @param {number} rows
 * @returns {Promise<{ dir: string, generation: string }>}
 */
async function compactedPartitionWithOneGeneration(cacheRoot, rows) {
  for (let id = 1; id <= rows; id++) {
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id, session_id: `s-${id}` }]
    )
  }
  const dir = partitionDir(cacheRoot)
  const compaction = await maintainCache({ cacheRoot, force: true, compactOnly: true })
  assert.equal(compaction.totalCompacted, 1, 'the fixture partition really was compacted')
  const generation = String(tryReadCursorSync(dir)?.tableDir)
  assert.notEqual(generation, 'table', 'so the live generation is no longer the default name')

  await fs.writeFile(
    path.join(dir, 'table', '.retired'),
    new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  )
  await maintainCache({ cacheRoot, force: true, expireOnly: true })
  assert.deepEqual(
    (await fs.readdir(dir)).sort(), ['cursor.json', generation],
    'and the retired default generation is gone, so only the real one holds the rows'
  )
  return { dir, generation }
}

/** @param {string} dir @returns {Promise<number[]>} */
async function idsIn(dir) {
  return (await readRowsFromTable(dir)).map((row) => Number(row.id)).sort((a, b) => a - b)
}

test('an append onto an unreadable cursor does not cost a compacted partition its generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-append-unreadable-cursor-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const { dir, generation } = await compactedPartitionWithOneGeneration(cacheRoot, 6)
    assert.deepEqual(await idsIn(path.join(dir, generation)), [1, 2, 3, 4, 5, 6])

    await fs.writeFile(path.join(dir, 'cursor.json'), '{ not json')

    // Caught rather than asserted on here, so the assertions below are the
    // ones that fail when this regresses: the loss is the finding, and a
    // rejection assertion in front of it would hide the loss behind
    // "missing expected rejection".
    /** @type {unknown} */
    let refusal
    try {
      await appendRowsToSourceTable(
        cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
        [{ id: 7, session_id: 's-7' }]
      )
    } catch (err) {
      refusal = err
    }

    // Age every generation past ORPHAN_GRACE_MS and run the sweep that
    // reclaimed the real one before this was fixed.
    for (const name of await fs.readdir(dir)) {
      const full = path.join(dir, name)
      if ((await fs.stat(full)).isDirectory()) await fs.utimes(full, STALE, STALE)
    }
    await maintainCache({ cacheRoot, force: true, expireOnly: true })

    assert.equal(
      await pathExists(path.join(dir, generation)), true,
      'the sweep still cannot name a live generation, so it calls nothing an orphan'
    )
    assert.deepEqual(
      await idsIn(path.join(dir, generation)), [1, 2, 3, 4, 5, 6],
      'and every row the partition held before the refused append is still readable'
    )

    // Said last, because it is the mechanism rather than the finding.
    assert.match(
      String(refusal), /present but unreadable/,
      'which it is because the append refused instead of publishing a generation it guessed'
    )
    assert.equal(
      await fs.readFile(path.join(dir, 'cursor.json'), 'utf8'), '{ not json',
      'leaving the unreadable bytes for a repair to look at, not overwritten'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The control for the over-tightening the refusal could cause. A brand-new
// partition has no `cursor.json` at all, and there the epoch-0 default is not
// a guess: it is the truth about a partition that has never been written to.
// It has to keep publishing `table` as its first live generation, or the
// refusal has broken every first write in the cache.

test('a partition with no cursor still publishes its first generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-append-fresh-partition-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const dir = partitionDir(cacheRoot)

    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 1, session_id: 's-1' }]
    )
    assert.equal(tryReadCursorSync(dir)?.tableDir, 'table', 'the first append names the default generation')
    assert.deepEqual(await idsIn(path.join(dir, 'table')), [1], 'and the row is in it')

    // The whole lifecycle, not just the first write: a second append, a
    // compaction that swaps the generation, and an append after the swap.
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 2, session_id: 's-2' }]
    )
    await maintainCache({ cacheRoot, force: true, compactOnly: true })
    const swapped = String(tryReadCursorSync(dir)?.tableDir)
    assert.notEqual(swapped, 'table', 'the swap moved the live generation off the default')
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 3, session_id: 's-3' }]
    )
    assert.equal(tryReadCursorSync(dir)?.tableDir, swapped, 'and the append after it still lands in the swapped one')
    assert.deepEqual(await idsIn(path.join(dir, swapped)), [1, 2, 3])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The third shape at the same call site, and the reason the gate asks the
// filesystem rather than the reader: a cursor that is GONE, over a table that
// is not. That is what a crash between an append and its cursor write leaves
// (the case `partitionHasCommittedRows` already reasons about), and it stays
// appendable, because a missing cursor names no other generation to lose.

test('an append still heals a partition whose cursor was lost but whose table was not', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-append-lost-cursor-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const dir = partitionDir(cacheRoot)
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 1, session_id: 's-1' }]
    )
    await fs.rm(path.join(dir, 'cursor.json'))

    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 2, session_id: 's-2' }]
    )
    assert.equal(tryReadCursorSync(dir)?.tableDir, 'table', 'the cursor is restored over the table that was already there')
    assert.deepEqual(await idsIn(path.join(dir, 'table')), [1, 2], 'and both rows are readable')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The epoch layout reaches the same default through `cursor.epoch`, so it
// carries the same defect: an unreadable cursor over a partition at
// `epoch=3/` would republish epoch 0 and orphan the real one.

test('the legacy epoch append refuses an unreadable cursor too', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-append-epoch-unreadable-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const dir = path.join(cacheRoot, 'datasets', 'traces', 'client=claude', 'date=2026-01-01')

    await appendRowsToPartition(
      cacheRoot, 'traces', ['client=claude', 'date=2026-01-01'], SESSION_COLUMNS,
      [{ id: 1, session_id: 's-1' }]
    )
    assert.deepEqual(await idsIn(path.join(dir, 'epoch=0')), [1], 'the first append publishes epoch 0 as it always did')

    await fs.writeFile(path.join(dir, 'cursor.json'), '{ not json')
    await assert.rejects(
      appendRowsToPartition(
        cacheRoot, 'traces', ['client=claude', 'date=2026-01-01'], SESSION_COLUMNS,
        [{ id: 2, session_id: 's-2' }]
      ),
      /present but unreadable/,
      'and an unreadable cursor stops the next one instead of guessing an epoch'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
