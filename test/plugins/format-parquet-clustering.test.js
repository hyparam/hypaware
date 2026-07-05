// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { parquetMetadata, parquetReadObjects } from 'hyparquet'

import { activate } from '../../hypaware-core/plugins-workspace/format-parquet/src/index.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

/** Build the format-parquet encoder via the plugin's activate(). */
async function makeEncoder() {
  /** @type {any} */
  let encoder
  await activate(/** @type {any} */ ({
    config: undefined,
    log: noopLog,
    provideCapability: (_name, _version, value) => { encoder = value },
  }))
  return encoder
}

/** @type {readonly ColumnSpec[]} */
const COLUMNS = [
  { name: 'conversation_id', type: 'STRING', nullable: false },
  { name: 'tools', type: 'STRING', nullable: true },
]

/**
 * Conversation-contiguous rows (the order `readRows` yields). Each
 * conversation repeats one wide `tools` blob; the blob differs per
 * conversation, so the column has `nConvs` distinct values total: enough
 * distinct ~20 KB blobs to exceed hyparquet-writer's 1 MiB dictionary cap
 * when they all land in one row group.
 *
 * @param {number} nConvs
 * @param {number} rowsPerConv
 */
async function* genRows(nConvs, rowsPerConv) {
  for (let c = 0; c < nConvs; c++) {
    const conversation_id = `conv-${c}`
    const tools = JSON.stringify({ schema: 'x'.repeat(20_000), conv: conversation_id })
    for (let r = 0; r < rowsPerConv; r++) {
      yield { conversation_id, tools }
    }
  }
}

/**
 * Collect, per column, the set of Parquet encodings across all row groups.
 *
 * @param {Uint8Array} bytes
 * @returns {{ rowGroups: number, encodingsByColumn: Map<string, Set<string>> }}
 */
function columnEncodings(bytes) {
  const ab = /** @type {ArrayBuffer} */ (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const md = parquetMetadata(ab)
  /** @type {Map<string, Set<string>>} */
  const encodingsByColumn = new Map()
  for (const rg of md.row_groups) {
    for (const col of rg.columns) {
      const name = col.meta_data?.path_in_schema.join('.') ?? ''
      const set = encodingsByColumn.get(name) ?? new Set()
      for (const e of col.meta_data?.encodings ?? []) set.add(String(e))
      encodingsByColumn.set(name, set)
    }
  }
  return { rowGroups: md.row_groups.length, encodingsByColumn }
}

const N_CONVS = 70
const ROWS_PER_CONV = 8

test('without clustering, a wide per-conversation column falls back to PLAIN (the bug)', async () => {
  const encoder = await makeEncoder()
  const blob = await encoder.encodePartition(
    { dataset: 'ai_gateway_messages', partition: {} },
    { log: noopLog, tempDir: '/tmp', columns: COLUMNS, rows: genRows(N_CONVS, ROWS_PER_CONV) }
    // no clusterColumns
  )
  const { rowGroups, encodingsByColumn } = columnEncodings(blob.bytes)
  assert.equal(rowGroups, 1, 'all rows land in a single default row group')
  const tools = encodingsByColumn.get('tools') ?? new Set()
  assert.ok(
    !tools.has('RLE_DICTIONARY') && !tools.has('PLAIN_DICTIONARY'),
    `expected tools to be PLAIN (dictionary busted), got ${[...tools].join(',')}`
  )
})

test('with clustering, the wide column stays dictionary-encoded and the file shrinks', async () => {
  const encoder = await makeEncoder()

  const plain = await encoder.encodePartition(
    { dataset: 'ai_gateway_messages', partition: {} },
    { log: noopLog, tempDir: '/tmp', columns: COLUMNS, rows: genRows(N_CONVS, ROWS_PER_CONV) }
  )
  const clustered = await encoder.encodePartition(
    { dataset: 'ai_gateway_messages', partition: {} },
    {
      log: noopLog,
      tempDir: '/tmp',
      columns: COLUMNS,
      rows: genRows(N_CONVS, ROWS_PER_CONV),
      clusterColumns: ['conversation_id'],
    }
  )

  const { rowGroups, encodingsByColumn } = columnEncodings(clustered.bytes)
  assert.ok(rowGroups > 1, `clustered output should split into multiple row groups, got ${rowGroups}`)
  const tools = encodingsByColumn.get('tools') ?? new Set()
  assert.ok(
    tools.has('RLE_DICTIONARY'),
    `expected tools to be dictionary-encoded under clustering, got ${[...tools].join(',')}`
  )

  // Same rows, same codec: the only difference is row-group clustering, which
  // keeps the repeated blob stored once per group instead of once per row.
  assert.ok(
    clustered.bytesWritten * 3 < plain.bytesWritten,
    `clustered export should be far smaller: clustered=${clustered.bytesWritten} plain=${plain.bytesWritten}`
  )
})

test('the per-group byte cap splits a single high-volume conversation into multiple row groups', async () => {
  // One conversation -> cluster-key splitting can never trigger (1 distinct
  // key). The only thing that can split this is the per-group BYTE cap, which
  // is the memory bound: the encoder writes a row group and frees it rather
  // than buffering the whole partition. Total estimated bytes (~40 MB) exceed
  // DEFAULT_MAX_GROUP_BYTES (32 MB), so we must see >1 row group.
  const encoder = await makeEncoder()
  async function* oneBigConversation() {
    const tools = JSON.stringify({ schema: 'x'.repeat(20_000) })
    for (let i = 0; i < 1000; i++) yield { conversation_id: 'conv-0', tools }
  }
  const blob = await encoder.encodePartition(
    { dataset: 'ai_gateway_messages', partition: {} },
    {
      log: noopLog,
      tempDir: '/tmp',
      columns: COLUMNS,
      rows: oneBigConversation(),
      clusterColumns: ['conversation_id'],
    }
  )
  const { rowGroups, encodingsByColumn } = columnEncodings(blob.bytes)
  assert.ok(rowGroups >= 2, `byte cap should split into multiple row groups, got ${rowGroups}`)
  assert.equal(blob.rowCount, 1000, 'all rows written exactly once across the split')
  // The split groups each see one distinct blob, so dictionary survives.
  assert.ok((encodingsByColumn.get('tools') ?? new Set()).has('RLE_DICTIONARY'))
})

test('a fat row flushes the group before it is added, so no group overshoots the byte cap', async () => {
  // Each row is ~18 MB estimated, so two rows (~36 MB) exceed the 32 MB cap but
  // one fits. The byte check must run *before* the row is added: otherwise the
  // group accumulates one row, fails the `groupBytes >= cap` test (it is still
  // under), then takes a second fat row to ~36 MB before flushing on the next
  // iteration, overshooting the heap bound by a whole row. With the pre-add
  // check, every fat row lands in its own row group.
  const encoder = await makeEncoder()
  const ROWS = 4
  async function* fatRows() {
    for (let i = 0; i < ROWS; i++) {
      // ~9M UTF-16 chars -> ~18 MB by the estimator. Distinct per row, same
      // conversation so cluster-key splitting can never be the cause.
      yield { conversation_id: 'conv-0', tools: 'x'.repeat(9_000_000) + i }
    }
  }
  const blob = await encoder.encodePartition(
    { dataset: 'ai_gateway_messages', partition: {} },
    {
      log: noopLog,
      tempDir: '/tmp',
      columns: COLUMNS,
      rows: fatRows(),
      clusterColumns: ['conversation_id'],
    }
  )
  assert.equal(blob.rowCount, ROWS, 'all rows written exactly once')
  const ab = /** @type {ArrayBuffer} */ (
    blob.bytes.buffer.slice(blob.bytes.byteOffset, blob.bytes.byteOffset + blob.bytes.byteLength)
  )
  const md = parquetMetadata(ab)
  assert.equal(md.row_groups.length, ROWS, `each fat row should get its own row group, got ${md.row_groups.length}`)
  for (const rg of md.row_groups) {
    assert.equal(Number(rg.num_rows), 1, 'no row group holds two fat rows (which would overshoot the cap)')
  }
})

test('JSON object columns are interned so they dictionary-encode AND round-trip as objects', async () => {
  // The cache stores JSON columns as Iceberg `variant`, so the reader hands
  // them back as parsed objects: a fresh object reference per row even when
  // the content repeats. The writer keys its dictionary by reference, so
  // without help it sees every row as distinct and bails to PLAIN (this is
  // what kept the real `tools` column at >1 GB even with clustering active).
  // Interning identical-content objects to one shared reference lets them
  // dictionary-encode WITHOUT stringifying, so the JSON logical type still
  // round-trips the original object to readers (no double-encoding).
  const encoder = await makeEncoder()
  const cols = [
    { name: 'conversation_id', type: 'STRING', nullable: false },
    { name: 'tools', type: 'JSON', nullable: true },
  ]
  const content = (/** @type {string} */ id) => ({ schema: 'x'.repeat(1000), conv: id, nested: { a: 1 } })
  async function* rows() {
    for (let c = 0; c < 40; c++) {
      const conversation_id = `conv-${c}`
      // Fresh object reference each row, identical content: mirrors the reader.
      for (let r = 0; r < 10; r++) yield { conversation_id, tools: content(conversation_id) }
    }
  }
  const blob = await encoder.encodePartition(
    { dataset: 'ai_gateway_messages', partition: {} },
    { log: noopLog, tempDir: '/tmp', columns: cols, rows: rows(), clusterColumns: ['conversation_id'] }
  )
  // Dedup: dictionary-encoded despite fresh refs.
  const { encodingsByColumn } = columnEncodings(blob.bytes)
  assert.ok(
    (encodingsByColumn.get('tools') ?? new Set()).has('RLE_DICTIONARY'),
    `object-valued JSON column must dictionary-encode after interning, got ${[...(encodingsByColumn.get('tools') ?? [])].join(',')}`
  )
  // No double-encoding: readers get the original object back, not a JSON string.
  const ab = /** @type {ArrayBuffer} */ (
    blob.bytes.buffer.slice(blob.bytes.byteOffset, blob.bytes.byteOffset + blob.bytes.byteLength)
  )
  const read = await parquetReadObjects({ file: ab })
  assert.equal(typeof read[0].tools, 'object', 'JSON column must round-trip as an object, not a JSON-text string')
  assert.deepEqual(read[0].tools, content(String(read[0].conversation_id)), 'round-tripped object must match the original content')
})

test('interning never merges distinct values: BigInt vs same-text string vs sentinel-shaped object', async () => {
  // Three values that a naive key could collapse but which the writer emits
  // differently, so none may be merged:
  //  - {a: 1n}              -> number 1
  //  - {a: "1"}             -> string "1"   (a string-coercing key would merge with 1n)
  //  - {a: {__hyp_bigint__: "1"}} -> that literal object (a sentinel-tagged key would merge with 1n)
  // The plain-JSON.stringify key (with BigInt values left un-interned) keeps
  // all three distinct.
  const encoder = await makeEncoder()
  const cols = [{ name: 'j', type: 'JSON', nullable: true }]
  async function* rows() {
    yield { j: { a: 1n } }
    yield { j: { a: '1' } }
    yield { j: { a: { __hyp_bigint__: '1' } } }
  }
  const blob = await encoder.encodePartition(
    { dataset: 'd', partition: {} },
    { log: noopLog, tempDir: '/tmp', columns: cols, rows: rows() }
  )
  const ab = /** @type {ArrayBuffer} */ (
    blob.bytes.buffer.slice(blob.bytes.byteOffset, blob.bytes.byteOffset + blob.bytes.byteLength)
  )
  const read = await parquetReadObjects({ file: ab })
  assert.equal(typeof read[0].j.a, 'number', 'BigInt row stays numeric')
  assert.equal(read[0].j.a, 1)
  assert.equal(typeof read[1].j.a, 'string', 'string row stays a string')
  assert.equal(read[1].j.a, '1')
  assert.deepEqual(read[2].j.a, { __hyp_bigint__: '1' }, 'sentinel-shaped object stays itself, not merged into the BigInt')
})

test('clusterColumns leaves row counts and schema unchanged', async () => {
  const encoder = await makeEncoder()
  const blob = await encoder.encodePartition(
    { dataset: 'ai_gateway_messages', partition: {} },
    {
      log: noopLog,
      tempDir: '/tmp',
      columns: COLUMNS,
      rows: genRows(5, 3),
      clusterColumns: ['conversation_id'],
    }
  )
  assert.equal(blob.rowCount, 15, 'every row is still written exactly once')
})
