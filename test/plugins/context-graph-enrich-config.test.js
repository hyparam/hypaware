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
