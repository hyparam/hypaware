// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REFRESH_DEFAULTS,
  validateVectorSearchConfig,
} from '../../hypaware-core/plugins-workspace/vector-search/src/config.js'

test('validateVectorSearchConfig defaults to no indexes and enabled refresh', () => {
  const result = validateVectorSearchConfig(undefined)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.config.indexes, [])
  assert.equal(result.config.refresh.enabled, true)
  assert.equal(result.config.refresh.interval_minutes, REFRESH_DEFAULTS.interval_minutes)
  assert.equal(result.config.refresh.max_tick_ms, REFRESH_DEFAULTS.max_tick_ms)
  assert.equal(result.config.refresh.max_rows_per_tick, REFRESH_DEFAULTS.max_rows_per_tick)
})

test('refresh interval default is longer than cache maintenance (60m)', () => {
  assert.ok(REFRESH_DEFAULTS.interval_minutes > 60)
})

test('index name defaults to dataset.column', () => {
  const result = validateVectorSearchConfig({
    indexes: [{ dataset: 'ai_gateway_messages', column: 'content' }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.indexes[0].name, 'ai_gateway_messages.content')
  assert.equal(result.config.indexes[0].id_column, undefined)
})

test('explicit index name and id_column are honored', () => {
  const result = validateVectorSearchConfig({
    indexes: [{ dataset: 'd', column: 'c', name: 'my-index', id_column: 'message_id' }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.indexes[0].name, 'my-index')
  assert.equal(result.config.indexes[0].id_column, 'message_id')
})

test('index names that would escape the state dir are rejected', () => {
  for (const name of ['../up', 'a/b', '.hidden', '']) {
    const result = validateVectorSearchConfig({ indexes: [{ dataset: 'd', column: 'c', name }] })
    assert.equal(result.ok, false, `name '${name}' must fail`)
  }
})

test('duplicate index names are rejected', () => {
  const result = validateVectorSearchConfig({
    indexes: [
      { dataset: 'd', column: 'c' },
      { dataset: 'd', column: 'c' },
    ],
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors[0].message, /duplicate index name/)
})

test('index declarations missing dataset or column are rejected with pointers', () => {
  const result = validateVectorSearchConfig({ indexes: [{ column: 'c' }, { dataset: 'd' }] })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/indexes/0/dataset')
  assert.equal(result.errors[1].pointer, '/indexes/1/column')
})

test('refresh budgets reject non-positive values', () => {
  for (const key of ['interval_minutes', 'max_tick_ms', 'max_rows_per_tick']) {
    const result = validateVectorSearchConfig({ refresh: { [key]: -1 } })
    assert.equal(result.ok, false, `${key}=-1 must fail`)
  }
})

test('refresh interval accepts fractional minutes (sub-minute smoke ticks)', () => {
  const result = validateVectorSearchConfig({ refresh: { interval_minutes: 0.005 } })
  assert.equal(result.ok, true)
})

test('refresh can be disabled', () => {
  const result = validateVectorSearchConfig({ refresh: { enabled: false } })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.refresh.enabled, false)
})
