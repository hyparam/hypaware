// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  icebergSchemaForColumns,
  mergeFieldIdsFromTable,
  rowsToIcebergRecords,
} from '../../hypaware-core/plugins-workspace/format-iceberg/src/schema.js'

/**
 * @import { HypError } from '../../collectivus-plugin-kernel-types.js'
 * @import { Schema } from 'icebird/src/types.js'
 */

test('icebergSchemaForColumns maps every kernel basic type', () => {
  const schema = icebergSchemaForColumns([
    { name: 's', type: 'STRING', nullable: true },
    { name: 'i32', type: 'INT32', nullable: false },
    { name: 'i64', type: 'INT64', nullable: false },
    { name: 'd', type: 'DOUBLE', nullable: true },
    { name: 'b', type: 'BOOLEAN', nullable: false },
    { name: 'ts', type: 'TIMESTAMP', nullable: false },
    { name: 'j', type: 'JSON', nullable: true },
  ])
  assert.equal(schema.type, 'struct')
  assert.equal(schema['schema-id'], 0)
  assert.deepEqual(schema.fields.map((f) => [f.name, f.type, f.required, f.id]), [
    ['s', 'string', false, 1],
    ['i32', 'int', true, 2],
    ['i64', 'long', true, 3],
    ['d', 'double', false, 4],
    ['b', 'boolean', true, 5],
    ['ts', 'timestamptz', true, 6],
    ['j', 'string', false, 7],
  ])
})

test('mergeFieldIdsFromTable preserves existing field ids and appends nullable additions', () => {
  /** @type {Schema} */
  const existing = {
    type: 'struct',
    'schema-id': 7,
    fields: [
      { id: 11, name: 'a', required: false, type: 'string' },
      { id: 12, name: 'b', required: true, type: 'long' },
    ],
  }
  const merged = mergeFieldIdsFromTable(
    [
      { name: 'a', type: 'STRING', nullable: true },
      { name: 'b', type: 'INT64', nullable: false },
      { name: 'c', type: 'DOUBLE', nullable: true },
    ],
    existing
  )
  assert.equal(merged['schema-id'], 7)
  assert.deepEqual(merged.fields, [
    { id: 11, name: 'a', required: false, type: 'string' },
    { id: 12, name: 'b', required: true, type: 'long' },
    { id: 13, name: 'c', required: false, type: 'double' },
  ])
})

test('mergeFieldIdsFromTable rejects incompatible type changes with iceberg_schema_incompatible', () => {
  /** @type {Schema} */
  const existing = {
    type: 'struct',
    'schema-id': 0,
    fields: [{ id: 1, name: 'a', required: false, type: 'long' }],
  }
  assert.throws(
    () =>
      mergeFieldIdsFromTable(
        [{ name: 'a', type: 'STRING', nullable: true }],
        existing
      ),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_schema_incompatible'
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
    () =>
      mergeFieldIdsFromTable(
        [
          { name: 'a', type: 'STRING', nullable: true },
          { name: 'b', type: 'INT32', nullable: false },
        ],
        existing
      ),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_schema_incompatible'
  )
})

test('mergeFieldIdsFromTable rejects column removals', () => {
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
    () =>
      mergeFieldIdsFromTable(
        [{ name: 'a', type: 'STRING', nullable: true }],
        existing
      ),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_schema_incompatible'
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
    () =>
      mergeFieldIdsFromTable(
        [{ name: 'a', type: 'STRING', nullable: false }],
        existing
      ),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_schema_incompatible'
  )
})

test('rowsToIcebergRecords coerces numeric strings and BigInt for INT64', () => {
  const records = rowsToIcebergRecords(
    [
      { name: 'id', type: 'INT64', nullable: false },
      { name: 'tag', type: 'STRING', nullable: false },
    ],
    [
      { id: '42', tag: 'a' },
      { id: 7n, tag: 'b' },
    ]
  )
  assert.deepEqual(records, [
    { id: 42n, tag: 'a' },
    { id: 7n, tag: 'b' },
  ])
})

test('rowsToIcebergRecords throws iceberg_data_write_failed on required nulls', () => {
  assert.throws(
    () =>
      rowsToIcebergRecords(
        [{ name: 'id', type: 'INT64', nullable: false }],
        [{ id: null }]
      ),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_data_write_failed'
  )
})

test('rowsToIcebergRecords canonicalizes JSON objects to strings', () => {
  const records = rowsToIcebergRecords(
    [{ name: 'payload', type: 'JSON', nullable: true }],
    [{ payload: { a: 1 } }, { payload: '["already-json"]' }]
  )
  assert.deepEqual(records, [
    { payload: '{"a":1}' },
    { payload: '["already-json"]' },
  ])
})
