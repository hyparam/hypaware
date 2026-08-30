// @ts-check

/**
 * The vector-search orphan sweep only deletes inside a directory the plugin
 * owns.
 *
 * `<stateDir>/indexes/<decl.name>` is assembled with `path.join`, whose last
 * segment comes out of the user's config and which performs no `readlink`, so
 * the index directory is inside the plugin state root by spelling and can be a
 * symlink in fact. `readShardMetas` reads through it and `sweepOrphan` then
 * unlinks the `.parquet`/`.meta.json` pair it named, wherever the link points.
 *
 * @ref LLP 0331#guard-travels-with-the-delete [tests]: the sweep refuses a
 *   confirmed symlink at the directory it unlinks in, and still reclaims
 *   orphans everywhere else
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { refreshIndexes } from '../../hypaware-core/plugins-workspace/vector-search/src/refresh.js'
import { shardFileBase } from '../../hypaware-core/plugins-workspace/vector-search/src/shards.js'

/** @import { CachePartitionMeta, EmbedderCapability } from '../../hypaware-plugin-kernel-types.js' */
/** @import { ExtendedQueryStorageService } from '../../src/core/cache/types.js' */

const skipSymlinks = process.platform === 'win32' && 'symlink creation needs Developer Mode on win32'

const DECL = /** @type {const} */ ({ dataset: 'd', column: 'text', name: 'd.text' })

/** @param {string} prefix */
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hyp-vector-guard-${prefix}-`))
}

/**
 * A recording log. The orphan sweep says three different things (swept,
 * failed, refused) and only the error kind separates them.
 */
function recordingLog() {
  /** @type {Array<{ msg: string, fields: Record<string, unknown> }>} */
  const records = []
  /** @param {string} msg @param {object} [fields] */
  const push = (msg, fields) => {
    records.push({ msg, fields: /** @type {Record<string, unknown>} */ (fields ?? {}) })
  }
  return {
    records,
    refusals() {
      return records.filter((r) => r.fields.error_kind === 'vector_index_dir_is_symlink')
    },
    swept() {
      return records.filter((r) => r.msg === 'vector.orphan_swept')
    },
    debug: push,
    info: push,
    warn: push,
    error: push,
  }
}

/**
 * Storage with no live partitions at all, so every shard sidecar on disk
 * classifies as an orphan and nothing is ever built.
 *
 * @returns {ExtendedQueryStorageService}
 */
function noPartitions() {
  return /** @type {ExtendedQueryStorageService} */ (/** @type {unknown} */ ({
    async discoverCachePartitions() {
      return /** @type {CachePartitionMeta[]} */ ([])
    },
    async *readRows() {},
  }))
}

/** @returns {EmbedderCapability} */
function stubEmbedder() {
  return {
    provider: 'stub',
    model: 'm1',
    async embed(/** @type {string[]} */ texts) {
      return { vectors: texts.map(() => Float32Array.from([1, 0, 0])), dimension: 3, model: 'm1' }
    },
  }
}

/**
 * One shard pair (parquet plus sidecar) in `dir`, for a partition the storage
 * stub will not report, which is exactly what makes it an orphan.
 *
 * @param {string} dir
 */
function plantOrphanShard(dir) {
  const partition = { source: 'gone' }
  const fileBase = shardFileBase(partition)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${fileBase}.parquet`)
  const meta = path.join(dir, `${fileBase}.meta.json`)
  fs.writeFileSync(file, 'not-a-real-parquet')
  fs.writeFileSync(meta, JSON.stringify({
    schema_version: 1,
    index: DECL.name,
    dataset: DECL.dataset,
    column: DECL.column,
    partition,
    model: 'm1',
    dimension: 3,
    row_count: 2,
    source_row_count: 2,
    built_at: '2026-06-12T00:00:00.000Z',
  }))
  return { file, meta }
}

/** @param {{ indexesDir: string, log: ReturnType<typeof recordingLog> }} args */
function refresh({ indexesDir, log }) {
  return refreshIndexes({
    decls: [{ ...DECL }],
    embedder: stubEmbedder(),
    storage: noPartitions(),
    indexesDir,
    log: /** @type {any} */ (log),
  })
}

// ---------------------------------------------------------------------------
// The door.
// ---------------------------------------------------------------------------

test('the orphan sweep deletes nothing through a symlinked index directory', { skip: skipSymlinks }, async (t) => {
  const indexesDir = tmpDir('link')
  const outside = tmpDir('link-target')
  t.after(() => {
    for (const dir of [indexesDir, outside]) fs.rmSync(dir, { recursive: true, force: true })
  })

  const planted = plantOrphanShard(outside)
  fs.symlinkSync(outside, path.join(indexesDir, DECL.name), 'dir')

  const log = recordingLog()
  await refresh({ indexesDir, log })

  assert.equal(fs.existsSync(planted.file), true, 'a shard pair outside the state root is not ours to unlink')
  assert.equal(fs.existsSync(planted.meta), true)
  assert.equal(log.refusals().length, 1, 'and the refusal is said, not merely done')
  assert.equal(log.swept().length, 0)
})

// The index name is config-declared and reaches the join verbatim, so a
// spelling that ends in a separator is one a config file can carry. `lstat`
// reports on a link only when the path NAMES the link, so that spelling would
// otherwise inspect the target while `rmSync` still followed the link.
test('a trailing separator on the configured index name is not a way past the guard', { skip: skipSymlinks }, async (t) => {
  const indexesDir = tmpDir('trailing')
  const outside = tmpDir('trailing-target')
  t.after(() => {
    for (const dir of [indexesDir, outside]) fs.rmSync(dir, { recursive: true, force: true })
  })

  const planted = plantOrphanShard(outside)
  fs.symlinkSync(outside, path.join(indexesDir, DECL.name), 'dir')

  const log = recordingLog()
  await refreshIndexes({
    decls: [{ ...DECL, name: `${DECL.name}/` }],
    embedder: stubEmbedder(),
    storage: noPartitions(),
    indexesDir,
    log: /** @type {any} */ (log),
  })

  assert.equal(fs.existsSync(planted.file), true)
  assert.equal(fs.existsSync(planted.meta), true)
  assert.equal(log.refusals().length, 1)
})

// ---------------------------------------------------------------------------
// The over-tightening controls. A sweep that refuses too much leaves orphaned
// shards on disk forever, and nothing else reclaims them.
// ---------------------------------------------------------------------------

test('an ordinary index still has its orphaned shards reclaimed', async (t) => {
  const indexesDir = tmpDir('ordinary')
  t.after(() => fs.rmSync(indexesDir, { recursive: true, force: true }))

  const planted = plantOrphanShard(path.join(indexesDir, DECL.name))

  const log = recordingLog()
  const report = await refresh({ indexesDir, log })

  assert.equal(report.orphansSwept, 1)
  assert.equal(fs.existsSync(planted.file), false, 'the orphan parquet is gone')
  assert.equal(fs.existsSync(planted.meta), false, 'and its sidecar with it')
  assert.equal(log.refusals().length, 0, 'and it refused nothing')
})

// The legitimate case the check most plausibly breaks: a plugin state root on
// another volume, or `/tmp` resolving to `/private/tmp` on macOS. The guard
// asks about the directory it unlinks in and nothing above it.
test('an index under a symlinked state root is still swept', { skip: skipSymlinks }, async (t) => {
  const root = tmpDir('symlinked-root')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const real = path.join(root, 'volume', 'indexes')
  const planted = plantOrphanShard(path.join(real, DECL.name))
  fs.symlinkSync(path.join(root, 'volume'), path.join(root, 'link'), 'dir')

  const log = recordingLog()
  const report = await refresh({ indexesDir: path.join(root, 'link', 'indexes'), log })

  assert.equal(report.orphansSwept, 1)
  assert.equal(fs.existsSync(planted.file), false, 'every component above the index dir is the state root\'s business')
  assert.equal(log.refusals().length, 0)
})

// The other half of positive evidence. An `lstat` that cannot answer says
// nothing about the name; refusing on silence would turn an ordinary transient
// into a report that sends an operator looking for a symlink that is not
// there, and would stop the only reclaimer these shards have.
//
// Stated rather than implied: this control is DECORATION against a
// silence-as-escape mutant, and was measured surviving one. This pass reaches
// its guard only after `readShardMetas` has listed the same directory, and on
// a real filesystem a `readdir` that succeeded means an `lstat` that can
// answer - so a directory the process cannot stat produces no orphans, no
// sweep, and nothing for either version of the predicate to say. What it does
// pin is the reachable half: an unreadable index directory is a quiet no-op
// rather than a refusal record. The predicate's silence behaviour is killed
// where it IS reachable, by the scratch sweep's and the capture spool's own
// controls over the same shared function.
test('an index directory the process cannot stat is not declared foreign', {
  skip: process.getuid?.() === 0 && 'a root process traverses a mode-000 directory anyway',
}, async (t) => {
  const root = tmpDir('unreadable')
  const blocked = path.join(root, 'blocked')
  const indexesDir = path.join(blocked, 'indexes')
  plantOrphanShard(path.join(indexesDir, DECL.name))
  fs.chmodSync(blocked, 0o000)
  t.after(() => {
    try { fs.chmodSync(blocked, 0o700) } catch { /* already gone */ }
    fs.rmSync(root, { recursive: true, force: true })
  })

  const log = recordingLog()
  await refresh({ indexesDir, log })

  assert.equal(log.refusals().length, 0, 'an unanswerable lstat is not positive evidence of a plant')
})
