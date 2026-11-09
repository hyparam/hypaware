// @ts-check

// Token usage columns (LLP 0590). Settlement copies each surviving carrier's
// `attributes.usage` into six columns, and cache maintenance backfills them
// into partitions written before they existed, counting each response once.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToPartition, appendRowsToSourceTable, readCursorSync } from '../../src/core/cache/partition.js'
import { readRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { aiGatewayDatasetRegistration } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @import { ColumnSpec, DatasetColumnBackfill, DatasetSettleContext } from '../../hypaware-plugin-kernel-types.js'
 */

const registration = aiGatewayDatasetRegistration()
const declaration = /** @type {NonNullable<typeof registration.cachePartitioning>} */ (registration.cachePartitioning)
const backfill = /** @type {DatasetColumnBackfill} */ (registration.columnBackfill)

/** The columns a partition written before LLP 0590 has. */
/** @type {ColumnSpec[]} */
const OLD_COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'message_id', type: 'STRING', nullable: true },
  { name: 'part_id', type: 'STRING', nullable: true },
  { name: 'request_id', type: 'STRING', nullable: true },
  { name: 'provider', type: 'STRING', nullable: true },
  { name: 'role', type: 'STRING', nullable: true },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'conversation_source', type: 'STRING', nullable: true },
  { name: 'raw_frame', type: 'JSON', nullable: true },
  { name: 'attributes', type: 'JSON', nullable: true },
  { name: 'date', type: 'STRING', nullable: false },
]

const NEW_COLUMNS = [...OLD_COLUMNS, ...backfill.columns]

/**
 * @param {Partial<Record<string, unknown>>} fields
 * @param {Record<string, unknown> | undefined} usage
 */
function row(fields, usage) {
  return {
    session_id: 's1',
    provider: 'anthropic',
    role: 'assistant',
    client_name: 'claude',
    conversation_source: 'claude',
    raw_frame: null,
    date: '2026-10-07',
    ...fields,
    attributes: usage ? { usage } : { other: true },
  }
}

const usage = (/** @type {number} */ output) => ({ input_tokens: 2, output_tokens: output, cache_read_tokens: 460229, cache_write_tokens: 2833 })

/** @param {string} cacheRoot */
function partitionDir(cacheRoot) {
  return path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
}

/** @param {string} dir */
function liveTableDir(dir) {
  return path.join(dir, readCursorSync(dir).tableDir ?? 'table')
}

test('maintenance backfills old partitions and counts each response once', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-usage-backfill-'))
  try {
    // One Claude response recorded by both lanes under different message ids:
    // the transcript copy holds an early streaming count, the other the final.
    await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=claude'], OLD_COLUMNS, [
      row({ message_id: 'm-transcript', part_id: 'p1', request_id: 'req_1' }, usage(5)),
      row({ message_id: 'm-other', part_id: 'p2', request_id: 'req_1', conversation_source: 'claude_code' }, usage(5517)),
      // A second response in the same session, recorded once.
      row({ message_id: 'm-2', part_id: 'p3', request_id: 'req_2' }, usage(40)),
      // A non-carrier row.
      row({ message_id: 'm-2', part_id: 'p4', request_id: 'req_2', role: 'user' }, undefined),
    ], { declaration })
    // A whole row stored twice, from a client whose request ids are not
    // known to name one response: only exact copies collapse.
    const codex = { provider: 'openai', client_name: 'claude', conversation_source: 'codex', message_id: 'c-1', part_id: 'cp1', role: 'assistant', request_id: null }
    await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=claude'], OLD_COLUMNS,
      [row(codex, usage(100)), row(codex, usage(100))], { declaration })

    // Converge the partition first, so only the backfill can make it due.
    const plain = await maintainCache({ cacheRoot, compactOnly: true, getDeclaration: () => declaration })
    assert.equal(plain.partitions[0].backfilled, undefined)
    assert.equal((await maintainCache({ cacheRoot, compactOnly: true, getDeclaration: () => declaration })).totalCompacted, 0)

    const report = await maintainCache({
      cacheRoot,
      compactOnly: true,
      getDeclaration: () => declaration,
      getColumnBackfill: () => backfill,
    })
    assert.equal(report.partitions[0].backfilled, true)

    const rows = await readRowsFromTable(liveTableDir(partitionDir(cacheRoot)))
    assert.equal(rows.length, 6, 'the backfill drops no row')
    const counted = rows.filter((r) => r.output_tokens !== null && r.output_tokens !== undefined)
    assert.deepEqual(
      counted.map((r) => [r.message_id, Number(r.output_tokens)]).sort(),
      [['c-1', 100], ['m-2', 40], ['m-other', 5517]]
    )
    const final = counted.find((r) => r.message_id === 'm-other')
    assert.equal(Number(final?.cache_read_tokens), 460229)
    assert.equal(Number(final?.input_tokens), 2)
    assert.equal(final?.reasoning_tokens ?? null, null, 'a key the usage lacks stays NULL')
    // The JSON copy is written back untouched, so the repair can be redone.
    const transcript = rows.find((r) => r.message_id === 'm-transcript')
    const attrs = typeof transcript?.attributes === 'string' ? JSON.parse(transcript.attributes) : transcript?.attributes
    assert.equal(attrs.usage.output_tokens, 5)

    // Converged: the backfilled generation is never due again.
    const second = await maintainCache({
      cacheRoot,
      compactOnly: true,
      getDeclaration: () => declaration,
      getColumnBackfill: () => backfill,
    })
    assert.equal(second.totalCompacted, 0)
    assert.equal(second.partitions[0].backfilled, undefined)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// The server's mover writes the legacy epoch layout (org=/date= partitions),
// which has no live table stats; the backfill must still find it.
test('maintenance backfills a legacy epoch-layout partition', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-usage-backfill-epoch-'))
  try {
    const segments = ['org=acme', 'date=2026-10-07']
    await appendRowsToPartition(cacheRoot, 'ai_gateway_messages', segments, OLD_COLUMNS, [
      row({ message_id: 'm-transcript', part_id: 'p1', request_id: 'req_1' }, usage(5)),
      row({ message_id: 'm-other', part_id: 'p2', request_id: 'req_1', conversation_source: 'claude_code' }, usage(5517)),
    ])
    const dir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', ...segments)
    assert.equal(readCursorSync(dir).layout, undefined, 'the fixture is the epoch layout')
    await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal((await maintainCache({ cacheRoot, compactOnly: true })).totalCompacted, 0, 'converged without the backfill')
    const report = await maintainCache({ cacheRoot, compactOnly: true, getColumnBackfill: () => backfill })
    assert.equal(report.partitions[0].backfilled, true)
    const rows = await readRowsFromTable(path.join(dir, `epoch=${readCursorSync(dir).epoch}`))
    assert.deepEqual(rows.map((r) => r.output_tokens == null ? null : Number(r.output_tokens)).sort(), [5517, null])
    const second = await maintainCache({ cacheRoot, compactOnly: true, getColumnBackfill: () => backfill })
    assert.equal(second.totalCompacted, 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a partition created with the token columns is not backfilled', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-usage-backfill-fresh-'))
  try {
    await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=claude'], NEW_COLUMNS,
      [{ ...row({ message_id: 'm', part_id: 'p', request_id: 'r' }, usage(7)), output_tokens: 7 }], { declaration })
    const report = await maintainCache({
      cacheRoot,
      compactOnly: true,
      getDeclaration: () => declaration,
      getColumnBackfill: () => backfill,
    })
    assert.equal(report.totalCompacted, 0)
    assert.equal(report.partitions[0].backfilled, undefined)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('settlement copies a carrier usage into the token columns', async () => {
  const settle = /** @type {NonNullable<typeof registration.settleBatch>} */ (registration.settleBatch)
  const rows = [
    { session_id: 's', client_name: 'codex', conversation_source: 'codex', provider: 'openai', role: 'assistant',
      attributes: { usage: { input_tokens: 10, output_tokens: 3, cache_read_tokens: 0, reasoning_tokens: 1, total_tokens: 14 } } },
    { session_id: 's', client_name: 'codex', conversation_source: 'codex', provider: 'openai', role: 'assistant',
      attributes: JSON.stringify({ usage: { input_tokens: 2.5, output_tokens: 'n/a' } }) },
    { session_id: 's', client_name: 'codex', conversation_source: 'codex', provider: 'openai', role: 'user', attributes: { other: 1 } },
  ]
  const out = await settle(rows, /** @type {DatasetSettleContext} */ ({ storage: /** @type {any} */ ({}) }))
  assert.deepEqual(
    [out[0].input_tokens, out[0].output_tokens, out[0].cache_read_tokens, out[0].cache_write_tokens, out[0].reasoning_tokens, out[0].total_tokens],
    [10, 3, 0, null, 1, 14]
  )
  assert.equal(out[1].input_tokens, null, 'a fractional count stays only in the JSON')
  assert.equal(out[1].output_tokens, null)
  assert.equal(out[2].output_tokens, undefined, 'a row without usage is left alone')
})
