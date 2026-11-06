// @ts-check

// A cursor whose `epoch` is not a number used to read as epoch 0. On a
// legacy epoch-layout partition that names `epoch=0/` as live, so the orphan
// sweep reclaimed the real live generation once it aged past the grace
// window (issue #2522). The reader now refuses the whole cursor instead.
//
// @ref LLP 0323#whole-cursor [tests]: a non-numeric or missing epoch refuses the cursor rather than defaulting to zero.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToPartition, tryReadCursorSync } from '../../src/core/cache/partition.js'
import { appendRowsToTable, readRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { stderrLinesFrom } from '../helpers/stderr_lines.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
]

const STALE = new Date(Date.now() - 5 * 60 * 60 * 1000)
const REFUSAL = 'cursor_unreadable'
const RECOVERY = 'cursor_unreadable_recovered'

/**
 * @param {() => unknown} fn
 * @param {string} token
 * @returns {Promise<string[]>}
 */
function linesFrom(fn, token) {
  return stderrLinesFrom(fn, token, token === REFUSAL ? RECOVERY : undefined)
}

/**
 * @param {string} partitionDir
 * @param {unknown} cursor
 */
async function writeRawCursor(partitionDir, cursor) {
  await fs.writeFile(path.join(partitionDir, 'cursor.json'), JSON.stringify(cursor))
}

/** @param {string} p */
async function pathExists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

test('a cursor whose epoch is not a number reads as null, out loud and once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-epoch-'))
  try {
    /** @type {Record<string, unknown>[]} */
    const bad = [
      { epoch: '2', rowCount: 3, compaction: null },
      { epoch: null, rowCount: 3, compaction: null },
      { epoch: true, rowCount: 3, compaction: null },
      { epoch: { n: 2 }, rowCount: 3, compaction: null },
      { epoch: [2], rowCount: 3, compaction: null },
      { rowCount: 3, compaction: null },
      { rowCount: 3, compaction: null, layout: 'source-table', tableDir: 'table' },
    ]
    for (const cursor of bad) {
      await writeRawCursor(dir, cursor)
      const lines = await linesFrom(() => {
        assert.equal(tryReadCursorSync(dir), null, `${JSON.stringify(cursor)} is not a cursor`)
      }, REFUSAL)
      assert.equal(lines.length, 1, `${JSON.stringify(cursor)} is refused out loud`)
      assert.equal((await linesFrom(() => { tryReadCursorSync(dir) }, REFUSAL)).length, 0,
        'a standing refusal does not repeat itself per read')
      assert.equal((await linesFrom(() => { tryReadCursorSync(dir) }, RECOVERY)).length, 0,
        'and repeated reads do not retract and re-arm it')

      // Repaired, so the next shape starts from a cleared condition.
      await writeRawCursor(dir, { epoch: 2, rowCount: 3, compaction: null })
      const healed = await linesFrom(() => {
        assert.equal(tryReadCursorSync(dir)?.epoch, 2, 'a repaired cursor reads again')
      }, RECOVERY)
      assert.equal(healed.length, 1, 'and the repair retracts the standing refusal once')
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('numeric epochs, legacy and source-table cursors still read', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-epoch-ok-'))
  try {
    for (const epoch of [0, 2]) {
      await writeRawCursor(dir, { epoch, rowCount: 1, compaction: null })
      const cursor = tryReadCursorSync(dir)
      assert.equal(cursor?.epoch, epoch)
      assert.equal(cursor?.layout, undefined, 'a legacy cursor keeps its absent layout')
    }
    await fs.mkdir(path.join(dir, 'table'), { recursive: true })
    await writeRawCursor(dir, { epoch: 0, rowCount: 1, compaction: null, layout: 'source-table' })
    const sourceTable = tryReadCursorSync(dir)
    assert.equal(sourceTable?.layout, 'source-table')
    assert.equal(sourceTable?.tableDir, undefined, 'an absent tableDir stays the pre-tableDir spelling of table')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('maintenance keeps the live epoch=2 generation under a string-epoch cursor', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-epoch-maint-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const partition = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
    // Three generations, each with committed rows; only epoch=2 is live.
    for (const epoch of [0, 1, 2]) {
      await appendRowsToTable(path.join(partition, `epoch=${epoch}`), COLUMNS, [{ id: epoch, session_id: `s-${epoch}` }])
      await fs.utimes(path.join(partition, `epoch=${epoch}`), STALE, STALE)
    }
    await writeRawCursor(partition, { epoch: '2', rowCount: 1, compaction: null })

    await maintainCache({ cacheRoot })

    const live = path.join(partition, 'epoch=2')
    assert.equal(await pathExists(live), true, 'the live generation is not reclaimed as an orphan')
    assert.deepEqual((await readRowsFromTable(live)).map((row) => Number(row.id)), [2], 'and its rows are intact')
    assert.equal(await pathExists(path.join(partition, 'epoch=1')), true,
      'an unreadable cursor names no live generation, so it orphans none')

    // The append still refuses the unreadable cursor rather than writing a
    // guessed epoch=0 (issue #1170).
    await assert.rejects(
      appendRowsToPartition(cacheRoot, 'ai_gateway_messages', ['source=claude'], COLUMNS, [{ id: 9, session_id: 's-9' }]),
      /present but unreadable/
    )

    // Control: repaired to the numeric epoch it meant, the same sweep keeps
    // epoch=2 and reclaims the aged epochs it does not name.
    await writeRawCursor(partition, { epoch: 2, rowCount: 1, compaction: null })
    await maintainCache({ cacheRoot })
    assert.equal(await pathExists(live), true)
    assert.equal(await pathExists(path.join(partition, 'epoch=1')), false, 'the sweep is live on a readable cursor')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
