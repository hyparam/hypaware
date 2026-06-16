// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { validateEnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/config.js'

test('validateEnrichConfig fills source + tier defaults', () => {
  const result = validateEnrichConfig(undefined)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.source_dataset, 'ai_gateway_messages')
  assert.equal(result.config.text_column, 'content_text')
  assert.equal(result.config.tiebreak_column, 'part_id')
  assert.equal(result.config.anchor_type, 'Session')
  assert.equal(result.config.part_type_column, 'part_type')
  assert.deepEqual(result.config.exclude_part_types, ['tool_result'])
  assert.equal(result.config.require_text, true)
  assert.equal(result.config.propose.t1_model, 'claude-haiku-4-5')
  assert.equal(result.config.propose.enabled, true)
  assert.equal(result.config.curate.t2_model, 'claude-opus-4-8')
  assert.equal(result.config.curate.expand_depth, 1)
})

test('validateEnrichConfig accepts overrides incl. recall_index', () => {
  const result = validateEnrichConfig({
    source_dataset: 'my_logs',
    recall_index: 'committed_idx',
    propose: { t1_model: 'llama3.1', interval_minutes: 2 },
    curate: { t2_model: 'gpt-4o', max_prospects_per_tick: 5 },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.source_dataset, 'my_logs')
  assert.equal(result.config.recall_index, 'committed_idx')
  assert.equal(result.config.propose.t1_model, 'llama3.1')
  assert.equal(result.config.propose.interval_minutes, 2)
  assert.equal(result.config.curate.t2_model, 'gpt-4o')
  assert.equal(result.config.curate.max_prospects_per_tick, 5)
})

test('validateEnrichConfig rejects a non-object config', () => {
  const result = validateEnrichConfig('nope')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].errorKind, 'enrich_config_invalid')
})

test('validateEnrichConfig rejects an out-of-range confidence_floor', () => {
  const result = validateEnrichConfig({ propose: { confidence_floor: 1.5 } })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/propose/confidence_floor')
})

test('validateEnrichConfig rejects a non-positive interval', () => {
  const result = validateEnrichConfig({ curate: { interval_minutes: 0 } })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/curate/interval_minutes')
})

test('validateEnrichConfig rejects a column name that is not a SQL identifier', () => {
  const result = validateEnrichConfig({ text_column: 'content; DROP TABLE node' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/text_column')
  assert.match(result.errors[0].message, /valid SQL identifier/)
})

test('validateEnrichConfig accepts a custom tiebreak_column', () => {
  const result = validateEnrichConfig({ tiebreak_column: 'row_uid' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.tiebreak_column, 'row_uid')
})

test('validateEnrichConfig accepts row-selection overrides incl. an empty exclude list', () => {
  const result = validateEnrichConfig({
    part_type_column: 'kind',
    exclude_part_types: ['tool_result', 'image'],
    require_text: false,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.part_type_column, 'kind')
  assert.deepEqual(result.config.exclude_part_types, ['tool_result', 'image'])
  assert.equal(result.config.require_text, false)

  // An explicit [] is honored (disable the filter), not replaced by the default.
  const cleared = validateEnrichConfig({ exclude_part_types: [] })
  assert.equal(cleared.ok, true)
  if (!cleared.ok) return
  assert.deepEqual(cleared.config.exclude_part_types, [])
})

test('validateEnrichConfig rejects a non-string-array exclude_part_types', () => {
  const result = validateEnrichConfig({ exclude_part_types: ['tool_result', 7] })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/exclude_part_types')
})

test('validateEnrichConfig rejects a part_type_column that is not a SQL identifier', () => {
  const result = validateEnrichConfig({ part_type_column: 'part type' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/part_type_column')
  assert.match(result.errors[0].message, /valid SQL identifier/)
})

test('validateEnrichConfig rejects a non-boolean require_text', () => {
  const result = validateEnrichConfig({ require_text: 'yes' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/require_text')
})
