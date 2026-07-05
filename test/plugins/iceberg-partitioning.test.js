// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'

import { derivePartitioning } from '../../hypaware-core/plugins-workspace/format-iceberg/src/partitioning.js'
import { commitBatch, probeTable } from '../../hypaware-core/plugins-workspace/format-iceberg/src/commit.js'
import {
  createBlobStoreIO,
  tableUrlForBlobPrefix,
} from '../../hypaware-core/plugins-workspace/format-iceberg/src/blob-io.js'
import { createLocalFsBlobStore } from '../../hypaware-core/plugins-workspace/local-fs/src/blob-store.js'

/**
 * @import { BlobStore, ColumnSpec, DatasetRegistration, HypError } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const AI_GATEWAY_COLUMNS = [
  { name: 'conversation_id', type: 'STRING', nullable: false },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'message', type: 'STRING', nullable: true },
]

/** Minimal registration carrying just what `derivePartitioning` reads. */
const AI_GATEWAY_REG = /** @type {DatasetRegistration} */ (/** @type {unknown} */ ({
  name: 'ai_gateway_messages',
  primaryTimestampColumn: 'message_created_at',
  cachePartitioning: {
    source: { columns: ['client_name'], fallback: 'unknown' },
    iceberg: {
      fields: [
        { column: 'conversation_id', transform: 'identity', required: true },
        { column: 'cwd', transform: 'identity' },
        { column: 'date', transform: 'identity', required: true },
      ],
    },
  },
}))

// --- derivePartitioning (pure) ---

test('derivePartitioning returns null without a registration', () => {
  assert.equal(derivePartitioning(undefined, AI_GATEWAY_COLUMNS), null)
})

test('derivePartitioning returns null when no primaryTimestampColumn', () => {
  const reg = /** @type {DatasetRegistration} */ (/** @type {unknown} */ ({ name: 'x' }))
  assert.equal(derivePartitioning(reg, AI_GATEWAY_COLUMNS), null)
})

test('derivePartitioning returns null when the timestamp column is absent from the schema', () => {
  const reg = /** @type {DatasetRegistration} */ (/** @type {unknown} */ ({
    name: 'x', primaryTimestampColumn: 'not_in_schema',
  }))
  assert.equal(derivePartitioning(reg, AI_GATEWAY_COLUMNS), null)
})

test('derivePartitioning builds day(primaryTimestampColumn) + conversation sort for ai-gateway', () => {
  const p = derivePartitioning(AI_GATEWAY_REG, AI_GATEWAY_COLUMNS)
  assert.ok(p, 'partitioning should be derived')

  // Partition: day(message_created_at) on its schema field id (3), id base 1000.
  assert.equal(p.partitionSpec.fields.length, 1)
  assert.deepEqual(
    { name: p.partitionSpec.fields[0].name, transform: p.partitionSpec.fields[0].transform, src: p.partitionSpec.fields[0]['source-id'] },
    { name: 'message_created_at', transform: 'day', src: 3 }
  )
  assert.equal(p.partitionSpec.fields[0]['field-id'], 1000)
  assert.equal(p.partitionSpecLabel, 'day(message_created_at)')

  // Sort: the dataset's declared identity columns, in order, asc/nulls-last.
  assert.equal(p.sortOrder['order-id'], 1)
  assert.deepEqual(
    p.sortOrder.fields.map((f) => [f['source-id'], f.transform, f.direction, f['null-order']]),
    [[1, 'identity', 'asc', 'nulls-last'], [2, 'identity', 'asc', 'nulls-last'], [4, 'identity', 'asc', 'nulls-last']]
  )
  assert.equal(p.sortOrderLabel, 'conversation_id,cwd,date')
})

test('derivePartitioning day grain is independent of cachePartitioning (does not inherit conversation_id partitioning)', () => {
  const p = derivePartitioning(AI_GATEWAY_REG, AI_GATEWAY_COLUMNS)
  assert.ok(p)
  // The partition axis must be the day grain only: NOT the cache's
  // conversation_id/cwd/date identity partitioning.
  assert.deepEqual(p.partitionSpec.fields.map((f) => f.name), ['message_created_at'])
})

test('derivePartitioning yields an empty (unsorted) order when no cachePartitioning is declared', () => {
  const reg = /** @type {DatasetRegistration} */ (/** @type {unknown} */ ({
    name: 'plain', primaryTimestampColumn: 'message_created_at',
  }))
  const p = derivePartitioning(reg, AI_GATEWAY_COLUMNS)
  assert.ok(p)
  assert.equal(p.partitionSpec.fields.length, 1, 'still day-partitioned')
  assert.equal(p.sortOrder.fields.length, 0)
  assert.equal(p.sortOrder['order-id'], 0)
  assert.equal(p.sortOrderLabel, '')
})

test('derivePartitioning excludes non-identity cachePartitioning fields from the sort', () => {
  const reg = /** @type {DatasetRegistration} */ (/** @type {unknown} */ ({
    name: 'mixed',
    primaryTimestampColumn: 'message_created_at',
    cachePartitioning: {
      source: { columns: [] },
      iceberg: {
        fields: [
          { column: 'conversation_id', transform: 'identity', required: true },
          { column: 'message_created_at', transform: 'day' }, // temporal, not a lookup key
        ],
      },
    },
  }))
  const p = derivePartitioning(reg, AI_GATEWAY_COLUMNS)
  assert.ok(p)
  assert.deepEqual(p.sortOrder.fields.map((f) => f['source-id']), [1])
  assert.equal(p.sortOrderLabel, 'conversation_id')
})

// --- commit integration (real local-fs + icebird) ---

/** @returns {Promise<{ blobStore: BlobStore, baseDir: string, cleanup: () => Promise<void> }>} */
async function freshLocalFsStore() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-iceberg-partition-'))
  return {
    blobStore: createLocalFsBlobStore({ baseDir }),
    baseDir,
    cleanup: () => fs.rm(baseDir, { recursive: true, force: true }),
  }
}

const ROWS = [
  { conversation_id: 'cB', cwd: '/x', message_created_at: '2026-06-04T10:00:00Z', date: '2026-06-04', message: 'b1' },
  { conversation_id: 'cA', cwd: '/x', message_created_at: '2026-06-04T09:00:00Z', date: '2026-06-04', message: 'a1' },
  { conversation_id: 'cB', cwd: '/x', message_created_at: '2026-06-05T10:00:00Z', date: '2026-06-05', message: 'b2' },
  { conversation_id: 'cA', cwd: '/x', message_created_at: '2026-06-05T09:00:00Z', date: '2026-06-05', message: 'a2' },
]

test('commitBatch creates a day-partitioned, conversation-sorted table and buckets rows by day', async () => {
  const fixture = await freshLocalFsStore()
  try {
    const { resolver, lister } = await createBlobStoreIO(fixture.blobStore)
    const tableUrl = tableUrlForBlobPrefix('iceberg/datasets/ai_gateway_messages')
    const partitioning = derivePartitioning(AI_GATEWAY_REG, AI_GATEWAY_COLUMNS)

    const initial = await probeTable(tableUrl, resolver, lister)
    await commitBatch(
      { tableUrl, columns: AI_GATEWAY_COLUMNS, rows: ROWS, resolver, lister, partitioning },
      { exists: initial.exists, metadata: initial.metadata }
    )

    const after = await probeTable(tableUrl, resolver, lister)
    const meta = after.metadata
    assert.ok(meta, 'metadata present')

    // Partition spec: day(message_created_at).
    const spec = meta['partition-specs'].find((s) => s['spec-id'] === meta['default-spec-id'])
    assert.deepEqual((spec?.fields ?? []).map((f) => [f.name, f.transform]), [['message_created_at', 'day']])

    // Sort order recorded and made default.
    const order = (meta['sort-orders'] ?? []).find((o) => o['order-id'] === meta['default-sort-order-id'])
    assert.ok(order && order.fields.length === 3, 'default sort order has the three lookup columns')
    assert.equal(order.fields[0]['source-id'], 1, 'conversation_id leads the sort')

    // 4 rows over 2 days ⇒ exactly 2 data files (one per day partition).
    const dataDir = path.join(fixture.baseDir, 'iceberg', 'datasets', 'ai_gateway_messages', 'data')
    const dataFiles = fsSync.readdirSync(dataDir).filter((f) => f.endsWith('.parquet'))
    assert.equal(dataFiles.length, 2, `expected 2 day-partition files, got ${dataFiles.length}`)

    // The sort must be real on disk, not just recorded metadata: each day
    // file holds cB-then-cA input, so sorted output reads back cA, cB.
    for (const file of dataFiles) {
      const rows = await parquetReadObjects({
        file: await asyncBufferFromFile(path.join(dataDir, file)),
        columns: ['conversation_id'],
      })
      assert.deepEqual(
        rows.map((r) => r.conversation_id),
        ['cA', 'cB'],
        `rows in ${file} must be sorted by conversation_id`
      )
    }
  } finally {
    await fixture.cleanup()
  }
})

test('commitBatch rejects partition-spec drift on a previously-unpartitioned table', async () => {
  const fixture = await freshLocalFsStore()
  try {
    const { resolver, lister } = await createBlobStoreIO(fixture.blobStore)
    const tableUrl = tableUrlForBlobPrefix('iceberg/datasets/ai_gateway_messages')

    // First commit creates the table WITHOUT partitioning (simulates a table
    // written before this spec, or a dataset that later gains a timestamp).
    const initial = await probeTable(tableUrl, resolver, lister)
    await commitBatch(
      { tableUrl, columns: AI_GATEWAY_COLUMNS, rows: [ROWS[0]], resolver, lister },
      { exists: initial.exists, metadata: initial.metadata }
    )

    // Second commit now carries the day-grain partitioning ⇒ drift.
    const partitioning = derivePartitioning(AI_GATEWAY_REG, AI_GATEWAY_COLUMNS)
    const existing = await probeTable(tableUrl, resolver, lister)
    await assert.rejects(
      () =>
        commitBatch(
          { tableUrl, columns: AI_GATEWAY_COLUMNS, rows: [ROWS[1]], resolver, lister, partitioning },
          { exists: existing.exists, metadata: existing.metadata }
        ),
      (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_partition_spec_drift'
    )
  } finally {
    await fixture.cleanup()
  }
})

test('commitBatch rejects reverse drift: null partitioning onto a partitioned table', async () => {
  const fixture = await freshLocalFsStore()
  try {
    const { resolver, lister } = await createBlobStoreIO(fixture.blobStore)
    const tableUrl = tableUrlForBlobPrefix('iceberg/datasets/ai_gateway_messages')

    // First commit creates the table WITH the day-grain partitioning.
    const partitioning = derivePartitioning(AI_GATEWAY_REG, AI_GATEWAY_COLUMNS)
    const initial = await probeTable(tableUrl, resolver, lister)
    await commitBatch(
      { tableUrl, columns: AI_GATEWAY_COLUMNS, rows: [ROWS[0]], resolver, lister, partitioning },
      { exists: initial.exists, metadata: initial.metadata }
    )

    // Second commit derives no partitioning (e.g. the dataset dropped its
    // primaryTimestampColumn) ⇒ reverse drift, must be rejected.
    const existing = await probeTable(tableUrl, resolver, lister)
    await assert.rejects(
      () =>
        commitBatch(
          { tableUrl, columns: AI_GATEWAY_COLUMNS, rows: [ROWS[1]], resolver, lister, partitioning: null },
          { exists: existing.exists, metadata: existing.metadata }
        ),
      (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_partition_spec_drift'
    )
  } finally {
    await fixture.cleanup()
  }
})

test('commitBatch accepts a re-commit with the same derived partitioning (no false drift)', async () => {
  const fixture = await freshLocalFsStore()
  try {
    const { resolver, lister } = await createBlobStoreIO(fixture.blobStore)
    const tableUrl = tableUrlForBlobPrefix('iceberg/datasets/ai_gateway_messages')
    const partitioning = derivePartitioning(AI_GATEWAY_REG, AI_GATEWAY_COLUMNS)

    const initial = await probeTable(tableUrl, resolver, lister)
    await commitBatch(
      { tableUrl, columns: AI_GATEWAY_COLUMNS, rows: [ROWS[0]], resolver, lister, partitioning },
      { exists: initial.exists, metadata: initial.metadata }
    )
    const existing = await probeTable(tableUrl, resolver, lister)
    const result = await commitBatch(
      { tableUrl, columns: AI_GATEWAY_COLUMNS, rows: [ROWS[2]], resolver, lister, partitioning },
      { exists: existing.exists, metadata: existing.metadata }
    )
    assert.ok(result.snapshotId.length > 0, 'second append with stable spec must succeed')
  } finally {
    await fixture.cleanup()
  }
})
