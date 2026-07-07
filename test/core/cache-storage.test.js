// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readCursorSync } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { DEFAULT_SPOOL_BYTES_THRESHOLD, SPOOL_DIR } from '../../src/core/cache/spool.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration } from '../../src/core/cache/types.js'
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

test('spool flush reports rows dropped by required partition validation', async () => {
  const cacheRoot = await makeTmpDir('flush-dropped')
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
          { column: 'date', transform: 'identity', required: true },
        ],
      },
    }
    /** @type {ColumnSpec[]} */
    const columns = [
      { name: 'id', type: 'INT32', nullable: false },
      { name: 'client_name', type: 'STRING', nullable: true },
      { name: 'date', type: 'STRING', nullable: true },
      { name: 'value', type: 'STRING', nullable: true },
    ]

    const storage = createQueryStorageService({
      cacheRoot,
      getDeclaration: (dataset) => dataset === 'declared_ds' ? declaration : undefined,
    })
    const tablePath = storage.cacheTablePath('declared_ds', ['proxy'])

    await storage.appendRows(tablePath, columns, [
      { id: 1, value: 'kept', client_name: 'claude', date: '2026-05-28' },
      { id: 2, value: 'dropped', client_name: 'claude' },
    ])
    const result = await storage.flushTable(tablePath, { force: true })

    assert.equal(result.rowCount, 2)
    assert.equal(result.droppedCount, 1)

    const claudeDir = path.join(cacheRoot, 'datasets', 'declared_ds', 'source=claude')
    const cursor = readCursorSync(claudeDir)
    assert.equal(cursor.rowCount, 1)
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

/* ------------------- readSpooledRows (issue #107) ------------------------ */

/** @param {AsyncIterable<Record<string, unknown>>} gen */
async function drain(gen) {
  /** @type {Record<string, unknown>[]} */
  const out = []
  for await (const row of gen) out.push(row)
  return out
}

test('readSpooledRows yields unflushed rows and goes empty after flush', async () => {
  const cacheRoot = await makeTmpDir('spool-read')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    const tablePath = storage.cacheTablePath('my_ds', ['proxy_messages_v4'])

    await storage.appendRows(tablePath, SIMPLE_COLUMNS, [
      { id: 1, value: 'a' },
      { id: 2, value: 'b' },
    ])

    // Before flush, the rows live only in the spool, invisible to the
    // committed-partition scan but visible to readSpooledRows.
    const pending = await drain(storage.readSpooledRows('my_ds'))
    assert.equal(pending.length, 2)
    assert.deepEqual(pending.map((r) => r.id).sort(), [1, 2])

    await storage.flushTable(tablePath, { force: true })

    // After flush the spool files are gone, so the spool read is empty.
    const afterFlush = await drain(storage.readSpooledRows('my_ds'))
    assert.deepEqual(afterFlush, [])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('readSpooledRows projects to requested columns and filters by dataset', async () => {
  const cacheRoot = await makeTmpDir('spool-read-proj')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    const mine = storage.cacheTablePath('ds_a', ['proxy_messages_v4'])
    const other = storage.cacheTablePath('ds_b', ['proxy_messages_v4'])

    await storage.appendRows(mine, SIMPLE_COLUMNS, [{ id: 1, value: 'keep' }])
    await storage.appendRows(other, SIMPLE_COLUMNS, [{ id: 9, value: 'other' }])

    const rows = await drain(storage.readSpooledRows('ds_a', ['id']))
    assert.equal(rows.length, 1)
    // Projection drops `value`; dataset filter excludes ds_b entirely.
    assert.deepEqual(rows[0], { id: 1 })
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('readSpooledRows skips a parseable envelope missing columns, matching what flush drops', async () => {
  // A parseable spool line whose envelope lacks `columns` is malformed:
  // streamFlushFile drops it and never commits its rows. readSpooledRows
  // must skip the same rows, or backfill would dedupe against (and thus
  // refuse to materialize) rows that flush will never commit.
  const cacheRoot = await makeTmpDir('spool-read-malformed')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    const tablePath = storage.cacheTablePath('mal_ds', ['proxy_messages_v4'])

    // One well-formed row (has columns) and one malformed envelope (no columns).
    await storage.appendRows(tablePath, SIMPLE_COLUMNS, [{ id: 1, value: 'good' }])
    const active = path.join(tablePath, SPOOL_DIR, 'active.jsonl')
    await fs.appendFile(
      active,
      JSON.stringify({ version: 1, rows: [{ id: 2, value: 'flush-would-drop' }] }) + '\n',
    )

    const rows = await drain(storage.readSpooledRows('mal_ds'))
    assert.deepEqual(rows.map((r) => r.id), [1], 'only the well-formed envelope is yielded')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('readSpooledRows on an unknown dataset is an empty stream', async () => {
  const cacheRoot = await makeTmpDir('spool-read-empty')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    assert.deepEqual(await drain(storage.readSpooledRows('nope')), [])
    assert.deepEqual(await drain(storage.readSpooledRows('')), [])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('readSpooledRows streams a large spool file rather than reading it whole (bounded memory, issue #280)', async () => {
  // A spool file can reach DEFAULT_SPOOL_BYTES_THRESHOLD (512 MB) of
  // content-heavy `ai_gateway_messages` envelopes before it flushes. The old
  // reader did `fs.readFile(name, 'utf8')` + `split('\n')`, holding ~2x the file
  // (the whole file as one V8 string plus the split-line array) resident BEFORE
  // yielding a single row: a giant async UTF-8 decode that OOM'd a large-backfill
  // dedupe scan (issue #280). The streaming reader holds only a bounded 64 KB
  // chunk, so heap growth up to the first row must stay far below the file size.
  const cacheRoot = await makeTmpDir('spool-read-bounded')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    const tablePath = storage.cacheTablePath('big_ds', ['proxy_messages_v4'])
    const dir = path.join(tablePath, SPOOL_DIR)
    await fs.mkdir(dir, { recursive: true })

    // ~48 MB of spool: 1024 envelopes, each a ~48 KB content_text row. Written
    // incrementally so the test itself never materializes the whole file.
    const big = 'x'.repeat(48 * 1024)
    const active = path.join(dir, 'active.jsonl')
    const handle = await fs.open(active, 'w')
    try {
      for (let i = 0; i < 1024; i += 1) {
        const line = JSON.stringify({
          version: 1,
          columns: [{ name: 'id' }, { name: 'content_text' }],
          rows: [{ id: i, content_text: big }],
        }) + '\n'
        await handle.write(line)
      }
    } finally {
      await handle.close()
    }
    const fileBytes = (await fs.stat(active)).size

    // Heap growth measured at the moment the FIRST row is yielded. The whole-file
    // reader must have the entire file (as a string) resident by then; the
    // streaming reader holds only one ~64 KB chunk + the current envelope. The gap
    // (~48 MB+ vs < 1 MB) is decisive, so a generous fraction-of-file threshold
    // tolerates GC noise while still failing the whole-file read.
    const before = process.memoryUsage().heapUsed
    let firstRowHeapDelta = Number.POSITIVE_INFINITY
    let count = 0
    for await (const row of storage.readSpooledRows('big_ds')) {
      if (count === 0) firstRowHeapDelta = process.memoryUsage().heapUsed - before
      assert.equal(typeof row.id, 'number')
      count += 1
    }
    assert.equal(count, 1024, 'every spooled row is still yielded')
    assert.ok(
      firstRowHeapDelta < fileBytes / 2,
      `first-row heap delta ${firstRowHeapDelta}B must be far below the ${fileBytes}B file `
        + '(streamed, not read whole)',
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
