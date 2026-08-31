// @ts-check

/**
 * The index-scratch sweep carries its own containment check.
 *
 * `sweepIndexScratch` is exported, lists `<generation>/data`, and unlinks by
 * path. Until this change the `isConfirmedSymlink` guard in front of it lived
 * at its single call site in cache maintenance, so the property belonged to
 * the caller rather than to the code that deletes: calling the function
 * directly, which is what a second caller and this file both do, swept
 * straight through a planted symlink.
 *
 * @ref LLP 0331#guard-travels-with-the-delete [tests]: the exported deleting
 *   pass refuses on its own, and still reclaims everything it should
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { sweepIndexScratch } from '../../src/core/search/sidecar_build.js'

const skipSymlinks = process.platform === 'win32' && 'symlink creation needs Developer Mode on win32'

/** Two hours back, well past the one-hour grace window a live build occupies. */
const ABANDONED = new Date(Date.now() - 2 * 60 * 60 * 1000)

/** @param {string} prefix */
function tmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `hyp-scratch-guard-${prefix}-`))
}

/**
 * A recording log, so a refusal is observable as something the pass SAID
 * rather than only as work it did not do. Refusing and having nothing to do
 * are otherwise the same void return.
 */
function recordingLog() {
  /** @type {Array<{ msg: string, fields: Record<string, unknown> }>} */
  const warnings = []
  return {
    warnings,
    /**
     * The sweep also warns once per file it DID reclaim, so a refusal has to
     * be read off the error kind rather than off the record count.
     */
    refusals() {
      return warnings.filter((w) => w.fields.error_kind === 'sweep_path_is_symlink')
    },
    /**
     * @param {string} msg
     * @param {object} [fields]
     */
    warn(msg, fields) {
      warnings.push({ msg, fields: /** @type {Record<string, unknown>} */ (fields ?? {}) })
    },
  }
}

/**
 * A directory holding one abandoned scratch file, named exactly as the
 * publish path names them, plus one ordinary file that no sweep may ever
 * touch.
 *
 * @param {string} dir
 */
async function plantScratch(dir) {
  await fsp.mkdir(dir, { recursive: true })
  const scratch = path.join(dir, 'rows.parquet.index.parquet.aaaaaaaa-dead.tmp')
  await fsp.writeFile(scratch, Buffer.alloc(64))
  await fsp.utimes(scratch, ABANDONED, ABANDONED)
  await fsp.writeFile(path.join(dir, 'precious.txt'), 'not ours')
  return scratch
}

// ---------------------------------------------------------------------------
// The door: a symlink on the path the pass walks, reached without a caller.
// ---------------------------------------------------------------------------

test('sweepIndexScratch reclaims nothing through a symlinked data directory', { skip: skipSymlinks }, async (t) => {
  const table = await tmpDir('data-link')
  const outside = await tmpDir('data-link-target')
  t.after(async () => {
    for (const dir of [table, outside]) await fsp.rm(dir, { recursive: true, force: true })
  })

  const scratch = await plantScratch(outside)
  await fsp.symlink(outside, path.join(table, 'data'), 'dir')

  const log = recordingLog()
  sweepIndexScratch(table, log)

  assert.equal(fs.existsSync(scratch), true, 'a tree outside the cache is not this pass to reclaim')
  assert.equal(log.refusals().length, 1, 'and the refusal is said, not merely done')
  assert.equal(log.refusals()[0].fields.planted_component, path.join(table, 'data'))
})

test('sweepIndexScratch reclaims nothing through a symlinked generation directory', { skip: skipSymlinks }, async (t) => {
  const root = await tmpDir('gen-link')
  const outside = await tmpDir('gen-link-target')
  t.after(async () => {
    for (const dir of [root, outside]) await fsp.rm(dir, { recursive: true, force: true })
  })

  const scratch = await plantScratch(path.join(outside, 'data'))
  const table = path.join(root, 'generation')
  await fsp.symlink(outside, table, 'dir')

  const log = recordingLog()
  sweepIndexScratch(table, log)

  assert.equal(fs.existsSync(scratch), true)
  assert.equal(log.refusals().length, 1)
  assert.equal(log.refusals()[0].fields.planted_component, table)
})

// `lstat` reports on a link only when the path NAMES the link: a trailing `/`
// or `/.` makes the kernel resolve the last component, so a guard handed an
// unnormalized spelling inspects the target while `readdirSync` walks the
// link. One `path.resolve`, then check, walk, and report that one spelling.
//
// Stated rather than implied: this spelling is not reachable through the one
// existing caller. A `cursor.tableDir` whose `basename` differs from itself
// fails `generationDirIsContained`, which makes the whole cursor unreadable, so
// maintenance falls back to the layout default. What this pins is the exported
// entry point, which is the whole of LLP 0331: the pass may not depend on its
// caller having normalized the string.
test('a symlinked generation spelled with a trailing separator is still refused', { skip: skipSymlinks }, async (t) => {
  const root = await tmpDir('gen-trailing')
  const outside = await tmpDir('gen-trailing-target')
  t.after(async () => {
    for (const dir of [root, outside]) await fsp.rm(dir, { recursive: true, force: true })
  })

  const scratch = await plantScratch(path.join(outside, 'data'))
  const table = path.join(root, 'generation')
  await fsp.symlink(outside, table, 'dir')

  for (const spelling of [`${table}/`, `${table}/.`, `${table}//`]) {
    const log = recordingLog()
    sweepIndexScratch(spelling, log)
    assert.equal(fs.existsSync(scratch), true, spelling)
    assert.equal(log.refusals().length, 1, spelling)
    assert.equal(log.refusals()[0].fields.planted_component, table, spelling)
  }
})

// ---------------------------------------------------------------------------
// The over-tightening controls. A sweep that refuses too much leaks scratch
// files that nothing else reclaims, and says so to nobody.
// ---------------------------------------------------------------------------

test('an ordinary generation still has its abandoned scratch reclaimed', async (t) => {
  const table = await tmpDir('ordinary')
  t.after(() => fsp.rm(table, { recursive: true, force: true }))

  const dataDir = path.join(table, 'data')
  const scratch = await plantScratch(dataDir)
  const live = path.join(dataDir, 'rows.parquet.index.parquet.bbbbbbbb-live.tmp')
  await fsp.writeFile(live, Buffer.alloc(64))

  const log = recordingLog()
  sweepIndexScratch(table, log)

  assert.equal(fs.existsSync(scratch), false, 'the abandoned scratch is gone')
  assert.equal(fs.existsSync(live), true, 'a scratch young enough to be in flight is untouched')
  assert.equal(fs.existsSync(path.join(dataDir, 'precious.txt')), true, 'and the name predicate still holds')
  assert.equal(log.refusals().length, 0, 'and it refused nothing')
})

// The legitimate case a containment check most plausibly breaks: a cache root
// on another volume, or `/tmp` resolving to `/private/tmp` on macOS. The guard
// asks about the two components this pass opens and nothing above them, so the
// shape of the path the cache lives at is not the sweep's business.
test('a generation under a symlinked ancestor is still swept', { skip: skipSymlinks }, async (t) => {
  const root = await tmpDir('symlinked-ancestor')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const table = path.join(root, 'volume', 'cache', 'generation')
  const scratch = await plantScratch(path.join(table, 'data'))
  await fsp.symlink(path.join(root, 'volume'), path.join(root, 'link'), 'dir')

  const log = recordingLog()
  sweepIndexScratch(path.join(root, 'link', 'cache', 'generation'), log)

  assert.equal(fs.existsSync(scratch), false, 'every component above the generation is the cache root\'s business')
  assert.equal(log.refusals().length, 0)
})

// The components asked about are the ones this pass walks. `metadata/` belongs
// to the unreferenced sweep; a link there says nothing about `data/`, and
// refusing on it would stop reclaiming scratch for a reason unrelated to
// anything this pass opens.
test('a symlinked metadata sibling does not stop the scratch sweep', { skip: skipSymlinks }, async (t) => {
  const table = await tmpDir('metadata-sibling')
  const outside = await tmpDir('metadata-sibling-target')
  t.after(async () => {
    for (const dir of [table, outside]) await fsp.rm(dir, { recursive: true, force: true })
  })

  const scratch = await plantScratch(path.join(table, 'data'))
  await fsp.symlink(outside, path.join(table, 'metadata'), 'dir')

  const log = recordingLog()
  sweepIndexScratch(table, log)

  assert.equal(fs.existsSync(scratch), false)
  assert.equal(log.refusals().length, 0)
})

// The other half of positive evidence. A filesystem that will not answer says
// nothing about the name, and a pass that read silence as an escape would
// report a refusal for an ordinary transient - which is the one report an
// operator would then go and look for a symlink behind.
test('a generation the process cannot stat is not declared foreign', {
  skip: skipSymlinks || (process.getuid?.() === 0 && 'a root process traverses a mode-000 directory anyway'),
}, async (t) => {
  const root = await tmpDir('unreadable')
  const blocked = path.join(root, 'blocked')
  const table = path.join(blocked, 'generation')
  await fsp.mkdir(path.join(table, 'data'), { recursive: true })
  await fsp.chmod(blocked, 0o000)
  t.after(async () => {
    await fsp.chmod(blocked, 0o700).catch(() => {})
    await fsp.rm(root, { recursive: true, force: true })
  })

  const log = recordingLog()
  sweepIndexScratch(table, log)

  assert.equal(log.refusals().length, 0, 'an unanswerable lstat is not positive evidence of a plant')
})
