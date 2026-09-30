// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { collect, executeSql } from 'squirreling'

import { readCursorSync } from '../../src/core/cache/partition.js'
import { reconcileRowsInTable } from '../../src/core/cache/iceberg/store.js'
import { createSessionPurgeStore } from '../../src/core/cache/session-purges.js'
import { createLocalIcebergIO } from '../../src/core/cache/iceberg/resolver.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { DEFAULT_SPOOL_BYTES_THRESHOLD, SPOOL_DIR } from '../../src/core/cache/spool.js'
import { withLogRecords } from '../helpers/log_records.js'

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

test('local cache reader reads ranges without loading the whole file', async (t) => {
  const dir = await makeTmpDir('range-reader')
  const filename = path.join(dir, 'file with spaces.bin')
  try {
    await fs.writeFile(filename, Buffer.from('0123456789'))
    const { resolver } = await createLocalIcebergIO()
    const readFileSync = fsSync.readFileSync
    const wholeReads = t.mock.method(fsSync, 'readFileSync', function (...args) {
      assert.notEqual(args[0], filename, 'range reads must not load the entire file')
      return Reflect.apply(readFileSync, fsSync, args)
    })
    try {
      for (const target of [filename, pathToFileURL(filename).href]) {
        const file = await resolver.reader(target)
        assert.equal(file.byteLength, 10)
        assert.equal(Buffer.from(await file.slice(3, 7)).toString(), '3456')
        assert.equal(Buffer.from(await file.slice(8)).toString(), '89')
        assert.equal((await file.slice(5, 5)).byteLength, 0)
      }
    } finally {
      wholeReads.mock.restore()
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
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

test('storage.readRowsWhere filters on a sorted lookup column across date partitions', async () => {
  const cacheRoot = await makeTmpDir('read-rows-where')
  try {
    /** @type {CachePartitioningDeclaration} */
    const declaration = {
      source: { columns: ['client_name'], fallback: 'unknown' },
      iceberg: {
        fields: [
          { column: 'session_id', transform: 'identity', required: true, sortOnly: true },
          { column: 'date', transform: 'identity', required: true },
        ],
      },
    }
    /** @type {ColumnSpec[]} */
    const columns = [
      { name: 'session_id', type: 'STRING', nullable: false },
      { name: 'date', type: 'STRING', nullable: false },
      { name: 'client_name', type: 'STRING', nullable: false },
      { name: 'part_id', type: 'STRING', nullable: false },
    ]
    const storage = createQueryStorageService({
      cacheRoot,
      getDeclaration: (dataset) => dataset === 'messages' ? declaration : undefined,
    })
    const tablePath = storage.cacheTablePath('messages', ['proxy'])
    await storage.appendRows(tablePath, columns, [
      { session_id: 'wanted', date: '2026-07-01', client_name: 'claude', part_id: 'old#0' },
      { session_id: 'other', date: '2026-08-27', client_name: 'claude', part_id: 'other#0' },
      { session_id: 'wanted', date: '2026-08-27', client_name: 'claude', part_id: 'new#0' },
    ])
    await storage.flushTable(tablePath, { force: true })
    const [partition] = await storage.discoverCachePartitions({ datasets: ['messages'] })
    assert.ok(partition)
    const readRowsWhere = storage.readRowsWhere
    assert.ok(readRowsWhere)

    const found = []
    for await (const row of readRowsWhere(partition.path, ['part_id'], { session_id: ['wanted'] })) {
      found.push(row.part_id)
    }
    assert.deepEqual(found.sort(), ['new#0', 'old#0'])
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
    assert.ok(source.schema, 'storage forwards the public prepared schema')
    assert.equal(typeof source.prepareScan, 'function', 'storage forwards native batches')
    assert.deepEqual(source.schema.fields.map((field) => field.name), ['id', 'value'])

    const rowScan = source.scan
    source.scan = () => { throw new Error('legacy row scan should not run') }
    const preparedRows = await collect(executeSql({
      tables: { t: source },
      query: 'SELECT id, value FROM t',
    }))
    assert.deepEqual(preparedRows, [{ id: 7, value: 'kept' }], 'prepared scan returns only public fields')
    source.scan = rowScan

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

// @ref LLP 0449#reconciliation [tests]: real legacy/spooled rows, isolation and failure atomicity.
test('snapshot reconciliation drains legacy spool, isolates sessions, rolls back failed replacement and respects purge', async t => {
  const cacheRoot = await makeTmpDir('reconcile')
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  const storage = createQueryStorageService({ cacheRoot })
  assert.ok(storage.reconcileRows)
  /** @type {ColumnSpec[]} */
  const columns = ['client_name', 'session_id', 'part_id', 'content_text'].map(name => ({ name, type: 'STRING', nullable: false }))
  const scope = { where: { client_name: 'hermes', session_id: 'hermes-s' }, key: 'part_id' }
  const original = { ...scope.where, part_id: 'p1', content_text: 'old' }
  const other = { ...original, session_id: 'hermes-other', part_id: 'p2', content_text: 'keep' }
  const fresh = { ...original, content_text: 'new' }
  await storage.appendRowsToPartition('messages', ['hermes'], columns, [original, other])
  const spoolPath = storage.cacheTablePath('messages', ['backfill'])
  await storage.appendRows(spoolPath, columns, [original])
  assert.equal(await storage.reconcileRows('messages', columns, [fresh], scope), 1)
  await storage.flushAll({ force: true })
  const read = async () => {
    const rows = []
    for (const part of await storage.discoverCachePartitions()) for await (const row of storage.readRows(part.path)) rows.push(row)
    return rows
  }
  assert.deepEqual((await read()).map(row => row.content_text).sort(), ['keep', 'new'])
  assert.equal(await storage.reconcileRows('messages', columns, [fresh], scope), 0)
  const canonical = path.join(cacheRoot, 'datasets/messages/source=hermes')
  // A committed table can outlive a failed first cursor publication.
  await fs.rm(path.join(canonical, 'cursor.json'))
  assert.equal(await storage.reconcileRows('messages', columns, [fresh], scope), 0)
  assert.equal(readCursorSync(canonical).rowCount, 1)
  assert.deepEqual((await read()).map(row => row.content_text).sort(), ['keep', 'new'])
  const reconcile = storage.reconcileRows
  await assert.rejects(() => reconcile('messages', columns, [other], scope), /outside/)
  const table = path.join(cacheRoot, 'datasets/messages/source=hermes/table')
  // An invalid append fails after the transaction staged deletes, before publish.
  await assert.rejects(() => reconcileRowsInTable(table, columns, [{ ...fresh, content_text: 'bad' }], scope,
    async () => /** @type {any} */ ('invalid int64')))
  assert.deepEqual((await read()).map(row => row.content_text).sort(), ['keep', 'new'])
  await storage.reconcileRows('messages', columns, [], scope)
  assert.deepEqual((await read()).map(row => row.content_text), ['keep'])
  createSessionPurgeStore(cacheRoot).add('hermes-s')
  assert.equal(await storage.reconcileRows('messages', columns, [fresh], scope), 0)
  assert.deepEqual((await read()).map(row => row.content_text), ['keep'])
})

// @ref LLP 0449#reconciliation [tests]: a reconciled snapshot carries the dataset's current columns.
test('snapshot reconciliation evolves the table schema for a column the dataset gained', async t => {
  const cacheRoot = await makeTmpDir('reconcile-evolve')
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  /** @type {CachePartitioningDeclaration} */
  const declaration = {
    source: { columns: ['client_name'], fallback: 'unknown' },
    iceberg: { fields: [{ column: 'session_id', transform: 'identity', required: true, sortOnly: true }] },
  }
  const storage = createQueryStorageService({ cacheRoot, getDeclaration: () => declaration })
  /** @param {string[]} names @returns {ColumnSpec[]} */
  const cols = names => names.map(name => ({ name, type: 'STRING', nullable: true }))
  const base = ['client_name', 'session_id', 'part_id', 'content_text']
  const scope = { where: { client_name: 'hermes', session_id: 'hermes-s' }, key: 'part_id' }
  const row = { client_name: 'hermes', session_id: 'hermes-s', part_id: 'p1', content_text: 'old' }
  assert.ok(storage.reconcileRows)
  await storage.reconcileRows('messages', cols(base), [row], scope)
  // The dataset gains a nullable column; the snapshot writer must widen the
  // table in place rather than silently drop the value it cannot store.
  await storage.reconcileRows('messages', cols([...base, 'extra']), [{ ...row, content_text: 'new', extra: 'kept' }], scope)
  const rows = []
  for (const part of await storage.discoverCachePartitions()) {
    for await (const read of storage.readRows(part.path)) rows.push(read)
  }
  assert.deepEqual(rows.map(r => r.content_text), ['new'])
  assert.deepEqual(rows.map(r => r.extra), ['kept'])
})

/** @type {CachePartitioningDeclaration} */
const GATEWAY_PARTITIONING = {
  source: { columns: ['client_name', 'conversation_source', 'provider'], fallback: 'unknown' },
  iceberg: { fields: [{ column: 'session_id', transform: 'identity', required: true, sortOnly: true }] },
}

/** @type {ColumnSpec[]} */
const SNAPSHOT_COLUMNS = ['client_name', 'session_id', 'part_id', 'content_text']
  .map(name => ({ name, type: 'STRING', nullable: false }))

const SNAPSHOT_SCOPE = { where: { client_name: 'hermes', session_id: 'hermes-s' }, key: 'part_id' }

// @ref LLP 0449#reconciliation [tests]: the retirement sweep touches every
// partition, so a cursor only another client's partition can be damaged by
// must not stop this scope committing or retiring what it can reach.
test('snapshot reconciliation commits and retires past a corrupt cursor the scope cannot reach', async t => {
  const cacheRoot = await makeTmpDir('reconcile-foreign-cursor')
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  const storage = createQueryStorageService({ cacheRoot, getDeclaration: () => GATEWAY_PARTITIONING })
  const reconcile = storage.reconcileRows
  assert.ok(reconcile)
  const read = async () => {
    const rows = []
    for (const part of await storage.discoverCachePartitions()) {
      for await (const row of storage.readRows(part.path)) rows.push(row.content_text)
    }
    return rows.sort()
  }
  const stale = { ...SNAPSHOT_SCOPE.where, part_id: 'p1', content_text: 'stale' }
  // A legacy poll partition: no `source=` segment, so the scope's rows can
  // live here and the sweep still has to retire them.
  await storage.appendRowsToPartition('messages', ['backfill'], SNAPSHOT_COLUMNS, [stale])
  // Another client's canonical partition, born the way every one is: through
  // the spool, routed by the same declaration this scope resolves through.
  await storage.appendRows(storage.cacheTablePath('messages', ['live']), SNAPSHOT_COLUMNS,
    [{ client_name: 'claude', session_id: 'claude-s', part_id: 'c1', content_text: 'claude' }])
  await storage.flushAll({ force: true })
  const foreign = path.join(cacheRoot, 'datasets/messages/source=claude')
  const foreignCursor = path.join(foreign, 'cursor.json')
  const repaired = await fs.readFile(foreignCursor, 'utf8')
  await fs.writeFile(foreignCursor, '{ this is not a cursor')

  const { result, records } = await withLogRecords(() => reconcile('messages', SNAPSHOT_COLUMNS,
    [{ ...stale, content_text: 'new' }], SNAPSHOT_SCOPE))
  assert.equal(result, 1, 'the scope still commits its snapshot')
  // The operator is told which partition went unswept, beside the cursor
  // read's own refusal naming why it could not be read.
  const skip = records.find(record => record.body === 'cache.retirement_skipped')
  assert(skip, 'the skipped partition is recorded, not passed over in silence')
  assert.equal(skip.attributes.partition_dir, foreign)
  assert.equal(skip.attributes.error_kind, 'cursor_unreadable')
  assert.equal(skip.attributes.status, 'degraded')
  assert.equal(records.find(r => r.body === 'cache.snapshot_reconciled')?.attributes.retirement_skipped, 1)
  // The damaged partition is left exactly as the operator has to find it.
  assert.equal(await fs.readFile(foreignCursor, 'utf8'), '{ this is not a cursor')
  assert.deepEqual(await read(), ['new'],
    'the stale legacy copy is retired and the unreadable partition reads as empty')
  await fs.writeFile(foreignCursor, repaired)
  assert.deepEqual(await read(), ['claude', 'new'],
    'repairing the cursor brings the other client back with its rows intact')
})

// @ref LLP 0449#reconciliation [tests]: the converse of the skip above. A
// partition whose rows could match the scope is unverifiable while its cursor
// is, so the whole reconcile fails closed rather than leave a duplicate.
test('snapshot reconciliation still refuses a corrupt cursor on a partition that could hold the scope', async t => {
  const cacheRoot = await makeTmpDir('reconcile-reachable-cursor')
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  const storage = createQueryStorageService({ cacheRoot, getDeclaration: () => GATEWAY_PARTITIONING })
  const reconcile = storage.reconcileRows
  assert.ok(reconcile)
  const stale = { ...SNAPSHOT_SCOPE.where, part_id: 'p1', content_text: 'stale' }
  await storage.appendRowsToPartition('messages', ['backfill'], SNAPSHOT_COLUMNS, [stale])
  await fs.writeFile(path.join(cacheRoot, 'datasets/messages/backfill/cursor.json'), '{ this is not a cursor')

  await assert.rejects(() => reconcile('messages', SNAPSHOT_COLUMNS,
    [{ ...stale, content_text: 'new' }], SNAPSHOT_SCOPE), /cursor\.json/)
  assert.equal(fsSync.existsSync(path.join(cacheRoot, 'datasets/messages/source=hermes')), false,
    'nothing is published while a partition that could hold the scope cannot be verified')
})

// @ref LLP 0449#reconciliation [tests]: the skip reads a `source=` segment as
// the value the row resolved to, and `migrateLegacyPartitions` writes that
// segment from `resolveClientName` whatever the dataset declares. A chain
// leading with anything else makes the two disagree, so it proves nothing.
test('snapshot reconciliation refuses a corrupt cursor when the declared chain does not lead with client_name', async t => {
  const cacheRoot = await makeTmpDir('reconcile-unaligned-chain')
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  /** @type {CachePartitioningDeclaration} */
  const unaligned = {
    source: { columns: ['provider', 'client_name'], fallback: 'unknown' },
    iceberg: { fields: [{ column: 'session_id', transform: 'identity', required: true, sortOnly: true }] },
  }
  const storage = createQueryStorageService({ cacheRoot, getDeclaration: () => unaligned })
  const reconcile = storage.reconcileRows
  assert.ok(reconcile)
  /** @type {ColumnSpec[]} */
  const columns = [...SNAPSHOT_COLUMNS, { name: 'provider', type: 'STRING', nullable: false }]
  // The scope pins the chain's first column, so pinning alone lets this through.
  const scope = { where: { ...SNAPSHOT_SCOPE.where, provider: 'openai' }, key: 'part_id' }
  const stale = { ...scope.where, part_id: 'p1', content_text: 'stale' }
  // A migrated partition, labelled the way `migrateLegacyPartitions` labels
  // one: by `resolveClientName`, which reads `client_name`, not `provider`.
  // The scope resolves to `source=openai`, so the labels differ while the rows
  // match, and only a chain leading with `client_name` could rule that out.
  await storage.appendRowsToPartition('messages', ['source=hermes'], columns, [stale])
  await fs.writeFile(path.join(cacheRoot, 'datasets/messages/source=hermes/cursor.json'), '{ this is not a cursor')

  await assert.rejects(() => reconcile('messages', columns,
    [{ ...stale, content_text: 'new' }], scope), /cursor\.json/)
  assert.equal(fsSync.existsSync(path.join(cacheRoot, 'datasets/messages/source=openai')), false,
    'nothing is published while a partition the scope could reach cannot be verified')
})
