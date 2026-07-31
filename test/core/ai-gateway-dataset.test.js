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
  withSchemaColumns,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @import { ColumnSpec, QueryScope } from '../../collectivus-plugin-kernel-types.js'
 * @import { AsyncDataSource } from 'squirreling'
 * @import { ScanColumnOptions, ScanColumnResults, SqlPrimitive } from 'squirreling/src/types.js'
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

// --- withSchemaColumns scanColumn forward (LLP 0055) ---

/**
 * Build a minimal fake `AsyncDataSource` whose `scanColumn` yields the given
 * per-column value arrays as a single chunk, so tests can assert forwarding
 * without a real icebird-backed source.
 *
 * @param {string[]} columns
 * @param {Record<string, SqlPrimitive[]>} columnValues
 * @returns {AsyncDataSource & { calls: ScanColumnOptions[] }}
 */
function fakeColumnSource(columns, columnValues) {
  /** @type {ScanColumnOptions[]} */
  const calls = []
  return {
    columns,
    numRows: Math.max(0, ...Object.values(columnValues).map((v) => v.length)),
    calls,
    scan() {
      throw new Error('unused in these tests')
    },
    async *scanColumn(options) {
      calls.push(options)
      yield columnValues[options.column] ?? []
    },
  }
}

/**
 * Normalizes squirreling's `scanColumn` return, which is a union: a bare
 * `AsyncIterable` (what every source in this stack yields today) or the
 * newer `ScanColumnResults` wrapper (`.chunks()`); this test stack never
 * produces the latter, but the pinned squirreling@0.16.0 type still declares
 * the union, so consumption has to narrow it. `@ref LLP 0055`.
 *
 * @param {AsyncIterable<ArrayLike<SqlPrimitive>> | ScanColumnResults} result
 * @returns {Promise<SqlPrimitive[]>}
 */
async function collectColumn(result) {
  /** @type {SqlPrimitive[]} */
  const values = []
  const chunks = 'chunks' in result ? result.chunks() : result
  for await (const chunk of chunks) {
    for (const v of Array.from(chunk)) values.push(v)
  }
  return values
}

test('withSchemaColumns forwards scanColumn for a column present on the wrapped source', async () => {
  const source = fakeColumnSource(['id', 'date'], { id: [1, 2, 3] })
  const wrapped = withSchemaColumns(source)
  if (!wrapped.scanColumn) throw new Error('expected withSchemaColumns to expose scanColumn')

  const values = await collectColumn(wrapped.scanColumn({ column: 'id' }))
  assert.deepEqual(values, [1, 2, 3])
  assert.equal(source.calls.length, 1)
  assert.equal(source.calls[0].column, 'id')
})

test('withSchemaColumns null-fills scanColumn for a column absent from the wrapped source', async () => {
  // git_remote is a declared v7 schema column (LLP 0032) that a pre-v7
  // partition physically lacks, matching the row-scan drift test above.
  const source = fakeColumnSource(['id', 'date'], { id: [1, 2, 3] })
  const wrapped = withSchemaColumns(source)
  if (!wrapped.scanColumn) throw new Error('expected withSchemaColumns to expose scanColumn')
  assert.ok(wrapped.columns.includes('git_remote'), 'declared column still advertised')

  const values = await collectColumn(wrapped.scanColumn({ column: 'git_remote' }))
  assert.deepEqual(values, [null, null, null])
  // Never touches the wrapped source's scanColumn for a column it doesn't have.
  assert.equal(source.calls.length, 0)
})

test('withSchemaColumns scanColumn honors limit/offset when null-filling', async () => {
  const source = fakeColumnSource(['id'], { id: [1, 2, 3, 4, 5] })
  const wrapped = withSchemaColumns(source)
  if (!wrapped.scanColumn) throw new Error('expected withSchemaColumns to expose scanColumn')

  const limited = await collectColumn(wrapped.scanColumn({ column: 'git_remote', offset: 1, limit: 2 }))
  assert.deepEqual(limited, [null, null])

  const pastEnd = await collectColumn(wrapped.scanColumn({ column: 'git_remote', offset: 10 }))
  assert.deepEqual(pastEnd, [])
})

test('withSchemaColumns scanColumn never throws over schema drift, for present or absent columns', async () => {
  const source = fakeColumnSource(['id'], { id: [1] })
  const wrapped = withSchemaColumns(source)
  if (!wrapped.scanColumn) throw new Error('expected withSchemaColumns to expose scanColumn')
  const scanColumn = wrapped.scanColumn
  await assert.doesNotReject(() => collectColumn(scanColumn({ column: 'id' })))
  await assert.doesNotReject(() => collectColumn(scanColumn({ column: 'head_sha' })))
  await assert.doesNotReject(() => collectColumn(scanColumn({ column: 'repo_root' })))
})

test('withSchemaColumns omits scanColumn entirely when the wrapped source has none', () => {
  const source = {
    columns: ['id', 'date'],
    numRows: 1,
    scan() {
      return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} }
    },
  }
  const wrapped = withSchemaColumns(source)
  assert.equal(wrapped.scanColumn, undefined, 'no streaming column path when the source cannot stream at all')
})
