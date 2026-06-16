// @ts-check

// Proves issue #102: additive (nullable) column changes evolve the cache table
// schema IN PLACE — the new column is queryable after a plain append, with no
// recreate and no backfill. Old rows read the new column as `null`; new rows
// populate it. Breaking changes still reject. See LLP 0029.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  appendRowsToTable,
  readRowsFromTable,
  currentSchema,
} from '../../src/core/cache/iceberg/store.js'
import { loadLatestFileCatalogMetadata } from 'icebird'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'

/**
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 * @import { CachePartitioningDeclaration } from '../../src/core/cache/types.d.ts'
 */

/** @type {CachePartitioningDeclaration} */
const DECLARATION = {
  source: { columns: ['client_name'], fallback: 'unknown' },
  iceberg: {
    fields: [
      { column: 'conversation_id', transform: 'identity', required: true },
      { column: 'date', transform: 'identity', required: true },
    ],
  },
}

/** @type {ColumnSpec[]} */
const V1_COLUMNS = [
  { name: 'conversation_id', type: 'STRING', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'message', type: 'STRING', nullable: true },
]

/** A new nullable column appended to the schema (the "agent_id v5" case). */
/** @type {ColumnSpec[]} */
const V2_COLUMNS = [
  ...V1_COLUMNS,
  { name: 'agent_id', type: 'STRING', nullable: true },
]

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = path.join(
    os.tmpdir(),
    `hyp-test-schema-evolution-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** @param {string} dir @param {string} columnName */
async function tableHasColumn(dir, columnName) {
  const { resolver, lister } = await createLocalIcebergIO()
  const { metadata } = await loadLatestFileCatalogMetadata({
    tableUrl: tableUrlForDir(dir), resolver, lister,
  })
  const schema = currentSchema(metadata)
  return Boolean(schema?.fields.some(f => f.name === columnName))
}

/**
 * The current-schema field for `columnName`, or undefined. Lets a test assert
 * a column's `required` flag (not just its presence).
 * @param {string} dir @param {string} columnName
 */
async function tableField(dir, columnName) {
  const { resolver, lister } = await createLocalIcebergIO()
  const { metadata } = await loadLatestFileCatalogMetadata({
    tableUrl: tableUrlForDir(dir), resolver, lister,
  })
  return currentSchema(metadata)?.fields.find(f => f.name === columnName)
}

/** @param {string} dir */
async function tableSchemaCount(dir) {
  const { resolver, lister } = await createLocalIcebergIO()
  const { metadata } = await loadLatestFileCatalogMetadata({
    tableUrl: tableUrlForDir(dir), resolver, lister,
  })
  return metadata.schemas.length
}

test('additive nullable column evolves the cache schema in place — new column queryable, no recreate', async () => {
  const dir = await makeTmpDir('additive')
  try {
    // 1. Write a row under the V1 schema.
    await appendRowsToTable(dir, V1_COLUMNS, [
      { conversation_id: 'c1', client_name: 'claude', date: '2026-06-16', message: 'old' },
    ], { declaration: DECLARATION })

    assert.equal(await tableHasColumn(dir, 'agent_id'), false, 'agent_id absent before evolution')

    // 2. Append a row under the V2 schema (new nullable `agent_id`) into the
    //    SAME table dir — no recreate, no separate backfill step.
    await appendRowsToTable(dir, V2_COLUMNS, [
      { conversation_id: 'c2', client_name: 'claude', date: '2026-06-16', message: 'new', agent_id: 'agent-7' },
    ], { declaration: DECLARATION })

    // 3. The table's current schema now carries the new column.
    assert.equal(await tableHasColumn(dir, 'agent_id'), true, 'agent_id present after evolution')

    // 4. Read everything back: old row reads agent_id as null, new row populates it.
    const rows = await readRowsFromTable(dir)
    const byId = new Map(rows.map(r => [r.conversation_id, r]))
    assert.equal(rows.length, 2)
    assert.ok(byId.has('c1') && byId.has('c2'))
    assert.equal(byId.get('c1')?.agent_id ?? null, null, 'old row reads new column as null')
    assert.equal(byId.get('c2')?.agent_id, 'agent-7', 'new row populates the new column')
    // No data loss: the original payload survived the evolution.
    assert.equal(byId.get('c1')?.message, 'old')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('backfill works against the evolved schema — repeated V2 appends keep the new column populated', async () => {
  const dir = await makeTmpDir('backfill')
  try {
    await appendRowsToTable(dir, V1_COLUMNS, [
      { conversation_id: 'c1', client_name: 'claude', date: '2026-06-16', message: 'm1' },
    ], { declaration: DECLARATION })

    // Simulate a backfill: several batches re-projected under the V2 schema.
    for (let i = 2; i <= 4; i++) {
      await appendRowsToTable(dir, V2_COLUMNS, [
        {
          conversation_id: `c${i}`, client_name: 'claude', date: '2026-06-16',
          message: `m${i}`, agent_id: `agent-${i}`,
        },
      ], { declaration: DECLARATION })
    }

    const rows = await readRowsFromTable(dir)
    assert.equal(rows.length, 4)
    const byId = new Map(rows.map(r => [r.conversation_id, r]))
    assert.equal(byId.get('c1')?.agent_id ?? null, null)
    assert.equal(byId.get('c2')?.agent_id, 'agent-2')
    assert.equal(byId.get('c3')?.agent_id, 'agent-3')
    assert.equal(byId.get('c4')?.agent_id, 'agent-4')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('schema evolution is a no-op when columns are unchanged — only one schema persists', async () => {
  const dir = await makeTmpDir('noop')
  try {
    await appendRowsToTable(dir, V1_COLUMNS, [
      { conversation_id: 'c1', client_name: 'claude', date: '2026-06-16', message: 'm1' },
    ], { declaration: DECLARATION })
    await appendRowsToTable(dir, V1_COLUMNS, [
      { conversation_id: 'c2', client_name: 'claude', date: '2026-06-16', message: 'm2' },
    ], { declaration: DECLARATION })

    const { resolver, lister } = await createLocalIcebergIO()
    const { metadata } = await loadLatestFileCatalogMetadata({
      tableUrl: tableUrlForDir(dir), resolver, lister,
    })
    assert.equal(metadata.schemas.length, 1, 'no spurious add-schema commit when schema is unchanged')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('breaking changes still reject after the table exists (no in-place evolution for them)', async () => {
  const dir = await makeTmpDir('breaking')
  try {
    await appendRowsToTable(dir, V1_COLUMNS, [
      { conversation_id: 'c1', client_name: 'claude', date: '2026-06-16', message: 'm1' },
    ], { declaration: DECLARATION })

    // New REQUIRED column — Iceberg can't back-fill it; must reject.
    /** @type {ColumnSpec[]} */
    const requiredAddition = [...V1_COLUMNS, { name: 'must_have', type: 'STRING', nullable: false }]
    await assert.rejects(
      appendRowsToTable(dir, requiredAddition, [
        { conversation_id: 'c2', client_name: 'claude', date: '2026-06-16', message: 'm2', must_have: 'x' },
      ], { declaration: DECLARATION }),
      /new column "must_have" must be nullable/
    )

    // Type change on an existing column — must reject.
    /** @type {ColumnSpec[]} */
    const typeChanged = V1_COLUMNS.map(c =>
      c.name === 'message' ? { ...c, type: /** @type {const} */ ('INT64') } : c
    )
    await assert.rejects(
      appendRowsToTable(dir, typeChanged, [
        { conversation_id: 'c3', client_name: 'claude', date: '2026-06-16', message: 7 },
      ], { declaration: DECLARATION }),
      /column "message" type changed/
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// A non-partition column that starts required, then widens to nullable.
/** @type {ColumnSpec[]} */
const V1_WITH_REQUIRED_NOTE = [
  { name: 'conversation_id', type: 'STRING', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'note', type: 'STRING', nullable: false },
]
/** @type {ColumnSpec[]} */
const V2_NOTE_WIDENED = [
  { name: 'conversation_id', type: 'STRING', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'note', type: 'STRING', nullable: true },
]

test('required→nullable widening evolves the table in place — a later null append lands', async () => {
  // LLP 0029 lists a column that widened required→nullable as additive. The
  // merge keeps the column's field id, so the old id-set "needs evolution"
  // check missed it: the table stayed marked required and a null write was a
  // contract violation. schemaNeedsEvolution now detects the required-flag
  // delta and evolves the table.
  const dir = await makeTmpDir('widen')
  try {
    await appendRowsToTable(dir, V1_WITH_REQUIRED_NOTE, [
      { conversation_id: 'c1', date: '2026-06-16', note: 'present' },
    ], { declaration: DECLARATION })

    const before = await tableField(dir, 'note')
    assert.equal(before?.required, true, 'note starts required')

    // Append the widened schema with a NULL note — only valid if the table
    // schema actually evolved to mark note nullable.
    await appendRowsToTable(dir, V2_NOTE_WIDENED, [
      { conversation_id: 'c2', date: '2026-06-16', note: null },
    ], { declaration: DECLARATION })

    const after = await tableField(dir, 'note')
    assert.equal(after?.required, false, 'note widened to nullable in the current schema')

    const rows = await readRowsFromTable(dir)
    const byId = new Map(rows.map(r => [r.conversation_id, r]))
    assert.equal(rows.length, 2)
    assert.equal(byId.get('c1')?.note, 'present')
    assert.equal(byId.get('c2')?.note ?? null, null, 'the widened-column null row read back')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a rejected append does not advance the table schema (coerce before any commit)', async () => {
  // The new nullable column AND a row that violates an existing required
  // column arrive in the same batch. Coercion runs before evolveSchemaInPlace,
  // so the schema commit never happens — the table is unchanged, not left with
  // schema ahead of data.
  const dir = await makeTmpDir('atomic')
  try {
    await appendRowsToTable(dir, V1_COLUMNS, [
      { conversation_id: 'c1', client_name: 'claude', date: '2026-06-16', message: 'm1' },
    ], { declaration: DECLARATION })

    const schemasBefore = await tableSchemaCount(dir)

    await assert.rejects(
      appendRowsToTable(dir, V2_COLUMNS, [
        // conversation_id is required; null forces coercion to throw.
        { conversation_id: null, client_name: 'claude', date: '2026-06-16', message: 'bad', agent_id: 'a7' },
      ], { declaration: DECLARATION }),
      /required column "conversation_id" got null/
    )

    assert.equal(await tableHasColumn(dir, 'agent_id'), false, 'rejected append did not add the new column')
    assert.equal(await tableSchemaCount(dir), schemasBefore, 'no add-schema commit landed for the rejected batch')

    // The table is still healthy: the original row reads back intact.
    const rows = await readRowsFromTable(dir)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].conversation_id, 'c1')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
