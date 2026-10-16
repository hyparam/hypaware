// @ts-check

// Issue #2533: `deleteMatchingRowsAtUrl` takes an optional exact selection of
// live data files. Omitted keeps the whole-table scan, empty deletes nothing,
// the whole selection is validated against the current snapshot before the
// first commit, and unselected files are never opened. Runs against the real
// Iceberg cache, for both the v3 deletion-vector and v2 position-delete paths.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { fileCatalog, icebergCreateTable, loadLatestFileCatalogMetadata } from 'icebird'
import {
  appendRowsToTable,
  deleteMatchingRowsAtUrl,
  listLiveDataFiles,
  readRowsFromTable,
} from '../../src/core/cache/iceberg/store.js'
import { createLocalIcebergIO, tableUrlForDir, urlToPath } from '../../src/core/cache/iceberg/resolver.js'
import { icebergSchemaForColumns } from '../../src/core/cache/iceberg/schema.js'
import * as core from '../../src/core/index.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { TestContext } from 'node:test'
 * @import { Resolver } from 'icebird/src/types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'message', type: 'STRING', nullable: true },
]

/** @param {Record<string, unknown>} row */
const isTarget = (row) => row.session_id === 'target'

/**
 * Three appends, so three live data files. Each holds one target row and one
 * survivor, the mixed-file shape a session purge narrows to.
 *
 * @param {TestContext} t
 * @param {2 | 3} formatVersion
 */
async function makeTable(t, formatVersion) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-delete-selection-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const tablePath = path.join(dir, 'table')
  const tableUrl = tableUrlForDir(tablePath)
  const { resolver, lister } = await createLocalIcebergIO()
  if (formatVersion === 2) {
    const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
    await icebergCreateTable({ catalog, tableUrl, schema: icebergSchemaForColumns(COLUMNS), formatVersion: 2 })
  }
  for (const n of ['a', 'b', 'c']) {
    await appendRowsToTable(tablePath, COLUMNS, [
      { session_id: 'target', message: `target-${n}` },
      { session_id: 'other', message: `other-${n}` },
    ])
  }
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  assert.equal(metadata['format-version'], formatVersion)
  const files = (await listLiveDataFiles(tablePath)).map((f) => f.filePath)
  assert.equal(files.length, 3)
  return { tablePath, tableUrl, resolver, lister, files }
}

/** @param {string} tablePath */
async function messages(tablePath) {
  return (await readRowsFromTable(tablePath)).map((r) => String(r.message)).sort()
}

/** @param {string} tablePath */
async function snapshotCount(tablePath) {
  const { resolver, lister } = await createLocalIcebergIO()
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: tableUrlForDir(tablePath), resolver, lister })
  return metadata.snapshots?.length ?? 0
}

for (const formatVersion of /** @type {const} */ ([3, 2])) {
  test(`v${formatVersion}: omitted selection keeps the whole-table scan`, async (t) => {
    const table = await makeTable(t, formatVersion)
    const result = await deleteMatchingRowsAtUrl({ ...table, predicate: isTarget, columns: ['session_id'] })
    assert.deepEqual(result, { rowsDeleted: 3, filesAffected: 3, batchCount: 1 })
    assert.deepEqual(await messages(table.tablePath), ['other-a', 'other-b', 'other-c'])
  })

  test(`v${formatVersion}: a subset deletes matches only in the selected files and never opens the others`, async (t) => {
    const table = await makeTable(t, formatVersion)
    const [first, second, third] = table.files
    /** @type {string[]} */
    const opened = []
    /** @type {Resolver} */
    const spy = { ...table.resolver, reader: (p) => { opened.push(p); return table.resolver.reader(p) } }
    // Corrupt the unselected file too: if the helper opened it, the read would throw.
    await fs.writeFile(urlToPath(second), 'not parquet')
    const result = await deleteMatchingRowsAtUrl({
      ...table, resolver: spy, predicate: isTarget, columns: ['session_id'], files: [first, third, first],
    })
    assert.deepEqual(result, { rowsDeleted: 2, filesAffected: 2, batchCount: 1 })
    assert.ok(!opened.includes(second), 'unselected data file was opened')
    assert.equal(opened.filter((p) => p === first).length, 1, 'a repeated selection is scanned once')

    // The survivors of the selected files and the untouched file's rows remain.
    const live = await listLiveDataFiles(table.tablePath)
    assert.deepEqual(live.map((f) => f.filePath).sort(), [...table.files].sort())
    const deleted = new Map(live.map((f) => [f.filePath, [...(f.deletedPositions ?? [])]]))
    assert.deepEqual(deleted.get(first), [0n])
    assert.deepEqual(deleted.get(second), [])
    assert.deepEqual(deleted.get(third), [0n])
  })

  test(`v${formatVersion}: an empty selection deletes nothing and commits nothing`, async (t) => {
    const table = await makeTable(t, formatVersion)
    const before = await snapshotCount(table.tablePath)
    const result = await deleteMatchingRowsAtUrl({ ...table, predicate: () => true, columns: [], files: [] })
    assert.deepEqual(result, { rowsDeleted: 0, filesAffected: 0, batchCount: 0 })
    assert.equal(await snapshotCount(table.tablePath), before)
    assert.equal((await messages(table.tablePath)).length, 6)
  })

  test(`v${formatVersion}: a path not live in the current snapshot fails the whole selection before any commit`, async (t) => {
    const table = await makeTable(t, formatVersion)
    const before = await snapshotCount(table.tablePath)
    const [first, second] = table.files
    for (const bad of [`${first}.missing`, 'file:///elsewhere/data.parquet', path.basename(first)]) {
      await assert.rejects(
        deleteMatchingRowsAtUrl({ ...table, predicate: isTarget, columns: ['session_id'], files: [first, second, bad] }),
        /not a live data file in the current snapshot/
      )
    }
    assert.equal(await snapshotCount(table.tablePath), before)
    assert.equal((await messages(table.tablePath)).length, 6)
  })

  test(`v${formatVersion}: rows already deleted in a selected file are not counted again`, async (t) => {
    const table = await makeTable(t, formatVersion)
    const [first] = table.files
    const once = await deleteMatchingRowsAtUrl({ ...table, predicate: isTarget, columns: ['session_id'], files: [first] })
    assert.equal(once.rowsDeleted, 1)
    const again = await deleteMatchingRowsAtUrl({ ...table, predicate: isTarget, columns: ['session_id'], files: [first] })
    assert.deepEqual(again, { rowsDeleted: 0, filesAffected: 0, batchCount: 0 })
    // A later whole-table purge still finds the targets in the other two files only.
    let calls = 0
    const rest = await deleteMatchingRowsAtUrl({
      ...table, predicate: isTarget, columns: ['session_id'], beforeDelete: async () => { calls++ },
    })
    assert.deepEqual(rest, { rowsDeleted: 2, filesAffected: 2, batchCount: 1 })
    assert.equal(calls, 1)
    assert.deepEqual(await messages(table.tablePath), ['other-a', 'other-b', 'other-c'])
  })
}

test('a nonempty selection against a table with no snapshot is rejected', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-delete-selection-empty-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const tableUrl = tableUrlForDir(path.join(dir, 'table'))
  const { resolver, lister } = await createLocalIcebergIO()
  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
  await icebergCreateTable({ catalog, tableUrl, schema: icebergSchemaForColumns(COLUMNS), formatVersion: 3 })
  const args = { tableUrl, resolver, lister, predicate: isTarget, columns: ['session_id'] }
  assert.deepEqual(await deleteMatchingRowsAtUrl({ ...args, files: [] }), { rowsDeleted: 0, filesAffected: 0, batchCount: 0 })
  await assert.rejects(
    deleteMatchingRowsAtUrl({ ...args, files: [`${tableUrl}/data/x.parquet`] }),
    /not a live data file in the current snapshot/
  )
})

test('an unreadable selected file fails the purge rather than reporting zero rows', async (t) => {
  const table = await makeTable(t, 3)
  const [first] = table.files
  await fs.writeFile(urlToPath(first), 'not parquet')
  await assert.rejects(deleteMatchingRowsAtUrl({ ...table, predicate: isTarget, columns: ['session_id'], files: [first] }))
})

test('the package root still exports the deletion primitive', () => {
  assert.equal(core.deleteMatchingRowsAtUrl, deleteMatchingRowsAtUrl)
})
