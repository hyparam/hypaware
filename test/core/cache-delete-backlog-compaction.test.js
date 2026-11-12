// @ts-check

// Deletes never change a table's data-file count, so the growth gate and the
// file heuristics never see them, and the in-place merge only picks fragmented
// files. A converged table whose rows are mostly deleted must still be
// rewritten so reads stop decoding the deletes.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync } from '../../src/core/cache/partition.js'
import { deleteMatchingRows, readRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'
import { loadLatestFileCatalogMetadata } from 'icebird'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
]

const DECLARATION = {
  source: { columns: ['source'] },
  iceberg: { fields: [{ column: 'session_id', transform: 'identity' }] },
}

/** @param {string} dir @returns {string} */
function liveTableDir(dir) {
  return path.join(dir, readCursorSync(dir).tableDir ?? 'table')
}

/** @param {string} tableDir @returns {Promise<Record<string, string>>} */
async function currentSummary(tableDir) {
  const { resolver, lister } = await createLocalIcebergIO()
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: tableUrlForDir(tableDir), resolver, lister })
  const snapshot = (metadata.snapshots ?? []).find((s) => BigInt(s['snapshot-id']) === BigInt(metadata['current-snapshot-id'] ?? -1))
  return /** @type {Record<string, string>} */ (snapshot?.summary ?? {})
}

/**
 * @param {string} cacheRoot
 * @param {number} deleteSessions how many of the four sessions to delete
 */
async function seedConvergedThenDelete(cacheRoot, deleteSessions) {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, session_id: `s-${i % 4}` }))
  await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=claude'], COLUMNS, rows, { declaration: DECLARATION })
  const dir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
  // One file per tuple: the floor. This tick records the baseline.
  await maintainCache({ cacheRoot, compactOnly: true })
  const doomed = new Set(Array.from({ length: deleteSessions }, (_, i) => `s-${i}`))
  await deleteMatchingRows(liveTableDir(dir), (row) => doomed.has(String(row.session_id)), { columns: ['session_id'] })
  return dir
}

test('a converged table whose deletes hide a large share of its rows is rewritten', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-delete-backlog-'))
  try {
    const dir = await seedConvergedThenDelete(cacheRoot, 2)
    assert.equal(Number((await currentSummary(liveTableDir(dir)))['total-position-deletes']), 20, 'fixture: half the rows are deleted')

    const report = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(report.partitions[0].compacted, true, 'the delete backlog makes the partition due')

    const summary = await currentSummary(liveTableDir(dir))
    assert.equal(Number(summary['total-position-deletes'] ?? 0), 0, 'the rewrite drops the deletes')
    const rows = await readRowsFromTable(liveTableDir(dir))
    assert.equal(rows.length, 20)
    assert.ok(!rows.some((r) => r.session_id === 's-0' || r.session_id === 's-1'), 'deleted rows stay deleted')

    const second = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(second.totalCompacted, 0, 'once the deletes are gone the partition converges')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a few deletes below the ratio do not trigger a rewrite', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-delete-backlog-small-'))
  try {
    const dir = await seedConvergedThenDelete(cacheRoot, 0)
    await deleteMatchingRows(liveTableDir(dir), (row) => Number(row.id) < 4, { columns: ['id'] })

    const report = await maintainCache({ cacheRoot, compactOnly: true })
    assert.notEqual(report.partitions[0].compacted, true, '10% deleted stays below the threshold')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
