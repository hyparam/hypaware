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
import { appendRowsToSourceTable, readCursorSync } from '../../src/core/cache/partition.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'
import { currentPartitionSpec, readRowsFromTable, sortColumnsFromMetadata } from '../../src/core/cache/iceberg/store.js'
import {
  partitionSpecForDeclaration,
  partitionSpecMigrationDue,
  validatePartitionSpecStability,
} from '../../src/core/iceberg/partition-spec.js'

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
