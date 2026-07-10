// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendRowsToPartition, appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { createQueryRegistry } from '../../src/core/registry/datasets.js'
import {
  aiGatewayDatasetRegistration,
  createDataSource,
  DATASET_NAME,
  discoverParts,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @import { ColumnSpec, QueryScope } from '../../hypaware-plugin-kernel-types.js'
 */

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-ai-gw-${prefix}-`))
}

/** @type {ColumnSpec[]} */
const TEST_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
]

// --- cache partitioning registration ---

test('ai-gateway registers cache partitioning for source columns and iceberg fields', () => {
  const registry = createQueryRegistry()
  const reg = aiGatewayDatasetRegistration()
  registry.registerDataset(reg)
  const dataset = registry.getDataset(DATASET_NAME)
  assert.ok(dataset)
  assert.ok(dataset.cachePartitioning)
  assert.deepEqual(dataset.cachePartitioning.source.columns, ['client_name', 'conversation_source', 'provider'])
  assert.equal(dataset.cachePartitioning.source.fallback, 'unknown')
  // @ref LLP 0030#breaking: the required identity partition field is
  // session_id (always present), not conversation_id (now nullable);
  // conversation_id rides along as a secondary, non-required field.
  assert.equal(dataset.cachePartitioning.iceberg.fields.length, 4)
  assert.equal(dataset.cachePartitioning.iceberg.fields[0].column, 'session_id')
  assert.equal(dataset.cachePartitioning.iceberg.fields[0].required, true)
  assert.equal(dataset.cachePartitioning.iceberg.fields[1].column, 'conversation_id')
  assert.equal(dataset.cachePartitioning.iceberg.fields[1].required, undefined)
  assert.equal(dataset.cachePartitioning.iceberg.fields[2].column, 'cwd')
  assert.equal(dataset.cachePartitioning.iceberg.fields[2].required, undefined)
  assert.equal(dataset.cachePartitioning.iceberg.fields[3].column, 'date')
  assert.equal(dataset.cachePartitioning.iceberg.fields[3].required, true)
})

test('ai-gateway registers sourceSignal proxy so rows forward under a known ingest signal', () => {
  // Load-bearing for the @hypaware/central forward sink: without this the
  // sink falls back to the dataset name ('ai_gateway_messages'), which is
  // not a known signal, and AI-gateway rows never leave the gateway.
  const registry = createQueryRegistry()
  registry.registerDataset(aiGatewayDatasetRegistration())
  const dataset = registry.getDataset(DATASET_NAME)
  assert.ok(dataset)
  assert.equal(dataset.sourceSignal, 'proxy')
})

test('registry rejects cachePartitioning with source column absent from schema', () => {
  const registry = createQueryRegistry()
  assert.throws(
    () => registry.registerDataset({
      name: 'bad_source',
      plugin: 'test',
      schema: { columns: [{ name: 'id', type: 'INT32', nullable: false }] },
      cachePartitioning: {
        source: { columns: ['nonexistent_col'] },
        iceberg: { fields: [] },
      },
      discoverPartitions: () => [],
      createDataSource: () => { throw new Error('unused') },
    }),
    { message: /source column 'nonexistent_col' not found in schema/ }
  )
})

test('registry rejects cachePartitioning with required Iceberg field absent from schema', () => {
  const registry = createQueryRegistry()
  assert.throws(
    () => registry.registerDataset({
      name: 'bad_iceberg',
      plugin: 'test',
      schema: { columns: [{ name: 'id', type: 'INT32', nullable: false }] },
      cachePartitioning: {
        source: { columns: ['id'] },
        iceberg: { fields: [{ column: 'missing_field', transform: 'identity', required: true }] },
      },
      discoverPartitions: () => [],
      createDataSource: () => { throw new Error('unused') },
    }),
    { message: /required Iceberg field 'missing_field' not found in schema/ }
  )
})

test('registry accepts cachePartitioning with optional Iceberg field absent from schema', () => {
  const registry = createQueryRegistry()
  registry.registerDataset({
    name: 'optional_iceberg',
    plugin: 'test',
    schema: { columns: [{ name: 'id', type: 'INT32', nullable: false }] },
    cachePartitioning: {
      source: { columns: ['id'] },
      iceberg: { fields: [{ column: 'optional_col', transform: 'identity' }] },
    },
    discoverPartitions: () => [],
    createDataSource: () => { throw new Error('unused') },
  })
  assert.ok(registry.getDataset('optional_iceberg'))
})

// --- existing tests ---

test('ai-gateway createDataSource honors scope when re-discovering fresh partitions', async () => {
  const cacheRoot = await makeTmpDir('scope')
  try {
    await appendRowsToPartition(
      cacheRoot,
      DATASET_NAME,
      ['client=claude', 'date=2026-05-25'],
      TEST_COLUMNS,
      [{ id: 1, date: '2026-05-25' }]
    )
    await appendRowsToPartition(
      cacheRoot,
      DATASET_NAME,
      ['client=claude', 'date=2026-05-26'],
      TEST_COLUMNS,
      [{ id: 2, date: '2026-05-26' }]
    )

    const storage = createQueryStorageService({ cacheRoot })
    /** @type {QueryScope} */
    const scope = { date: '2026-05-26', limit: 1000 }
    const partitions = await discoverParts({ cacheDir: cacheRoot, scope, config: { version: 2 } })
    const source = await createDataSource(partitions, { scope, storage })

    const seen = []
    for await (const row of source.scan({}).rows()) {
      if (row.resolved) {
        seen.push(row.resolved)
      }
    }

    assert.equal(seen.length, 1)
    assert.equal(seen[0].id, 2)
    assert.equal(seen[0].date, '2026-05-26')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('ai-gateway discoverParts unions legacy and source-table partitions without duplicates', async () => {
  const cacheRoot = await makeTmpDir('union')
  try {
    await appendRowsToSourceTable(
      cacheRoot, DATASET_NAME, ['source=claude'],
      TEST_COLUMNS, [{ id: 1, date: '2026-05-26' }]
    )
    await appendRowsToSourceTable(
      cacheRoot, DATASET_NAME, ['source=codex'],
      TEST_COLUMNS, [{ id: 2, date: '2026-05-26' }]
    )

    const partitions = await discoverParts({ cacheDir: cacheRoot, scope: { limit: 1000 }, config: { version: 2 } })
    const tablePaths = partitions.map(p => p.tablePath)
    const uniquePaths = new Set(tablePaths)
    assert.equal(tablePaths.length, uniquePaths.size, 'no duplicate tablePaths')

    const sourcePartitions = partitions.filter(p => p.partition.source)
    assert.equal(sourcePartitions.length, 2)
    const sources = sourcePartitions.map(p => p.partition.source).sort()
    assert.deepEqual(sources, ['claude', 'codex'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('ai-gateway createDataSource unions legacy and source-table data', async () => {
  const cacheRoot = await makeTmpDir('union-ds')
  try {
    await appendRowsToPartition(
      cacheRoot, DATASET_NAME, ['client=legacy', 'date=2026-05-25'],
      TEST_COLUMNS, [{ id: 1, date: '2026-05-25' }]
    )
    await appendRowsToSourceTable(
      cacheRoot, DATASET_NAME, ['source=claude'],
      TEST_COLUMNS, [{ id: 2, date: '2026-05-26' }]
    )

    const storage = createQueryStorageService({ cacheRoot })
    /** @type {QueryScope} */
    const scope = { limit: 1000 }
    const partitions = await discoverParts({ cacheDir: cacheRoot, scope, config: { version: 2 } })
    const source = await createDataSource(partitions, { scope, storage })

    const seen = []
    for await (const row of source.scan({}).rows()) {
      if (row.resolved) seen.push(row.resolved)
    }

    assert.equal(seen.length, 2)
    const ids = seen.map(r => r.id).sort()
    assert.deepEqual(ids, [1, 2])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('ai-gateway createDataSource pads declared schema columns absent from an old partition', async () => {
  // A v7 column (e.g. git_remote, LLP 0032) read over a pre-v7 partition that
  // physically lacks it must surface as a null-valued column, not throw
  // ColumnNotFoundError. `withSchemaColumns` is the only thing guaranteeing
  // this, and every other test stages partitions that already carry all
  // columns. So without this test a regression dropping the padding would pass
  // the suite while breaking real queries over old data. @ref LLP 0032#capture
  const cacheRoot = await makeTmpDir('schema-pad')
  try {
    // Stage a partition with ONLY id/date: no repo-identity columns at all.
    await appendRowsToSourceTable(
      cacheRoot, DATASET_NAME, ['source=claude'],
      TEST_COLUMNS, [{ id: 1, date: '2026-05-26' }]
    )

    const storage = createQueryStorageService({ cacheRoot })
    /** @type {QueryScope} */
    const scope = { limit: 1000 }
    const partitions = await discoverParts({ cacheDir: cacheRoot, scope, config: { version: 2 } })
    const source = await createDataSource(partitions, { scope, storage })

    // The declared v7 columns are advertised even though the partition lacks them.
    for (const col of ['git_remote', 'head_sha', 'repo_root']) {
      assert.ok(source.columns.includes(col), `source advertises declared column ${col}`)
    }

    // Scanning reads them as null/undefined rather than throwing.
    const seen = []
    for await (const row of source.scan({}).rows()) {
      if (row.resolved) seen.push(row.resolved)
    }
    assert.equal(seen.length, 1)
    assert.equal(seen[0].id, 1)
    assert.equal(seen[0].git_remote ?? null, null, 'absent column reads as null')
    assert.equal(seen[0].repo_root ?? null, null)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('ai-gateway createDataSource streams scanColumn with nulls for a physically absent column', async () => {
  // The column-stream analog of the schema-padding row test above: the
  // engine's streaming-aggregate fast path consumes scanColumn, and a
  // partition that predates a declared column must contribute nulls (never
  // undefined, never a throw) so accumulators see the same value the row
  // path reads. @ref LLP 0055
  const cacheRoot = await makeTmpDir('scan-column')
  try {
    await appendRowsToSourceTable(
      cacheRoot, DATASET_NAME, ['source=claude'],
      TEST_COLUMNS, [{ id: 1, date: '2026-05-26' }, { id: 2, date: '2026-05-27' }]
    )

    const storage = createQueryStorageService({ cacheRoot })
    /** @type {QueryScope} */
    const scope = { limit: 1000 }
    const partitions = await discoverParts({ cacheDir: cacheRoot, scope, config: { version: 2 } })
    const source = await createDataSource(partitions, { scope, storage })

    assert.equal(typeof source.scanColumn, 'function', 'the storage-backed source streams columns')
    const scanColumn = /** @type {NonNullable<typeof source.scanColumn>} */ (source.scanColumn)

    /** @type {unknown[]} */
    const ids = []
    for await (const chunk of scanColumn({ column: 'id' })) {
      for (let i = 0; i < chunk.length; i++) ids.push(chunk[i])
    }
    assert.deepEqual([...ids].sort(), [1, 2], 'a physical column streams its values')

    /** @type {unknown[]} */
    const absent = []
    for await (const chunk of scanColumn({ column: 'git_remote' })) {
      for (let i = 0; i < chunk.length; i++) absent.push(chunk[i])
    }
    assert.equal(absent.length, 2)
    for (const v of absent) assert.strictEqual(v, null, 'absent column streams null, not undefined')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
