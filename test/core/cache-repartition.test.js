// @ts-check

// Re-partition migration (LLP 0311): a dataset declaration may demote
// partition columns to sortOnly lookup columns. Existing tables whose
// recorded spec still partitions on a demoted column keep accepting
// appends (the mismatch is a pending migration, not drift), and the next
// maintenance tick rewrites them into a fresh generation under the
// declared layout: partitioned on the remaining fields, sorted by the
// full lookup-column order.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadLatestFileCatalogMetadata } from 'icebird'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { createQueryRegistry } from '../../src/core/registry/datasets.js'
import { appendRowsToSourceTable, readCursorSync } from '../../src/core/cache/partition.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'
import { currentPartitionSpec, readRowsFromTable, sortColumnsFromMetadata } from '../../src/core/cache/iceberg/store.js'
import {
  partitionSpecForDeclaration,
  partitionSpecMigrationDue,
  sortColumnsForDeclaration,
  validatePartitionSpecStability,
} from '../../src/core/iceberg/partition-spec.js'

/**
 * @import { ColumnSpec, DatasetRegistration } from '../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration } from '../../src/core/iceberg/types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
]

/** The pre-migration shape: identity partitioning on the session tuple. */
/** @type {CachePartitioningDeclaration} */
const OLD_DECLARATION = {
  source: { columns: ['source'] },
  iceberg: {
    fields: [
      { column: 'session_id', transform: 'identity', required: true },
      { column: 'date', transform: 'identity', required: true },
    ],
  },
}

/** The post-migration shape: date partitions, session as a sort column. */
/** @type {CachePartitioningDeclaration} */
const NEW_DECLARATION = {
  source: { columns: ['source'] },
  iceberg: {
    fields: [
      { column: 'session_id', transform: 'identity', required: true, sortOnly: true },
      { column: 'date', transform: 'identity', required: true },
    ],
  },
}

const ICEBERG_SCHEMA = {
  'schema-id': 0,
  type: /** @type {const} */ ('struct'),
  fields: [
    { id: 1, name: 'id', required: true, type: /** @type {const} */ ('int') },
    { id: 2, name: 'session_id', required: true, type: /** @type {const} */ ('string') },
    { id: 3, name: 'date', required: true, type: /** @type {const} */ ('string') },
  ],
}

test('sortOnly fields are excluded from the derived partition spec', () => {
  const spec = partitionSpecForDeclaration(NEW_DECLARATION, ICEBERG_SCHEMA)
  assert.deepEqual(spec.fields.map((f) => f.name), ['date'])
  const oldSpec = partitionSpecForDeclaration(OLD_DECLARATION, ICEBERG_SCHEMA)
  assert.deepEqual(oldSpec.fields.map((f) => f.name), ['session_id', 'date'])
})

test('the sort order carries identity lookup columns only', () => {
  assert.deepEqual(
    sortColumnsForDeclaration(NEW_DECLARATION).map((c) => c.column),
    ['session_id', 'date'],
    'partitioned and sortOnly fields alike are sort columns'
  )
  // A cache sort order is recorded as identity on the source column, so a
  // transformed field would declare a sort the declaration never asked for.
  // Same rule the export's sortOrderForLookup applies.
  assert.deepEqual(
    sortColumnsForDeclaration({
      source: { columns: ['source'] },
      iceberg: {
        fields: [
          { column: 'session_id', transform: 'identity', sortOnly: true },
          { column: 'date', transform: 'day' },
        ],
      },
    }).map((c) => c.column),
    ['session_id']
  )
})

test('a recorded spec on a demoted column is a pending migration, not drift', () => {
  const recorded = partitionSpecForDeclaration(OLD_DECLARATION, ICEBERG_SCHEMA)
  // Tolerated: appends keep landing under the recorded spec.
  validatePartitionSpecStability(NEW_DECLARATION, recorded, ICEBERG_SCHEMA)
  assert.equal(partitionSpecMigrationDue(NEW_DECLARATION, recorded), true)

  // Converged: the declaration matches the migrated table.
  const migrated = partitionSpecForDeclaration(NEW_DECLARATION, ICEBERG_SCHEMA)
  assert.equal(partitionSpecMigrationDue(NEW_DECLARATION, migrated), false)

  // Still drift: a partition column removed from the declaration entirely.
  /** @type {CachePartitioningDeclaration} */
  const dropped = {
    source: { columns: ['source'] },
    iceberg: { fields: [{ column: 'date', transform: 'identity', required: true }] },
  }
  assert.throws(
    () => validatePartitionSpecStability(dropped, recorded, ICEBERG_SCHEMA),
    /was removed/
  )
})

/**
 * A minimal `DatasetRegistration` carrying only the declaration under test;
 * the discovery/data-source members are never called by `registerDataset`.
 *
 * @param {string} name
 * @param {CachePartitioningDeclaration} cachePartitioning
 * @returns {DatasetRegistration}
 */
function registration(name, cachePartitioning) {
  return {
    name,
    plugin: /** @type {DatasetRegistration['plugin']} */ ('test'),
    schema: { columns: COLUMNS },
    cachePartitioning,
    discoverPartitions: () => [],
    createDataSource: () => ({ columns: [], scan: () => ({ appliedWhere: false, appliedLimitOffset: false, async *rows() {} }) }),
  }
}

test('a declaration that demotes every field is refused at registration', () => {
  // Demoting the last partition field creates the cache table unpartitioned
  // AND leaves `validatePartitionSpecStability` with no expected field to
  // check and no recorded field it could reject, so it would accept any spec
  // at all. Refused where the declaration is registered.
  const registry = createQueryRegistry()
  assert.throws(
    () => registry.registerDataset(registration('all_sort_only', {
      source: { columns: ['session_id'] },
      iceberg: {
        fields: [
          { column: 'session_id', transform: 'identity', sortOnly: true },
          { column: 'date', transform: 'identity', sortOnly: true },
        ],
      },
    })),
    /every Iceberg field sortOnly/
  )

  // One partition field left is fine: that is the shape LLP 0311 ships.
  registry.registerDataset(registration('one_partition_field', {
    source: { columns: ['session_id'] },
    iceberg: {
      fields: [
        { column: 'session_id', transform: 'identity', sortOnly: true },
        { column: 'date', transform: 'identity', required: true },
      ],
    },
  }))
  assert.ok(registry.getDataset('one_partition_field'))
})

/**
 * Seed `sessions` session tuples across two days under `declaration`.
 *
 * @param {string} cacheRoot
 * @param {CachePartitioningDeclaration} declaration
 * @param {number} sessions
 */
async function seed(cacheRoot, declaration, sessions) {
  for (const date of ['2026-08-01', '2026-08-02']) {
    const rows = Array.from({ length: sessions }, (_, i) => ({
      id: i,
      session_id: `s-${i}`,
      date,
    }))
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], COLUMNS, rows,
      { declaration }
    )
  }
}

/** @param {string} cacheRoot @returns {string} */
function partitionDir(cacheRoot) {
  return path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
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

test('maintenance migrates a demoted-spec table by generation swap', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-repartition-'))
  try {
    await seed(cacheRoot, OLD_DECLARATION, 4)
    const dir = partitionDir(cacheRoot)
    const generationBefore = readCursorSync(dir).tableDir
    const specBefore = currentPartitionSpec(await loadTableMetadata(liveTableDir(dir)))
    assert.deepEqual(specBefore?.fields.map((f) => f.name), ['session_id', 'date'])

    // An append under the NEW declaration still lands: pending migration
    // must not brick the flush path.
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], COLUMNS,
      [{ id: 99, session_id: 's-0', date: '2026-08-02' }],
      { declaration: NEW_DECLARATION }
    )

    const report = await maintainCache({
      cacheRoot,
      compactOnly: true,
      getDeclaration: () => NEW_DECLARATION,
    })
    const part = report.partitions[0]
    assert.equal(part.compacted, true)
    assert.equal(part.repartitioned, true, 'the swap is reported as the migration it is')

    const cursor = readCursorSync(dir)
    assert.notEqual(cursor.tableDir, generationBefore, 'the migration swaps the generation')
    const metadata = await loadTableMetadata(liveTableDir(dir))
    const spec = currentPartitionSpec(metadata)
    assert.deepEqual(spec?.fields.map((f) => f.name), ['date'], 'the new generation partitions on date alone')
    const sort = sortColumnsFromMetadata(metadata)
    assert.deepEqual(sort?.map((s) => s.column), ['session_id', 'date'], 'the lookup columns become the sort order')
    assert.equal(part.dataFilesAfter, 2, 'one file per day, not one per session tuple')

    // Lossless: every row survives the swap.
    const rows = await readRowsFromTable(liveTableDir(dir))
    assert.equal(rows.length, 9)
    assert.equal(new Set(rows.map((r) => r.session_id)).size, 4)

    // Converged: the next tick neither migrates nor rewrites again.
    const second = await maintainCache({
      cacheRoot,
      compactOnly: true,
      getDeclaration: () => NEW_DECLARATION,
    })
    assert.equal(second.totalCompacted, 0)
    assert.equal(second.partitions[0].repartitioned, undefined)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a fresh table under a sortOnly declaration is born on the new layout', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-repartition-fresh-'))
  try {
    await seed(cacheRoot, NEW_DECLARATION, 3)
    const dir = partitionDir(cacheRoot)
    const metadata = await loadTableMetadata(liveTableDir(dir))
    assert.deepEqual(currentPartitionSpec(metadata)?.fields.map((f) => f.name), ['date'])
    assert.deepEqual(sortColumnsFromMetadata(metadata)?.map((s) => s.column), ['session_id', 'date'])

    // Nothing due: no migration, and two day tuples sit at their floor.
    const report = await maintainCache({
      cacheRoot,
      compactOnly: true,
      getDeclaration: () => NEW_DECLARATION,
    })
    assert.equal(report.totalCompacted, 0)
    assert.equal(report.partitions[0].repartitioned, undefined)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// A `sortOnly` field is carried by `sortColumnsForDeclaration`, which takes
// identity fields only; combined with the partition-spec exclusion that
// leaves a non-identity sortOnly field contributing to neither. Refused at
// registration rather than left to be discovered as a column that silently
// does nothing.
test('a sortOnly field with a non-identity transform is refused at registration', () => {
  const registry = createQueryRegistry()
  assert.throws(
    () => registry.registerDataset(registration('bad_sort_only', {
      source: { columns: ['session_id'] },
      iceberg: {
        fields: [
          { column: 'date', transform: 'day', sortOnly: true },
          { column: 'date', transform: 'identity', required: true },
        ],
      },
    })),
    /sortOnly requires transform 'identity'/
  )
})

// The cache table declares a sort order now, so LLP 0310's in-place merge
// commits a `replace` that looks exactly like the foreign sorted rewrite
// LLP 0207 recognizes. The cursor's recorded snapshot id is the only thing
// telling them apart, so it has to be the id the merge actually committed -
// taken from the commit's own metadata, not from a second read that can
// come back empty.
test('an in-place merge records the snapshot id it committed', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-repartition-inplace-'))
  try {
    // One day, many single-row appends: fragmented enough to be due, and
    // every file sits in the same date partition so the merge has victims.
    for (let i = 0; i < 8; i++) {
      await appendRowsToSourceTable(
        cacheRoot, 'ai_gateway_messages', ['source=claude'], COLUMNS,
        [{ id: i, session_id: `s-${i}`, date: '2026-08-01' }],
        { declaration: NEW_DECLARATION }
      )
    }
    const dir = partitionDir(cacheRoot)
    const generationBefore = readCursorSync(dir).tableDir
    const report = await maintainCache({
      cacheRoot,
      compactOnly: true,
      getDeclaration: () => NEW_DECLARATION,
    })
    assert.equal(report.partitions[0].compacted, true)
    assert.equal(readCursorSync(dir).tableDir, generationBefore, 'merged in place, not swapped')

    const cursor = readCursorSync(dir)
    const compaction = cursor.compaction
    assert.ok(compaction && typeof compaction === 'object')
    const metadata = await loadTableMetadata(liveTableDir(dir))
    const currentId = String(metadata['current-snapshot-id'])
    assert.equal(
      /** @type {Record<string, unknown>} */ (compaction).inPlaceSnapshotId,
      currentId,
      'the cursor claims the snapshot the merge committed'
    )
    const snapshot = (metadata.snapshots ?? []).find((s) => String(s['snapshot-id']) === currentId)
    assert.equal(snapshot?.summary?.operation, 'replace', 'which is the replace foreignSortedReplace would otherwise bless')

    // And so a later tick does not mistake it for a foreign layout.
    const second = await maintainCache({
      cacheRoot,
      compactOnly: true,
      getDeclaration: () => NEW_DECLARATION,
    })
    assert.equal(second.totalRebaselined, 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
