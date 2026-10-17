// @ts-check

// A forced maintenance rewrite of a published source table needs the
// table's metadata to carry its schema, partition spec and sort order into
// the replacement generation. When that metadata cannot be read the rewrite
// is refused: the partition fails visibly, its live generation and cursor
// stay exactly as they were, and the walk moves on (#1023). `--force`
// overrides the dueness heuristics, not the metadata contract. The legacy
// epoch layout, which has no spec by construction, still rewrites.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadLatestFileCatalogMetadata } from 'icebird'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync, writeCursor } from '../../src/core/cache/partition.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'
import {
  appendRowsToTable,
  currentPartitionSpec,
  currentSchema,
  readRowsFromTable,
  sortColumnsFromMetadata,
} from '../../src/core/cache/iceberg/store.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration } from '../../src/core/iceberg/types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
]

/** @type {CachePartitioningDeclaration} */
const DECLARATION = {
  source: { columns: ['source'] },
  iceberg: {
    fields: [
      { column: 'session_id', transform: 'identity', required: true, sortOnly: true },
      { column: 'date', transform: 'identity', required: true },
    ],
  },
}

/**
 * Three separate flushes per source, so a forced rewrite has files to merge.
 *
 * @param {string} cacheRoot
 * @param {string} source
 */
async function seed(cacheRoot, source) {
  for (let i = 0; i < 3; i++) {
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', [`source=${source}`], COLUMNS,
      [{ id: i, session_id: `s-${i}`, date: '2026-08-01' }],
      { declaration: DECLARATION }
    )
  }
}

/** @param {string} cacheRoot @param {string} source @returns {string} */
function partitionDir(cacheRoot, source) {
  return path.join(cacheRoot, 'datasets', 'ai_gateway_messages', `source=${source}`)
}

/** @param {string} dir @returns {string} */
function liveTableDir(dir) {
  return path.join(dir, readCursorSync(dir).tableDir ?? 'table')
}

/** @param {string} tableDir */
async function loadTableMetadata(tableDir) {
  const { resolver, lister } = await createLocalIcebergIO()
  const { metadata } = await loadLatestFileCatalogMetadata({
    tableUrl: tableUrlForDir(tableDir), resolver, lister,
  })
  return metadata
}

/** @param {string} tableDir */
async function currentMetadataFile(tableDir) {
  const metadataDir = path.join(tableDir, 'metadata')
  const hint = (await fs.readFile(path.join(metadataDir, 'version-hint.text'), 'utf8')).trim()
  return path.join(metadataDir, `v${hint}.metadata.json`)
}

/**
 * Every file under `root`, by relative path, with a digest of its bytes.
 * Taken before and after a refused rewrite, it shows nothing was written,
 * moved or reserved anywhere in the partition, the cursor included.
 *
 * @param {string} root
 * @returns {Promise<Record<string, string>>}
 */
async function snapshotTree(root) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name)
    const rel = path.relative(root, full)
    out[rel] = entry.isFile() ? createHash('sha256').update(await fs.readFile(full)).digest('hex') : 'dir'
  }
  return out
}

/** @param {Awaited<ReturnType<typeof loadTableMetadata>>} metadata */
function layoutOf(metadata) {
  return {
    schema: currentSchema(metadata)?.fields.map((f) => `${f.name}:${f.type}:${f.required}`),
    spec: currentPartitionSpec(metadata)?.fields.map((f) => `${f.name}:${f.transform}`),
    sort: sortColumnsFromMetadata(metadata),
  }
}

// @ref LLP 0220#walk-survives-a-partition [tests]: the refused partition fails alone and the next one is still rewritten.
test('a forced rewrite over unreadable metadata is refused, the walk continues, and a later tick rewrites it', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-forced-refusal-'))
  try {
    await seed(cacheRoot, 'claude')
    await seed(cacheRoot, 'codex')
    const broken = partitionDir(cacheRoot, 'claude')
    const healthy = partitionDir(cacheRoot, 'codex')
    const brokenTable = liveTableDir(broken)
    const layoutBefore = layoutOf(await loadTableMetadata(brokenTable))
    assert.deepEqual(layoutBefore.spec, ['date:identity'], 'the fixture is a published date-partitioned table')
    assert.deepEqual(layoutBefore.sort?.map((s) => s.column), ['session_id', 'date'])

    // The metadata keeps its published name, so the table still exists to
    // the walk, but it no longer parses: no schema, spec or sort to carry.
    const metadataFile = await currentMetadataFile(brokenTable)
    const goodMetadata = await fs.readFile(metadataFile)
    await fs.writeFile(metadataFile, 'not json at all')

    const treeBefore = await snapshotTree(broken)
    const healthyGeneration = readCursorSync(healthy).tableDir

    const report = await maintainCache({
      cacheRoot,
      compactOnly: true,
      force: true,
      getDeclaration: () => DECLARATION,
    })

    const refused = report.partitions.find((p) => p.partition.source === 'claude')
    const walked = report.partitions.find((p) => p.partition.source === 'codex')
    assert.ok(refused && walked, JSON.stringify(report.partitions))
    assert.equal(refused.failed, true, 'the refusal is reported as a failed partition')
    assert.equal(refused.errorKind, 'compaction_metadata_unavailable')
    assert.match(refused.errorMessage ?? '', /schema, partition spec and sort order/)
    assert.equal(refused.compacted, false)
    assert.equal(report.totalFailed, 1)
    assert.deepEqual(
      await snapshotTree(broken), treeBefore,
      'cursor bytes, live generation files and the directory listing are unchanged: no spec-less generation was reserved or published'
    )

    // The walk did not stop at the refusal.
    assert.equal(walked.failed ?? false, false)
    assert.equal(walked.compacted, true, 'the next partition is still rewritten')
    assert.notEqual(readCursorSync(healthy).tableDir, healthyGeneration)
    assert.deepEqual(
      layoutOf(await loadTableMetadata(liveTableDir(healthy))),
      layoutBefore,
      'a healthy forced rewrite keeps the recorded schema, partition spec and sort order'
    )

    // Once the metadata reads again, the same forced tick rewrites it.
    await fs.writeFile(metadataFile, goodMetadata)
    const retried = await maintainCache({
      cacheRoot,
      compactOnly: true,
      force: true,
      getDeclaration: () => DECLARATION,
    })
    const recovered = retried.partitions.find((p) => p.partition.source === 'claude')
    assert.equal(recovered?.failed ?? false, false, JSON.stringify(recovered))
    assert.equal(recovered?.compacted, true)
    const rewrittenTable = liveTableDir(broken)
    assert.notEqual(rewrittenTable, brokenTable, 'the recovered partition swaps to a new generation')
    assert.deepEqual(layoutOf(await loadTableMetadata(rewrittenTable)), layoutBefore)
    const rows = await readRowsFromTable(rewrittenTable)
    assert.deepEqual(rows.map((r) => r.id).sort(), [0, 1, 2], 'every row survives the recovered rewrite')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('metadata that exists but cannot be opened is refused the same way', { skip: process.getuid?.() === 0 && 'root reads a mode-000 file' }, async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-forced-refusal-eacces-'))
  /** @type {string | undefined} */
  let metadataFile
  try {
    await seed(cacheRoot, 'claude')
    const dir = partitionDir(cacheRoot, 'claude')
    metadataFile = await currentMetadataFile(liveTableDir(dir))
    const treeBefore = await snapshotTree(dir)
    await fs.chmod(metadataFile, 0o000)

    const report = await maintainCache({ cacheRoot, compactOnly: true, force: true, getDeclaration: () => DECLARATION })

    // Readable again only so the snapshot can hash it.
    await fs.chmod(metadataFile, 0o644)
    assert.equal(report.partitions[0].failed, true, JSON.stringify(report.partitions))
    assert.equal(report.partitions[0].errorKind, 'compaction_metadata_unavailable')
    assert.deepEqual(await snapshotTree(dir), treeBefore)
  } finally {
    if (metadataFile) await fs.chmod(metadataFile, 0o644).catch(() => {})
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

/**
 * Metadata that still parses but has lost part of the layout, metadata that
 * is gone, and metadata that cannot be listed: each is refused before any
 * generation is reserved, with the partition's files byte-identical.
 *
 * @type {{ name: string, root?: boolean, break: (metadataFile: string) => Promise<void>, mend?: (metadataFile: string) => Promise<void> }[]}
 */
const BREAKAGES = [
  {
    name: 'a sort order id that resolves to no sort order',
    break: (file) => editMetadata(file, (meta) => { delete meta['sort-orders'] }),
  },
  {
    name: 'a spec id that resolves to no partition spec',
    break: (file) => editMetadata(file, (meta) => { delete meta['partition-specs'] }),
  },
  {
    name: 'no published metadata file at all',
    break: async (file) => {
      for (const name of await fs.readdir(path.dirname(file))) {
        if (name.endsWith('.metadata.json')) await fs.rm(path.join(path.dirname(file), name))
      }
    },
  },
  {
    name: 'a metadata directory that cannot be listed',
    root: true,
    break: (file) => fs.chmod(path.dirname(file), 0o000),
    mend: (file) => fs.chmod(path.dirname(file), 0o755),
  },
]

/**
 * @param {string} file
 * @param {(meta: Record<string, unknown>) => void} edit
 */
async function editMetadata(file, edit) {
  const meta = JSON.parse(await fs.readFile(file, 'utf8'))
  edit(meta)
  await fs.writeFile(file, JSON.stringify(meta))
}

for (const breakage of BREAKAGES) {
  test(`a forced rewrite over ${breakage.name} is refused and changes nothing`, { skip: breakage.root && process.getuid?.() === 0 && 'root lists a mode-000 directory' }, async () => {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-forced-refusal-layout-'))
    /** @type {string | undefined} */
    let metadataFile
    try {
      await seed(cacheRoot, 'claude')
      await seed(cacheRoot, 'codex')
      const dir = partitionDir(cacheRoot, 'claude')
      metadataFile = await currentMetadataFile(liveTableDir(dir))
      await breakage.break(metadataFile)
      if (breakage.mend) await breakage.mend(metadataFile)
      const treeBefore = await snapshotTree(dir)
      await breakage.break(metadataFile)

      const report = await maintainCache({ cacheRoot, compactOnly: true, force: true, getDeclaration: () => DECLARATION })

      if (breakage.mend) await breakage.mend(metadataFile)
      const refused = report.partitions.find((p) => p.partition.source === 'claude')
      assert.equal(refused?.failed, true, JSON.stringify(report.partitions))
      assert.equal(refused?.errorKind, 'compaction_metadata_unavailable')
      assert.equal(refused?.compacted, false)
      assert.deepEqual(await snapshotTree(dir), treeBefore, 'no generation reserved, published or swapped')
      const walked = report.partitions.find((p) => p.partition.source === 'codex')
      assert.equal(walked?.compacted, true, 'the walk continues to the next partition')
    } finally {
      if (metadataFile && breakage.mend) await breakage.mend(metadataFile).catch(() => {})
      await fs.rm(cacheRoot, { recursive: true, force: true })
    }
  })
}

test('a refusal leaves a stale compaction verdict unstamped, and the repaired partition still gets its retry', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-forced-refusal-stale-'))
  try {
    await seed(cacheRoot, 'claude')
    const dir = partitionDir(cacheRoot, 'claude')
    // A verdict recorded against an older writer generation: the shape
    // LLP 0217 stamps when an attempt throws.
    const cursor = readCursorSync(dir)
    await writeCursor(dir, {
      ...cursor,
      compaction: { previousTableDir: 'table', compactedAt: '2026-08-12T00:00:00Z', resettleBaselineFiles: 3, writerGeneration: 0 },
    })
    const metadataFile = await currentMetadataFile(liveTableDir(dir))
    const goodMetadata = await fs.readFile(metadataFile)
    await fs.writeFile(metadataFile, 'not json at all')
    const cursorBefore = await fs.readFile(path.join(dir, 'cursor.json'))
    const treeBefore = await snapshotTree(dir)

    const report = await maintainCache({ cacheRoot, compactOnly: true, force: true, getDeclaration: () => DECLARATION })

    assert.equal(report.partitions[0].errorKind, 'compaction_metadata_unavailable', JSON.stringify(report.partitions))
    assert.deepEqual(await fs.readFile(path.join(dir, 'cursor.json')), cursorBefore)
    assert.deepEqual(await snapshotTree(dir), treeBefore)

    // The retry is still owed: once the metadata reads, an ordinary,
    // unforced tick takes it.
    await fs.writeFile(metadataFile, goodMetadata)
    const repaired = await maintainCache({ cacheRoot, compactOnly: true, getDeclaration: () => DECLARATION })
    assert.equal(repaired.partitions[0].failed ?? false, false, JSON.stringify(repaired.partitions))
    assert.equal(repaired.partitions[0].compacted, true)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a forced rewrite of a legacy epoch partition, which has no spec by construction, still compacts', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-forced-epoch-'))
  try {
    const dir = path.join(cacheRoot, 'datasets', 'events', 'org=hyperparam')
    for (let i = 0; i < 3; i++) {
      await appendRowsToTable(path.join(dir, 'epoch=0'), COLUMNS, [{ id: i, session_id: `s-${i}`, date: '2026-08-01' }])
    }
    await writeCursor(dir, { epoch: 0, rowCount: 3, compaction: null })
    assert.equal(currentPartitionSpec(await loadTableMetadata(path.join(dir, 'epoch=0')))?.fields.length ?? 0, 0)

    const report = await maintainCache({ cacheRoot, compactOnly: true, force: true })

    assert.equal(report.totalFailed, 0, JSON.stringify(report.partitions))
    assert.equal(report.partitions[0].compacted, true)
    const cursor = readCursorSync(dir)
    assert.equal(cursor.epoch, 1, 'the legacy layout advances its epoch')
    const rows = await readRowsFromTable(path.join(dir, 'epoch=1'))
    assert.deepEqual(rows.map((r) => r.id).sort(), [0, 1, 2])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
