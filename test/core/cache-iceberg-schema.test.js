// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  basicTypeForIcebergType,
  columnsFromIcebergSchema,
  icebergSchemaForColumns,
  mergeFieldIdsFromTable,
} from '../../src/core/cache/iceberg/schema.js'
import {
  partitionSpecForDeclaration,
  validatePartitionSpecStability,
} from '../../src/core/iceberg/partition-spec.js'
import { appendRowsToTable, readRowsFromTable, tableExists } from '../../src/core/cache/iceberg/store.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration } from '../../src/core/cache/types.js'
 * @import { Schema, PartitionSpec } from 'icebird/src/types.js'
 */

/** @type {CachePartitioningDeclaration} */
const AI_GATEWAY_DECLARATION = {
  source: {
    columns: ['client_name', 'conversation_source', 'provider'],
    fallback: 'unknown',
  },
  iceberg: {
    fields: [
      { column: 'conversation_id', transform: 'identity', required: true },
      { column: 'cwd', transform: 'identity' },
      { column: 'date', transform: 'identity', required: true },
    ],
  },
}

/** @type {ColumnSpec[]} */
const AI_GATEWAY_COLUMNS = [
  { name: 'conversation_id', type: 'STRING', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'conversation_source', type: 'STRING', nullable: true },
  { name: 'provider', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'message', type: 'STRING', nullable: true },
]

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = path.join(
    os.tmpdir(),
    `hyp-test-iceberg-schema-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// --- partitionSpecForDeclaration ---

test('partitionSpecForDeclaration builds spec for ai_gateway_messages', () => {
  const schema = icebergSchemaForColumns(AI_GATEWAY_COLUMNS)
  const spec = partitionSpecForDeclaration(AI_GATEWAY_DECLARATION, schema)

  assert.equal(spec['spec-id'], 0)
  assert.equal(spec.fields.length, 3)

  assert.equal(spec.fields[0].name, 'conversation_id')
  assert.equal(spec.fields[0]['source-id'], 1)
  assert.equal(spec.fields[0]['field-id'], 1000)
  assert.equal(spec.fields[0].transform, 'identity')

  assert.equal(spec.fields[1].name, 'cwd')
  assert.equal(spec.fields[1]['source-id'], 5)
  assert.equal(spec.fields[1]['field-id'], 1001)
  assert.equal(spec.fields[1].transform, 'identity')

  assert.equal(spec.fields[2].name, 'date')
  assert.equal(spec.fields[2]['source-id'], 6)
  assert.equal(spec.fields[2]['field-id'], 1002)
  assert.equal(spec.fields[2].transform, 'identity')
})

test('partitionSpecForDeclaration skips optional column not in schema', () => {
  const schema = icebergSchemaForColumns([
    { name: 'id', type: 'INT32', nullable: false },
  ])
  /** @type {CachePartitioningDeclaration} */
  const decl = {
    source: { columns: ['id'] },
    iceberg: {
      fields: [{ column: 'missing_col', transform: 'identity' }],
    },
  }
  const spec = partitionSpecForDeclaration(decl, schema)
  assert.equal(spec.fields.length, 0)
})

test('partitionSpecForDeclaration throws when required column not in schema', () => {
  const schema = icebergSchemaForColumns([
    { name: 'id', type: 'INT32', nullable: false },
  ])
  /** @type {CachePartitioningDeclaration} */
  const decl = {
    source: { columns: ['id'] },
    iceberg: {
      fields: [{ column: 'missing_col', transform: 'identity', required: true }],
    },
  }
  assert.throws(
    () => partitionSpecForDeclaration(decl, schema),
    /required partition field "missing_col" not found in schema/
  )
})

test('partitionSpecForDeclaration supports non-identity transforms', () => {
  const schema = icebergSchemaForColumns([
    { name: 'ts', type: 'TIMESTAMP', nullable: false },
  ])
  /** @type {CachePartitioningDeclaration} */
  const decl = {
    source: { columns: ['ts'] },
    iceberg: {
      fields: [{ column: 'ts', transform: 'day' }],
    },
  }
  const spec = partitionSpecForDeclaration(decl, schema)
  assert.equal(spec.fields[0].transform, 'day')
})

// --- mergeFieldIdsFromTable ---

test('mergeFieldIdsFromTable preserves existing field IDs', () => {
  /** @type {Schema} */
  const existing = {
    type: 'struct',
    'schema-id': 0,
    fields: [
      { id: 1, name: 'a', required: false, type: 'string' },
      { id: 2, name: 'b', required: true, type: 'long' },
    ],
  }
  const merged = mergeFieldIdsFromTable(
    [
      { name: 'a', type: 'STRING', nullable: true },
      { name: 'b', type: 'INT64', nullable: false },
    ],
    existing
  )
  assert.deepEqual(merged.fields.map(f => [f.name, f.id]), [['a', 1], ['b', 2]])
})

test('mergeFieldIdsFromTable appends nullable additions with fresh IDs', () => {
  /** @type {Schema} */
  const existing = {
    type: 'struct',
    'schema-id': 3,
    fields: [
      { id: 10, name: 'x', required: false, type: 'string' },
    ],
  }
  const merged = mergeFieldIdsFromTable(
    [
      { name: 'x', type: 'STRING', nullable: true },
      { name: 'y', type: 'DOUBLE', nullable: true },
    ],
    existing
  )
  assert.equal(merged['schema-id'], 3)
  assert.deepEqual(merged.fields, [
    { id: 10, name: 'x', required: false, type: 'string' },
    { id: 11, name: 'y', required: false, type: 'double' },
  ])
})

test('mergeFieldIdsFromTable rejects type changes', () => {
  /** @type {Schema} */
  const existing = {
    type: 'struct',
    'schema-id': 0,
    fields: [{ id: 1, name: 'a', required: false, type: 'string' }],
  }
  assert.throws(
    () => mergeFieldIdsFromTable(
      [{ name: 'a', type: 'INT32', nullable: true }],
      existing
    ),
    /column "a" type changed/
  )
})

test('mergeFieldIdsFromTable rejects new required columns', () => {
  /** @type {Schema} */
  const existing = {
    type: 'struct',
    'schema-id': 0,
    fields: [{ id: 1, name: 'a', required: false, type: 'string' }],
  }
  assert.throws(
    () => mergeFieldIdsFromTable(
      [
        { name: 'a', type: 'STRING', nullable: true },
        { name: 'b', type: 'INT32', nullable: false },
      ],
      existing
    ),
    /new column "b" must be nullable/
  )
})

test('mergeFieldIdsFromTable rejects column removal', () => {
  /** @type {Schema} */
  const existing = {
    type: 'struct',
    'schema-id': 0,
    fields: [
      { id: 1, name: 'a', required: false, type: 'string' },
      { id: 2, name: 'b', required: false, type: 'long' },
    ],
  }
  assert.throws(
    () => mergeFieldIdsFromTable(
      [{ name: 'a', type: 'STRING', nullable: true }],
      existing
    ),
    /column "b" cannot be dropped/
  )
})

test('mergeFieldIdsFromTable rejects nullable → required tightening', () => {
  /** @type {Schema} */
  const existing = {
    type: 'struct',
    'schema-id': 0,
    fields: [{ id: 1, name: 'a', required: false, type: 'string' }],
  }
  assert.throws(
    () => mergeFieldIdsFromTable(
      [{ name: 'a', type: 'STRING', nullable: false }],
      existing
    ),
    /cannot tighten nullable/
  )
})

// --- partition column protection ---

test('mergeFieldIdsFromTable uses specific error for partition column type change', () => {
  /** @type {Schema} */
  const existing = {
    type: 'struct',
    'schema-id': 0,
    fields: [{ id: 1, name: 'date', required: false, type: 'string' }],
  }
  assert.throws(
    () => mergeFieldIdsFromTable(
      [{ name: 'date', type: 'INT32', nullable: true }],
      existing,
      new Set(['date'])
    ),
    /partition column "date" type changed/
  )
})

test('mergeFieldIdsFromTable uses specific error for partition column removal', () => {
  /** @type {Schema} */
  const existing = {
    type: 'struct',
    'schema-id': 0,
    fields: [
      { id: 1, name: 'id', required: false, type: 'string' },
      { id: 2, name: 'date', required: false, type: 'string' },
    ],
  }
  assert.throws(
    () => mergeFieldIdsFromTable(
      [{ name: 'id', type: 'STRING', nullable: true }],
      existing,
      new Set(['date'])
    ),
    /partition column "date" cannot be dropped/
  )
})

// --- validatePartitionSpecStability ---

test('validatePartitionSpecStability passes when spec matches declaration', () => {
  /** @type {PartitionSpec} */
  const existingSpec = {
    'spec-id': 0,
    fields: [
      { 'source-id': 1, 'field-id': 1000, name: 'conversation_id', transform: 'identity' },
      { 'source-id': 5, 'field-id': 1001, name: 'cwd', transform: 'identity' },
      { 'source-id': 6, 'field-id': 1002, name: 'date', transform: 'identity' },
    ],
  }
  assert.doesNotThrow(() =>
    validatePartitionSpecStability(AI_GATEWAY_DECLARATION, existingSpec)
  )
})

test('validatePartitionSpecStability rejects new partition field', () => {
  /** @type {PartitionSpec} */
  const existingSpec = {
    'spec-id': 0,
    fields: [
      { 'source-id': 1, 'field-id': 1000, name: 'conversation_id', transform: 'identity' },
      { 'source-id': 6, 'field-id': 1001, name: 'date', transform: 'identity' },
    ],
  }
  assert.throws(
    () => validatePartitionSpecStability(AI_GATEWAY_DECLARATION, existingSpec),
    /partition field "cwd" is new.*spec evolution/
  )
})

test('validatePartitionSpecStability rejects removed partition field', () => {
  /** @type {PartitionSpec} */
  const existingSpec = {
    'spec-id': 0,
    fields: [
      { 'source-id': 1, 'field-id': 1000, name: 'conversation_id', transform: 'identity' },
      { 'source-id': 5, 'field-id': 1001, name: 'cwd', transform: 'identity' },
      { 'source-id': 6, 'field-id': 1002, name: 'date', transform: 'identity' },
    ],
  }
  /** @type {CachePartitioningDeclaration} */
  const changed = {
    ...AI_GATEWAY_DECLARATION,
    iceberg: {
      fields: [
        { column: 'conversation_id', transform: 'identity', required: true },
        { column: 'date', transform: 'identity', required: true },
      ],
    },
  }
  assert.throws(
    () => validatePartitionSpecStability(changed, existingSpec),
    /partition field "cwd" was removed.*spec evolution/
  )
})

test('validatePartitionSpecStability compares effective optional fields against schema', () => {
  /** @type {CachePartitioningDeclaration} */
  const declaration = {
    source: { columns: ['id'] },
    iceberg: {
      fields: [
        { column: 'missing_optional', transform: 'identity' },
      ],
    },
  }
  /** @type {PartitionSpec} */
  const existingSpec = {
    'spec-id': 0,
    fields: [],
  }
  const schema = icebergSchemaForColumns([
    { name: 'id', type: 'INT32', nullable: false },
  ])
  assert.doesNotThrow(() =>
    validatePartitionSpecStability(declaration, existingSpec, schema)
  )
})

test('validatePartitionSpecStability rejects transform changes', () => {
  /** @type {PartitionSpec} */
  const existingSpec = {
    'spec-id': 0,
    fields: [
      { 'source-id': 1, 'field-id': 1000, name: 'ts', transform: 'day' },
    ],
  }
  /** @type {CachePartitioningDeclaration} */
  const declaration = {
    source: { columns: ['ts'] },
    iceberg: {
      fields: [
        { column: 'ts', transform: 'month' },
      ],
    },
  }
  assert.throws(
    () => validatePartitionSpecStability(declaration, existingSpec),
    /partition field "ts" changed transform/
  )
})

// --- Integration: appendRowsToTable with declaration ---

test('appendRowsToTable creates table with partition spec from declaration', async () => {
  const dir = await makeTmpDir('create-with-spec')
  try {
    await appendRowsToTable(dir, AI_GATEWAY_COLUMNS, [
      {
        conversation_id: 'conv-1',
        client_name: 'claude',
        conversation_source: 'cli',
        provider: 'anthropic',
        cwd: '/tmp',
        date: '2026-05-27',
        message: 'hello',
      },
    ], { declaration: AI_GATEWAY_DECLARATION })

    assert.ok(tableExists(dir))

    const metadataDir = path.join(dir, 'metadata')
    const files = fsSync.readdirSync(metadataDir)
    const metaFile = files.find(f => f.endsWith('.metadata.json'))
    assert.ok(metaFile, 'metadata file should exist')

    const meta = JSON.parse(fsSync.readFileSync(path.join(metadataDir, metaFile), 'utf8'))
    const specs = meta['partition-specs']
    assert.ok(specs, 'partition-specs should be in metadata')
    assert.equal(specs.length, 1)
    assert.equal(specs[0].fields.length, 3)
    assert.equal(specs[0].fields[0].name, 'conversation_id')
    assert.equal(specs[0].fields[1].name, 'cwd')
    assert.equal(specs[0].fields[2].name, 'date')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('appendRowsToTable without declaration creates unpartitioned table', async () => {
  const dir = await makeTmpDir('create-no-spec')
  try {
    await appendRowsToTable(dir, [
      { name: 'id', type: 'INT32', nullable: false },
    ], [{ id: 1 }])

    const metadataDir = path.join(dir, 'metadata')
    const files = fsSync.readdirSync(metadataDir)
    const metaFile = files.find(f => f.endsWith('.metadata.json'))
    assert.ok(metaFile, 'metadata file should exist')
    const meta = JSON.parse(fsSync.readFileSync(path.join(metadataDir, metaFile), 'utf8'))
    const specs = meta['partition-specs']
    assert.ok(specs)
    assert.equal(specs[0].fields.length, 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('appendRowsToTable validates schema on existing table with declaration', async () => {
  const dir = await makeTmpDir('evolve-ok')
  try {
    await appendRowsToTable(dir, AI_GATEWAY_COLUMNS, [
      {
        conversation_id: 'c1', client_name: 'claude',
        conversation_source: 'cli', provider: 'anthropic',
        cwd: '/tmp', date: '2026-05-27', message: 'hi',
      },
    ], { declaration: AI_GATEWAY_DECLARATION })

    /** @type {ColumnSpec[]} */
    const extendedColumns = [
      ...AI_GATEWAY_COLUMNS,
      { name: 'extra_notes', type: 'STRING', nullable: true },
    ]
    await assert.doesNotReject(
      appendRowsToTable(dir, extendedColumns, [
        {
          conversation_id: 'c2', client_name: 'claude',
          conversation_source: 'cli', provider: 'anthropic',
          cwd: '/tmp', date: '2026-05-27', message: 'hi2',
          extra_notes: 'note',
        },
      ], { declaration: AI_GATEWAY_DECLARATION })
    )

    // The additive column is evolved in place and immediately queryable: the
    // first row (written before it existed) reads null, the second populates it.
    // (Full evolution coverage lives in cache-iceberg-schema-evolution.test.js.)
    const rows = await readRowsFromTable(dir)
    const byId = new Map(rows.map(r => [r.conversation_id, r]))
    assert.equal(byId.get('c1')?.extra_notes ?? null, null)
    assert.equal(byId.get('c2')?.extra_notes, 'note')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// --- basicTypeForIcebergType ---

test('basicTypeForIcebergType round-trips known types', () => {
  const pairs = [
    ['string', 'STRING'],
    ['int', 'INT32'],
    ['long', 'INT64'],
    ['double', 'DOUBLE'],
    ['boolean', 'BOOLEAN'],
    ['timestamptz', 'TIMESTAMP'],
    ['variant', 'JSON'],
  ]
  for (const [iceberg, basic] of pairs) {
    assert.equal(
      basicTypeForIcebergType(/** @type {any} */ (iceberg)),
      basic,
      `${iceberg} → ${basic}`
    )
  }
})

test('basicTypeForIcebergType defaults unknown types to STRING', () => {
  assert.equal(basicTypeForIcebergType(/** @type {any} */ ('decimal')), 'STRING')
})

// --- columnsFromIcebergSchema ---

test('columnsFromIcebergSchema preserves types and nullability', () => {
  const schema = icebergSchemaForColumns(AI_GATEWAY_COLUMNS)
  const columns = columnsFromIcebergSchema(schema)
  assert.equal(columns.length, AI_GATEWAY_COLUMNS.length)
  assert.equal(columns[0].name, 'conversation_id')
  assert.equal(columns[0].type, 'STRING')
  assert.equal(columns[0].nullable, false)
  assert.equal(columns[1].name, 'client_name')
  assert.equal(columns[1].nullable, true)
})
