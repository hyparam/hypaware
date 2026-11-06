// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { executeSql, collect, readBatchColumn, valueAt } from 'squirreling'
import { appendRowsToTable, dataSourceForTable, deleteMatchingRows } from '../../src/core/cache/iceberg/store.js'
import { createSessionPurgeStore, filterPurgedSessions, sessionGraphNodeId } from '../../src/core/cache/session-purges.js'

test('fenced native scans preserve batches, counts, projection, limits and tenant scope', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'purge-native-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const table = path.join(root, 'table')
  const columns = ['session_id', 'org', 'body', 'node_id'].map(name => ({ name, type: /** @type {const} */ ('STRING'), nullable: true }))
  await appendRowsToTable(table, columns, [
    { session_id: 'target', org: 'a', body: 'hidden' },
    { session_id: 'target', org: 'b', body: 'foreign' },
    { session_id: 'keep', org: 'a', body: 'neighbor' },
    { session_id: 'graph', org: 'a', body: 'hidden graph', node_id: sessionGraphNodeId('target') },
  ])
  const raw = await dataSourceForTable(table)
  assert(raw?.schema && raw.prepareScan)
  const store = createSessionPurgeStore(root)
  store.add('target', 'a')
  const filtered = filterPurgedSessions({ ...raw, scan() { throw new Error('native query fell back to rows') } }, store)
  assert(filtered.schema && filtered.prepareScan && filtered.scanColumn)
  assert.equal(filtered.numRows, undefined)
  const sql = query => collect(executeSql({ query, tables: { t: filtered } }))
  assert.deepEqual(await sql('SELECT COUNT(*) AS n FROM t'), [{ n: 2 }])
  assert.deepEqual(await sql('SELECT body FROM t ORDER BY body LIMIT 1 OFFSET 1'), [{ body: 'neighbor' }])
  assert.deepEqual(await sql("SELECT body FROM t WHERE org = 'b'"), [{ body: 'foreign' }])
  const body = filtered.schema.fields.find(field => field.name === 'body')
  assert(body)
  const prepared = filtered.prepareScan({ columns: [{ field: body.id, phase: 0, mode: 'deferred', purpose: 'output' }], limit: 1, offset: 1 })
  assert.equal(prepared.properties.exactRows, undefined)
  assert.equal(prepared.residual.limit, 1)
  assert.equal(prepared.residual.offset, 1)
  assert.deepEqual(prepared.schema.fields.map(field => field.name), ['body'])
  const values = []
  for await (const batch of prepared.batches()) {
    assert.equal(batch.columns.length, 1)
    const vector = await readBatchColumn({ batch, columnIndex: 0 })
    for (let i = 0; i < vector.length; i++) values.push(valueAt(vector, i))
  }
  assert.deepEqual(values.sort(), ['foreign', 'neighbor'])
  const scan = filtered.scanColumn({ column: 'body' })
  assert('chunks' in scan)
  const chunks = []
  for await (const chunk of scan.chunks()) chunks.push(...Array.from(chunk))
  assert.deepEqual(chunks.sort(), ['foreign', 'neighbor'])
  // Row-only providers also must not advertise an unfiltered exact count.
  const rowOnly = filterPurgedSessions({ columns: raw.columns, numRows: 4, scan: raw.scan.bind(raw) }, store)
  assert.deepEqual(await collect(executeSql({ query: 'SELECT COUNT(*) AS n FROM t', tables: { t: rowOnly } })), [{ n: 2 }])
  store.add('keep', 'a')
  assert.deepEqual(await sql('SELECT COUNT(*) AS n FROM t'), [{ n: 1 }])
})

// @ref LLP 0417#operation [tests]: sources and plans predating the first fence cannot return purged rows
test('first purge fences existing row, column and native plans, including COUNT', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'purge-first-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const table = path.join(root, 'table')
  await appendRowsToTable(table, ['session_id', 'body'].map(name => ({ name, type: /** @type {const} */ ('STRING'), nullable: true })), [
    { session_id: 'target', body: 'hidden' }, { session_id: 'keep', body: 'neighbor' },
  ])
  const raw = await dataSourceForTable(table)
  assert(raw)
  const store = createSessionPurgeStore(root)
  const source = filterPurgedSessions(raw, store)
  const rowOnly = filterPurgedSessions({ columns: raw.columns, numRows: 2, scan: raw.scan.bind(raw) }, store)
  assert(source.prepareScan && source.schema && source.scanColumn)
  const body = source.schema.fields.find(field => field.name === 'body')
  assert(body)
  const prepared = source.prepareScan({ columns: [{ field: body.id, purpose: 'output', phase: 0, mode: 'required' }] })
  const rowScan = rowOnly.scan({ columns: ['body'] })
  const columnScan = source.scanColumn({ column: 'body' })
  const count = executeSql({ query: 'SELECT COUNT(*) AS n FROM t', tables: { t: source } })
  const rowCount = executeSql({ query: 'SELECT COUNT(*) AS n FROM t', tables: { t: rowOnly } })
  // A different store instance models a purge by another process.
  createSessionPurgeStore(root).add('target')
  await deleteMatchingRows(table, row => row.session_id === 'target', { columns: ['session_id'] })
  assert.deepEqual(await collect(count), [{ n: 1 }])
  assert.deepEqual(await collect(rowCount), [{ n: 1 }])
  const rows = []
  for await (const row of rowScan.rows()) rows.push(row.resolved?.body ?? await row.cells?.body?.())
  assert.deepEqual(rows, ['neighbor'])
  assert('chunks' in columnScan)
  const values = []
  for await (const chunk of columnScan.chunks()) values.push(...Array.from(chunk))
  assert.deepEqual(values, ['neighbor'])
  const batches = []
  for await (const batch of prepared.batches()) {
    const vector = await readBatchColumn({ batch, columnIndex: 0 })
    for (let i = 0; i < vector.length; i++) batches.push(valueAt(vector, i))
  }
  assert.deepEqual(batches, ['neighbor'])
})
