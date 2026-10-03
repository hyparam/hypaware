// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { asyncBufferFromFile, parquetMetadataAsync } from 'hyparquet'

import { appendRowsToTable, readRowsFromTable, reconcileRowsInTable } from '../../src/core/cache/iceberg/store.js'
import { INGEST_SEQ_COLUMN } from '../../src/core/cache/streaming-reader.js'

/**
 * Snapshot reconciliation locates one session's rows inside data files that
 * hold many sessions. The scan that finds them is staged: a scope pass over
 * the `where` columns plus the identity key, then a value pass over the rest
 * for the rows that could still match the snapshot.
 *
 * A scan that under-selects fails SILENTLY - a row the scan never reaches is
 * left live beside the replacement the reconcile writes, so every later query
 * sees a stale duplicate and no error says so. So the identity cases below
 * pin the whole outcome (return value, surviving rows, preserved ingest
 * sequences) for every shape the staging could get wrong: one row group,
 * several row groups, several files, a file with nothing in scope, a row that
 * agrees on the scope columns but differs in a wide one, a row identical
 * everywhere, two stored rows claiming one key, and one key's duplicates
 * split across two data files.
 *
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'client_name', type: 'STRING', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'content_text', type: 'STRING', nullable: true },
  { name: 'raw_frame', type: 'STRING', nullable: true },
]

const WRITE_COLUMNS = [...COLUMNS, INGEST_SEQ_COLUMN]

/** @param {string} session @returns {{ where: Record<string, string>, key: string }} */
function scopeFor(session) {
  return { where: { client_name: 'hermes', session_id: session }, key: 'part_id' }
}

/**
 * A stored row. `raw_frame` is the wide column the staged scan must not read
 * outside the candidate range, so it carries real bulk.
 * @param {string} session
 * @param {number} index
 * @param {string} [text]
 */
function storedRow(session, index, text = `text ${session}-${index}`) {
  return {
    client_name: 'hermes',
    session_id: session,
    part_id: `${session}-p${index}`,
    content_text: text,
    raw_frame: JSON.stringify({ session, index, text, blob: 'y'.repeat(512) }),
  }
}

/** @param {string} prefix */
async function makeTable(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `hyp-reconcile-scan-${prefix}-`))
  return { dir, table: path.join(dir, 'table') }
}

/**
 * Write one data file, stamping a distinct ingest sequence on every row so a
 * preserved row is distinguishable from a rewritten one.
 * @param {string} table
 * @param {Record<string, unknown>[]} rows
 * @param {{ from: number }} seq
 */
async function writeDataFile(table, rows, seq) {
  const stamped = rows.map((row) => ({ ...row, [INGEST_SEQ_COLUMN.name]: BigInt(seq.from++) }))
  await appendRowsToTable(table, WRITE_COLUMNS, stamped)
}

/** Allocator matching the kernel's: reconciliation only ever writes above the fixture's range. */
function allocator(start = 1000) {
  let next = BigInt(start)
  return async () => next++
}

/** @param {string} table */
async function liveRows(table) {
  const rows = await readRowsFromTable(table)
  return rows
    .map((row) => ({
      session: String(row.session_id),
      part: String(row.part_id),
      text: String(row.content_text),
      frame: String(row.raw_frame),
      seq: Number(row[INGEST_SEQ_COLUMN.name]),
    }))
    .sort((a, b) => (a.part === b.part ? a.seq - b.seq : a.part < b.part ? -1 : 1))
}

/** @param {string} table @param {string} session */
async function sessionRows(table, session) {
  return (await liveRows(table)).filter((row) => row.session === session)
}

test('reconcile retires and replaces a session held inside one row group', async (t) => {
  const { dir, table } = await makeTable('one-group')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const seq = { from: 1 }
  await writeDataFile(table, [
    storedRow('other', 0),
    storedRow('target', 0),
    storedRow('target', 1),
    storedRow('other', 1),
  ], seq)

  const result = await reconcileRowsInTable(
    table,
    COLUMNS,
    [storedRow('target', 0), storedRow('target', 1, 'edited'), storedRow('target', 2)],
    scopeFor('target'),
    allocator(),
  )
  assert.deepEqual(result, { rowsWritten: 2, rowsDeleted: 1, rowCount: 5 })
  assert.deepEqual(await sessionRows(table, 'target'), [
    { session: 'target', part: 'target-p0', text: 'text target-0', frame: storedRow('target', 0).raw_frame, seq: 2 },
    { session: 'target', part: 'target-p1', text: 'edited', frame: storedRow('target', 1, 'edited').raw_frame, seq: 1000 },
    { session: 'target', part: 'target-p2', text: 'text target-2', frame: storedRow('target', 2).raw_frame, seq: 1001 },
  ])
  // Another session in the same row group keeps its rows and its sequences.
  assert.deepEqual((await sessionRows(table, 'other')).map((row) => [row.part, row.seq]), [['other-p0', 1], ['other-p1', 4]])
})

test('reconcile reaches a session split across row groups', async (t) => {
  const { dir, table } = await makeTable('two-groups')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const seq = { from: 1 }
  // hyparquet-writer closes its first row group at 1000 rows, so target rows
  // at 998..1001 straddle the boundary.
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (let i = 0; i < 998; i++) rows.push(storedRow('filler', i))
  for (let i = 0; i < 4; i++) rows.push(storedRow('target', i))
  for (let i = 998; i < 1200; i++) rows.push(storedRow('filler', i))
  await writeDataFile(table, rows, seq)

  const buffer = await asyncBufferFromFile(await soleDataFile(table))
  const metadata = await parquetMetadataAsync(buffer)
  assert.equal(metadata.row_groups.length, 2, 'fixture must straddle a row-group boundary')
  assert.equal(Number(metadata.row_groups[0].num_rows), 1000)

  const result = await reconcileRowsInTable(
    table,
    COLUMNS,
    // p0 and p2 unchanged (one per row group), p1 and p3 edited (one per group).
    [storedRow('target', 0), storedRow('target', 1, 'edited'), storedRow('target', 2), storedRow('target', 3, 'edited')],
    scopeFor('target'),
    allocator(),
  )
  assert.deepEqual(result, { rowsWritten: 2, rowsDeleted: 2, rowCount: 1204 })
  assert.deepEqual((await sessionRows(table, 'target')).map((row) => [row.part, row.text, row.seq]), [
    ['target-p0', 'text target-0', 999],
    ['target-p1', 'edited', 1000],
    ['target-p2', 'text target-2', 1001],
    ['target-p3', 'edited', 1001],
  ])
  assert.equal((await sessionRows(table, 'filler')).length, 1200)
})

test('reconcile reaches a session split across data files', async (t) => {
  const { dir, table } = await makeTable('two-files')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const seq = { from: 1 }
  await writeDataFile(table, [storedRow('other', 0), storedRow('target', 0), storedRow('target', 1)], seq)
  await writeDataFile(table, [storedRow('target', 2), storedRow('other', 1), storedRow('target', 3)], seq)

  const result = await reconcileRowsInTable(
    table,
    COLUMNS,
    [storedRow('target', 0), storedRow('target', 3, 'edited')],
    scopeFor('target'),
    allocator(),
  )
  assert.deepEqual(result, { rowsWritten: 1, rowsDeleted: 3, rowCount: 4 })
  assert.deepEqual((await sessionRows(table, 'target')).map((row) => [row.part, row.text, row.seq]), [
    ['target-p0', 'text target-0', 2],
    ['target-p3', 'edited', 1000],
  ])
  assert.deepEqual((await sessionRows(table, 'other')).map((row) => [row.part, row.seq]), [['other-p0', 1], ['other-p1', 5]])
})

test('reconcile leaves a data file holding nothing in scope untouched', async (t) => {
  const { dir, table } = await makeTable('no-match')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const seq = { from: 1 }
  await writeDataFile(table, [storedRow('other', 0), storedRow('other', 1)], seq)

  const before = await liveRows(table)
  const result = await reconcileRowsInTable(table, COLUMNS, [storedRow('target', 0)], scopeFor('target'), allocator())
  assert.deepEqual(result, { rowsWritten: 1, rowsDeleted: 0, rowCount: 3 })
  assert.deepEqual((await liveRows(table)).filter((row) => row.session === 'other'), before)

  // And an empty snapshot for an absent session changes nothing at all.
  const empty = await reconcileRowsInTable(table, COLUMNS, [], scopeFor('absent'), allocator(2000))
  assert.deepEqual(empty, { rowsWritten: 0, rowsDeleted: 0, rowCount: 3 })
})

test('reconcile rejects a stored row that agrees on the scope columns but differs in a wide one', async (t) => {
  const { dir, table } = await makeTable('wide-diff')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const seq = { from: 1 }
  const stored = storedRow('target', 0)
  await writeDataFile(table, [stored], seq)

  // Identical client_name, session_id, part_id and content_text; only the
  // widest column differs. The deep-equal must still retire and replace it.
  const snapshot = { ...stored, raw_frame: JSON.stringify({ different: true }) }
  const result = await reconcileRowsInTable(table, COLUMNS, [snapshot], scopeFor('target'), allocator())
  assert.deepEqual(result, { rowsWritten: 1, rowsDeleted: 1, rowCount: 1 })
  assert.deepEqual(await sessionRows(table, 'target'), [
    { session: 'target', part: 'target-p0', text: 'text target-0', frame: snapshot.raw_frame, seq: 1000 },
  ])
})

test('reconcile preserves a row identical in every column, and its ingest sequence', async (t) => {
  const { dir, table } = await makeTable('identical')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const seq = { from: 7 }
  await writeDataFile(table, [storedRow('target', 0), storedRow('target', 1)], seq)

  const result = await reconcileRowsInTable(
    table,
    COLUMNS,
    [storedRow('target', 0), storedRow('target', 1)],
    scopeFor('target'),
    allocator(),
  )
  assert.deepEqual(result, { rowsWritten: 0, rowsDeleted: 0, rowCount: 2 })
  assert.deepEqual((await sessionRows(table, 'target')).map((row) => [row.part, row.seq]), [['target-p0', 7], ['target-p1', 8]])
})

test('reconcile retires every duplicate of one key but the first that matches', async (t) => {
  const { dir, table } = await makeTable('duplicates')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const seq = { from: 1 }
  // Three stored rows claim target-p0 inside one row group. The first is
  // compared against the snapshot and matches, which settles the key, so the
  // other two are retired unread and nothing is written.
  await writeDataFile(table, [storedRow('target', 0), storedRow('target', 0), storedRow('target', 0, 'drifted')], seq)

  const result = await reconcileRowsInTable(table, COLUMNS, [storedRow('target', 0)], scopeFor('target'), allocator())
  assert.deepEqual(result, { rowsWritten: 0, rowsDeleted: 2, rowCount: 1 })
  assert.deepEqual(await sessionRows(table, 'target'), [
    { session: 'target', part: 'target-p0', text: 'text target-0', frame: storedRow('target', 0).raw_frame, seq: 1 },
  ])
})

test('reconcile keeps the duplicate that matches when an earlier one has drifted', async (t) => {
  const { dir, table } = await makeTable('duplicates-drift')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const seq = { from: 1 }
  // The FIRST duplicate is the one that no longer matches, so it is compared,
  // rejected and retired, and the identical twin behind it is the row that
  // survives with the sequence it was written under. Nothing is written.
  await writeDataFile(table, [storedRow('target', 0, 'drifted'), storedRow('target', 0)], seq)

  const result = await reconcileRowsInTable(table, COLUMNS, [storedRow('target', 0)], scopeFor('target'), allocator())
  assert.deepEqual(result, { rowsWritten: 0, rowsDeleted: 1, rowCount: 1 })
  assert.deepEqual((await sessionRows(table, 'target')).map((row) => [row.part, row.text, row.seq]), [['target-p0', 'text target-0', 2]])
})

// The acceptance for #2346: one key's duplicates in two data files. icebird's
// `findDataFileEntries` fills its map inside a `Promise.all` over manifests,
// so which copy the walk meets first is a race. Mirroring two keys forces the
// adversarial order without reaching into icebird: whichever file the walk
// reaches first carries one key's drifted copy beside the other key's equal
// copy, so a first-come claim loses an equal row in EVERY order.
test('reconcile keeps the matching copy of a key duplicated across data files', async (t) => {
  const { dir, table } = await makeTable('duplicates-cross-file')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const seq = { from: 1 }
  await writeDataFile(table, [storedRow('target', 1, 'drifted'), storedRow('target', 2)], seq)
  await writeDataFile(table, [storedRow('target', 1), storedRow('target', 2, 'drifted')], seq)

  const result = await reconcileRowsInTable(table, COLUMNS, [storedRow('target', 1), storedRow('target', 2)], scopeFor('target'), allocator())
  assert.deepEqual(result, { rowsWritten: 0, rowsDeleted: 2, rowCount: 2 })
  assert.deepEqual((await sessionRows(table, 'target')).map((row) => [row.part, row.text, row.seq]), [
    ['target-p1', 'text target-1', 3],
    ['target-p2', 'text target-2', 2],
  ])
})

// The same hazard in the shape #2346 reports it: one key with an equal copy in
// one data file and a drifted copy in another, seeded both ways round and
// repeated, because the outcome must not follow which manifest's read settles
// first. Every run must agree, counters included.
test('reconcile settles a cross-file duplicate identically run to run', async (t) => {
  const { dir } = await makeTable('duplicates-cross-file-runs')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  /** @type {string[]} */
  const outcomes = []
  for (let run = 0; run < 8; run++) {
    for (const driftFirst of [false, true]) {
      const table = path.join(dir, `run${run}-${driftFirst ? 'drift' : 'equal'}`)
      const copies = [storedRow('target', 0), storedRow('target', 0, 'drifted')]
      if (driftFirst) copies.reverse()
      const seq = { from: 1 }
      await writeDataFile(table, [copies[0]], seq)
      await writeDataFile(table, [copies[1]], seq)

      const result = await reconcileRowsInTable(table, COLUMNS, [storedRow('target', 0)], scopeFor('target'), allocator())
      const seqs = (await sessionRows(table, 'target')).map((row) => row.seq).join(',')
      outcomes.push(`${driftFirst ? 'drift-first' : 'equal-first'} written=${result.rowsWritten} deleted=${result.rowsDeleted} seq=${seqs}`)
    }
  }
  // The equal copy survives carrying the sequence it was written under,
  // whichever of the two files holds it, and no run writes a replacement.
  assert.deepEqual([...new Set(outcomes)].sort(), [
    'drift-first written=0 deleted=1 seq=2',
    'equal-first written=0 deleted=1 seq=1',
  ])
})

/** @param {string} table */
async function soleDataFile(table) {
  const dataDir = path.join(table, 'data')
  const names = (await fs.readdir(dataDir)).filter((name) => name.endsWith('.parquet'))
  assert.equal(names.length, 1)
  return path.join(dataDir, names[0])
}

/**
 * An incompressible payload, so the fixture's bytes on disk are the bytes a
 * reader must pull to see them. A fixed seed keeps the file deterministic.
 * @param {number} seed
 * @param {number} bytes
 */
function noise(seed, bytes) {
  let state = seed >>> 0 || 1
  let out = ''
  for (let i = 0; i < bytes; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    out += (state & 0xff).toString(16).padStart(2, '0')
  }
  return out
}

/** Bytes this process has read from files, as the kernel counts them. */
function bytesRead() {
  return Number(/rchar:\s*(\d+)/.exec(fsSync.readFileSync('/proc/self/io', 'utf8'))?.[1])
}

// The acceptance for #2278: one session's reconcile in a many-session file
// must not decode the file's wide columns end to end. `/proc/self/io` counts
// the bytes this process actually pulled off disk, which for a projected
// parquet read is the compressed column chunks the reader decoded plus the
// footer prefetch every reader pays once.
test('reconcile decodes far less than the whole file to find one session', {
  skip: !fsSync.existsSync('/proc/self/io') && 'needs /proc/self/io',
}, async (t) => {
  const { dir, table } = await makeTable('bytes')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (let s = 0; s < 12; s++) {
    for (let i = 0; i < 1000; i++) {
      const index = s * 1000 + i
      rows.push({
        client_name: 'hermes',
        session_id: `s${s}`,
        part_id: `s${s}-p${i}`,
        content_text: `text ${s}-${i}`,
        raw_frame: noise(index + 1, 128),
      })
    }
  }
  await writeDataFile(table, rows, { from: 1 })

  const metadata = await parquetMetadataAsync(await asyncBufferFromFile(await soleDataFile(table)))
  assert.ok(metadata.row_groups.length > 1, 'fixture must hold more than one row group')
  const names = new Set(COLUMNS.map((column) => column.name))
  let fullWidth = 0
  for (const group of metadata.row_groups) {
    for (const column of group.columns) {
      if (names.has(String(column.meta_data?.path_in_schema[0]))) fullWidth += Number(column.meta_data?.total_compressed_size)
    }
  }

  // s0 lives entirely in the first row group and has not changed, so every
  // one of its rows still needs a full-width deep-equal: the worst case for
  // a staged scan, and still far below reading the file full-width.
  const snapshot = rows.slice(0, 1000)
  const before = bytesRead()
  const result = await reconcileRowsInTable(table, COLUMNS, snapshot, scopeFor('s0'), allocator(100000))
  const decoded = bytesRead() - before
  assert.deepEqual(result, { rowsWritten: 0, rowsDeleted: 0, rowCount: 12000 })
  assert.ok(
    decoded < fullWidth / 2,
    `reconcile read ${decoded}B to locate one of twelve sessions; half the file's ${fullWidth}B of data columns is the budget`,
  )
})
