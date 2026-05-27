// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readCursorSync } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { DEFAULT_SPOOL_BYTES_THRESHOLD } from '../../src/core/cache/spool.js'

/**
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 * @import { CachePartitioningDeclaration } from '../../src/core/cache/types.d.ts'
 */

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-cache-storage-${prefix}-`))
}

/** @type {ColumnSpec[]} */
const SIMPLE_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'value', type: 'STRING', nullable: true },
]

test('default spool threshold is Iceberg-sized to avoid frequent small commits', () => {
  assert.equal(DEFAULT_SPOOL_BYTES_THRESHOLD, 512 * 1024 * 1024)
})

test('storage.appendRowsToPartition writes data without error', async () => {
  const cacheRoot = await makeTmpDir('append-meta')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    await storage.appendRowsToPartition(
      'dataset',
      ['all'],
      SIMPLE_COLUMNS,
      [{ id: 1, value: 'a' }]
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('spool flush groups rows by source and creates source-table layout', async () => {
  const cacheRoot = await makeTmpDir('flush-source')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    const tablePath = storage.cacheTablePath('test_data', ['proxy_messages_v4'])

    await storage.appendRows(tablePath, SIMPLE_COLUMNS, [
      { id: 1, value: 'a', client_name: 'claude' },
      { id: 2, value: 'b', client_name: 'codex' },
      { id: 3, value: 'c', client_name: 'claude' },
    ])
    await storage.flushTable(tablePath, { force: true })

    const claudeDir = path.join(cacheRoot, 'datasets', 'test_data', 'source=claude')
    const codexDir = path.join(cacheRoot, 'datasets', 'test_data', 'source=codex')

    const claudeCursor = readCursorSync(claudeDir)
    assert.equal(claudeCursor.layout, 'source-table')
    assert.equal(claudeCursor.rowCount, 2)

    const codexCursor = readCursorSync(codexDir)
    assert.equal(codexCursor.layout, 'source-table')
    assert.equal(codexCursor.rowCount, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('spool flush falls back to source=unknown when no client columns present', async () => {
  const cacheRoot = await makeTmpDir('flush-unknown')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    const tablePath = storage.cacheTablePath('logs', ['spool'])

    await storage.appendRows(tablePath, SIMPLE_COLUMNS, [
      { id: 1, value: 'a' },
    ])
    await storage.flushTable(tablePath, { force: true })

    const unknownDir = path.join(cacheRoot, 'datasets', 'logs', 'source=unknown')
    const cursor = readCursorSync(unknownDir)
    assert.equal(cursor.layout, 'source-table')
    assert.equal(cursor.rowCount, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('storage.dataSourceForTable keeps columns and cells aligned after internal-field filtering', async () => {
  const cacheRoot = await makeTmpDir('row-alignment')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    /** @type {ColumnSpec[]} */
    const columns = [
      { name: 'id', type: 'INT32', nullable: false },
      { name: '_hyp_cache_row_id', type: 'STRING', nullable: true },
      { name: 'value', type: 'STRING', nullable: true },
      { name: '_hyp_cache_batch_id', type: 'STRING', nullable: true },
    ]
    await storage.appendRowsToPartition(
      'dataset',
      ['all'],
      columns,
      [{ id: 7, _hyp_cache_row_id: 'row-7', value: 'kept', _hyp_cache_batch_id: 'batch-1' }]
    )

    const source = await storage.dataSourceForTable(storage.cacheTablePath('dataset', ['all']))
    assert.ok(source)

    const scan = source.scan({})
    for await (const row of scan.rows()) {
      assert.deepEqual(row.columns, ['id', 'value'])
      assert.ok(!row.columns.includes('_hyp_cache_row_id'))
      assert.ok(!row.columns.includes('_hyp_cache_batch_id'))

      if (row.resolved) {
        assert.ok(!('_hyp_cache_row_id' in row.resolved))
        assert.ok(!('_hyp_cache_batch_id' in row.resolved))
      }
      return
    }

    assert.fail('expected one row from data source')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('spool flush creates Iceberg table with partition spec when declaration is provided', async () => {
  const cacheRoot = await makeTmpDir('flush-with-decl')
  try {
    /** @type {CachePartitioningDeclaration} */
    const declaration = {
      source: {
        columns: ['client_name'],
        fallback: 'unknown',
      },
      iceberg: {
        fields: [
          { column: 'client_name', transform: 'identity', required: true },
        ],
      },
    }
    /** @type {ColumnSpec[]} */
    const columns = [
      { name: 'id', type: 'INT32', nullable: false },
      { name: 'client_name', type: 'STRING', nullable: false },
      { name: 'value', type: 'STRING', nullable: true },
    ]

    const storage = createQueryStorageService({
      cacheRoot,
      getDeclaration: (dataset) => dataset === 'declared_ds' ? declaration : undefined,
    })
    const tablePath = storage.cacheTablePath('declared_ds', ['proxy'])

    await storage.appendRows(tablePath, columns, [
      { id: 1, value: 'a', client_name: 'claude' },
    ])
    await storage.flushTable(tablePath, { force: true })

    const tableDir = path.join(cacheRoot, 'datasets', 'declared_ds', 'source=claude', 'table')
    const metadataDir = path.join(tableDir, 'metadata')
    const files = fsSync.readdirSync(metadataDir)
    const metaFile = files.find(f => f.endsWith('.metadata.json'))
    assert.ok(metaFile, 'metadata file should exist')

    const meta = JSON.parse(fsSync.readFileSync(path.join(metadataDir, metaFile), 'utf8'))
    const specs = meta['partition-specs']
    assert.ok(specs, 'partition-specs should be in metadata')
    assert.ok(specs[0].fields.length > 0, 'partition spec should have fields from declaration')
    assert.equal(specs[0].fields[0].name, 'client_name')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('spool flush uses resolveSourceSegments when declaration is provided', async () => {
  const cacheRoot = await makeTmpDir('flush-source-decl')
  try {
    /** @type {CachePartitioningDeclaration} */
    const declaration = {
      source: {
        columns: ['provider', 'conversation_source'],
        fallback: 'default_source',
      },
      iceberg: {
        fields: [],
      },
    }
    const storage = createQueryStorageService({
      cacheRoot,
      getDeclaration: (dataset) => dataset === 'custom_ds' ? declaration : undefined,
    })
    const tablePath = storage.cacheTablePath('custom_ds', ['proxy'])

    await storage.appendRows(tablePath, SIMPLE_COLUMNS, [
      { id: 1, value: 'a', provider: 'anthropic' },
      { id: 2, value: 'b' },
    ])
    await storage.flushTable(tablePath, { force: true })

    const anthropicDir = path.join(cacheRoot, 'datasets', 'custom_ds', 'source=anthropic')
    const defaultDir = path.join(cacheRoot, 'datasets', 'custom_ds', 'source=default_source')

    const anthropicCursor = readCursorSync(anthropicDir)
    assert.equal(anthropicCursor.layout, 'source-table')
    assert.equal(anthropicCursor.rowCount, 1)

    const defaultCursor = readCursorSync(defaultDir)
    assert.equal(defaultCursor.layout, 'source-table')
    assert.equal(defaultCursor.rowCount, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
