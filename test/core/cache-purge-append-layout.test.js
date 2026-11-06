// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { purgeCache } from '../../src/core/cache/purge.js'
import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToTable, scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { appendRowsToPartition, readCursorSync, writeCursor } from '../../src/core/cache/partition.js'

/** @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js' */

const columns = /** @type {ColumnSpec[]} */ (['session_id', 'org', 'body'].map(name => ({ name, type: 'STRING', nullable: true })))
/** @param {string} dir */
async function rows(dir) {
  const result = []
  for await (const row of scanRowsFromTable(dir)) result.push(row)
  return result
}

test('an epoch append after a purge rewrite keeps every surviving row readable', async t => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-purge-append-'))
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  const storage = createQueryStorageService({ cacheRoot })
  const partition = storage.cacheTablePath('events', ['org=hyperparam', 'date=2026-10-09'])
  const survivors = Array.from({ length: 20 }, (_, i) => ({ session_id: `keep-${i}`, org: 'hyperparam', body: `pre-purge ${i}` }))
  const input = [...survivors, { session_id: 'target', org: 'hyperparam', body: 'purged session' }]
  await appendRowsToTable(path.join(partition, 'epoch=0'), columns, input)
  await writeCursor(partition, { epoch: 0, rowCount: input.length, compaction: null })

  const purged = await purgeCache({ cacheRoot, target: { kind: 'session', id: 'target', org: 'hyperparam' } })
  assert.equal(purged.rowsDeleted, 1)
  const maintained = await maintainCache({ cacheRoot })
  assert.equal(maintained.totalFailed, 0, JSON.stringify(maintained))
  assert.equal(maintained.totalCompacted, 1)
  const rewritten = resolveIcebergDir(partition)
  assert.notEqual(path.basename(rewritten), 'epoch=0')
  assert.equal((await rows(rewritten)).length, survivors.length)
  const cursorAfterRewrite = readCursorSync(partition)

  // The server ingest mover appends through the epoch-layout entry point.
  const late = { session_id: 'late', org: 'hyperparam', body: 'post-purge' }
  await appendRowsToPartition(cacheRoot, 'events', ['org=hyperparam', 'date=2026-10-09'], columns, [late])

  const cursor = readCursorSync(partition)
  assert.equal(cursor.layout, cursorAfterRewrite.layout, 'append preserves the layout the rewrite published')
  assert.equal(cursor.tableDir, cursorAfterRewrite.tableDir, 'append preserves the live generation')
  assert.equal(cursor.rowCount, survivors.length + 1)
  const live = resolveIcebergDir(partition)
  assert.equal(live, rewritten, 'the live generation does not flip back to the purged epoch')
  const bodies = (await rows(live)).map(row => row.body).sort()
  assert.deepEqual(bodies, [...survivors.map(row => row.body), late.body].sort(), 'every non-purged row is still readable')
})
